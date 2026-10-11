import type { ServiceHealth } from '@adhar/platform-info'

/**
 * Pure matching and roll-up for the platform's backing components — shared
 * by the browser hook (backing-health.ts) and the server's /api/status, so
 * both name, match and grade a component the same way.
 */

export interface Workload {
  name: string
  namespace?: string
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet'
  ready: number
  desired: number
  /** First container's image, when known. */
  image?: string
}

/** Per-component name matchers (include keywords, optional excludes). */
export const MATCHERS: Record<string, { include: string[]; exclude?: string[] }> = {
  gitea: { include: ['gitea'] },
  argocd: { include: ['argo-cd', 'argocd'] },
  kargo: { include: ['kargo'] },
  'argo-rollouts': { include: ['argo-rollout'] },
  crossplane: { include: ['crossplane'] },
  keycloak: { include: ['keycloak'] },
  harbor: { include: ['harbor'] },
  kyverno: { include: ['kyverno'] },
  // "plane" collides with "crossplane"/"control-plane" — exclude them.
  plane: { include: ['plane'], exclude: ['crossplane', 'control-plane'] },
  grafana: { include: ['grafana'] },
  loki: { include: ['loki'] },
  mimir: { include: ['mimir'] },
  tempo: { include: ['tempo'] },
  prometheus: { include: ['prometheus', 'kube-prometheus'] },
  opentelemetry: { include: ['opentelemetry', 'otel', 'alloy'] },
  beyla: { include: ['beyla'] },
}

export function matchWorkloads(all: Workload[], id: string): Workload[] {
  const m = MATCHERS[id]
  if (!m) return []
  return all.filter((w) => {
    const n = w.name.toLowerCase()
    if (m.exclude?.some((e) => n.includes(e))) return false
    return m.include.some((k) => n.includes(k))
  })
}

export function foldHealth(workloads: Workload[]): { health: ServiceHealth; ready: number; desired: number } {
  if (workloads.length === 0) return { health: 'unknown', ready: 0, desired: 0 }
  const ready = workloads.reduce((s, w) => s + Math.min(w.ready, w.desired || w.ready), 0)
  const desired = workloads.reduce((s, w) => s + (w.desired || 0), 0)
  const allReady = workloads.every((w) => (w.desired ? w.ready >= w.desired : w.ready > 0))
  const noneReady = workloads.every((w) => w.ready === 0)
  const health: ServiceHealth = allReady ? 'operational' : noneReady ? 'outage' : 'degraded'
  return { health, ready, desired }
}

/**
 * The version an image runs, read from its tag: `ghcr.io/adhar-io/adhar:0.1.38`
 * → `0.1.38`, `…@sha256:abc` → `sha256:abc1234`. `latest` and missing tags
 * come back as-is or undefined — a tag is only a version when it looks like one.
 */
export function imageVersion(image: string | undefined): string | undefined {
  if (!image) return undefined
  const at = image.indexOf('@')
  if (at >= 0) {
    const tagPart = image.slice(0, at)
    const tag = tagPart.lastIndexOf(':') > tagPart.lastIndexOf('/') ? tagPart.slice(tagPart.lastIndexOf(':') + 1) : undefined
    return tag ?? image.slice(at + 1, at + 1 + 14)
  }
  const colon = image.lastIndexOf(':')
  if (colon < 0 || colon < image.lastIndexOf('/')) return undefined
  return image.slice(colon + 1)
}
