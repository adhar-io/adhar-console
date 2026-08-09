import { useMemo, useState } from 'react'
import { DataTable, EmptyState, StatusBadge, Tabs, type TabDef } from '@adhar-console/shell-ui'
import type { k8s } from '@adhar-console/api-clients'
import {
  useEndpoints,
  useIngresses,
  useNetworkPolicies,
  useServices,
} from '../data/hooks.ts'
import { age } from '../data/format.ts'
import { DrawerSection, ResourceDrawer, Row } from './resource-drawer.tsx'
import { ListShell, matchesSearch } from './list-shell.tsx'

type Sub = 'services' | 'endpoints' | 'ingresses' | 'networkpolicies'

const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'services', label: 'Services' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'ingresses', label: 'Ingresses' },
  { id: 'networkpolicies', label: 'Network Policies' },
]

export function NetworkingView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Sub> tabs={SUB_TABS} defaultValue="services" ariaLabel="Networking kind">
      {(active) => (
        <>
          {active === 'services' && <ServicesTable namespace={namespace} />}
          {active === 'endpoints' && <EndpointsTable namespace={namespace} />}
          {active === 'ingresses' && <IngressesTable namespace={namespace} />}
          {active === 'networkpolicies' && <NetworkPoliciesTable namespace={namespace} />}
        </>
      )}
    </Tabs>
  )
}

