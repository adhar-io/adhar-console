import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

export const RolloutSchema = z.object({
  metadata: z.object({ name: z.string(), namespace: z.string() }),
  spec: z.object({
    replicas: z.number().optional(),
    strategy: z
      .object({
        canary: z.object({ steps: z.array(z.record(z.any())) }).optional(),
        blueGreen: z.record(z.any()).optional(),
      })
      .optional(),
  }),
  status: z.object({
    phase: z.enum(['Healthy', 'Progressing', 'Degraded', 'Paused']).optional(),
    currentStepIndex: z.number().optional(),
    message: z.string().optional(),
  }),
})
export type Rollout = z.infer<typeof RolloutSchema>

export interface ArgoRolloutsClient {
  listRollouts(namespace?: string): Promise<Rollout[]>
  promoteRollout(namespace: string, name: string, full?: boolean): Promise<void>
  abortRollout(namespace: string, name: string): Promise<void>
}

function build(http: HttpClient): ArgoRolloutsClient {
  return {
    listRollouts: async (ns) => {
      const path = ns
        ? `/apis/argoproj.io/v1alpha1/namespaces/${ns}/rollouts`
        : `/apis/argoproj.io/v1alpha1/rollouts`
      const res = await http.get<{ items: Rollout[] }>(path)
      return res.items
    },
    promoteRollout: async (ns, n, full) => {
      await http.put<void>(`/api/v1/rollouts/${ns}/${n}/promote${full ? '?full=true' : ''}`, {})
    },
    abortRollout: async (ns, n) => {
      await http.put<void>(`/api/v1/rollouts/${ns}/${n}/abort`, {})
    },
  }
}

const STUB_ROLLOUTS: Rollout[] = [
  {
    metadata: { name: 'adhar-console', namespace: 'acme-console' },
    spec: { replicas: 4, strategy: { canary: { steps: [{ setWeight: 25 }, { pause: {} }] } } },
    status: { phase: 'Healthy', currentStepIndex: 2 },
  },
  {
    metadata: { name: 'billing-service', namespace: 'acme-billing' },
    spec: { replicas: 3, strategy: { canary: { steps: [{ setWeight: 10 }, { pause: {} }] } } },
    status: { phase: 'Paused', currentStepIndex: 1, message: 'Awaiting manual promotion' },
  },
]

export const ArgoRolloutsClient = defineClient<ArgoRolloutsClient>(build, () => ({
  listRollouts: async () => STUB_ROLLOUTS,
  promoteRollout: async () => {},
  abortRollout: async () => {},
}))
