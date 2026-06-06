import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { createReadStream, existsSync, unlinkSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { createInterface } from 'node:readline'

/**
 * Subset of {@link fs.Stats} that choros depends on. Defined as its own
 * interface so {@link Fs.stat} doesn't expose node-specific types to
 * downstream modules.
 */
export interface StatInfo {
  mtimeMs: number
  isDirectory: boolean
  size: number
}

/**
 * Filesystem effects choros depends on. Production wires this to
 * `node:fs/promises`; tests wire it to `FakeFs` for in-memory verification
 * with full atomicity assertions.
 */
export interface Fs {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<StatInfo>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
  unlinkSync(path: string): void
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  existsSync(path: string): boolean
  readLines(path: string): AsyncIterable<string>
  /** Read exactly `length` bytes from `offset` as UTF-8. Used by
   *  {@link verifyJsonlReceipt} to read only the delta between polls
   *  rather than the whole (multi-MB) file each tick. */
  readBytesFromOffset(path: string, offset: number, length: number): Promise<string>
}

/**
 * Time effects. `setTimeout` returns a handle whose `clear()` removes the
 * pending callback — used by every timeout path in choros to avoid zombie
 * timers when the underlying promise settles.
 */
export interface Clock {
  nowMs(): number
  nowIso(): string
  setTimeout(fn: () => void, ms: number): { clear(): void }
}

/**
 * Process effects: identity, lifecycle, and OS-process queries.
 *
 * @remarks
 * `pidAlive` distinguishes "heartbeat freshly written by a now-dead bun"
 * from "live bun" and is the only Linux-specific piece of the interface
 * (production implementation reads `/proc/<pid>`).
 */
export interface Proc {
  pid(): number
  /** Parent PID. Used by the shim to locate Claude Code's per-process
   *  session metadata at `~/.claude/sessions/<ppid>.json` — the
   *  canonical source for this CC session's UUID + display name. */
  ppid(): number
  cwd(): string
  pidAlive(pid: number): Promise<boolean>
  exit(code: number): never
  stderr(line: string): void
}

/** Environment + host metadata, injected so tests can simulate different
 *  hostnames, home dirs, and env-var fixtures. */
export interface Env {
  get(name: string): string | undefined
  homedir(): string
  hostname(): string
}

/**
 * MCP push channel into the running session's agent.
 *
 * @remarks
 * Production wraps `Server.notification` from the MCP SDK; tests use
 * `FakeMcp` which can simulate the EPIPE hang (`hangForever`) or
 * synchronous rejection. The SDK's notification method silently
 * deadlocks on broken stdio, which is why every call goes through
 * {@link withTimeout}.
 */
export interface Mcp {
  notify(method: string, params: unknown): Promise<void>
}

/** Child-process spawner. Production uses `node:child_process`; tests
 *  use `FakeSpawner` to simulate inotifywait emitting filenames on
 *  demand. */
export interface Spawner {
  spawn(cmd: string, args: string[]): SpawnedChild
}

/** A spawned child process — choros only uses inotifywait. Listeners
 *  are wired via setter callbacks rather than EventEmitter so the
 *  interface stays node-runtime-agnostic. */
export interface SpawnedChild {
  pid: number | undefined
  onStdout(handler: (chunk: string) => void): void
  onStderr(handler: (chunk: string) => void): void
  onExit(handler: (code: number | null) => void): void
  kill(): void
}

/**
 * Bundle of all effects choros's pure modules require. Production
 * builds this once at boot via {@link realContext}; tests build a
 * disjoint context per test via `fakeContext()` so concurrent tests
 * don't share state.
 */
export interface Context {
  fs: Fs
  clock: Clock
  proc: Proc
  env: Env
  mcp: Mcp
  spawner: Spawner
}

/** Build a Context wired to the real node primitives. Production entrypoint
 *  calls this once at boot; tests construct their own Context via fakes/. */
export function realContext(mcp: Mcp): Context {
  return {
    fs: realFs(),
    clock: realClock(),
    proc: realProc(),
    env: realEnv(),
    mcp,
    spawner: realSpawner(),
  }
}

function realFs(): Fs {
  return {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, content) => writeFile(path, content),
    readdir: path => readdir(path),
    async stat(path) {
      const s = await stat(path)
      return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), size: s.size }
    },
    rename: (oldPath, newPath) => rename(oldPath, newPath),
    unlink: path => unlink(path),
    unlinkSync: path => unlinkSync(path),
    mkdir: (path, opts) => mkdir(path, opts).then(() => undefined),
    existsSync: path => existsSync(path),
    async readBytesFromOffset(path, offset, length) {
      if (length <= 0) return ''
      const fh = await open(path, 'r')
      try {
        const buf = Buffer.alloc(length)
        const { bytesRead } = await fh.read(buf, 0, length, offset)
        return buf.toString('utf8', 0, bytesRead)
      } finally {
        await fh.close()
      }
    },
    async *readLines(path) {
      // Wrap the stream so non-existent files (ENOENT) yield nothing
      // rather than throw. EMFILE / EACCES / EISDIR also surface as
      // empty yields with stderr — callers can't recover from them
      // here, but treating "can't read" as "no lines" matches the
      // contract every consumer expects (display-name lookup returns
      // null on read failure).
      let stream: ReturnType<typeof createReadStream>
      try {
        stream = createReadStream(path, { encoding: 'utf8' })
      } catch {
        return
      }
      stream.on('error', err => {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') {
          process.stderr.write(`[choros] readLines(${path}): ${err.message ?? err}\n`)
        }
      })
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
      try {
        for await (const line of rl) yield line
      } catch {
        /* stream error already logged via the 'error' handler */
      }
    },
  }
}

