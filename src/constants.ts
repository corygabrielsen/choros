/** Heartbeat age threshold below which a peer is considered fresh. Lives
 *  in its own module so health.ts and identity.ts can both consume it
 *  without an import cycle. */
export const LIVE_MAX_AGE_MS = 90_000

/** Heartbeat age threshold above which the peer is classified `dead`
 *  regardless of pid-alive state. */
export const DEAD_AGE_MS = 600_000
