import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Kargo (promotion pipelines).
 *
 * Kargo's API server speaks Connect-RPC/gRPC-web, not the REST paths a
 * generic proxy can call — so the console reads Kargo's Kubernetes CRDs
 * directly through the console's k8s gateway (`/api/k8s`, the signed-in
 * user's RBAC): `stages`, `freights`, `warehouses` and `promotions` in
 * `kargo.akuity.io/v1alpha1`. Promoting creates a `Promotion` resource —
 * exactly what the Kargo CLI/UI do.
 *
 * A Kargo *project* is a namespace (labelled `kargo.akuity.io/project`). The
 * caller passes the platform project; when that namespace has no stages the
 * client falls back to every project the user can see.
 */

export const StageSchema = z.object({
  name: z.string(),
  /** Kargo project == namespace. */
  project: z.string(),
  currentFreight: z.string().optional(),
  currentFreightAlias: z.string().optional(),
  lastPromoted: z.string().optional(),
  phase: z.enum(['NotApplicable', 'Pending', 'Promoting', 'Verifying', 'Steady', 'Failed', 'Erroring', 'Unknown']),
  health: z.enum(['Healthy', 'Unhealthy', 'Progressing', 'Unknown']).optional(),
  /** Upstream stages this one promotes from (empty = fed by a warehouse). */
  upstream: z.array(z.string()).optional(),
  warehouse: z.string().optional(),
  message: z.string().optional(),
})
export type Stage = z.infer<typeof StageSchema>

export const FreightSchema = z.object({
  id: z.string(),
  alias: z.string().optional(),
  project: z.string(),
  warehouse: z.string().optional(),
  images: z.array(z.object({ repoURL: z.string(), tag: z.string(), digest: z.string().optional() })),
  commits: z.array(z.object({ repoURL: z.string(), id: z.string(), message: z.string().optional(), branch: z.string().optional() })).optional(),
  charts: z.array(z.object({ repoURL: z.string(), name: z.string().optional(), version: z.string() })).optional(),
  verifiedIn: z.array(z.string()).optional(),
  approvedFor: z.array(z.string()).optional(),
  created: z.string(),
})
export type Freight = z.infer<typeof FreightSchema>

export interface Promotion {
  name: string
  project: string
  stage: string
  freight: string
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Errored' | 'Aborted' | 'Unknown'
  message?: string
  created: string
  finished?: string
}

export interface KargoClient {
  listStages(project: string): Promise<Stage[]>
  listFreight(project: string): Promise<Freight[]>
  listPromotions(project: string): Promise<Promotion[]>
  promote(project: string, stage: string, freight: string): Promise<void>
}

/* ─────────── raw CRD shapes (subset) ─────────── */

interface KMeta {
  name: string
  namespace?: string
  creationTimestamp?: string
  labels?: Record<string, string>
}
interface RawStage {
  metadata: KMeta
  spec?: {
    requestedFreight?: Array<{ origin?: { kind?: string; name?: string }; sources?: { direct?: boolean; stages?: string[] } }>
    subscriptions?: { warehouse?: string; upstreamStages?: Array<{ name: string }> }
  }
  status?: {
    phase?: string
    message?: string
    health?: { status?: string; issues?: string[] }
    currentFreight?: { name?: string; id?: string }
    freightHistory?: Array<{ items?: Record<string, { name?: string; origin?: { kind?: string; name?: string } }> }>
    lastPromotion?: { name?: string; finishedAt?: string; status?: { phase?: string } }
    currentPromotion?: { name?: string }
  }
}
interface RawFreight {
  metadata: KMeta
  alias?: string
  warehouse?: string
  origin?: { kind?: string; name?: string }
  images?: Array<{ repoURL: string; tag?: string; digest?: string }>
  commits?: Array<{ repoURL: string; id?: string; message?: string; branch?: string }>
  charts?: Array<{ repoURL: string; name?: string; version?: string }>
  status?: { verifiedIn?: Record<string, unknown>; approvedFor?: Record<string, unknown> }
}
interface RawPromotion {
  metadata: KMeta
  spec?: { stage?: string; freight?: string }
  status?: { phase?: string; message?: string; finishedAt?: string }
}

const API = '/apis/kargo.akuity.io/v1alpha1'

function toStage(s: RawStage): Stage {
  const st = s.status ?? {}
  const latest = st.freightHistory?.[0]?.items
  const current = st.currentFreight?.name ?? (latest ? Object.values(latest)[0]?.name : undefined)
  const rawPhase = st.phase ?? 'NotApplicable'
  const phase = (['NotApplicable', 'Pending', 'Promoting', 'Verifying', 'Steady', 'Failed', 'Erroring'].includes(rawPhase) ? rawPhase : 'Unknown') as Stage['phase']
  const h = st.health?.status
  const upstream = [
    ...(s.spec?.subscriptions?.upstreamStages ?? []).map((u) => u.name),
    ...(s.spec?.requestedFreight ?? []).flatMap((r) => r.sources?.stages ?? []),
  ]
  const warehouse = s.spec?.subscriptions?.warehouse ?? s.spec?.requestedFreight?.find((r) => r.origin?.kind === 'Warehouse')?.origin?.name
  return {
    name: s.metadata.name,
    project: s.metadata.namespace ?? '',
    currentFreight: current,
    lastPromoted: st.lastPromotion?.finishedAt,
    phase,
    health: h === 'Healthy' || h === 'Unhealthy' || h === 'Progressing' ? h : h ? 'Unknown' : undefined,
    upstream: [...new Set(upstream)],
    warehouse,
    message: st.message ?? st.health?.issues?.[0],
  }
}

