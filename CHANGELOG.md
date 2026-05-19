# Changelog

This project follows [semver](https://semver.org/) once it reaches 1.0.
Until then, breaking changes can land in any minor version.

## 0.29.0

### Toolchain

- `@biomejs/biome` 1.9.4 → 2.4.15 (config migrated to v2 schema; ~30
  rules enabled across complexity / correctness / performance / style /
  suspicious).
- `typescript` ^5 → 6.0.3, with `exactOptionalPropertyTypes`,
  `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`.
- `simple-git-hooks` 2.11.1 → 2.13.1.
- `tsc --noEmit` wired into the pre-commit gate. Hook now runs
  `biome check` + `tsc --noEmit` + `bun test`; verified to block lint,
  type, or test regressions.

### Architectural extractions

- **`src/watcher.ts`** — unified inotify + boot-prescan + periodic sweep
  + capped respawn for `inbox/`, `presence/`, `sent_acks/`. Replaces
  ~165 lines of repeated wiring in main.ts. Falls back to sweep-only
  when inotifywait is unavailable.
- **`src/mutex.ts`** — `KeyedMutex` with per-op timeout and self-pruning
  queue. Replaces the bespoke `serializeOnThread` and is now also used
  for `.agent_state` and `.subscriptions` so concurrent
  `set_status` + `set_intent` (or `subscribe` + `unsubscribe`) cannot
  race-clobber each other.
- **`src/dir-cache.ts`** — `ensureDir(ctx, path)` memoizes "already
  created in this bun lifetime" so the fan-out hot path doesn't pay
  a `mkdir -p` syscall per peer per message.
- **`src/constants.ts`** — `LIVE_MAX_AGE_MS` + `DEAD_AGE_MS` moved out
  of `health.ts` so `identity.ts` no longer duplicates the threshold
  to avoid an import cycle.

### Bug-hunt round 3 (43 findings, 39 addressed across 7 categories)

- **Identity & serialization (A)**: msg_id format now preserves
  milliseconds + per-process counter (no more same-second collisions);
  `.agent_state` and `.subscriptions` serialized via `KeyedMutex`;
  `takeLock` post-write-verifies its pid won the race; `.react` files
  keyed on (msg_id, reactor); empty `msg_id` on inbound now skipped
  rather than dedup-bucketed.
- **Input validation (B)**: send tool's `msg_id` arg sanitized;
  inbound message file-size cap (256 KB) + body cap (64 KB) enforced
  before parse; mention list filtered to strings + capped at 64;
  presence meta fields coerced via string-only filter.
- **Shutdown/signal (C)**: stdout EPIPE goes through `shutdownAsync`
  instead of bypassing it; stderr error handler installed; SIGHUP
  handled; `.lock` released on every shutdown path; boot-time
  `cleanupOrphanTmpFiles` sweep for `*.<pid>.<counter>.tmp` files
  whose writer pid is dead.
- **Watcher symmetry (D)**: see "Architectural extractions" above.
- **Delivery correctness (E)**: `verifyJsonlReceipt` now snapshots the
  JSONL size BEFORE the push so msg_ids CC writes during/before push
  resolution land in the verification window; broadcast / publish /
  broadcastPresence / broadcastRename per-peer try/catch (no
  Promise.all-rejects-drops-successes); stale `.wedged` cleared at
  boot.
- **Spec drift (F)**: SKILL.md doctor section aligned to actual
  no-args contract; react section documents `from_session`;
  emitPresence JSDoc corrected; `SendResult.live_status` narrowed
  from `string` to `RecipientHealth['status']` literal union.
- **Resource hygiene (G)**: thread mutation queue uses per-op timeout;
  `lastCorruptParseCount` LRU-capped at 1024; `realSpawner` registers
  a single-fire exit channel that routes both `child.on('error')` and
  `child.on('exit')` through one handler list.

### Perf-hunt round 3 (30 findings, 22 addressed across 4 batches)

- **Batch 1** — JSONL tail read (was buffering multi-MB into a string
  array on every doctor/broadcast/publish call); startup parallelism
  for boot mkdir + cleanup + initial heartbeat; disk JSON pretty-print
  dropped; `ensureDir` memoization.
- **Batch 2** — `listKnownInstances` per-peer probes parallelized via
  `Promise.all`; `readDisplayNameForJsonl` complexity refactor.
- **Batch 3** — heartbeat reads coalesced (`isLivePeer`,
  `recipientLiveness`, doctor each now do `Promise.all([readFile,
  stat])` instead of serial stat-then-read); redundant `existsSync(src)`
  dropped from `emitInboxMessage`; `runWithLimit` uses index cursor
  instead of `Array.shift()` for O(1) dispatch; sweep tick jittered
  across `[0, sweepIntervalMs)` so the three watchers don't fire in
  lock-step; `realSpawner` exit channel unified.
- **Batch 4** — `findJsonlForSession` slow path now probes candidates
  in parallel + drops the `existsSync`-then-`stat` redundancy;
  `InboxTargets.cachedOwnJsonl` accessor threads the identity layer's
  cached JSONL path through to the hot delivery path.

### Repo hygiene

- MIT `LICENSE` added.
- `README.md` rewritten (was still saying `msg-channel` with stale
  `bun run index.ts` install instructions). New README covers
  architecture, scripts, and the pre-commit gate.
- `CHANGELOG.md` introduced (this file).
- `.editorconfig` (utf-8 / lf / 2-space).
- `.gitignore` expanded: `dist/`, `coverage/`, `*.tmp`, `*.bak`,
  `.DS_Store`, `.env`, IDE dirs.
- `package.json` metadata: description, license, author,
  `engines.bun >=1.3.0`, `test:cov` script.
- `retain.sh` references corrected (was pre-rename `msg-channel`
  paths); now honors `XDG_STATE_HOME`. `migrate.sh` deleted —
  one-off helper that completed weeks ago.
- All relative imports purged via `package.json` `imports` field
  (`#choros/*`).

## 0.28 and earlier

See git log; pre-changelog history is captured in commit messages.
