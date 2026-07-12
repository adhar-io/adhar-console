import { useMemo, useState } from 'react'
import {
  DataTable,
  EmptyState,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { usePods } from '../data/hooks.ts'
import { age, shortImage } from '../data/format.ts'
import { PodDrawer } from './pod-drawer.tsx'
import { ListShell, StatusFilterPills, matchesSearch } from './list-shell.tsx'

const PHASE_KIND: Record<string, StatusKind> = {
  Running: 'healthy',
  Pending: 'progressing',
  Succeeded: 'info',
  Failed: 'failed',
  Unknown: 'unknown',
}

type Phase = 'Running' | 'Pending' | 'Succeeded' | 'Failed' | 'Unknown'

export function PodsView({ namespace }: { namespace?: string }) {
  const q = usePods(namespace)
  const [selected, setSelected] = useState<{ ns: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [phase, setPhase] = useState<Phase | 'all'>('all')

  const all = q.data ?? []

  const counts = useMemo(() => {
    const c: Record<Phase, number> = { Running: 0, Pending: 0, Succeeded: 0, Failed: 0, Unknown: 0 }
    for (const p of all) {
      const ph = (p.status?.phase as Phase | undefined) ?? 'Unknown'
      if (ph in c) c[ph]++
      else c.Unknown++
    }
    return c
  }, [all])

  const rows = useMemo(() => {
    return all.filter((p) => {
      const matchesPhase = phase === 'all' || (p.status?.phase ?? 'Unknown') === phase
      if (!matchesPhase) return false
      if (!search) return true
      return (
        matchesSearch(p.metadata.name, search) ||
        matchesSearch(p.metadata.namespace, search) ||
        matchesSearch(p.spec?.nodeName, search) ||
        matchesSearch(p.spec?.containers?.[0]?.image, search)
      )
    })
  }, [all, phase, search])

  return (
    <>
      <ListShell
        title="Pods"
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching}
        onRefresh={() => q.refetch()}
        lastUpdatedAt={q.dataUpdatedAt}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search pods, namespaces, nodes…"
        caption={namespace ? `namespace ${namespace}` : 'all namespaces'}
        filters={
          <StatusFilterPills<Phase>
            value={phase}
            onChange={setPhase}
            pills={[
              { value: 'Running', label: 'Running', count: counts.Running, tone: 'emerald' },
              { value: 'Pending', label: 'Pending', count: counts.Pending, tone: 'amber' },
              { value: 'Failed', label: 'Failed', count: counts.Failed, tone: 'rose' },
              { value: 'Succeeded', label: 'Succeeded', count: counts.Succeeded, tone: 'sky' },
              { value: 'Unknown', label: 'Unknown', count: counts.Unknown, tone: 'slate' },
            ]}
          />
        }
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(p) =>
            setSelected({ ns: p.metadata.namespace ?? '', name: p.metadata.name })
          }
          columns={[
            {
              key: 'name',
              header: 'Pod',
              cell: (p) => (
                <div>
                  <div className="font-medium text-content">{p.metadata.name}</div>
                  <div className="text-xs text-content-muted">{p.metadata.namespace}</div>
                </div>
              ),
            },
            {
              key: 'ready',
              header: 'Ready',
              numeric: true,
              cell: (p) => {
                const cs = p.status?.containerStatuses ?? []
                const total = cs.length || p.spec?.containers?.length || 0
                const ready = cs.filter((c) => c.ready).length
                return (
                  <span
                    className={cn(
                      'font-mono tabular-nums',
                      total > 0 && ready < total && 'text-amber-700',
                    )}
                  >
                    {ready}/{total}
                  </span>
                )
              },
            },
            {
              key: 'restarts',
              header: 'Restarts',
              numeric: true,
              cell: (p) => {
                const r = (p.status?.containerStatuses ?? []).reduce(
                  (a, c) => a + (c.restartCount ?? 0),
                  0,
                )
                return (
                  <span className={cn('font-mono tabular-nums', r > 0 && 'text-amber-700')}>
                    {r}
                  </span>
                )
              },
            },
            {
              key: 'phase',
              header: 'Phase',
              cell: (p) => {
                const ph = p.status?.phase
                return (
                  <StatusBadge kind={ph ? (PHASE_KIND[ph] ?? 'unknown') : 'unknown'}>
                    {ph ?? '—'}
                  </StatusBadge>
                )
              },
            },
            { key: 'node', header: 'Node', cell: (p) => p.spec?.nodeName ?? '—' },
            {
              key: 'ip',
              header: 'IP',
              cell: (p) => (
                <code className="font-mono text-[11px] text-content-muted">
                  {p.status?.podIP ?? '—'}
                </code>
              ),
            },
            {
              key: 'image',
              header: 'Image',
              cell: (p) => (
                <code className="text-xs text-content-muted">
                  {shortImage(p.spec?.containers?.[0]?.image)}
                </code>
              ),
            },
            { key: 'age', header: 'Age', cell: (p) => age(p.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(p) => `${p.metadata.namespace}/${p.metadata.name}`}
          empty={
            <EmptyState
              title="No pods"
              description={
                search || phase !== 'all'
                  ? 'No pods match the active filters.'
                  : namespace
                    ? `Namespace "${namespace}" has no pods.`
                    : 'The cluster has no running pods.'
              }
            />
          }
        />
      </ListShell>
      {selected ? (
        <PodDrawer
          namespace={selected.ns}
          name={selected.name}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  )
}
