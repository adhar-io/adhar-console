import { useEffect, useMemo, useState } from 'react'
import {
  DataTable,
  EmptyState,
  StatusBadge,
  Tabs,
  type StatusKind,
  type TabDef,
} from '@adhar-console/shell-ui'
import type { GatewayGVR as GVR, KubeObject } from '@adhar-console/api-clients/k8s'
import { useLiveList, type LiveStatus } from '../data/live.ts'
import { age } from '../data/format.ts'
import { DrawerSection, DrawerStatusTile, ResourceDrawer, Row } from './resource-drawer.tsx'
import { ListShell, matchesSearch } from './list-shell.tsx'

/* ─────────── GVRs (real cluster; dev resolves to stub fixtures) ─────────── */

const ARGO_WORKFLOWS_GVR: GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'workflows',
  namespaced: true,
}
const TEKTON_PIPELINERUNS_GVR: GVR = {
  group: 'tekton.dev',
  version: 'v1',
  resource: 'pipelineruns',
  namespaced: true,
}

/* ─────────── Loosely-typed shapes (any field may be absent) ─────────── */

interface ArgoNode {
  name?: string
  displayName?: string
  type?: string
  phase?: string
  templateName?: string
  startedAt?: string
  finishedAt?: string
  message?: string
}
interface ArgoWorkflow extends KubeObject {
  status?: {
    phase?: string
    progress?: string
    message?: string
    startedAt?: string
    finishedAt?: string
    nodes?: Record<string, ArgoNode>
  }
}

interface TektonCondition {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}
interface TektonChildRef {
  name?: string
  kind?: string
  pipelineTaskName?: string
}
interface TektonTaskRun {
  pipelineTaskName?: string
  status?: { conditions?: TektonCondition[] }
}
interface TektonRun extends KubeObject {
  status?: {
    startTime?: string
    completionTime?: string
    conditions?: TektonCondition[]
    childReferences?: TektonChildRef[]
    taskRuns?: Record<string, TektonTaskRun>
  }
}

/* ─────────── Helpers ─────────── */

