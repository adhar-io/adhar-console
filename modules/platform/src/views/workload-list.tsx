import { useMemo, useState } from 'react'
import { DataTable, EmptyState, StatusBadge, Tabs, type TabDef } from '@adhar-console/shell-ui'
import {
  useCronJobs,
  useDaemonSets,
  useDeployments,
  useHorizontalPodAutoscalers,
  useJobs,
  useReplicaSets,
  useStatefulSets,
} from '../data/hooks.ts'
import { age, shortImage } from '../data/format.ts'
import type { k8s } from '@adhar-console/api-clients'
import { DrawerSection, DrawerStatusTile, ResourceDrawer, Row } from './resource-drawer.tsx'
import { ListShell, matchesSearch } from './list-shell.tsx'
import { WorkloadOpsForKind } from './workload-ops.tsx'

type Sub = 'deployments' | 'replicasets' | 'statefulsets' | 'daemonsets' | 'jobs' | 'cronjobs' | 'hpa'

const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'deployments', label: 'Deployments' },
  { id: 'replicasets', label: 'ReplicaSets' },
  { id: 'statefulsets', label: 'StatefulSets' },
  { id: 'daemonsets', label: 'DaemonSets' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'cronjobs', label: 'CronJobs' },
  { id: 'hpa', label: 'HPAs' },
]

export function WorkloadView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Sub> tabs={SUB_TABS} defaultValue="deployments" ariaLabel="Workload kind">
      {(active) => (
        <>
          {active === 'deployments' && <DeploymentTable namespace={namespace} />}
          {active === 'replicasets' && <ReplicaSetTable namespace={namespace} />}
          {active === 'statefulsets' && <StatefulSetTable namespace={namespace} />}
          {active === 'daemonsets' && <DaemonSetTable namespace={namespace} />}
          {active === 'jobs' && <JobTable namespace={namespace} />}
          {active === 'cronjobs' && <CronJobTable namespace={namespace} />}
          {active === 'hpa' && <HpaTable namespace={namespace} />}
        </>
      )}
    </Tabs>
  )
}

