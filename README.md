# choros

Inter-session messaging and swarm coordination for Claude Code sessions.

`choros` is a daemon-backed MCP service. One long-lived daemon process
holds the state; each CC session runs a thin MCP shim that forwards
tool calls to the daemon over a Unix-socket JSON-RPC. State lives in a
WAL-mode SQLite database at `$XDG_STATE_HOME/choros/choros.sqlite`.

The user-facing docs live in [`skill/SKILL.md`](skill/SKILL.md).

## Architecture

```
┌──────────────────────────┐    ┌──────────────────────────┐
│ CC session A             │    │ CC session B             │
│  ┌────────────────────┐  │    │  ┌────────────────────┐  │
│  │ shim (bun, ~50ms)  │  │    │  │ shim (bun, ~50ms)  │  │
│  └────────┬───────────┘  │    │  └────────┬───────────┘  │
└───────────┼──────────────┘    └───────────┼──────────────┘
            │ JSON-RPC 2.0 / NDJSON         │
            │   daemon.sock                  │
            └───────────────┬────────────────┘
                            ▼
        ┌────────────────────────────────────┐
        │ choros daemon                      │
        │   bun, long-lived, systemd/launchd │
        │   bun:sqlite (WAL) for state       │
        │   in-memory session router         │
        │   pending notification queue       │
        │   HTTP /peers /stats /health on    │
        │     admin.sock for cockpit + curl  │
        └────────────────────────────────────┘
```

The shim contains essentially no business logic. Every MCP tool call
goes through `choros.<tool>` on the daemon, with the shim's
`session_id` injected. Notifications flow back over the same
connection; the shim re-emits them as `mcp.notification` events to its
CC.

## Quick start

```bash
bun install
bun run check     # lint + typecheck + tests

# Install daemon as a system service (Linux: systemd --user; macOS: launchd LaunchAgent)
./install/install.sh
```

Wire the shim into your Claude Code config:

```json
{
  "mcpServers": {
    "choros": {
      "command": "bun",
      "args": ["run", "/path/to/choros/src/shim/main.ts"]
    }
  }
}
```

The shim auto-discovers the daemon socket at
`$XDG_STATE_HOME/choros/daemon.sock` (override via `CHOROS_DAEMON_SOCK`).

## Layout

| Path | Role |
|---|---|
| `src/daemon/` | Long-lived process; JSON-RPC + admin HTTP server; SQL handlers for every tool |
| `src/daemon/main.ts` | Entry; binds sockets; runs forever |
| `src/daemon/storage.ts` | bun:sqlite wrapper + migrations |
| `src/daemon/sessions.ts` | In-memory `session_id` → socket routing |
| `src/daemon/rpc.ts` | NDJSON JSON-RPC 2.0 server |
| `src/daemon/admin.ts` | HTTP admin endpoint |
| `src/daemon/handlers/*.ts` | One file per RPC method |
| `src/daemon/notify.ts` | `deliverOrBuffer` — push or enqueue |
| `src/daemon/helpers.ts` | Validation + `resolveRecipient` + liveness |
| `src/shim/` | Per-CC MCP server |
| `src/shim/main.ts` | MCP entry; connects to daemon |
| `src/shim/rpc-client.ts` | Reconnecting JSON-RPC client |
| `src/protocol/` | Shared shim ↔ daemon contract |
| `src/protocol/methods.ts` | Request/response shapes; `PROTOCOL_VERSION` |
| `src/protocol/notifications.ts` | Push event names |
| `src/sql/000-init.sql` | Schema v1 |
| `src/identity.ts` | UUID / sanitize / msg_id / session discovery (pure) |
| `src/inbox.ts` | Speech-act + body-cap validators (pure) |
| `src/constants.ts` | Shared thresholds (`LIVE_MAX_AGE_MS`, etc.) |
| `src/effects.ts` | DI interfaces (legacy from v0, used by shim's identity resolution) |
| `install/` | systemd unit, launchd plist, install / uninstall scripts |

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
bun run daemon        # run daemon in foreground for development
```

A `simple-git-hooks` pre-commit hook runs `bun run check`; install it via
`bun run prepare` (executed automatically on `bun install`).

## Operating

```bash
# Linux
systemctl --user status choros
journalctl --user -u choros -f
systemctl --user restart choros

# macOS
launchctl print gui/$UID/com.choros.daemon
tail -f ~/Library/Logs/choros/daemon.{out,err}.log
launchctl kickstart -k gui/$UID/com.choros.daemon

# Admin endpoints (both platforms)
curl --unix-socket "${XDG_STATE_HOME:-$HOME/.local/state}/choros/admin.sock" http://localhost/peers
curl --unix-socket "${XDG_STATE_HOME:-$HOME/.local/state}/choros/admin.sock" http://localhost/stats
```

## License

[MIT](LICENSE)
