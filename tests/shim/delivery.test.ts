import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonlSize, verifyJsonlReceipt, withTimeout } from '#choros/shim/delivery.ts'

async function tmpJsonl(initial: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'choros-delivery-'))
  const path = join(dir, 'session.jsonl')
  await writeFile(path, initial)
  return path
}

const FAST_TIMEOUT = 200
const FAST_POLL = 10

describe('verifyJsonlReceipt', () => {
  test('matches a msg_id appended after the start cursor', async () => {
    const jsonl = await tmpJsonl('{"type":"old"}\n')
    const start = await jsonlSize(jsonl)
    await writeFile(jsonl, '{"type":"old"}\n{"channel":"msg-abc-123"}\n')
    expect(await verifyJsonlReceipt(jsonl, 'msg-abc-123', start, FAST_TIMEOUT, FAST_POLL)).toBe(
      true,
    )
  })

  test('returns false when the msg_id never appears', async () => {
    const jsonl = await tmpJsonl('{"type":"old"}\n')
    const start = await jsonlSize(jsonl)
    await writeFile(jsonl, '{"type":"old"}\n{"unrelated":"event"}\n')
    expect(await verifyJsonlReceipt(jsonl, 'msg-missing', start, FAST_TIMEOUT, FAST_POLL)).toBe(
      false,
    )
  })

  test('ignores an occurrence that precedes the start cursor (append-only window)', async () => {
    // msg_id already in the file BEFORE we capture the cursor: a prior
    // delivery, not this one. Must not false-positive.
    const jsonl = await tmpJsonl('{"channel":"msg-old-999"}\n')
    const start = await jsonlSize(jsonl)
    expect(await verifyJsonlReceipt(jsonl, 'msg-old-999', start, FAST_TIMEOUT, FAST_POLL)).toBe(
      false,
    )
  })

  test('takes a null transcript on trust (synthetic session)', async () => {
    expect(await verifyJsonlReceipt(null, 'msg-any', 0, FAST_TIMEOUT, FAST_POLL)).toBe(true)
  })

  test('returns false for an empty msg_id', async () => {
    const jsonl = await tmpJsonl('')
    expect(await verifyJsonlReceipt(jsonl, '', 0, FAST_TIMEOUT, FAST_POLL)).toBe(false)
  })

  test('treats a missing transcript file as no-match within the window', async () => {
    expect(
      await verifyJsonlReceipt('/no/such/path.jsonl', 'msg-x', 0, FAST_TIMEOUT, FAST_POLL),
    ).toBe(false)
  })
})

describe('withTimeout', () => {
  test('resolves ok when the task settles first', async () => {
    let rejected = false
    const r = await withTimeout(Promise.resolve(1), 1000, () => {
      rejected = true
    })
    expect(r).toBe('ok')
    expect(rejected).toBe(false)
  })

  test('counts a rejected task as ok and reports the message', async () => {
    let msg = ''
    const r = await withTimeout(Promise.reject(new Error('EPIPE')), 1000, m => {
      msg = m
    })
    expect(r).toBe('ok')
    expect(msg).toBe('EPIPE')
  })

  test('resolves timeout when the task outlasts the deadline', async () => {
    const never = new Promise(() => {
      // intentionally never settles
    })
    const r = await withTimeout(never, 30, () => {
      /* no rejection expected */
    })
    expect(r).toBe('timeout')
  })
})

describe('jsonlSize', () => {
  let made: string | null = null
  afterEach(() => {
    made = null
  })
  test('returns byte length of an existing file', async () => {
    made = await tmpJsonl('hello')
    expect(await jsonlSize(made)).toBe(5)
  })
  test('returns 0 for null or missing', async () => {
    expect(await jsonlSize(null)).toBe(0)
    expect(await jsonlSize('/no/such/file')).toBe(0)
  })
})
