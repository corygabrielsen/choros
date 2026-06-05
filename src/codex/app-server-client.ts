import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export interface JsonRpcError extends Error {
  code?: number
}

export type CodexNotificationHandler = (method: string, params: unknown) => void
export type CodexServerRequestHandler = (method: string, params: unknown) => Promise<unknown>

export interface CodexAppServerClient {
  call<R = unknown>(method: string, params?: unknown): Promise<R>
  notify(method: string, params?: unknown): void
  close(): Promise<void>
  isOpen(): boolean
}

export interface CodexAppServerClientOptions {
  command?: string | undefined
  args?: string[] | undefined
  sock?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  onNotification?: CodexNotificationHandler | undefined
  onServerRequest?: CodexServerRequestHandler | undefined
  onStderr?: ((line: string) => void) | undefined
  connectTimeoutMs?: number | undefined
  callTimeoutMs?: number | undefined
}

type RequestId = number | string
type AnyBuffer = Buffer<ArrayBufferLike>

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

interface JsonTransport {
  send(text: string): void
  close(): Promise<void>
  isOpen(): boolean
}

interface ParsedWebSocketFrame {
  fin: boolean
  opcode: number
  payload: AnyBuffer
}

function makeRpcError(message: string, code?: number): JsonRpcError {
  const err = new Error(message) as JsonRpcError
  if (code !== undefined) err.code = code
  return err
}

function defaultCodexControlSocket(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir()
  return join(home, '.codex', 'app-server-control', 'app-server-control.sock')
}

function childArgs(opts: CodexAppServerClientOptions): string[] {
  return opts.args ?? ['app-server', '--listen', 'stdio://']
}

function createChildTransport(
  opts: CodexAppServerClientOptions,
  onMessage: (text: string) => void,
  onClose: (message: string) => void,
): JsonTransport {
  const child = spawn(opts.command ?? 'codex', childArgs(opts), {
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let open = true

  createInterface({ input: child.stdout }).on('line', onMessage)
  createInterface({ input: child.stderr }).on('line', line => opts.onStderr?.(line))

  child.on('exit', (code, signal) => {
    open = false
    onClose(`codex app-server child exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  })
  child.on('error', error => {
    open = false
    onClose(`codex app-server child error: ${error.message}`)
  })

  return {
    send(text: string): void {
      if (!open || child.killed) throw new Error('codex app-server child closed')
      child.stdin.write(`${text}\n`)
    },
    close(): Promise<void> {
      open = false
      child.kill('SIGTERM')
      return Promise.resolve()
    },
    isOpen(): boolean {
      return open && !child.killed
    },
  }
}

function expectedWebSocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`, 'binary').digest('base64')
}

function encodeWebSocketFrame(payload: string | AnyBuffer, opcode = 0x1): AnyBuffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const mask = randomBytes(4)
  let header: Buffer

  if (data.length <= 125) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length])
  } else if (data.length <= 65_535) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }

  const masked = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i++) {
    masked[i] = (data[i] ?? 0) ^ (mask[i % mask.length] ?? 0)
  }
  return Buffer.concat([header, mask, masked])
}

function decodeWebSocketFrame(buffer: AnyBuffer): {
  frame: ParsedWebSocketFrame | null
  rest: AnyBuffer
} {
  if (buffer.length < 2) return { frame: null, rest: buffer }
  const first = buffer[0] ?? 0
  const second = buffer[1] ?? 0
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buffer.length < offset + 2) return { frame: null, rest: buffer }
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return { frame: null, rest: buffer }
    const bigLength = buffer.readBigUInt64BE(offset)
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('codex app-server websocket frame is too large')
    }
    length = Number(bigLength)
    offset += 8
  }

  let mask: Buffer | null = null
  if (masked) {
    if (buffer.length < offset + 4) return { frame: null, rest: buffer }
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + length) return { frame: null, rest: buffer }
  let payload = buffer.subarray(offset, offset + length)
  if (mask) {
    const unmasked = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i++) {
      unmasked[i] = (payload[i] ?? 0) ^ (mask[i % mask.length] ?? 0)
    }
    payload = unmasked
  }

  return {
    frame: { fin, opcode, payload },
    rest: buffer.subarray(offset + length),
  }
}

