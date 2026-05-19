import { describe, expect, test } from 'bun:test'
import { generateMessageId, resolveIdentity, sanitizeId, UUID_RE } from '#choros/identity.ts'
import { fakeContext } from './fakes/index.ts'

const PROJECTS = '/state/projects'

describe('sanitizeId', () => {
  test('accepts simple alphanumeric handles', () => {
    expect(sanitizeId('alice', 'test')).toBe('alice')
    expect(sanitizeId('a1b2_c-3', 'test')).toBe('a1b2_c-3')
  })

  test('rejects empty / non-string', () => {
    expect(() => sanitizeId('', 'test')).toThrow(/empty/)
    expect(() => sanitizeId(undefined, 'test')).toThrow(/empty/)
    expect(() => sanitizeId(42, 'test')).toThrow(/empty/)
  })

  test('rejects path separators', () => {
    expect(() => sanitizeId('a/b', 'test')).toThrow(/path separator/)
    expect(() => sanitizeId('a\\b', 'test')).toThrow(/path separator/)
    expect(() => sanitizeId('../etc/passwd', 'test')).toThrow()
  })

  test('rejects NUL and control chars', () => {
    expect(() => sanitizeId('a\x00b', 'test')).toThrow()
    expect(() => sanitizeId('a\nb', 'test')).toThrow()
  })

  test('rejects dot-prefix', () => {
    expect(() => sanitizeId('.', 'test')).toThrow(/start with/)
    expect(() => sanitizeId('..', 'test')).toThrow(/start with/)
    expect(() => sanitizeId('.heartbeat', 'test')).toThrow(/start with/)
  })

  test('rejects over-length (257 chars)', () => {
    expect(() => sanitizeId('a'.repeat(257), 'test')).toThrow(/256/)
  })
})

describe('generateMessageId', () => {
  test('format: ts-counter-prefix, ms preserved', () => {
    const id = generateMessageId('11111111-2222-3333-4444-555555555555', '2026-05-19T12:34:56.789Z')
    expect(id).toMatch(/^\d{8}T\d{6}\d{3}Z-[0-9a-z]+-\d{8}$/)
    expect(id.endsWith('-11111111')).toBe(true)
  })

  test('uniqueness across calls (counter increments)', () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => generateMessageId('me', '2026-05-19T00:00:00.000Z')),
    )
    expect(ids.size).toBe(100)
  })
})

describe('resolveIdentity', () => {
  test('CHOROS_IDENTITY override wins', async () => {
    const ctx = fakeContext()
    ctx.env.vars.CHOROS_IDENTITY = 'override-name'
    const id = await resolveIdentity(ctx)
    expect(id).toMatchObject({ me: 'override-name', meIsUuid: false, source: 'CHOROS_IDENTITY' })
  })

  test('CLAUDE_CODE_SESSION_ID with UUID shape wins next', async () => {
    const ctx = fakeContext()
    const uuid = '12345678-1234-1234-1234-1234567890ab'
    ctx.env.vars.CLAUDE_CODE_SESSION_ID = uuid
    const id = await resolveIdentity(ctx)
    expect(id).toMatchObject({ me: uuid, meIsUuid: true, source: 'CLAUDE_CODE_SESSION_ID' })
  })

  test('newest UUID jsonl in project dir wins when no env hints', async () => {
    const ctx = fakeContext()
    ctx.env.vars.PWD = '/x'
    const older = '11111111-1111-1111-1111-111111111111'
    const newer = '22222222-2222-2222-2222-222222222222'
    await ctx.fs.writeFile(`${PROJECTS}/-x/${older}.jsonl`, '')
    ctx.clock.advance(1000)
    await ctx.fs.writeFile(`${PROJECTS}/-x/${newer}.jsonl`, '')
    const id = await resolveIdentity(ctx, PROJECTS)
    expect(id).toMatchObject({ me: newer, meIsUuid: true, source: 'newest-jsonl-in-project-dir' })
  })

  test('falls back to cwd-derived id when no env, no jsonl', async () => {
    const ctx = fakeContext()
    const id = await resolveIdentity(ctx)
    expect(id.meIsUuid).toBe(false)
    expect(id.source).toBe('cwd')
  })
})

describe('UUID_RE', () => {
  test('matches a valid UUID', () => {
    expect(UUID_RE.test('12345678-1234-1234-1234-1234567890ab')).toBe(true)
  })
  test('rejects non-UUID strings', () => {
    expect(UUID_RE.test('not-a-uuid')).toBe(false)
    expect(UUID_RE.test('skills')).toBe(false)
  })
})
