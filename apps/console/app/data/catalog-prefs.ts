import { useSyncExternalStore } from 'react'

/**
 * User preferences for the Service Catalog: starred entities and a recently
 * viewed history. Backed by localStorage so they survive reloads, exposed
 * through `useSyncExternalStore` so React renders stay in sync — including
 * across tabs via the `storage` event.
 *
 * The snapshot is cached against the raw localStorage string so React doesn't
 * see a fresh array on every render (which would trip the
 * "getSnapshot should be cached" infinite-loop guard).
 */

const EMPTY: readonly string[] = Object.freeze([])

/**
 * In a production build, catalog prefs are mirrored to the DB-backed API
 * `/api/prefs/<scope>` (per-user) — localStorage stays as the instant,
 * sync-friendly cache that `useSyncExternalStore` reads, and we hydrate it from
 * the server once on first use. In dev (no server) localStorage is the store.
 */
function isProdBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    return false
  }
}

interface RefStore {
  useValue(): readonly string[]
  read(): string[]
  write(next: string[]): void
}

function makeRefStore(key: string, max?: number, scope?: string): RefStore {
  const listeners = new Set<() => void>()
  let cachedRaw: string | null = '__init__'
  let cachedSnapshot: readonly string[] = EMPTY
  let hydrated = false

  const notify = () => {
    cachedRaw = '__init__'
    for (const l of Array.from(listeners)) l()
  }

  // One-time pull of the durable per-user list from the server (prod only).
  const hydrate = () => {
    if (!isProdBuild() || !scope || hydrated || typeof localStorage === 'undefined') return
    hydrated = true
    void fetch(`/api/prefs/${scope}`, { credentials: 'include', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { data?: { items?: unknown } } | null) => {
        const items = j?.data?.items
        if (Array.isArray(items)) {
          localStorage.setItem(key, JSON.stringify(items.filter((x): x is string => typeof x === 'string')))
          notify()
        }
      })
      .catch(() => {})
  }

  const pushRemote = (items: string[]) => {
    if (!isProdBuild() || !scope) return
    try {
      void fetch(`/api/prefs/${scope}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { items } }),
        keepalive: true,
      })
    } catch {
      /* best-effort */
    }
  }

  const subscribe = (cb: () => void) => {
    listeners.add(cb)
    hydrate()
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) {
        cachedRaw = '__init__'
        cb()
      }
    }
    if (typeof globalThis !== 'undefined' && 'addEventListener' in globalThis) {
      globalThis.addEventListener('storage', onStorage)
    }
    return () => {
      listeners.delete(cb)
      if (typeof globalThis !== 'undefined' && 'removeEventListener' in globalThis) {
        globalThis.removeEventListener('storage', onStorage)
      }
    }
  }

  const getSnapshot = (): readonly string[] => {
    if (typeof localStorage === 'undefined') return EMPTY
    const raw = localStorage.getItem(key)
    if (raw === cachedRaw) return cachedSnapshot
    cachedRaw = raw
    if (!raw) {
      cachedSnapshot = EMPTY
      return cachedSnapshot
    }
    try {
      const parsed = JSON.parse(raw)
      cachedSnapshot = Array.isArray(parsed)
        ? Object.freeze(parsed.filter((x): x is string => typeof x === 'string'))
        : EMPTY
    } catch {
      cachedSnapshot = EMPTY
    }
    return cachedSnapshot
  }

  const getServerSnapshot = (): readonly string[] => EMPTY

  return {
    useValue: () =>
      useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot),
    read: () => {
      if (typeof localStorage === 'undefined') return []
      try {
        const raw = localStorage.getItem(key)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed)
          ? parsed.filter((x): x is string => typeof x === 'string')
          : []
      } catch {
        return []
      }
    },
    write: (next: string[]) => {
      const limited = max !== undefined ? next.slice(0, max) : next
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(limited))
        notify()
      }
      pushRemote(limited)
    },
  }
}

const starsStore = makeRefStore('adhar.catalog.stars', undefined, 'catalog-stars')
const recentsStore = makeRefStore('adhar.catalog.recently-viewed', 8, 'catalog-recents')

/* ─────────── stars ─────────── */

export function useStars(): readonly string[] {
  return starsStore.useValue()
}

export function isStarred(stars: readonly string[], ref: string): boolean {
  return stars.includes(ref)
}

export function toggleStar(ref: string): void {
  const cur = starsStore.read()
  if (cur.includes(ref)) {
    starsStore.write(cur.filter((x) => x !== ref))
  } else {
    starsStore.write([ref, ...cur])
  }
}

/* ─────────── recently viewed ─────────── */

export function useRecentlyViewed(): readonly string[] {
  return recentsStore.useValue()
}

export function pushRecentlyViewed(ref: string): void {
  const cur = recentsStore.read()
  recentsStore.write([ref, ...cur.filter((x) => x !== ref)])
}
