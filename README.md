# choros

Inter-session messaging and swarm coordination for Claude Code and Codex sessions.

`choros` is a daemon-backed MCP service. One long-lived daemon process
holds the state; each agent session gets a thin adapter that forwards
tool calls and/or push delivery to the daemon over a Unix-socket
JSON-RPC. State lives in a WAL-mode SQLite database at
`$XDG_STATE_HOME/choros/choros.sqlite`.

The user-facing docs live in [`skill/SKILL.md`](skill/SKILL.md).

## Architecture

```
┌──────────────────────────┐    ┌──────────────────────────┐
│ Agent session A          │    │ Agent session B          │
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

The shims contain essentially no business logic. Every MCP tool call
goes through `choros.<tool>` on the daemon, with the session's
`session_id` injected. Claude Code push notifications flow back over
the same connection. Codex uses a split adapter: MCP is tool-only, while
`choros-codex attach` owns app-server delivery for a Codex thread.

For the identity, display-name resolution, and routing model — the parts
of the system most likely to surprise under restart, rename, and
concurrency — see [`docs/identity-and-routing.md`](docs/identity-and-routing.md).

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

Codex support is explicit because Codex does not expose Claude's
`claude/channel` push mechanism. Start the local Codex app-server daemon,
register the tool-only MCP server, and attach delivery to a thread:

```bash
codex app-server daemon start
codex mcp add choros -- bun run /path/to/choros/src/codex/mcp.ts

# In, or for, the target Codex thread:
choros-codex attach "$CODEX_THREAD_ID"
```

`choros-codex attach` resumes the app-server thread, registers as the
session's notification sink, and appends Choros events with
`thread/inject_items`. Pass `--steer-active` to additionally call
`turn/steer` when a turn is already running. Delivery acks for Codex mean
"accepted into the Codex thread's model-visible history"; they are not
Claude-style transcript/UI proof. See
[`docs/codex-support.md`](docs/codex-support.md) for the hard seams and
remaining work. If `codex app-server daemon start` is unavailable in a
non-standalone Codex install, `choros-codex attach --direct-app-server`
can run a local stdio app-server process, but the managed control socket
is the path that can join an already-running thread.

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
| `src/codex/` | Codex app-server attachment and tool-only MCP shim |
| `src/codex/main.ts` | `choros-codex attach` entry; owns Codex push delivery |
| `src/codex/mcp.ts` | Codex MCP entry; tools only, no notification sink |
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
bun run codex-attach  # attach Choros delivery to $CODEX_THREAD_ID
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
