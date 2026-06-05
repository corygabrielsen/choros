# Codex support

Local baseline checked while implementing this adapter:

- `codex-cli 0.133.0`
- `thread/inject_items` appends raw Responses API items to a thread's
  model-visible history.
- `turn/steer` can steer an active turn with an `expectedTurnId`
  precondition.
- `thread/start` has experimental dynamic tools, but `thread/resume`
  does not. Choros therefore uses normal Codex MCP config for tools and
  app-server only for push delivery.

## Shape

Codex support is intentionally split into two processes:

1. `choros-codex attach <thread-id>` connects to the managed Codex
   app-server control socket, resumes the thread, registers with the
   Choros daemon as the notification sink, and injects daemon events
   with `thread/inject_items`.
2. `choros-codex-mcp` is a normal MCP server for Codex. It registers
   with `receive_notifications:false`, so it can authorize tool calls
   without draining pending notifications or stealing the app-server
   attachment's delivery binding.

The shared daemon contract stays provider-neutral: tools are still
`choros.<tool>` RPC calls with an injected `session_id`, messages are
still stored in SQLite, and offline delivery still uses
`pending_notifications`.

## Running

```bash
codex app-server daemon start
codex mcp add choros -- bun run /path/to/choros/src/codex/mcp.ts

# In, or for, the Codex thread that should receive pushes:
choros-codex attach "$CODEX_THREAD_ID"
```

Use `--name NAME` to override the default `codex-<thread-prefix>`
display name. Use `--steer-active` if external events should interrupt
an already-running turn via `turn/steer`; without it, events are still
available to the next turn through injected history.

`choros-codex attach` defaults to the managed control socket at
`~/.codex/app-server-control/app-server-control.sock`, speaking
WebSocket over the Unix-domain socket. Use `--sock PATH` for a different
managed control socket. `--direct-app-server` instead spawns
`codex app-server --listen stdio://` as a child process. Direct mode is
useful for local smoke tests and history injection, but the managed
control socket is the path for joining an already-running Codex thread
and steering an active turn.

`choros-codex-mcp` needs the same identity as the attachment. By
default both derive it from `CODEX_THREAD_ID`. If a Codex build does not
pass that environment variable to MCP servers, set
`CHOROS_CODEX_THREAD_ID` or `CHOROS_IDENTITY` explicitly when registering
the MCP server.

## Hard seams

- **No Claude channel equivalent.** Claude Code can receive custom
  `mcp.notification` channel events. Codex cannot use that path, so
  delivery goes through app-server history injection instead.
- **Managed transport is WebSocket-over-UDS.** The app-server control
  socket rejects raw newline JSON-RPC. `codex app-server proxy` forwards
  bytes to that socket but does not adapt framing, so Choros speaks the
  WebSocket transport directly.
- **Two connections for one session.** The daemon originally assumed one
  socket was both the auth binding and notification sink. Codex needs a
  notification-owning app-server attachment plus a tool-only MCP server,
  so `choros.register` now has `receive_notifications?: boolean`.
- **Delivery proof is weaker than Claude.** Claude delivery waits for a
  msg_id to appear in the recipient transcript. Codex delivery currently
  means app-server accepted the item into model-visible thread history.
  It does not prove the TUI rendered it or that an in-flight model turn
  consumed it.
- **Active turns need steering.** `thread/inject_items` is enough for
  future context. If the model is already running, `--steer-active` asks
  Codex to ingest the event now with `turn/steer`, guarded by
  `expectedTurnId` so stale steering fails closed.
- **Dynamic app-server tools are not a resume-time solution.** The local
  schema exposes dynamic tools on `thread/start`, not `thread/resume`.
  Existing threads therefore cannot reliably acquire Choros tools via
  app-server attachment alone.

## Remaining work

- End-to-end injected-delivery smoke against a live Codex TUI session.
- Installer support that can add the Codex MCP server and print the
  attach command for the active thread.
- Better lifecycle integration if Codex exposes a durable per-thread
  sidecar hook, so users do not have to run `choros-codex attach`
  manually.
