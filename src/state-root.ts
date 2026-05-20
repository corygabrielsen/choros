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

/** Resolve the home directory the same way in every launch context.
 *  `$HOME` first (systemd --user, launchd, and the CC MCP host all set
 *  it from the login record, so daemon and shim agree), falling back to
 *  the passwd entry via os.homedir() only when $HOME is unset. Reading
 *  $HOME consistently is what keeps the daemon's and shim's state-root
 *  identical — mixing $HOME on one side with os.homedir() on the other
 *  is the divergence we're avoiding. */
function resolveHome(envHome: string | undefined): string {
  const h = envHome?.trim()
  return h && isAbsolute(h) ? h : homedir()
}

/** Resolve the choros state root. Order:
 *    1. $CHOROS_STATE_HOME (explicit override, must be absolute)
 *    2. ~/.local/state/choros
 *
 *  choros does NOT honor $XDG_STATE_HOME. The daemon (systemd --user,
 *  XDG unset) and the shim (CC host, inherits the login env) run in
 *  different contexts; if one saw an XDG override and the other didn't,
 *  they'd bind different sockets and silently never connect. Keying
 *  only on $HOME + the explicit CHOROS_STATE_HOME override makes
 *  resolution identical across both. State is OURS; nothing under
 *  ~/.claude. */
export function resolveStateRoot(ctx: Pick<Context, 'env'>): string {
  const explicit = ctx.env.get('CHOROS_STATE_HOME')?.trim()
  if (explicit) return requireAbsolute('CHOROS_STATE_HOME', explicit)
  return join(resolveHome(ctx.env.get('HOME')), '.local', 'state', 'choros')
}

/** Env-free version of {@link resolveStateRoot} for entry points (daemon
 *  main, shim main) that don't construct a full Context. Must produce
 *  the same path as the ctx-based version for the same env. */
export function resolveStateRootFromEnv(): string {
  const explicit = process.env.CHOROS_STATE_HOME?.trim()
  if (explicit) return requireAbsolute('CHOROS_STATE_HOME', explicit)
  return join(resolveHome(process.env.HOME), '.local', 'state', 'choros')
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
  return join(resolveHome(ctx.env.get('HOME')), '.claude', 'projects')
}
