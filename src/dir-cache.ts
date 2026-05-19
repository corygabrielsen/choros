import type { Context } from '#choros/effects.ts'

/**
 * Idempotent `mkdir -p` with a process-lifetime cache. The bun's hot
 * fan-out paths (broadcast, publish, send, send_to_thread, react,
 * writeAckToSender) each `mkdir` into the recipient's inbox/sent_acks
 * before every write — under load that's one syscall per peer per
 * message. After the first call for a given path within this bun's
 * lifetime, the dir exists and subsequent calls skip the syscall.
 *
 * Safety note: if an operator deletes one of these dirs out-of-band,
 * subsequent writes will fail until the bun restarts (the cache says
 * the dir exists). The trade-off is intentional — choros owns these
 * dirs, and deleting them while a bun is running is an operator
 * mistake comparable to deleting `.heartbeat`.
 */
const ensuredDirs = new Set<string>()

/** Memoized `mkdir -p`. First call for each `path` actually runs the
 *  syscall; subsequent calls are O(1) Set lookups. */
export async function ensureDir(ctx: Pick<Context, 'fs'>, path: string): Promise<void> {
  if (ensuredDirs.has(path)) return
  await ctx.fs.mkdir(path, { recursive: true })
  ensuredDirs.add(path)
}

/** Forget the cached state — only for tests that need a fresh-bun
 *  view between runs. Not for production use. */
export function resetDirCacheForTesting(): void {
  ensuredDirs.clear()
}
