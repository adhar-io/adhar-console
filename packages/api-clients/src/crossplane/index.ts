import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

export const CompositionSchema = z.object({
  metadata: z.object({ name: z.string(), creationTimestamp: z.string().optional() }),
  spec: z.object({
    compositeTypeRef: z.object({ apiVersion: z.string(), kind: z.string() }),
  }),
})
export type Composition = z.infer<typeof CompositionSchema>

export const ClaimSchema = z.object({
  apiVersion: z.string(),
  kind: z.string(),
  metadata: z.object({ name: z.string(), namespace: z.string().optional() }),
  status: z
    .object({
      conditions: z
        .array(z.object({ type: z.string(), status: z.string(), message: z.string().optional() }))
        .optional(),
    })
    .optional(),
})
export type Claim = z.infer<typeof ClaimSchema>

export const ProviderSchema = z.object({
  metadata: z.object({ name: z.string() }),
  spec: z.object({ package: z.string() }),
  status: z
    .object({
      conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
    })
    .optional(),
})
export type Provider = z.infer<typeof ProviderSchema>

export interface CrossplaneClient {
  listCompositions(): Promise<Composition[]>
  listProviders(): Promise<Provider[]>
  listClaims(group: string, version: string, resource: string): Promise<Claim[]>
}

function build(http: HttpClient): CrossplaneClient {
  return {
    listCompositions: async () => {
      const res = await http.get<{ items: Composition[] }>(
        '/apis/apiextensions.crossplane.io/v1/compositions',
      )
      return res.items
    },
    listProviders: async () => {
      const res = await http.get<{ items: Provider[] }>('/apis/pkg.crossplane.io/v1/providers')
      return res.items
    },
    listClaims: async (g, v, r) => {
      const res = await http.get<{ items: Claim[] }>(`/apis/${g}/${v}/${r}`)
      return res.items
    },
  }
}

const STUB_COMPOSITIONS: Composition[] = [
  {
    metadata: { name: 'xeks-standard' },
    spec: { compositeTypeRef: { apiVersion: 'acme.io/v1alpha1', kind: 'XEKS' } },
  },
  {
    metadata: { name: 'xrds-postgres' },
    spec: { compositeTypeRef: { apiVersion: 'acme.io/v1alpha1', kind: 'XPostgres' } },
  },
]

const STUB_PROVIDERS: Provider[] = [
  {
    metadata: { name: 'provider-aws-eks' },
    spec: { package: 'xpkg.upbound.io/upbound/provider-aws-eks:v1.9.0' },
    status: { conditions: [{ type: 'Healthy', status: 'True' }] },
  },
  {
    metadata: { name: 'provider-kubernetes' },
    spec: { package: 'xpkg.upbound.io/crossplane-contrib/provider-kubernetes:v0.15.0' },
    status: { conditions: [{ type: 'Healthy', status: 'True' }] },
  },
]

export const CrossplaneClient = defineClient<CrossplaneClient>(build, () => ({
  listCompositions: async () => STUB_COMPOSITIONS,
  listProviders: async () => STUB_PROVIDERS,
  listClaims: async () => [],
}))
