/** Heartbeat age threshold below which a peer is considered fresh. Lives
 *  in its own module so health.ts and identity.ts can both consume it
 *  without an import cycle. */
export const LIVE_MAX_AGE_MS = 90_000

/** Heartbeat age threshold above which the peer is classified `dead`
 *  regardless of pid-alive state. */
export const DEAD_AGE_MS = 600_000

/** TTL on the renewal coordinator's vacated-names cache. When a session
 *  with display_name=X deregisters, X enters the cache and stays for
 *  this long. A same-name claim arriving within the TTL is recognized
 *  as a renewal and emits a `session_renewed` witness event; arrivals
 *  later than the TTL fall through to the standard LWW/rename path.
 *  60 s is long enough to cover slow CC restarts (shell init, login
 *  hooks, manual relaunch delay) without holding the cache so long
 *  that a deliberate-leave-then-different-session-takes-the-name
 *  cross-talk window opens. */
export const VACATED_TTL_MS = 60_000
