import { describe, expect, test } from 'bun:test'
import { FakeClock, FakeFs, FakeMcp, FakeProc, fakeContext } from './fakes/index.ts'

describe('FakeFs', () => {
  test('writeFile + readFile round-trips', async () => {
    const fs = new FakeFs()
    await fs.writeFile('/a/b.txt', 'hello')
    expect(await fs.readFile('/a/b.txt')).toBe('hello')
  })

  test('readFile throws ENOENT for missing path', async () => {
    const fs = new FakeFs()
    await expect(fs.readFile('/missing')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rename moves file and records pair (atomic-write witness)', async () => {
    const fs = new FakeFs()
    await fs.writeFile('/x.tmp', 'data')
    await fs.rename('/x.tmp', '/x')
    expect(await fs.readFile('/x')).toBe('data')
    expect(fs.files.has('/x.tmp')).toBe(false)
    expect(fs.renamePairs).toEqual([{ from: '/x.tmp', to: '/x' }])
  })

  test('readdir enumerates files and subdirs', async () => {
    const fs = new FakeFs()
    await fs.mkdir('/root', { recursive: true })
    await fs.writeFile('/root/a.txt', '')
    await fs.writeFile('/root/sub/b.txt', '')
    const entries = await fs.readdir('/root')
    expect(entries.sort()).toEqual(['a.txt', 'sub'])
  })

  test('stat returns mtime tied to the clock at write time', async () => {
    const clock = new FakeClock(1000)
    const fs = new FakeFs(clock)
    await fs.writeFile('/t', 'x')
    expect((await fs.stat('/t')).mtimeMs).toBe(1000)
    clock.advance(500)
    await fs.writeFile('/t', 'y')
    expect((await fs.stat('/t')).mtimeMs).toBe(1500)
  })

  test('readLines does NOT yield a trailing empty for newline-terminated content', async () => {
    const fs = new FakeFs()
    await fs.writeFile('/t', 'line1\nline2\n')
    const out: string[] = []
    for await (const line of fs.readLines('/t')) out.push(line)
    expect(out).toEqual(['line1', 'line2'])
  })

  test('readLines preserves empty lines in the middle of content', async () => {
    const fs = new FakeFs()
    await fs.writeFile('/t', 'line1\n\nline3\n')
    const out: string[] = []
    for await (const line of fs.readLines('/t')) out.push(line)
    expect(out).toEqual(['line1', '', 'line3'])
  })
})

describe('FakeClock', () => {
  test('advance fires timers whose deadline has passed', () => {
    const clock = new FakeClock(0)
    let fired = false
    clock.setTimeout(() => {
      fired = true
    }, 100)
    clock.advance(50)
    expect(fired).toBe(false)
    clock.advance(50)
    expect(fired).toBe(true)
  })

  test('clear() prevents a timer from firing (no zombie timers)', () => {
    const clock = new FakeClock(0)
    let fired = false
    const t = clock.setTimeout(() => {
      fired = true
    }, 100)
    t.clear()
    clock.advance(1000)
    expect(fired).toBe(false)
    expect(clock.pendingTimers()).toBe(0)
  })
})

describe('FakeProc', () => {
  test('pidAlive starts true for myPid only', async () => {
    const proc = new FakeProc(42)
    expect(await proc.pidAlive(42)).toBe(true)
    expect(await proc.pidAlive(99)).toBe(false)
  })

  test('setPidAlive toggles', async () => {
    const proc = new FakeProc(42)
    proc.setPidAlive(99, true)
    expect(await proc.pidAlive(99)).toBe(true)
    proc.setPidAlive(99, false)
    expect(await proc.pidAlive(99)).toBe(false)
  })
})

describe('FakeMcp', () => {
  test('notify records params by default', async () => {
    const mcp = new FakeMcp()
    await mcp.notify('m', { x: 1 })
    expect(mcp.notifications).toEqual([{ method: 'm', params: { x: 1 } }])
  })

  test('hangForever returns a never-settling promise (EPIPE simulation)', async () => {
    const mcp = new FakeMcp()
    mcp.hangForever = true
    const p = mcp.notify('m', null)
    const race = await Promise.race([
      p.then(() => 'resolved' as const),
      new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 20)),
    ])
    expect(race).toBe('timeout')
  })
})

describe('fakeContext', () => {
  test('returns a Context with all fake fields populated', () => {
    const ctx = fakeContext()
    expect(ctx.fs).toBeInstanceOf(FakeFs)
    expect(ctx.clock).toBeInstanceOf(FakeClock)
    expect(ctx.proc).toBeInstanceOf(FakeProc)
    expect(ctx.mcp).toBeInstanceOf(FakeMcp)
  })

  test('over.clock is shared with the default fs (mtime is consistent)', async () => {
    const clock = new FakeClock(5000)
    const ctx = fakeContext({ clock })
    await ctx.fs.writeFile('/x', 'y')
    expect((await ctx.fs.stat('/x')).mtimeMs).toBe(5000)
  })
})
