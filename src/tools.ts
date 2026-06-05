import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const CHOROS_TOOLS: Tool[] = [
  { name: 'send', description: 'Send a message to a peer.', inputSchema: { type: 'object' } },
  {
    name: 'broadcast',
    description: 'Broadcast to every live peer.',
    inputSchema: { type: 'object' },
  },
  { name: 'publish', description: 'Publish to a topic.', inputSchema: { type: 'object' } },
  { name: 'subscribe', description: 'Subscribe to a topic.', inputSchema: { type: 'object' } },
  {
    name: 'unsubscribe',
    description: 'Unsubscribe from a topic.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'react',
    description: 'React to a received message.',
    inputSchema: { type: 'object' },
  },
  { name: 'set_status', description: 'Set ambient status.', inputSchema: { type: 'object' } },
  { name: 'set_intent', description: 'Set ambient intent.', inputSchema: { type: 'object' } },
  { name: 'doctor', description: 'Diagnostic snapshot.', inputSchema: { type: 'object' } },
  {
    name: 'join_thread',
    description: 'Join a persistent thread.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'leave_thread',
    description: 'Leave a thread.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'list_threads',
    description: 'List threads this session belongs to.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'send_to_thread',
    description: 'Append a message to a thread.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'mark_read',
    description: 'Mark a received message as read.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'inbox',
    description: 'Pull unread messages addressed to this session.',
    inputSchema: { type: 'object' },
  },
]
