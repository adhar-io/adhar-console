import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Multi-cloud catalog + workspace cloud configuration.
 *
 * The Adhar platform treats Kubernetes as the lingua-franca, so any
 * combination of supported clouds can host a single workspace. Concretely
 * this lets a customer keep production on GCP while using CIVO for
 * non-prod (cheap, fast spin-up), or run the entire estate on a single
 * cloud — the per-environment mapping captured here is the source of
 * truth that downstream Crossplane compositions read.
 */

export type CloudProviderId = 'aws' | 'gcp' | 'azure' | 'civo' | 'digitalocean' | 'onprem'

export type CloudCategory = 'hyperscaler' | 'specialist' | 'self-hosted'

export interface CloudProvider {
  id: CloudProviderId
  name: string
  shortName: string
  category: CloudCategory
  /** Brand tone — drives the icon tile + chip styling. */
  tone: 'amber' | 'sky' | 'violet' | 'emerald' | 'rose' | 'slate'
  description: string
  /** Auth modality the connection uses. */
  auth:
    | 'aws-sts'
    | 'gcp-workload-identity'
    | 'azure-ad-federation'
    | 'civo-api-token'
    | 'do-api-token'
    | 'kubeconfig'
  /** Default regions to display in pickers. */
  regions: string[]
  /** Managed Kubernetes service name — informational. */
  k8sService: string
  /** Best-fit personas — used by the picker recommendation chip. */
  bestFor: ('production' | 'staging' | 'preview' | 'dev' | 'data' | 'edge' | 'air-gapped')[]
}

export const CLOUD_CATALOG: CloudProvider[] = [
  {
    id: 'aws',
    name: 'Amazon Web Services',
    shortName: 'AWS',
    category: 'hyperscaler',
    tone: 'amber',
    description: 'Broadest service catalog. Default home for production-grade workloads.',
    auth: 'aws-sts',
    regions: ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-south-1', 'ap-southeast-1'],
    k8sService: 'EKS',
    bestFor: ['production', 'staging', 'data'],
  },
  {
    id: 'gcp',
    name: 'Google Cloud',
    shortName: 'GCP',
    category: 'hyperscaler',
    tone: 'sky',
    description: 'Strong Kubernetes pedigree (GKE Autopilot), BigQuery, Vertex AI.',
    auth: 'gcp-workload-identity',
    regions: ['us-central1', 'us-east1', 'europe-west1', 'europe-west4', 'asia-south1', 'asia-southeast1'],
    k8sService: 'GKE',
    bestFor: ['production', 'staging', 'data'],
  },
  {
    id: 'azure',
    name: 'Microsoft Azure',
    shortName: 'Azure',
    category: 'hyperscaler',
    tone: 'violet',
    description: 'Enterprise-friendly compliance, AKS, Entra-native identity.',
    auth: 'azure-ad-federation',
    regions: ['eastus', 'westeurope', 'northeurope', 'centralindia', 'southeastasia', 'australiaeast'],
    k8sService: 'AKS',
    bestFor: ['production', 'staging'],
  },
  {
    id: 'civo',
    name: 'Civo',
    shortName: 'Civo',
    category: 'specialist',
    tone: 'emerald',
    description: 'Sub-2-minute K3s clusters at flat per-node pricing — ideal for non-prod.',
    auth: 'civo-api-token',
    regions: ['NYC1', 'LON1', 'FRA1', 'PHX1'],
    k8sService: 'Civo K3s',
    bestFor: ['preview', 'dev', 'staging'],
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    shortName: 'DO',
    category: 'specialist',
    tone: 'rose',
    description: 'Predictable pricing, simple managed K8s, great for SMB and side-projects.',
    auth: 'do-api-token',
    regions: ['nyc1', 'nyc3', 'ams3', 'fra1', 'sgp1', 'blr1'],
    k8sService: 'DOKS',
    bestFor: ['staging', 'preview', 'dev'],
  },
  {
    id: 'onprem',
    name: 'On-prem Kubernetes',
    shortName: 'On-prem',
    category: 'self-hosted',
    tone: 'slate',
    description: 'Bring-your-own cluster — vSphere, bare metal, OpenShift, Rancher, RKE2.',
    auth: 'kubeconfig',
    regions: ['—'],
    k8sService: 'kubeconfig',
    bestFor: ['production', 'air-gapped', 'edge'],
  },
]

export const CLOUD_BY_ID: Record<CloudProviderId, CloudProvider> = Object.fromEntries(
  CLOUD_CATALOG.map((c) => [c.id, c]),
) as Record<CloudProviderId, CloudProvider>

/* ─────────── connections ─────────── */

export interface CloudConnection {
  id: string
  providerId: CloudProviderId
  /** Friendly label shown in pickers. */
  label: string
  /** Region scope of this connection. */
  region: string
  /** Account / project / subscription identifier. */
  accountId: string
  status: 'connected' | 'pending' | 'error' | 'paused'
  /** ISO timestamp; bumped on every successful credential check. */
  lastCheckedAt: string
  /** Connection owner (the person or role responsible). */
  ownerEmail: string
  /** Cluster names provisioned via this connection. */
  clusters: string[]
  /** Estimated monthly spend on this connection (USD). */
  monthlySpend: number
}

