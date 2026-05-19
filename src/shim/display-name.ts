import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { encodedCwd, UUID_RE } from '#choros/identity.ts'

/** Tail-window size for the JSONL scan. CC writes title events as the
 *  session lives; the most recent ones sit at the file's tail, so a
 *  64 KB read covers the typical case without buffering multi-MB
 *  transcripts. */
const DISPLAY_NAME_TAIL_BYTES = 64 * 1024

/**
 * Resolve this CC session's display name by reading its JSONL.
 *
 * Returns the latest `custom-title.customTitle` (set via /rename) if
 * present, falling back to the latest `ai-title.aiTitle`, falling back
 * to `null` (which the daemon stores; senders fall back to the UUID
 * prefix for display).
 *
 * Bounded: reads only the tail of the JSONL, regardless of file size.
 */
export async function resolveDisplayName(opts: {
  sessionId: string
  projectsRoot: string
  pwd: string
}): Promise<string | null> {
  const jsonl = await findJsonl(opts)
  if (!jsonl) return null
  let chunk: string
  try {
    const fh = await open(jsonl, 'r')
    try {
      const size = (await fh.stat()).size
      const offset = Math.max(0, size - DISPLAY_NAME_TAIL_BYTES)
      const buf = Buffer.alloc(size - offset)
      await fh.read(buf, 0, buf.length, offset)
      chunk = buf.toString('utf8')
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
  const lines = chunk.split('\n')
  if (lines.length > 0 && chunk.length > DISPLAY_NAME_TAIL_BYTES) lines.shift()
  let aiFallback: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (!(line.includes('"custom-title"') || line.includes('"ai-title"'))) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'custom-title' && typeof ev.customTitle === 'string') return ev.customTitle
      if (aiFallback === null && ev?.type === 'ai-title' && typeof ev.aiTitle === 'string') {
        aiFallback = ev.aiTitle
      }
    } catch {
      /* skip unparseable */
    }
  }
  return aiFallback
}

async function findJsonl(opts: {
  sessionId: string
  projectsRoot: string
  pwd: string
}): Promise<string | null> {
  const fast = join(opts.projectsRoot, encodedCwd(opts.pwd), `${opts.sessionId}.jsonl`)
  try {
    await stat(fast)
    return fast
  } catch {
    /* fall through to slow path */
  }
  let projects: string[]
  try {
    projects = await readdir(opts.projectsRoot)
  } catch {
    return null
  }
  let best: { path: string; mtime: number } | null = null
  for (const p of projects) {
    if (!UUID_RE.test(opts.sessionId)) break
    const candidate = join(opts.projectsRoot, p, `${opts.sessionId}.jsonl`)
    try {
      const s = await stat(candidate)
      if (!best || s.mtimeMs > best.mtime) best = { path: candidate, mtime: s.mtimeMs }
    } catch {
      /* skip */
    }
  }
  return best?.path ?? null
}
