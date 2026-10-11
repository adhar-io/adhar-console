/**
 * A short-lived, process-wide cache for GETs the BFF proxies with a SERVICE
 * credential.
 *
 * Why it exists: some backing tools are called with one shared token for every
 * console user, and rate-limit that token. Plane allows `API_KEY_RATE_LIMIT`
 * (60/minute by default) per API key, and the Define pages alone fan out to
 * projects, states, labels, members, cycles, modules and issues — then poll
 * every 30s, in every open tab, for every user. Without coalescing, three
 * people on the Define dashboard exhaust the budget and every panel turns into
 * a 429.
 *
 * Only responses that are identical for every caller may live here, which is
 * exactly the service-credential case: the upstream sees the same token and
 * the same URL, so it returns the same bytes whoever asked.
 *
 * Behaviour:
 *   • a fresh entry (younger than `ttlMs`) is served without an upstream call;
 *   • concurrent misses for one key share a single upstream request;
 *   • a stale entry (younger than `staleMs`) is served when the upstream
 *     answers 429, so a burst degrades to slightly old data instead of errors;
 *   • any write through the proxy to the same tool drops that tool's entries,
 *     so a change is visible on the very next read.
 */

export interface CachedResponse {
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: Uint8Array<ArrayBuffer>
  /** Epoch ms the upstream answered. */
  at: number
}

const MAX_ENTRIES = 500
/** Bodies larger than this are passed through and never cached. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

export class SharedGetCache {
  private entries = new Map<string, CachedResponse>()
  private inflight = new Map<string, Promise<CachedResponse>>()

  constructor(private now: () => number = Date.now) {}

  /** The entry for `key` if it is younger than `maxAgeMs`. */
  get(key: string, maxAgeMs: number): CachedResponse | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    if (this.now() - e.at > maxAgeMs) return undefined
    return e
  }

  set(key: string, entry: CachedResponse): void {
    if (entry.body.byteLength > MAX_BODY_BYTES) return
    this.entries.delete(key)
    this.entries.set(key, entry)
    // Insertion order is age order, so the first key is the oldest.
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** Run `load` once per key at a time; later callers share the result. */
  coalesce(key: string, load: () => Promise<CachedResponse>): Promise<CachedResponse> {
    const running = this.inflight.get(key)
    if (running) return running
    const p = load().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  /** Forget every entry whose key starts with `prefix`. */
  invalidate(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

/** Buffer a fetch Response into a cacheable record. */
export async function snapshot(res: Response, at = Date.now()): Promise<CachedResponse> {
  const body = new Uint8Array(await res.arrayBuffer())
  return { status: res.status, statusText: res.statusText, headers: [...res.headers], body, at }
}

/**
 * Seconds to wait before retrying a 429, from `Retry-After` (seconds or an
 * HTTP date) or Plane's `X-RateLimit-Reset` (epoch seconds). Undefined when
 * the upstream gave no hint.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ra = headers.get('retry-after')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
    const when = Date.parse(ra)
    if (Number.isFinite(when)) return Math.max(0, when - now)
  }
  const reset = headers.get('x-ratelimit-reset')
  if (reset) {
    const epoch = Number(reset)
    if (Number.isFinite(epoch)) return Math.max(0, epoch * 1000 - now)
  }
  return undefined
}

export const toolGetCache = new SharedGetCache()
