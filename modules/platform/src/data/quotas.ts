import { parseQuantity } from './format.ts'
import type { LimitRange, LimitRangeItem, ResourceQuota } from './namespaces.ts'

/**
 * Quota & Limits — pure helpers for the Platform page that governs
 * ResourceQuotas and LimitRanges. No I/O here, so the maths and the manifests
 * the page writes are unit-tested on their own (`quotas_test.ts`).
 */

/* ─── usage ─────────────────────────────────────────────────────────────── */

export type Pressure = 'ok' | 'warn' | 'high' | 'full' | 'unbounded'

export interface QuotaLine {
  resource: string
  used?: string
  hard?: string
  /** used ÷ hard as a percentage; null when either side can't be compared. */
  pct: number | null
  pressure: Pressure
}

/** Thresholds the page and the summary tiles agree on. */
export const WARN_AT = 70
export const HIGH_AT = 90

export function pressureOf(pct: number | null): Pressure {
  if (pct == null) return 'unbounded'
  if (pct >= 100) return 'full'
  if (pct >= HIGH_AT) return 'high'
  if (pct >= WARN_AT) return 'warn'
  return 'ok'
}

export function usagePct(used: string | undefined, hard: string | undefined): number | null {
  if (hard == null) return null
  const h = parseQuantity(hard)
  const u = parseQuantity(used ?? '0')
  if (!Number.isFinite(h) || !Number.isFinite(u)) return null
  if (h === 0) return u > 0 ? 100 : 0
  return (u / h) * 100
}

/** Every resource a quota limits, with live usage, most pressured first. */
export function quotaLines(q: ResourceQuota): QuotaLine[] {
  const hard = q.status?.hard ?? q.spec?.hard ?? {}
  const used = q.status?.used ?? {}
  return Object.keys(hard)
    .map((resource) => {
      const pct = usagePct(used[resource], hard[resource])
      return { resource, used: used[resource], hard: hard[resource], pct, pressure: pressureOf(pct) }
    })
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.resource.localeCompare(b.resource))
}

/** The quota's tightest resource — what its row headlines. */
export function topLine(q: ResourceQuota): QuotaLine | undefined {
  return quotaLines(q)[0]
}

/** Status from the controller: has it computed usage yet? */
export function quotaReconciled(q: ResourceQuota): boolean {
  return !!q.status?.hard && Object.keys(q.status.hard).length > 0
}

/* ─── resource names ────────────────────────────────────────────────────── */

/** Human label for a quota resource key (`requests.cpu`, `count/deployments.apps`, …). */
export function resourceLabel(key: string): string {
  const fixed: Record<string, string> = {
    'requests.cpu': 'CPU requests',
    'limits.cpu': 'CPU limits',
    cpu: 'CPU requests',
    'requests.memory': 'Memory requests',
    'limits.memory': 'Memory limits',
    memory: 'Memory requests',
    'requests.storage': 'Storage requests',
    'requests.ephemeral-storage': 'Ephemeral storage requests',
    'limits.ephemeral-storage': 'Ephemeral storage limits',
    pods: 'Pods',
    services: 'Services',
    'services.loadbalancers': 'LoadBalancer services',
    'services.nodeports': 'NodePort services',
    persistentvolumeclaims: 'PVCs',
    configmaps: 'ConfigMaps',
    secrets: 'Secrets',
    replicationcontrollers: 'ReplicationControllers',
    resourcequotas: 'ResourceQuotas',
  }
  if (fixed[key]) return fixed[key]
  const count = /^count\/(.+)$/.exec(key)
  if (count) return `${count[1].split('.')[0]} (count)`
  const sc = /^(.+)\.storageclass\.storage\.k8s\.io\/(.+)$/.exec(key)
  if (sc) return `${sc[2] === 'requests.storage' ? 'Storage' : sc[2]} · ${sc[1]}`
  return key
}

/* ─── presets ───────────────────────────────────────────────────────────── */

export interface QuotaPreset {
  id: 'small' | 'medium' | 'large'
  label: string
  hint: string
  hard: Record<string, string>
}

/** Starting points for a team namespace; every value stays editable. */
export const QUOTA_PRESETS: QuotaPreset[] = [
  {
    id: 'small',
    label: 'Small',
    hint: 'A dev or preview namespace',
    hard: {
      'requests.cpu': '2', 'limits.cpu': '4', 'requests.memory': '4Gi', 'limits.memory': '8Gi',
      pods: '20', services: '10', persistentvolumeclaims: '5', 'requests.storage': '20Gi',
    },
  },
  {
    id: 'medium',
    label: 'Medium',
    hint: 'A team’s staging namespace',
    hard: {
      'requests.cpu': '4', 'limits.cpu': '8', 'requests.memory': '8Gi', 'limits.memory': '16Gi',
      pods: '50', services: '20', persistentvolumeclaims: '10', 'requests.storage': '100Gi',
    },
  },
  {
    id: 'large',
    label: 'Large',
    hint: 'A production namespace',
    hard: {
      'requests.cpu': '16', 'limits.cpu': '32', 'requests.memory': '32Gi', 'limits.memory': '64Gi',
      pods: '200', services: '50', persistentvolumeclaims: '40', 'requests.storage': '500Gi',
    },
  },
]

