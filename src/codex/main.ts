#!/usr/bin/env bun
import { connectCodexAppServer } from '#choros/codex/app-server-client.ts'
import { CodexAttachment } from '#choros/codex/attachment.ts'
import { resolveCodexIdentity } from '#choros/codex/session.ts'
import { connectRpcClient } from '#choros/shim/rpc-client.ts'
import { daemonSocketPath } from '#choros/state-root.ts'

interface CliOptions {
  command: 'attach'
  threadId?: string | undefined
  displayName?: string | undefined
  steerActive: boolean
  sock?: string | undefined
  directAppServer: boolean
}

function usage(): string {
  return [
    'Usage: choros-codex attach [thread-id] [--name NAME] [--steer-active] [--sock PATH] [--direct-app-server]',
    '',
    'Attaches Choros push delivery to a Codex app-server thread.',
    'thread-id defaults to CODEX_THREAD_ID.',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv]
  const command = args.shift()
  if (command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  if (command !== 'attach') throw new Error(`expected "attach"\n${usage()}`)
  let threadId: string | undefined
  let displayName: string | undefined
  let sock: string | undefined
  let steerActive = false
  let directAppServer = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--steer-active') {
      steerActive = true
    } else if (arg === '--direct-app-server') {
      directAppServer = true
    } else if (arg === '--name') {
      displayName = args[++i]
      if (!displayName) throw new Error('--name requires a value')
    } else if (arg === '--sock') {
      sock = args[++i]
      if (!sock) throw new Error('--sock requires a value')
    } else if (arg?.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`)
    } else if (threadId) {
      throw new Error(`unexpected argument: ${arg}`)
    } else {
      threadId = arg
    }
  }
  if (directAppServer && sock) throw new Error('--direct-app-server cannot be combined with --sock')
  return { command: 'attach', threadId, displayName, steerActive, sock, directAppServer }
}

const opts = parseArgs(process.argv.slice(2))
const identity = resolveCodexIdentity({
  threadId: opts.threadId,
  displayName: opts.displayName,
})

let attachment: CodexAttachment | null = null

const codex = await connectCodexAppServer({
  args: opts.directAppServer ? ['app-server', '--listen', 'stdio://'] : undefined,
  sock: opts.sock,
  onNotification: (method, params): void => {
    attachment?.handleCodexNotification(method, params)
  },
  onStderr: line => process.stderr.write(`[codex app-server] ${line}\n`),
})

const choros = await connectRpcClient({
  socketPath: daemonSocketPath(),
  onNotification: (method, params): void => {
    void attachment?.handleChorosNotification(method, params)
  },
  onConnect: async (): Promise<void> => {
    if (attachment) await attachment.tryRegisterWithDaemon('daemon reconnect')
  },
})

attachment = new CodexAttachment({
  threadId: identity.threadId,
  sessionId: identity.sessionId,
  displayName: identity.displayName,
  steerActive: opts.steerActive,
  codex,
  choros,
  logger: { log: message => process.stderr.write(`${message}\n`) },
})

await attachment.start()
process.stderr.write(
  `[choros-codex] attached ${identity.displayName} to Codex thread ${identity.threadId}\n`,
)

async function shutdown(reason: string): Promise<void> {
  process.stderr.write(`[choros-codex] ${reason}; detaching\n`)
  await attachment?.stop()
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    void shutdown(sig).finally(() => process.exit(0))
  })
}

process.on('unhandledRejection', reason => {
  const m = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  process.stderr.write(`[choros-codex] unhandledRejection: ${m}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`[choros-codex] uncaughtException: ${err.stack ?? err.message}\n`)
})

await new Promise<never>(() => {
  /* run until a signal arrives */
})
