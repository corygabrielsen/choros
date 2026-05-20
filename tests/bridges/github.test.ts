import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { extractMergedPullRequest, MERGE_ACT, verifyHmac } from '#choros/bridges/github/verify.ts'
import { validateSpeechAct } from '#choros/inbox.ts'

const SECRET = 'test-secret'
function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
}

describe('verifyHmac', () => {
  test('accepts a correctly signed body', () => {
    const body = '{"hello":"world"}'
    expect(verifyHmac(SECRET, body, sign(body))).toBe(true)
  })

  test('rejects a tampered body', () => {
    const original = '{"hello":"world"}'
    const tampered = '{"hello":"WORLD"}'
    expect(verifyHmac(SECRET, tampered, sign(original))).toBe(false)
  })

  test('rejects a missing prefix', () => {
    const body = 'hello'
    const hex = createHmac('sha256', SECRET).update(body).digest('hex')
    expect(verifyHmac(SECRET, body, hex)).toBe(false)
  })

  test('rejects a malformed hex digest', () => {
    expect(verifyHmac(SECRET, 'x', 'sha256=not-hex-data-zzz')).toBe(false)
  })

  test('rejects a length-mismatched digest', () => {
    expect(verifyHmac(SECRET, 'x', 'sha256=00')).toBe(false)
  })
})

describe('extractMergedPullRequest', () => {
  const mergedPayload = {
    action: 'closed',
    pull_request: {
      number: 42,
      title: 'Add the thing',
      merged: true,
      merge_commit_sha: 'deadbeef',
      html_url: 'https://github.com/cory/choros/pull/42',
      head: { ref: 'feat/the-thing' },
      base: { ref: 'master' },
      merged_by: { login: 'cory' },
    },
    repository: { full_name: 'cory/choros' },
  }

  test('extracts the merge details for a merged PR', () => {
    const result = extractMergedPullRequest(mergedPayload)
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('cory/choros')
    expect(result?.number).toBe(42)
    expect(result?.title).toBe('Add the thing')
    expect(result?.branch).toBe('feat/the-thing')
    expect(result?.base).toBe('master')
    expect(result?.merge_commit_sha).toBe('deadbeef')
    expect(result?.merged_by).toBe('cory')
    expect(result?.url).toBe('https://github.com/cory/choros/pull/42')
  })

  test('returns null for a closed-without-merge PR', () => {
    const payload = {
      ...mergedPayload,
      pull_request: { ...mergedPayload.pull_request, merged: false },
    }
    expect(extractMergedPullRequest(payload)).toBeNull()
  })

  test('returns null for non-closed actions', () => {
    const payload = { ...mergedPayload, action: 'opened' }
    expect(extractMergedPullRequest(payload)).toBeNull()
  })

  test('returns null for a non-object payload', () => {
    expect(extractMergedPullRequest(null)).toBeNull()
    expect(extractMergedPullRequest('hi')).toBeNull()
    expect(extractMergedPullRequest(42)).toBeNull()
  })

  test('fills missing optional fields with empty strings', () => {
    const minimal = {
      action: 'closed',
      pull_request: { merged: true },
      repository: {},
    }
    const result = extractMergedPullRequest(minimal)
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('')
    expect(result?.title).toBe('')
    expect(result?.merged_by).toBe('')
  })
})

describe('MERGE_ACT', () => {
  test('is a valid speech act the daemon accepts', () => {
    // Regression guard: the bridge published `act: 'fyi'`, which
    // validateSpeechAct rejects → handlePublish ERR_INVALID_PARAMS →
    // the bridge could never deliver a single merge. Pin the act the
    // bridge actually sends to the daemon's taxonomy.
    expect(() => validateSpeechAct(MERGE_ACT)).not.toThrow()
    expect(validateSpeechAct(MERGE_ACT)).toBe(MERGE_ACT)
  })
})
