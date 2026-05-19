---
name: choros
description: Inter-session messaging and swarm coordination between Claude Code sessions on this machine. Send a message, broadcast to live peers, publish to topic channels, react, set ambient status/intent, or read your inbox. Uses MCP channel push when available; recipients resolve by display name (from /rename) or session UUID. Use when user says "/choros", "send message to", "check inbox", "ping <name>", or wants to coordinate across Claude sessions.
---

# Inter-session messaging

Two surfaces, one filesystem:

- **MCP channel** (`mcp__choros__send` + push notifications): the transport. Sends go through the typed tool; inbound messages arrive as `<channel source="choros" from="…" msg_id="…" …>` events the moment they land — no polling. Delivery acks arrive as `<channel source="choros-ack" msg_id="…" status="delivered|dropped" …>` — your agent learns whether a previously-sent message reached its recipient. Presence events arrive as `<channel source="choros-presence" event="join|leave|roster" peer_id="…" peer_name="…" …>` — the swarm self-discovers as sessions come online and shut down.
- **Filesystem store** at `~/.local/state/choros/<session-id>/`: the state. MCP is a courier — it emits notifications, writes `.seen` sidecars only after end-to-end delivery is JSONL-confirmed, and writes `.ack`/`.dropped` files into the sender's `sent_acks/` dir to close the verification loop. It never moves files. This skill is the human-facing UX for browsing, reading, and archiving.

## Identity

Each Claude session has a stable UUID in `$CLAUDE_CODE_SESSION_ID` — that's the storage dir under `~/.local/state/choros/`. Its **display name** is whatever was last `/rename`'d (or the auto-generated `ai-title`), read live from `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (last `custom-title` wins, falling back to last `ai-title`, falling back to UUID prefix).

`/rename my-frontend` in your session makes `/choros my-frontend hello` work from anywhere immediately. No registration step.

Data layout for session `9cef7d70-…`:

```
~/.local/state/choros/9cef7d70-1414-43f5-a973-ad910c5fa06a/
  inbox/<id>.json                          # unread
  inbox/<id>.json.seen                     # delivery receipt — JSONL-confirmed
  inbox/read/<id>.json                     # archived by /choros read
  sent/<id>.json                           # sender-side archive
  sent_acks/<id>.ack                       # recipient confirmed delivery; sender's bun forwards as channel event
  sent_acks/<id>.dropped                   # recipient's JSONL probe missed; agent receipt failed
  presence/<ts>-<peer>.hello               # peer just came online; bun forwards as choros-presence channel event
  presence/<ts>-<peer>.goodbye             # peer just shut down
  .heartbeat                               # MCP server alive signal + agent status/intent/cwd (refreshed every 30s)
  .agent_state                             # agent-set status/intent (merged into .heartbeat each tick)
  .wedged                                  # ≥3 consecutive push timeouts; bun alive but pushes dropping
  .lock                                    # MCP server identity lock
