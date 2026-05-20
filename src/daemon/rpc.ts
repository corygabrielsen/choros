import { chmodSync } from 'node:fs'
import { handleBroadcast } from '#choros/daemon/handlers/broadcast.ts'
import { handleDeregister } from '#choros/daemon/handlers/deregister.ts'
import { handleDoctor } from '#choros/daemon/handlers/doctor.ts'
import { handleHeartbeat } from '#choros/daemon/handlers/heartbeat.ts'
import { handleInbox } from '#choros/daemon/handlers/inbox.ts'
import { handleConfirmDelivery, handleMarkRead } from '#choros/daemon/handlers/inbox_ops.ts'
import { handlePublish } from '#choros/daemon/handlers/publish.ts'
import { handleReact } from '#choros/daemon/handlers/react.ts'
import { type HandlerCtx, handleRegister } from '#choros/daemon/handlers/register.ts'
import { handleSend } from '#choros/daemon/handlers/send.ts'
import { handleSetDisplayName } from '#choros/daemon/handlers/set_display_name.ts'
import { handleSetIntent, handleSetStatus } from '#choros/daemon/handlers/set_state.ts'
import { handleSubscribe, handleUnsubscribe } from '#choros/daemon/handlers/subscribe.ts'
import {
  handleJoinThread,
  handleLeaveThread,
  handleListThreads,
  handleSendToThread,
} from '#choros/daemon/handlers/threads.ts'
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

/** Maximum bytes a single NDJSON frame may occupy. A peer that
 *  streams without newlines would otherwise grow the per-connection
 *  buffer until V8's string limit; this cap turns that DoS into a
 *  bounded error. 4 MiB is well above the 64 KB body cap plus all
 *  envelope overhead and per-recipient drain frames in pending
 *  notifications. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Spawn a JSON-RPC 2.0 server on a Unix socket. Each connection
 *  speaks NDJSON — one message per line, capped at {@link
 *  MAX_FRAME_BYTES}. The server dispatches to the registered
 *  handlers; unknown methods return a JSON-RPC method-not-found
 *  error. The socket is chmod'd to 0600 after bind so only the
 *  invoking user can connect — choros is a per-user service. */
export function startRpcServer(opts: { socketPath: string; ctx: HandlerCtx }): RpcServer {
  // Per-connection line buffer. Bun's socket `data` callback may
  // deliver partial NDJSON; we accumulate until a `\n` arrives.
  const buffers = new WeakMap<object, string>()
  // Per-connection "dropped" sentinel: when a connection sends an
  // oversized frame we call socket.end() but more chunks may arrive
  // before the close event fires. This set lets us ignore those
  // chunks instead of starting a fresh buffer that could re-overflow.
  const dropped = new WeakSet<object>()

  const listener = Bun.listen<NotificationSink>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        const sink: NotificationSink = {
          write(line) {
            // Returns true iff the bytes were handed to the kernel.
            // The daemon's notification path falls back to the
            // pending-notifications queue when this returns false.
            const ready = String(socket.readyState) === 'open' || socket.readyState === 1
            if (!ready) return false
            try {
              socket.write(line.endsWith('\n') ? line : `${line}\n`)
              return true
            } catch {
              return false
            }
          },
          isOpen() {
            return String(socket.readyState) === 'open' || socket.readyState === 1
          },
        }
        ;(socket as unknown as { data: NotificationSink }).data = sink
        buffers.set(socket as unknown as object, '')
      },
      data(socket, chunk) {
        const key = socket as unknown as object
        if (dropped.has(key)) return
        const sink = (socket as unknown as { data: NotificationSink }).data
        let buf = buffers.get(key) ?? ''
        buf += chunk.toString('utf8')
        if (buf.length > MAX_FRAME_BYTES) {
          // Drop the connection rather than grow unbounded. Frames
          // larger than the cap come either from a buggy client or a
          // DoS attempt; either way we want bounded memory.
          process.stderr.write(
            `[choros-daemon] connection sent oversized frame (${buf.length}B > ${MAX_FRAME_BYTES}B); dropping\n`,
          )
          dropped.add(key)
          buffers.delete(key)
          try {
            socket.end()
          } catch {
            /* already gone */
          }
          return
        }
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

  try {
    chmodSync(opts.socketPath, 0o600)
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    process.stderr.write(`[choros-daemon] rpc socket chmod failed: ${m}\n`)
  }

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
  // JSON-RPC notifications are requests with NO id field. Both `id`
  // absent and `id: null` are treated as notifications (per spec,
  // null id in requests is reserved; we ignore them to avoid sending
  // responses to id=null that would collide with parse-error replies).
  if (req.id === undefined || req.id === null) return null
  if (typeof req.id !== 'number' && typeof req.id !== 'string') {
    return errResponse(null, ERR_INVALID_REQUEST, 'invalid id type')
  }
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
      case 'choros.send':
        return handleSend(ctx, req.params)
      case 'choros.broadcast':
        return handleBroadcast(ctx, req.params)
      case 'choros.publish':
        return handlePublish(ctx, req.params)
      case 'choros.subscribe':
        return handleSubscribe(ctx, req.params)
      case 'choros.unsubscribe':
        return handleUnsubscribe(ctx, req.params)
      case 'choros.react':
        return handleReact(ctx, req.params)
      case 'choros.set_status':
        return handleSetStatus(ctx, req.params)
      case 'choros.set_intent':
        return handleSetIntent(ctx, req.params)
      case 'choros.set_display_name':
        return handleSetDisplayName(ctx, req.params)
      case 'choros.doctor':
        return handleDoctor(ctx, req.params)
      case 'choros.join_thread':
        return handleJoinThread(ctx, req.params)
      case 'choros.leave_thread':
        return handleLeaveThread(ctx, req.params)
      case 'choros.list_threads':
        return handleListThreads(ctx, req.params)
      case 'choros.send_to_thread':
        return handleSendToThread(ctx, req.params)
      case 'choros.confirm_delivery':
        return handleConfirmDelivery(ctx, req.params)
      case 'choros.mark_read':
        return handleMarkRead(ctx, req.params)
      case 'choros.inbox':
        return handleInbox(ctx, req.params)
      default:
        return { code: ERR_METHOD_NOT_FOUND, message: `unknown method: ${req.method}` }
    }
  } catch (e: unknown) {
    // Log the underlying error to stderr for operators but never
    // surface SQLite / runtime detail over the wire — message content
    // ("UNIQUE constraint failed: messages.id", file paths, etc) leaks
    // schema + filesystem hints to callers.
    const m = e instanceof Error ? e.message : String(e)
    process.stderr.write(`[choros-daemon] handler ${req.method} threw: ${m}\n`)
    return { code: ERR_INTERNAL, message: 'internal error' }
  }
}

function errResponse(id: RpcRequest['id'] | null, code: number, message: string): RpcResponse {
  // Per JSON-RPC 2.0, a response for an un-parseable request uses
  // id=null. Don't coerce null to 0 — that would collide with a
  // legitimate response for id=0.
  return {
    jsonrpc: '2.0',
    id: id ?? (null as unknown as RpcRequest['id']),
    error: { code, message },
  }
}
