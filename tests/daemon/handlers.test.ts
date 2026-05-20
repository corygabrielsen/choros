import { describe, expect, test } from 'bun:test'
import { PROTOCOL_VERSION } from '#choros/protocol/methods.ts'
import { connectTestClient, spawnTestDaemon } from './fixtures.ts'

const PEER_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const PEER_B = 'aaaaaaaa-0000-0000-0000-000000000002'
const PEER_C = 'aaaaaaaa-0000-0000-0000-000000000003'

async function registerClient(daemon: { socketPath: string }, sessionId: string, name?: string) {
  const client = await connectTestClient(daemon.socketPath)
  await client.call('choros.register', {
    protocol_version: PROTOCOL_VERSION,
    session_id: sessionId,
    display_name: name ?? null,
    host: 'test',
    cwd: '/tmp',
    pid: Math.floor(Math.random() * 100_000),
  })
  return client
}

describe('daemon handlers (Phase 2)', () => {
  test('send + delivery notification + confirm_delivery + ack notification', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const bobInbound = bob.nextNotification('choros.inbound_message')
      const sendResult = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'hello',
      })
      const inbound = (await bobInbound) as { msg_id: string; from_session: string; body: string }
      expect(inbound.msg_id).toBe(sendResult.msg_id)
      expect(inbound.from_session).toBe(PEER_A)
      expect(inbound.body).toBe('hello')

      const aliceAck = alice.nextNotification('choros.ack')
      await bob.call('choros.confirm_delivery', { session_id: PEER_B, msg_id: sendResult.msg_id })
      const ack = (await aliceAck) as { msg_id: string; status: string }
      expect(ack.msg_id).toBe(sendResult.msg_id)
      expect(ack.status).toBe('delivered')

      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('report_drop fires a dropped ack to the sender', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const bobInbound = bob.nextNotification('choros.inbound_message')
      const sent = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'hi',
      })
      await bobInbound

      const aliceAck = alice.nextNotification('choros.ack')
      await bob.call('choros.report_drop', { session_id: PEER_B, msg_id: sent.msg_id })
      const ack = (await aliceAck) as { msg_id: string; status: string }
      expect(ack.msg_id).toBe(sent.msg_id)
      expect(ack.status).toBe('dropped')

      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('consecutive drops wedge the recipient; a verified delivery clears it', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')

      for (let i = 0; i < 3; i++) {
        const inbound = bob.nextNotification('choros.inbound_message')
        const sent = await alice.call<{ msg_id: string }>('choros.send', {
          session_id: PEER_A,
          to: PEER_B,
          body: `m${i}`,
        })
        await inbound
        await bob.call('choros.report_drop', { session_id: PEER_B, msg_id: sent.msg_id })
      }

      type Doc = { peers: { session_id: string; classification: string; wedged: boolean }[] }
      const doc1 = await alice.call<Doc>('choros.doctor', { session_id: PEER_A })
      const bob1 = doc1.peers.find(p => p.session_id === PEER_B)
      expect(bob1?.wedged).toBe(true)
      expect(bob1?.classification).toBe('wedged')

      const inbound = bob.nextNotification('choros.inbound_message')
      const ok = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'recovered',
      })
      await inbound
      await bob.call('choros.confirm_delivery', { session_id: PEER_B, msg_id: ok.msg_id })

      const doc2 = await alice.call<Doc>('choros.doctor', { session_id: PEER_A })
      const bob2 = doc2.peers.find(p => p.session_id === PEER_B)
      expect(bob2?.wedged).toBe(false)

      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('send-to-self is rejected', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      await expect(
        alice.call('choros.send', { session_id: PEER_A, to: PEER_A, body: 'hi' }),
      ).rejects.toThrow(/cannot send to self/)
      await alice.close()
    } finally {
      await daemon.stop()
    }
  })

  test('broadcast reaches every live peer, excludes sender', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const carol = await registerClient(daemon, PEER_C, 'carol')
      const bobInbound = bob.nextNotification('choros.inbound_message')
      const carolInbound = carol.nextNotification('choros.inbound_message')
      const result = await alice.call<{ recipients: string[] }>('choros.broadcast', {
        session_id: PEER_A,
        body: 'hello all',
      })
      expect(result.recipients.sort()).toEqual([PEER_B, PEER_C].sort())
      await bobInbound
      await carolInbound
      await alice.close()
      await bob.close()
      await carol.close()
    } finally {
      await daemon.stop()
    }
  })

  test('publish reaches only topic subscribers', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const carol = await registerClient(daemon, PEER_C, 'carol')
      await bob.call('choros.subscribe', { session_id: PEER_B, topic: 'deploy' })
      const bobInbound = bob.nextNotification('choros.inbound_message')
      const result = await alice.call<{ delivered_to: string[] }>('choros.publish', {
        session_id: PEER_A,
        topic: 'deploy',
        body: 'release time',
      })
      expect(result.delivered_to).toEqual([PEER_B])
      const inbound = (await bobInbound) as { topic: string }
      expect(inbound.topic).toBe('deploy')
      await alice.close()
      await bob.close()
      await carol.close()
    } finally {
      await daemon.stop()
    }
  })

  test('subscribe is idempotent; unsubscribe removes', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A)
      let r = await alice.call<{ subscribed: string[] }>('choros.subscribe', {
        session_id: PEER_A,
        topic: 't1',
      })
      expect(r.subscribed).toEqual(['t1'])
      r = await alice.call<{ subscribed: string[] }>('choros.subscribe', {
        session_id: PEER_A,
        topic: 't1',
      })
      expect(r.subscribed).toEqual(['t1'])
      r = await alice.call<{ subscribed: string[] }>('choros.unsubscribe', {
        session_id: PEER_A,
        topic: 't1',
      })
      expect(r.subscribed).toEqual([])
      await alice.close()
    } finally {
      await daemon.stop()
    }
  })

  test('react notifies original sender; second react replaces emoji', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      // Need a real message for bob to react to.
      const _bobInbound = bob.nextNotification('choros.inbound_message')
      const sent = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'hi',
      })
      await _bobInbound
      const aliceReaction = alice.nextNotification('choros.reaction')
      await bob.call('choros.react', {
        session_id: PEER_B,
        msg_id: sent.msg_id,
        emoji: '👍',
      })
      const reaction = (await aliceReaction) as { msg_id: string; emoji: string }
      expect(reaction.msg_id).toBe(sent.msg_id)
      expect(reaction.emoji).toBe('👍')

      // Replace.
      const aliceReaction2 = alice.nextNotification('choros.reaction')
      await bob.call('choros.react', {
        session_id: PEER_B,
        msg_id: sent.msg_id,
        emoji: '🔥',
      })
      const r2 = (await aliceReaction2) as { emoji: string }
      expect(r2.emoji).toBe('🔥')

      // Only one row in reactions (upsert).
      const rows = daemon.storage.db
        .query('SELECT COUNT(*) AS n FROM reactions WHERE msg_id = ?')
        .get(sent.msg_id) as { n: number }
      expect(rows.n).toBe(1)
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('set_status + set_intent persist and survive reconnect', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A)
      await alice.call('choros.set_status', { session_id: PEER_A, text: 'working' })
      await alice.call('choros.set_intent', { session_id: PEER_A, text: 'ship v1' })
      const row = daemon.storage.db
        .query('SELECT agent_status, agent_intent FROM sessions WHERE id = ?')
        .get(PEER_A) as { agent_status: string; agent_intent: string }
      expect(row.agent_status).toBe('working')
      expect(row.agent_intent).toBe('ship v1')
      await alice.close()
    } finally {
      await daemon.stop()
    }
  })

  test('doctor returns self + peers with classifications', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const _bob = await registerClient(daemon, PEER_B, 'bob')
      const report = await alice.call<{ self: unknown; peers: { session_id: string }[] }>(
        'choros.doctor',
        { session_id: PEER_A },
      )
      expect(report.peers.map(p => p.session_id)).toContain(PEER_B)
      await alice.close()
      await _bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('thread join + send + member list', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const threadId = 'thread-root-1'
      await alice.call('choros.join_thread', { session_id: PEER_A, thread_id: threadId })
      const bobJoin = await bob.call<{ members: string[] }>('choros.join_thread', {
        session_id: PEER_B,
        thread_id: threadId,
      })
      expect(bobJoin.members.sort()).toEqual([PEER_A, PEER_B].sort())

      const bobInbound = bob.nextNotification('choros.inbound_message')
      const sent = await alice.call<{ msg_id: string; delivered_to: string[] }>(
        'choros.send_to_thread',
        { session_id: PEER_A, thread_id: threadId, body: 'thread msg' },
      )
      expect(sent.delivered_to).toEqual([PEER_B])
      const msg = (await bobInbound) as { thread_id: string; body: string }
      expect(msg.thread_id).toBe(threadId)
      expect(msg.body).toBe('thread msg')

      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('mark_read fires read_receipt to sender', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const bobInbound = bob.nextNotification('choros.inbound_message')
      const sent = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'read me',
      })
      await bobInbound

      const aliceRead = alice.nextNotification('choros.read_receipt')
      await bob.call('choros.mark_read', { session_id: PEER_B, msg_id: sent.msg_id })
      const receipt = (await aliceRead) as { msg_id: string; by_session: string }
      expect(receipt.msg_id).toBe(sent.msg_id)
      expect(receipt.by_session).toBe(PEER_B)
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('notifications buffered when shim is offline are drained on register', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      // Bob has never connected — sending to him buffers in pending_notifications.
      await alice.call('choros.send', { session_id: PEER_A, to: PEER_B, body: 'while-offline' })
      const buffered = daemon.storage.db
        .query('SELECT COUNT(*) AS n FROM pending_notifications WHERE session_id = ?')
        .get(PEER_B) as { n: number }
      expect(buffered.n).toBe(1)

      // Bob connects: register response carries the buffered notification.
      const bob = await connectTestClient(daemon.socketPath)
      const result = (await bob.call('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: PEER_B,
        display_name: 'bob',
        host: 'test',
        cwd: '/tmp',
        pid: 42,
      })) as { pending: { method: string; params: { body: string } }[] }
      expect(result.pending).toHaveLength(1)
      expect(result.pending[0]?.method).toBe('choros.inbound_message')
      expect(result.pending[0]?.params.body).toBe('while-offline')
      // Queue is now drained.
      const afterDrain = daemon.storage.db
        .query('SELECT COUNT(*) AS n FROM pending_notifications WHERE session_id = ?')
        .get(PEER_B) as { n: number }
      expect(afterDrain.n).toBe(0)
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })
})

