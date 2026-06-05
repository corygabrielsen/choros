export type ResponsesMessageItem = {
  type: 'message'
  role: 'user'
  content: { type: 'input_text'; text: string }[]
}

export type CodexUserInput = {
  type: 'text'
  text: string
  text_elements: unknown[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

function metaString(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of [
    'from_name',
    'from_session',
    'msg_id',
    'status',
    'event',
    'topic',
    'thread_id',
    'act',
    'in_reply_to',
  ]) {
    const value = scalar(params[key])
    if (value !== null && value.length > 0) parts.push(`${key}=${value}`)
  }
  return parts.join(' ')
}

export function formatChorosEvent(method: string, params: unknown): string {
  const event = method.replace(/^choros\./, '')
  const p = asRecord(params)
  const meta = metaString(p)
  const header = meta ? `[choros:${event} ${meta}]` : `[choros:${event}]`
  const body = typeof p.body === 'string' && p.body.length > 0 ? p.body : ''
  return body ? `${header}\n${body}` : header
}

export function chorosEventToResponsesItem(method: string, params: unknown): ResponsesMessageItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: formatChorosEvent(method, params) }],
  }
}

export function chorosEventToSteerInput(method: string, params: unknown): CodexUserInput {
  return { type: 'text', text: formatChorosEvent(method, params), text_elements: [] }
}
