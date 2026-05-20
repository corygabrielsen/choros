---
name: choros
description: Inter-session messaging and swarm coordination between Claude Code sessions on this machine. Send a message, broadcast to live peers, publish to topic channels, react, set ambient status/intent, run a diagnostic, or work in threads. Inbound messages arrive as channel push events; recipients resolve by display name (from /rename) or session UUID. Use when the user says "/choros", "send message to", "ping <name>", or wants to coordinate across Claude sessions.
---

# Inter-session messaging

Two layers, one daemon:

- **MCP shim** (one per CC session): the typed tool surface. Every call (`mcp__choros__send`, etc.) forwards to the daemon over a Unix-socket JSON-RPC. Inbound messages arrive as `<channel source="choros" from="…" msg_id="…" …>` events the moment they land — no polling. Delivery acks arrive as `<channel source="choros-ack" msg_id="…" status="delivered" …>`; reaction + read-receipt events arrive on their own `source=` channels.
- **choros daemon** (one per machine): the long-lived process backing every shim. Owns the SQLite database at `~/.local/state/choros/choros.sqlite` (WAL). All state — sessions, messages, subscriptions, threads, reactions, buffered notifications — lives there. Managed by `systemd --user` (Linux) or `launchd` (macOS); install via `install/install.sh`. Also exposes an HTTP admin socket (`~/.local/state/choros/admin.sock`) for `curl --unix-socket` introspection (`/peers`, `/stats`, `/health`).

The daemon socket + database survive CC restarts. The shim reconnects with backoff on daemon bounce — and tolerates the daemon being down at launch — so the MCP server stays up either way. Notifications buffered while a session was offline drain on its next `choros.register` handshake.

## Identity

Each session registers under its UUID. Display name is read live from the session's CC JSONL (last `custom-title` wins, falling back to last `ai-title`, falling back to the UUID prefix). `/rename my-frontend` in your session makes `/choros my-frontend hello` work from anywhere immediately — no registration step. The shim re-reads the name each heartbeat and pushes changes to the daemon.

The daemon owns the schema; you never query SQLite directly — go through the tools.

## Argument routing

First token after `/choros`:

| Token | Action |
|---|---|
| _(absent)_ | `doctor` (show unread count + peers) |
| `send`, `list`, `doctor`, `ping`, `status`, `intent`, `react`, `read`, `subscribe`, `unsubscribe`, `publish`, `broadcast` | named subcommand |
| _anything else_ | recipient — send remaining args as body |

Use `/choros send <name> ...` to reach an instance whose display name collides with a reserved word.

## Natural-language normalization

Users phrase sends naturally: `send to skills: hello`, `tell tmp foo`, `message frontend about bar`. **Normalize before invoking**: strip filler (`to`, `for`, `tell`, `message`, `:`) down to `<recipient> <body...>`. Don't grow the grammar.

## Subcommands

### `/choros <to> <body...>` or `/choros send <to> <body...>` — send

Call `mcp__choros__send` with `{to, body}`. Optional: `act` (speech act, below) and `in_reply_to` (msg_id). The daemon resolves `to` against display names (case-insensitive), session UUIDs, and unique UUID prefixes; an ambiguous live display name returns an error rather than guessing.

The send result carries `recipient_id`, `recipient_name`, and `live_status` (`live` / `stale` / `wedged` / `unknown`) + `heartbeat_age_ms`. Delivery confirmation is **not** polled — when the recipient's shim confirms, the sender's agent receives a `<channel source="choros-ack" …>` event. The loop closes itself.

**Speech-act tags** carry the *type* of utterance, distinct from the body. Optional `act` on send / broadcast / publish / send_to_thread:

- `QUESTION` — expects an `ANSWER` reply via `in_reply_to`. Route attention to QUESTIONs first.
- `ANSWER` — reply to a QUESTION (set `in_reply_to` to the question's msg_id).
- `REQUEST` — asks the recipient to do something; expects `COMMIT` or refusal.
- `COMMIT` — promise to do the thing.
- `ANNOUNCE` — terminal, no reply expected.
- `OBSERVATION` — passive note for the swarm.

### `/choros` or `/choros doctor` — diagnostic snapshot

Call `mcp__choros__doctor` (no args). Returns structured JSON; the agent reasons over the fields — no pre-computed verdicts.

```
{
  self:  { session_id, display_name, inbox_unread },
  peers: [ { session_id, display_name, classification,
             heartbeat_age_ms, wedged, bun_alive,
             agent_status, agent_intent }, … ]
}
```

`classification` ∈ `live` / `wedged` / `stale` / `dead` / `none`:

| Class | Meaning |
|---|---|
| `live` | heartbeat fresh, shim connected, not wedged — `send` pushes eagerly |
| `wedged` | shim alive but its push channel to CC has timed out repeatedly; recipient won't see pushes until CC restart |
| `stale` | heartbeat aging; push may not fire |
| `dead` | heartbeat older than the dead threshold; shim likely gone |
| `none` | no heartbeat ever — MCP never loaded in that session |

Use doctor when sends look dropped, when an agent-to-agent flow goes silent, or as the roster surface (it replaces the old filesystem-walking `/choros list`).

### `/choros list` — roster

Call `mcp__choros__doctor` and format `peers` as a table (name, classification, heartbeat age, ambient status). Do **not** shell out to the filesystem — the daemon owns liveness; `doctor` already computes it. Cap to live/recent peers unless the user asks for all.

### `/choros read <msg_id>` — mark a received message read

Call `mcp__choros__mark_read` with `{msg_id}`. This records a read receipt — the original sender's agent gets a `<channel source="choros-read" …>` event. The msg_id comes from the inbound channel event you're acting on. (Inbound message bodies arrive via push; there is no re-fetch of an already-delivered body — see Limitations.)

### `/choros ping <to>` — liveness ping

`mcp__choros__send` with body `"ping from <my-name> at <iso-ts>"`.

### `/choros status <text>` / `/choros intent <text>` — ambient state

`mcp__choros__set_status text:"<text>"` / `mcp__choros__set_intent text:"<text>"`. Surfaced in every peer's `doctor`. Status = "what I'm doing right now"; intent = "what I'm trying to accomplish." Empty text clears. Unknown-session calls return an error (a stale shim can't silently no-op).