/** Human duration between two timestamps; end defaults to now while running. */
function duration(start?: string, end?: string): string {
  if (!start) return '—'
  const startMs = new Date(start).getTime()
  if (!Number.isFinite(startMs)) return '—'
  const endMs = end ? new Date(end).getTime() : Date.now()
  let s = Math.max(0, Math.floor((endMs - startMs) / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

/** Re-render on an interval so live durations keep ticking. */
function useTick(ms = 1000) {
  const [, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

function creationOf(o: KubeObject): number {
  return new Date(o.metadata?.creationTimestamp ?? 0).getTime()
}
function newestFirst(a: KubeObject, b: KubeObject): number {
  return creationOf(b) - creationOf(a)
}

function argoKind(phase?: string): StatusKind {
  switch (phase) {
    case 'Succeeded':
      return 'healthy'
    case 'Running':
      return 'progressing'
    case 'Failed':
      return 'failed'
    case 'Error':
      return 'degraded'
    case 'Pending':
      return 'paused'
    default:
      return 'unknown'
  }
}

/** Newest `Succeeded`-type condition (falls back to first condition). */
function tektonCondition(run: TektonRun): TektonCondition | undefined {
  const conds = run.status?.conditions ?? []
  const succeeded = conds.filter((c) => c.type === 'Succeeded')
  const pool = succeeded.length ? succeeded : conds
  return [...pool].sort(
    (a, b) =>
      new Date(b.lastTransitionTime ?? 0).getTime() - new Date(a.lastTransitionTime ?? 0).getTime(),
  )[0]
}
function tektonKind(c?: TektonCondition): StatusKind {
  if (!c) return 'unknown'
  if (c.status === 'True') return 'healthy'
  if (c.status === 'False') return 'failed'
  return 'progressing'
}
function tektonLabel(c?: TektonCondition): string {
  if (!c) return 'Unknown'
  if (c.reason) return c.reason
  return c.status === 'True' ? 'Succeeded' : c.status === 'False' ? 'Failed' : 'Running'
}
function tektonProgress(run: TektonRun): string {
  const refs = run.status?.childReferences ?? []
  const trs = Object.values(run.status?.taskRuns ?? {})
  const total = refs.length || trs.length
  if (!total) return '—'
  const done = trs.filter((tr) => {
    const c = (tr.status?.conditions ?? []).find((x) => x.type === 'Succeeded')
    return c ? c.status !== 'Unknown' : false
  }).length
  return `${done}/${total}`
}

/* ─────────── Small shared bits ─────────── */

const LIVE_TONE: Record<LiveStatus, string> = {
  live: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
  error: 'bg-rose-500',
}

function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-content-subtle">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${LIVE_TONE[status]}`} />
      {status}
    </span>
  )
}

function StepRow({
  label,
  sub,
  kind,
  badge,
}: {
  label: string
  sub?: string
  kind: StatusKind
  badge: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="truncate text-sm text-content">{label}</div>
        {sub ? <div className="truncate text-[11px] text-content-muted">{sub}</div> : null}
      </div>
      <StatusBadge kind={kind}>{badge}</StatusBadge>
    </div>
  )
}

/* ─────────── Root view ─────────── */

type Source = 'argo' | 'tekton'

const SOURCE_TABS: readonly TabDef<Source>[] = [
  { id: 'argo', label: 'Argo Workflows' },
  { id: 'tekton', label: 'Tekton' },
]

export function CiRunsView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Source> tabs={SOURCE_TABS} defaultValue="argo" ariaLabel="Pipeline source">
      {(active) => (
        <>
          {active === 'argo' && <ArgoTable namespace={namespace} />}
          {active === 'tekton' && <TektonTable namespace={namespace} />}
        </>
      )}
    </Tabs>
  )
}

export default CiRunsView

/* ─────────── Argo Workflows ─────────── */

function ArgoTable({ namespace }: { namespace?: string }) {
  const live = useLiveList<ArgoWorkflow>(ARGO_WORKFLOWS_GVR, { namespace })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ArgoWorkflow | null>(null)
  useTick()

  const all = live.data
  const rows = useMemo(
    () =>
      all
        .filter(
          (w) =>
            matchesSearch(w.metadata?.name, search) ||
            matchesSearch(w.metadata?.namespace, search) ||
            matchesSearch(w.status?.phase, search),
        )
        .slice()
        .sort(newestFirst),
    [all, search],
  )

  return (
    <>
      <ListShell
        title="Argo Workflows"
        total={all.length}
        visible={rows.length}
        loading={live.isLoading}
        onRefresh={() => live.refetch()}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search workflows…"
        caption="newest first"
        filters={<LiveIndicator status={live.status} />}
      >
        <DataTable
          loading={live.isLoading}
          onRowClick={(w) => setSelected(w)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (w) => <span className="font-medium text-content">{w.metadata?.name}</span>,
            },
            { key: 'namespace', header: 'Namespace', cell: (w) => w.metadata?.namespace ?? '—' },
            {
              key: 'phase',
              header: 'Phase',
              cell: (w) => (
                <StatusBadge kind={argoKind(w.status?.phase)}>
                  {w.status?.phase ?? 'Unknown'}
                </StatusBadge>
              ),
            },
            {
              key: 'progress',
              header: 'Progress',
              cell: (w) => (
                <span className="font-mono text-xs text-content-muted">
                  {w.status?.progress ?? '—'}
                </span>
              ),
            },
            {
              key: 'started',
              header: 'Started',
              cell: (w) => age(w.status?.startedAt ?? w.metadata?.creationTimestamp),
            },
            {
              key: 'duration',
              header: 'Duration',
              cell: (w) => duration(w.status?.startedAt, w.status?.finishedAt),
            },
          ]}
          rows={rows}
          rowKey={(w) => w.metadata?.uid ?? `${w.metadata?.namespace}/${w.metadata?.name}`}
          empty={
            <EmptyState
              title="No workflow runs"
              description="Argo Workflow runs in this scope will appear here as they start."
            />
          }
        />
      </ListShell>
      {selected ? <ArgoDrawer wf={selected} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function ArgoDrawer({ wf, onClose }: { wf: ArgoWorkflow; onClose(): void }) {
  useTick()
  const status = wf.status
  const kind = argoKind(status?.phase)
  const phase = status?.phase ?? 'Unknown'

  const nodes = useMemo(() => {
    const list = Object.values(status?.nodes ?? {})
    return list
      .slice()
      .sort((a, b) => new Date(a.startedAt ?? 0).getTime() - new Date(b.startedAt ?? 0).getTime())
  }, [status?.nodes])

  return (
    <ResourceDrawer
      resource={
        {
          ...wf,
          apiVersion: 'argoproj.io/v1alpha1',
          kind: 'Workflow',
        } as unknown as { apiVersion: string; kind: string; metadata: { name: string } }
      }
      kindLabel="Workflow"
      statusBadge={<StatusBadge kind={kind}>{phase}</StatusBadge>}
      onClose={onClose}
    >
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <DrawerStatusTile label="Phase" kind={kind} value={phase} sub={status?.message} />
        <DrawerStatusTile label="Progress" kind="info" value={status?.progress ?? '—'} />
        <DrawerStatusTile
          label="Duration"
          kind="info"
          value={duration(status?.startedAt, status?.finishedAt)}
        />
      </section>

      <DrawerSection title="Run">
        <div className="divide-y divide-edge-subtle text-sm">
          <Row label="Started" value={age(status?.startedAt)} />
          <Row label="Finished" value={status?.finishedAt ? age(status.finishedAt) : '—'} />
          <Row label="Message" value={status?.message ?? '—'} />
        </div>
      </DrawerSection>

      <DrawerSection title={`Steps (${nodes.length})`}>
        {nodes.length ? (
          <div className="divide-y divide-edge-subtle">
            {nodes.map((n, i) => (
              <StepRow
                key={n.name ?? `${n.displayName}-${i}`}
                label={n.displayName || n.name || '—'}
                sub={[n.type, n.templateName].filter(Boolean).join(' · ') || undefined}
                kind={argoKind(n.phase)}
                badge={n.phase ?? 'Unknown'}
              />
            ))}
          </div>
        ) : (
          <EmptyState compact title="No step nodes reported" />
        )}
      </DrawerSection>
    </ResourceDrawer>
  )
}

/* ─────────── Tekton PipelineRuns ─────────── */

function TektonTable({ namespace }: { namespace?: string }) {
  const live = useLiveList<TektonRun>(TEKTON_PIPELINERUNS_GVR, { namespace })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<TektonRun | null>(null)
  useTick()

  const all = live.data
  const rows = useMemo(
    () =>
      all
        .filter(
          (r) =>
            matchesSearch(r.metadata?.name, search) ||
            matchesSearch(r.metadata?.namespace, search) ||
            matchesSearch(tektonCondition(r)?.reason, search),
        )
        .slice()
        .sort(newestFirst),
    [all, search],
  )

  return (
    <>
      <ListShell
        title="Tekton PipelineRuns"
        total={all.length}
        visible={rows.length}
        loading={live.isLoading}
        onRefresh={() => live.refetch()}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search pipeline runs…"
        caption="newest first"
        filters={<LiveIndicator status={live.status} />}
      >
        <DataTable
          loading={live.isLoading}
          onRowClick={(r) => setSelected(r)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (r) => <span className="font-medium text-content">{r.metadata?.name}</span>,
            },
            { key: 'namespace', header: 'Namespace', cell: (r) => r.metadata?.namespace ?? '—' },
            {
              key: 'status',
              header: 'Status',
              cell: (r) => {
                const c = tektonCondition(r)
                return <StatusBadge kind={tektonKind(c)}>{tektonLabel(c)}</StatusBadge>
              },
            },
            {
              key: 'progress',
              header: 'Progress',
              cell: (r) => (
                <span className="font-mono text-xs text-content-muted">{tektonProgress(r)}</span>
              ),
            },
            {
              key: 'started',
              header: 'Started',
              cell: (r) => age(r.status?.startTime ?? r.metadata?.creationTimestamp),
            },
            {
              key: 'duration',
              header: 'Duration',
              cell: (r) => duration(r.status?.startTime, r.status?.completionTime),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.metadata?.uid ?? `${r.metadata?.namespace}/${r.metadata?.name}`}
          empty={
            <EmptyState
              title="No pipeline runs"
              description="Tekton PipelineRuns in this scope will appear here as they start."
            />
          }
        />
      </ListShell>
      {selected ? <TektonDrawer run={selected} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function TektonDrawer({ run, onClose }: { run: TektonRun; onClose(): void }) {
  useTick()
  const status = run.status
  const primary = tektonCondition(run)
  const kind = tektonKind(primary)
  const label = tektonLabel(primary)
  const conditions = status?.conditions ?? []
  const children = status?.childReferences ?? []
  const taskRuns = status?.taskRuns ?? {}

  const steps = useMemo(() => {
    if (children.length) {
      return children.map((c) => ({
        key: c.name ?? c.pipelineTaskName ?? '',
        label: c.pipelineTaskName || c.name || '—',
        sub: c.kind || undefined,
        cond: undefined as TektonCondition | undefined,
      }))
    }
    return Object.entries(taskRuns).map(([name, tr]) => ({
      key: name,
      label: tr.pipelineTaskName || name,
      sub: 'TaskRun',
      cond: (tr.status?.conditions ?? []).find((x) => x.type === 'Succeeded'),
    }))
  }, [children, taskRuns])

  return (
    <ResourceDrawer
      resource={
        {
          ...run,
          apiVersion: 'tekton.dev/v1',
          kind: 'PipelineRun',
        } as unknown as { apiVersion: string; kind: string; metadata: { name: string } }
      }
      kindLabel="PipelineRun"
      statusBadge={<StatusBadge kind={kind}>{label}</StatusBadge>}
      onClose={onClose}
    >
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <DrawerStatusTile label="Status" kind={kind} value={label} sub={primary?.message} />
        <DrawerStatusTile label="Progress" kind="info" value={tektonProgress(run)} />
        <DrawerStatusTile
          label="Duration"
          kind="info"
          value={duration(status?.startTime, status?.completionTime)}
        />
      </section>

      <DrawerSection title="Run">
        <div className="divide-y divide-edge-subtle text-sm">
          <Row label="Started" value={age(status?.startTime)} />
          <Row label="Completed" value={status?.completionTime ? age(status.completionTime) : '—'} />
        </div>
      </DrawerSection>

      <DrawerSection title={`Conditions (${conditions.length})`}>
        {conditions.length ? (
          <div className="divide-y divide-edge-subtle">
            {conditions.map((c, i) => (
              <StepRow
                key={`${c.type ?? 'cond'}-${i}`}
                label={c.type ?? '—'}
                sub={c.message || undefined}
                kind={tektonKind(c)}
                badge={c.reason ?? c.status ?? '—'}
              />
            ))}
          </div>
        ) : (
          <EmptyState compact title="No conditions reported" />
        )}
      </DrawerSection>

      <DrawerSection title={`Tasks (${steps.length})`}>
        {steps.length ? (
          <div className="divide-y divide-edge-subtle">
            {steps.map((s, i) => (
              <StepRow
                key={s.key || `step-${i}`}
                label={s.label}
                sub={s.sub}
                kind={s.cond ? tektonKind(s.cond) : 'unknown'}
                badge={s.cond ? tektonLabel(s.cond) : s.sub === 'TaskRun' ? 'Pending' : 'Task'}
              />
            ))}
          </div>
        ) : (
          <EmptyState compact title="No task references reported" />
        )}
      </DrawerSection>
    </ResourceDrawer>
  )
}
