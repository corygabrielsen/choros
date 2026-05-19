import { describe, expect, test } from 'bun:test'
import {
  UUID_RE,
  createNameCache,
  isSelf,
  listKnownInstances,
  parseMentions,
  resolveIdentity,
  resolveMyName,
  resolveMyNameCached,
  resolveRecipient,
  sanitizeId,
} from '../src/identity.ts'
import { fakeContext } from './fakes/index.ts'

const STATE = '/state/choros'
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

  test('rejects path separators (defense vs traversal)', () => {
    expect(() => sanitizeId('a/b', 'test')).toThrow(/path separator/)
    expect(() => sanitizeId('a\\b', 'test')).toThrow(/path separator/)
    expect(() => sanitizeId('../etc/passwd', 'test')).toThrow()
  })

  test('rejects NUL and control chars', () => {
    expect(() => sanitizeId('a\x00b', 'test')).toThrow()
    expect(() => sanitizeId('a\nb', 'test')).toThrow()
    expect(() => sanitizeId('a\x7fb', 'test')).toThrow()
  })

  test('rejects dot-prefix (would collide with hidden state files)', () => {
    expect(() => sanitizeId('.', 'test')).toThrow(/start with/)
    expect(() => sanitizeId('..', 'test')).toThrow(/start with/)
    expect(() => sanitizeId('.heartbeat', 'test')).toThrow(/start with/)
  })

  test('rejects over-length (257 chars)', () => {
    expect(() => sanitizeId('a'.repeat(257), 'test')).toThrow(/256/)
  })
})

