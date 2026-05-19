import { join } from 'node:path'
import type { Context } from './effects.ts'

/** Resolve the choros state root. Order:
 *    1. $CHOROS_STATE_HOME (explicit override)
 *    2. $XDG_STATE_HOME/choros
 *    3. ~/.local/state/choros
 *  Mirrors the ooda-* convention. State is OURS; nothing under ~/.claude. */
export function resolveStateRoot(ctx: Pick<Context, 'env'>): string {
  const explicit = ctx.env.get('CHOROS_STATE_HOME')
  if (explicit) return explicit
  const xdg = ctx.env.get('XDG_STATE_HOME')
  if (xdg) return join(xdg, 'choros')
  return join(ctx.env.homedir(), '.local', 'state', 'choros')
}

export function projectsRoot(ctx: Pick<Context, 'env'>): string {
  return join(ctx.env.homedir(), '.claude', 'projects')
}
// trivial
