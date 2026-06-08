/** Heartbeat age threshold below which a peer is considered fresh. Lives
 *  in its own module so health.ts and identity.ts can both consume it
 *  without an import cycle. */
export const LIVE_MAX_AGE_MS = 90_000

/** Heartbeat age threshold above which the peer is classified `dead`
 *  regardless of pid-alive state. */
export const DEAD_AGE_MS = 600_000

/** Window during which a deregistered session's leave broadcast is held,
 *  awaiting a same-name claim that would coalesce it into a single
 *  `session_renewed` event. 5 s is long enough to cover a CC `/exit`
 *  + relaunch on a slow shell, short enough that a genuinely departed
 *  agent's leave still surfaces promptly. */
export const RENEWAL_WINDOW_MS = 5_000

/** Window during which a freshly-registered session's join broadcast is
 *  held, in case a `set_display_name` call within the window completes a
 *  renewal. 1 s is enough for the shim's startup backfill loop to claim
 *  the name on a healthy path; otherwise the join flushes normally. */
export const CLAIM_WINDOW_MS = 1_000
