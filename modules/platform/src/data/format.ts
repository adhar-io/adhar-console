/**
 * Small formatters + label helpers for Kubernetes data — shared across
 * every view so column rendering stays consistent.
 */

/** Convert a K8s resource quantity (`100m`, `1Gi`, `500`, `1.5`) to a number. */
export function parseQuantity(q: string | undefined): number {
  if (!q) return 0
  const s = q.toString().trim()
  const units: Record<string, number> = {
    // Power-of-two binary suffixes.
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    // Power-of-ten decimal suffixes.
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
  }
  const match = s.match(/^(-?[\d.]+)\s*([A-Za-z]*)$/)
  if (!match) return NaN
  const n = parseFloat(match[1])
  const u = match[2]
  if (!u) return n
  return n * (units[u] ?? NaN)
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = Math.abs(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${(bytes < 0 ? -v : v).toFixed(digits)} ${units[i]}`
}

export function formatCpu(cores: number): string {
  if (!Number.isFinite(cores)) return '—'
  if (cores === 0) return '0'
  if (cores < 1) return `${Math.round(cores * 1000)}m`
  return `${cores.toFixed(cores < 10 ? 2 : 1)}`
}

/** Age of a resource in short human form: "5s", "3m", "2h", "6d". */
export function age(iso?: string): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

/** Extract the condition matching `type`; returns undefined if not found. */
export function findCondition<T extends { type: string; status: string; reason?: string; message?: string }>(
  conditions: T[] | undefined,
  type: string,
): T | undefined {
  return conditions?.find((c) => c.type === type)
}

/** Derive a role label from node labels (`node-role.kubernetes.io/<role>=""`). */
export function nodeRoles(labels: Record<string, string> | undefined): string[] {
  if (!labels) return []
  const prefix = 'node-role.kubernetes.io/'
  return Object.keys(labels)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .filter(Boolean)
}

/** Compact metadata location (`namespace/name` when ns is present). */
export function resourceLocation(
  meta: { namespace?: string; name: string } | undefined,
): string {
  if (!meta) return '—'
  return meta.namespace ? `${meta.namespace}/${meta.name}` : meta.name
}

/** Short container image display — strip registry for same-registry names. */
export function shortImage(image: string | undefined): string {
  if (!image) return '—'
  // Trim docker.io/library/ prefix common in local dev.
  return image.replace(/^docker\.io\/(library\/)?/, '').replace(/^registry-1\.docker\.io\//, '')
}
