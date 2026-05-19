import type { InboxMessage } from './inbox.ts'

/** Registry of in-flight ask() waiters keyed by the question's msg_id.
 *  When an inbound message arrives with in_reply_to === <key>, resolve the
 *  waiter with that message and unregister.
 *
 *  Used in production from main.ts: the inbox watcher checks this registry
 *  on every inbound; sync-ask tool registers a waiter and awaits the
 *  resolution. */
export class AskRegistry {
  private waiters = new Map<string, (msg: InboxMessage) => void>()

  register(msgId: string, onReply: (msg: InboxMessage) => void): void {
    this.waiters.set(msgId, onReply)
  }

  unregister(msgId: string): void {
    this.waiters.delete(msgId)
  }

  /** If a waiter is registered for msg.in_reply_to, resolve it and return
   *  true. The caller can decide whether to suppress the normal channel
   *  push (we don't — agents may want to see the reply event anyway). */
  notifyIfWaiting(msg: InboxMessage): boolean {
    if (!msg.in_reply_to) return false
    const cb = this.waiters.get(msg.in_reply_to)
    if (!cb) return false
    this.waiters.delete(msg.in_reply_to)
    cb(msg)
    return true
  }

  pendingCount(): number {
    return this.waiters.size
  }
}
