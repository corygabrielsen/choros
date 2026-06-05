#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolveCodexIdentity } from '#choros/codex/session.ts'
import {
  ERR_PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  type RegisterResult,
} from '#choros/protocol/methods.ts'
import { connectRpcClient, type RpcClient } from '#choros/shim/rpc-client.ts'
import { daemonSocketPath } from '#choros/state-root.ts'
import { CHOROS_TOOLS } from '#choros/tools.ts'

const SHIM_VERSION = '1.0.0'

let identity: ReturnType<typeof resolveCodexIdentity>
try {
  identity = resolveCodexIdentity()
} catch (e: unknown) {
  const m = e instanceof Error ? e.message : String(e)
  process.stderr.write(`[choros-codex-mcp] ${m}\n`)
  process.exit(1)
}

function injectSession(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...(args ?? {}), session_id: identity.sessionId }
}

async function registerToolOnly(client: RpcClient): Promise<void> {
  const result = await client.call<RegisterResult>('choros.register', {
    protocol_version: PROTOCOL_VERSION,
    session_id: identity.sessionId,
    display_name: identity.displayName,
    host: 'local',
    cwd: process.cwd(),
    pid: process.pid,
    receive_notifications: false,
  })
  process.stderr.write(
    `[choros-codex-mcp] v${SHIM_VERSION} registered tools for ${identity.displayName}; daemon=${result.daemon_version}\n`,
  )
}

const rpc = await connectRpcClient({
  socketPath: daemonSocketPath(),
  onNotification: (): void => {
    /* Codex push delivery is owned by choros-codex attach. */
  },
  onConnect: async client => {
    try {
      await registerToolOnly(client)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      const code = (e as { code?: number })?.code
      if (code === ERR_PROTOCOL_MISMATCH || m.includes('protocol mismatch')) {
        process.stderr.write(`[choros-codex-mcp] ${m}; reinstall matching choros binaries\n`)
        process.exit(2)
      }
      process.stderr.write(`[choros-codex-mcp] register failed: ${m}\n`)
    }
  },
})

const server = new Server(
  { name: 'choros', version: SHIM_VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'Use choros tools to send messages, publish topics, inspect doctor, and pull inbox. ' +
      'Push delivery for Codex is handled by the separate choros-codex attach process.',
  },
)

server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: CHOROS_TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const args = injectSession(req.params.arguments as Record<string, unknown> | undefined)
  const result = await rpc.call(`choros.${req.params.name}`, args)
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})

await server.connect(new StdioServerTransport())

async function shutdown(reason: string): Promise<void> {
  process.stderr.write(`[choros-codex-mcp] ${reason}; closing\n`)
  await rpc.close()
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    void shutdown(sig).finally(() => process.exit(0))
  })
}
