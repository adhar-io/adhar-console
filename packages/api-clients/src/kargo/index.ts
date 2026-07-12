import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

export const StageSchema = z.object({
  name: z.string(),
  project: z.string(),
  currentFreight: z.string().optional(),
  lastPromoted: z.string().optional(),
  phase: z.enum(['NotApplicable', 'Pending', 'Promoting', 'Verifying', 'Steady', 'Failed']),
})
export type Stage = z.infer<typeof StageSchema>

export const FreightSchema = z.object({
  id: z.string(),
  project: z.string(),
  images: z.array(z.object({ repoURL: z.string(), tag: z.string() })),
  created: z.string(),
})
export type Freight = z.infer<typeof FreightSchema>

export interface KargoClient {
  listStages(project: string): Promise<Stage[]>
  listFreight(project: string): Promise<Freight[]>
  promote(project: string, stage: string, freight: string): Promise<void>
}

function build(http: HttpClient): KargoClient {
  return {
    listStages: (p) => http.get<Stage[]>(`/api/v1/projects/${p}/stages`),
    listFreight: (p) => http.get<Freight[]>(`/api/v1/projects/${p}/freight`),
    promote: async (p, s, f) => {
      await http.post<void>(`/api/v1/projects/${p}/stages/${s}/promote`, { freight: f })
    },
  }
}

const STUB_STAGES: Stage[] = [
  {
    name: 'dev',
    project: 'acme',
    currentFreight: 'fr-1',
    lastPromoted: '2026-04-19T05:00:00Z',
    phase: 'Steady',
  },
  {
    name: 'staging',
    project: 'acme',
    currentFreight: 'fr-0',
    lastPromoted: '2026-04-17T12:00:00Z',
    phase: 'Promoting',
  },
  {
    name: 'prod',
    project: 'acme',
    currentFreight: 'fr-0',
    lastPromoted: '2026-04-15T16:30:00Z',
    phase: 'Steady',
  },
]

const STUB_FREIGHT: Freight[] = [
  {
    id: 'fr-1',
    project: 'acme',
    images: [{ repoURL: 'harbor.adhar.local/acme/adhar-console', tag: 'v0.2.0' }],
    created: '2026-04-19T04:55:00Z',
  },
  {
    id: 'fr-0',
    project: 'acme',
    images: [{ repoURL: 'harbor.adhar.local/acme/adhar-console', tag: 'v0.1.9' }],
    created: '2026-04-15T16:00:00Z',
  },
]

export const KargoClient = defineClient<KargoClient>(build, () => ({
  listStages: async () => STUB_STAGES,
  listFreight: async () => STUB_FREIGHT,
  promote: async () => {},
}))
