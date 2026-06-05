import { describe, expect, test } from 'bun:test'
import { CodexAttachment, type JsonRpcLikeClient } from '#choros/codex/attachment.ts'
import { PROTOCOL_VERSION } from '#choros/protocol/methods.ts'

type CallRecord = { method: string; params: unknown }
type Handler = (params: unknown) => unknown | Promise<unknown>

class FakeClient implements JsonRpcLikeClient {
  calls: CallRecord[] = []
  handlers = new Map<string, Handler>()

  constructor(handlers: Record<string, Handler | unknown> = {}) {
    for (const [method, handler] of Object.entries(handlers)) {
      this.handlers.set(
        method,
        typeof handler === 'function' ? (handler as Handler) : () => handler,
      )
    }
  }

  async call<R = unknown>(method: string, params?: unknown): Promise<R> {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)
    if (!handler) return {} as R
    const result = await handler(params)
    if (result instanceof Error) throw result
    return result as R
  }
}

function registerResult(pending: { method: string; params: unknown }[] = []) {
  return {
    daemon_version: 'test',
    protocol_version: PROTOCOL_VERSION,
    pending,
    roster: [],
  }
}

function makeAttachment(codex: FakeClient, choros: FakeClient): CodexAttachment {
  return new CodexAttachment({
    threadId: 'thread-1',
    sessionId: 'aaaaaaaa-0000-0000-0000-000000000002',
    displayName: 'codex-test',
    codex,
    choros,
    startHeartbeat: false,
    logger: {
      log: (): void => {
        /* intentionally silent */
      },
    },
  })
}

describe('CodexAttachment', () => {
  test('resumes the thread, registers with Choros, injects pending events, and confirms', async () => {
    const codex = new FakeClient({
      'thread/resume': {},
      'thread/inject_items': {},
    })
    const choros = new FakeClient({
      'choros.register': registerResult([
        {
          method: 'choros.inbound_message',
          params: { msg_id: 'm1', from_name: 'alice', body: 'hello' },
        },
      ]),
      'choros.confirm_delivery': {},
    })

    await makeAttachment(codex, choros).start()

    expect(codex.calls.map(c => c.method)).toEqual(['thread/resume', 'thread/inject_items'])
    expect(choros.calls.map(c => c.method)).toEqual(['choros.register', 'choros.confirm_delivery'])
    expect(codex.calls[1]?.params).toEqual({
      threadId: 'thread-1',
      items: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[choros:inbound_message from_name=alice msg_id=m1]\nhello',
            },
          ],
        },
      ],
    })
  })

  test('reports a drop when app-server injection fails', async () => {
    const codex = new FakeClient({
      'thread/resume': {},
      'thread/inject_items': new Error('no app server'),
    })
    const choros = new FakeClient({
      'choros.register': registerResult(),
      'choros.report_drop': {},
    })
    const attachment = makeAttachment(codex, choros)
    await attachment.start()

    await attachment.handleChorosNotification('choros.inbound_message', {
      msg_id: 'm2',
      from_name: 'alice',
      body: 'lost',
    })

    expect(choros.calls.map(c => c.method)).toEqual(['choros.register', 'choros.report_drop'])
    expect(choros.calls[1]?.params).toEqual({
      session_id: 'aaaaaaaa-0000-0000-0000-000000000002',
      msg_id: 'm2',
    })
  })

  test('steers the active turn when requested', async () => {
    const codex = new FakeClient({
      'thread/resume': {},
      'thread/inject_items': {},
      'turn/steer': {},
    })
    const choros = new FakeClient({
      'choros.register': registerResult(),
      'choros.confirm_delivery': {},
    })
    const attachment = new CodexAttachment({
      threadId: 'thread-1',
      sessionId: 'aaaaaaaa-0000-0000-0000-000000000002',
      displayName: 'codex-test',
      codex,
      choros,
      steerActive: true,
      startHeartbeat: false,
      logger: {
        log: (): void => {
          /* intentionally silent */
        },
      },
    })
    await attachment.start()
    attachment.handleCodexNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1' },
    })

    await attachment.handleChorosNotification('choros.inbound_message', {
      msg_id: 'm3',
      from_name: 'alice',
      body: 'during turn',
    })

    expect(codex.calls.map(c => c.method)).toEqual([
      'thread/resume',
      'thread/inject_items',
      'turn/steer',
    ])
    expect(codex.calls[2]?.params).toEqual({
      threadId: 'thread-1',
      input: [
        {
          type: 'text',
          text: '[choros:inbound_message from_name=alice msg_id=m3]\nduring turn',
          text_elements: [],
        },
      ],
      expectedTurnId: 'turn-1',
    })
  })
})
