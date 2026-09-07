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
  }),
  spec: z
    .object({
      project: z.string().optional(),
      source: SourceSchema.optional(),
      sources: z.array(SourceSchema).optional(),
      destination: z
        .object({ server: z.string().optional(), name: z.string().optional(), namespace: z.string().optional() })
        .optional(),
    })
    .optional(),
  status: z
    .object({
      sync: z.object({ status: SyncStatusSchema.optional(), revision: z.string().optional() }).optional(),
      health: z.object({ status: HealthStatusSchema.optional(), message: z.string().optional() }).optional(),
      operationState: z.object({ phase: z.string(), finishedAt: z.string().optional() }).optional(),
    })
    .optional(),
})
export type RawApplication = z.infer<typeof RawApplicationSchema>

/** Normalized Application — every field views read is guaranteed present. */
export interface Application {
  metadata: { name: string; namespace: string; creationTimestamp?: string }
  spec: {
    project: string
    /** Resolved from `source`, else the first of `sources`, else an empty ref. */
    source: Source
    /** All sources (single-source apps report one). */
    sources: Source[]
    destination: { server: string; name?: string; namespace: string }
  }
  status: {
    sync: { status: z.infer<typeof SyncStatusSchema>; revision?: string }
    health: { status: z.infer<typeof HealthStatusSchema>; message?: string }
    operationState?: { phase: string; finishedAt?: string }
  }
}

const EMPTY_SOURCE: Source = { repoURL: '' }

/** Fill in every optional the apiserver may omit. Total, never throws. */
export function normalizeApplication(raw: RawApplication): Application {
  const spec = raw.spec ?? {}
  const sources = spec.sources?.length ? spec.sources : spec.source ? [spec.source] : []
  const dest = spec.destination ?? {}
  const st = raw.status ?? {}
  return {
    metadata: raw.metadata,
    spec: {
      project: spec.project ?? 'default',
      source: sources[0] ?? EMPTY_SOURCE,
      sources,
      destination: {
        server: dest.server ?? dest.name ?? 'in-cluster',
        name: dest.name,
        namespace: dest.namespace ?? '',
      },
    },
    status: {
      sync: { status: st.sync?.status ?? 'Unknown', revision: st.sync?.revision },
      health: { status: st.health?.status ?? 'Unknown', message: st.health?.message },
      operationState: st.operationState,
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
