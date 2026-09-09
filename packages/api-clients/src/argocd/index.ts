import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

export const SyncStatusSchema = z.enum(['Synced', 'OutOfSync', 'Unknown'])
export const HealthStatusSchema = z.enum([
  'Healthy',
  'Degraded',
  'Progressing',
  'Suspended',
  'Missing',
  'Unknown',
])

export const SourceSchema = z.object({
  repoURL: z.string(),
  path: z.string().optional(),
  chart: z.string().optional(),
  targetRevision: z.string().optional(),
})
export type Source = z.infer<typeof SourceSchema>

/**
 * The wire shape. Argo CD ≥ 2.6 Applications may declare a single
 * `spec.source` OR a `spec.sources[]` array (multi-source Helm/Git), an
 * Application mid-creation carries neither, and `status` is empty until the
 * controller first reconciles. Everything optional here is filled in by
 * `normalizeApplication` so views never touch `undefined` — that was the
 * "Cannot read properties of undefined (reading 'path')" crash on the
 * Deliver dashboard.
 */
const RawApplicationSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string(),
    creationTimestamp: z.string().optional(),
    labels: z.record(z.string()).optional(),
  }),
  spec: z
    .object({
      project: z.string().optional(),
      source: SourceSchema.optional(),
      sources: z.array(SourceSchema).optional(),
      destination: z
        .object({ server: z.string().optional(), name: z.string().optional(), namespace: z.string().optional() })
        .optional(),
      syncPolicy: z
        .object({
          automated: z.object({ prune: z.boolean().optional(), selfHeal: z.boolean().optional() }).optional(),
          syncOptions: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  status: z
    .object({
      sync: z.object({ status: SyncStatusSchema.optional(), revision: z.string().optional() }).optional(),
      health: z.object({ status: HealthStatusSchema.optional(), message: z.string().optional() }).optional(),
      operationState: z
        .object({
          phase: z.string(),
          message: z.string().optional(),
          startedAt: z.string().optional(),
          finishedAt: z.string().optional(),
          operation: z
            .object({
              sync: z.object({ revision: z.string().optional(), prune: z.boolean().optional(), dryRun: z.boolean().optional() }).optional(),
              initiatedBy: z.object({ username: z.string().optional(), automated: z.boolean().optional() }).optional(),
            })
            .optional(),
          syncResult: z.object({ revision: z.string().optional() }).optional(),
        })
        .optional(),
      conditions: z.array(z.object({ type: z.string(), message: z.string().optional(), lastTransitionTime: z.string().optional() })).optional(),
      summary: z.object({ images: z.array(z.string()).optional(), externalURLs: z.array(z.string()).optional() }).optional(),
      history: z.array(z.object({ id: z.number(), revision: z.string().optional(), deployedAt: z.string().optional() })).optional(),
      reconciledAt: z.string().optional(),
      resources: z.array(z.object({ kind: z.string().optional(), status: z.string().optional(), health: z.object({ status: z.string().optional() }).optional() })).optional(),
    })
    .optional(),
})
export type RawApplication = z.infer<typeof RawApplicationSchema>

/** Normalized Application — every field views read is guaranteed present. */
export interface Application {
  metadata: { name: string; namespace: string; creationTimestamp?: string; labels: Record<string, string> }
  spec: {
    project: string
    /** Resolved from `source`, else the first of `sources`, else an empty ref. */
    source: Source
    /** All sources (single-source apps report one). */
    sources: Source[]
    destination: { server: string; name?: string; namespace: string }
    /** Auto-sync policy: `automated` is undefined for manual-sync apps. */
    syncPolicy: { automated?: { prune: boolean; selfHeal: boolean }; syncOptions: string[] }
  }
  status: {
    sync: { status: z.infer<typeof SyncStatusSchema>; revision?: string }
    health: { status: z.infer<typeof HealthStatusSchema>; message?: string }
    /** Last (or running) sync/rollback operation. */
    operationState?: {
      phase: string
      message?: string
      startedAt?: string
      finishedAt?: string
      revision?: string
      initiatedBy?: string
      dryRun?: boolean
    }
    /** Controller conditions (ComparisonError, SyncError, …) — empty when healthy. */
    conditions: Array<{ type: string; message?: string; lastTransitionTime?: string }>
    /** Container images the app currently deploys. */
    images: string[]
    /** Number of deployments in `.status.history`. */
    deployments: number
    /** Last time the controller reconciled the app. */
    reconciledAt?: string
    /** Managed-resource counts (from `.status.resources`). */
    resources: { total: number; outOfSync: number; unhealthy: number }
  }
}

const EMPTY_SOURCE: Source = { repoURL: '' }

/** Fill in every optional the apiserver may omit. Total, never throws. */
export function normalizeApplication(raw: RawApplication): Application {
  const spec = raw.spec ?? {}
  const sources = spec.sources?.length ? spec.sources : spec.source ? [spec.source] : []
  const dest = spec.destination ?? {}
  const st = raw.status ?? {}
  const op = st.operationState
  const res = st.resources ?? []
  return {
    metadata: { ...raw.metadata, labels: raw.metadata.labels ?? {} },
    spec: {
      project: spec.project ?? 'default',
      source: sources[0] ?? EMPTY_SOURCE,
      sources,
      destination: {
        server: dest.server ?? dest.name ?? 'in-cluster',
        name: dest.name,
        namespace: dest.namespace ?? '',
      },
      syncPolicy: {
        automated: spec.syncPolicy?.automated
          ? { prune: spec.syncPolicy.automated.prune ?? false, selfHeal: spec.syncPolicy.automated.selfHeal ?? false }
          : undefined,
        syncOptions: spec.syncPolicy?.syncOptions ?? [],
      },
    },
    status: {
      sync: { status: st.sync?.status ?? 'Unknown', revision: st.sync?.revision },
      health: { status: st.health?.status ?? 'Unknown', message: st.health?.message },
      operationState: op
        ? {
            phase: op.phase,
            message: op.message,
            startedAt: op.startedAt,
            finishedAt: op.finishedAt,
            revision: op.syncResult?.revision ?? op.operation?.sync?.revision,
            initiatedBy: op.operation?.initiatedBy?.username ?? (op.operation?.initiatedBy?.automated ? 'automation' : undefined),
            dryRun: op.operation?.sync?.dryRun,
          }
        : undefined,
      conditions: st.conditions ?? [],
      images: st.summary?.images ?? [],
      deployments: st.history?.length ?? 0,
      reconciledAt: st.reconciledAt,
      resources: {
        total: res.length,
        outOfSync: res.filter((r) => r.status === 'OutOfSync').length,
        unhealthy: res.filter((r) => r.health?.status === 'Degraded' || r.health?.status === 'Missing').length,
      },
    },
  }
}

/** Back-compat alias for callers importing the schema. */
export const ApplicationSchema = RawApplicationSchema

export interface ArgoCDClient {
  listApplications(project?: string): Promise<Application[]>
  getApplication(name: string): Promise<Application>
  syncApplication(name: string): Promise<void>
}

function build(http: HttpClient): ArgoCDClient {
  return {
    listApplications: async (project) => {
      const res = await http.get<{ items: RawApplication[] }>(
        `/api/v1/applications${project ? `?projects=${encodeURIComponent(project)}` : ''}`,
      )
      return (res.items ?? []).map(normalizeApplication)
    },
    getApplication: async (name) => normalizeApplication(await http.get<RawApplication>(`/api/v1/applications/${encodeURIComponent(name)}`)),
    syncApplication: async (name) => {
      await http.post<void>(`/api/v1/applications/${name}/sync`, {})
    },
  }
}

const STUB_APPS: Application[] = ([
  {
    metadata: { name: 'adhar-console', namespace: 'argocd' },
    spec: {
      project: 'default',
      source: {
        repoURL: 'https://gitea.adhar.local/adhar/gitops',
        path: 'envs/prod/adhar-console',
        targetRevision: 'main',
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'demo-console' },
    },
    status: {
      sync: { status: 'Synced', revision: 'abc123' },
      health: { status: 'Healthy' },
    },
  },
  {
    metadata: { name: 'billing-service', namespace: 'argocd' },
    spec: {
      project: 'default',
      source: {
        repoURL: 'https://gitea.adhar.local/adhar/gitops',
        path: 'envs/prod/billing',
        targetRevision: 'main',
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'demo-billing' },
    },
    status: {
      sync: { status: 'OutOfSync', revision: 'def456' },
      health: { status: 'Degraded', message: 'Pod crash looping' },
    },
  },
] as RawApplication[]).map(normalizeApplication)

export const ArgoCDClient = defineClient<ArgoCDClient>(build, () => ({
  listApplications: async () => STUB_APPS,
  getApplication: async (name) => {
    const a = STUB_APPS.find((x) => x.metadata.name === name)
    if (!a) throw new Error(`Stub: app ${name} not found`)
    return a
  },
  syncApplication: async () => {},
}))
