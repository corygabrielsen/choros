import { chmodSync } from 'node:fs'
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
 *  The socket is chmod'd to 0600 immediately after bind so only the
 *  invoking user can connect — even if `/peers` would otherwise leak
 *  agent_status / agent_intent (user-set strings that may contain
 *  context the operator didn't intend to share with other local
 *  processes). Read-only by design — admin writes go through the
 *  JSON-RPC server so they share the same handler surface as
 *  production traffic. */
export function startAdminServer(opts: {
  socketPath: string
  storage: Storage
  router: SessionRouter
}): AdminServer {
  const server = Bun.serve({
    unix: opts.socketPath,
    fetch(req): Response {
      // Reject non-GET methods so future writeable endpoints have to
      // be opted into explicitly.
      if (req.method !== 'GET') {
        return new Response('method not allowed', { status: 405 })
      }
      const url = new URL(req.url)
      switch (url.pathname) {
        case '/peers': {
          // Default payload: classification-relevant fields only.
          // Pass `?verbose=1` to include ambient state (agent_status /
          // agent_intent) which may contain context-sensitive strings.
          const verbose = url.searchParams.get('verbose') === '1'
          const baseFields = 'id, display_name, host, lock_pid, heartbeat_at, wedged_at'
          const cols = verbose ? `${baseFields}, agent_status, agent_intent` : baseFields
          // Cap rows so a swarm with thousands of historical sessions
          // doesn't dump the whole table on every poll; cockpit refreshes
          // /peers on every render. Override via `?limit=N` (1..1000).
          const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
          const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 200
          // Cap the offset symmetrically with the limit so
          // `?offset=999999999` doesn't walk that many index rows on
          // every poll. 1M is well past any plausible operator history.
          const rawOffset = Number.parseInt(url.searchParams.get('offset') ?? '', 10)
          const offset =
            Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(rawOffset, 1_000_000) : 0
          const rows = opts.storage.db
            .query(
              `SELECT ${cols} FROM sessions ORDER BY heartbeat_at DESC NULLS LAST LIMIT ? OFFSET ?`,
            )
            .all(limit, offset) as unknown[]
          return Response.json({ peers: rows, limit, offset })
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
        case '/health': {
          // Probe the DB so /health actually distinguishes "process
          // alive" from "process alive but DB unusable."
          try {
            opts.storage.db.query('SELECT 1').get()
            return Response.json({ ok: true })
          } catch (e: unknown) {
            const m = e instanceof Error ? e.message : String(e)
            return Response.json({ ok: false, error: m }, { status: 503 })
          }
        }
        default:
          return new Response('not found', { status: 404 })
      }
    },
  })

  // Restrict the admin socket to user-only after Bun creates it. The
  // default mode is 0755 which would let any local process on the box
  // read `agent_status` / `agent_intent` — fields the user may set
  // assuming session-internal scope.
  try {
    chmodSync(opts.socketPath, 0o600)
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    process.stderr.write(`[choros-daemon] admin socket chmod failed: ${m}\n`)
  }

  return {
    socketPath: opts.socketPath,
    stop(): Promise<void> {
      return server.stop(true)
    },
  }
}
