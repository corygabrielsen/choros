/** Heartbeat age threshold below which a peer is considered fresh. Lives
 *  in its own module so health.ts and identity.ts can both consume it
 *  without an import cycle. */
export const LIVE_MAX_AGE_MS = 90_000

/** Heartbeat age threshold above which the peer is classified `dead`
 *  regardless of pid-alive state. */
export const DEAD_AGE_MS = 600_000

/** Window during which a deregistered session's leave broadcast is held,
 *  awaiting a same-name claim that would coalesce it into a single
 *  `session_renewed` event. Sized to cover empirical CC `/exit` +
 *  relaunch latency: new shim register at ~3-5 s post-deregister, then
 *  set_display_name backfill at ~6-8 s. 15 s is the smallest window
 *  that holds the leave past the typical claim arrival; below it, the
 *  deferred leave fires first and the renewal path no longer applies. */
export const RENEWAL_WINDOW_MS = 15_000

/** Window during which a freshly-registered session's join broadcast is
 *  held, in case a `set_display_name` call within the window completes a
 *  renewal. Empirically the shim takes ~2-3 s from register to first
 *  set_display_name; 5 s buys headroom on slow hardware without
 *  meaningfully delaying genuinely-anonymous joins. */
export const CLAIM_WINDOW_MS = 5_000