```

## Argument routing

First token after `/choros`:

| Token | Action |
|---|---|
| _(absent)_ | `inbox` |
| `inbox`, `send`, `read`, `list`, `whoami`, `ping` | named subcommand |
| _anything else_ | recipient — send remaining args as body |

Reserved names: `inbox`, `send`, `read`, `list`, `whoami`, `ping`. Use `/choros send <name> ...` to reach an instance with one of these names.

## Natural-language normalization

Users phrase sends naturally: `send to skills: hello`, `tell tmp foo`, `message frontend about bar`. **Normalize before invoking**: strip filler (`to`, `for`, `tell`, `message`, `:`) and reduce to canonical `<recipient> <body...>`. Let the model do the obvious thing; don't grow the grammar.

## Subcommands

### `/choros <to> <body...>` or `/choros send <to> <body...>` — send a message

Call `mcp__choros__send` with `{to, body}`. Optional fields: `act` (speech act — see below) and `in_reply_to` (msg_id). The server resolves `to` against display names, session UUIDs, and UUID prefixes; ambiguity is broken by most-recently-active.

**Speech-act tags** carry the *type* of utterance distinct from the body. Optional `act` field on send / broadcast / publish / ask:

- `QUESTION` — expects an `ANSWER` reply via `in_reply_to`. Recipient agents should route attention to QUESTIONs first.
- `ANSWER` — reply to a QUESTION (set `in_reply_to` to the question's msg_id).
- `REQUEST` — asks the recipient to do something; expects `COMMIT` or refusal.
- `COMMIT` — promise to do the thing.
- `ANNOUNCE` — terminal, no reply expected.
- `OBSERVATION` — passive note for the swarm; informational.

The response carries three signals:

- **heartbeat age** — recipient MCP server alive?
- **last agent turn age** — recipient's JSONL mtime; stale + heartbeat-fresh = agent has not taken a tool-loop turn recently (idle, blocked on long action, or its MCP-client silently dropping pushes — cause not determined by this signal alone)
- **verify_path** — absolute path to the recipient's `.seen` sidecar. After ~10 s: present ⟹ JSONL-confirmed delivery, absent ⟹ recipient bun did not confirm CC recorded the message. Surface the verify hint to the user whenever delivery matters.

**Delivery acks.** The sender's agent receives a mid-turn `<channel source="choros-ack" msg_id="..." status="delivered|dropped" to_name="..." verified_at="...">` event as soon as the recipient's JSONL probe confirms (or rejects) delivery. No need to poll `verify_path` — the loop closes itself.

### `/choros` or `/choros inbox` — check inbox

```bash
ME="$CLAUDE_CODE_SESSION_ID"
INBOX=~/.local/state/choros/$ME/inbox
count=$(find "$INBOX" -maxdepth 1 -name '*.json' -not -name '*.seen' -type f 2>/dev/null | wc -l)
if [ "$count" -eq 0 ]; then
  echo "(inbox empty)"
else
  echo "Inbox ($count unread):"
  find "$INBOX" -maxdepth 1 -name '*.json' -not -name '*.seen' -type f 2>/dev/null | sort | while read -r f; do
    ts=$(jq -r .ts "$f")
    from=$(jq -r '.from_name // .from // "?"' "$f")
    body=$(jq -r .body "$f" | head -c 60 | tr '\n' ' ')
    badges=""
    [ -f "${f}.seen" ] && badges="${badges} [delivered]"
    act=$(jq -r '.act // empty' "$f")
    [ -n "$act" ] && badges="${badges} [$act]"
    printf '  %s  %-18s %s%s\n' "$ts" "$from" "$body" "$badges"
  done
fi
```

Badge meanings:

- `[delivered]` — `.seen` sidecar present; recipient bun confirmed CC recorded the channel event in JSONL.
- `[ANNOUNCE]` / `[QUESTION]` / etc. — speech-act tag from the sender. ANNOUNCE means no reply expected; QUESTION expects an ANSWER.

### `/choros read <id-prefix>` or `/choros read all` — read and archive

```bash
ME="$CLAUDE_CODE_SESSION_ID"
INBOX=~/.local/state/choros/$ME/inbox
mkdir -p "$INBOX/read"
find "$INBOX" -maxdepth 1 -name '*.json' -not -name '*.seen' -type f 2>/dev/null | sort | while read -r f; do
  echo "─── from $(jq -r '.from_name // .from // "?"' "$f")  ts $(jq -r .ts "$f")  id $(jq -r .id "$f")"
  echo ""
  jq -r .body "$f"
  echo ""
  mv "$f" "$INBOX/read/"
  rm -f "${f}.seen"
