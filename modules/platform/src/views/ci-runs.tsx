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
import { TektonPipelineRuns, TektonPipelines, TektonTasks, TektonTriggers } from './tekton.tsx'

/**
 * CI / CD runs. A single tab row spans the Tekton surface (PipelineRuns with a
 * task DAG / service map, per-step logs, and re-run / cancel / delete
 * management; plus Pipelines, Tasks, and Triggers) and keeps the existing Argo
 * Workflows view. The Tekton tabs live in `tekton.tsx`; this file owns the tab
 * shell and the Argo Workflows table + drawer.
 */

/* ─────────── GVRs (real cluster; dev resolves to stub fixtures) ─────────── */

const ARGO_WORKFLOWS_GVR: GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'workflows',
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

type Source = 'runs' | 'pipelines' | 'tasks' | 'triggers' | 'argo'

const SOURCE_TABS: readonly TabDef<Source>[] = [
  { id: 'runs', label: 'PipelineRuns' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'argo', label: 'Argo Workflows' },
]

export function CiRunsView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Source> tabs={SOURCE_TABS} defaultValue="runs" ariaLabel="CI / CD source">
      {(active) => (
        <>
          {active === 'runs' && <TektonPipelineRuns namespace={namespace} />}
          {active === 'pipelines' && <TektonPipelines namespace={namespace} />}
          {active === 'tasks' && <TektonTasks namespace={namespace} />}
          {active === 'triggers' && <TektonTriggers namespace={namespace} />}
          {active === 'argo' && <ArgoTable namespace={namespace} />}
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