function validateWebSocketUpgrade(headerText: string, expectedAccept: string): void {
  const lines = headerText.split('\r\n')
  const status = lines[0] ?? ''
  if (!/^HTTP\/1\.[01] 101\b/i.test(status)) {
    throw new Error(`codex app-server websocket upgrade failed: ${status}`)
  }
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const sep = line.indexOf(':')
    if (sep === -1) continue
    headers.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim())
  }
  const accept = headers.get('sec-websocket-accept')
  if (accept !== expectedAccept) {
    throw new Error('codex app-server websocket upgrade returned an invalid accept key')
  }
}

async function createUnixWebSocketTransport(
  sock: string,
  connectTimeoutMs: number,
  onMessage: (text: string) => void,
  onClose: (message: string) => void,
): Promise<JsonTransport> {
  // Codex's managed app-server control socket speaks WebSocket over UDS.
  return await new Promise<JsonTransport>((resolve, reject) => {
    const socket = createConnection(sock)
    const key = randomBytes(16).toString('base64')
    const expectedAccept = expectedWebSocketAccept(key)
    let open = true
    let upgraded = false
    let settled = false
    let headerBuffer: AnyBuffer = Buffer.alloc(0)
    let frameBuffer: AnyBuffer = Buffer.alloc(0)
    let fragmentedText: AnyBuffer[] = []

    const timer = setTimeout(() => {
      fail(new Error(`timeout connecting to codex app-server socket ${sock}`))
    }, connectTimeoutMs)
    timer.unref?.()

    function closeWith(message: string): void {
      if (!open) return
      open = false
      clearTimeout(timer)
      onClose(message)
    }

    function fail(error: Error): void {
      open = false
      clearTimeout(timer)
      socket.destroy()
      if (settled) {
        onClose(error.message)
      } else {
        settled = true
        reject(error)
      }
    }

    function handleFrame(frame: ParsedWebSocketFrame): void {
      switch (frame.opcode) {
        case 0x0:
          if (fragmentedText.length === 0) return
          fragmentedText.push(frame.payload)
          if (frame.fin) {
            onMessage(Buffer.concat(fragmentedText).toString('utf8'))
            fragmentedText = []
          }
          return
        case 0x1:
          if (frame.fin) {
            onMessage(frame.payload.toString('utf8'))
          } else {
            fragmentedText = [frame.payload]
          }
          return
        case 0x8:
          socket.end()
          closeWith('codex app-server socket closed')
          return
        case 0x9:
          if (open) socket.write(encodeWebSocketFrame(frame.payload, 0x0a))
          return
        case 0x0a:
          return
        default:
          return
      }
    }

    function feedFrames(chunk: AnyBuffer): void {
      frameBuffer = Buffer.concat([frameBuffer, chunk])
      while (frameBuffer.length > 0) {
        const decoded = decodeWebSocketFrame(frameBuffer)
        if (!decoded.frame) {
          frameBuffer = decoded.rest
          return
        }
        frameBuffer = decoded.rest
        handleFrame(decoded.frame)
      }
    }

    const transport: JsonTransport = {
      send(text: string): void {
        if (!(open && upgraded)) throw new Error('codex app-server socket closed')
        socket.write(encodeWebSocketFrame(text))
      },
      close(): Promise<void> {
        open = false
        clearTimeout(timer)
        if (!socket.destroyed) {
          socket.write(encodeWebSocketFrame(Buffer.alloc(0), 0x8))
          socket.end()
        }
        return Promise.resolve()
      },
      isOpen(): boolean {
        return open && upgraded && !socket.destroyed
      },
    }

    socket.on('connect', () => {
      socket.write(
        [
          'GET / HTTP/1.1',
          'Host: localhost',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })

    socket.on('data', chunk => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      try {
        if (upgraded) {
          feedFrames(data)
          return
        }
        headerBuffer = Buffer.concat([headerBuffer, data])
        const headerEnd = headerBuffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const headerText = headerBuffer.subarray(0, headerEnd).toString('utf8')
        const rest = headerBuffer.subarray(headerEnd + 4)
        validateWebSocketUpgrade(headerText, expectedAccept)
        upgraded = true
        clearTimeout(timer)
        if (!settled) {
          settled = true
          resolve(transport)
        }
        if (rest.length > 0) feedFrames(rest)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })

    socket.on('error', error => {
      fail(new Error(`codex app-server socket error: ${error.message}`))
    })
    socket.on('close', () => {
      open = false
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(new Error('codex app-server socket closed before websocket upgrade completed'))
        return
      }
      onClose('codex app-server socket closed')
    })
  })
}

export async function connectCodexAppServer(
  opts: CodexAppServerClientOptions = {},
): Promise<CodexAppServerClient> {
  const pending = new Map<RequestId, PendingCall>()
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  let nextId = 0
  let closed = false
  let transport: JsonTransport | null = null

  function rejectPending(message: string): void {
    for (const [, call] of pending) {
      clearTimeout(call.timer)
      call.reject(new Error(message))
    }
    pending.clear()
  }

  function closeFromTransport(message: string): void {
    if (closed) return
    closed = true
    rejectPending(message)
  }

  function sendFrame(frame: unknown): void {
    if (closed || !transport?.isOpen()) throw new Error('codex app-server closed')
    transport.send(JSON.stringify(frame))
  }

  function trySendFrame(frame: unknown): boolean {
    try {
      sendFrame(frame)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      closeFromTransport(`codex app-server send failed: ${message}`)
      return false
    }
  }

  function reply(id: RequestId, result: unknown): void {
    trySendFrame({ jsonrpc: '2.0', id, result })
  }

  function replyError(id: RequestId, code: number, message: string): void {
    trySendFrame({ jsonrpc: '2.0', id, error: { code, message } })
  }

  async function handleServerRequest(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as RequestId
    const method = msg.method
    if (typeof method !== 'string') {
      replyError(id, -32600, 'invalid request')
      return
    }
    if (!opts.onServerRequest) {
      replyError(id, -32601, `unsupported server request: ${method}`)
      return
    }
    try {
      reply(id, await opts.onServerRequest(method, msg.params))
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      replyError(id, -32000, m)
    }
  }

  function handleMessage(text: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const obj = msg as Record<string, unknown>
    const id = obj.id as RequestId | undefined
    if (id !== undefined && 'method' in obj) {
      void handleServerRequest(obj)
      return
    }
    if (id !== undefined) {
      const call = pending.get(id)
      if (!call) return
      pending.delete(id)
      clearTimeout(call.timer)
      if ('error' in obj) {
        const err = obj.error as { code?: number; message?: string }
        call.reject(makeRpcError(err.message ?? 'codex app-server error', err.code))
      } else {
        call.resolve(obj.result)
      }
      return
    }
    const method = obj.method
    if (typeof method === 'string') opts.onNotification?.(method, obj.params)
  }

  transport =
    opts.args || opts.command
      ? createChildTransport(opts, handleMessage, closeFromTransport)
      : await createUnixWebSocketTransport(
          opts.sock ?? defaultCodexControlSocket(opts.env),
          connectTimeoutMs,
          handleMessage,
          closeFromTransport,
        )

  const client: CodexAppServerClient = {
    call<R>(method: string, params?: unknown): Promise<R> {
      if (closed || !transport?.isOpen())
        return Promise.reject(new Error('codex app-server closed'))
      const id = ++nextId
      return new Promise<R>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`timeout calling ${method}`))
        }, callTimeoutMs)
        timer.unref?.()
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
        if (!trySendFrame({ jsonrpc: '2.0', id, method, params }) && pending.delete(id)) {
          clearTimeout(timer)
          reject(new Error('codex app-server closed'))
        }
      })
    },
    notify(method: string, params?: unknown): void {
      if (!closed && transport?.isOpen()) trySendFrame({ jsonrpc: '2.0', method, params })
    },
    close(): Promise<void> {
      closed = true
      rejectPending('codex app-server client closed')
      return transport?.close() ?? Promise.resolve()
    },
    isOpen(): boolean {
      return !closed && (transport?.isOpen() ?? false)
    },
  }

  await client.call('initialize', {
    clientInfo: { name: 'choros-codex', version: '1.0.0' },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
    },
  })
  client.notify('initialized')
  return client
}
