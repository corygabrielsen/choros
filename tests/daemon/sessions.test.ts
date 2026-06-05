import { describe, expect, test } from 'bun:test'
import { type NotificationSink, SessionRouter } from '#choros/daemon/sessions.ts'

function fakeSink(): NotificationSink {
  return {
    write: () => true,
    isOpen: () => true,
  }
}

describe('SessionRouter', () => {
  test('reconnect: same session on a new sink drops the old sink', () => {
    const router = new SessionRouter()
    const s1 = fakeSink()
    const s2 = fakeSink()
    router.bind('A', s1, null)
    router.bind('A', s2, null)
    expect(router.sinkFor('A')).toBe(s2)
    expect(router.sessionForSink(s1)).toBeNull()
    expect(router.sessionForSink(s2)).toBe('A')
    expect(router.connectedSessionIds()).toEqual(['A'])
  })

  test('identity rotation: same sink re-bound to a new session drops the old session', () => {
    // Register-as-A then register-as-B on ONE connection. Without
    // evicting A's forward entry, sinkFor('A') would leak B's sink.
    const router = new SessionRouter()
    const sink = fakeSink()
    router.bind('A', sink, null)
    router.bind('B', sink, null)
    expect(router.sinkFor('A')).toBeNull()
    expect(router.sinkFor('B')).toBe(sink)
    expect(router.sessionForSink(sink)).toBe('B')
    expect(router.connectedSessionIds()).toEqual(['B'])
  })

  test('re-bind of the same (session, sink) pair is a no-op', () => {
    const router = new SessionRouter()
    const sink = fakeSink()
    router.bind('A', sink, 'alice')
    router.bind('A', sink, 'alice')
    expect(router.sinkFor('A')).toBe(sink)
    expect(router.sessionForSink(sink)).toBe('A')
    expect(router.connectedSessionIds()).toEqual(['A'])
  })

  test('tool-only binding authorizes without stealing notification sink', () => {
    const router = new SessionRouter()
    const notify = fakeSink()
    const tool = fakeSink()
    router.bind('A', notify, 'alice')
    router.bind('A', tool, 'alice', { receiveNotifications: false })
    expect(router.sinkFor('A')).toBe(notify)
    expect(router.sessionForSink(notify)).toBe('A')
    expect(router.sessionForSink(tool)).toBe('A')
    expect(router.connectedSessionIds()).toEqual(['A'])
  })
})
