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

/** Open a connection to the daemon. On disconnect, the client
 *  attempts a single reconnect after `reconnectDelayMs` so a daemon
 *  bounce (systemd restart, upgrade) doesn't tear down the shim. */
export async function connectRpcClient(opts: {
  socketPath: string
  onNotification: NotificationHandler
  /** Called once each time the socket reconnects (initial connect
   *  counts as one). Useful for re-registering the session. */
  onConnect?: () => void | Promise<void>
  reconnectDelayMs?: number
}): Promise<RpcClient> {
  let buf = ''
  let idCounter = 0
  const pending = new Map<number, PendingHandler>()
  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null
  let closed = false
  let reconnecting = false
  const reconnectDelay = opts.reconnectDelayMs ?? 1_000

  function dispatchMessage(raw: string): void {
    let msg: RpcResponse | { method: string; params: unknown; id?: undefined }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if ('id' in msg && msg.id !== undefined) {
      const id = typeof msg.id === 'number' ? msg.id : Number.parseInt(String(msg.id), 10)
      const handler = pending.get(id)
      if (!handler) return
      pending.delete(id)
      if ('error' in msg) handler.reject(new Error(`rpc: ${msg.error.message}`))
      else handler.resolve(msg.result)
    } else if ('method' in msg) {
      opts.onNotification(msg.method, msg.params)
    }
  }

  function onData(chunk: Buffer): void {
    buf += chunk.toString('utf8')
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (line.length > 0) dispatchMessage(line)
    }
  }

  async function open(): Promise<void> {
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
          if (closed || reconnecting) return
          reconnecting = true
          setTimeout(() => {
            reconnecting = false
            if (closed) return
            void open()
              .then(async () => {
                if (opts.onConnect) await opts.onConnect()
              })
              .catch(err => {
                process.stderr.write(
                  `[choros-shim] reconnect failed: ${err instanceof Error ? err.message : err}\n`,
                )
              })
          }, reconnectDelay)
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
      socket?.end()
      socket = null
      return Promise.resolve()
    },
    isConnected(): boolean {
      return socket !== null
    },
  }
}
