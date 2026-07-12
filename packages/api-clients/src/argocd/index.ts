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

export const ApplicationSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string(),
    creationTimestamp: z.string().optional(),
  }),
  spec: z.object({
    project: z.string(),
    source: z.object({
      repoURL: z.string(),
      path: z.string().optional(),
      targetRevision: z.string().optional(),
    }),
    destination: z.object({ server: z.string(), namespace: z.string() }),
  }),
  status: z.object({
    sync: z.object({ status: SyncStatusSchema, revision: z.string().optional() }),
    health: z.object({ status: HealthStatusSchema, message: z.string().optional() }),
    operationState: z
      .object({ phase: z.string(), finishedAt: z.string().optional() })
      .optional(),
  }),
})
export type Application = z.infer<typeof ApplicationSchema>

export interface ArgoCDClient {
  listApplications(project?: string): Promise<Application[]>
  getApplication(name: string): Promise<Application>
  syncApplication(name: string): Promise<void>
}

function build(http: HttpClient): ArgoCDClient {
  return {
    listApplications: async (project) => {
      const res = await http.get<{ items: Application[] }>(
        `/api/v1/applications${project ? `?projects=${project}` : ''}`,
      )
      return res.items
    },
    getApplication: (name) => http.get<Application>(`/api/v1/applications/${name}`),
    syncApplication: async (name) => {
      await http.post<void>(`/api/v1/applications/${name}/sync`, {})
    },
  }
}

const STUB_APPS: Application[] = [
  {
    metadata: { name: 'adhar-console', namespace: 'argocd' },
    spec: {
      project: 'acme',
      source: {
        repoURL: 'https://gitea.adhar.local/acme/gitops',
        path: 'envs/prod/adhar-console',
        targetRevision: 'main',
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'acme-console' },
    },
    status: {
      sync: { status: 'Synced', revision: 'abc123' },
      health: { status: 'Healthy' },
    },
  },
  {
    metadata: { name: 'billing-service', namespace: 'argocd' },
    spec: {
      project: 'acme',
      source: {
        repoURL: 'https://gitea.adhar.local/acme/gitops',
        path: 'envs/prod/billing',
        targetRevision: 'main',
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'acme-billing' },
    },
    status: {
      sync: { status: 'OutOfSync', revision: 'def456' },
      health: { status: 'Degraded', message: 'Pod crash looping' },
    },
  },
]

export const ArgoCDClient = defineClient<ArgoCDClient>(build, () => ({
  listApplications: async () => STUB_APPS,
  getApplication: async (name) => {
    const a = STUB_APPS.find((x) => x.metadata.name === name)
    if (!a) throw new Error(`Stub: app ${name} not found`)
    return a
  },
  syncApplication: async () => {},
}))