function DeploymentTable({ namespace }: { namespace?: string }) {
  const q = useDeployments(namespace)
  const [selected, setSelected] = useState<k8s.Deployment | null>(null)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (d) =>
          matchesSearch(d.metadata.name, search) || matchesSearch(d.metadata.namespace, search),
      ),
    [all, search],
  )

  return (
    <>
      <ListShell
        title="Deployments"
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching}
        onRefresh={() => q.refetch()}
        lastUpdatedAt={q.dataUpdatedAt}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search deployments…"
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(d) => setSelected(d)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (d) => (
                <div>
                  <div className="font-medium text-content">{d.metadata.name}</div>
                  <div className="text-xs text-content-muted">{d.metadata.namespace}</div>
                </div>
              ),
            },
            {
              key: 'ready',
              header: 'Ready',
              numeric: true,
              cell: (d) => `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 0}`,
            },
            {
              key: 'updated',
              header: 'Up-to-date',
              numeric: true,
              cell: (d) => d.status?.updatedReplicas ?? 0,
            },
            {
              key: 'available',
              header: 'Available',
              numeric: true,
              cell: (d) => d.status?.availableReplicas ?? 0,
            },
            { key: 'strategy', header: 'Strategy', cell: (d) => d.spec?.strategy?.type ?? '—' },
            {
              key: 'status',
              header: 'Status',
              cell: (d) => {
                const desired = d.spec?.replicas ?? 0
                const ready = d.status?.readyReplicas ?? 0
                if (desired === 0) return <StatusBadge kind="paused">Scaled 0</StatusBadge>
                if (ready >= desired) return <StatusBadge kind="healthy">Healthy</StatusBadge>
                return <StatusBadge kind="progressing">Rolling</StatusBadge>
              },
            },
            { key: 'age', header: 'Age', cell: (d) => age(d.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(d) => `${d.metadata.namespace}/${d.metadata.name}`}
          empty={<EmptyState title="No deployments" />}
        />
      </ListShell>
      {selected ? (
        <DeploymentDrawer deployment={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  )
}

function DeploymentDrawer({
  deployment,
  onClose,
}: {
  deployment: k8s.Deployment
  onClose(): void
}) {
  const spec = deployment.spec
  const status = deployment.status as
    | {
        replicas?: number
        readyReplicas?: number
        updatedReplicas?: number
        availableReplicas?: number
        conditions?: Array<{
          type: string
          status: string
          reason?: string
          message?: string
          lastTransitionTime?: string
        }>
      }
    | undefined

  const desired = spec?.replicas ?? 0
  const ready = status?.readyReplicas ?? 0
  const available = status?.availableReplicas ?? 0
  const updated = status?.updatedReplicas ?? 0

  const healthKind = desired === 0 ? 'paused' : ready >= desired ? 'healthy' : 'progressing'
  const healthLabel = desired === 0 ? 'Scaled 0' : ready >= desired ? 'Healthy' : 'Rolling'

  const containers = (spec as
    | {
        template?: {
          spec?: {
            containers?: Array<{
              name: string
              image: string
              resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
            }>
          }
        }
      }
    | undefined)
    ?.template?.spec?.containers ?? []

  return (
    <ResourceDrawer
      resource={
        {
          ...deployment,
          apiVersion: 'apps/v1',
          kind: 'Deployment',
        } as k8s.Deployment & { apiVersion: string; kind: string }
      }
      kindLabel="Deployment"
      statusBadge={<StatusBadge kind={healthKind}>{healthLabel}</StatusBadge>}
      onClose={onClose}
    >
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <DrawerStatusTile label="Desired" kind="info" value={String(desired)} />
        <DrawerStatusTile
          label="Ready"
          kind={ready >= desired && desired > 0 ? 'healthy' : 'progressing'}
          value={String(ready)}
        />
        <DrawerStatusTile
          label="Available"
          kind={available >= desired && desired > 0 ? 'healthy' : 'progressing'}
          value={String(available)}
        />
        <DrawerStatusTile label="Up-to-date" kind="info" value={String(updated)} />
      </section>

      <WorkloadOpsForKind
        namespace={deployment.metadata.namespace ?? 'default'}
        kind="Deployment"
        name={deployment.metadata.name}
        showStatus={false}
      />

      <DrawerSection title="Spec">
        <div className="divide-y divide-edge-subtle text-sm">
          <Row label="Replicas" value={String(desired)} />
          <Row label="Strategy" value={(spec?.strategy as { type?: string } | undefined)?.type ?? '—'} />
          <Row
            label="Selector"
            mono
            value={
              Object.entries(
                (spec?.selector as { matchLabels?: Record<string, string> } | undefined)
                  ?.matchLabels ?? {},
              )
                .map(([k, v]) => `${k}=${v}`)
                .join(', ') || '—'
            }
          />
        </div>
      </DrawerSection>

      {containers.length ? (
        <DrawerSection
          title="Containers"
          actions={<span className="text-xs text-content-subtle">{containers.length}</span>}
        >
          <ul className="divide-y divide-edge-subtle">
            {containers.map((c, i) => (
              <li key={i} className="space-y-1 px-1 py-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-content">{c.name}</div>
                    <code className="text-[11px] text-content-muted">{shortImage(c.image)}</code>
                  </div>
                  {c.resources?.requests || c.resources?.limits ? (
                    <div className="shrink-0 text-right text-[11px] text-content-muted">
                      {c.resources?.requests ? (
                        <div>
                          req cpu {c.resources.requests.cpu ?? '—'} · mem{' '}
                          {c.resources.requests.memory ?? '—'}
                        </div>
                      ) : null}
                      {c.resources?.limits ? (
                        <div>
                          lim cpu {c.resources.limits.cpu ?? '—'} · mem{' '}
                          {c.resources.limits.memory ?? '—'}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </DrawerSection>
      ) : null}

      {status?.conditions?.length ? (
        <DrawerSection title="Conditions">
          <ul className="divide-y divide-edge-subtle">
            {status.conditions.map((c) => (
              <li key={c.type} className="flex items-start gap-3 px-1 py-2 text-sm">
                <StatusBadge
                  kind={
                    c.status === 'True' && (c.type === 'Available' || c.type === 'Progressing')
                      ? 'healthy'
                      : c.status === 'False'
                        ? 'degraded'
                        : 'info'
                  }
                >
                  {c.type}
                </StatusBadge>
                <div className="min-w-0 flex-1">
                  <div className="text-content">{c.reason ?? c.status}</div>
                  {c.message ? (
                    <div className="mt-0.5 text-xs text-content-muted">{c.message}</div>
                  ) : null}
                  {c.lastTransitionTime ? (
                    <div className="mt-0.5 text-[11px] text-content-subtle">
                      transitioned {age(c.lastTransitionTime)} ago
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </DrawerSection>
      ) : null}
    </ResourceDrawer>
  )
}

interface ReplicaSetObject {
  metadata: { name: string; namespace?: string; creationTimestamp?: string; ownerReferences?: Array<{ kind?: string; name?: string }> }
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } }
  status?: { replicas?: number; readyReplicas?: number; availableReplicas?: number }
}

function ReplicaSetTable({ namespace }: { namespace?: string }) {
  const q = useReplicaSets(namespace)
  const [search, setSearch] = useState('')
  const all = (q.data ?? []) as unknown as ReplicaSetObject[]
  const rows = useMemo(
    () =>
      all.filter(
        (r) =>
          matchesSearch(r.metadata.name, search) || matchesSearch(r.metadata.namespace, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title="ReplicaSets"
      total={all.length}
      visible={rows.length}
      loading={q.isLoading}
      isFetching={q.isFetching}
      onRefresh={() => q.refetch()}
      lastUpdatedAt={q.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
      caption="owner: Deployment"
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
            key: 'owner',
            header: 'Owner',
            cell: (r) => {
              const owner = r.metadata.ownerReferences?.[0]
              return owner ? (
                <code className="font-mono text-[11px] text-content-muted">
                  {owner.kind}/{owner.name}
                </code>
              ) : (
                <span className="text-content-subtle">—</span>
              )
            },
          },
          {
            key: 'desired',
            header: 'Desired',
            numeric: true,
            cell: (r) => r.spec?.replicas ?? 0,
          },
          {
            key: 'ready',
            header: 'Ready',
            numeric: true,
            cell: (r) => `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0}`,
          },
          {
            key: 'image',
            header: 'Image',
            cell: (r) => (
              <code className="text-xs text-content-muted">
                {shortImage(r.spec?.template?.spec?.containers?.[0]?.image)}
              </code>
            ),
          },
          { key: 'age', header: 'Age', cell: (r) => age(r.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(r) => `${r.metadata.namespace}/${r.metadata.name}`}
        empty={<EmptyState title="No replicasets" />}
      />
    </ListShell>
  )
}

function StatefulSetTable({ namespace }: { namespace?: string }) {
  const q = useStatefulSets(namespace)
  return (
    <GenericWorkloadList
      title="StatefulSets"
      query={q}
      empty="No statefulsets"
      readyExtractor={(o) =>
        `${(o.status as { readyReplicas?: number })?.readyReplicas ?? 0}/${(o.spec as { replicas?: number })?.replicas ?? 0}`
      }
    />
  )
}

function DaemonSetTable({ namespace }: { namespace?: string }) {
  const q = useDaemonSets(namespace)
  return (
    <GenericWorkloadList
      title="DaemonSets"
      query={q}
      empty="No daemonsets"
      readyExtractor={(o) => {
        const s = o.status as { numberReady?: number; desiredNumberScheduled?: number }
        return `${s?.numberReady ?? 0}/${s?.desiredNumberScheduled ?? 0}`
      }}
    />
  )
}

function JobTable({ namespace }: { namespace?: string }) {
  const q = useJobs(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (j) =>
          matchesSearch(j.metadata.name, search) || matchesSearch(j.metadata.namespace, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title="Jobs"
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
            cell: (j) => (
              <div>
                <div className="font-medium text-content">{j.metadata.name}</div>
                <div className="text-xs text-content-muted">{j.metadata.namespace}</div>
              </div>
            ),
          },
          {
            key: 'completions',
            header: 'Completions',
            cell: (j) => {
              const s = (j.status as { succeeded?: number } | undefined) ?? {}
              const c = (j.spec as { completions?: number } | undefined)?.completions
              return `${s.succeeded ?? 0}/${c ?? '—'}`
            },
          },
          {
            key: 'duration',
            header: 'Duration',
            cell: (j) => {
              const s =
                (j.status as { startTime?: string; completionTime?: string } | undefined) ?? {}
              if (!s.startTime) return '—'
              const start = new Date(s.startTime).getTime()
              const end = s.completionTime ? new Date(s.completionTime).getTime() : Date.now()
              const secs = Math.max(0, Math.floor((end - start) / 1000))
              return `${secs}s`
            },
          },
          { key: 'age', header: 'Age', cell: (j) => age(j.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(j) => `${j.metadata.namespace}/${j.metadata.name}`}
        empty={<EmptyState title="No jobs" />}
      />
    </ListShell>
  )
}

function CronJobTable({ namespace }: { namespace?: string }) {
  const q = useCronJobs(namespace)
  const [search, setSearch] = useState('')
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (cj) =>
          matchesSearch(cj.metadata.name, search) || matchesSearch(cj.metadata.namespace, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title="CronJobs"
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
            cell: (cj) => (
              <div>
                <div className="font-medium text-content">{cj.metadata.name}</div>
                <div className="text-xs text-content-muted">{cj.metadata.namespace}</div>
              </div>
            ),
          },
          {
            key: 'schedule',
            header: 'Schedule',
            cell: (cj) => (
              <code className="font-mono text-[11px]">
                {(cj.spec as { schedule?: string })?.schedule ?? '—'}
              </code>
            ),
          },
          {
            key: 'suspend',
            header: 'Suspended',
            cell: (cj) =>
              (cj.spec as { suspend?: boolean })?.suspend ? (
                <StatusBadge kind="paused">Yes</StatusBadge>
              ) : (
                <StatusBadge kind="healthy">No</StatusBadge>
              ),
          },
          {
            key: 'lastSchedule',
            header: 'Last schedule',
            cell: (cj) => age((cj.status as { lastScheduleTime?: string })?.lastScheduleTime),
          },
          { key: 'age', header: 'Age', cell: (cj) => age(cj.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(cj) => `${cj.metadata.namespace}/${cj.metadata.name}`}
        empty={<EmptyState title="No cronjobs" />}
      />
    </ListShell>
  )
}

interface HpaObject {
  metadata: { name: string; namespace?: string; creationTimestamp?: string }
  spec?: {
    minReplicas?: number
    maxReplicas?: number
    scaleTargetRef?: { kind?: string; name?: string }
    metrics?: Array<{ type?: string; resource?: { name?: string; target?: { averageUtilization?: number } } }>
  }
  status?: { currentReplicas?: number; desiredReplicas?: number; conditions?: Array<{ type: string; status: string }> }
}

function HpaTable({ namespace }: { namespace?: string }) {
  const q = useHorizontalPodAutoscalers(namespace)
  const [search, setSearch] = useState('')
  const all = (q.data ?? []) as unknown as HpaObject[]
  const rows = useMemo(
    () =>
      all.filter(
        (h) =>
          matchesSearch(h.metadata.name, search) ||
          matchesSearch(h.metadata.namespace, search) ||
          matchesSearch(h.spec?.scaleTargetRef?.name, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title="Horizontal Pod Autoscalers"
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
            cell: (h) => (
              <div>
                <div className="font-medium text-content">{h.metadata.name}</div>
                <div className="text-xs text-content-muted">{h.metadata.namespace}</div>
              </div>
            ),
          },
          {
            key: 'target',
            header: 'Target',
            cell: (h) => (
              <code className="font-mono text-[11px] text-content-muted">
                {h.spec?.scaleTargetRef?.kind}/{h.spec?.scaleTargetRef?.name}
              </code>
            ),
          },
          {
            key: 'replicas',
            header: 'Replicas',
            numeric: true,
            cell: (h) =>
              `${h.status?.currentReplicas ?? '—'}/${h.spec?.maxReplicas ?? '∞'}`,
          },
          {
            key: 'min',
            header: 'Min',
            numeric: true,
            cell: (h) => h.spec?.minReplicas ?? 1,
          },
          {
            key: 'metrics',
            header: 'Metrics',
            cell: (h) => {
              const ms = h.spec?.metrics ?? []
              if (!ms.length) return <span className="text-content-subtle">—</span>
              return (
                <div className="flex flex-wrap gap-1 font-mono text-[10px]">
                  {ms.map((m, i) => (
                    <span
                      key={i}
                      className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted"
                    >
                      {m.resource?.name ?? m.type}
                      {m.resource?.target?.averageUtilization
                        ? `@${m.resource.target.averageUtilization}%`
                        : ''}
                    </span>
                  ))}
                </div>
              )
            },
          },
          { key: 'age', header: 'Age', cell: (h) => age(h.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(h) => `${h.metadata.namespace}/${h.metadata.name}`}
        empty={<EmptyState title="No horizontal pod autoscalers" />}
      />
    </ListShell>
  )
}

interface GenericQuery {
  isLoading: boolean
  isFetching: boolean
  refetch(): unknown
  dataUpdatedAt: number
  data?: Array<{
    metadata: { name: string; namespace?: string; creationTimestamp?: string }
    spec?: unknown
    status?: unknown
  }>
}

function GenericWorkloadList({
  title,
  query,
  empty,
  readyExtractor,
}: {
  title: string
  query: GenericQuery
  empty: string
  readyExtractor(obj: { spec?: unknown; status?: unknown }): string
}) {
  const [search, setSearch] = useState('')
  const all = query.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (o) =>
          matchesSearch(o.metadata.name, search) || matchesSearch(o.metadata.namespace, search),
      ),
    [all, search],
  )
  return (
    <ListShell
      title={title}
      total={all.length}
      visible={rows.length}
      loading={query.isLoading}
      isFetching={query.isFetching}
      onRefresh={() => query.refetch()}
      lastUpdatedAt={query.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
    >
      <DataTable
        loading={query.isLoading}
        columns={[
          {
            key: 'name',
            header: 'Name',
            cell: (o) => (
              <div>
                <div className="font-medium text-content">{o.metadata.name}</div>
                <div className="text-xs text-content-muted">{o.metadata.namespace}</div>
              </div>
            ),
          },
          { key: 'ready', header: 'Ready', numeric: true, cell: (o) => readyExtractor(o) },
          { key: 'age', header: 'Age', cell: (o) => age(o.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(o) => `${o.metadata.namespace}/${o.metadata.name}`}
        empty={<EmptyState title={empty} />}
      />
    </ListShell>
  )
}

// pin the format import so the bundler keeps it available for future columns
export const _pin = { shortImage }
