# Identity and routing

How a session learns who it is, how peers learn its name, and how the daemon routes a message to the right shim. This is the part of the system most likely to behave surprisingly under restart, rename, and concurrency — pinning the design here keeps future changes from drifting from the contract.

## The identity facets

Five distinct things wear the word "identity" in this system. Conflating them is the root cause of every routing footgun we've fixed.

| Facet | Type | Source of truth | Lifetime |
|---|---|---|---|
| CC session UUID | UUID | `~/.claude/sessions/<PID>.json` `.sessionId` | One CC session (changes on `--continue` / `--resume`) |
| CC session PID | int | OS-assigned to the `claude` process | One CC process |
| CC session display name | string \| null | `~/.claude/sessions/<PID>.json` `.name`, set by user `/rename` | Per-named-session across resumes |
| Shim PID | int | OS-assigned to the `bun` MCP child | One shim process |
| Daemon `session_id` | UUID | shim-derived; ought to equal the CC session UUID | Per shim register |

The invariant we hold: **the shim's `session_id` IS the CC session UUID**. Every other surface (routing, doctor, message history) keys off it.

## Identity resolution chain in the shim

The shim runs `resolveIdentity` once at boot, in priority order:

1. **`CHOROS_IDENTITY` env** — explicit override; non-UUID synthetic identity, used by tests and debug shells.
2. **`~/.claude/sessions/<ppid>.json`** — CC's canonical per-process metadata file, located via `process.ppid` (always CC when the shim runs as CC's MCP child). Returns the file's `sessionId`. **This is the primary path for production CC.**
3. **`CLAUDE_CODE_SESSION_ID` env** — if CC sets it (it doesn't, today; reserved for forward compatibility).
4. **Newest UUID-shaped `.jsonl` in the project directory by mtime** — heuristic fallback, picks the wrong session in multi-session-per-cwd cases. Retained for older CC versions that don't write per-PID metadata.
5. **Path-encoded fallback** — `CLAUDE_PROJECT_DIR` / `PWD` / `cwd`, encoded as a non-UUID identifier. Used for synthetic and sdk-cli sessions that have no real CC session UUID.

The CC-session-file path resolves both `sessionId` AND `name` from one file, so the next stage (display-name resolution) reuses the same file via a shared mtime cache.

### Startup race window

CC writes `~/.claude/sessions/<pid>.json` shortly after spawning the MCP child, but not synchronously. `readCcSessionFileWithRetry` budgets 4 × 250ms at register time to ride out the typical race. Beyond that, the post-register backfill loop catches the slow tail (see [Display name backfill](#display-name-backfill)).

## Display name resolution

`currentDisplayName()` returns `null` (no display name) or a string (the user's chosen label). Chain:

1. **CC session file** (`~/.claude/sessions/<ppid>.json` `.name`): primary path. mtime+size cached so heartbeat ticks are stat-only when nothing changed.
2. **JSONL tail-scan**: legacy fallback. Reads the last 64KB of `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` hunting for `custom-title` events. Fails on long-running sessions (the rename event sits beyond the tail window) and on `--continue` / `--resume "X"` (new JSONL never received the prior session's `custom-title`).

The chain is a left-biased disjunction (First / Maybe monoid): first non-null wins.

### Display name backfill

Four push paths keep the daemon's view of `display_name` current:

| Path | Cadence | Catches |
|---|---|---|
| Startup retry | 4 × 250ms inline at register | CC writes the file within ~1s of MCP spawn |
| Post-tool-call sync | Every MCP tool invocation | User `/rename`s mid-session |
| Backfill loop | 3s × 20 attempts (~60s) after register, self-clears on first non-null | CC writes the file late, especially on `--continue` |
| Heartbeat | Every 30s for session lifetime | Long-term steady state; rename detection after backfill expires |

The cost is dominated by the first stat() of the cached path. Steady-state — display name unchanged — every path short-circuits on the in-memory `cachedDisplayName` guard before any IO.

## Daemon-side `display_name` storage

`sessions.display_name` is plain text, non-UNIQUE, case-insensitive index. Two sessions can momentarily hold the same name during a rename race; the LWW eviction below resolves the ambiguity at write time.

### Last-writer-wins (`evictDisplayNameHolders`)

When `register` or `set_display_name` writes a non-null `display_name`, the daemon first clears that name on every OTHER session that holds it:

```
UPDATE sessions SET display_name = NULL
  WHERE display_name = ? COLLATE NOCASE AND id != ?
```

For each evicted session, the daemon:

1. Drops the router cache entry (so fan-out doesn't stamp a stale `from_name`).
2. Broadcasts a `name_evicted` presence event to peers — distinct from `rename` so receivers can attribute it correctly. Includes `claimed_by` (the new owner) and `old_name`.
3. Skips both the evictee AND the claimant from the broadcast — the evictee doesn't need to be told (often it's a stale dead row), and the claimant already knows (it just called `set_display_name`).

### Resolver tiers in `resolveRecipient`

Routing by name traverses three tiers, in order:

| Tier | Filter | Returns |
|---|---|---|
| 1 | Target matches `UUID_RE` exactly | Session row by `id` (synthetic row if unknown — allows forward-addressing) |
| 2 | `display_name = ? COLLATE NOCASE AND lock_pid IS NOT NULL AND heartbeat_at > now - LIVE_MAX_AGE_MS (90s)` | Single match; ambiguity error on multiple |
| 3 | `display_name = ? COLLATE NOCASE AND heartbeat_at > now - DEAD_AGE_MS (10min) ORDER BY heartbeat_at DESC` | Most-recent within the freshness window |
| 4 | UUID prefix match via `GLOB` (escape meta-chars) | Single match; ambiguity error on multiple |

Tier 2's heartbeat freshness check is load-bearing: `lock_pid IS NOT NULL` alone is insufficient because a crashed shim leaves `lock_pid` set until explicit deregister.

Tier 3 closes the gap where no currently-live session holds the name but a recently-active one did. The `DEAD_AGE_MS` cutoff prevents weeks-old stale rows from intercepting traffic.

## Lock reconcile janitor

`reconcileSessionLocks` runs at daemon boot and every `DEAD_AGE_MS` thereafter:

1. **Stale-heartbeat sweep** (one SQL UPDATE): clears `lock_pid` on rows whose `heartbeat_at` is null or older than `DEAD_AGE_MS`. Catches shims that died without deregistering.
2. **Dead-PID sweep** (per-row OS probe via `kill(pid, 0)`): clears `lock_pid` on rows pointing at PIDs that no longer exist. Catches recent shim deaths and PID-recycle hazards.

Both passes preserve row history (`display_name`, `agent_status`, message foreign-key targets) — only the lock columns reset. This keeps the doctor + routing's view of "live" aligned with reality without losing message attribution.

## Lifecycle events

Two events frame daemon transitions so peers don't see naked rejoin bursts:

**`shutting_down`** — broadcast by the dying daemon in its SIGTERM handler, before closing sockets. Push-only, best-effort, no buffering. Tells each connected shim "expect disconnect; reconnect when I come back."

**`restarted`** — emitted by the shim on re-register when the new `daemon_started_at` in `RegisterResult` differs from the cached value. Carries `previous_started_at` for correlation. Fires BEFORE draining buffered notifications, so the CC sees the lifecycle frame ahead of the rejoin burst it's contextualising.

Both flow through the `choros.daemon` notification method → `kind="choros-daemon"` channel attribute on the CC side.

## What the design rules out

- **Two sessions silently sharing a display name.** LWW eviction makes the second writer the owner; tier 2 of the resolver rejects ambiguity in any transient window.
- **A stale shim intercepting by-name routing.** Tier 2 freshness gate (90s) + tier 3 freshness gate (10min) + reconcile janitor combine to filter dead sessions from routing within seconds, and from the DB-level lock view within 10 minutes.
- **A peer surfacing as `from_name: null` after `/rename`.** The four-path backfill (startup retry + tool-call sync + 60s backfill loop + 30s heartbeat) caps the null window at ~3s in the worst observed case.
- **A daemon restart looking like four sessions silently churning.** Lifecycle events frame the transition.

## What the design does NOT yet handle

- **`display_name` set via the MCP tool surviving a daemon restart.** The daemon's `upsertSession` on register overwrites `display_name` with whatever the shim passes (sourced from `~/.claude/sessions/<ppid>.json`). If a session used `mcp__choros__set_display_name` directly to set a name that CC doesn't know about, that name is lost on next register. Deferred; latent until someone actually does this.
- **Re-keying the shim's `me` mid-session.** If `~/.claude/sessions/<ppid>.json` is unavailable at startup-retry timeout and the shim falls back to the legacy heuristic chain, `me` is fixed for the session lifetime even if the file appears later. Recoverable via CC session restart. Documented edge case, not bug.
