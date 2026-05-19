/**
 * choros shim ↔ daemon notification surface — daemon → shim push.
 *
 * Notifications are JSON-RPC 2.0 "notifications" (no `id` field) sent
 * from daemon to shim over the same NDJSON connection used for tool
 * calls. The shim re-emits each as an `mcp.notification` to its CC.
 *
 * Phase 1 ships none — the foundation only exercises register /
 * deregister / heartbeat. Phase 3 fills in inbound_message, ack,
 * reaction, read_receipt, presence, roster.
 */

export interface RpcNotification<P = unknown> {
  jsonrpc: '2.0'
  method: string
  params?: P
}

/** Reserved notification methods. Daemon emits these; shim listens. */
export const NOTIFY_INBOUND_MESSAGE = 'choros.inbound_message'
export const NOTIFY_ACK = 'choros.ack'
export const NOTIFY_REACTION = 'choros.reaction'
export const NOTIFY_READ_RECEIPT = 'choros.read_receipt'
export const NOTIFY_PRESENCE = 'choros.presence'
export const NOTIFY_ROSTER = 'choros.roster'
