/** Per-key serialization for read-modify-write operations against the
 *  same logical resource (a file path, a thread id, a session id). Each
 *  key gets its own Promise chain; ops on the same key run strictly in
 *  submission order, ops on different keys run in parallel.
 *
 *  The chain self-prunes — once a key's last op settles, the queue
 *  entry is dropped so the Map doesn't grow without bound.
 *
 *  Every op runs with a hard timeout. A hung op would otherwise wedge
 *  every subsequent op for the same key forever; the timeout converts
 *  that into a per-op rejection so the queue keeps moving. */
export interface KeyedMutex {
  run<T>(key: string, op: () => Promise<T>): Promise<T>
}

/** Build a fresh keyed mutex. `defaultTimeoutMs` is the per-op deadline
 *  used when `run()` is called without an explicit override. */
export function createKeyedMutex(defaultTimeoutMs = 30_000): KeyedMutex {
  const queue = new Map<string, Promise<unknown>>()
  return {
    async run<T>(key: string, op: () => Promise<T>): Promise<T> {
      const prev = queue.get(key) ?? Promise.resolve()
      const guardedOp = (): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`mutex op timed out for key=${key}`)),
            defaultTimeoutMs,
          )
        })
        return Promise.race([op(), timeout]).finally(() => {
          if (timer) clearTimeout(timer)
        })
      }
      const next = prev.then(guardedOp, guardedOp)
      queue.set(key, next)
      try {
        return await next
      } finally {
        if (queue.get(key) === next) {
          queue.delete(key)
        }
      }
    },
  }
}
