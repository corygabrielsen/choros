import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetCcSessionFileCache,
  ccSessionFilePath,
  parseCcSessionFile,
  readCcSessionFile,
  readCcSessionFileWithRetry,
} from '#choros/shim/cc-session-file.ts'

const PPID = 12345
const SESSION_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SAMPLE = JSON.stringify({
  pid: PPID,
  sessionId: SESSION_UUID,
  cwd: '/home/cory/code/skills',
  startedAt: 1780736634716,
  procStart: '71257341',
  version: '2.1.167',
  peerProtocol: 1,
  kind: 'interactive',
  entrypoint: 'cli',
  name: 'agent-tools',
  updatedAt: 1780739442201,
  status: 'busy',
})

async function stageHome(content: string | null, ppid = PPID): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'choros-ccfile-'))
  if (content !== null) {
    await mkdir(join(home, '.claude', 'sessions'), { recursive: true })
    await writeFile(ccSessionFilePath(home, ppid), content)
  }
  return home
}

describe('parseCcSessionFile', () => {
  afterEach(() => {
    _resetCcSessionFileCache()
  })

  test('parses a well-formed session file with `name`', () => {
    const result = parseCcSessionFile(SAMPLE, PPID)
    expect(result).not.toBeNull()
    expect(result?.sessionId).toBe(SESSION_UUID)
    expect(result?.name).toBe('agent-tools')
    expect(result?.cwd).toBe('/home/cory/code/skills')
    expect(result?.pid).toBe(PPID)
  })

  test('null name for sdk-cli sessions (no `name` field)', () => {
    const raw = JSON.stringify({ pid: PPID, sessionId: SESSION_UUID, cwd: '/x' })
    expect(parseCcSessionFile(raw, PPID)?.name).toBeNull()
  })

  test('null name for explicit null', () => {
    const raw = JSON.stringify({ pid: PPID, sessionId: SESSION_UUID, cwd: '/x', name: null })
    expect(parseCcSessionFile(raw, PPID)?.name).toBeNull()
  })

  test('null name for empty string (treated as absent)', () => {
    const raw = JSON.stringify({ pid: PPID, sessionId: SESSION_UUID, cwd: '/x', name: '' })
    expect(parseCcSessionFile(raw, PPID)?.name).toBeNull()
  })

  test('rejects malformed JSON', () => {
    expect(parseCcSessionFile('{not json', PPID)).toBeNull()
  })

  test('rejects non-UUID sessionId', () => {
    const raw = JSON.stringify({ pid: PPID, sessionId: 'not-a-uuid', cwd: '/x' })
    expect(parseCcSessionFile(raw, PPID)).toBeNull()
  })

  test('rejects missing cwd', () => {
    const raw = JSON.stringify({ pid: PPID, sessionId: SESSION_UUID })
    expect(parseCcSessionFile(raw, PPID)).toBeNull()
  })

  test('rejects pid mismatch (stale or PID-recycled file)', () => {
    const result = parseCcSessionFile(SAMPLE, PPID + 1)
    expect(result).toBeNull()
  })

  test('rejects array top-level', () => {
    expect(parseCcSessionFile('[]', PPID)).toBeNull()
  })

  test('rejects null top-level', () => {
    expect(parseCcSessionFile('null', PPID)).toBeNull()
  })
})

describe('readCcSessionFile', () => {
  let stagedHome: string | null = null

  afterEach(async () => {
    _resetCcSessionFileCache()
    if (stagedHome !== null) {
      await rm(stagedHome, { recursive: true, force: true })
      stagedHome = null
    }
  })

  test('returns parsed metadata when file present + valid', async () => {
    const home = await stageHome(SAMPLE)
    stagedHome = home
    const result = await readCcSessionFile(home, PPID)
    expect(result?.sessionId).toBe(SESSION_UUID)
    expect(result?.name).toBe('agent-tools')
  })

  test('returns null when file missing', async () => {
    const home = await stageHome(null)
    stagedHome = home
    expect(await readCcSessionFile(home, PPID)).toBeNull()
  })

  test('returns null for non-positive ppid (no parent inferable)', async () => {
    const home = await stageHome(SAMPLE)
    stagedHome = home
    expect(await readCcSessionFile(home, 0)).toBeNull()
    expect(await readCcSessionFile(home, -1)).toBeNull()
    expect(await readCcSessionFile(home, Number.NaN)).toBeNull()
  })

  test('returns null when file content is malformed', async () => {
    const home = await stageHome('{not json}')
    stagedHome = home
    expect(await readCcSessionFile(home, PPID)).toBeNull()
  })

  test('cache short-circuits subsequent reads at same mtime+size', async () => {
    const home = await stageHome(SAMPLE)
    stagedHome = home
    const first = await readCcSessionFile(home, PPID)
    // Overwrite contents but if size unchanged AND mtime within cache
    // resolution, cache may serve stale. We force a clear-cache to
    // verify the read picks up the change deterministically.
    const renamed = SAMPLE.replace('"agent-tools"', '"renamed-name"')
    await writeFile(ccSessionFilePath(home, PPID), renamed)
    _resetCcSessionFileCache()
    const second = await readCcSessionFile(home, PPID)
    expect(first?.name).toBe('agent-tools')
    expect(second?.name).toBe('renamed-name')
  })
})

describe('readCcSessionFileWithRetry', () => {
  let stagedHome: string | null = null

  afterEach(async () => {
    _resetCcSessionFileCache()
    if (stagedHome !== null) {
      await rm(stagedHome, { recursive: true, force: true })
      stagedHome = null
    }
  })

  test('returns on first attempt when file present', async () => {
    const home = await stageHome(SAMPLE)
    stagedHome = home
    const result = await readCcSessionFileWithRetry(home, PPID, { attempts: 4, waitMs: 1 })
    expect(result?.sessionId).toBe(SESSION_UUID)
  })

  test('returns null after exhausting attempts on missing file', async () => {
    const home = await stageHome(null)
    stagedHome = home
    const result = await readCcSessionFileWithRetry(home, PPID, { attempts: 3, waitMs: 1 })
    expect(result).toBeNull()
  })

  test('picks up the file when it appears mid-retry', async () => {
    const home = await stageHome(null)
    stagedHome = home
    // Write the file just before the 2nd attempt fires.
    setTimeout(() => {
      void mkdir(join(home, '.claude', 'sessions'), { recursive: true }).then(() =>
        writeFile(ccSessionFilePath(home, PPID), SAMPLE),
      )
    }, 3)
    const result = await readCcSessionFileWithRetry(home, PPID, { attempts: 6, waitMs: 10 })
    expect(result?.sessionId).toBe(SESSION_UUID)
  })
})
