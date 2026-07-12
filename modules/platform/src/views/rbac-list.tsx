import { useMemo, useState } from 'react'
import { DataTable, EmptyState, Tabs, type TabDef } from '@adhar-console/shell-ui'
import {
  useClusterRoleBindings,
  useClusterRoles,
  useRoleBindings,
  useRoles,
  useServiceAccounts,
} from '../data/hooks.ts'
import { age } from '../data/format.ts'
import { ListShell, matchesSearch } from './list-shell.tsx'

type Sub = 'sa' | 'roles' | 'rolebindings' | 'clusterroles' | 'clusterrolebindings'

const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'sa', label: 'ServiceAccounts' },
  { id: 'roles', label: 'Roles' },
  { id: 'rolebindings', label: 'RoleBindings' },
  { id: 'clusterroles', label: 'ClusterRoles' },
  { id: 'clusterrolebindings', label: 'ClusterRoleBindings' },
]

export function RbacView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Sub> tabs={SUB_TABS} defaultValue="sa" ariaLabel="RBAC kind">
      {(active) => (
        <>
          {active === 'sa' && <ServiceAccountsTable namespace={namespace} />}
          {active === 'roles' && <RolesTable namespace={namespace} />}
          {active === 'rolebindings' && <RoleBindingsTable namespace={namespace} />}
          {active === 'clusterroles' && <ClusterRolesTable />}
          {active === 'clusterrolebindings' && <ClusterRoleBindingsTable />}
        </>
      )}
    </Tabs>
  )
}

function useFilter<T extends { metadata: { name: string; namespace?: string } }>(
  rows: T[],
  search: string,
) {
  return useMemo(
    () =>
      rows.filter(
        (r) =>
          matchesSearch(r.metadata.name, search) || matchesSearch(r.metadata.namespace, search),
      ),
    [rows, search],
  )
}

function ServiceAccountsTable({ namespace }: { namespace?: string }) {
  const q = useServiceAccounts(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useFilter(all, search)
  return (
    <ListShell
      title="ServiceAccounts"
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
              <div>
                <div className="font-medium text-content">{s.metadata.name}</div>
                <div className="text-xs text-content-muted">{s.metadata.namespace}</div>
              </div>
            ),
          },
          {
            key: 'secrets',
            header: 'Secrets',
            numeric: true,
            cell: (s) => (s as unknown as { secrets?: unknown[] }).secrets?.length ?? 0,
          },
          { key: 'age', header: 'Age', cell: (s) => age(s.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(s) => `${s.metadata.namespace}/${s.metadata.name}`}
        empty={<EmptyState title="No service accounts" />}
      />
    </ListShell>
  )
}

function RolesTable({ namespace }: { namespace?: string }) {
  const q = useRoles(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useFilter(all, search)
  return (
    <ListShell
      title="Roles"
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
            cell: (r) => (
              <div>
                <div className="font-medium text-content">{r.metadata.name}</div>
                <div className="text-xs text-content-muted">{r.metadata.namespace}</div>
              </div>
            ),
          },
          {
            key: 'rules',
            header: 'Rules',
            numeric: true,
            cell: (r) => (r as unknown as { rules?: unknown[] }).rules?.length ?? 0,
          },
          { key: 'age', header: 'Age', cell: (r) => age(r.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(r) => `${r.metadata.namespace}/${r.metadata.name}`}
        empty={<EmptyState title="No roles" />}
      />
    </ListShell>
  )
}

function RoleBindingsTable({ namespace }: { namespace?: string }) {
  const q = useRoleBindings(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useFilter(all, search)
  return (
    <ListShell
      title="RoleBindings"
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
            cell: (rb) => (
              <div>
                <div className="font-medium text-content">{rb.metadata.name}</div>
                <div className="text-xs text-content-muted">{rb.metadata.namespace}</div>
              </div>
            ),
          },
          {
            key: 'role',
            header: 'Role',
            cell: (rb) => {
              const r = (rb as unknown as { roleRef?: { kind?: string; name?: string } }).roleRef
              return (
                <code className="font-mono text-[11px] text-content-muted">
                  {r?.kind}/{r?.name}
                </code>
              )
            },
          },
          {
            key: 'subjects',
            header: 'Subjects',
            cell: (rb) => {
              const subjects =
                (rb as unknown as { subjects?: Array<{ kind: string; name: string }> }).subjects ?? []
              return (
                <div className="flex flex-col gap-0.5 font-mono text-[11px] text-content-muted">
                  {subjects.slice(0, 3).map((s, i) => (
                    <code key={i}>
                      {s.kind}/{s.name}
                    </code>
                  ))}
                  {subjects.length > 3 ? (
                    <span className="text-[10px] text-content-subtle">
                      +{subjects.length - 3} more
                    </span>
                  ) : null}
                </div>
              )
            },
          },
          { key: 'age', header: 'Age', cell: (rb) => age(rb.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(rb) => `${rb.metadata.namespace}/${rb.metadata.name}`}
        empty={<EmptyState title="No role bindings" />}
      />
    </ListShell>
  )
}

function ClusterRolesTable() {
  const q = useClusterRoles()
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useFilter(all, search)
  return (
    <ListShell
      title="ClusterRoles"
      total={all.length}
      visible={rows.length}
      loading={q.isLoading}
      isFetching={q.isFetching}
      onRefresh={() => q.refetch()}
      lastUpdatedAt={q.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
      caption="cluster-scoped"
    >
      <DataTable
        loading={q.isLoading}
        columns={[
          {
            key: 'name',
            header: 'Name',
            cell: (r) => <span className="font-medium text-content">{r.metadata.name}</span>,
          },
          {
            key: 'rules',
            header: 'Rules',
            numeric: true,
            cell: (r) => (r as unknown as { rules?: unknown[] }).rules?.length ?? 0,
          },
          { key: 'age', header: 'Age', cell: (r) => age(r.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(r) => r.metadata.name}
        empty={<EmptyState title="No cluster roles" />}
      />
    </ListShell>
  )
}

function ClusterRoleBindingsTable() {
  const q = useClusterRoleBindings()
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useFilter(all, search)
  return (
    <ListShell
      title="ClusterRoleBindings"
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
            cell: (rb) => <span className="font-medium text-content">{rb.metadata.name}</span>,
          },
          {
            key: 'role',
            header: 'Role',
            cell: (rb) => {
              const r = (rb as unknown as { roleRef?: { kind?: string; name?: string } }).roleRef
              return (
                <code className="font-mono text-[11px] text-content-muted">
                  {r?.kind}/{r?.name}
                </code>
              )
            },
          },
          {
            key: 'subjects',
            header: 'Subjects',
            numeric: true,
            cell: (rb) => (rb as unknown as { subjects?: unknown[] }).subjects?.length ?? 0,
          },
          { key: 'age', header: 'Age', cell: (rb) => age(rb.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(rb) => rb.metadata.name}
        empty={<EmptyState title="No cluster role bindings" />}
      />
    </ListShell>
  )
}
