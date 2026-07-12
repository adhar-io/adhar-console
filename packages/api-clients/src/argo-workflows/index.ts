import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

export const WorkflowSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string(),
    creationTimestamp: z.string().optional(),
  }),
  spec: z.object({ entrypoint: z.string().optional() }),
  status: z.object({
    phase: z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Error']),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    progress: z.string().optional(),
  }),
})
export type Workflow = z.infer<typeof WorkflowSchema>

export interface ArgoWorkflowsClient {
  listWorkflows(namespace: string): Promise<Workflow[]>
  getWorkflow(namespace: string, name: string): Promise<Workflow>
  resubmitWorkflow(namespace: string, name: string): Promise<void>
}

function build(http: HttpClient): ArgoWorkflowsClient {
  return {
    listWorkflows: async (ns) => {
      const res = await http.get<{ items: Workflow[] }>(`/api/v1/workflows/${ns}`)
      return res.items
    },
    getWorkflow: (ns, n) => http.get<Workflow>(`/api/v1/workflows/${ns}/${n}`),
    resubmitWorkflow: async (ns, n) => {
      await http.put<void>(`/api/v1/workflows/${ns}/${n}/resubmit`, {})
    },
  }
}

const STUB_WORKFLOWS: Workflow[] = [
  {
    metadata: {
      name: 'adhar-console-build-xyz12',
      namespace: 'argo',
      creationTimestamp: '2026-04-19T04:50:00Z',
    },
    spec: { entrypoint: 'main' },
    status: {
      phase: 'Succeeded',
      startedAt: '2026-04-19T04:50:00Z',
      finishedAt: '2026-04-19T04:54:37Z',
      progress: '4/4',
    },
  },
  {
    metadata: {
      name: 'billing-service-build-abc99',
      namespace: 'argo',
      creationTimestamp: '2026-04-19T06:12:00Z',
    },
    spec: { entrypoint: 'main' },
    status: { phase: 'Running', startedAt: '2026-04-19T06:12:00Z', progress: '2/5' },
  },
]

export const ArgoWorkflowsClient = defineClient<ArgoWorkflowsClient>(build, () => ({
  listWorkflows: async () => STUB_WORKFLOWS,
  getWorkflow: async (_ns, n) => {
    const w = STUB_WORKFLOWS.find((x) => x.metadata.name === n)
    if (!w) throw new Error(`Stub: workflow ${n} not found`)
    return w
  },
  resubmitWorkflow: async () => {},
}))
