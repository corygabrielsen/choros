import { open, stat } from 'node:fs/promises'

/** A channel push is given this long to settle before it's treated as a
 *  wedged stdio link. The MCP SDK can hang indefinitely on a broken
 *  pipe; this cap is what lets the shim survive a parent that stopped
 *  reading. */
export const PUSH_TIMEOUT_MS = 5_000

/** Window within which the msg_id is expected to appear in the recipient's
 *  own CC transcript after the push resolves. A miss means CC accepted the
 *  notification bytes but never surfaced the channel event — the silent
 *  drop that an `await mcp.notification()` resolve cannot detect. */
export const JSONL_VERIFY_TIMEOUT_MS = 5_000

/** Poll cadence for the append-only transcript probe. */
export const JSONL_VERIFY_POLL_MS = 250

/** Race `task` against a timeout. Resolves `'ok'` if the task settles
 *  first (rejections are reported via `onReject` and counted as `'ok'` —
 *  a rejected push is a delivered-its-best-effort, distinct from a hang),
 *  `'timeout'` if the deadline wins. The timer is always cleared. */
export async function withTimeout(
  task: Promise<unknown>,
  timeoutMs: number,
  onReject: (message: string) => void,
): Promise<'ok' | 'timeout'> {
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => {
      if (!settled) resolve('timeout')
    }, timeoutMs)
  })
  try {
    return await Promise.race<'ok' | 'timeout'>([
      task.then(
        () => 'ok' as const,
        (err: unknown) => {
          onReject(err instanceof Error ? err.message : String(err))
          return 'ok' as const
        },
      ),
      timeoutP,
    ])
  } finally {
    settled = true
    if (timer) clearTimeout(timer)
  }
}

/** Byte size of `jsonl` (0 when absent). Captured BEFORE the push so the
 *  delta scan starts past any history and cannot false-match an older
 *  record that happens to embed the same msg_id literal. */
export async function jsonlSize(jsonl: string | null): Promise<number> {
  if (!jsonl) return 0
  try {
    return (await stat(jsonl)).size
  } catch {
    return 0 // ENOENT — transcript not created yet
  }
}

/** Poll an own-CC transcript for `msgId` in the bytes appended after
 *  `startSize`. Returns true on the first match within `timeoutMs`.
 *
 *  A null transcript path means the session has no locatable JSONL
 *  (synthetic/non-UUID session); there is nothing to verify against, so
 *  the push is taken on trust rather than falsely reported as dropped. */
export async function verifyJsonlReceipt(
  jsonl: string | null,
  msgId: string,
  startSize: number,
  timeoutMs: number,
  pollMs: number = JSONL_VERIFY_POLL_MS,
): Promise<boolean> {
  if (!msgId) return false
  if (!jsonl) return true
  const deadline = Date.now() + timeoutMs
  let cursor = startSize
  while (Date.now() < deadline) {
    try {
      const s = await stat(jsonl)
      if (s.size > cursor) {
        const delta = await readFrom(jsonl, cursor, s.size - cursor)
        if (delta.includes(msgId)) return true
        cursor = s.size
      }
    } catch {
      // Transcript briefly unreadable (rotated, truncated) — keep polling.
    }
    await sleep(pollMs)
  }
  return false
}

/** Read `length` bytes from `path` starting at `offset`. */
async function readFrom(path: string, offset: number, length: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, offset)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}