function realClock(): Clock {
  return {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    setTimeout(fn, ms) {
      const handle = setTimeout(fn, ms)
      return { clear: () => clearTimeout(handle) }
    },
  }
}

function realProc(): Proc {
  // Detect /proc once at module load. On Linux this is always present;
  // on macOS / BSD it doesn't exist and we use POSIX kill(pid, 0)
  // instead. The detection avoids ambiguity (on macOS, stat('/proc/X')
  // returns ENOENT just like a dead pid on Linux).
  let procFsAvailable: boolean | null = null
  const detect = async (): Promise<boolean> => {
    if (procFsAvailable !== null) return procFsAvailable
    try {
      await stat('/proc/self')
      procFsAvailable = true
    } catch {
      procFsAvailable = false
    }
    return procFsAvailable
  }
  return {
    pid: () => process.pid,
    ppid: () => process.ppid ?? 0,
    cwd: () => process.cwd(),
    async pidAlive(pid) {
      if (!pid || typeof pid !== 'number') return false
      if (await detect()) {
        try {
          await stat(`/proc/${pid}`)
          return true
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return false
          return true
        }
      }
      try {
        process.kill(pid, 0)
        return true
      } catch (k: unknown) {
        const code = (k as NodeJS.ErrnoException)?.code
        if (code === 'ESRCH') return false
        return true
      }
    },
    exit: code => process.exit(code),
    stderr: line => process.stderr.write(line),
  }
}

function realEnv(): Env {
  return {
    get: name => process.env[name],
    homedir: () => homedir(),
    hostname: () => hostname(),
  }
}

function realSpawner(): Spawner {
  return {
    spawn(cmd, args): SpawnedChild {
      const child: ChildProcess = nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      // Single-fire exit channel. Node emits 'error' (without 'exit')
      // on spawn failure like ENOENT, and 'exit' on every other
      // termination path. We funnel both through one handler list so
      // callers see exactly one exit notification regardless of which
      // path the child took.
      const exitHandlers: ((code: number | null) => void)[] = []
      let exitFired = false
      const fireExit = (code: number | null): void => {
        if (exitFired) return
        exitFired = true
        for (const h of exitHandlers) h(code)
      }
      child.on('error', err => {
        process.stderr.write(`[choros] child spawn error (${cmd}): ${err.message ?? err}\n`)
        fireExit(null)
      })
      child.on('exit', code => fireExit(code))
      return {
        pid: child.pid,
        onStdout(handler) {
          child.stdout?.on('data', (chunk: Buffer) => handler(chunk.toString()))
        },
        onStderr(handler) {
          child.stderr?.on('data', (chunk: Buffer) => handler(chunk.toString()))
        },
        onExit(handler) {
          exitHandlers.push(handler)
        },
        kill() {
          try {
            child.kill()
          } catch {
            /* already dead */
          }
        },
      }
    },
  }
}
