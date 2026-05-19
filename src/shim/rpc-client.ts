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
}

/** Max bytes for a single NDJSON frame from the daemon. Matches the
 *  daemon's server-side cap so the shim never wedges on an oversized
 *  drain frame. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Reconnect backoff schedule: 1s, 2s, 4s, 8s, …, capped at 30s. */
const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/** Open a connection to the daemon. On disconnect, retries forever
 *  with exponential backoff (1s → 30s cap) so a daemon outage longer
 *  than a single retry doesn't permanently strand the shim. */
export async function connectRpcClient(opts: {
  socketPath: string
  onNotification: NotificationHandler
  /** Called once each time the socket reconnects (initial connect
   *  counts as one). Useful for re-registering the session. */
  onConnect?: () => void | Promise<void>
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
    if ('error' in msg) handler.reject(new Error(`rpc: ${msg.error.message}`))
    else handler.resolve(msg.result)
  }

  function onData(chunk: Buffer): void {
    buf += chunk.toString('utf8')
    if (buf.length > MAX_FRAME_BYTES) {
      process.stderr.write(
        `[choros-shim] daemon sent oversized frame (${buf.length}B); closing connection\n`,
      )
      try {
        socket?.end()
      } catch {
        /* already gone */
      }
      buf = ''
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
    const delay = reconnectDelay
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (closed) return
      void open()
        .then(async () => {
          // Successful reconnect resets the backoff for the next outage.
          reconnectDelay = RECONNECT_INITIAL_MS
          if (opts.onConnect) await opts.onConnect()
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
          for (const [, h] of pending) h.reject(new Error('rpc: connection closed'))
          pending.clear()
          buf = ''
          if (closed) return
          scheduleReconnect()
        },
      },
    })
    if (opts.onConnect) await opts.onConnect()
  }

  await open()

  return {
    call<R>(method: string, params?: unknown): Promise<R> {
      if (!socket) return Promise.reject(new Error('rpc: not connected'))
      const id = ++idCounter
      const req: RpcRequest = { jsonrpc: '2.0', id, method, params }
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        socket?.write(`${JSON.stringify(req)}\n`)
      })
    },
    close(): Promise<void> {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      socket?.end()
      socket = null
      return Promise.resolve()
    },
    isConnected(): boolean {
      return socket !== null
    },
  }
}
