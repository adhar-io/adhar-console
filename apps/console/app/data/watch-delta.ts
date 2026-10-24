/**
 * Pure helpers behind `live-k8s.ts`: folding apiserver watch events into a
 * cached list, and throttling refetches. React-free so tests can load it
 * without the shell-ui / api-client graph.
 */

export interface WatchObject {
  metadata?: { uid?: string; namespace?: string; name?: string }
}

export interface WatchEvent {
  type?: string
  object?: unknown
}

/**
 * Identity of an object across the list response and the watch stream.
 * `namespace/name` rather than `uid`: proxied shapes (Argo CD's API) do not
 * always carry the uid, and names are unique within a namespace anyway.
 */
export function watchKey(o: WatchObject | undefined): string {
  return `${o?.metadata?.namespace ?? ''}/${o?.metadata?.name ?? ''}`
}

export interface ApplyOpts<T> {
  /** Shape a raw watch object into what the query holds. */
  map?(o: unknown): T
  /**
   * Only update or remove objects the list already holds; never add one.
   * For lists read through another API (Argo CD) whose access rules may be
   * narrower than the apiserver watch — an unknown object is reported via
   * `unknown` so the caller refetches through that API instead.
   */
  mergeOnly?: boolean
}

export interface ApplyResult<T> {
  next: T[]
  /** An object the list did not hold arrived and was not added (mergeOnly). */
  unknown: boolean
  changed: boolean
}

/** Fold `events` into `list`, in order. The input is never mutated. */
export function applyWatchEvents<T>(
  list: readonly T[],
  events: readonly WatchEvent[],
  opts: ApplyOpts<T> = {},
): ApplyResult<T> {
  const map = opts.map ?? ((o: unknown) => o as T)
  const index = new Map<string, number>()
  const out = list.slice()
  out.forEach((o, i) => index.set(watchKey(o as WatchObject), i))
  const removed = new Set<number>()
  let unknown = false
  let changed = false
  for (const ev of events) {
    if (!ev.object || ev.type === 'BOOKMARK' || ev.type === 'ERROR') continue
    const k = watchKey(ev.object as WatchObject)
    const at = index.get(k)
    if (ev.type === 'DELETED') {
      if (at !== undefined && !removed.has(at)) {
        removed.add(at)
        index.delete(k)
        changed = true
      }
      continue
    }
    if (at !== undefined && !removed.has(at)) {
      out[at] = map(ev.object)
      changed = true
    } else if (opts.mergeOnly) {
      unknown = true
    } else {
      index.set(k, out.length)
      out.push(map(ev.object))
      changed = true
    }
  }
  const next = removed.size ? out.filter((_, i) => !removed.has(i)) : out
  return { next: changed ? next : (list as T[]), unknown, changed }
}

/**
 * Leading-edge-delayed throttle: the first call runs after `delayMs` (so a
 * burst coalesces), then at most once per `minGapMs`. Calls in between are
 * folded into one trailing run. `now`/timers are injectable for tests.
 */
export function createThrottle(
  fn: () => void,
  minGapMs: number,
  delayMs = 500,
  clock: {
    now(): number
    set(cb: () => void, ms: number): unknown
    clear(h: unknown): void
  } = {
    now: () => Date.now(),
    set: (cb, ms) => setTimeout(cb, ms),
    clear: (h) => clearTimeout(h as number),
  },
): { call(): void; cancel(): void } {
  let last = -Infinity
  let handle: unknown
  const run = () => {
    handle = undefined
    last = clock.now()
    fn()
  }
  return {
    call() {
      if (handle !== undefined) return
      const wait = Math.max(delayMs, last + minGapMs - clock.now())
      handle = clock.set(run, wait)
    },
    cancel() {
      if (handle !== undefined) clock.clear(handle)
      handle = undefined
    },
  }
}
