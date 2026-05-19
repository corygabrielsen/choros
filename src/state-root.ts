import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '#choros/effects.ts'

/** Reject env-supplied path overrides that aren't absolute. Relative
 *  paths resolve against the current working directory, which differs
 *  between systemd/launchd/terminal invocations — silently producing
 *  divergent state-roots that the daemon and shim disagree on. */
function requireAbsolute(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(
      `${name}=${value} must be an absolute path; relative paths resolve differently across systemd/launchd/terminal`,
    )
  }
  return value
}

/** Resolve the choros state root. Order:
 *    1. $CHOROS_STATE_HOME (explicit override)
 *    2. $XDG_STATE_HOME/choros
 *    3. ~/.local/state/choros
 *  Mirrors the ooda-* convention. State is OURS; nothing under ~/.claude.
 *  Trims whitespace on env values so a blank-but-set env var doesn't
 *  silently leak into the path. Both env-sourced paths must be absolute. */
export function resolveStateRoot(ctx: Pick<Context, 'env'>): string {
  const explicit = ctx.env.get('CHOROS_STATE_HOME')?.trim()
  if (explicit) return requireAbsolute('CHOROS_STATE_HOME', explicit)
  const xdg = ctx.env.get('XDG_STATE_HOME')?.trim()
  if (xdg) return join(requireAbsolute('XDG_STATE_HOME', xdg), 'choros')
  return join(ctx.env.homedir(), '.local', 'state', 'choros')
}

/** Env-free version of {@link resolveStateRoot} for entry points (daemon
 *  main, shim main) that don't construct a full Context. Reads
 *  `process.env` and `os.homedir()` directly. Both must produce the
 *  same path as the ctx-based version for the same env. */
export function resolveStateRootFromEnv(): string {
  const explicit = process.env.CHOROS_STATE_HOME?.trim()
  if (explicit) return requireAbsolute('CHOROS_STATE_HOME', explicit)
  const xdg = process.env.XDG_STATE_HOME?.trim()
  if (xdg) return join(requireAbsolute('XDG_STATE_HOME', xdg), 'choros')
  return join(homedir(), '.local', 'state', 'choros')
}

/** The daemon's primary RPC Unix-socket path. */
export function daemonSocketPath(): string {
  const explicit = process.env.CHOROS_DAEMON_SOCK?.trim()
  if (explicit) return requireAbsolute('CHOROS_DAEMON_SOCK', explicit)
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