/** Resource keys offered in the create form, in display order. */
export const QUOTA_KEYS = [
  'requests.cpu', 'limits.cpu', 'requests.memory', 'limits.memory',
  'pods', 'services', 'persistentvolumeclaims', 'requests.storage',
  'configmaps', 'secrets', 'services.loadbalancers', 'services.nodeports',
  'count/deployments.apps', 'count/jobs.batch',
] as const

/* ─── validation + manifests ────────────────────────────────────────────── */

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

export function nameError(name: string): string | undefined {
  if (!name) return 'Required.'
  if (name.length > 63) return 'At most 63 characters.'
  if (!DNS1123.test(name)) return 'Lowercase letters, digits and "-", starting and ending alphanumeric.'
  return undefined
}

export function quantityError(v: string): string | undefined {
  if (!v) return undefined
  const n = parseQuantity(v)
  if (!Number.isFinite(n)) return `"${v}" is not a quantity (e.g. 500m, 2, 4Gi).`
  if (n < 0) return 'Must not be negative.'
  return undefined
}

/** Drop blank values so an emptied field means "no limit", not "0". */
export function cleanQuantities(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k.trim(), v.trim()]).filter(([k, v]) => k && v),
  )
}

export function buildQuota(
  namespace: string,
  name: string,
  hard: Record<string, string>,
  scopes: string[] = [],
) {
  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'adhar-console' } },
    spec: { hard: cleanQuantities(hard), ...(scopes.length ? { scopes } : {}) },
  }
}

export interface ContainerLimits {
  defaultRequestCpu: string
  defaultRequestMemory: string
  defaultCpu: string
  defaultMemory: string
  maxCpu: string
  maxMemory: string
  minCpu: string
  minMemory: string
  pvcMin: string
  pvcMax: string
}

export const EMPTY_LIMITS: ContainerLimits = {
  defaultRequestCpu: '', defaultRequestMemory: '', defaultCpu: '', defaultMemory: '',
  maxCpu: '', maxMemory: '', minCpu: '', minMemory: '', pvcMin: '', pvcMax: '',
}

export const LIMIT_PRESET: ContainerLimits = {
  defaultRequestCpu: '100m', defaultRequestMemory: '128Mi', defaultCpu: '500m', defaultMemory: '512Mi',
  maxCpu: '2', maxMemory: '4Gi', minCpu: '10m', minMemory: '16Mi', pvcMin: '1Gi', pvcMax: '100Gi',
}

const pair = (cpu: string, memory: string) => cleanQuantities({ cpu, memory })

export function buildLimitRange(namespace: string, name: string, l: ContainerLimits) {
  const container: LimitRangeItem = { type: 'Container' }
  const set = (k: keyof LimitRangeItem, v: Record<string, string>) => {
    if (Object.keys(v).length) (container as Record<string, unknown>)[k] = v
  }
  set('defaultRequest', pair(l.defaultRequestCpu, l.defaultRequestMemory))
  set('default', pair(l.defaultCpu, l.defaultMemory))
  set('max', pair(l.maxCpu, l.maxMemory))
  set('min', pair(l.minCpu, l.minMemory))
  const limits: LimitRangeItem[] = Object.keys(container).length > 1 ? [container] : []
  const pvc = { min: cleanQuantities({ storage: l.pvcMin }), max: cleanQuantities({ storage: l.pvcMax }) }
  if (Object.keys(pvc.min).length || Object.keys(pvc.max).length) {
    limits.push({
      type: 'PersistentVolumeClaim',
      ...(Object.keys(pvc.min).length ? { min: pvc.min } : {}),
      ...(Object.keys(pvc.max).length ? { max: pvc.max } : {}),
    })
  }
  return {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'adhar-console' } },
    spec: { limits },
  }
}

/**
 * The consistency rules the apiserver enforces on a Container limit range,
 * checked before submitting so the form explains the problem in place:
 * min ≤ defaultRequest ≤ default ≤ max for each of cpu and memory.
 */
export function limitRangeErrors(l: ContainerLimits): string[] {
  const out: string[] = []
  for (const [res, chain] of [
    ['CPU', [l.minCpu, l.defaultRequestCpu, l.defaultCpu, l.maxCpu]],
    ['Memory', [l.minMemory, l.defaultRequestMemory, l.defaultMemory, l.maxMemory]],
  ] as const) {
    const names = ['min', 'default request', 'default limit', 'max']
    const vals = chain.map((v) => (v ? parseQuantity(v) : null))
    for (let i = 0; i < vals.length; i++) {
      for (let j = i + 1; j < vals.length; j++) {
        const a = vals[i]
        const b = vals[j]
        if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && a > b) {
          out.push(`${res}: ${names[i]} (${chain[i]}) is above ${names[j]} (${chain[j]}).`)
        }
      }
    }
  }
  for (const v of Object.values(l)) {
    const e = quantityError(v)
    if (e) out.push(e)
  }
  if (l.pvcMin && l.pvcMax && parseQuantity(l.pvcMin) > parseQuantity(l.pvcMax)) {
    out.push(`PVC: min (${l.pvcMin}) is above max (${l.pvcMax}).`)
  }
  return [...new Set(out)]
}

/** The Container entry of a LimitRange, which is what workloads feel. */
export function containerLimits(lr: LimitRange): LimitRangeItem | undefined {
  return lr.spec?.limits?.find((l) => l.type === 'Container')
}
