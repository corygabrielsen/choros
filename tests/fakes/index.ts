import type {
  Clock,
  Context,
  Env,
  Fs,
  Mcp,
  Proc,
  SpawnedChild,
  Spawner,
  StatInfo,
} from '../../src/effects.ts'

export interface FakeFile {
  content: string
  mtimeMs: number
}

export class FakeFs implements Fs {
  files = new Map<string, FakeFile>()
  dirs = new Set<string>(['/'])
  /** Records the temp paths used in rename operations so tests can assert
   *  the atomic-write pattern is being followed. */
  renamePairs: Array<{ from: string; to: string }> = []

  constructor(private clock: { nowMs(): number } = { nowMs: () => 0 }) {}

  private ensureParent(path: string): void {
    const parts = path.split('/').slice(0, -1)
    let cur = ''
    for (const p of parts) {
      cur += `/${p}`
      if (cur === '/') continue
      this.dirs.add(cur.replace(/^\/+/, '/'))
    }
    this.dirs.add('/')
  }

  async readFile(path: string): Promise<string> {
    const f = this.files.get(path)
    if (!f) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return f.content
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.ensureParent(path)
    this.files.set(path, { content, mtimeMs: this.clock.nowMs() })
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    const prefix = path.endsWith('/') ? path : `${path}/`
    const names = new Set<string>()
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && d !== path) {
        const rest = d.slice(prefix.length)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
    }
    return [...names]
  }

  async stat(path: string): Promise<StatInfo> {
    const f = this.files.get(path)
    if (f) return { mtimeMs: f.mtimeMs, isDirectory: false, size: f.content.length }
    if (this.dirs.has(path)) return { mtimeMs: 0, isDirectory: true, size: 0 }
    const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const f = this.files.get(oldPath)
    if (!f) {
      const err = new Error(`ENOENT: ${oldPath}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    this.files.delete(oldPath)
    this.ensureParent(newPath)
    this.files.set(newPath, { content: f.content, mtimeMs: this.clock.nowMs() })
    this.renamePairs.push({ from: oldPath, to: newPath })
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.has(path)) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    this.files.delete(path)
  }

  unlinkSync(path: string): void {
    this.files.delete(path)
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (opts?.recursive) {
      const parts = path.split('/').filter(Boolean)
      let cur = ''
      for (const p of parts) {
        cur += `/${p}`
        this.dirs.add(cur)
      }
    } else {
      this.dirs.add(path)
    }
  }

  existsSync(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }

  async *readLines(path: string): AsyncIterable<string> {
    const f = this.files.get(path)
    if (!f) return
    // node:readline does NOT yield a trailing empty line when content ends
    // with '\n'. Match that — split('\n').filter(...) would also drop empty
    // lines in the middle, which we don't want. Drop only the final empty
    // produced by a terminal newline.
    const parts = f.content.split('\n')
    const lines = parts.length > 0 && parts[parts.length - 1] === '' ? parts.slice(0, -1) : parts
    for (const line of lines) yield line
  }
}

export class FakeClock implements Clock {
  private current: number
  private timers: Array<{ fireAt: number; fn: () => void; cleared: boolean }> = []

  constructor(startMs = 1_700_000_000_000) {
    this.current = startMs
  }

  nowMs(): number {
    return this.current
  }

  nowIso(): string {
    return new Date(this.current).toISOString()
  }

  setTimeout(fn: () => void, ms: number): { clear(): void } {
    const entry = { fireAt: this.current + ms, fn, cleared: false }
    this.timers.push(entry)
    return {
      clear: () => {
        entry.cleared = true
      },
    }
  }

  advance(ms: number): void {
    this.current += ms
    const due = this.timers.filter(t => !t.cleared && t.fireAt <= this.current)
    this.timers = this.timers.filter(t => t.cleared || t.fireAt > this.current)
    for (const t of due) t.fn()
  }

  pendingTimers(): number {
    return this.timers.filter(t => !t.cleared).length
  }
}

export class FakeProc implements Proc {
  exitCode: number | null = null
  stderrLines: string[] = []
  private alivePids = new Set<number>([1000])

  constructor(public myPid = 1000) {
    this.alivePids.add(myPid)
  }

  pid(): number {
    return this.myPid
  }

  cwd(): string {
    return '/cwd'
  }

  async pidAlive(pid: number): Promise<boolean> {
    return this.alivePids.has(pid)
  }

  setPidAlive(pid: number, alive: boolean): void {
    if (alive) this.alivePids.add(pid)
    else this.alivePids.delete(pid)
  }

  exit(code: number): never {
    this.exitCode = code
    throw new Error(`exit(${code})`)
  }

  stderr(line: string): void {
    this.stderrLines.push(line)
  }
}

export class FakeEnv implements Env {
  vars: Record<string, string> = {}

  constructor(
    public home = '/home/test',
    public host = 'fake-host',
  ) {}

  get(name: string): string | undefined {
    return this.vars[name]
  }

  homedir(): string {
    return this.home
  }

  hostname(): string {
    return this.host
  }
}

export interface MockMcpNotification {
  method: string
  params: unknown
}

export class FakeMcp implements Mcp {
  notifications: MockMcpNotification[] = []
  /** When set, notify() returns a promise that never settles. Simulates EPIPE
   *  hang on the SDK's stdio transport. */
  hangForever = false
  /** When set, notify() rejects with this error. */
  rejectWith: Error | null = null

  async notify(method: string, params: unknown): Promise<void> {
    if (this.hangForever) return new Promise(() => {})
    if (this.rejectWith) throw this.rejectWith
    this.notifications.push({ method, params })
  }
}

export class FakeSpawner implements Spawner {
  spawned: Array<{ cmd: string; args: string[]; child: FakeChild }> = []

  spawn(cmd: string, args: string[]): SpawnedChild {
    const child = new FakeChild()
    this.spawned.push({ cmd, args, child })
    return child
  }
}

export class FakeChild implements SpawnedChild {
  pid: number | undefined = 99999
  killed = false
  private stdoutHandlers: Array<(c: string) => void> = []
  private stderrHandlers: Array<(c: string) => void> = []
  private exitHandlers: Array<(code: number | null) => void> = []

  onStdout(h: (c: string) => void): void {
    this.stdoutHandlers.push(h)
  }
  onStderr(h: (c: string) => void): void {
    this.stderrHandlers.push(h)
  }
  onExit(h: (code: number | null) => void): void {
    this.exitHandlers.push(h)
  }
  kill(): void {
    this.killed = true
    for (const h of this.exitHandlers) h(null)
  }

  emitStdout(line: string): void {
    for (const h of this.stdoutHandlers) h(line)
  }
  emitStderr(line: string): void {
    for (const h of this.stderrHandlers) h(line)
  }
}

export function fakeContext(over: Partial<Context> = {}): Context & {
  fs: FakeFs
  clock: FakeClock
  proc: FakeProc
  env: FakeEnv
  mcp: FakeMcp
  spawner: FakeSpawner
} {
  const clock = (over.clock as FakeClock) ?? new FakeClock()
  const fs = (over.fs as FakeFs) ?? new FakeFs(clock)
  const proc = (over.proc as FakeProc) ?? new FakeProc()
  const env = (over.env as FakeEnv) ?? new FakeEnv()
  const mcp = (over.mcp as FakeMcp) ?? new FakeMcp()
  const spawner = (over.spawner as FakeSpawner) ?? new FakeSpawner()
  return { fs, clock, proc, env, mcp, spawner }
}
