import { proxyToolRequest } from './proxy.ts'
import { UserTtlCache } from './user-cache.ts'

/**
 * `POST /api/prom/batch` — many PromQL queries, one browser request.
 *
 * A page like the Overview asks Prometheus 15–25 questions a minute, one panel
 * at a time; each used to be its own `/api/svc/prometheus/…` request on its
 * own timer, which reads as a constant trickle of calls. The client now
 * coalesces every query issued in the same instant into one POST, and this
 * handler fans them out to Prometheus through the normal tool proxy (same
 * session check, same credentials) with bounded concurrency.
 *
 * Each answer is cached for `CACHE_MS` per user + query, so several tabs, or
 * two panels asking the same thing, cost Prometheus one evaluation.
 */

export interface PromBatchItem {
  kind: 'instant' | 'range'
  query: string
  start?: number
  end?: number
  step?: number
}

export interface PromBatchResult {
  status: number
  body: unknown
}

const MAX_ITEMS = 64
const CONCURRENCY = 8
const CACHE_MS = 20_000

const cache = new UserTtlCache<PromBatchResult>(CACHE_MS, 2000)

function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

/** Validate one item and build its Prometheus API path; null when malformed. */
export function itemPath(it: unknown): string | null {
  const i = it as Partial<PromBatchItem> | null
  if (!i || typeof i.query !== 'string' || !i.query || i.query.length > 4000) return null
  if (i.kind === 'instant') return `api/v1/query?${new URLSearchParams({ query: i.query })}`
  if (i.kind === 'range') {
    const nums = [i.start, i.end, i.step]
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
    if ((i.step as number) <= 0 || (i.end as number) < (i.start as number)) return null
    return `api/v1/query_range?${new URLSearchParams({
      query: i.query,
      start: String(i.start),
      end: String(i.end),
      step: String(i.step),
    })}`
  }
  return null
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function handlePromBatch(req: Request): Promise<Response> {
  if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 })
  let items: unknown[]
  try {
    const body = (await req.json()) as { items?: unknown }
    items = Array.isArray(body.items) ? body.items : []
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!items.length || items.length > MAX_ITEMS) {
    return Response.json({ error: 'bad_request', detail: `1–${MAX_ITEMS} items` }, { status: 400 })
  }
  const origin = new URL(req.url).origin
  const cookie = req.headers.get('cookie') ?? ''
  const user = fnv(cookie)

  const results = await mapLimit(items, CONCURRENCY, async (it): Promise<PromBatchResult> => {
    const path = itemPath(it)
    if (!path) return { status: 400, body: { status: 'error', error: 'malformed query item' } }
    return await cache.get(
      `${user}|${path}`,
      async () => {
        const upstream = new Request(`${origin}/api/svc/prometheus/${path}`, {
          headers: { cookie, accept: 'application/json', origin },
        })
        const res = await proxyToolRequest(upstream, 'prometheus', path.split('?')[0])
        const text = await res.text()
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {
          // non-JSON error page — pass the text through
        }
        return { status: res.status, body }
      },
      (r) => r.status === 200,
    )
  })
  return Response.json({ results })
}
