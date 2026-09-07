import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Argo Rollouts.
 *
 * Rollouts are Kubernetes CRDs (`argoproj.io/v1alpha1`), so the console reads
 * and drives them through its k8s gateway (`/api/k8s`, the user's RBAC) —
 * the dashboard's REST API is optional and often not exposed. Promote / abort
 * mirror `kubectl argo rollouts`: a merge-patch on the `status` subresource
 * (`pauseConditions: null`, `promoteFull: true`, `abort: true`) and, for a
 * rollout paused via `spec.paused`, un-pausing the spec.
 */

export const RolloutSchema = z.object({
  metadata: z.object({ name: z.string(), namespace: z.string(), creationTimestamp: z.string().optional() }),
  spec: z.object({
    replicas: z.number().optional(),
    paused: z.boolean().optional(),
    strategy: z
      .object({
        canary: z.object({ steps: z.array(z.record(z.any())).optional() }).optional(),
        blueGreen: z.record(z.any()).optional(),
      })
      .optional(),
  }),
  status: z.object({
    phase: z.enum(['Healthy', 'Progressing', 'Degraded', 'Paused']).optional(),
    currentStepIndex: z.number().optional(),
    message: z.string().optional(),
    replicas: z.number().optional(),
    updatedReplicas: z.number().optional(),
    readyReplicas: z.number().optional(),
    availableReplicas: z.number().optional(),
    abort: z.boolean().optional(),
    pauseConditions: z.array(z.record(z.any())).optional(),
    canary: z.object({ weights: z.object({ canary: z.object({ weight: z.number().optional() }).optional(), stable: z.object({ weight: z.number().optional() }).optional() }).optional() }).optional(),
    currentPodHash: z.string().optional(),
    stableRS: z.string().optional(),
  }),
})
export type Rollout = z.infer<typeof RolloutSchema>

export interface ArgoRolloutsClient {
  listRollouts(namespace?: string): Promise<Rollout[]>
  promoteRollout(namespace: string, name: string, full?: boolean): Promise<void>
  abortRollout(namespace: string, name: string): Promise<void>
  retryRollout(namespace: string, name: string): Promise<void>
}

const API = '/apis/argoproj.io/v1alpha1'
const MERGE = { headers: { 'content-type': 'application/merge-patch+json' } }

function normalize(r: Rollout): Rollout {
  const raw = (r.status?.phase ?? '') as string
  const phase = raw === 'Healthy' || raw === 'Progressing' || raw === 'Degraded' || raw === 'Paused' ? raw : undefined
  return { ...r, status: { ...r.status, phase } }
}

function build(_http: HttpClient): ArgoRolloutsClient {
  const k8s = new HttpClient({ baseUrl: '/api/k8s', credentials: 'include' })
  const path = (ns: string, n: string) => `${API}/namespaces/${encodeURIComponent(ns)}/rollouts/${encodeURIComponent(n)}`
  return {
    listRollouts: async (ns) => {
      const p = ns ? `${API}/namespaces/${encodeURIComponent(ns)}/rollouts` : `${API}/rollouts`
      const res = await k8s.get<{ items: Rollout[] }>(`${p}?limit=500`)
      return (res.items ?? []).map(normalize)
    },
    promoteRollout: async (ns, n, full) => {
      const cur = await k8s.get<Rollout>(path(ns, n))
      if (cur.spec?.paused) await k8s.patch<unknown>(path(ns, n), { spec: { paused: false } }, MERGE)
      await k8s.patch<unknown>(`${path(ns, n)}/status`, full ? { status: { promoteFull: true } } : { status: { pauseConditions: null } }, MERGE)
    },
    abortRollout: async (ns, n) => {
      await k8s.patch<unknown>(`${path(ns, n)}/status`, { status: { abort: true } }, MERGE)
    },
    retryRollout: async (ns, n) => {
      await k8s.patch<unknown>(`${path(ns, n)}/status`, { status: { abort: false } }, MERGE)
    },
  }
}

const STUB_ROLLOUTS: Rollout[] = [
  {
    metadata: { name: 'adhar-console', namespace: 'demo-console' },
    spec: { replicas: 4, strategy: { canary: { steps: [{ setWeight: 25 }, { pause: {} }] } } },
    status: { phase: 'Healthy', currentStepIndex: 2, replicas: 4, readyReplicas: 4, availableReplicas: 4, updatedReplicas: 4 },
  },
  {
    metadata: { name: 'billing-service', namespace: 'demo-billing' },
    spec: { replicas: 3, strategy: { canary: { steps: [{ setWeight: 10 }, { pause: {} }] } } },
    status: { phase: 'Paused', currentStepIndex: 1, message: 'Awaiting manual promotion', replicas: 3, readyReplicas: 3, availableReplicas: 3, updatedReplicas: 1, canary: { weights: { canary: { weight: 10 }, stable: { weight: 90 } } } },
  },
]

export const ArgoRolloutsClient = defineClient<ArgoRolloutsClient>(build, () => ({
  listRollouts: async () => STUB_ROLLOUTS,
  promoteRollout: async () => {},
  abortRollout: async () => {},
  retryRollout: async () => {},
}))