const CONNECTIONS: CloudConnection[] = [
  {
    id: 'conn-aws-prod',
    providerId: 'aws',
    label: 'AWS · Production',
    region: 'us-east-1',
    accountId: '432198765432',
    status: 'connected',
    lastCheckedAt: new Date(Date.now() - 90_000).toISOString(),
    ownerEmail: 'priya@acme.com',
    clusters: ['prod-us-1', 'prod-eu-1'],
    monthlySpend: 14820,
  },
  {
    id: 'conn-gcp-data',
    providerId: 'gcp',
    label: 'GCP · Data plane',
    region: 'us-central1',
    accountId: 'acme-data-prod',
    status: 'connected',
    lastCheckedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    ownerEmail: 'mira@acme.com',
    clusters: ['data-us-1'],
    monthlySpend: 6840,
  },
  {
    id: 'conn-civo-nonprod',
    providerId: 'civo',
    label: 'Civo · Non-prod',
    region: 'LON1',
    accountId: 'acme-nonprod',
    status: 'connected',
    lastCheckedAt: new Date(Date.now() - 30_000).toISOString(),
    ownerEmail: 'jordan@acme.com',
    clusters: ['staging-eu-1', 'preview-eu-1'],
    monthlySpend: 980,
  },
  {
    id: 'conn-onprem-dr',
    providerId: 'onprem',
    label: 'Datacenter · DR',
    region: 'fra-dc-2',
    accountId: 'acme-dc',
    status: 'connected',
    lastCheckedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    ownerEmail: 'sam@acme.com',
    clusters: ['dr-fra-1'],
    monthlySpend: 0,
  },
  {
    id: 'conn-azure-pending',
    providerId: 'azure',
    label: 'Azure · Trial subscription',
    region: 'westeurope',
    accountId: 'sub-de1234ab-...',
    status: 'pending',
    lastCheckedAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
    ownerEmail: 'priya@acme.com',
    clusters: [],
    monthlySpend: 0,
  },
]

/* ─────────── environment / cloud mapping (dual-mode) ─────────── */

export type EnvKind = 'production' | 'staging' | 'preview' | 'dev'

export interface EnvironmentMapping {
  env: EnvKind
  /** Connection backing this environment. */
  connectionId: string
  /** Optional fallback connection used during incidents. */
  failoverConnectionId?: string
  /** Sized for typical workload — informational. */
  capacity: 'small' | 'medium' | 'large'
  /** Per-env feature flags. */
  flags: {
    /** Block manifests with `prod`-tagged secrets reaching this env. */
    blockProdSecrets: boolean
    /** Allow direct kubectl access (off in fully-locked-down prod). */
    directKubectl: boolean
  }
}

const MAPPINGS: EnvironmentMapping[] = [
  {
    env: 'production',
    connectionId: 'conn-aws-prod',
    failoverConnectionId: 'conn-onprem-dr',
    capacity: 'large',
    flags: { blockProdSecrets: false, directKubectl: false },
  },
  {
    env: 'staging',
    connectionId: 'conn-civo-nonprod',
    capacity: 'medium',
    flags: { blockProdSecrets: true, directKubectl: true },
  },
  {
    env: 'preview',
    connectionId: 'conn-civo-nonprod',
    capacity: 'small',
    flags: { blockProdSecrets: true, directKubectl: true },
  },
  {
    env: 'dev',
    connectionId: 'conn-civo-nonprod',
    capacity: 'small',
    flags: { blockProdSecrets: true, directKubectl: true },
  },
]

/* ─────────── React Query layer (faux BFF) ─────────── */

const KEY_CONNS = ['ws', 'cloud-connections'] as const
const KEY_MAPS = ['ws', 'cloud-mappings'] as const

let _conns = [...CONNECTIONS]
let _maps = [...MAPPINGS]

function delay<T>(value: T, ms = 90): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export function useCloudConnections() {
  return useQuery<CloudConnection[]>({
    queryKey: KEY_CONNS,
    queryFn: () => delay(_conns),
    staleTime: 60_000,
  })
}

export function useCloudMappings() {
  return useQuery<EnvironmentMapping[]>({
    queryKey: KEY_MAPS,
    queryFn: () => delay(_maps),
    staleTime: 60_000,
  })
}

export function useUpdateMapping() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: EnvironmentMapping) => {
      _maps = _maps.map((m) => (m.env === input.env ? input : m))
      return delay(input, 140)
    },
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: KEY_MAPS })
      const prev = qc.getQueryData<EnvironmentMapping[]>(KEY_MAPS) ?? _maps
      qc.setQueryData<EnvironmentMapping[]>(
        KEY_MAPS,
        prev.map((m) => (m.env === next.env ? next : m)),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(KEY_MAPS, ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY_MAPS }),
  })
}

export function useAddConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<CloudConnection, 'id' | 'lastCheckedAt' | 'clusters' | 'monthlySpend'>) => {
      const conn: CloudConnection = {
        ...input,
        id: `conn-${input.providerId}-${Math.random().toString(36).slice(2, 7)}`,
        lastCheckedAt: new Date().toISOString(),
        clusters: [],
        monthlySpend: 0,
      }
      _conns = [..._conns, conn]
      return delay(conn)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY_CONNS }),
  })
}

/* ─────────── tone helpers (mirrors marketplace) ─────────── */

export const CLOUD_TONE_TILE: Record<CloudProvider['tone'], string> = {
  amber: 'bg-linear-to-br from-amber-100 to-amber-50 text-amber-700 ring-amber-200',
  sky: 'bg-linear-to-br from-sky-100 to-sky-50 text-sky-700 ring-sky-200',
  violet: 'bg-linear-to-br from-violet-100 to-violet-50 text-violet-700 ring-violet-200',
  emerald: 'bg-linear-to-br from-emerald-100 to-emerald-50 text-emerald-700 ring-emerald-200',
  rose: 'bg-linear-to-br from-rose-100 to-rose-50 text-rose-700 ring-rose-200',
  slate: 'bg-linear-to-br from-slate-200 to-slate-100 text-slate-700 ring-slate-300',
}

export const CLOUD_TONE_CHIP: Record<CloudProvider['tone'], string> = {
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200',
  slate: 'bg-slate-100 text-slate-700 ring-slate-300',
}