function ServicesTable({ namespace }: { namespace?: string }) {
  const q = useServices(namespace)
  const [selected, setSelected] = useState<k8s.Service | null>(null)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (s) =>
          matchesSearch(s.metadata.name, search) ||
          matchesSearch(s.metadata.namespace, search) ||
          matchesSearch(s.spec?.type, search),
      ),
    [all, search],
  )

  return (
    <>
      <ListShell
        title="Services"
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching}
        onRefresh={() => q.refetch()}
        lastUpdatedAt={q.dataUpdatedAt}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search services…"
        caption={namespace ? `namespace ${namespace}` : 'all namespaces'}
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(s) => setSelected(s)}
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
                const type = s.spec?.type ?? 'ClusterIP'
                const tone =
                  type === 'LoadBalancer' ? 'info' : type === 'NodePort' ? 'progressing' : 'unknown'
                return (
                  <StatusBadge kind={tone as 'info' | 'progressing' | 'unknown'}>
                    {type}
                  </StatusBadge>
                )
              },
            },
            {
              key: 'clusterIp',
              header: 'ClusterIP',
              cell: (s) => <code className="font-mono text-[11px]">{s.spec?.clusterIP ?? '—'}</code>,
            },
            {
              key: 'ports',
              header: 'Ports',
              cell: (s) => {
                const ports = s.spec?.ports ?? []
                if (!ports.length) return <span className="text-content-subtle">—</span>
                return (
                  <div className="flex flex-wrap gap-1 font-mono text-[11px]">
                    {ports.map((p, i) => (
                      <span
                        key={i}
                        className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted"
                      >
                        {p.port}
                        {p.targetPort ? `→${p.targetPort}` : ''}/{p.protocol ?? 'TCP'}
                      </span>
                    ))}
                  </div>
                )
              },
            },
            {
              key: 'selector',
              header: 'Selector',
              cell: (s) => {
                const sel = s.spec?.selector
                if (!sel || Object.keys(sel).length === 0)
                  return <span className="text-content-subtle">—</span>
                return (
                  <code className="font-mono text-[11px] text-content-muted">
                    {Object.entries(sel)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(', ')}
                  </code>
                )
              },
            },
            { key: 'age', header: 'Age', cell: (s) => age(s.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(s) => `${s.metadata.namespace}/${s.metadata.name}`}
          empty={<EmptyState title="No services" />}
        />
      </ListShell>
      {selected ? <ServiceDrawer service={selected} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function ServiceDrawer({ service, onClose }: { service: k8s.Service; onClose(): void }) {
  const spec = service.spec as
    | {
        type?: string
        clusterIP?: string
        ports?: Array<{
          name?: string
          port: number
          targetPort?: number | string
          protocol?: string
          nodePort?: number
        }>
        selector?: Record<string, string>
        externalIPs?: string[]
        sessionAffinity?: string
      }
    | undefined
  const ports = spec?.ports ?? []
  return (
    <ResourceDrawer
      resource={
        {
          ...service,
          apiVersion: 'v1',
          kind: 'Service',
        } as k8s.Service & { apiVersion: string; kind: string }
      }
      kindLabel="Service"
      statusBadge={<StatusBadge kind="info">{spec?.type ?? 'ClusterIP'}</StatusBadge>}
      onClose={onClose}
    >
      <DrawerSection title="Spec">
        <div className="divide-y divide-edge-subtle text-sm">
          <Row label="Type" value={spec?.type ?? 'ClusterIP'} />
          <Row label="Cluster IP" value={spec?.clusterIP ?? '—'} mono />
          <Row label="Session affinity" value={spec?.sessionAffinity ?? 'None'} />
          <Row
            label="External IPs"
            value={spec?.externalIPs?.length ? spec.externalIPs.join(', ') : '—'}
            mono
          />
          <Row
            label="Selector"
            mono
            value={
              Object.entries(spec?.selector ?? {})
                .map(([k, v]) => `${k}=${v}`)
                .join(', ') || '—'
            }
          />
        </div>
      </DrawerSection>

      {ports.length ? (
        <DrawerSection
          title="Ports"
          actions={<span className="text-xs text-content-subtle">{ports.length}</span>}
        >
          <div className="overflow-hidden rounded-lg border border-edge-default">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-xs text-content-subtle">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-right font-medium">Port</th>
                  <th className="px-3 py-2 text-right font-medium">Target</th>
                  <th className="px-3 py-2 text-left font-medium">Protocol</th>
                  <th className="px-3 py-2 text-right font-medium">Node port</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle font-mono text-[12px]">
                {ports.map((p, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-content">{p.name ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-content">{p.port}</td>
                    <td className="px-3 py-2 text-right text-content">{p.targetPort ?? '—'}</td>
                    <td className="px-3 py-2 text-content-muted">{p.protocol ?? 'TCP'}</td>
                    <td className="px-3 py-2 text-right text-content-muted">{p.nodePort ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DrawerSection>
      ) : null}
    </ResourceDrawer>
  )
}

function IngressesTable({ namespace }: { namespace?: string }) {
  const q = useIngresses(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (i) =>
          matchesSearch(i.metadata.name, search) ||
          matchesSearch(i.metadata.namespace, search) ||
          matchesSearch(i.spec?.ingressClassName, search) ||
          (i.spec?.rules ?? []).some((r) => matchesSearch(r.host, search)),
      ),
    [all, search],
  )

  return (
    <ListShell
      title="Ingresses"
      total={all.length}
      visible={rows.length}
      loading={q.isLoading}
      isFetching={q.isFetching}
      onRefresh={() => q.refetch()}
      lastUpdatedAt={q.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search hosts, classes…"
    >
      <DataTable
        loading={q.isLoading}
        columns={[
          {
            key: 'name',
            header: 'Name',
            cell: (i) => (
              <div>
                <div className="font-medium text-content">{i.metadata.name}</div>
                <div className="text-xs text-content-muted">{i.metadata.namespace}</div>
              </div>
            ),
          },
          {
            key: 'class',
            header: 'Class',
            cell: (i) =>
              i.spec?.ingressClassName ? (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">
                  {i.spec.ingressClassName}
                </code>
              ) : (
                <span className="text-content-subtle">—</span>
              ),
          },
          {
            key: 'hosts',
            header: 'Hosts',
            cell: (i) => {
              const rules = i.spec?.rules ?? []
              if (!rules.length) return <span className="text-content-subtle">—</span>
              return (
                <div className="flex flex-col gap-0.5 text-xs">
                  {rules.map((r, idx) => (
                    <code key={idx} className="font-mono text-content-muted">
                      {r.host ?? '*'}
                    </code>
                  ))}
                </div>
              )
            },
          },
          {
            key: 'paths',
            header: 'Paths → Backend',
            cell: (i) => {
              const rules = i.spec?.rules ?? []
              const lines = rules.flatMap((r, ri) =>
                (r.http?.paths ?? []).map((p, pi) => {
                  const svc = p.backend?.service
                  const port = svc?.port?.number ?? svc?.port?.name ?? '—'
                  return (
                    <span key={`${ri}-${pi}`} className="text-content-muted">
                      {p.path ?? '/'} → {svc?.name ?? 'resource'}:{port}
                    </span>
                  )
                }),
              )
              if (!lines.length) return <span className="text-content-subtle">—</span>
              return <div className="flex flex-col gap-0.5 font-mono text-[11px]">{lines}</div>
            },
          },
          { key: 'age', header: 'Age', cell: (i) => age(i.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(i) => `${i.metadata.namespace}/${i.metadata.name}`}
        empty={<EmptyState title="No ingresses" />}
      />
    </ListShell>
  )
}

interface EndpointsObject {
  metadata: { name: string; namespace?: string; creationTimestamp?: string }
  subsets?: Array<{
    addresses?: Array<{ ip: string; nodeName?: string; targetRef?: { name?: string; kind?: string } }>
    notReadyAddresses?: Array<{ ip: string }>
    ports?: Array<{ name?: string; port: number; protocol?: string }>
  }>
}

function EndpointsTable({ namespace }: { namespace?: string }) {
  const q = useEndpoints(namespace)
  const [search, setSearch] = useState('')
  const all = (q.data ?? []) as unknown as EndpointsObject[]
  const rows = useMemo(
    () =>
      all.filter(
        (e) =>
          matchesSearch(e.metadata.name, search) || matchesSearch(e.metadata.namespace, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title="Endpoints"
      total={all.length}
      visible={rows.length}
      loading={q.isLoading}
      isFetching={q.isFetching}
      onRefresh={() => q.refetch()}
      lastUpdatedAt={q.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
      caption="addresses backing each Service"
    >
      <DataTable
        loading={q.isLoading}
        columns={[
          {
            key: 'name',
            header: 'Name',
            cell: (e) => (
              <div>
                <div className="font-medium text-content">{e.metadata.name}</div>
                <div className="text-xs text-content-muted">{e.metadata.namespace}</div>
              </div>
            ),
          },
          {
            key: 'addresses',
            header: 'Addresses',
            cell: (e) => {
              const addrs = (e.subsets ?? []).flatMap((s) => s.addresses ?? [])
              const not = (e.subsets ?? []).flatMap((s) => s.notReadyAddresses ?? [])
              return (
                <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                  {addrs.slice(0, 4).map((a, i) => (
                    <span key={i} className="text-content-muted">
                      {a.ip}
                      {a.nodeName ? ` · ${a.nodeName}` : ''}
                    </span>
                  ))}
                  {addrs.length > 4 ? (
                    <span className="text-[10px] text-content-subtle">+{addrs.length - 4} more</span>
                  ) : null}
                  {not.length ? (
                    <span className="text-[10px] text-amber-700 dark:text-amber-300">{not.length} not ready</span>
                  ) : null}
                </div>
              )
            },
          },
          {
            key: 'ports',
            header: 'Ports',
            cell: (e) => {
              const ports = (e.subsets ?? []).flatMap((s) => s.ports ?? [])
              if (!ports.length) return <span className="text-content-subtle">—</span>
              return (
                <div className="flex flex-wrap gap-1 font-mono text-[11px]">
                  {ports.map((p, i) => (
                    <span
                      key={i}
                      className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted"
                    >
                      {p.port}/{p.protocol ?? 'TCP'}
                      {p.name ? ` (${p.name})` : ''}
                    </span>
                  ))}
                </div>
              )
            },
          },
          {
            key: 'count',
            header: 'Ready',
            numeric: true,
            cell: (e) =>
              (e.subsets ?? []).reduce((s, x) => s + (x.addresses?.length ?? 0), 0),
          },
          { key: 'age', header: 'Age', cell: (e) => age(e.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(e) => `${e.metadata.namespace}/${e.metadata.name}`}
        empty={<EmptyState title="No endpoints" />}
      />
    </ListShell>
  )
}

interface NetworkPolicyObject {
  metadata: { name: string; namespace?: string; creationTimestamp?: string }
  spec?: {
    podSelector?: { matchLabels?: Record<string, string> }
    policyTypes?: string[]
    ingress?: unknown[]
    egress?: unknown[]
  }
}

function NetworkPoliciesTable({ namespace }: { namespace?: string }) {
  const q = useNetworkPolicies(namespace)
  const [search, setSearch] = useState('')
  const all = (q.data ?? []) as unknown as NetworkPolicyObject[]
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
      title="Network Policies"
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
            key: 'selector',
            header: 'Pod selector',
            cell: (p) => {
              const sel = p.spec?.podSelector?.matchLabels
              if (!sel || Object.keys(sel).length === 0)
                return <span className="text-content-subtle">all pods</span>
              return (
                <code className="font-mono text-[11px] text-content-muted">
                  {Object.entries(sel)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ')}
                </code>
              )
            },
          },
          {
            key: 'types',
            header: 'Types',
            cell: (p) => {
              const types = p.spec?.policyTypes ?? []
              if (!types.length) return <span className="text-content-subtle">—</span>
              return (
                <div className="flex gap-1">
                  {types.map((t) => (
                    <StatusBadge key={t} kind={t === 'Ingress' ? 'info' : 'progressing'}>
                      {t}
                    </StatusBadge>
                  ))}
                </div>
              )
            },
          },
          {
            key: 'rules',
            header: 'Rules',
            numeric: true,
            cell: (p) => (p.spec?.ingress?.length ?? 0) + (p.spec?.egress?.length ?? 0),
          },
          { key: 'age', header: 'Age', cell: (p) => age(p.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(p) => `${p.metadata.namespace}/${p.metadata.name}`}
        empty={<EmptyState title="No network policies" />}
      />
    </ListShell>
  )
}
