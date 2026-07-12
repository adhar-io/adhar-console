import { useQuery } from '@tanstack/react-query'
import {
  DataTable,
  EmptyState,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { k8s } from '@adhar-console/api-clients'

const client = k8s.K8sClient.create({ baseUrl: '/kube-api' })

const WORKFLOWS_GVR: k8s.GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'workflows',
  namespaced: true,
}

interface Workflow {
  metadata: { name: string; namespace: string; creationTimestamp?: string; labels?: Record<string, string> }
  spec?: { entrypoint?: string }
  status?: {
    phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Error'
    message?: string
    startedAt?: string
    finishedAt?: string
    progress?: string
    nodes?: Record<string, { phase?: string; type?: string }>
  }
}

const PHASE_KIND: Record<string, StatusKind> = {
  Succeeded: 'healthy',
  Running: 'progressing',
  Pending: 'info',
  Failed: 'failed',
  Error: 'failed',
}

export function WorkflowList() {
  const q = useQuery({
    queryKey: ['argo-workflows', 'all'],
    queryFn: () => client.listGeneric(undefined, WORKFLOWS_GVR),
    refetchInterval: 10_000,
    retry: false,
  })

  const status = (q.error as { status?: number })?.status
  if (status === 404) {
    return (
      <EmptyState
        title="Argo Workflows not installed"
        description={
          <>
            No <code className="font-mono">argoproj.io/workflows</code> CRDs on this cluster.{' '}
            <a
              className="text-brand-700 underline"
              href="https://argo-workflows.readthedocs.io/en/stable/quick-start/"
              target="_blank"
              rel="noreferrer"
            >
              Install guide ↗
            </a>
          </>
        }
      />
    )
  }

  const rows = (q.data ?? []) as unknown as Workflow[]
  return (
    <DataTable
      loading={q.isLoading}
      columns={[
        {
          key: 'name',
          header: 'Workflow',
          cell: (w) => (
            <div>
              <div className="font-medium text-content">{w.metadata.name}</div>
              <div className="text-xs text-content-muted">{w.metadata.namespace}</div>
            </div>
          ),
        },
        {
          key: 'entry',
          header: 'Entrypoint',
          cell: (w) => (
            <code className="text-xs text-content-muted">{w.spec?.entrypoint ?? '—'}</code>
          ),
        },
        {
          key: 'status',
          header: 'Status',
          cell: (w) => {
            const phase = w.status?.phase
            return (
              <div title={w.status?.message}>
                <StatusBadge kind={phase ? (PHASE_KIND[phase] ?? 'unknown') : 'unknown'}>
                  {phase ?? '—'}
                </StatusBadge>
              </div>
            )
          },
        },
        {
          key: 'progress',
          header: 'Progress',
          numeric: true,
          cell: (w) => w.status?.progress ?? '—',
        },
        {
          key: 'duration',
          header: 'Duration',
          cell: (w) => {
            const startedAt = w.status?.startedAt
            if (!startedAt) return '—'
            const start = new Date(startedAt).getTime()
            const end = w.status?.finishedAt ? new Date(w.status.finishedAt).getTime() : Date.now()
            const secs = Math.max(0, Math.floor((end - start) / 1000))
            if (secs < 60) return `${secs}s`
            if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
            return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
          },
        },
        {
          key: 'started',
          header: 'Started',
          cell: (w) => (w.status?.startedAt ? ago(w.status.startedAt) : '—'),
        },
      ]}
      rows={rows}
      rowKey={(w) => `${w.metadata.namespace}/${w.metadata.name}`}
      empty={<EmptyState title="No workflows found" />}
    />
  )
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default WorkflowList
