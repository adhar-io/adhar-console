import { useMemo, useState } from 'react'
import { DataTable, EmptyState, StatusBadge, Tabs, type TabDef } from '@adhar-console/shell-ui'
import {
  usePersistentVolumeClaims,
  usePersistentVolumes,
  useStorageClasses,
} from '../data/hooks.ts'
import { age, formatBytes, parseQuantity } from '../data/format.ts'
import { ListShell, matchesSearch } from './list-shell.tsx'

type Sub = 'pvcs' | 'pvs' | 'scs'

const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'pvcs', label: 'PersistentVolumeClaims' },
  { id: 'pvs', label: 'PersistentVolumes' },
  { id: 'scs', label: 'StorageClasses' },
]

export function StorageView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Sub> tabs={SUB_TABS} defaultValue="pvcs" ariaLabel="Storage kind">
      {(active) => (
        <>
          {active === 'pvcs' && <PVCs namespace={namespace} />}
          {active === 'pvs' && <PVs />}
          {active === 'scs' && <SCs />}
        </>
      )}
    </Tabs>
  )
}

function PVCs({ namespace }: { namespace?: string }) {
  const q = usePersistentVolumeClaims(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (p) =>
          matchesSearch(p.metadata.name, search) || matchesSearch(p.metadata.namespace, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title="PersistentVolumeClaims"
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
          cell: (p) => (
            <div>
              <div className="font-medium text-content">{p.metadata.name}</div>
              <div className="text-xs text-content-muted">{p.metadata.namespace}</div>
            </div>
          ),
        },
        {
          key: 'status',
          header: 'Status',
          cell: (p) => {
            const phase = (p.status as { phase?: string })?.phase
            return (
              <StatusBadge
                kind={phase === 'Bound' ? 'healthy' : phase === 'Pending' ? 'progressing' : 'unknown'}
              >
                {phase ?? '—'}
              </StatusBadge>
            )
          },
        },
        {
          key: 'volume',
          header: 'Volume',
          cell: (p) => (p.spec as { volumeName?: string })?.volumeName ?? '—',
        },
        {
          key: 'capacity',
          header: 'Capacity',
          cell: (p) => {
            const req = (p.spec as { resources?: { requests?: Record<string, string> } })
              ?.resources?.requests?.storage
            return req ? formatBytes(parseQuantity(req)) : '—'
          },
        },
        {
          key: 'class',
          header: 'Class',
          cell: (p) => (p.spec as { storageClassName?: string })?.storageClassName ?? '—',
        },
        { key: 'age', header: 'Age', cell: (p) => age(p.metadata.creationTimestamp) },
      ]}
      rows={rows}
      rowKey={(p) => `${p.metadata.namespace}/${p.metadata.name}`}
      empty={<EmptyState title="No PVCs" />}
    />
    </ListShell>
  )
}

function PVs() {
  const q = usePersistentVolumes()
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(() => all.filter((p) => matchesSearch(p.metadata.name, search)), [all, search])
  return (
    <ListShell
      title="PersistentVolumes"
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
          cell: (p) => <span className="font-medium text-content">{p.metadata.name}</span>,
        },
        {
          key: 'capacity',
          header: 'Capacity',
          cell: (p) => {
            const cap = (p.spec as { capacity?: { storage?: string } })?.capacity?.storage
            return cap ? formatBytes(parseQuantity(cap)) : '—'
          },
        },
        {
          key: 'access',
          header: 'Access',
          cell: (p) => {
            const modes = (p.spec as { accessModes?: string[] })?.accessModes ?? []
            return (
              <code className="text-xs text-content-muted">
                {modes.map((m) => abbreviateAccess(m)).join(',')}
              </code>
            )
          },
        },
        {
          key: 'reclaim',
          header: 'Reclaim',
          cell: (p) => (p.spec as { persistentVolumeReclaimPolicy?: string })?.persistentVolumeReclaimPolicy ?? '—',
        },
        {
          key: 'status',
          header: 'Status',
          cell: (p) => {
            const phase = (p.status as { phase?: string })?.phase
            return (
              <StatusBadge
                kind={
                  phase === 'Bound'
                    ? 'healthy'
                    : phase === 'Available'
                      ? 'info'
                      : phase === 'Released'
                        ? 'paused'
                        : 'unknown'
                }
              >
                {phase ?? '—'}
              </StatusBadge>
            )
          },
        },
        {
          key: 'claim',
          header: 'Claim',
          cell: (p) => {
            const c = (p.spec as { claimRef?: { namespace?: string; name?: string } })?.claimRef
            return c ? <code className="text-xs">{c.namespace}/{c.name}</code> : '—'
          },
        },
        { key: 'age', header: 'Age', cell: (p) => age(p.metadata.creationTimestamp) },
      ]}
      rows={rows}
      rowKey={(p) => p.metadata.name}
      empty={<EmptyState title="No persistent volumes" />}
    />
    </ListShell>
  )
}

function SCs() {
  const q = useStorageClasses()
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(() => all.filter((s) => matchesSearch(s.metadata.name, search)), [all, search])
  return (
    <ListShell
      title="StorageClasses"
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
          cell: (s) => (
            <div className="flex items-center gap-2">
              <span className="font-medium text-content">{s.metadata.name}</span>
              {s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? (
                <StatusBadge kind="info">default</StatusBadge>
              ) : null}
            </div>
          ),
        },
        {
          key: 'provisioner',
          header: 'Provisioner',
          cell: (s) => (
            <code className="text-xs text-content-muted">
              {(s as unknown as { provisioner?: string }).provisioner ?? '—'}
            </code>
          ),
        },
        {
          key: 'reclaim',
          header: 'Reclaim',
          cell: (s) => (s as unknown as { reclaimPolicy?: string }).reclaimPolicy ?? '—',
        },
        {
          key: 'bindMode',
          header: 'Binding',
          cell: (s) => (s as unknown as { volumeBindingMode?: string }).volumeBindingMode ?? '—',
        },
        { key: 'age', header: 'Age', cell: (s) => age(s.metadata.creationTimestamp) },
      ]}
      rows={rows}
      rowKey={(s) => s.metadata.name}
      empty={<EmptyState title="No storage classes" />}
    />
    </ListShell>
  )
}

function abbreviateAccess(mode: string): string {
  return { ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[mode] ?? mode
}
