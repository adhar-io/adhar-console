import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore, type StoredDoc } from '@adhar-console/shell-ui'

/**
 * Multi-cloud catalog + workspace cloud configuration.
 *
 * The Adhar platform treats Kubernetes as the lingua-franca, so any
 * combination of supported clouds can host a single workspace. Concretely
 * this lets a customer keep production on GCP while using CIVO for
 * non-prod (cheap, fast spin-up), or run the entire estate on a single
 * cloud — the per-environment mapping captured here is the source of
 * truth that downstream Crossplane compositions read.
 *
 * The CATALOG below is static reference data. Connections and environment
 * mappings are REAL tenant configuration persisted in the Postgres document
 * store (`workspace.cloud-connection`, `workspace.cloud-mapping`) — there
 * are no fabricated "connected" clouds. A new connection is recorded as
 * `pending` until the platform actually verifies credentials; a missing
 * database surfaces as a `DocStoreError` the views must render.
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

/* ─────────── connections (docStore-backed) ─────────── */

export interface CloudConnection {
  id: string
  providerId: CloudProviderId
  /** Friendly label shown in pickers. */
  label: string
  /** Region scope of this connection. */
  region: string
  /** Account / project / subscription identifier. */
  accountId: string
  /**
   * `pending` = recorded config awaiting a real credential check by the
   * platform. The console never marks a connection `connected` on its own.
   */
  status: 'connected' | 'pending' | 'error' | 'paused'
  /** ISO timestamp of the last successful credential check — unset until one ran. */
  lastCheckedAt?: string
  /** Connection owner (the person or role responsible). */
  ownerEmail: string
  /** Cluster names provisioned via this connection (filled by the platform). */
  clusters: string[]
  /** Monthly spend reported by cost ingestion (USD); 0 until reported. */
  monthlySpend: number
}

type CloudConnectionData = Omit<CloudConnection, 'id'>

const CONN_KIND = 'workspace.cloud-connection'
const MAP_KIND = 'workspace.cloud-mapping'

function toConnection(doc: StoredDoc<CloudConnectionData>): CloudConnection {
  return {
    id: doc.id,
    ...doc.data,
    clusters: [...(doc.data.clusters ?? [])],
    monthlySpend: doc.data.monthlySpend ?? 0,
  }
}

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

/* ─────────── React Query layer (document-store persistence) ─────────── */

const KEY_CONNS = ['ws', 'cloud-connections'] as const
const KEY_MAPS = ['ws', 'cloud-mappings'] as const

export function useCloudConnections() {
  return useQuery<CloudConnection[]>({
    queryKey: KEY_CONNS,
    queryFn: async () => (await docStore.list<CloudConnectionData>(CONN_KIND)).map(toConnection),
  })
}

export function useCloudMappings() {
  return useQuery<EnvironmentMapping[]>({
    queryKey: KEY_MAPS,
    queryFn: async () => (await docStore.list<EnvironmentMapping>(MAP_KIND)).map((d) => d.data),
  })
}

/** Upserts the per-environment mapping (doc id = env name). */
export function useUpdateMapping() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: EnvironmentMapping) => {
      const doc = await docStore.put<EnvironmentMapping>(MAP_KIND, input.env, input)
      return doc.data
    },
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: KEY_MAPS })
      const prev = qc.getQueryData<EnvironmentMapping[]>(KEY_MAPS)
      if (prev) {
        const exists = prev.some((m) => m.env === next.env)
        qc.setQueryData<EnvironmentMapping[]>(
          KEY_MAPS,
          exists ? prev.map((m) => (m.env === next.env ? next : m)) : [...prev, next],
        )
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(KEY_MAPS, ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY_MAPS }),
  })
}

/**
 * Records a new connection as `pending` — the honest state until the
 * platform runs a real credential check against the account.
 */
export function useAddConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (
      input: Omit<CloudConnection, 'id' | 'lastCheckedAt' | 'clusters' | 'monthlySpend' | 'status'>,
    ) => {
      const doc = await docStore.create<CloudConnectionData>(CONN_KIND, {
        ...input,
        status: 'pending',
        clusters: [],
        monthlySpend: 0,
      })
      return toConnection(doc)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY_CONNS }),
  })
}

export function useRemoveConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(CONN_KIND, id),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY_CONNS }),
  })
}

/* ─────────── tone helpers (mirrors marketplace) ─────────── */

export const CLOUD_TONE_TILE: Record<CloudProvider['tone'], string> = {
  amber:
    'bg-linear-to-br from-amber-100 to-amber-50 text-amber-700 ring-amber-200 dark:from-amber-500/20 dark:to-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  sky: 'bg-linear-to-br from-sky-100 to-sky-50 text-sky-700 ring-sky-200 dark:from-sky-500/20 dark:to-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30',
  violet:
    'bg-linear-to-br from-violet-100 to-violet-50 text-violet-700 ring-violet-200 dark:from-violet-500/20 dark:to-violet-500/10 dark:text-violet-300 dark:ring-violet-500/30',
  emerald:
    'bg-linear-to-br from-emerald-100 to-emerald-50 text-emerald-700 ring-emerald-200 dark:from-emerald-500/20 dark:to-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  rose: 'bg-linear-to-br from-rose-100 to-rose-50 text-rose-700 ring-rose-200 dark:from-rose-500/20 dark:to-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
  slate: 'bg-linear-to-br from-slate-200 to-slate-100 text-slate-700 ring-slate-300',
}

export const CLOUD_TONE_CHIP: Record<CloudProvider['tone'], string> = {
  amber: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/30',
  emerald:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
  slate: 'bg-slate-100 text-slate-700 ring-slate-300',
}
