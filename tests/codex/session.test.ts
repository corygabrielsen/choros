import { describe, expect, test } from 'bun:test'
import {
  codexSessionId,
  defaultCodexDisplayName,
  resolveCodexIdentity,
} from '#choros/codex/session.ts'
import { UUID_RE } from '#choros/identity.ts'

describe('codex session identity', () => {
  test('maps a Codex thread id to a stable UUID-shaped Choros session id', () => {
    const a = codexSessionId('thread-abc')
    const b = codexSessionId('thread-abc')
    const c = codexSessionId('thread-def')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(UUID_RE.test(a)).toBe(true)
  })

  test('uses explicit inputs ahead of environment defaults', () => {
    const identity = resolveCodexIdentity({
      threadId: 'thread-from-arg',
      sessionId: 'explicit-session',
      displayName: 'agent-one',
      env: {
        CODEX_THREAD_ID: 'thread-from-env',
        CHOROS_IDENTITY: 'env-session',
        CHOROS_DISPLAY_NAME: 'env-name',
      },
    })
    expect(identity).toEqual({
      threadId: 'thread-from-arg',
      sessionId: 'explicit-session',
      displayName: 'agent-one',
    })
  })

  test('default display name is routeable and compact', () => {
    expect(defaultCodexDisplayName('thread_1234567890abcdef')).toBe('codex-thread_12345')
  })
})
