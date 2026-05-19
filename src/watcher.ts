import type { Context, SpawnedChild } from './effects.ts'

/** Configuration for {@link setupWatcher}. */
export interface WatcherConfig {
  /** Absolute path to the directory to watch. Must already exist. */
  dir: string
  /** Emit one filename. Called for each entry seen by the inotify watcher
   *  AND by every prescan and sweep tick. Implementations must be
   *  idempotent — the same filename may arrive from multiple sources. */
  emit: (filename: string) => Promise<unknown>
  /** Human-readable label for diagnostic stderr messages. */
  label: string
  /** Sweep interval. The watcher periodically re-scans `dir` and dispatches
   *  every eligible filename through {@link emit}; the sweep is what
   *  rescues messages that the inotify watcher missed (inotifywait death,
   *  pre-scan race, or unsupported platform). Use 0 to disable. */
  sweepIntervalMs: number
  /** Maximum number of concurrent {@link emit} dispatches during prescan
   *  and sweep. Inotify-driven dispatches are not limited (they arrive
   *  one chunk at a time). */
  maxConcurrent: number
  /** Cap on inotifywait respawn attempts when the child dies under load
   *  (watch-table exhaustion, fs unmount). */
  respawnCap: number
  /** Reference to a flag observed by the watcher to suppress respawn and
   *  sweep ticks once shutdown begins. */
  shuttingDown: { value: boolean }
}

/** Handle returned by {@link setupWatcher}. The caller is responsible for
 *  calling `stop()` during shutdown so the inotify child is reaped and
 *  the sweep interval is cleared. */
export interface WatcherHandle {
  stop(): void
  /** Whether inotify-driven event delivery is currently active. False
   *  when the platform lacks inotifywait or all respawn attempts are
   *  exhausted; in either case the periodic sweep is the only delivery
   *  channel. */
  inotifyActive(): boolean
}

/** Dispatch up to `limit` items concurrently through `op`, swallowing
 *  per-item errors (op is expected to log its own failures). */
async function runWithLimit<T>(
  items: T[],
  limit: number,
  op: (item: T) => Promise<unknown>,
): Promise<void> {
  if (items.length === 0) return
  const queue = items.slice()
  const workers: Promise<void>[] = []
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item === undefined) return
      try {
        await op(item)
      } catch {
        /* op is expected to log its own failures */
      }
    }
  }
  const n = Math.min(limit, items.length)
  for (let i = 0; i < n; i++) workers.push(worker())
  await Promise.all(workers)
}

/** Iterate `dir`, dropping dotfiles, and dispatch each remaining filename
 *  through {@link WatcherConfig.emit} with bounded concurrency. */
async function dispatchExisting(
  ctx: Pick<Context, 'fs' | 'proc'>,
  config: WatcherConfig,
): Promise<void> {
  let entries: string[]
  try {
    entries = await ctx.fs.readdir(config.dir)
  } catch {
    return
  }
  const eligible = entries.filter(f => !f.startsWith('.')).sort()
  await runWithLimit(eligible, config.maxConcurrent, config.emit)
}

/** Spawn an inotifywait child watching `dir` and route each emitted
 *  filename through {@link WatcherConfig.emit}. Returns the child handle
 *  plus a respawn helper closure. */
function spawnOnce(
  ctx: Pick<Context, 'spawner' | 'proc'>,
  config: WatcherConfig,
  onExit: (code: number | null) => void,
): SpawnedChild {
  const child = ctx.spawner.spawn('inotifywait', [
    '-m',
    '-q',
    '-e',
    'close_write,moved_to',
    '--format',
    '%f',
    config.dir,
  ])
  child.onStdout(chunk => {
    for (const filename of chunk.split('\n').filter(Boolean)) {
      void config.emit(filename)
    }
  })
  child.onExit(onExit)
  return child
}

/**
 * Wire up an inotify watcher + boot prescan + periodic sweep + respawn
 * loop for `dir`. The three delivery channels compose:
 *
 * 1. inotifywait fires on every `close_write` / `moved_to` after spawn.
 * 2. After spawn, a prescan walks the dir so files already present at
 *    boot get emitted (the inotify watcher only sees CHANGES from spawn
 *    onward). Spawning before prescan means any event in the gap is
 *    captured by inotify; the emit fn's own idempotency tolerates the
 *    overlap with prescan.
 * 3. Every `sweepIntervalMs`, the dir is re-walked and every eligible
 *    file dispatched. The sweep is the resilience layer — it rescues
 *    files when inotify misses (under load, on platforms without
 *    inotifywait, or after a respawn cap is exhausted).
 *
 * On spawn failure (`child.onExit(null)` from a spawn-error path, or
 * exit code beyond {@link WatcherConfig.respawnCap}), the watcher
 * downgrades to sweep-only.
 */
export function setupWatcher(
  ctx: Pick<Context, 'spawner' | 'fs' | 'proc' | 'clock'>,
  config: WatcherConfig,
): WatcherHandle {
  let respawns = 0
  let inotify: SpawnedChild | null = null
  let active = true

  const onChildExit = (code: number | null): void => {
    if (config.shuttingDown.value) return
    if (respawns >= config.respawnCap) {
      ctx.proc.stderr(
        `[choros] ${config.label} watcher: ${config.respawnCap} respawn attempts exhausted (last code=${code}); falling back to sweep-only\n`,
      )
      active = false
      inotify = null
      return
    }
    respawns++
    ctx.proc.stderr(
      `[choros] ${config.label} watcher exited (code=${code}); respawning (attempt ${respawns})\n`,
    )
    inotify = spawnOnce(ctx, config, onChildExit)
  }

  try {
    inotify = spawnOnce(ctx, config, onChildExit)
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    ctx.proc.stderr(
      `[choros] ${config.label} watcher: inotifywait unavailable (${m}); using sweep-only\n`,
    )
    active = false
    inotify = null
  }

  // Prescan AFTER spawn (when spawn succeeded) so any file written
  // during the gap is captured by inotify queueing; the prescan picks
  // up files that pre-existed boot. emit is idempotent across both
  // sources.
  void dispatchExisting(ctx, config)

  let sweepInFlight = false
  const sweepTick = (): void => {
    if (config.shuttingDown.value) return
    if (sweepInFlight) return
    sweepInFlight = true
    void dispatchExisting(ctx, config).finally(() => {
      sweepInFlight = false
    })
  }
  let sweepHandle: ReturnType<typeof setInterval> | null = null
  if (config.sweepIntervalMs > 0) {
    sweepHandle = setInterval(sweepTick, config.sweepIntervalMs)
    sweepHandle.unref?.()
  }

  return {
    stop(): void {
      if (sweepHandle) clearInterval(sweepHandle)
      inotify?.kill()
    },
    inotifyActive(): boolean {
      return active
    },
  }
}