describe('authz + error-contract regressions (post bug-r5/r6 saturation)', () => {
  test('react: self-react rejected as ERR_NOT_AUTHORIZED', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const sent = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'hi',
      })
      // The sender cannot react to their own message — they aren't
      // the recipient row's to_session.
      await expect(
        alice.call('choros.react', {
          session_id: PEER_A,
          msg_id: sent.msg_id,
          emoji: '👍',
        }),
      ).rejects.toThrow(/not a recipient/)
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('react: non-recipient rejected as ERR_NOT_AUTHORIZED', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const carol = await registerClient(daemon, PEER_C, 'carol')
      const sent = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'hi',
      })
      // Carol isn't a recipient — knowing the msg_id alone must not
      // let her fire a forged NOTIFY_REACTION at Alice.
      await expect(
        carol.call('choros.react', {
          session_id: PEER_C,
          msg_id: sent.msg_id,
          emoji: '🚀',
        }),
      ).rejects.toThrow(/not a recipient/)
      await alice.close()
      await bob.close()
      await carol.close()
    } finally {
      await daemon.stop()
    }
  })

  test('react: unknown msg_id returns ERR_NOT_FOUND', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      await expect(
        alice.call('choros.react', {
          session_id: PEER_A,
          msg_id: 'does-not-exist',
          emoji: '👍',
        }),
      ).rejects.toThrow(/unknown msg_id/)
      await alice.close()
    } finally {
      await daemon.stop()
    }
  })

  test('mark_read on a message addressed to someone else is rejected', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const carol = await registerClient(daemon, PEER_C, 'carol')
      const sent = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'for bob',
      })
      await expect(
        carol.call('choros.mark_read', { session_id: PEER_C, msg_id: sent.msg_id }),
      ).rejects.toThrow(/not your message/)
      await alice.close()
      await bob.close()
      await carol.close()
    } finally {
      await daemon.stop()
    }
  })

  test('confirm_delivery on a foreign msg_id is rejected', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const carol = await registerClient(daemon, PEER_C, 'carol')
      const sent = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'for bob',
      })
      await expect(
        carol.call('choros.confirm_delivery', { session_id: PEER_C, msg_id: sent.msg_id }),
      ).rejects.toThrow(/not your message/)
      await alice.close()
      await bob.close()
      await carol.close()
    } finally {
      await daemon.stop()
    }
  })

  test('unregistered connection cannot call non-register methods', async () => {
    const daemon = spawnTestDaemon()
    try {
      const client = await connectTestClient(daemon.socketPath)
      // The auth boundary requires a session binding (via register)
      // before any other method — an unregistered connection is
      // rejected, no silent success.
      await expect(
        client.call('choros.set_status', { session_id: PEER_A, text: 'wat' }),
      ).rejects.toThrow(/not registered/)
      await expect(client.call('choros.inbox', { session_id: PEER_A })).rejects.toThrow(
        /not registered/,
      )
      await client.close()
    } finally {
      await daemon.stop()
    }
  })

  test('a session cannot act as another by passing a foreign session_id', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      // Bob's connection passes Alice's session_id — the daemon binds
      // identity to the connection, so this is rejected even though
      // both are the same local user.
      await expect(bob.call('choros.inbox', { session_id: PEER_A })).rejects.toThrow(
        /does not match/,
      )
      await expect(
        bob.call('choros.set_status', { session_id: PEER_A, text: 'pwned' }),
      ).rejects.toThrow(/does not match/)
      // Alice's own status is untouched.
      const row = daemon.storage.db
        .query('SELECT agent_status FROM sessions WHERE id = ?')
        .get(PEER_A) as { agent_status: string | null }
      expect(row.agent_status).toBeNull()
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('send to nil UUID is rejected', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      await expect(
        alice.call('choros.send', {
          session_id: PEER_A,
          to: '00000000-0000-0000-0000-000000000000',
          body: 'into the void',
        }),
      ).rejects.toThrow(/nil UUID/)
      await alice.close()
    } finally {
      await daemon.stop()
    }
  })

  test('send by display_name is case-insensitive', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'Bob')
      const inbound = bob.nextNotification('choros.inbound_message')
      // Bob is registered with display_name 'Bob' (mixed case). Alice
      // sends to 'BOB' (upper); resolution should still find him.
      await alice.call('choros.send', { session_id: PEER_A, to: 'BOB', body: 'hi' })
      const msg = (await inbound) as { from_session: string; body: string }
      expect(msg.from_session).toBe(PEER_A)
      expect(msg.body).toBe('hi')
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('publish to a topic with no subscribers returns msg_id=null', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const result = await alice.call<{ msg_id: string | null; delivered_to: string[] }>(
        'choros.publish',
        { session_id: PEER_A, topic: 'lonely', body: 'anyone?' },
      )
      expect(result.msg_id).toBeNull()
      expect(result.delivered_to).toHaveLength(0)
      await alice.close()
    } finally {
      await daemon.stop()
    }
  })

  test('publish accepts a valid act and rejects an invalid one', async () => {
    // The gh-bridge regression: it published act:'fyi', which is not in
    // the speech-act taxonomy → handlePublish ERR_INVALID_PARAMS → the
    // bridge could never deliver. Exercise the real publish-with-act
    // path the bridge depends on (the MERGE_ACT unit test only pins the
    // constant, not this delivery).
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      await bob.call('choros.subscribe', { session_id: PEER_B, topic: 'rel' })
      const inbound = bob.nextNotification('choros.inbound_message')
      const ok = await alice.call<{ msg_id: string | null }>('choros.publish', {
        session_id: PEER_A,
        topic: 'rel',
        body: 'shipped',
        act: 'ANNOUNCE',
      })
      expect(ok.msg_id).not.toBeNull()
      const msg = (await inbound) as { act?: string; body: string }
      expect(msg.act).toBe('ANNOUNCE')
      await expect(
        alice.call('choros.publish', {
          session_id: PEER_A,
          topic: 'rel',
          body: 'nope',
          act: 'fyi',
        }),
      ).rejects.toThrow(/act|speech/i)
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('inbox returns unread messages and respects mark_read', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const s1 = await alice.call<{ msg_id: string }>('choros.send', {
        session_id: PEER_A,
        to: PEER_B,
        body: 'first',
      })
      await alice.call('choros.send', { session_id: PEER_A, to: PEER_B, body: 'second' })

      // Bob pulls his inbox — both unread, oldest first, with sender name.
      const inbox1 = await bob.call<{
        messages: { msg_id: string; body: string; from_name: string }[]
        truncated: boolean
      }>('choros.inbox', { session_id: PEER_B })
      expect(inbox1.messages).toHaveLength(2)
      expect(inbox1.messages[0]?.body).toBe('first')
      expect(inbox1.messages[1]?.body).toBe('second')
      expect(inbox1.messages[0]?.from_name).toBe('alice')
      expect(inbox1.truncated).toBe(false)

      // Row-limit truncation is signalled.
      const limited = await bob.call<{ messages: unknown[]; truncated: boolean }>('choros.inbox', {
        session_id: PEER_B,
        limit: 1,
      })
      expect(limited.messages).toHaveLength(1)
      expect(limited.truncated).toBe(true)

      // Mark the first read; inbox now returns only the second.
      await bob.call('choros.mark_read', { session_id: PEER_B, msg_id: s1.msg_id })
      const inbox2 = await bob.call<{ messages: { body: string }[]; truncated: boolean }>(
        'choros.inbox',
        { session_id: PEER_B },
      )
      expect(inbox2.messages).toHaveLength(1)
      expect(inbox2.messages[0]?.body).toBe('second')
      expect(inbox2.truncated).toBe(false)

      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('topic canonicalization: subscribe(FOO) reaches publish(foo)', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      await bob.call('choros.subscribe', { session_id: PEER_B, topic: 'FOO' })
      const inbound = bob.nextNotification('choros.inbound_message')
      const result = await alice.call<{ msg_id: string | null }>('choros.publish', {
        session_id: PEER_A,
        topic: 'foo',
        body: 'case-folded',
      })
      expect(result.msg_id).not.toBeNull()
      const msg = (await inbound) as { topic: string; body: string }
      expect(msg.topic).toBe('foo')
      expect(msg.body).toBe('case-folded')
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })
})