function toFreight(f: RawFreight): Freight {
  return {
    id: f.metadata.name,
    alias: f.alias ?? f.metadata.labels?.['kargo.akuity.io/alias'],
    project: f.metadata.namespace ?? '',
    warehouse: f.warehouse ?? f.origin?.name,
    images: (f.images ?? []).map((i) => ({ repoURL: i.repoURL, tag: i.tag ?? (i.digest ? i.digest.slice(0, 19) : 'latest'), digest: i.digest })),
    commits: (f.commits ?? []).map((c) => ({ repoURL: c.repoURL, id: c.id ?? '', message: c.message, branch: c.branch })),
    charts: (f.charts ?? []).map((c) => ({ repoURL: c.repoURL, name: c.name, version: c.version ?? '' })),
    verifiedIn: Object.keys(f.status?.verifiedIn ?? {}),
    approvedFor: Object.keys(f.status?.approvedFor ?? {}),
    created: f.metadata.creationTimestamp ?? new Date(0).toISOString(),
  }
}

function toPromotion(p: RawPromotion): Promotion {
  const ph = p.status?.phase ?? 'Unknown'
  return {
    name: p.metadata.name,
    project: p.metadata.namespace ?? '',
    stage: p.spec?.stage ?? '',
    freight: p.spec?.freight ?? '',
    phase: (['Pending', 'Running', 'Succeeded', 'Failed', 'Errored', 'Aborted'].includes(ph) ? ph : 'Unknown') as Promotion['phase'],
    message: p.status?.message,
    created: p.metadata.creationTimestamp ?? new Date(0).toISOString(),
    finished: p.status?.finishedAt,
  }
}

/** Namespace-scoped list; empty (or forbidden) → fall back to every namespace the user can see. */
async function listScoped<T extends { metadata: KMeta }>(http: HttpClient, resource: string, project: string): Promise<T[]> {
  const all = async () => (await http.get<{ items: T[] }>(`${API}/${resource}?limit=500`)).items ?? []
  if (!project) return all()
  try {
    const mine = (await http.get<{ items: T[] }>(`${API}/namespaces/${encodeURIComponent(project)}/${resource}?limit=500`)).items ?? []
    if (mine.length) return mine
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status && status !== 403 && status !== 404) throw e
  }
  try {
    return await all()
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 403) return []
    throw e
  }
}

function build(_http: HttpClient): KargoClient {
  // Always talk to the console's k8s gateway — Kargo has no REST proxy.
  const k8s = new HttpClient({ baseUrl: '/api/k8s', credentials: 'include' })
  const bySort = (a: string | undefined, b: string | undefined) => (b ?? '').localeCompare(a ?? '')
  return {
    listStages: async (project) => (await listScoped<RawStage>(k8s, 'stages', project)).map(toStage),
    listFreight: async (project) =>
      (await listScoped<RawFreight>(k8s, 'freights', project)).map(toFreight).sort((a, b) => bySort(a.created, b.created)),
    listPromotions: async (project) =>
      (await listScoped<RawPromotion>(k8s, 'promotions', project)).map(toPromotion).sort((a, b) => bySort(a.created, b.created)).slice(0, 100),
    promote: async (project, stage, freight) => {
      await k8s.post<unknown>(`${API}/namespaces/${encodeURIComponent(project)}/promotions`, {
        apiVersion: 'kargo.akuity.io/v1alpha1',
        kind: 'Promotion',
        metadata: { generateName: `${stage}-`, namespace: project },
        spec: { stage, freight },
      })
    },
  }
}

const STUB_STAGES: Stage[] = [
  { name: 'dev', project: 'default', currentFreight: 'fr-1', currentFreightAlias: 'brave-otter', lastPromoted: '2026-04-19T05:00:00Z', phase: 'Steady', health: 'Healthy', warehouse: 'main' },
  { name: 'staging', project: 'default', currentFreight: 'fr-0', lastPromoted: '2026-04-17T12:00:00Z', phase: 'Promoting', health: 'Progressing', upstream: ['dev'] },
  { name: 'prod', project: 'default', currentFreight: 'fr-0', lastPromoted: '2026-04-15T16:30:00Z', phase: 'Steady', health: 'Healthy', upstream: ['staging'] },
]

const STUB_FREIGHT: Freight[] = [
  { id: 'fr-1', alias: 'brave-otter', project: 'default', warehouse: 'main', images: [{ repoURL: 'harbor.adhar.local/library/adhar-console', tag: 'v0.2.0' }], verifiedIn: ['dev'], created: '2026-04-19T04:55:00Z' },
  { id: 'fr-0', alias: 'calm-heron', project: 'default', warehouse: 'main', images: [{ repoURL: 'harbor.adhar.local/library/adhar-console', tag: 'v0.1.9' }], verifiedIn: ['dev', 'staging', 'prod'], created: '2026-04-15T16:00:00Z' },
]

export const KargoClient = defineClient<KargoClient>(build, () => ({
  listStages: async () => STUB_STAGES,
  listFreight: async () => STUB_FREIGHT,
  listPromotions: async () => [],
  promote: async () => {},
}))
