/**
 * A short-lived, single-flight cache for BFF answers computed with ONE
 * viewer's identity (their RBAC), so they are keyed per user and never served
 * to anyone else.
 *
 * Why: panels on several pages (and every open tab) ask the same BFF endpoint;
 * each answer is a handful of apiserver reads. Within `ttlMs` a repeat is
 * served from memory, and concurrent misses for one key share one computation.
 * Failures are not cached — the next caller tries again.
 */
export class UserTtlCache<T> {
  private entries = new Map<string, { at: number; value: T }>()
  private inflight = new Map<string, Promise<T>>()

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
    private now: () => number = Date.now,
  ) {}

  /**
   * The cached value for `key`, or `compute()`'s. `keep(value)` decides
   * whether a computed value may be cached (e.g. only successful answers).
   */
  async get(key: string, compute: () => Promise<T>, keep: (v: T) => boolean = () => true): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value
    const running = this.inflight.get(key)
    if (running) return running
    const p = compute()
      .then((value) => {
        if (keep(value)) {
          this.entries.delete(key)
          this.entries.set(key, { at: this.now(), value })
          while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value
            if (oldest === undefined) break
            this.entries.delete(oldest)
          }
        }
        return value
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, p)
    return p
  }

  /** Drop one key (after the user's own write), or everything. */
  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear()
    else this.entries.delete(key)
  }
}
