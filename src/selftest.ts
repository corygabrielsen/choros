#!/usr/bin/env bun
/**
 * choros self-test — the one-command answer to "is messaging actually
 * working right now?"
 *
 * The admin /health endpoint only probes the DB (`SELECT 1`); it
 * returns ok even when no agent can send a message (dead shims, broken
 * delivery). This does the real end-to-end check: spin up two ephemeral
 * clients, register both, send A→B, confirm B receives the push, then
 * deregister. Exit 0 + "HEALTHY" on success, exit 1 + the failure
 * otherwise. Also reports the live peer roster (from register) so you
 * can see who's actually connected.
 *
 *   bun run src/selftest.ts        # or: choros-doctor
 */
import { PROTOCOL_VERSION, type RosterEntry } from '#choros/protocol/methods.ts'
import { connectRpcClient } from '#choros/shim/rpc-client.ts'
import { daemonSocketPath } from '#choros/state-root.ts'

const A = 'aaaaaaaa-0000-4000-8000-00000000fa00'
const B = 'bbbbbbbb-0000-4000-8000-00000000fb00'
const DELIVER_TIMEOUT_MS = 3000

function fail(msg: string): never {
  process.stdout.write(`choros selftest: UNHEALTHY — ${msg}\n`)
  process.exit(1)
}

const sock = daemonSocketPath()

// 1. Daemon reachable at all?
let roster: RosterEntry[] = []
let delivered = false

const recipient = await connectRpcClient({
  socketPath: sock,
  onNotification: method => {
    if (method === 'choros.inbound_message') delivered = true
  },
  onConnect: async c => {
    await c.call('choros.register', {
      protocol_version: PROTOCOL_VERSION,
      session_id: B,
      display_name: 'selftest-recipient',
      host: 'selftest',
      cwd: '/tmp',
      pid: process.pid,
    })
  },
})

const sender = await connectRpcClient({
  socketPath: sock,
  onNotification: () => {
    /* sender doesn't consume notifications */
  },
  onConnect: async c => {
    const res = await c.call<{ roster: RosterEntry[] }>('choros.register', {
      protocol_version: PROTOCOL_VERSION,
      session_id: A,
      display_name: 'selftest-sender',
      host: 'selftest',
      cwd: '/tmp',
      pid: process.pid,
    })
    roster = res.roster ?? []
  },
})

// Give both registers a beat to land.
await new Promise(r => setTimeout(r, 300))

try {
  await sender.call('choros.send', { session_id: A, to: B, body: 'selftest ping' })
} catch (e) {
  fail(`send rejected: ${e instanceof Error ? e.message : String(e)}`)
}

// Wait for the push to arrive at the recipient.
const start = Date.now()
while (!delivered && Date.now() - start < DELIVER_TIMEOUT_MS) {
  await new Promise(r => setTimeout(r, 50))
}

await sender.call('choros.deregister', { session_id: A }).catch(() => undefined)
await recipient.call('choros.deregister', { session_id: B }).catch(() => undefined)
await sender.close()
await recipient.close()

if (!delivered) {
  fail(`send accepted but recipient never received the push within ${DELIVER_TIMEOUT_MS}ms`)
}

// roster excludes the two selftest sessions only if they registered
// after the snapshot; filter them defensively.
const realPeers = roster.filter(p => p.session_id !== A && p.session_id !== B)
const names = realPeers.map(p => p.display_name ?? p.session_id.slice(0, 8)).join(', ')
process.stdout.write(
  `choros selftest: HEALTHY — send→deliver round-trip passed. ${realPeers.length} live peer(s)${
    realPeers.length > 0 ? `: ${names}` : ''
  }\n`,
)
process.exit(0)
