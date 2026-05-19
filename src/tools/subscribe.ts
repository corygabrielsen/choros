import { atomicWrite } from '../delivery.ts'
import type { Context } from '../effects.ts'
import { sanitizeId } from '../identity.ts'

/** Path to the per-session `.subscriptions` file. */
export interface SubscribeTargets {
  subscriptionsPath: string
}

async function readSubscriptions(ctx: Pick<Context, 'fs'>, path: string): Promise<Set<string>> {
  try {
    const raw = await ctx.fs.readFile(path)
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

async function writeSubscriptions(
  ctx: Pick<Context, 'fs' | 'proc'>,
  path: string,
  set: Set<string>,
): Promise<void> {
  await atomicWrite(ctx, path, JSON.stringify([...set].sort()))
}

/**
 * Subscribe to a topic. Future publishes to that topic will arrive in
 * this session's inbox.
 *
 * @remarks
 * Subscriptions are persisted to `.subscriptions` via atomic write.
 * Idempotent — subscribing to the same topic twice is a no-op.
 *
 * @throws When `topic` is empty.
 */
export async function handleSubscribe(
  ctx: Pick<Context, 'fs' | 'proc'>,
  targets: SubscribeTargets,
  topic: string,
): Promise<{ subscribed: string[] }> {
  const t = topic.trim()
  if (!t) throw new Error('subscribe: "topic" is required')
  const set = await readSubscriptions(ctx, targets.subscriptionsPath)
  set.add(t)
  await writeSubscriptions(ctx, targets.subscriptionsPath, set)
  return { subscribed: [...set].sort() }
}

/**
 * Unsubscribe from a topic.
 *
 * @throws When `topic` is empty.
 */
export async function handleUnsubscribe(
  ctx: Pick<Context, 'fs' | 'proc'>,
  targets: SubscribeTargets,
  topic: string,
): Promise<{ subscribed: string[] }> {
  const t = topic.trim()
  if (!t) throw new Error('unsubscribe: "topic" is required')
  const set = await readSubscriptions(ctx, targets.subscriptionsPath)
  set.delete(t)
  await writeSubscriptions(ctx, targets.subscriptionsPath, set)
  return { subscribed: [...set].sort() }
}

/** Test whether a peer is subscribed to a topic. Used by
 *  {@link handlePublish} to filter the fan-out set. */
export async function listSubscribers(
  ctx: Pick<Context, 'fs'>,
  stateRoot: string,
  peerId: string,
  topic: string,
): Promise<boolean> {
  sanitizeId(peerId, 'listSubscribers.peerId')
  const set = await readSubscriptions(ctx, `${stateRoot}/${peerId}/.subscriptions`)
  return set.has(topic)
}
