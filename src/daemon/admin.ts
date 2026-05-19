import type { SessionRouter } from '#choros/daemon/sessions.ts'
import type { Storage } from '#choros/daemon/storage.ts'

/** Handle returned by {@link startAdminServer}. */
export interface AdminServer {
  readonly socketPath: string
  stop(): Promise<void>
}

/** HTTP admin endpoint over a separate Unix socket. Curl-able for
 *  human debugging + cockpit integration:
 *
 *      curl --unix-socket choros.admin.sock http://localhost/peers
 *      curl --unix-socket choros.admin.sock http://localhost/stats
 *
 *  Read-only by design — admin writes go through the JSON-RPC server
 *  so they share the same handler surface as production traffic. */
export function startAdminServer(opts: {
  socketPath: string
  storage: Storage
  router: SessionRouter
}): AdminServer {
  const server = Bun.serve({
    unix: opts.socketPath,
    fetch(req): Response {
      const url = new URL(req.url)
      switch (url.pathname) {
        case '/peers': {
          const rows = opts.storage.db
            .query(
              `SELECT id, display_name, host, cwd, lock_pid, heartbeat_at, wedged_at,
                      agent_status, agent_intent
               FROM sessions ORDER BY heartbeat_at DESC NULLS LAST`,
            )
            .all() as unknown[]
          return Response.json({ peers: rows })
        }
        case '/stats': {
          const sessions = opts.storage.db.query('SELECT COUNT(*) AS n FROM sessions').get() as {
            n: number
          }
          const messages = opts.storage.db.query('SELECT COUNT(*) AS n FROM messages').get() as {
            n: number
          }
          return Response.json({
            sessions: sessions.n,
            messages: messages.n,
            connected: opts.router.connectedSessionIds().length,
          })
        }
        case '/health':
          return Response.json({ ok: true })
        default:
          return new Response('not found', { status: 404 })
      }
    },
  })

  return {
    socketPath: opts.socketPath,
    stop(): Promise<void> {
      return server.stop(true)
    },
  }
}
