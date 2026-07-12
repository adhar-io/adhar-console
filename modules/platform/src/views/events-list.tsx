import { useMemo, useState } from 'react'
import {
  DataTable,
  EmptyState,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { useEvents } from '../data/hooks.ts'
import { age } from '../data/format.ts'
import { ListShell, StatusFilterPills, matchesSearch } from './list-shell.tsx'

const TYPE_KIND: Record<string, StatusKind> = {
  Normal: 'info',
  Warning: 'degraded',
}

type EventType = 'Normal' | 'Warning'

export function EventsView({ namespace }: { namespace?: string }) {
  const q = useEvents(namespace)
  const [search, setSearch] = useState('')
  const [type, setType] = useState<EventType | 'all'>('all')

  const all = q.data ?? []
  const counts = useMemo(() => {
    let normal = 0
    let warning = 0
    for (const e of all) {
      if (e.type === 'Warning') warning++
      else normal++
    }
    return { Normal: normal, Warning: warning }
  }, [all])

  const rows = useMemo(() => {
    return all
      .filter((e) => type === 'all' || e.type === type)
      .filter(
        (e) =>
          !search ||
          matchesSearch(e.reason, search) ||
          matchesSearch(e.message, search) ||
          matchesSearch(e.involvedObject?.name, search) ||
          matchesSearch(e.involvedObject?.kind, search) ||
          matchesSearch(e.involvedObject?.namespace, search),
      )
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.lastTimestamp ?? 0).getTime()
        const tb = new Date(b.lastTimestamp ?? 0).getTime()
        return tb - ta
      })
  }, [all, search, type])

  return (
    <ListShell
      title="Events"
      total={all.length}
      visible={rows.length}
      loading={q.isLoading}
      isFetching={q.isFetching}
      onRefresh={() => q.refetch()}
      lastUpdatedAt={q.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search reason, object, message…"
      caption="newest first · refresh 5s"
      filters={
        <StatusFilterPills<EventType>
          value={type}
          onChange={setType}
          pills={[
            { value: 'Warning', label: 'Warning', count: counts.Warning, tone: 'rose' },
            { value: 'Normal', label: 'Normal', count: counts.Normal, tone: 'sky' },
          ]}
        />
      }
    >
      <DataTable
        loading={q.isLoading}
        columns={[
          {
            key: 'type',
            header: 'Type',
            cell: (e) => (
              <StatusBadge kind={TYPE_KIND[e.type] ?? 'unknown'}>{e.type}</StatusBadge>
            ),
          },
          {
            key: 'reason',
            header: 'Reason',
            cell: (e) => <span className="font-medium text-content">{e.reason}</span>,
          },
          {
            key: 'object',
            header: 'Object',
            cell: (e) => {
              const obj = e.involvedObject ?? { kind: '', name: '', namespace: undefined }
              return (
                <div>
                  <div className="text-sm text-content">
                    <span className="font-mono text-[11px] text-content-muted">{obj.kind || '—'}</span>
                    {' / '}
                    {obj.name || '—'}
                  </div>
                  <div className="text-xs text-content-muted">{obj.namespace ?? '—'}</div>
                </div>
              )
            },
          },
          {
            key: 'message',
            header: 'Message',
            cell: (e) => (
              <span className="block max-w-xl truncate text-sm text-content" title={e.message}>
                {e.message}
              </span>
            ),
          },
          { key: 'last', header: 'Last seen', cell: (e) => age(e.lastTimestamp) },
          { key: 'count', header: 'Count', numeric: true, cell: (e) => e.count ?? 1 },
        ]}
        rows={rows}
        rowKey={(e) => `${e.metadata.namespace}/${e.metadata.name}`}
        empty={<EmptyState title="No events in this scope" />}
      />
    </ListShell>
  )
}
