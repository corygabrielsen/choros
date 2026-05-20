import type { RpcRequest, RpcResponse } from '#choros/protocol/methods.ts'

/** Callback shape for daemon → shim notifications. The shim's MCP
 *  layer wires this to `server.notification(...)` so each daemon
 *  event surfaces as a `<channel source="choros…">` in the CC log. */
export type NotificationHandler = (method: string, params: unknown) => void

/** Reconnecting JSON-RPC 2.0 client over a Unix socket. NDJSON
 *  framing matches the daemon's RPC server. Tool calls are
 *  promise-correlated by `id`; notifications (no `id`) are routed
 *  through the configured handler. */
export interface RpcClient {
  /** Issue a request and wait for its response. Rejects with the
   *  daemon's RPC error message verbatim on failure. */
  call<R = unknown>(method: string, params?: unknown): Promise<R>
  /** Close the connection. Pending requests reject with "closed". */
  close(): Promise<void>
  /** True iff the underlying socket is currently connected. */
  isConnected(): boolean
}

interface PendingHandler {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Error carrying the daemon's numeric JSON-RPC code so callers branch
 *  on the code, not the prose message. */
export interface RpcClientError extends Error {
  code?: number
}

/** Max bytes for a single NDJSON frame from the daemon. Matches the
 *  daemon's server-side cap so the shim never wedges on an oversized
 *  drain frame. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Reconnect backoff schedule: 1s, 2s, 4s, 8s, …, capped at 30s. */
const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/** Per-call timeout. Without this, a daemon that accepts the request
 *  but never replies (kernel-buffer accepts, daemon wedged before
 *  response) hangs the call forever and grows `pending` unboundedly.
 *  30s comfortably covers the slowest real handler (register backlog
 *  drain) but cuts off wedges. */
const CALL_TIMEOUT_MS = 30_000

/** Open a connection to the daemon. On disconnect, retries forever
 *  with exponential backoff (1s → 30s cap) so a daemon outage longer
 *  than a single retry doesn't permanently strand the shim. */
export async function connectRpcClient(opts: {
  socketPath: string
  onNotification: NotificationHandler
  /** Called once each time the socket reconnects (initial connect
   *  counts as one). Receives the client so the callback can issue
   *  the register handshake without capturing an outer `const rpc`
   *  binding that's still in its TDZ on the first call. */
  onConnect?: (client: RpcClient) => void | Promise<void>
}): Promise<RpcClient> {
  let buf = ''
  let idCounter = 0
  const pending = new Map<number, PendingHandler>()
  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null
  let closed = false
  let reconnectDelay = RECONNECT_INITIAL_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function dispatchMessage(raw: string): void {
    let msg: RpcResponse | { method: string; params: unknown; id?: undefined }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!('id' in msg) || msg.id === undefined) {
      if ('method' in msg && typeof msg.method === 'string') {
        opts.onNotification(msg.method, msg.params)
      }
      return
    }
    if (typeof msg.id !== 'number') return
    const handler = pending.get(msg.id)
    if (!handler) return
    pending.delete(msg.id)
    clearTimeout(handler.timer)
    if ('error' in msg) {
      // Carry the numeric JSON-RPC code on the Error so callers can
      // branch on the code (ERR_UNKNOWN_SESSION, ERR_PROTOCOL_MISMATCH)
      // rather than substring-matching the prose message — which
      // silently breaks if the daemon's wording changes.
      const err = new Error(`rpc: ${msg.error.message}`) as RpcClientError
      err.code = msg.error.code
      handler.reject(err)
    } else handler.resolve(msg.result)
  }