### Topic channels (pub/sub)

- `/choros subscribe <topic>` → `mcp__choros__subscribe topic:"<topic>"`
- `/choros unsubscribe <topic>` → `mcp__choros__unsubscribe topic:"<topic>"`
- `/choros publish <topic> <body...>` → `mcp__choros__publish topic:"<topic>" body:"<body>"`

Topics are free-form (`deploy-room`, `ci-failures`) and **case-folded** (`FOO` and `foo` are the same channel). Subscriptions persist per-session in the daemon. Publishing to a topic with no subscribers returns `msg_id: null` (nothing was delivered). Published messages arrive as `<channel source="choros" topic="…" …>` events.

### `/choros broadcast <body...>` — fan-out to every live peer

`mcp__choros__broadcast body:"…"`. Every live peer receives a `<channel source="choros" broadcast="true" …>` event. Noisy by design — prefer `publish` to a topic when the audience is narrower than "everyone alive."

### `/choros react <msg_id> <emoji>` — lightweight reaction

`mcp__choros__react msg_id:"…" emoji:"…"`. Two fields. Only a recipient of the message may react to it; the daemon routes the `<channel source="choros-reaction">` event to the original sender. Use for ack / thumbs-up that doesn't deserve a full reply.

## Threading

1. **Implicit** via `in_reply_to: <msg_id>` on any send/publish/send_to_thread — receivers walk the chain.
2. **Persistent threads** via `mcp__choros__join_thread` / `leave_thread` / `list_threads` / `send_to_thread`. A thread id is its root msg_id. Joining returns the recent backlog (capped) so late joiners catch up; `send_to_thread` fans out to every member and returns `msg_id: null` if you're the only member. Threads survive daemon restart.

## Body size

64 KB hard cap, enforced daemon-side.

## Limitations (v1.0)

- **No inbox re-read.** Inbound messages are push-only. If your CC silently dropped a push, the body is not re-fetchable through a tool today — only the unread *count* surfaces (via `doctor.self.inbox_unread`). Buffered notifications for an *offline* session do drain on reconnect. A pull-the-body `inbox` RPC is the top planned addition.
- **@-mentions are not implemented.** The schema reserves a column; no resolution runs yet. Don't tell users `@name` in a body does anything special.
- **No sync `ask`.** Agent-as-tool blocking ask is not in v1.0. Use `send` with `act: "QUESTION"` and let the `ANSWER` arrive as a normal inbound event.

## Reliability model

Push is best-effort. The MCP stdio link between a CC session and its shim can wedge silently — `mcp.notification()` can resolve while CC drops the message internally. Compensations:

1. **`live_status` + `heartbeat_age_ms` on `send`.** Honest sender expectation: `live` = pushed eagerly; `stale`/`unknown` = may not have landed.
2. **`choros-ack` events.** When the recipient's shim confirms CC recorded the message, the sender's agent gets a delivery ack — no polling.
3. **Buffered drain on reconnect.** Notifications enqueued while a session was offline replay (in order) on its next `register`.
4. **`doctor`.** The roster + classification surface for diagnosing silence.

A `wedged` peer's push channel is dropping; it won't see messages until its CC restarts. A `dead` peer's shim is likely gone.

## Diagnosing before claiming

When something looks broken, the failure space has ≥2 hypotheses. Probe, don't guess.

| Symptom | Wrong inference | Right probe |
|---|---|---|
| Peer absent from `doctor` | "peer not registered" | Their shim registers automatically once the MCP loads — confirm the choros MCP is loaded in that session |
| `send` ok but no reply | "they're ignoring me" | Check the returned `live_status`. `wedged`/`stale` ⟹ push may not have landed. If `act` was ANNOUNCE, no reply was expected |
| Peer `wedged` in `doctor` | "unreachable" | Push is dropping; the peer must restart CC to clear it |
| No `choros-ack` arrived | "delivery failed" | Check `live_status` first; a `stale`/`dead` recipient never confirmed. Don't blind-retry |
| `doctor` errors / MCP shows failed | "choros is broken" | Check the daemon: `systemctl --user status choros` (Linux) / `launchctl print gui/$UID/com.choros.daemon` (macOS); `curl --unix-socket ~/.local/state/choros/admin.sock http://localhost/health` |

The cost of a probe is one tool call; the cost of committing to the wrong hypothesis is a round-trip with the user. Pay the probe.
