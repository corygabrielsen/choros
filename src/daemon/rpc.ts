import { handleDeregister } from '#choros/daemon/handlers/deregister.ts'
import { handleHeartbeat } from '#choros/daemon/handlers/heartbeat.ts'
import { type HandlerCtx, handleRegister } from '#choros/daemon/handlers/register.ts'
import type { NotificationSink } from '#choros/daemon/sessions.ts'
import {
  ERR_INTERNAL,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  type RpcError,
  type RpcRequest,
  type RpcResponse,
} from '#choros/protocol/methods.ts'

/** Handle returned by {@link startRpcServer}. */
export interface RpcServer {
  /** Bound Unix socket path. */
  readonly socketPath: string
  /** Stop accepting connections and close every open one. */
  stop(): Promise<void>
}

/** Spawn a JSON-RPC 2.0 server on a Unix socket. Each connection
 *  speaks NDJSON — one message per line. The server dispatches to
 *  the Phase 1 handlers (register / deregister / heartbeat); unknown
 *  methods return a JSON-RPC method-not-found error. */
export function startRpcServer(opts: { socketPath: string; ctx: HandlerCtx }): RpcServer {
  // Per-connection line buffer. Bun's socket `data` callback may
  // deliver partial NDJSON; we accumulate until a `\n` arrives.
  const buffers = new WeakMap<object, string>()

  const listener = Bun.listen<NotificationSink>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        const sink: NotificationSink = {
          write(line) {
            // Bun's socket.write returns the bytes accepted; for a
            // Unix datagram this is reliable in practice, but we
            // don't fail loud on partial writes — the daemon's
            // notification path handles partial delivery as "shim
            // dropped, requeue".
            try {
              socket.write(line.endsWith('\n') ? line : `${line}\n`)
            } catch {
              /* socket gone; isOpen will catch on next check */
            }
          },
          isOpen() {
            // Bun's `socket.readyState` is a numeric enum in some
            // releases and a string union in others; coerce to a
            // string for the comparison so both shapes are handled.
            return String(socket.readyState) === 'open' || socket.readyState === 1
          },
        }
        ;(socket as unknown as { data: NotificationSink }).data = sink
        buffers.set(socket as unknown as object, '')
      },
      data(socket, chunk) {
        const key = socket as unknown as object
        const sink = (socket as unknown as { data: NotificationSink }).data
        let buf = buffers.get(key) ?? ''
        buf += chunk.toString('utf8')
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.length > 0) {
            const response = processLine(line, sink, opts.ctx)
            if (response !== null) sink.write(JSON.stringify(response))
          }
          nl = buf.indexOf('\n')
        }
        buffers.set(key, buf)
      },
      close(socket) {
        const sink = (socket as unknown as { data: NotificationSink | undefined }).data
        if (sink) opts.ctx.router.unbindBySink(sink)
        buffers.delete(socket as unknown as object)
      },
      error(_socket, err) {
        // Daemon stays up on a per-connection error; the connection's
        // close handler will tear down its routing binding.
        process.stderr.write(`[choros-daemon] connection error: ${err.message ?? err}\n`)
      },
    },
  })

  return {
    socketPath: opts.socketPath,
    stop(): Promise<void> {
      listener.stop(true)
      return Promise.resolve()
    },
  }
}

function processLine(line: string, sink: NotificationSink, ctx: HandlerCtx): RpcResponse | null {
  let req: RpcRequest
  try {
    req = JSON.parse(line)
  } catch {
    return errResponse(null, ERR_PARSE, 'parse error')
  }
  if (req?.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return errResponse(req?.id ?? null, ERR_INVALID_REQUEST, 'invalid JSON-RPC envelope')
  }
  // JSON-RPC notifications (no id field) are intentionally one-way;
  // the shim never sends them today, but reserve the shape anyway.
  if (req.id === undefined) return null
  const outcome = dispatch(req, sink, ctx)
  if (outcome && typeof outcome === 'object' && 'code' in outcome && 'message' in outcome) {
    return { jsonrpc: '2.0', id: req.id, error: outcome as RpcError }
  }
  return { jsonrpc: '2.0', id: req.id, result: outcome }
}

function dispatch(req: RpcRequest, sink: NotificationSink, ctx: HandlerCtx): RpcError | unknown {
  try {
    switch (req.method) {
      case 'choros.register':
        return handleRegister(ctx, sink, req.params)
      case 'choros.deregister':
        return handleDeregister(ctx, req.params)
      case 'choros.heartbeat':
        return handleHeartbeat(ctx, req.params)
      default:
        return { code: ERR_METHOD_NOT_FOUND, message: `unknown method: ${req.method}` }
    }
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    return { code: ERR_INTERNAL, message: `internal error: ${m}` }
  }
}

function errResponse(id: RpcRequest['id'] | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? 0, error: { code, message } }
}
