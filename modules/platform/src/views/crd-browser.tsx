import { useState } from 'react'
import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { useGeneric } from '../data/hooks.ts'
import { age } from '../data/format.ts'

interface Props {
  namespace?: string
}

/**
 * Curated shortcut list of CRDs commonly deployed alongside Adhar (ArgoCD,
 * Kargo, Crossplane, Kyverno, Argo Workflows/Rollouts). The real cluster may
 * or may not have these installed — tables render empty gracefully.
 */
const CRD_KINDS = [
  {
    id: 'argocd-apps',
    label: 'ArgoCD Applications',
    gvr: { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications', namespaced: true },
  },
  {
    id: 'kargo-stages',
    label: 'Kargo Stages',
    gvr: { group: 'kargo.akuity.io', version: 'v1alpha1', resource: 'stages', namespaced: true },
  },
  {
    id: 'crossplane-compositions',
    label: 'Crossplane Compositions',
    gvr: { group: 'apiextensions.crossplane.io', version: 'v1', resource: 'compositions', namespaced: false },
  },
  {
    id: 'kyverno-policies',
    label: 'Kyverno ClusterPolicies',
    gvr: { group: 'kyverno.io', version: 'v1', resource: 'clusterpolicies', namespaced: false },
  },
  {
    id: 'argo-workflows',
    label: 'Argo Workflows',
    gvr: { group: 'argoproj.io', version: 'v1alpha1', resource: 'workflows', namespaced: true },
  },
  {
    id: 'argo-rollouts',
    label: 'Argo Rollouts',
    gvr: { group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts', namespaced: true },
  },
] as const

export function CrdBrowser({ namespace }: Props) {
  const [selected, setSelected] = useState<(typeof CRD_KINDS)[number]['id']>('argocd-apps')
  const kind = CRD_KINDS.find((k) => k.id === selected)!
  const q = useGeneric(kind.gvr, kind.gvr.namespaced ? namespace : undefined)

  const is404 = q.isError && (q.error as { status?: number })?.status === 404

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
      <aside className="space-y-1">
        <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Operator CRDs
        </div>
        {CRD_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => setSelected(k.id)}
            className={cn(
              'block w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
              selected === k.id
                ? 'bg-brand-50 dark:bg-brand-500/10 font-medium text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200 dark:ring-brand-500/25'
                : 'text-content-muted hover:bg-surface-sunken hover:text-content',
            )}
          >
            {k.label}
          </button>
        ))}
      </aside>
      <div className="min-w-0">
        <div className="mb-3 flex items-center justify-between text-xs text-content-muted">
          <code className="rounded bg-surface-sunken px-2 py-1 font-mono">
            {kind.gvr.group}/{kind.gvr.version}/{kind.gvr.resource}
          </code>
          {kind.gvr.namespaced ? <span>Namespaced</span> : <span>Cluster-scoped</span>}
        </div>
        {is404 ? (
          <EmptyState
            title={`${kind.label} is not installed`}
            description="The CRD group isn't registered on this cluster. Install the operator and this list populates automatically."
          />
        ) : q.isError ? (
          <EmptyState title="Couldn't list" description={(q.error as Error).message} />
        ) : (
          <DataTable
            loading={q.isLoading}
            columns={[
              {
                key: 'name',
                header: 'Name',
                cell: (o) => <span className="font-medium text-content">{o.metadata.name}</span>,
              },
              {
                key: 'ns',
                header: 'Namespace',
                cell: (o) => o.metadata.namespace ?? <span className="text-content-subtle">—</span>,
              },
              { key: 'kind', header: 'Kind', cell: (o) => o.kind },
              {
                key: 'status',
                header: 'Status',
                cell: (o) => {
                  const s = (o.status ?? {}) as Record<string, unknown>
                  const health =
                    typeof s.health === 'object' && s.health && 'status' in s.health
                      ? String((s.health as { status: string }).status)
                      : typeof s.phase === 'string'
                        ? s.phase
                        : '—'
                  const kind = ['Healthy', 'Succeeded', 'Steady', 'Active'].includes(health)
                    ? 'healthy'
                    : ['Failed', 'Error'].includes(health)
                      ? 'failed'
                      : 'info'
                  return (
                    <StatusBadge kind={kind as 'healthy' | 'failed' | 'info'}>
                      {health}
                    </StatusBadge>
                  )
                },
              },
              { key: 'age', header: 'Age', cell: (o) => age(o.metadata.creationTimestamp) },
            ]}
            rows={q.data ?? []}
            rowKey={(o) => `${o.metadata.namespace ?? '-'}/${o.metadata.name}`}
            empty={<EmptyState title={`No ${kind.label} found`} />}
          />
        )}
      </div>
    </div>
  )
}

export default CrdBrowser