  function onData(chunk: Buffer): void {
    // Drop chunks for a socket that's already been torn down (e.g.
    // close fired between two `data` callbacks). Otherwise the buffer
    // can re-accumulate after we cleared it on oversize.
    if (!socket) return
    buf += chunk.toString('utf8')
    if (buf.length > MAX_FRAME_BYTES) {
      process.stderr.write(
        `[choros-shim] daemon sent oversized frame (${buf.length}B); closing connection\n`,
      )
      const dead = socket
      socket = null
      buf = ''
      try {
        dead.end()
      } catch {
        /* already gone */
      }
      return
    }
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (line.length > 0) dispatchMessage(line)
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return
    // ±20% jitter so a daemon restart doesn't wake every shim + the
    // gh-bridge in lockstep (thundering herd of simultaneous register
    // round-trips). Backoff caps the rate; jitter de-synchronizes the
    // phase.
    const delay = Math.round(reconnectDelay * (0.8 + Math.random() * 0.4))
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (closed) return
      void open()
        .then(() => {
          // Successful reconnect resets the backoff. onConnect already
          // fires from inside open() — don't call it twice here.
          reconnectDelay = RECONNECT_INITIAL_MS
        })
        .catch(err => {
          process.stderr.write(
            `[choros-shim] reconnect failed (${err instanceof Error ? err.message : err}); retrying in ${reconnectDelay}ms\n`,
          )
          scheduleReconnect()
        })
    }, delay)
    reconnectTimer.unref?.()
  }

  async function open(): Promise<void> {
    // Reset per-connection state so half-frames from a prior socket
    // don't corrupt the first response after reconnect.
    buf = ''
    socket = await Bun.connect({
      unix: opts.socketPath,
      socket: {
        data(_s, chunk) {
          onData(chunk)
        },
        close() {
          socket = null
          for (const [, h] of pending) {
            clearTimeout(h.timer)
            h.reject(new Error('rpc: connection closed'))
          }
          pending.clear()
          buf = ''
          if (closed) return
          scheduleReconnect()
        },
      },
    })
    if (opts.onConnect) {
      try {
        await opts.onConnect(client)
      } catch (e) {
        // A throwing onConnect (e.g. shim register handler) MUST NOT
        // strand the open socket. Tear it down and let the close
        // handler schedule a reconnect.
        const dead = socket
        socket = null
        try {
          dead?.end()
        } catch {
          /* already gone */
        }
        throw e
      }
    }
  }

  // `client` is referenced inside `open()` (via the onConnect call).
  // Declared after `open` so the closure captures the binding; the
  // initial `open()` call below happens after this assignment so the
  // const is initialized by the time onConnect runs.
  const client: RpcClient = {
    call<R>(method: string, params?: unknown): Promise<R> {
      if (closed) return Promise.reject(new Error('rpc: client closed'))
      if (!socket) return Promise.reject(new Error('rpc: not connected'))
      const id = ++idCounter
      const req: RpcRequest = { jsonrpc: '2.0', id, method, params }
      return new Promise<R>((resolve, reject) => {
        // Register the pending handler BEFORE writing — if the socket
        // closes between write and response the close handler iterates
        // `pending` and rejects each entry, which we'd miss if we
        // registered after the write.
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`rpc: timeout after ${CALL_TIMEOUT_MS}ms calling ${method}`))
          }
        }, CALL_TIMEOUT_MS)
        timer.unref?.()
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        try {
          socket?.write(`${JSON.stringify(req)}\n`)
        } catch (e: unknown) {
          pending.delete(id)
          clearTimeout(timer)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    },
    close(): Promise<void> {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const dead = socket
      socket = null
      // Reject every in-flight call so callers don't hang forever on
      // a shim shutdown that races with a pending response.
      for (const [, h] of pending) {
        clearTimeout(h.timer)
        h.reject(new Error('rpc: client closed'))
      }
      pending.clear()
      try {
        dead?.end()
      } catch {
        /* already gone */
      }
      return Promise.resolve()
    },
    isConnected(): boolean {
      return socket !== null
    },
  }

  // Cold start must tolerate a daemon that isn't up yet. Bun.connect
  // rejects with ENOENT (socket absent) or ECONNREFUSED (stale inode
  // from a SIGKILL'd daemon) — if that propagated, the caller's
  // top-level `await connectRpcClient(...)` would crash the process
  // before it could install its MCP handlers, surfacing as a "failed"
  // MCP server. Instead, swallow the initial failure and arm the
  // backoff loop; `call()` rejects with "not connected" until the
  // daemon appears, and onConnect (register) fires on first success.
  try {
    await open()
  } catch (e) {
    // Log — every other failure path here writes to stderr; a silent
    // initial-connect failure makes a persistent misconfig (wrong
    // socket path, perms) indistinguishable from "daemon not up yet."
    process.stderr.write(
      `[choros-rpc] initial connect failed (${e instanceof Error ? e.message : e}); retrying with backoff\n`,
    )
    scheduleReconnect()
  }
  return client
}
