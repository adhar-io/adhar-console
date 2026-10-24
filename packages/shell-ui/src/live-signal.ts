/**
 * Change detection for watch-driven queries — pure, no React.
 *
 * An apiserver watch reports far more than a view shows: Argo CD rewrites
 * every Application's `status.reconciledAt` on each reconcile, Kyverno
 * re-stamps report timestamps, controllers bump `resourceVersion` on
 * no-op writes, and the live hub re-sends a full `resync` whenever the
 * upstream watch times out and relists. Refetching on each of those turns a
 * push architecture back into polling. So a subscriber keeps a fingerprint of
 * every object (bookkeeping fields stripped) and only invalidates when one
 * actually changes, appears or disappears.
 */

/** Fields whose changes say nothing a view renders. */
export const NOISE_KEYS: ReadonlySet<string> = new Set([
  'resourceVersion',
  'managedFields',
  'generation',
  'reconciledAt',
  'observedAt',
  'lastHeartbeatTime',
  'lastProbeTime',
])

interface KubeObj {
  metadata?: { uid?: string; namespace?: string; name?: string }
}

export function objectKey(o: unknown): string {
  const m = (o as KubeObj | null)?.metadata
  return m?.uid ?? `${m?.namespace ?? ''}/${m?.name ?? ''}`
}

/** FNV-1a — the snapshot only needs "did it change", not the content. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + ':' + s.length.toString(36)
}

/** Stable fingerprint of an object with `NOISE_KEYS` (and `extraIgnore`) removed at any depth. */
export function fingerprint(o: unknown, extraIgnore: readonly string[] = []): string {
  const ignore = extraIgnore.length ? new Set([...NOISE_KEYS, ...extraIgnore]) : NOISE_KEYS
  return hash(JSON.stringify(o, (k, v) => (ignore.has(k) ? undefined : v)))
}

export type Snapshot = Map<string, string>

export function snapshotOf(items: readonly unknown[], extraIgnore: readonly string[] = []): Snapshot {
  const m: Snapshot = new Map()
  for (const it of items) m.set(objectKey(it), fingerprint(it, extraIgnore))
  return m
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/**
 * Apply one watch event to the snapshot. Returns true when it changed
 * something a view would show.
 */
export function applyEvent(snap: Snapshot, type: string, obj: unknown, extraIgnore: readonly string[] = []): boolean {
  const k = objectKey(obj)
  if (type === 'DELETED') return snap.delete(k)
  const fp = fingerprint(obj, extraIgnore)
  if (snap.get(k) === fp) return false
  snap.set(k, fp)
  return true
}

/** How long to wait before the next invalidation: ≥ debounce, and ≥ throttle since the last one. */
export function nextDelay(now: number, last: number, throttleMs: number, debounceMs = 250): number {
  return Math.max(debounceMs, last + throttleMs - now)
}
