import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AdminServer, startAdminServer } from '#choros/daemon/admin.ts'
import type { HandlerCtx } from '#choros/daemon/handlers/register.ts'
import { type RpcServer, startRpcServer } from '#choros/daemon/rpc.ts'
import { SessionRouter } from '#choros/daemon/sessions.ts'
import { openStorage, type Storage } from '#choros/daemon/storage.ts'
import type { RpcRequest, RpcResponse } from '#choros/protocol/methods.ts'

/** In-process daemon stand-up for integration tests. Real Unix
 *  sockets in a tmp dir; real SQLite (on disk so WAL mode behaves as
 *  in production). Caller is responsible for calling `stop()`. */
export interface TestDaemon {
  storage: Storage
  router: SessionRouter
  rpc: RpcServer
  admin: AdminServer
  socketPath: string
  adminSocketPath: string
  stateRoot: string
  stop(): Promise<void>
}

/** Spawn a fully-wired daemon backed by a fresh tmp state root. The
 *  sockets are real (a real Bun.listen on disk), but storage is
 *  `:memory:`. Empirically the on-disk SQLite open dominated ~60% of
 *  per-test wall time and the suite has no concurrent-reader/writer
 *  assertions that require WAL-on-disk behavior. */
export function spawnTestDaemon(opts?: { nowIso?: () => string }): TestDaemon {
  const stateRoot = mkdtempSync(join(tmpdir(), 'choros-test-'))
  const socketPath = join(stateRoot, 'daemon.sock')
  const adminSocketPath = join(stateRoot, 'admin.sock')
  const storage = openStorage(':memory:')
  const router = new SessionRouter()
  const ctx: HandlerCtx = {
    storage,
    router,
    daemon: { version: 'test' },
    nowIso: opts?.nowIso ?? ((): string => new Date().toISOString()),
  }
  const rpc = startRpcServer({ socketPath, ctx })
  const admin = startAdminServer({ socketPath: adminSocketPath, storage, router })

  return {
    storage,
    router,
    rpc,
    admin,
    socketPath,
    adminSocketPath,
    stateRoot,
    stop(): Promise<void> {
      const closing = Promise.allSettled([rpc.stop(), admin.stop()])
      return closing.then(() => {
        storage.close()
        try {
          rmSync(stateRoot, { recursive: true, force: true })
        } catch {
          /* tmp cleanup best-effort */
        }
      })
    },
  }
}

/** Minimal NDJSON JSON-RPC client over a Unix socket. Each `call`
 *  awaits its matching response by `id`. Designed for test ergonomics
 *  rather than production use. */
export interface TestClient {
  call<R = unknown>(method: string, params?: unknown): Promise<R>
  /** Wait for an unsolicited notification matching the method name
   *  (or any if `method` is omitted). Resolves with the params. */
  nextNotification(method?: string): Promise<unknown>
  close(): Promise<void>
}

type NotificationWaiter = { method?: string | undefined; resolve: (params: unknown) => void }

function dispatchResponse(msg: RpcResponse, pending: Map<number, (r: RpcResponse) => void>): void {
  if (typeof msg.id !== 'number') return
  const handler = pending.get(msg.id)
  if (!handler) return
  pending.delete(msg.id)
  handler(msg)
}

function dispatchNotification(
  msg: { method: string; params: unknown },
  waiters: NotificationWaiter[],
): void {
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i]
    if (w && (w.method === undefined || w.method === msg.method)) {
      waiters.splice(i, 1)
      w.resolve(msg.params)
      return
    }
  }
}

export async function connectTestClient(socketPath: string): Promise<TestClient> {
  let buf = ''
  let idCounter = 0
  const pending = new Map<number, (r: RpcResponse) => void>()
  const notificationWaiters: NotificationWaiter[] = []

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        buf += chunk.toString('utf8')
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          nl = buf.indexOf('\n')
          if (line.length === 0) continue
          try {
            const msg = JSON.parse(line) as RpcResponse | { method: string; params: unknown }
            if ('id' in msg) dispatchResponse(msg, pending)
            else if ('method' in msg) dispatchNotification(msg, notificationWaiters)
          } catch {
            /* malformed frame from daemon — test should fail downstream */
          }
        }
      },
      close() {
        for (const [, resolve] of pending) {
          resolve({
            jsonrpc: '2.0',
            id: 0,
            error: { code: -32000, message: 'connection closed' },
          })
        }
        pending.clear()
      },
    },
  })

  return {
    call<R>(method: string, params?: unknown): Promise<R> {
      const id = ++idCounter
      const req: RpcRequest = { jsonrpc: '2.0', id, method, params }
      return new Promise<R>((resolve, reject) => {
        pending.set(id, response => {
          if ('error' in response) {
            reject(new Error(`rpc ${method}: ${response.error.message}`))
          } else {
            resolve(response.result as R)
          }
        })
        socket.write(`${JSON.stringify(req)}\n`)
      })
    },
    nextNotification(method?: string): Promise<unknown> {
      return new Promise<unknown>(resolve => {
        notificationWaiters.push({ method, resolve })
      })
    },
    close(): Promise<void> {
      socket.end()
      return Promise.resolve()
    },
  }
}
