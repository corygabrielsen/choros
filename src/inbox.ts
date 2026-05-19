/**
 * Pure validators + constants shared by the daemon's tool handlers.
 *
 * Pre-v1 this file housed the per-CC inbox-processing pipeline. The
 * daemon owns delivery now (see `src/daemon/handlers/*`); only the
 * sub-100-line slice of pure validation lives on here, imported from
 * a handful of daemon handlers.
 */

/** Maximum UTF-8 body size for any outbound message. */
export const BODY_CAP_BYTES = 64 * 1024

/** File-size cap on inbound messages the daemon will deserialize. */
export const INBOUND_MESSAGE_CAP_BYTES = 256 * 1024

/** Speech-act taxonomy. Optional `act` field on every outbound
 *  message; carries an utterance type distinct from the body. */
export const SPEECH_ACTS = [
  'REQUEST',
  'COMMIT',
  'ANNOUNCE',
  'QUESTION',
  'ANSWER',
  'OBSERVATION',
] as const
export type SpeechAct = (typeof SPEECH_ACTS)[number]

/** Coerce an arbitrary value to a non-coerced string, rejecting any
 *  non-string input. Used at trust boundaries where attacker-
 *  controllable input flows into SQL or filesystem paths. */
export function asStringField(value: unknown, label: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  throw new Error(`${label}: expected string, got ${typeof value}`)
}

/** Validate an optional speech-act tag. Returns the act when valid,
 *  `undefined` when omitted, throws when malformed. */
export function validateSpeechAct(value: unknown): SpeechAct | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('act must be a string')
  if (!(SPEECH_ACTS as readonly string[]).includes(value)) {
    throw new Error(`act must be one of: ${SPEECH_ACTS.join(', ')}`)
  }
  return value as SpeechAct
}

/** Enforce the body byte-cap on outbound (send / broadcast / publish /
 *  send_to_thread). UTF-8 byte length, not character count. */
export function enforceBodyCap(body: string, label: string): void {
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > BODY_CAP_BYTES) {
    throw new Error(`${label}: body exceeds ${BODY_CAP_BYTES} bytes (${bytes})`)
  }
}