describe('resolveIdentity', () => {
  test('CHOROS_IDENTITY override wins', () => {
    const ctx = fakeContext()
    ctx.env.vars.CHOROS_IDENTITY = 'override-name'
    const id = resolveIdentity(ctx)
    expect(id).toMatchObject({ me: 'override-name', meIsUuid: false, source: 'CHOROS_IDENTITY' })
  })

  test('CLAUDE_CODE_SESSION_ID with UUID shape wins next', () => {
    const ctx = fakeContext()
    const uuid = '12345678-1234-1234-1234-1234567890ab'
    ctx.env.vars.CLAUDE_CODE_SESSION_ID = uuid
    const id = resolveIdentity(ctx)
    expect(id).toMatchObject({ me: uuid, meIsUuid: true, source: 'CLAUDE_CODE_SESSION_ID' })
  })

  test('falls back to cwd-derived id', () => {
    const ctx = fakeContext()
    const id = resolveIdentity(ctx)
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

describe('isSelf (three-layer self-exclusion)', () => {
  test('layer 1: same UUID', async () => {
    const ctx = fakeContext()
    expect(await isSelf(ctx, STATE, 'me-id', null, 'me-id', null)).toBe(true)
  })

  test('layer 2: same display name', async () => {
    const ctx = fakeContext()
    expect(await isSelf(ctx, STATE, 'me-id', 'tint', 'other-id', 'tint')).toBe(true)
  })

  test('layer 3: same heartbeat pid', async () => {
    const ctx = fakeContext()
    await ctx.fs.writeFile(`${STATE}/peer-id/.heartbeat`, JSON.stringify({ pid: ctx.proc.pid() }))
    expect(await isSelf(ctx, STATE, 'me-id', 'me-name', 'peer-id', 'other-name')).toBe(true)
  })

  test('returns false for genuinely different peer', async () => {
    const ctx = fakeContext()
    await ctx.fs.writeFile(`${STATE}/peer-id/.heartbeat`, JSON.stringify({ pid: 9999 }))
    expect(await isSelf(ctx, STATE, 'me-id', 'me-name', 'peer-id', 'other-name')).toBe(false)
  })

  test('returns false when peer has no heartbeat (no layer-3 evidence)', async () => {
    const ctx = fakeContext()
    expect(await isSelf(ctx, STATE, 'me-id', 'me-name', 'peer-id', 'other-name')).toBe(false)
  })
})

describe('listKnownInstances', () => {
  test('returns empty when state root is missing', async () => {
    const ctx = fakeContext()
    expect(await listKnownInstances(ctx, STATE, PROJECTS)).toEqual([])
  })

  test('includes UUID-shaped and non-UUID dirs', async () => {
    const ctx = fakeContext()
    const uuid = '12345678-1234-1234-1234-1234567890ab'
    await ctx.fs.mkdir(`${STATE}/${uuid}`, { recursive: true })
    await ctx.fs.mkdir(`${STATE}/legacy-name`, { recursive: true })
    const out = await listKnownInstances(ctx, STATE, PROJECTS)
    expect(out.map(k => k.id).sort()).toEqual([uuid, 'legacy-name'].sort())
    const u = out.find(k => k.id === uuid)
    expect(u?.isUuid).toBe(true)
    const l = out.find(k => k.id === 'legacy-name')
    expect(l?.isUuid).toBe(false)
  })

  test('skips dot-prefixed entries', async () => {
    const ctx = fakeContext()
    await ctx.fs.mkdir(`${STATE}/.hidden`, { recursive: true })
    await ctx.fs.mkdir(`${STATE}/visible`, { recursive: true })
    const out = await listKnownInstances(ctx, STATE, PROJECTS)
    expect(out.map(k => k.id)).toEqual(['visible'])
  })
})

describe('resolveRecipient (precedence order)', () => {
  const uuidA = '11111111-1111-1111-1111-111111111111'
  const uuidB = '22222222-2222-2222-2222-222222222222'

  test('1) exact UUID match wins', async () => {
    const ctx = fakeContext()
    await ctx.fs.mkdir(`${STATE}/${uuidA}`, { recursive: true })
    await ctx.fs.mkdir(`${STATE}/${uuidB}`, { recursive: true })
    const r = await resolveRecipient(ctx, STATE, PROJECTS, uuidA)
    expect(r.id).toBe(uuidA)
  })

  test('5) fall-through creates a new id (sanitized)', async () => {
    const ctx = fakeContext()
    const r = await resolveRecipient(ctx, STATE, PROJECTS, 'new-peer')
    expect(r).toEqual({ id: 'new-peer', name: null })
  })

  test('4) unique UUID prefix resolves', async () => {
    const ctx = fakeContext()
    await ctx.fs.mkdir(`${STATE}/${uuidA}`, { recursive: true })
    const r = await resolveRecipient(ctx, STATE, PROJECTS, uuidA.slice(0, 8))
    expect(r.id).toBe(uuidA)
  })

  test('4) ambiguous UUID prefix throws', async () => {
    const ctx = fakeContext()
    const u1 = 'abcdef01-0000-0000-0000-000000000000'
    const u2 = 'abcdef02-0000-0000-0000-000000000000'
    await ctx.fs.mkdir(`${STATE}/${u1}`, { recursive: true })
    await ctx.fs.mkdir(`${STATE}/${u2}`, { recursive: true })
    await expect(resolveRecipient(ctx, STATE, PROJECTS, 'abcdef')).rejects.toThrow(/ambiguous/)
  })

  test('fall-through rejects path traversal', async () => {
    const ctx = fakeContext()
    await expect(resolveRecipient(ctx, STATE, PROJECTS, '../etc/passwd')).rejects.toThrow()
  })
})

describe('parseMentions', () => {
  test('self-mentions are filtered', async () => {
    const ctx = fakeContext()
    const out = await parseMentions(
      ctx,
      STATE,
      PROJECTS,
      'me-id',
      'agent-tools',
      'hello @me and @agent-tools',
    )
    expect(out).toEqual([])
  })

  test('self UUID prefix (≥8 chars) is filtered', async () => {
    const ctx = fakeContext()
    const me = 'abcdef12-3456-7890-1234-567890abcdef'
    const out = await parseMentions(ctx, STATE, PROJECTS, me, 'me', `hi @${me.slice(0, 8)}`)
    expect(out).toEqual([])
  })

  test('known peer by display name resolves', async () => {
    const ctx = fakeContext()
    const uuid = '12345678-1234-1234-1234-1234567890ab'
    await ctx.fs.mkdir(`${STATE}/${uuid}`, { recursive: true })
    // Seed a JSONL so the peer's display name resolves to "bob"
    await ctx.fs.writeFile(
      `${PROJECTS}/-x/${uuid}.jsonl`,
      JSON.stringify({ type: 'custom-title', customTitle: 'bob' }),
    )
    ctx.env.vars.PWD = '/x'
    const out = await parseMentions(ctx, STATE, PROJECTS, 'me-id', 'me', 'hey @bob')
    expect(out).toEqual([uuid])
  })

  test('unresolved handles are silently ignored', async () => {
    const ctx = fakeContext()
    const out = await parseMentions(ctx, STATE, PROJECTS, 'me-id', 'me', 'hi @nobody')
    expect(out).toEqual([])
  })
})

describe('resolveMyName', () => {
  test('returns the override id for non-UUID identity', async () => {
    const ctx = fakeContext()
    const name = await resolveMyName(
      ctx,
      { me: 'override', meIsUuid: false, source: 'CHOROS_IDENTITY' },
      PROJECTS,
    )
    expect(name).toBe('override')
  })

  test('falls back to UUID prefix when JSONL has no title', async () => {
    const ctx = fakeContext()
    const me = '12345678-1111-2222-3333-444444444444'
    const name = await resolveMyName(
      ctx,
      { me, meIsUuid: true, source: 'CLAUDE_CODE_SESSION_ID' },
      PROJECTS,
    )
    expect(name).toBe('12345678…')
  })

  test('reads custom-title from JSONL if present', async () => {
    const ctx = fakeContext()
    const me = '12345678-1111-2222-3333-444444444444'
    await ctx.fs.writeFile(
      `${PROJECTS}/-x/${me}.jsonl`,
      JSON.stringify({ type: 'custom-title', customTitle: 'tint' }),
    )
    ctx.env.vars.PWD = '/x'
    const name = await resolveMyName(
      ctx,
      { me, meIsUuid: true, source: 'CLAUDE_CODE_SESSION_ID' },
      PROJECTS,
    )
    expect(name).toBe('tint')
  })

  test('cached resolveMyName returns the cached value without rescanning if mtime unchanged', async () => {
    const ctx = fakeContext()
    const me = '12345678-1111-2222-3333-444444444444'
    await ctx.fs.writeFile(
      `${PROJECTS}/-x/${me}.jsonl`,
      JSON.stringify({ type: 'custom-title', customTitle: 'cached-name' }),
    )
    ctx.env.vars.PWD = '/x'
    const cache = createNameCache()
    const id = { me, meIsUuid: true as const, source: 'CLAUDE_CODE_SESSION_ID' as const }
    expect(await resolveMyNameCached(ctx, id, PROJECTS, cache)).toBe('cached-name')
    expect(cache.value).toBe('cached-name')
    // Mutate the file's content but keep mtime the same — cache should
    // return the old value because mtime hasn't moved.
    const savedMtime = cache.mtimeMs
    expect(await resolveMyNameCached(ctx, id, PROJECTS, cache)).toBe('cached-name')
    expect(cache.mtimeMs).toBe(savedMtime)
  })

  test('cached resolveMyName invalidates when JSONL mtime advances', async () => {
    const ctx = fakeContext()
    const me = '12345678-1111-2222-3333-444444444444'
    await ctx.fs.writeFile(
      `${PROJECTS}/-x/${me}.jsonl`,
      JSON.stringify({ type: 'custom-title', customTitle: 'old' }),
    )
    ctx.env.vars.PWD = '/x'
    const cache = createNameCache()
    const id = { me, meIsUuid: true as const, source: 'CLAUDE_CODE_SESSION_ID' as const }
    expect(await resolveMyNameCached(ctx, id, PROJECTS, cache)).toBe('old')
    // Advance clock then rewrite — mtime moves; cache should refresh.
    ctx.clock.advance(1000)
    await ctx.fs.writeFile(
      `${PROJECTS}/-x/${me}.jsonl`,
      JSON.stringify({ type: 'custom-title', customTitle: 'new' }),
    )
    expect(await resolveMyNameCached(ctx, id, PROJECTS, cache)).toBe('new')
  })

  test('returns the LATEST custom-title when JSONL has multiple rename events', async () => {
    const ctx = fakeContext()
    const me = '12345678-1111-2222-3333-444444444444'
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'old-name' }),
      JSON.stringify({ type: 'something-else' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'middle-name' }),
      JSON.stringify({ type: 'plain-msg' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'newest-name' }),
    ].join('\n')
    await ctx.fs.writeFile(`${PROJECTS}/-x/${me}.jsonl`, `${lines}\n`)
    ctx.env.vars.PWD = '/x'
    const name = await resolveMyName(
      ctx,
      { me, meIsUuid: true, source: 'CLAUDE_CODE_SESSION_ID' },
      PROJECTS,
    )
    expect(name).toBe('newest-name')
  })
})
