# Changelog

This project follows [semver](https://semver.org/). Breaking changes
in 0.X were unbounded; from v1.0 on they trigger a major bump.

## 1.0.0

**Architectural reset.** Replaces the v0 per-CC-bun model with one
long-lived daemon plus thin per-CC MCP shims, SQLite-backed state,
and JSON-RPC over Unix sockets. The MCP tool surface is unchanged
(`mcp__choros__send` / `broadcast` / `publish` / `subscribe` /
`react` / `set_status` / `set_intent` / `doctor` / `join_thread` /
`leave_thread` / `list_threads` / `send_to_thread`); everything else
is new.

### What's new

- **`src/daemon/`** — long-lived bun process:
  - `main.ts` binds `$XDG_STATE_HOME/choros/daemon.sock` (JSON-RPC) +
    `admin.sock` (HTTP for cockpit + curl).
  - `storage.ts` opens `choros.sqlite` in WAL mode; sequential
    migrations from `src/sql/NNN-*.sql`.
  - `rpc.ts` NDJSON JSON-RPC 2.0 server; per-connection notification
    sink for daemon → shim push.
  - `sessions.ts` in-memory `session_id` → socket routing table.
  - `notify.ts` `deliverOrBuffer` — push to connected shim, else
    enqueue in `pending_notifications` table for drain on reconnect.
  - `handlers/*` — one file per RPC method, SQL-backed.
  - `helpers.ts` — validation primitives + `resolveRecipient` +
    liveness checks.
  - `admin.ts` HTTP endpoints: `/peers`, `/stats`, `/health`.
- **`src/shim/`** — per-CC MCP server:
  - `main.ts` — registers with daemon at boot, forwards every MCP
    tool call as JSON-RPC, re-emits daemon notifications as
    `mcp.notification`, heartbeats every 30s, deregisters on
    shutdown.
  - `rpc-client.ts` — reconnecting JSON-RPC client; on disconnect
    waits 1s and re-bootstraps; pending requests reject cleanly.
- **`src/protocol/`** — shared shim ↔ daemon contract:
  - `methods.ts` — JSON-RPC envelopes, `PROTOCOL_VERSION`, every
    method's arg/result types.
  - `notifications.ts` — push event names.
- **`src/sql/000-init.sql`** — schema v1: `sessions`, `messages`,
  `subscriptions`, `threads`, `thread_members`, `reactions`,
  `pending_notifications`, `system_meta`.
- **`install/`**:
  - `choros.service` — systemd user unit.
  - `com.choros.daemon.plist` — launchd LaunchAgent.
  - `install.sh` / `uninstall.sh` — per-user install (no sudo).

### What's gone

The per-CC-bun model is replaced wholesale. These files are deleted
because their responsibilities now live in the daemon:

- `src/main.ts` — replaced by `src/shim/main.ts`
- `src/acks.ts`, `src/ask-registry.ts`, `src/delivery.ts`,
  `src/dir-cache.ts`, `src/health.ts`, `src/heartbeat.ts`,
  `src/inbox.ts` (most of it), `src/mutex.ts`, `src/presence.ts`,
  `src/threads.ts`, `src/watcher.ts`, all of `src/tools/`
- Inotify watchers (the daemon is the single writer; no inotify
  needed)
- Per-file mutex serialization (SQLite WAL handles it)
- `.heartbeat` / `.lock` / `.wedged` / `.agent_state` /
  `.subscriptions` files (now table rows)
- Per-session `inbox/` / `sent/` / `sent_acks/` / `presence/`
  directories (now `messages` table + `reactions` table)
- Per-session JSONL probes for delivery confirmation (the daemon
  knows when delivery completes — `confirm_delivery` is an explicit
  RPC the shim calls after CC processes an inbound message)

### Why now

Two motivations:

1. **Develop without rebasing every CC**: pre-v1, every choros change
   required restarting every running Claude Code session to pick up
   the new bun. With a daemon, choros updates restart the daemon
   only; shims keep running and auto-reconnect.
2. **The architectural primitive for further work**: cross-machine
   federation, durable observability, scheduled work that outlives
   any session, background reaper / retention — all are now natural
   extensions of the daemon, not new abstractions in their own right.

### Install

```bash
bun install
./install/install.sh   # Linux systemd --user OR macOS launchd
```

Wire shim into Claude Code MCP config:

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

### Migration from v0.x

State formats are incompatible. The v0 filesystem state under
`$XDG_STATE_HOME/choros/<session-id>/` is ignored by the v1 daemon
— the daemon creates a fresh SQLite database on first boot. To wipe
v0 state:

```bash
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/choros"
```

(Run after `./install/uninstall.sh` if you'd previously installed
v0.)

## 0.29.0

(Previous version. See git log; pre-v1 history is captured in commit
messages.)
