# choros

Inter-session messaging and swarm coordination for Claude Code sessions.

`choros` is a bun-based MCP server that lets multiple Claude Code sessions
running on the same machine send messages, broadcast presence, publish to
topic channels, react, and coordinate via persistent threads. Two surfaces:
an MCP channel for low-latency push notifications, and a filesystem store at
`$XDG_STATE_HOME/choros/<session-id>/` as ground truth for delivery,
read-receipts, and acks.

The full user-facing docs live in [`skill/SKILL.md`](skill/SKILL.md) — it's
the skill body that ships alongside the runtime.

## Quick start

```bash
bun install
bun run check     # lint + typecheck + tests
```

Production entry is `src/main.ts`; install as an MCP server via your
Claude Code config:

```json
{
  "mcpServers": {
    "choros": {
      "command": "bun",
      "args": ["run", "/path/to/choros/src/main.ts"]
    }
  }
}
```

## Architecture

- `src/main.ts` — bun entry; wires the MCP server, watchers, heartbeat
- `src/effects.ts` — DI interfaces (`Fs`, `Clock`, `Proc`, `Env`, `Mcp`,
  `Spawner`); production wires to node primitives, tests wire to fakes
- `src/watcher.ts` — uniform inotify + prescan + sweep + respawn lifecycle
  used by inbox, presence, and sent_acks dirs
- `src/mutex.ts` — keyed mutex for read-modify-write serialization on
  shared files (`.agent_state`, `.subscriptions`, thread members)
- `src/delivery.ts` — atomicWrite, JSONL-verified receipt, push wedge
  detection
- `src/identity.ts` — session id resolution, sanitization, msg_id format,
  display-name lookup
- `src/inbox.ts` — inbound message processing
- `src/health.ts` — peer liveness classification
- `src/presence.ts` — hello/goodbye/rename broadcasts
- `src/threads.ts` — persistent threads (members + per-msg files)
- `src/tools/*.ts` — one file per MCP tool (send / broadcast / publish /
  subscribe / react / set_status / set_intent / doctor / ask / threads)

## Development

```bash
bun run lint          # biome check (lint + format gate)
bun run lint:fix      # apply biome auto-fixes
bun run format        # biome format-only
bun run typecheck     # tsc --noEmit
bun test              # bun:test
bun run test:watch    # bun:test --watch
bun run test:cov      # bun:test --coverage
bun run check         # lint + typecheck + tests (pre-commit gate)
```

A `simple-git-hooks` pre-commit hook runs `bun run check`; install it via
`bun run prepare` (executed automatically on `bun install`).

## License

[MIT](LICENSE)
