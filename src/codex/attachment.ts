import os from 'node:os'
import {
  chorosEventToResponsesItem,
  chorosEventToSteerInput,
  formatChorosEvent,
} from '#choros/codex/events.ts'
import {
  type CodexSessionIdentity,
  codexSessionId,
  defaultCodexDisplayName,
} from '#choros/codex/session.ts'
import {
  ERR_PROTOCOL_MISMATCH,
  ERR_UNKNOWN_SESSION,
  PROTOCOL_VERSION,
  type RegisterResult,
} from '#choros/protocol/methods.ts'

export interface JsonRpcLikeClient {
  call<R = unknown>(method: string, params?: unknown): Promise<R>
  close?(): Promise<void>
  isConnected?(): boolean
}

export interface AttachmentLogger {
  log(message: string): void
}

export interface CodexAttachmentOptions {
  threadId: string
  sessionId?: string | undefined
  displayName?: string | undefined
  host?: string | undefined
  cwd?: string | undefined
  pid?: number | undefined
  steerActive?: boolean | undefined
  startHeartbeat?: boolean | undefined
  heartbeatIntervalMs?: number | undefined
  codex: JsonRpcLikeClient
  choros: JsonRpcLikeClient
  logger?: AttachmentLogger | undefined
}

const HEARTBEAT_INTERVAL_MS = 30_000
const DEREGISTER_TIMEOUT_MS = 500

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function msgIdFrom(method: string, params: unknown): string | null {
  if (method !== 'choros.inbound_message') return null
  const msgId = asRecord(params).msg_id
  return typeof msgId === 'string' && msgId.length > 0 ? msgId : null
}

function errorCode(e: unknown): number | undefined {
  return e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'number'
    ? (e as { code: number }).code
    : undefined
}

function turnId(params: unknown): string | null {
  const turn = asRecord(asRecord(params).turn)
  return typeof turn.id === 'string' && turn.id.length > 0 ? turn.id : null
}

function sameThread(params: unknown, threadId: string): boolean {
  return asRecord(params).threadId === threadId
}

export class CodexAttachment {
  readonly identity: CodexSessionIdentity
  private readonly codex: JsonRpcLikeClient
  private readonly choros: JsonRpcLikeClient
  private readonly logger: AttachmentLogger
  private readonly host: string
  private readonly cwd: string
  private readonly pid: number
  private readonly steerActive: boolean
  private readonly autoHeartbeat: boolean
  private readonly heartbeatIntervalMs: number
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private activeTurnId: string | null = null
  private registerInFlight: Promise<void> | null = null
  private shuttingDown = false

  constructor(opts: CodexAttachmentOptions) {
    this.identity = {
      threadId: opts.threadId,
      sessionId: opts.sessionId ?? codexSessionId(opts.threadId),
      displayName: opts.displayName ?? defaultCodexDisplayName(opts.threadId),
    }
    this.codex = opts.codex
    this.choros = opts.choros
    this.logger = opts.logger ?? { log: message => process.stderr.write(`${message}\n`) }
    this.host = opts.host ?? os.hostname()
    this.cwd = opts.cwd ?? process.cwd()
    this.pid = opts.pid ?? process.pid
    this.steerActive = opts.steerActive ?? false
    this.autoHeartbeat = opts.startHeartbeat ?? true
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  }

  async start(): Promise<void> {
    await this.codex.call('thread/resume', { threadId: this.identity.threadId })
    await this.tryRegisterWithDaemon('initial register')
    if (this.autoHeartbeat) this.startHeartbeat()
  }

  registerWithDaemon(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve()
    if (this.registerInFlight) return this.registerInFlight
    this.registerInFlight = this.doRegisterWithDaemon().finally(() => {
      this.registerInFlight = null
    })
    return this.registerInFlight
  }

  async tryRegisterWithDaemon(context: string): Promise<void> {
    try {
      await this.registerWithDaemon()
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      if (errorCode(e) === ERR_PROTOCOL_MISMATCH || m.includes('protocol mismatch')) {
        throw e
      }
      this.logger.log(`[choros-codex] ${context} failed: ${m}`)
    }
  }

  async handleChorosNotification(method: string, params: unknown): Promise<void> {
    const msgId = msgIdFrom(method, params)
    try {
      const item = chorosEventToResponsesItem(method, params)
      await this.codex.call('thread/inject_items', {
        threadId: this.identity.threadId,
        items: [item],
      })
      if (this.steerActive && this.activeTurnId) {
        try {
          await this.codex.call('turn/steer', {
            threadId: this.identity.threadId,
            input: [chorosEventToSteerInput(method, params)],
            expectedTurnId: this.activeTurnId,
          })
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e)
          this.logger.log(`[choros-codex] steer skipped: ${m}`)
        }
      }
      if (msgId) await this.reportDelivery('choros.confirm_delivery', msgId)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      this.logger.log(
        `[choros-codex] inject failed: ${m}; event=${formatChorosEvent(method, params)}`,
      )
      if (msgId) await this.reportDelivery('choros.report_drop', msgId)
    }
  }

  handleCodexNotification(method: string, params: unknown): void {
    if (!sameThread(params, this.identity.threadId)) return
    if (method === 'turn/started') {
      this.activeTurnId = turnId(params)
    } else if (method === 'turn/completed') {
      const completed = turnId(params)
      if (!completed || completed === this.activeTurnId) this.activeTurnId = null
    } else if (method === 'thread/closed') {
      this.activeTurnId = null
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    await Promise.race([
      this.choros.call('choros.deregister', { session_id: this.identity.sessionId }).catch(() => {
        /* best-effort */
      }),
      new Promise<void>(resolve => setTimeout(resolve, DEREGISTER_TIMEOUT_MS)),
    ])
    await this.codex
      .call('thread/unsubscribe', { threadId: this.identity.threadId })
      .catch(() => undefined)
    await Promise.allSettled([this.choros.close?.(), this.codex.close?.()])
  }

  private async doRegisterWithDaemon(): Promise<void> {
    const result = await this.choros.call<RegisterResult>('choros.register', {
      protocol_version: PROTOCOL_VERSION,
      session_id: this.identity.sessionId,
      display_name: this.identity.displayName,
      host: this.host,
      cwd: this.cwd,
      pid: this.pid,
    })
    for (const buffered of result.pending) {
      await this.handleChorosNotification(buffered.method, buffered.params)
    }
    this.logger.log(
      `[choros-codex] registered ${this.identity.displayName} (${this.identity.sessionId}); drained ${result.pending.length} pending`,
    )
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick()
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref?.()
  }

  private async heartbeatTick(): Promise<void> {
    if (this.shuttingDown) return
    try {
      await this.choros.call('choros.heartbeat', {
        session_id: this.identity.sessionId,
        pid: this.pid,
        agent_status: null,
        agent_intent: null,
      })
    } catch (e: unknown) {
      if (errorCode(e) === ERR_UNKNOWN_SESSION) {
        await this.tryRegisterWithDaemon('heartbeat re-register')
        return
      }
      const m = e instanceof Error ? e.message : String(e)
      this.logger.log(`[choros-codex] heartbeat failed: ${m}`)
    }
  }

  private async reportDelivery(
    method: 'choros.confirm_delivery' | 'choros.report_drop',
    msgId: string,
  ): Promise<void> {
    try {
      await this.choros.call(method, { session_id: this.identity.sessionId, msg_id: msgId })
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      this.logger.log(`[choros-codex] ${method} failed: ${m}`)
    }
  }
}
