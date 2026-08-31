import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, DataTable, EmptyState, StatusBadge, Tabs, type TabDef } from '@adhar-console/shell-ui'
import { kube, type KubeObject } from '@adhar-console/api-clients/k8s'
import { GVRS } from '../data/gvr.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'
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
import { ListShell, matchesSearch } from './list-shell.tsx'
import { WorkloadDrawer, type WorkloadKind } from './workload-drawer.tsx'

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
        <WorkloadDrawer
          kind="Deployment"
          namespace={selected.metadata.namespace ?? 'default'}
          name={selected.metadata.name}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
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
      drawerKind="StatefulSet"
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
      drawerKind="DaemonSet"
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
          {
            key: 'actions',
            header: '',
            cell: (j) => <JobActions job={j as unknown as JobObj} />,
          },
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
          {
            key: 'actions',
            header: '',
            cell: (cj) => <CronJobActions cronJob={cj as unknown as CronJobObj} />,
          },
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
  drawerKind,
}: {
  title: string
  query: GenericQuery
  empty: string
  readyExtractor(obj: { spec?: unknown; status?: unknown }): string
  /** When set, rows open a rich WorkloadDrawer for that kind. */
  drawerKind?: WorkloadKind
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<{ namespace: string; name: string } | null>(null)
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
    <>
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
          onRowClick={
            drawerKind
              ? (o) =>
                  setSelected({
                    namespace: o.metadata.namespace ?? 'default',
                    name: o.metadata.name,
                  })
              : undefined
          }
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
      {drawerKind && selected ? (
        <WorkloadDrawer
          kind={drawerKind}
          namespace={selected.namespace}
          name={selected.name}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  )
}

/* ── CronJob / Job actions ─────────────────────────────────────────────── */

interface CronJobObj {
  metadata: { name: string; namespace?: string; uid?: string }
  spec?: {
    suspend?: boolean
    jobTemplate?: {
      metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
      spec?: Record<string, unknown>
    }
  }
}

interface JobObj {
  metadata: {
    name: string
    namespace?: string
    labels?: Record<string, string>
    ownerReferences?: Array<{ kind: string }>
  }
  spec?: Record<string, unknown> & {
    selector?: unknown
    template?: { metadata?: { labels?: Record<string, string> } }
  }
}

/** DNS-1123-safe generated name: `<base>-<suffix>-<ts>`, trimmed to 63 chars. */
function generatedName(base: string, suffix: string): string {
  const tail = `-${suffix}-${Date.now().toString(36)}`
  return `${base.slice(0, Math.max(1, 63 - tail.length))}${tail}`.toLowerCase()
}

function CronJobActions({ cronJob }: { cronJob: CronJobObj }) {
  const canWrite = useHasK8sPermission('workloads.write')
  const qc = useQueryClient()
  const ns = cronJob.metadata.namespace ?? 'default'
  const suspended = Boolean(cronJob.spec?.suspend)

  const suspendMut = useMutation({
    mutationFn: () =>
      kube.patch(GVRS.cronjobs, ns, cronJob.metadata.name, { spec: { suspend: !suspended } }, 'merge'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k8s', 'cronjobs'] }),
  })

  // "Trigger now" = create a Job from the CronJob's jobTemplate, exactly like
  // `kubectl create job --from=cronjob/<name>` — owner-ref'd for cleanup.
  const triggerMut = useMutation({
    mutationFn: async () => {
      const jt = cronJob.spec?.jobTemplate ?? {}
      const manifest = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: generatedName(cronJob.metadata.name, 'manual'),
          namespace: ns,
          annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' },
          ...(jt.metadata?.labels ? { labels: jt.metadata.labels } : {}),
          ...(cronJob.metadata.uid
            ? {
                ownerReferences: [
                  {
                    apiVersion: 'batch/v1',
                    kind: 'CronJob',
                    name: cronJob.metadata.name,
                    uid: cronJob.metadata.uid,
                  },
                ],
              }
            : {}),
        },
        spec: jt.spec ?? {},
      } as unknown as KubeObject
      await kube.apply(manifest)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k8s', 'jobs'] }),
  })

  if (!canWrite) return <K8sRolePill perm="workloads.write" />
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex justify-end gap-1.5">
        <Button
          size="xs"
          variant="secondary"
          disabled={suspendMut.isPending}
          onClick={() => suspendMut.mutate()}
          title={
            suspended
              ? 'Resume scheduling (spec.suspend = false)'
              : 'Stop new runs from being scheduled (spec.suspend = true)'
          }
        >
          {suspendMut.isPending ? 'Working…' : suspended ? 'Resume' : 'Suspend'}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          disabled={triggerMut.isPending}
          onClick={() => triggerMut.mutate()}
          title="Create a Job right now from this CronJob's template"
        >
          {triggerMut.isPending ? 'Triggering…' : 'Trigger now'}
        </Button>
      </div>
      {triggerMut.isSuccess ? (
        <span className="text-[10px] text-emerald-600 dark:text-emerald-400">Job created</span>
      ) : null}
      {suspendMut.isError || triggerMut.isError ? (
        <span className="max-w-[16rem] truncate text-[10px] text-rose-700 dark:text-rose-300">
          {((suspendMut.error ?? triggerMut.error) as Error).message}
        </span>
      ) : null}
    </div>
  )
}

