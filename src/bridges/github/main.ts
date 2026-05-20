#!/usr/bin/env bun
import { extractMergedPullRequest, MERGE_ACT, verifyHmac } from '#choros/bridges/github/verify.ts'
import { PROTOCOL_VERSION } from '#choros/protocol/methods.ts'
/**
 * choros github bridge — translates GitHub webhook events into choros
 * publish() calls so subscribed CC sessions get notified about
 * external events (PR merges to start; more later).
 *
 * Wire:
 *   GitHub (App webhook) ──HTTPS──> cloudflared ──HTTP──> bridge:PORT
 *   bridge ──unix JSON-RPC──> choros daemon
 *   daemon ──notification──> shims subscribed to TOPIC_PR_MERGED
 *
 * Required env:
 *   CHOROS_GH_WEBHOOK_SECRET — the secret configured on the GitHub App
 *
 * Optional env:
 *   CHOROS_GH_BRIDGE_PORT   — listen port (default 4242)
 */
import { connectRpcClient } from '#choros/shim/rpc-client.ts'
import { daemonSocketPath } from '#choros/state-root.ts'

const BRIDGE_VERSION = '1.0.0'
/** Synthetic session id the bridge registers under. Stable so peers
 *  can subscribe-by-name (`gh-bridge`) and see consistent attribution
 *  across daemon restarts. Not the nil UUID (which `resolveRecipient`
 *  rejects). */
const BRIDGE_SESSION_ID = '00000001-0000-4000-8000-000000000001'
const BRIDGE_DISPLAY_NAME = 'gh-bridge'
const TOPIC_PR_MERGED = 'github.pr_merged'
/** Cap the inbound webhook body before buffering. GitHub PR payloads
 *  run ~30-100 KB; 1 MiB is generous headroom and bounds the
 *  unauthenticated buffer. */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
/** Remember recent x-github-delivery ids so an at-least-once redelivery
 *  doesn't double-publish. Bounded ring — GitHub retries within
 *  minutes, so a few hundred ids is ample. */
const DEDUP_CAP = 512
const recentDeliveries = new Set<string>()
function alreadyHandled(deliveryId: string): boolean {
  if (!deliveryId) return false
  if (recentDeliveries.has(deliveryId)) return true
  recentDeliveries.add(deliveryId)
  if (recentDeliveries.size > DEDUP_CAP) {
    // Evict oldest (insertion order) to keep the set bounded.
    const oldest = recentDeliveries.values().next().value
    if (oldest !== undefined) recentDeliveries.delete(oldest)
  }
  return false
}

const PORT = Number(process.env.CHOROS_GH_BRIDGE_PORT ?? '4242')
const SECRET = process.env.CHOROS_GH_WEBHOOK_SECRET ?? ''
if (!SECRET) {
  process.stderr.write('[choros-gh-bridge] CHOROS_GH_WEBHOOK_SECRET is required\n')
  process.exit(1)
}

const rpc = await connectRpcClient({
  socketPath: daemonSocketPath(),
  onNotification: (): void => {
    /* bridge publishes only — it doesn't subscribe to anything */
  },
  onConnect: async (client): Promise<void> => {
    try {
      await client.call('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: BRIDGE_SESSION_ID,
        display_name: BRIDGE_DISPLAY_NAME,
        host: 'local',
        cwd: process.cwd(),
        pid: process.pid,
      })
      process.stderr.write(
        `[choros-gh-bridge] v${BRIDGE_VERSION} registered as ${BRIDGE_DISPLAY_NAME}\n`,
      )
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      // Don't exit — the reconnect loop will retry register on the
      // next successful connect. Exiting here would let a transient
      // daemon hiccup kill a webhook receiver that GitHub is actively
      // delivering to.
      process.stderr.write(`[choros-gh-bridge] register failed (will retry): ${m}\n`)
    }
  },
})

