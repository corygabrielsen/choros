import { describe, expect, test } from 'bun:test'
import {
  ERR_METHOD_NOT_FOUND,
  ERR_PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  type RegisterResult,
} from '#choros/protocol/methods.ts'
import { connectTestClient, spawnTestDaemon } from './fixtures.ts'

describe('daemon foundation (Phase 1)', () => {
  test('register handshake assigns daemon_version + empty pending', async () => {
    const daemon = spawnTestDaemon()
    try {
      const client = await connectTestClient(daemon.socketPath)
      const result = await client.call<RegisterResult>('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: 'aaaaaaaa-1111-2222-3333-444444444444',
        display_name: 'tester',
        host: 'test-host',
        cwd: '/tmp/test',
        pid: 12345,
      })
      expect(result.daemon_version).toBe('test')
      expect(result.protocol_version).toBe(PROTOCOL_VERSION)
      expect(result.pending).toEqual([])
      await client.close()
    } finally {
      await daemon.stop()
    }
  })

  test('register persists the session row in SQLite', async () => {
    const daemon = spawnTestDaemon()
    try {
      const client = await connectTestClient(daemon.socketPath)
      await client.call('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: 'bbbbbbbb-1111-2222-3333-444444444444',
        display_name: 'persist-me',
        host: 'h',
        cwd: '/c',
        pid: 9001,
      })
      const row = daemon.storage.db
        .query('SELECT * FROM sessions WHERE id = ?')
        .get('bbbbbbbb-1111-2222-3333-444444444444') as { display_name: string; lock_pid: number }
      expect(row.display_name).toBe('persist-me')
      expect(row.lock_pid).toBe(9001)
      await client.close()
    } finally {
      await daemon.stop()
    }
  })

  test('register rejects mismatched protocol_version', async () => {
    const daemon = spawnTestDaemon()
    try {
      const client = await connectTestClient(daemon.socketPath)
      await expect(
        client.call('choros.register', {
          protocol_version: PROTOCOL_VERSION + 99,
          session_id: 'cccccccc-1111-2222-3333-444444444444',
          display_name: null,
          host: 'h',
          cwd: '/c',
          pid: 1,
        }),
      ).rejects.toThrow(/protocol mismatch/)
      await client.close()
      // No row should have been written for the rejected register.
      const row = daemon.storage.db
        .query('SELECT * FROM sessions WHERE id = ?')
        .get('cccccccc-1111-2222-3333-444444444444')
      expect(row).toBeNull()
    } finally {
      await daemon.stop()
    }
  })

  test('deregister clears lock_pid but keeps the row', async () => {
    const daemon = spawnTestDaemon()
    try {
      const client = await connectTestClient(daemon.socketPath)
      const id = 'dddddddd-1111-2222-3333-444444444444'
      await client.call('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: id,
        display_name: null,
        host: 'h',
        cwd: '/c',
        pid: 555,
      })
      await client.call('choros.deregister', { session_id: id })
      const row = daemon.storage.db
        .query('SELECT id, lock_pid FROM sessions WHERE id = ?')
        .get(id) as { id: string; lock_pid: number | null }
      expect(row.id).toBe(id)
      expect(row.lock_pid).toBeNull()
      await client.close()
    } finally {
      await daemon.stop()
    }
  })

  test('heartbeat updates heartbeat_at + ambient state', async () => {
    let now = '2026-05-19T12:00:00.000Z'
    const daemon = spawnTestDaemon({ nowIso: () => now })
    try {
      const client = await connectTestClient(daemon.socketPath)
      const id = 'eeeeeeee-1111-2222-3333-444444444444'
      await client.call('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: id,
        display_name: null,
        host: 'h',
        cwd: '/c',
        pid: 7,
      })
      now = '2026-05-19T12:00:30.000Z'
      await client.call('choros.heartbeat', {
        session_id: id,
        pid: 7,
        agent_status: 'working',
        agent_intent: 'ship it',
      })
      const row = daemon.storage.db
        .query('SELECT heartbeat_at, agent_status, agent_intent FROM sessions WHERE id = ?')
        .get(id) as { heartbeat_at: string; agent_status: string; agent_intent: string }
      expect(row.heartbeat_at).toBe('2026-05-19T12:00:30.000Z')
      expect(row.agent_status).toBe('working')
      expect(row.agent_intent).toBe('ship it')
      await client.close()
    } finally {
      await daemon.stop()
    }
  })

  test('unknown method returns method-not-found', async () => {
    const daemon = spawnTestDaemon()
    try {
      const client = await connectTestClient(daemon.socketPath)
      await expect(client.call('choros.does_not_exist', {})).rejects.toThrow(/unknown method/)
      await client.close()
    } finally {
      await daemon.stop()
    }
    void ERR_METHOD_NOT_FOUND
    void ERR_PROTOCOL_MISMATCH
  })

  test('admin /stats reports session + connected counts', async () => {
    const daemon = spawnTestDaemon()
    try {
      const client = await connectTestClient(daemon.socketPath)
      await client.call('choros.register', {
        protocol_version: PROTOCOL_VERSION,
        session_id: 'ffffffff-1111-2222-3333-444444444444',
        display_name: null,
        host: 'h',
        cwd: '/c',
        pid: 42,
      })
      // Bun fetch supports unix sockets via the `unix` field.
      const res = await fetch('http://localhost/stats', { unix: daemon.adminSocketPath })
      const body = (await res.json()) as { sessions: number; connected: number }
      expect(body.sessions).toBeGreaterThanOrEqual(1)
      expect(body.connected).toBeGreaterThanOrEqual(1)
      await client.close()
    } finally {
      await daemon.stop()
    }
  })
})