describe('presence + roster', () => {
  test('register returns the live roster', async () => {
    const daemon = spawnTestDaemon()
    try {
      await registerClient(daemon, PEER_A, 'alice')
      const bob = await connectTestClient(daemon.socketPath)
      const res = await bob.call<{
        roster: { session_id: string; display_name: string | null }[]
      }>('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: PEER_B,
        display_name: 'bob',
        host: 'test',
        cwd: '/tmp',
        pid: 1,
      })
      const alice = res.roster.find(r => r.session_id === PEER_A)
      expect(alice?.display_name).toBe('alice')
      expect(res.roster.some(r => r.session_id === PEER_B)).toBe(false) // never self
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })

  test('a joining session pushes a join presence to live peers', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const presence = alice.nextNotification('choros.presence')
      await registerClient(daemon, PEER_B, 'bob')
      const ev = (await presence) as { event: string; session_id: string; display_name: string }
      expect(ev.event).toBe('join')
      expect(ev.session_id).toBe(PEER_B)
      expect(ev.display_name).toBe('bob')
      await alice.close()
    } finally {
      await daemon.stop()
    }
  })

  test('a leaving session pushes a leave presence', async () => {
    const daemon = spawnTestDaemon()
    try {
      const alice = await registerClient(daemon, PEER_A, 'alice')
      const bob = await registerClient(daemon, PEER_B, 'bob')
      const presence = alice.nextNotification('choros.presence')
      await bob.call('choros.deregister', { session_id: PEER_B })
      const ev = (await presence) as { event: string; session_id: string }
      expect(ev.event).toBe('leave')
      expect(ev.session_id).toBe(PEER_B)
      await alice.close()
      await bob.close()
    } finally {
      await daemon.stop()
    }
  })
})