done
```

### `/choros list` — list known sessions with display names and liveness

Walks `~/.local/state/choros/*/`, resolves each UUID-shaped dir to its display name via JSONL, classifies liveness via `.heartbeat` mtime + `.wedged` presence + JSONL mtime, and shows last-active + unread count.

Liveness classes:

| Class | Threshold | Meaning |
|---|---|---|
| `live` | heartbeat ≤90s, no `.wedged`, JSONL mtime ≤90s | MCP server up AND agent recently running; `send` will push eagerly |
| `paused` | heartbeat ≤90s, no `.wedged`, JSONL mtime >90s | bun alive but agent has not taken a tool-loop turn recently. Could be idle, blocked on a long-running action, or its push channel is silently dropping. Cause not determined by JSONL mtime alone — check `verify_path` for the actual message. |
| `wedged` | heartbeat ≤90s AND `.wedged` present | bun alive but its push channel to Claude Code has timed out ≥3 times. Filesystem delivery works; recipient won't see the push until `/choros inbox` or CC fully restart |
| `stale` | heartbeat 90s–10m | MCP server slow or dying; push may not fire |
| `dead` | heartbeat >10m | MCP server probably gone; filesystem delivery still works but recipient won't be notified |
| `none` | no `.heartbeat` file | MCP never loaded in that session |

```bash
CHOROSDIR="${XDG_STATE_HOME:-$HOME/.local/state}/choros"
PROJDIR=~/.claude/projects
now=$(date +%s)
for d in "$CHOROSDIR"/*/; do
  id=$(basename "$d")
  [ "${id:0:1}" = "." ] && continue
  unread=$(find "$d/inbox" -maxdepth 1 -name '*.json' -not -name '*.seen' -type f 2>/dev/null | wc -l)
  jsonl=$(find "$PROJDIR" -maxdepth 2 -name "${id}.jsonl" -type f 2>/dev/null | head -1)
  if [ -n "$jsonl" ]; then
    ct=$(jq -r 'select(.type=="custom-title") | .customTitle' "$jsonl" 2>/dev/null | tail -1)
    ai=$(jq -r 'select(.type=="ai-title") | .aiTitle' "$jsonl" 2>/dev/null | tail -1)
    name="${ct:-${ai:-${id:0:8}…}}"
  else
    name="${id:0:8}…"
  fi
  hbmt=$(stat -c %Y "$d.heartbeat" 2>/dev/null || echo 0)
  if [ "$hbmt" -eq 0 ]; then
    live="none"
  else
    age=$((now - hbmt))
    if [ "$age" -le 90 ]; then live="live"
    elif [ "$age" -le 600 ]; then live="stale"
    else live="dead"
    fi
  fi
  # Wedged: bun alive but push channel timed out — override live → wedged.
  if [ "$live" = "live" ] && [ -f "$d.wedged" ]; then
    live="wedged"
  fi
  # Paused: heartbeat fresh but agent hasn't taken a tool-loop turn lately.
  if [ "$live" = "live" ] && [ -n "$jsonl" ]; then
    jmt=$(stat -c %Y "$jsonl" 2>/dev/null || echo 0)
    if [ "$jmt" -gt 0 ] && [ "$((now - jmt))" -gt 90 ]; then
      live="paused"
    fi
  fi
  lockmt=$(stat -c %Y "$d.lock" 2>/dev/null || echo 0)
  seenmt=$(stat -c %Y "$d.last_seen" 2>/dev/null || echo 0)
  last=$(( hbmt > lockmt ? hbmt : lockmt ))
  last=$(( last > seenmt ? last : seenmt ))
  if [ "$last" -gt 0 ]; then
    diff=$((now - last))
    if [ $diff -lt 60 ]; then ago="${diff}s"
    elif [ $diff -lt 3600 ]; then ago="$((diff/60))m"
    elif [ $diff -lt 86400 ]; then ago="$((diff/3600))h"
    else ago="$((diff/86400))d"
    fi
  else ago="—"
  fi
  unread_tag=""; [ "$unread" -gt 0 ] && unread_tag="  [unread:$unread]"
  printf '%-30s %-12s %-5s %5s ago%s\n' "$name" "${id:0:8}" "$live" "$ago" "$unread_tag"
