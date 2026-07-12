import { useMemo, useState } from 'react'
import {
  DataTable,
  EmptyState,
  StatusBadge,
  Tabs,
  type TabDef,
} from '@adhar-console/shell-ui'
import { useConfigMaps, useSecrets } from '../data/hooks.ts'
import { age } from '../data/format.ts'
import { ListShell, matchesSearch } from './list-shell.tsx'

type Sub = 'configmaps' | 'secrets'

const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'configmaps', label: 'ConfigMaps' },
  { id: 'secrets', label: 'Secrets' },
]

export function ConfigView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Sub> tabs={SUB_TABS} defaultValue="configmaps" ariaLabel="Config & secrets">
      {(active) => (
        <>
          {active === 'configmaps' && <ConfigMapsTable namespace={namespace} />}
          {active === 'secrets' && <SecretsTable namespace={namespace} />}
        </>
      )}
    </Tabs>
  )
}

function ConfigMapsTable({ namespace }: { namespace?: string }) {
  const q = useConfigMaps(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (c) =>
          matchesSearch(c.metadata.name, search) || matchesSearch(c.metadata.namespace, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title="ConfigMaps"
      total={all.length}
      visible={rows.length}
      loading={q.isLoading}
      isFetching={q.isFetching}
      onRefresh={() => q.refetch()}
      lastUpdatedAt={q.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
    >
    <DataTable
      loading={q.isLoading}
      columns={[
        {
          key: 'name',
          header: 'Name',
          cell: (c) => (
            <div>
              <div className="font-medium text-content">{c.metadata.name}</div>
              <div className="text-xs text-content-muted">{c.metadata.namespace}</div>
            </div>
          ),
        },
        {
          key: 'keys',
          header: 'Keys',
          numeric: true,
          cell: (c) => Object.keys((c as unknown as { data?: object }).data ?? {}).length,
        },
        {
          key: 'preview',
          header: 'Preview',
          cell: (c) => {
            const data = ((c as unknown as { data?: Record<string, string> }).data ?? {})
            const keys = Object.keys(data)
            if (!keys.length) return <span className="text-content-subtle">empty</span>
            return (
              <div className="flex flex-wrap gap-1">
                {keys.slice(0, 4).map((k) => (
                  <code
                    key={k}
                    className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted"
                  >
                    {k}
                  </code>
                ))}
                {keys.length > 4 ? (
                  <span className="text-[11px] text-content-subtle">+{keys.length - 4}</span>
                ) : null}
              </div>
            )
          },
        },
        { key: 'age', header: 'Age', cell: (c) => age(c.metadata.creationTimestamp) },
      ]}
      rows={rows}
      rowKey={(c) => `${c.metadata.namespace}/${c.metadata.name}`}
      empty={<EmptyState title="No ConfigMaps" />}
    />
    </ListShell>
  )
}

function SecretsTable({ namespace }: { namespace?: string }) {
  const q = useSecrets(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (s) =>
          matchesSearch(s.metadata.name, search) ||
          matchesSearch(s.metadata.namespace, search) ||
          matchesSearch((s as unknown as { type?: string }).type, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title="Secrets"
      total={all.length}
      visible={rows.length}
      loading={q.isLoading}
      isFetching={q.isFetching}
      onRefresh={() => q.refetch()}
      lastUpdatedAt={q.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
      caption="values always redacted"
    >
    <DataTable
      loading={q.isLoading}
      columns={[
        {
          key: 'name',
          header: 'Name',
          cell: (s) => (
            <div>
              <div className="font-medium text-content">{s.metadata.name}</div>
              <div className="text-xs text-content-muted">{s.metadata.namespace}</div>
            </div>
          ),
        },
        {
          key: 'type',
          header: 'Type',
          cell: (s) => {
            const t = (s as unknown as { type?: string }).type ?? 'Opaque'
            const kind = t === 'Opaque' ? 'info' : t.startsWith('kubernetes.io/') ? 'progressing' : 'info'
            return <StatusBadge kind={kind}>{t}</StatusBadge>
          },
        },
        {
          key: 'keys',
          header: 'Keys',
          numeric: true,
          cell: (s) => Object.keys((s as unknown as { data?: object }).data ?? {}).length,
        },
        {
          key: 'preview',
          header: 'Preview',
          cell: (s) => {
            const data = (s as unknown as { data?: Record<string, string> }).data ?? {}
            const keys = Object.keys(data)
            if (!keys.length) return <span className="text-content-subtle">empty</span>
            return (
              <div className="flex flex-wrap gap-1">
                {keys.slice(0, 4).map((k) => (
                  <code
                    key={k}
                    title={`${k} (value redacted)`}
                    className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted"
                  >
                    {k}
                  </code>
                ))}
                {keys.length > 4 ? (
                  <span className="text-[11px] text-content-subtle">+{keys.length - 4}</span>
                ) : null}
              </div>
            )
          },
        },
        { key: 'age', header: 'Age', cell: (s) => age(s.metadata.creationTimestamp) },
      ]}
      rows={rows}
      rowKey={(s) => `${s.metadata.namespace}/${s.metadata.name}`}
      empty={
        <EmptyState
          title="No Secrets"
          description="Values are always redacted — only metadata is shown here."
        />
      }
    />
    </ListShell>
  )
}