const server = Bun.serve({
  // Bind loopback only — cloudflared connects from the same host, so
  // there's no reason to expose the receiver to the LAN. Mirrors the
  // daemon's 0600-socket posture.
  hostname: '127.0.0.1',
  port: PORT,
  // Reject oversized bodies before they're buffered. The webhook is an
  // unauthenticated endpoint (HMAC is checked after read); without this
  // a large POST is a memory-exhaustion vector.
  maxRequestBodySize: MAX_WEBHOOK_BODY_BYTES,
  fetch: async (req): Promise<Response> => {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    if (new URL(req.url).pathname !== '/webhook') {
      return new Response('not found', { status: 404 })
    }
    const sig = req.headers.get('x-hub-signature-256') ?? ''
    const event = req.headers.get('x-github-event') ?? ''
    const delivery = req.headers.get('x-github-delivery') ?? ''

    // Bun's req.text() buffers the whole body — we need the raw bytes
    // for HMAC verification before any JSON.parse can fail-open.
    const body = await req.text()
    if (!verifyHmac(SECRET, body, sig)) {
      process.stderr.write(`[choros-gh-bridge] invalid signature delivery=${delivery}\n`)
      return new Response('invalid signature', { status: 401 })
    }

    // Ignore every event class except pull_request. Returning 200
    // tells GitHub not to retry — the App's event subscription is the
    // place to narrow this, not the receiver.
    if (event !== 'pull_request') {
      return new Response('ignored', { status: 200 })
    }

    // GitHub delivery is at-least-once; drop a redelivered id so a
    // retry (or our own 500-triggered retry) doesn't double-publish.
    // Checked AFTER HMAC so an attacker can't poison the dedup set.
    if (alreadyHandled(delivery)) {
      return new Response('duplicate', { status: 200 })
    }

    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return new Response('invalid json', { status: 400 })
    }
    const merged = extractMergedPullRequest(payload)
    if (!merged) {
      // pull_request event but not a merge (opened, synchronized,
      // closed-without-merge, etc.). Drop silently with 200.
      return new Response('not a merge', { status: 200 })
    }

    const bodyText = `PR merged: ${merged.repo}#${merged.number} — ${merged.title} (${merged.url})`
    try {
      await rpc.call('choros.publish', {
        session_id: BRIDGE_SESSION_ID,
        topic: TOPIC_PR_MERGED,
        body: bodyText,
        act: MERGE_ACT,
      })
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      process.stderr.write(
        `[choros-gh-bridge] publish failed delivery=${delivery} pr=${merged.repo}#${merged.number}: ${m}\n`,
      )
      // Un-mark so GitHub's retry (triggered by the 500) is allowed to
      // re-attempt — otherwise a transient daemon-down would dedup the
      // retry and lose the event permanently.
      recentDeliveries.delete(delivery)
      return new Response('publish failed', { status: 500 })
    }
    process.stderr.write(
      `[choros-gh-bridge] published delivery=${delivery} pr=${merged.repo}#${merged.number}\n`,
    )
    return new Response('published', { status: 200 })
  },
})

process.stderr.write(`[choros-gh-bridge] v${BRIDGE_VERSION} listening on :${PORT}\n`)

async function shutdown(reason: string): Promise<void> {
  process.stderr.write(`[choros-gh-bridge] ${reason} — deregistering\n`)
  try {
    await Promise.race([
      rpc.call('choros.deregister', { session_id: BRIDGE_SESSION_ID }),
      new Promise<void>(resolve => setTimeout(resolve, 500)),
    ])
  } catch {
    /* best-effort */
  }
  await rpc.close()
  await server.stop(true)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    void shutdown(sig).finally(() => process.exit(0))
  })
}

// Defense in depth: a stray rejection/exception must not silently kill
// the webhook receiver. Log and keep serving — the RPC client
// reconnects on its own.
process.on('unhandledRejection', reason => {
  const m = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  process.stderr.write(`[choros-gh-bridge] unhandledRejection: ${m}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`[choros-gh-bridge] uncaughtException: ${err.stack ?? err.message}\n`)
})