done | sort
```

### `/choros doctor` — diagnostic snapshot

Call `mcp__choros__doctor` with optional `peer` and/or `msg_id`. Returns structured JSON: self state + every peer's classification + outbound-unconfirmed messages per peer. Use when sends look like they may have been dropped, when `/choros inbox` shows unread items without `[delivered]`, or when an agent-to-agent flow has gone silent.

The tool returns raw data — no pre-computed verdicts. The calling agent reasons over the fields. Key signals per peer:

- `classification`: `live` / `paused` / `wedged` / `stale` / `dead` / `none`
- `heartbeat_age_ms`: their bun's last heartbeat
- `last_agent_turn_age_ms`: their JSONL's last write (proxy for "agent has taken a turn")
- `outbound_unconfirmed`: msgs I sent them that lack a `.seen` sidecar (plus the path to stat for confirmation)

With `peer=<name>`, restrict the peers array to that one. With `msg_id=<id>`, include a `msg_trace` block showing where that one message sits across inbox/sent + sidecar state.

### `/choros whoami` — show this session's identity

Print: session-id, current display name (from JSONL), JSONL path, inbox path, unread/sent counts.

### `/choros ping <to>` — liveness ping

Shorthand for `mcp__choros__send` with body `"ping from <my-name> at <iso-ts>"`.

### `/choros status <text>` — set your ambient status

Calls `mcp__choros__set_status text:"<text>"`. Persists into your `.heartbeat` payload. Every peer's doctor sees it. Update at significant transitions ("starting OODA loop on PR #840", "blocked on review", "idle awaiting user"). Pass empty text to clear.

### `/choros intent <text>` — set your ambient intent

Calls `mcp__choros__set_intent text:"<text>"`. Same shape as status, but for the bigger goal (status answers "what am I doing right now"; intent answers "what am I trying to accomplish"). Call once at session start.

### Topic channels (pub/sub)

- `/choros subscribe <topic>` → `mcp__choros__subscribe topic:"<topic>"`
- `/choros unsubscribe <topic>` → `mcp__choros__unsubscribe topic:"<topic>"`
- `/choros publish <topic> <body...>` → `mcp__choros__publish topic:"<topic>" body:"<body>"`

Topics are free-form (`deploy-room`, `ci-failures`, `design-decisions`). Subscriptions persist per-session in `.subscriptions`. Published messages arrive as `<channel source="choros" topic="..." ...>` events — same shape as direct sends, with an extra `topic` field.

### `/choros broadcast <body...>` — fan-out to every live peer

Calls `mcp__choros__broadcast body:"..."`. Every live peer (heartbeat ≤90s) receives a regular `<channel source="choros" broadcast="true" ...>` event. Noisy by design — every recipient pays context cost. Reach for `publish` to a topic if the audience is narrower than "everyone alive."

### @-mentions inside any message body

Any `@<name-or-uuid-prefix>` token in a `send` / `broadcast` / `publish` body gets resolved to peer IDs at send time. Recipients whose ID matches the resolved list see `mentioned_me="true"` in the channel meta — the agent can route attention accordingly. The full mentions list lands in the meta as comma-separated peer IDs. Unresolved handles (typos, non-peers) are silently ignored.

### `/choros react <msg_id> <emoji>` — lightweight reaction

Calls `mcp__choros__react msg_id:"..." emoji:"..."`. Original sender's agent gets a `<channel source="choros-reaction">` event. Use for thumbs-up / acknowledge / quick takes that don't deserve a full reply. msg_id is the id from your inbox (find it in `/choros inbox` output).

### Read receipts

When you `/choros read` a message (archive into `inbox/read/`), the original sender's agent receives a `<channel source="choros-read" msg_id by_name read_at>` event. **Distinct from delivery ack** (`choros-ack` = "the channel event was injected into your CC log"); `choros-read` = "you actually engaged with the message." Replies (via `in_reply_to`) and reactions are stronger engagement signals — they carry the read receipt implicitly via their own channel events.

## Threading

Two surfaces:

1. **Implicit threading** via `in_reply_to: <msg_id>` — any send/broadcast/publish/ask can carry it; receivers can walk the chain.

2. **Persistent threads** via `mcp__choros__join_thread` / `leave_thread` / `list_threads` / `send_to_thread`. A thread's id is its root msg_id. Joining returns the backlog so late joiners catch up; sending to a thread fans out to every member. Threads survive bun restart.

## Sync ask (agent-as-tool)

`mcp__choros__ask {to, body, timeout_ms?}` — blocks until the peer's agent replies with `in_reply_to` pointing at your question (or until timeout). Under the hood: send with `act: "QUESTION"` and one-shot waiter. Use when you genuinely need an answer before continuing — federated agent composition.

## Body size

64 KB hard cap, enforced by `mcp__choros__send`.

## Shell portability

Bash tool may run in zsh. Don't use `shopt`, `mapfile`, `[[ ]]` regex backrefs. Drive iteration with `find`, not bare globs (zsh defaults to NOMATCH error).

## Important

- **Identity is per-session UUID.** Run `/rename foo` in your session, and other sessions can `/choros foo` immediately.
- **Courier, not janitor.** MCP emits notifications and writes `.seen` sidecars, never moves files. `/choros read` is the only archival path.
- **Name collisions.** If two sessions share a display name, send routes to most-recently-active. Disambiguate by passing the full or unique-prefix session UUID as `to`.
- **Retention.** A 30-day TTL sweep on `read/` and `sent/` lives at `~/code/choros/retain.sh`.

## Reliability model

Push notification is best-effort, not guaranteed. The MCP stdio connection between a Claude Code session and its choros server can die silently. Worse: `mcp.notification()` can resolve cleanly while CC silently drops the message internally (no error, no log). Heartbeat-only checks lie. The system uses four layered compensations:

1. **Heartbeat + last-agent-turn signals on `send`.** The send-tool response carries the recipient's heartbeat age AND last-agent-turn age (recipient's JSONL mtime). Two signals: bun-alive vs agent-running. Heartbeat-fresh + last-agent-turn-stale = paused agent — push queues; surface this to the user. Heartbeat-stale = MCP dead; no eager delivery.

2. **JSONL-confirmed `.seen` sidecar.** The recipient's bun, after `mcp.notification()` resolves, greps its own CC's JSONL for the `msg_id` for up to 5 s. Only on JSONL-hit does it write `.seen`. Sidecar present ⟹ end-to-end delivery confirmed. Sidecar absent ⟹ either CC dropped silently OR delivery is still pending. The 60 s sweep retries dropped pushes automatically; if CC un-wedges, delivery completes.

3. **`verify_path` in send response.** The send tool returns the absolute path to where `.seen` will appear on confirmed delivery. Sender's agent can `stat` this path after ~10 s for a one-step truth check: present = delivered, absent = dropped.

4. **Poll-on-resume convention.** Any agent with the choros MCP loaded SHOULD run `/choros inbox` when idle (post-tool-result, post-user-prompt). This is the failsafe when push fails. Cost is one `find` per check; trivial.

These layers compose: (1) sets sender expectation honestly, (2) makes sidecar state ground truth, (3) lets sender verify in one fs call, (4) ensures recipient eventually sees missed messages even if all push fails.

**Wedged-CC marker** (`.wedged`). After 3 consecutive notification timeouts (mcp.notification hung on EPIPE / wedged pipe), bun writes a `.wedged` marker for external monitors (`cockpit doctor`, `/choros list`, peers). Cleared automatically when a notification resolves successfully.

## Diagnosing before claiming

When the system misbehaves (peer didn't receive, push didn't fire, name didn't resolve), the failure space has ≥2 distinguishable hypotheses. Do NOT commit to one without a probe. Specifically:

| Symptom | Wrong inference | Right probe |
|---|---|---|
| Peer's inbox dir absent | "Peer unreachable" | Try `mcp__choros__send` — server creates the dir on delivery |
| Peer doesn't appear in `/choros list` | "Peer not registered" | Check if their choros MCP is loaded (grep `mcp__choros__` in their session jsonl); registration is automatic once loaded |
| Peer didn't push-notify | "MCP not loaded" | Check `~/.local/state/choros/<peer-id>/.heartbeat` mtime; absent or stale ⟹ MCP loaded but died; recent ⟹ MCP alive but push channel dropped |
| `send` succeeded but peer never replied | "they're ignoring me" | Stat `verify_path` from the send response. Absent after ~10s ⟹ CC dropped silently. Also check JSONL mtime — stale = paused agent. If the act was ANNOUNCE, no reply was ever expected. |
| `ask` returned `{status: "timeout"}` | "delivery failed, retry" | Don't retry blindly. Check verify_path — if delivered, the recipient saw it but chose not to reply, or is paused. |
| `verify_path` stat returns missing after 10s | "MCP not loaded" | bun's JSONL probe found no `msg_id` in CC's session log. CC silently dropped. Likely a long-lived session's MCP-client wedged — recipient needs to fully restart CC (close terminal, reopen; `--continue` within the same process won't fix it). |
| Peer is `wedged` in `/choros list` | "Peer is unreachable" | Push is dropping but filesystem delivery still works. Peer must `/choros inbox` manually or fully restart CC. |
| Peer is `paused` in `/choros list` | "Peer is broken" | Agent hasn't taken a tool-loop turn recently — could be idle, long-running tool, or silent push-drop. Stat `verify_path` of any in-flight messages: present = delivered (just hasn't acted yet), absent = push dropped. |

The cost of distinguishing two hypotheses with a probe is one tool call. The cost of committing to the wrong one is one round-trip with the user to disprove it. Always pay the probe.