function JobActions({ job }: { job: JobObj }) {
  const canWrite = useHasK8sPermission('workloads.write')
  const canDelete = useHasK8sPermission('workloads.delete')
  const qc = useQueryClient()
  const ns = job.metadata.namespace ?? 'default'
  const [confirmDelete, setConfirmDelete] = useState(false)

  // "Rerun" = recreate the Job from its own pod template, with the
  // controller-injected selector/labels stripped so the apiserver generates
  // fresh ones for the new Job.
  const rerunMut = useMutation({
    mutationFn: async () => {
      const spec = JSON.parse(JSON.stringify(job.spec ?? {})) as JobObj['spec'] & {
        template?: { metadata?: { labels?: Record<string, string> } }
      }
      delete spec.selector
      const labels = spec.template?.metadata?.labels
      if (labels) {
        for (const k of [
          'controller-uid',
          'job-name',
          'batch.kubernetes.io/controller-uid',
          'batch.kubernetes.io/job-name',
        ]) {
          delete labels[k]
        }
      }
      const manifest = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: generatedName(job.metadata.name, 'rerun'),
          namespace: ns,
          annotations: { 'adhar.io/rerun-of': job.metadata.name },
        },
        spec,
      } as unknown as KubeObject
      await kube.apply(manifest)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k8s', 'jobs'] }),
  })

  const deleteMut = useMutation({
    mutationFn: () =>
      kube.delete(GVRS.jobs, ns, job.metadata.name, { propagationPolicy: 'Background' }),
    onSuccess: () => {
      setConfirmDelete(false)
      qc.invalidateQueries({ queryKey: ['k8s', 'jobs'] })
      qc.invalidateQueries({ queryKey: ['k8s', 'pods'] })
    },
  })

  if (!canWrite && !canDelete) return <K8sRolePill perm="workloads.write" />
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex justify-end gap-1.5">
        {canWrite ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={rerunMut.isPending}
            onClick={() => rerunMut.mutate()}
            title="Create a new Job from this Job's pod template"
          >
            {rerunMut.isPending ? 'Creating…' : 'Rerun'}
          </Button>
        ) : null}
        {canDelete ? (
          confirmDelete ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
                disabled={deleteMut.isPending}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                variant="danger"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate()}
                title={`Delete Job ${job.metadata.name} and its pods`}
              >
                {deleteMut.isPending ? 'Deleting…' : 'Confirm delete'}
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              title="Delete this Job (asks to confirm)"
            >
              Delete
            </Button>
          )
        ) : null}
      </div>
      {rerunMut.isSuccess ? (
        <span className="text-[10px] text-emerald-600 dark:text-emerald-400">Job created</span>
      ) : null}
      {rerunMut.isError || deleteMut.isError ? (
        <span className="max-w-[16rem] truncate text-[10px] text-rose-700 dark:text-rose-300">
          {((rerunMut.error ?? deleteMut.error) as Error).message}
        </span>
      ) : null}
    </div>
  )
}

// pin the format import so the bundler keeps it available for future columns
export const _pin = { shortImage }
