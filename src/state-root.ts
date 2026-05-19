import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '#choros/effects.ts'

/** Resolve the choros state root. Order:
 *    1. $CHOROS_STATE_HOME (explicit override)
 *    2. $XDG_STATE_HOME/choros
 *    3. ~/.local/state/choros
 *  Mirrors the ooda-* convention. State is OURS; nothing under ~/.claude.
 *  Trims whitespace on env values so a blank-but-set env var doesn't
 *  silently leak into the path. */
export function resolveStateRoot(ctx: Pick<Context, 'env'>): string {
  const explicit = ctx.env.get('CHOROS_STATE_HOME')?.trim()
  if (explicit) return explicit
  const xdg = ctx.env.get('XDG_STATE_HOME')?.trim()
  if (xdg) return join(xdg, 'choros')
  return join(ctx.env.homedir(), '.local', 'state', 'choros')
}

/** Env-free version of {@link resolveStateRoot} for entry points (daemon
 *  main, shim main) that don't construct a full Context. Reads
 *  `process.env` and `os.homedir()` directly. Both must produce the
 *  same path as the ctx-based version for the same env. */
export function resolveStateRootFromEnv(): string {
  const explicit = process.env.CHOROS_STATE_HOME?.trim()
  if (explicit) return explicit
  const xdg = process.env.XDG_STATE_HOME?.trim()
  if (xdg) return join(xdg, 'choros')
  return join(homedir(), '.local', 'state', 'choros')
}

/** The daemon's primary RPC Unix-socket path. */
export function daemonSocketPath(): string {
  const explicit = process.env.CHOROS_DAEMON_SOCK?.trim()
  if (explicit) return explicit
  return join(resolveStateRootFromEnv(), 'daemon.sock')
}

/** The daemon's HTTP admin Unix-socket path. */
export function adminSocketPath(): string {
  return join(resolveStateRootFromEnv(), 'admin.sock')
}

/** Filesystem path to the daemon's SQLite database. */
export function databasePath(): string {
  return join(resolveStateRootFromEnv(), 'choros.sqlite')
}

/** Filesystem path to the daemon's lockfile. */
export function lockfilePath(): string {
  return join(resolveStateRootFromEnv(), 'daemon.lock')
}

/**
 * Path to Claude Code's per-project transcript directory.
 *
 * @remarks
 * Anthropic owns `~/.claude/projects/`; choros reads from it (to discover
 * session JSONLs and resolve display names) but never writes there.
 */
export function projectsRoot(ctx: Pick<Context, 'env'>): string {
  return join(ctx.env.homedir(), '.claude', 'projects')
}
