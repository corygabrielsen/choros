import { createHmac, timingSafeEqual } from 'node:crypto'

/** Speech act for the published merge notice. MUST be a member of the
 *  daemon's taxonomy (validateSpeechAct) or handlePublish rejects the
 *  publish with ERR_INVALID_PARAMS and the bridge can never deliver.
 *  Lives here (side-effect-free module) so a test can assert it's
 *  valid without importing main.ts's top-level connect/serve. */
export const MERGE_ACT = 'ANNOUNCE'

/** Verify a GitHub-style HMAC signature header against the raw body.
 *  The header looks like `sha256=<hex>`. Uses constant-time compare
 *  so the verifier can't be timing-probed. */
export function verifyHmac(secret: string, body: string, signatureHeader: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  let got: Buffer
  try {
    got = Buffer.from(signatureHeader.slice('sha256='.length), 'hex')
  } catch {
    return false
  }
  if (expected.length !== got.length) return false
  return timingSafeEqual(expected, got)
}

/** Just enough of a GitHub `pull_request` payload to surface the merge. */
export interface MergedPullRequest {
  repo: string
  number: number
  title: string
  branch: string
  base: string
  merge_commit_sha: string
  merged_by: string
  url: string
}

/** Extract a merged-PR record from a GitHub webhook payload, or null
 *  if the event is something else (closed without merge, opened, etc).
 *  Defensive against partially-populated payloads — GitHub has shipped
 *  schema changes that drop fields the docs say are present. */
export function extractMergedPullRequest(payload: unknown): MergedPullRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (p.action !== 'closed') return null
  const pr = p.pull_request as Record<string, unknown> | undefined
  if (!pr || pr.merged !== true) return null
  const repo = p.repository as Record<string, unknown> | undefined
  const head = pr.head as Record<string, unknown> | undefined
  const base = pr.base as Record<string, unknown> | undefined
  const mergedBy = pr.merged_by as Record<string, unknown> | undefined
  return {
    repo: typeof repo?.full_name === 'string' ? repo.full_name : '',
    number: typeof pr.number === 'number' ? pr.number : 0,
    title: typeof pr.title === 'string' ? pr.title : '',
    branch: typeof head?.ref === 'string' ? head.ref : '',
    base: typeof base?.ref === 'string' ? base.ref : '',
    merge_commit_sha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : '',
    merged_by: typeof mergedBy?.login === 'string' ? mergedBy.login : '',
    url: typeof pr.html_url === 'string' ? pr.html_url : '',
  }
}
