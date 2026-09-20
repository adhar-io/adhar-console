import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  DataTable,
  EmptyState,
  Input,
  LogConsole,
  Select,
  Spinner,
  StatusBadge,
  useCan,
  useLogStream,
  useToast,
  useToolPublicUrl,
  type Column,
  type StatusKind,
  useOverlayDismiss,
} from '@adhar-console/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar-console/utils'
import {
  CanvasBtn,
  edgeBetween,
  GraphCanvas,
  layoutLayers,
  type CanvasEdge,
} from '../components/canvas.tsx'
import { CrdMissing } from '../components/crd-missing.tsx'
import { WorkflowDesigner } from './wf-designer.tsx'
import {
  deleteWorkflow,
  durationSecs,
  fmtDuration,
  isCrdMissing,
  isNotFound,
  nodeList,
  resubmitWorkflow,
  shutdownWorkflow,
  useCronWorkflows,
  useWorkflow,
  useWorkflows,
  useWorkflowTemplates,
  type CronWorkflow,
  type Workflow,
  type WorkflowNode,
  type WorkflowTemplate,
} from '../data/workflows.ts'

/**
 * Argo Workflows workbench.
 *
 * The platform splits execution in two: Tekton runs CI — build, test, publish
 * on a commit — and lives under Platform → CI / CD. Everything else that is a
 * DAG of containers runs on Argo Workflows, and this is where those runs,
 * their templates and their schedules are read.
 *
 * A run opens in a drawer modelled on the Tekton PipelineRun drawer: stages as
 * a graph, a streaming console per stage, and Re-run / Stop / Terminate /
 * Delete through the Kubernetes gateway — the console has no Argo Server token,
 * so everything is done to the Workflow object itself.
 */

const ARGO_INSTALL_DOCS = 'https://argo-workflows.readthedocs.io/en/stable/quick-start/'
const ARGO_WRITING_DOCS = 'https://argo-workflows.readthedocs.io/en/stable/workflow-concepts/'

const PHASE_KIND: Record<string, StatusKind> = {
  Succeeded: 'healthy',
  Running: 'progressing',
  Pending: 'info',
  Failed: 'failed',
  Error: 'failed',
  Omitted: 'unknown',
  Skipped: 'unknown',
}

const PHASES = ['Running', 'Succeeded', 'Failed', 'Pending'] as const

type Tab = 'workflows' | 'templates' | 'cron' | 'designer'
type PhaseFilter = 'all' | 'Running' | 'Succeeded' | 'Failed' | 'Pending'

export function WorkflowList() {
  const argoUrl = useToolPublicUrl('argo-workflows')
  const [tab, setTab] = useState<Tab>('workflows')
  const [search, setSearch] = useState('')
  const [phaseF, setPhaseF] = useState<PhaseFilter>('all')
  const [nsF, setNsF] = useState('all')
  const [open, setOpen] = useState<{ namespace: string; name: string } | null>(null)

  // Workflows always load — the stats strip reads from them whichever tab is
  // showing. Templates and cron load only when asked for.
  const wfq = useWorkflows()
  const tplq = useWorkflowTemplates(tab === 'templates')
  const cronq = useCronWorkflows(tab === 'cron')

  const workflows = useMemo(() => wfq.data ?? [], [wfq.data])
  const templates = useMemo(() => tplq.data ?? [], [tplq.data])
  const crons = useMemo(() => cronq.data ?? [], [cronq.data])

  const stats = useMemo(() => {
    const s = { total: workflows.length, running: 0, succeeded: 0, failed: 0, pending: 0 }
    for (const w of workflows) {
      const p = w.status?.phase
      if (p === 'Running') s.running++
      else if (p === 'Succeeded') s.succeeded++
      else if (p === 'Failed' || p === 'Error') s.failed++
      else s.pending++
    }
    return s
  }, [workflows])

  /** Namespaces present in whatever the active tab is listing. */
  const namespaces = useMemo(() => {
    const src: Array<{ metadata: { namespace?: string } }> =
      tab === 'templates' ? templates : tab === 'cron' ? crons : workflows
    return [...new Set(src.map((o) => o.metadata.namespace).filter((n): n is string => !!n))].sort()
  }, [tab, workflows, templates, crons])

  const q = search.trim().toLowerCase()
  const matches = (...fields: Array<string | undefined>) =>
    !q || fields.some((f) => f?.toLowerCase().includes(q))
  const inNs = (ns?: string) => nsF === 'all' || ns === nsF

  const wfRows = useMemo(
    () =>
      workflows.filter((w) => {
        const p = w.status?.phase
        const phaseOk = phaseF === 'all' ||
          (phaseF === 'Failed' ? p === 'Failed' || p === 'Error'
            : phaseF === 'Pending' ? p !== 'Running' && p !== 'Succeeded' && p !== 'Failed' && p !== 'Error'
            : p === phaseF)
        return phaseOk && inNs(w.metadata.namespace) &&
          matches(w.metadata.name, w.metadata.namespace, w.spec?.entrypoint)
      }),
    // `matches` / `inNs` close over search + nsF, which are in the dep list.
    [workflows, phaseF, nsF, q],
  )

  const tplRows = useMemo(
    () =>
      templates.filter((t) =>
        inNs(t.metadata.namespace) && matches(t.metadata.name, t.metadata.namespace, t.spec?.entrypoint)
      ),
    [templates, nsF, q],
  )

  const cronRows = useMemo(
    () =>
      crons.filter((c) =>
        inNs(c.metadata.namespace) &&
        matches(c.metadata.name, c.metadata.namespace, scheduleOf(c), c.spec?.workflowSpec?.entrypoint)
      ),
    [crons, nsF, q],
  )

  // A 404 for the CRD path is not an error the user can act on by retrying —
  // the operator simply isn't installed.
  if (isCrdMissing(wfq.error)) {
    return (
      <CrdMissing
        tool='Argo Workflows'
        href={ARGO_INSTALL_DOCS}
        action={argoUrl ? <ExternalLink href={argoUrl}>Open Argo Workflows</ExternalLink> : undefined}
      />
    )
  }

  if (wfq.error) {
    return (
      <EmptyState
        title="Couldn't load workflows"
        description={wfq.error instanceof Error ? wfq.error.message : 'The apiserver rejected the request.'}
      />
    )
  }

  const activeQ = tab === 'templates' ? tplq : tab === 'cron' ? cronq : wfq

  // The designer owns the full width and carries its own toolbar, so it
  // replaces the list body rather than rendering inside the filter chrome.
  if (tab === 'designer') {
    return (
      <div className='space-y-3'>
        <div className='inline-flex items-center rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5'>
          <TabBtn on={false} onClick={() => setTab('workflows')}>Workflows</TabBtn>
          <TabBtn on={false} onClick={() => setTab('templates')}>Templates</TabBtn>
          <TabBtn on={false} onClick={() => setTab('cron')}>Cron</TabBtn>
          <TabBtn on onClick={() => setTab('designer')}>Designer</TabBtn>
        </div>
        <WorkflowDesigner namespace={nsF !== 'all' ? nsF : 'argo'} onClose={() => setTab('workflows')} />
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      {/* ── stats · each tile is also the phase filter ── */}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5'>
        <StatTile
          label='Workflows'
          value={stats.total}
          hint='all namespaces'
          active={phaseF === 'all' && tab === 'workflows'}
          onClick={() => {
            setTab('workflows')
            setPhaseF('all')
          }}
        />
        <PhaseTile label='Running' count={stats.running} tone='progressing' phase='Running' active={phaseF} setTab={setTab} setPhase={setPhaseF} />
        <PhaseTile label='Succeeded' count={stats.succeeded} tone='healthy' phase='Succeeded' active={phaseF} setTab={setTab} setPhase={setPhaseF} />
        <PhaseTile label='Failed' count={stats.failed} tone={stats.failed ? 'failed' : undefined} phase='Failed' active={phaseF} setTab={setTab} setPhase={setPhaseF} />
        <PhaseTile label='Pending' count={stats.pending} tone={stats.pending ? 'info' : undefined} phase='Pending' active={phaseF} setTab={setTab} setPhase={setPhaseF} />
      </div>

      {/* ── search · filters · kind switcher ── */}
      <div className='flex flex-wrap items-center gap-2 rounded-2xl border border-edge-default bg-surface-raised px-3 py-2 shadow-sm'>
        <div className='inline-flex items-center rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5'>
          <TabBtn on={tab === 'workflows'} onClick={() => setTab('workflows')}>Workflows</TabBtn>
          <TabBtn on={tab === 'templates'} onClick={() => setTab('templates')}>Templates</TabBtn>
          <TabBtn on={tab === 'cron'} onClick={() => setTab('cron')}>Cron</TabBtn>
          <TabBtn on={tab === 'designer'} onClick={() => setTab('designer')}>Designer</TabBtn>
        </div>
        <div className='min-w-48 flex-1'>
          <Input
            type='search'
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder='Search name, namespace, entrypoint…'
            aria-label='Search'
          />
        </div>
        {tab === 'workflows' ? (
          <Select
            value={phaseF}
            onChange={(e) => setPhaseF(e.currentTarget.value as PhaseFilter)}
            aria-label='Phase'
            title='Phase'
            options={[
              { value: 'all', label: 'Phase: all' },
              ...PHASES.map((p) => ({ value: p, label: p })),
            ]}
          />
        ) : null}
        <Select
          value={nsF}
          onChange={(e) => setNsF(e.currentTarget.value)}
          aria-label='Namespace'
          title='Namespace'
          options={[
            { value: 'all', label: 'Namespace: all' },
            ...namespaces.map((n) => ({ value: n, label: n })),
          ]}
        />
        {argoUrl ? (
          <ExternalLink className='ml-auto' href={tab === 'templates' ? `${argoUrl}/workflow-templates` : tab === 'cron' ? `${argoUrl}/cron-workflows` : `${argoUrl}/workflows`}>
            Argo Workflows
          </ExternalLink>
        ) : null}
      </div>

      {tab === 'workflows' ? (
        <DataTable<Workflow>
          tableId='develop.argo.workflows'
          loading={wfq.isLoading}
          features={{ columns: true, density: true, export: true }}
          defaultSort={{ key: 'started', dir: 'desc' }}
          columns={workflowColumns()}
          rows={wfRows}
          rowKey={(w) => `${w.metadata.namespace ?? ''}/${w.metadata.name}`}
          onRowClick={(w) => setOpen({ namespace: w.metadata.namespace ?? '', name: w.metadata.name })}
          empty={
            <WorkflowsEmpty
              filtered={workflows.length > 0}
              argoUrl={argoUrl}
              templateCount={templates.length}
            />
          }
        />
      ) : tab === 'templates' ? (
        <DataTable<WorkflowTemplate>
          tableId='develop.argo.workflowtemplates'
          loading={tplq.isLoading}
          features={{ columns: true, density: true, export: true }}
          columns={templateColumns(argoUrl)}
          rows={tplRows}
          rowKey={(t) => `${t.metadata.namespace ?? ''}/${t.metadata.name}`}
          empty={
            isCrdMissing(tplq.error)
              ? <EmptyState compact title='WorkflowTemplates are not registered on this cluster' />
              : (
                <EmptyState
                  compact
                  title={templates.length ? 'No matching templates' : 'No workflow templates'}
                  description={
                    templates.length
                      ? 'Relax the search or the namespace filter.'
                      : 'A WorkflowTemplate is a reusable workflow definition — submit it by name, or reference it from a CronWorkflow, instead of pasting the same spec into every run.'
                  }
                />
              )
          }
        />
      ) : (
        <DataTable<CronWorkflow>
          tableId='develop.argo.cronworkflows'
          loading={cronq.isLoading}
          features={{ columns: true, density: true, export: true }}
          columns={cronColumns(argoUrl)}
          rows={cronRows}
          rowKey={(c) => `${c.metadata.namespace ?? ''}/${c.metadata.name}`}
          empty={
            isCrdMissing(cronq.error)
              ? <EmptyState compact title='CronWorkflows are not registered on this cluster' />
              : (
                <EmptyState
                  compact
                  title={crons.length ? 'No matching cron workflows' : 'No cron workflows'}
                  description={
                    crons.length
                      ? 'Relax the search or the namespace filter.'
                      : 'A CronWorkflow runs a workflow on a schedule — nightly backfills, periodic reports, housekeeping.'
                  }
                />
              )
          }
        />
      )}

      {activeQ.isFetching && !activeQ.isLoading ? (
        <div className='flex items-center gap-2 text-[11px] text-content-subtle'>
          <Spinner /> refreshing
        </div>
      ) : null}

      {open
        ? (
          <WorkflowDrawer
            key={`${open.namespace}/${open.name}`}
            namespace={open.namespace}
            name={open.name}
            argoUrl={argoUrl}
            onClose={() => setOpen(null)}
            onReplace={(next) => setOpen(next)}
          />
        )
        : null}
    </div>
  )
}

/* ─────────── columns ─────────── */

function workflowColumns(): Column<Workflow>[] {
  return [
    {
      key: 'name',
      header: 'Workflow',
      pinned: true,
      minWidth: 200,
      value: (w) => w.metadata.name,
      cell: (w) => (
        <div className='min-w-0'>
          <div className='truncate font-medium text-content'>{w.metadata.name}</div>
          <code className='truncate text-[11px] text-content-subtle'>{w.spec?.entrypoint ?? '—'}</code>
        </div>
      ),
    },
    {
      key: 'namespace',
      header: 'Namespace',
      filter: 'select',
      value: (w) => w.metadata.namespace ?? '',
      cell: (w) => <span className='text-content-muted'>{w.metadata.namespace ?? '—'}</span>,
    },
    {
      key: 'phase',
      header: 'Phase',
      filter: 'select',
      value: (w) => w.status?.phase ?? 'Unknown',
      cell: (w) => {
        const phase = w.status?.phase
        return (
          <span title={w.status?.message}>
            <StatusBadge kind={phase ? (PHASE_KIND[phase] ?? 'unknown') : 'unknown'}>
              {phase ?? 'Unknown'}
            </StatusBadge>
          </span>
        )
      },
    },
    {
      key: 'progress',
      header: 'Progress',
      width: 140,
      value: (w) => progressFraction(w.status?.progress) ?? -1,
      cell: (w) => <ProgressBar progress={w.status?.progress} />,
    },
    {
      key: 'duration',
      header: 'Duration',
      numeric: true,
      value: (w) => durationSecs(w.status?.startedAt, w.status?.finishedAt) ?? -1,
      cell: (w) => fmtDuration(durationSecs(w.status?.startedAt, w.status?.finishedAt)),
    },
    {
      key: 'started',
      header: 'Started',
      value: (w) => (w.status?.startedAt ? new Date(w.status.startedAt).getTime() : 0),
      cell: (w) =>
        w.status?.startedAt
          ? <span title={formatAbsolute(w.status.startedAt)}>{formatRelative(w.status.startedAt)}</span>
          : '—',
    },
  ]
}

function templateColumns(argoUrl: string): Column<WorkflowTemplate>[] {
  const cols: Column<WorkflowTemplate>[] = [
    {
      key: 'name',
      header: 'Template',
      pinned: true,
      minWidth: 200,
      value: (t) => t.metadata.name,
      cell: (t) => <span className='font-medium text-content'>{t.metadata.name}</span>,
    },
    {
      key: 'namespace',
      header: 'Namespace',
      filter: 'select',
      value: (t) => t.metadata.namespace ?? '',
      cell: (t) => <span className='text-content-muted'>{t.metadata.namespace ?? '—'}</span>,
    },
    {
      key: 'entrypoint',
      header: 'Entrypoint',
      value: (t) => t.spec?.entrypoint ?? '',
      cell: (t) => <code className='text-[11px] text-content-muted'>{t.spec?.entrypoint ?? '—'}</code>,
    },
    {
      key: 'steps',
      header: 'Templates',
      numeric: true,
      value: (t) => t.spec?.templates?.length ?? 0,
      cell: (t) => t.spec?.templates?.length ?? 0,
    },
    {
      key: 'created',
      header: 'Created',
      value: (t) => (t.metadata.creationTimestamp ? new Date(t.metadata.creationTimestamp).getTime() : 0),
      cell: (t) =>
        t.metadata.creationTimestamp
          ? <span title={formatAbsolute(t.metadata.creationTimestamp)}>{formatRelative(t.metadata.creationTimestamp)}</span>
          : '—',
    },
  ]
  if (argoUrl) {
    cols.push({
      key: 'open',
      header: '',
      width: 56,
      sortable: false,
      filter: false,
      align: 'right',
      cell: (t) => (
        <ExternalLink
          bare
          href={`${argoUrl}/workflow-templates/${encodeURIComponent(t.metadata.namespace ?? '')}/${encodeURIComponent(t.metadata.name)}`}
        >
          Open
        </ExternalLink>
      ),
    })
  }
  return cols
}

function cronColumns(argoUrl: string): Column<CronWorkflow>[] {
  const cols: Column<CronWorkflow>[] = [
    {
      key: 'name',
      header: 'Cron workflow',
      pinned: true,
      minWidth: 200,
      value: (c) => c.metadata.name,
      cell: (c) => <span className='font-medium text-content'>{c.metadata.name}</span>,
    },
    {
      key: 'namespace',
      header: 'Namespace',
      filter: 'select',
      value: (c) => c.metadata.namespace ?? '',
      cell: (c) => <span className='text-content-muted'>{c.metadata.namespace ?? '—'}</span>,
    },
    {
      key: 'schedule',
      header: 'Schedule',
      value: (c) => scheduleOf(c) ?? '',
      cell: (c) => (
        <span className='flex items-center gap-1.5'>
          <code className='text-[11px] text-content'>{scheduleOf(c) ?? '—'}</code>
          {c.spec?.timezone ? <span className='text-[10px] text-content-subtle'>{c.spec.timezone}</span> : null}
        </span>
      ),
    },
    {
      key: 'suspended',
      header: 'State',
      filter: 'select',
      value: (c) => (c.spec?.suspend ? 'Suspended' : 'Active'),
      cell: (c) => (
        <StatusBadge kind={c.spec?.suspend ? 'paused' : 'healthy'}>
          {c.spec?.suspend ? 'Suspended' : 'Active'}
        </StatusBadge>
      ),
    },
    {
      key: 'entrypoint',
      header: 'Entrypoint',
      value: (c) => c.spec?.workflowSpec?.entrypoint ?? '',
      cell: (c) => (
        <code className='text-[11px] text-content-muted'>{c.spec?.workflowSpec?.entrypoint ?? '—'}</code>
      ),
    },
    {
      key: 'last',
      header: 'Last run',
      value: (c) => (c.status?.lastScheduledTime ? new Date(c.status.lastScheduledTime).getTime() : 0),
      cell: (c) =>
        c.status?.lastScheduledTime
          ? <span title={formatAbsolute(c.status.lastScheduledTime)}>{formatRelative(c.status.lastScheduledTime)}</span>
          : 'never',
    },
  ]
  if (argoUrl) {
    cols.push({
      key: 'open',
      header: '',
      width: 56,
      sortable: false,
      filter: false,
      align: 'right',
      cell: (c) => (
        <ExternalLink
          bare
          href={`${argoUrl}/cron-workflows/${encodeURIComponent(c.metadata.namespace ?? '')}/${encodeURIComponent(c.metadata.name)}`}
        >
          Open
        </ExternalLink>
      ),
    })
  }
  return cols
}

/* ─────────── detail drawer ─────────── */

/*
 * The run, presented the way a pipeline actually reads — the same model as the
 * Tekton PipelineRun drawer: an action bar, a progress strip, status tiles, the
 * stages as a graph you click, a streaming console for the selected stage,
 * then parameters, outputs, timeline, conditions and the raw object.
 *
 * Two layers. `WorkflowDrawer` owns data — the live query, the mutations, the
 * portal. `WorkflowDetail` is presentational and takes the object, so it can
 * be rendered from a fixture with nothing behind it.
 */

const STAGE_W = 196
const STAGE_H = 56
const STAGE_COL_GAP = 96
const STAGE_ROW_GAP = 20

/**
 * Nodes that group other nodes rather than doing work. Argo records the DAG
 * root, step groups and retry wrappers as nodes of their own; drawn literally
 * they double the graph and say nothing. They are collapsed, and edges pass
 * through them to the work they contain.
 */
const CONTAINER_TYPES = new Set(['DAG', 'Steps', 'StepGroup', 'TaskGroup', 'Retry'])

function phaseKind(phase?: string): StatusKind {
  return PHASE_KIND[phase ?? ''] ?? 'unknown'
}

interface StageGraph {
  stages: WorkflowNode[]
  edges: Array<{ from: string; to: string }>
  level: Map<string, number>
}

/** Visible stages, edges routed through the collapsed containers, and levels by longest path. */
function stageGraph(nodes: WorkflowNode[]): StageGraph {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const stages = nodes.filter((n) => !CONTAINER_TYPES.has(n.type ?? ''))
  const visible = new Set(stages.map((n) => n.id))
  const leaves = (id: string, seen: Set<string>): string[] => {
    if (seen.has(id)) return []
    seen.add(id)
    const n = byId.get(id)
    if (!n) return []
    if (visible.has(id)) return [id]
    return (n.children ?? []).flatMap((c) => leaves(c, seen))
  }
  const edges: StageGraph['edges'] = []
  const seenEdge = new Set<string>()
  for (const n of stages) {
    for (const c of n.children ?? []) {
      for (const t of leaves(c, new Set([n.id]))) {
        const k = `${n.id}>${t}`
        if (t === n.id || seenEdge.has(k)) continue
        seenEdge.add(k)
        edges.push({ from: n.id, to: t })
      }
    }
  }
  const parents = new Map<string, string[]>()
  for (const e of edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from])
  const level = new Map<string, number>(stages.map((n) => [n.id, 0]))
  // Bounded by the stage count: terminates on a DAG and refuses to hang on a cycle.
  for (let pass = 0; pass < stages.length; pass++) {
    let changed = false
    for (const n of stages) {
      const ps = parents.get(n.id)
      if (!ps?.length) continue
      const want = 1 + Math.max(...ps.map((p) => level.get(p) ?? 0))
      if (want > (level.get(n.id) ?? 0)) {
        level.set(n.id, want)
        changed = true
      }
    }
    if (!changed) break
  }
  return { stages, edges, level }
}

function isRunningPhase(phase?: string): boolean {
  return phase === 'Running' || phase === 'Pending'
}

function WorkflowDrawer({
  namespace,
  name,
  argoUrl,
  onClose,
  onReplace,
}: {
  namespace: string
  name: string
  argoUrl: string
  onClose(): void
  /** Follow another run in the same drawer (used by Re-run). */
  onReplace(next: { namespace: string; name: string }): void
}) {
  const q = useWorkflow(namespace, name)
  const qc = useQueryClient()
  const toast = useToast()
  const canWrite = useCan('develop')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleted, setDeleted] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['argo-workflows'] })
  const fail = (what: string) => (e: unknown) => toast.error(`${what}: ${e instanceof Error ? e.message : String(e)}`)

  const rerun = useMutation({
    mutationFn: () => resubmitWorkflow(q.data!),
    onSuccess: (created) => {
      invalidate()
      toast.success(`Started ${created.metadata.name}`)
      // Follow the new run here rather than closing — the run just started is
      // the one the operator wants to watch.
      onReplace({ namespace: created.metadata.namespace ?? namespace, name: created.metadata.name })
    },
    onError: fail('Re-run failed'),
  })
  const stop = useMutation({
    mutationFn: (mode: 'Stop' | 'Terminate') => shutdownWorkflow(namespace, name, mode),
    onSuccess: (_r, mode) => { invalidate(); q.refetch(); toast.success(mode === 'Stop' ? 'Stopping — running steps finish, exit handlers run.' : 'Terminating — all pods are being killed.') },
    onError: fail('Could not stop the workflow'),
  })
  const del = useMutation({
    mutationFn: () => deleteWorkflow(namespace, name),
    onSuccess: () => { invalidate(); setDeleted(true); setConfirmDelete(false); toast.success(`Deleted ${name}`) },
    onError: fail('Delete failed'),
  })

  useOverlayDismiss(!confirmDelete, onClose)

  const wfUrl = argoUrl
    ? `${argoUrl}/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
    : ''

  return createPortal(
    <div className='fixed inset-0 z-50 flex justify-end' role='dialog' aria-modal='true' aria-label={`Workflow ${name}`}>
      <button type='button' aria-label='Close' className='absolute inset-0 bg-scrim/40 backdrop-blur-[2px]' onClick={onClose} />
      <aside className='relative flex h-full w-full max-w-5xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl'>
        <WorkflowDetail
          namespace={namespace}
          name={name}
          wf={q.data}
          loading={q.isLoading}
          refreshing={q.isFetching && !q.isLoading}
          error={q.error}
          argoUrl={wfUrl}
          onClose={onClose}
          actions={{
            enabled: canWrite,
            deleted,
            rerun: { run: () => rerun.mutate(), pending: rerun.isPending },
            stop: { run: (mode) => stop.mutate(mode), pending: stop.isPending },
            remove: {
              confirm: confirmDelete,
              ask: () => setConfirmDelete(true),
              cancel: () => setConfirmDelete(false),
              run: () => del.mutate(),
              pending: del.isPending,
            },
          }}
        />
      </aside>
    </div>,
    document.body,
  )
}

export interface WorkflowActions {
  enabled: boolean
  deleted: boolean
  rerun: { run(): void; pending: boolean }
  stop: { run(mode: 'Stop' | 'Terminate'): void; pending: boolean }
  remove: { confirm: boolean; ask(): void; cancel(): void; run(): void; pending: boolean }
}

/** Everything inside the drawer. Presentational: takes the object, never fetches. */
export function WorkflowDetail({
  namespace,
  name,
  wf,
  loading = false,
  refreshing = false,
  error,
  argoUrl,
  onClose,
  actions,
}: {
  namespace: string
  name: string
  wf: Workflow | undefined
  loading?: boolean
  refreshing?: boolean
  error?: unknown
  argoUrl: string
  onClose(): void
  actions?: WorkflowActions
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const nodes = useMemo(() => nodeList(wf), [wf])
  const graph = useMemo(() => stageGraph(nodes), [nodes])
  const phase = wf?.status?.phase
  const kind = phaseKind(phase)
  const running = isRunningPhase(phase)
  const stage = selected ? graph.stages.find((n) => n.id === selected) ?? null : null

  // The first failed stage is what an operator opening a failed run wants to
  // see; a running run opens on its running stage. Neither is forced on a
  // reader who has already picked one.
  useEffect(() => {
    if (selected || !graph.stages.length) return
    const pick = graph.stages.find((n) => n.phase === 'Failed' || n.phase === 'Error')
      ?? graph.stages.find((n) => n.phase === 'Running')
    if (pick) setSelected(pick.id)
  }, [graph.stages, selected])

  const params = wf?.spec?.arguments?.parameters ?? []
  const outParams = wf?.status?.outputs?.parameters ?? []
  const outArtifacts = wf?.status?.outputs?.artifacts ?? []
  const conditions = wf?.status?.conditions ?? []
  const durationText = fmtDuration(durationSecs(wf?.status?.startedAt, wf?.status?.finishedAt))

  return (
    <>
      <header className='flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4'>
        <div className='min-w-0'>
          <div className='text-xs font-semibold uppercase tracking-wider text-content-subtle'>Workflow · {namespace}</div>
          <h2 className='mt-0.5 truncate text-lg font-semibold text-content'>{name}</h2>
          <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-content-muted'>
            argoproj.io/v1alpha1
            {wf?.spec?.entrypoint ? <span>entrypoint {wf.spec.entrypoint}</span> : null}
            {wf?.spec?.workflowTemplateRef?.name ? <span>template {wf.spec.workflowTemplateRef.name}</span> : null}
            {refreshing ? <span className='inline-flex items-center gap-1 text-content-subtle'><Spinner size={12} /> refreshing</span> : null}
          </div>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <StatusBadge kind={kind} pulse={running}>{phase ?? 'Unknown'}</StatusBadge>
          {argoUrl ? <ExternalLink href={argoUrl}>Argo</ExternalLink> : null}
          <button type='button' onClick={onClose} aria-label='Close' className='flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'>
            <IconClose />
          </button>
        </div>
      </header>

      {actions ? (
        <div className='flex flex-wrap items-center gap-2 border-b border-edge-default bg-surface-sunken/50 px-6 py-2.5'>
          {actions.enabled ? (
            <>
              <Button size='sm' variant='secondary' disabled={!wf || actions.rerun.pending || actions.deleted} onClick={actions.rerun.run} title='Start a new run from this run’s spec'>
                <IconRerun /> {actions.rerun.pending ? 'Starting…' : 'Re-run'}
              </Button>
              <Button size='sm' variant='secondary' disabled={!running || actions.stop.pending} onClick={() => actions.stop.run('Stop')} title={running ? 'Let running steps finish, then run exit handlers' : 'Only a running workflow can be stopped'}>
                <IconStopSquare /> {actions.stop.pending ? 'Stopping…' : 'Stop'}
              </Button>
              <Button size='sm' variant='secondary' disabled={!running || actions.stop.pending} onClick={() => actions.stop.run('Terminate')} title={running ? 'Kill every pod now — no exit handlers' : 'Only a running workflow can be terminated'}>
                <IconBolt /> Terminate
              </Button>
              <Button size='sm' variant='danger' disabled={actions.remove.pending || actions.deleted} onClick={actions.remove.ask}>
                <IconTrash /> Delete
              </Button>
            </>
          ) : (
            <span className='inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted'>
              Managing runs needs the <span className='font-medium text-content'>develop</span> capability
            </span>
          )}
          {actions.deleted ? <span className='text-[12px] text-content-muted'>Deleted — this run has been removed.</span> : null}
        </div>
      ) : null}

      {actions?.remove.confirm ? (
        <div className='border-b border-rose-200 bg-rose-50/70 px-6 py-3 dark:border-rose-500/25 dark:bg-rose-500/10' role='alertdialog' aria-label='Confirm delete'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <p className='min-w-0 flex-1 text-[12px] text-content-muted'>
              Delete Workflow <code className='font-mono'>{name}</code>? Its pods and logs go with it. This cannot be undone.
            </p>
            <div className='flex items-center gap-2'>
              <Button size='sm' variant='ghost' onClick={actions.remove.cancel} disabled={actions.remove.pending}>Cancel</Button>
              <Button size='sm' variant='danger' onClick={actions.remove.run} disabled={actions.remove.pending}>{actions.remove.pending ? 'Deleting…' : 'Delete run'}</Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className='min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5'>
        {loading ? (
          <div className='flex items-center gap-2 text-sm text-content-muted'><Spinner /> Loading workflow…</div>
        ) : isNotFound(error) ? (
          <EmptyState compact title='Workflow no longer exists' description='It may have been garbage-collected by the workflow controller.' />
        ) : error ? (
          <EmptyState compact title="Couldn't load this workflow" description={error instanceof Error ? error.message : undefined} />
        ) : (
          <>
            <StageProgress stages={graph.stages} kind={kind} label={phase ?? 'Unknown'} running={running} durationText={durationText} message={wf?.status?.message} />

            <section className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
              <Tile label='Status' kind={kind} value={phase ?? 'Unknown'} />
              <Tile label='Steps' kind='info' value={wf?.status?.progress ?? `${graph.stages.length}`} />
              <Tile label='Duration' kind='info' value={durationText} />
              <Tile label='Started' kind='info' value={wf?.status?.startedAt ? formatRelative(wf.status.startedAt) : '—'} />
            </section>

            <Section title='Stages'>
              {graph.stages.length === 0 ? (
                <EmptyState
                  compact
                  title={wf?.status?.compressedNodes ? 'Node graph is compressed' : running ? 'No stages scheduled yet' : 'No stages recorded'}
                  description={wf?.status?.compressedNodes
                    ? <>The controller stored this run's node map gzipped, which the console cannot inflate.{argoUrl ? <> Open it in <a className='text-brand-700 underline dark:text-brand-300' href={argoUrl} target='_blank' rel='noreferrer'>Argo Workflows ↗</a>.</> : null}</>
                    : 'Stages appear here as the controller schedules them.'}
                />
              ) : (
                <>
                  <StageCanvas graph={graph} selected={selected} onSelect={setSelected} />
                  <p className='mt-2 text-[11px] text-content-subtle'>
                    {stage ? 'The console below streams the selected stage — live while it runs.' : 'Click a stage to open its details and stream its console.'}
                  </p>
                </>
              )}
            </Section>

            {stage ? (
              <Section title={`Console · ${stage.displayName || stage.name}`}>
                <StageConsole key={stage.id} namespace={namespace} node={stage} argoUrl={argoUrl} />
              </Section>
            ) : null}

            <Section title={`Parameters (${params.length})`}>
              {params.length
                ? <KeyValueList rows={params.map((p) => [p.name ?? '—', p.value ?? (p.valueFrom ? 'from: ' + Object.keys(p.valueFrom).join(', ') : '—')])} />
                : <EmptyState compact title='No parameters' />}
            </Section>

            <Section title={`Outputs (${outParams.length + outArtifacts.length})`}>
              {outParams.length || outArtifacts.length
                ? <KeyValueList rows={[
                    ...outParams.map((p): [string, string] => [p.name ?? '—', p.value ?? '—']),
                    ...outArtifacts.map((a): [string, string] => [a.name ?? 'artifact', a.path ?? 'artifact']),
                  ]} />
                : <EmptyState compact title={running ? 'No outputs yet — run in progress' : 'No outputs emitted'} />}
            </Section>

            <Section title='Timeline'>
              <StageTimeline stages={graph.stages} onSelect={setSelected} />
            </Section>

            <Section title={`Conditions (${conditions.length})`}>
              {conditions.length ? (
                <ul className='divide-y divide-edge-subtle'>
                  {conditions.map((c, i) => (
                    <li key={`${c.type ?? 'c'}-${i}`} className='flex items-start gap-3 px-1 py-2 text-sm'>
                      <StatusBadge kind={c.status === 'True' ? (c.type === 'Completed' ? 'healthy' : 'info') : 'unknown'}>{c.type ?? '—'}</StatusBadge>
                      <div className='min-w-0 flex-1'>
                        <div className='text-content'>{c.status ?? '—'}</div>
                        {c.message ? <div className='mt-0.5 text-xs text-content-muted'>{c.message}</div> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState compact title='No conditions reported' />}
            </Section>

            <details className='group rounded-xl border border-edge-default bg-surface-raised'>
              <summary className='cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-content'>Raw object</summary>
              <pre className='max-h-96 overflow-auto border-t border-edge-subtle bg-code p-3 font-mono text-[11px] leading-relaxed text-code-fg'>{JSON.stringify(wf, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </>
  )
}

/* ─────────── stages: progress, canvas, console, timeline ─────────── */

const PROGRESS_SEGMENTS: Array<{ kinds: StatusKind[]; color: string }> = [
  { kinds: ['healthy'], color: '#10b981' },
  { kinds: ['failed', 'degraded'], color: '#f43f5e' },
  { kinds: ['progressing'], color: '#6366f1' },
  { kinds: ['info', 'paused', 'unknown'], color: '#cbd5e1' },
]

function StageProgress({ stages, kind, label, running, durationText, message }: { stages: WorkflowNode[]; kind: StatusKind; label: string; running: boolean; durationText: string; message?: string }) {
  const counts = new Map<StatusKind, number>()
  for (const n of stages) counts.set(phaseKind(n.phase), (counts.get(phaseKind(n.phase)) ?? 0) + 1)
  const total = stages.length
  const done = (counts.get('healthy') ?? 0) + (counts.get('failed') ?? 0)
  return (
    <div className='rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <StatusBadge kind={kind} pulse={running}>{label}</StatusBadge>
          <span className='text-[12px] text-content-muted'>{total ? `${done} of ${total} stages complete` : 'No stages'}</span>
        </div>
        <span className='font-mono text-[12px] tabular-nums text-content-muted'>{durationText}</span>
      </div>
      <div className='mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken'>
        {total ? PROGRESS_SEGMENTS.map((seg, i) => {
          const n = seg.kinds.reduce((s, k) => s + (counts.get(k) ?? 0), 0)
          if (!n) return null
          return <span key={i} className={cn('h-full transition-[width] duration-500', seg.color === '#6366f1' && running && 'animate-pulse')} style={{ width: `${(n / total) * 100}%`, backgroundColor: seg.color }} />
        }) : null}
      </div>
      {message ? <p className='mt-2 text-xs leading-relaxed text-content-muted'>{message}</p> : null}
    </div>
  )
}

/**
 * The stage graph. Pills laid out by dependency level on the shared canvas —
 * status on the glyph, name and duration beside it, one quiet outline. The
 * connectors carry no colour; the legend and the zoom cluster live in the
 * canvas footer.
 */
function StageCanvas({ graph, selected, onSelect }: { graph: StageGraph; selected: string | null; onSelect(id: string): void }) {
  const [onlyProblems, setOnlyProblems] = useState(false)
  const laid = useMemo(() => {
    const layout = layoutLayers(
      graph.stages.map((n) => ({ id: n.id, level: graph.level.get(n.id) ?? 0 })),
      { nodeWidth: STAGE_W, nodeHeight: STAGE_H, colGap: STAGE_COL_GAP, rowGap: STAGE_ROW_GAP },
    )
    const byId = new Map(graph.stages.map((n) => [n.id, n]))
    const edges: CanvasEdge[] = []
    for (const e of graph.edges) {
      const from = layout.pos.get(e.from)
      const to = layout.pos.get(e.to)
      if (!from || !to) continue
      edges.push({ ...edgeBetween(from, to, layout.nodeWidth, layout.nodeHeight), kind: phaseKind(byId.get(e.from)?.phase), flowing: byId.get(e.from)?.phase === 'Running' })
    }
    return { layout, edges }
  }, [graph])

  const legend = useMemo(() => {
    const seen = new Map<StatusKind, string>()
    for (const n of graph.stages) if (n.phase) seen.set(phaseKind(n.phase), n.phase)
    return [...seen].map(([kind, label]) => ({ kind, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [graph.stages])

  const problem = (n: WorkflowNode) => n.phase === 'Failed' || n.phase === 'Error'

  return (
    <GraphCanvas
      width={laid.layout.width}
      height={laid.layout.height}
      edges={laid.edges}
      legend={legend}
      // A static class on purpose: Tailwind only emits classes it can see in
      // source, so a computed `h-[…px]` is never generated and the canvas
      // collapses to its footer. Fit-to-view makes a fixed height fine.
      className='h-[380px]'
      ariaLabel={`Stage graph — ${graph.stages.length} stages`}
      toolbar={<CanvasBtn label='Only failed stages' active={onlyProblems} onClick={() => setOnlyProblems((v) => !v)}>!</CanvasBtn>}
    >
      {graph.stages.map((n) => {
        const p = laid.layout.pos.get(n.id)
        if (!p) return null
        return (
          <div key={n.id} className={cn('adhar-node-in absolute transition-opacity', onlyProblems && !problem(n) && 'opacity-30')} style={{ left: p.x, top: p.y, width: STAGE_W, height: STAGE_H }}>
            <StagePill node={n} selected={selected === n.id} onClick={() => onSelect(n.id)} />
          </div>
        )
      })}
    </GraphCanvas>
  )
}

const GLYPH_TONE: Record<StatusKind, string> = {
  healthy: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  failed: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  degraded: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  progressing: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  info: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  paused: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  unknown: 'bg-surface-sunken text-content-subtle',
}

function PhaseGlyph({ kind }: { kind: StatusKind }) {
  const P = ({ d }: { d: string }) => <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round' aria-hidden><path d={d} /></svg>
  if (kind === 'healthy') return <P d='m5 12 5 5L20 7' />
  if (kind === 'failed' || kind === 'degraded') return <P d='M18 6 6 18M6 6l12 12' />
  if (kind === 'progressing') return <span className='h-2.5 w-2.5 rounded-full bg-current' />
  if (kind === 'paused') return <P d='M8 5v14M16 5v14' />
  if (kind === 'info') return <span className='h-2.5 w-2.5 rounded-full border-2 border-current' />
  return <P d='M6 12h12' />
}

function StagePill({ node, selected, onClick }: { node: WorkflowNode; selected: boolean; onClick(): void }) {
  const kind = phaseKind(node.phase)
  const live = node.phase === 'Running'
  const sub = node.startedAt
    ? `${fmtDuration(durationSecs(node.startedAt, node.finishedAt))}${node.type && node.type !== 'Pod' ? ` · ${node.type}` : ''}`
    : node.phase ?? 'Pending'
  return (
    <button
      type='button'
      onClick={onClick}
      title={`${node.displayName || node.name} — ${node.phase ?? 'Pending'}`}
      className={cn(
        'flex h-full w-full items-center gap-2.5 rounded-full border bg-surface-raised px-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg',
        // One neutral outline; status lives in the glyph, never on the container.
        selected ? 'border-brand-400 ring-2 ring-brand-400/40' : 'border-edge-default',
      )}
      style={live ? { boxShadow: '0 0 0 3px rgb(99 102 241 / 0.15)' } : undefined}
    >
      <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', GLYPH_TONE[kind], live && 'animate-pulse')}>
        <PhaseGlyph kind={kind} />
      </span>
      <span className='min-w-0 flex-1'>
        <span className='block truncate text-[12px] font-semibold text-content'>{node.displayName || node.name}</span>
        <span className='block truncate text-[10px] text-content-subtle'>{sub}</span>
      </span>
    </button>
  )
}

const CONTAINERS = ['main', 'init', 'wait'] as const

/**
 * The selected stage: facts, message, and its console — streamed, following
 * while it runs, one container at a time. Logs are only offered when Argo
 * itself recorded the pod name on the node: pod naming changed between Argo
 * versions and the node does not always carry it, so anything else would be
 * a guess that 404s.
 */
function StageConsole({ namespace, node, argoUrl }: { namespace: string; node: WorkflowNode; argoUrl: string }) {
  const kind = phaseKind(node.phase)
  const running = node.phase === 'Running'
  const podName = node.type === 'Pod' ? node.podName : undefined
  const [container, setContainer] = useState<(typeof CONTAINERS)[number]>('main')
  const nodeUrl = argoUrl ? `${argoUrl}?nodeId=${encodeURIComponent(node.id)}&sidePanel=${encodeURIComponent(`logs:${node.id}:main`)}` : ''

  const sources = useMemo(() => (podName ? [{ pod: podName, container, label: container }] : []), [podName, container])
  const stream = useLogStream({ namespace, sources, follow: running, tailLines: 8000, enabled: Boolean(podName) })

  return (
    <div className='overflow-hidden rounded-xl border border-edge-default'>
      <div className='flex flex-wrap items-center gap-2 border-b border-edge-default bg-surface-sunken/50 px-3 py-2'>
        <StatusBadge kind={kind} pulse={running}>{node.phase ?? 'Pending'}</StatusBadge>
        <span className='font-mono text-[12px] font-semibold text-content'>{node.displayName || node.name}</span>
        {node.templateName || node.templateRef?.template ? <code className='text-[11px] text-content-muted'>{node.templateName ?? node.templateRef?.template}</code> : null}
        <span className='ml-auto text-[11px] text-content-subtle'>{fmtDuration(durationSecs(node.startedAt, node.finishedAt))}</span>
      </div>
      <dl className='grid grid-cols-2 gap-x-6 gap-y-2 border-b border-edge-subtle px-3 py-2.5 text-[11.5px] sm:grid-cols-4'>
        <Fact label='Type' value={node.type ?? '—'} />
        <Fact label='Started' value={node.startedAt ? formatAbsolute(node.startedAt) : '—'} />
        <Fact label='Finished' value={node.finishedAt ? formatAbsolute(node.finishedAt) : running ? 'running' : '—'} />
        {podName ? <Fact label='Pod' value={podName} mono /> : <Fact label='Node id' value={node.id} mono />}
        {node.hostNodeName ? <Fact label='Host' value={node.hostNodeName} mono /> : null}
        {node.progress ? <Fact label='Progress' value={node.progress} /> : null}
      </dl>
      {node.message ? <p className='border-b border-edge-subtle px-3 py-2 text-xs leading-relaxed text-content-muted'>{node.message}</p> : null}
      {podName ? (
        <LogConsole
          lines={stream.lines}
          status={stream.status}
          error={stream.error}
          reconnect={stream.reconnect}
          label={`${node.displayName || node.name} · ${container}`}
          live={running}
          filename={`${node.displayName || node.name}-${container}`}
          emptyMessage={running ? 'No log output yet.' : 'No log output.'}
          toolbar={
            <span className='inline-flex items-center rounded-md bg-surface-sunken p-0.5'>
              {CONTAINERS.map((c) => (
                <button key={c} type='button' onClick={() => setContainer(c)} aria-pressed={container === c} className={cn('h-5 rounded px-1.5 font-mono text-[10px]', container === c ? 'bg-surface-raised text-content shadow-sm' : 'text-content-subtle hover:text-content')}>
                  {c}
                </button>
              ))}
            </span>
          }
        />
      ) : (
        <div className='px-3 py-5'>
          <EmptyState
            compact
            title={node.type === 'Pod' ? 'No pod recorded for this stage' : `${node.type ?? 'This'} stages have no container`}
            description={node.type === 'Pod'
              ? <>Argo did not record the pod name on this node, so its logs cannot be read here.{nodeUrl ? <> Open it in <a className='text-brand-700 underline dark:text-brand-300' href={nodeUrl} target='_blank' rel='noreferrer'>Argo Workflows ↗</a>.</> : null}</>
              : 'Only pod stages produce logs.'}
          />
        </div>
      )}
    </div>
  )
}

function StageTimeline({ stages, onSelect }: { stages: WorkflowNode[]; onSelect(id: string): void }) {
  const rows = useMemo(() => [...stages].sort((a, b) => new Date(a.startedAt ?? '9999').getTime() - new Date(b.startedAt ?? '9999').getTime()), [stages])
  if (!rows.length) return <EmptyState compact title='No stages to time' />
  return (
    <ul className='divide-y divide-edge-subtle'>
      {rows.map((n) => (
        <li key={n.id}>
          <button type='button' onClick={() => onSelect(n.id)} className='flex w-full items-center justify-between gap-3 rounded-md px-1.5 py-2 text-left text-sm transition-colors hover:bg-surface-sunken'>
            <div className='min-w-0'>
              <div className='truncate font-medium text-content'>{n.displayName || n.name}</div>
              <div className='text-[11px] text-content-subtle'>
                {n.startedAt ? `started ${formatRelative(n.startedAt)} · ${fmtDuration(durationSecs(n.startedAt, n.finishedAt))}` : 'not started'}
              </div>
            </div>
            <StatusBadge kind={phaseKind(n.phase)}>{n.phase ?? 'Pending'}</StatusBadge>
          </button>
        </li>
      ))}
    </ul>
  )
}

/* ─────────── drawer chrome ─────────── */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='rounded-xl border border-edge-default bg-surface-raised'>
      <div className='border-b border-edge-subtle px-4 py-2.5 text-sm font-semibold text-content'>{title}</div>
      <div className='p-4'>{children}</div>
    </section>
  )
}

const TILE_TEXT: Record<string, string> = {
  healthy: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-rose-700 dark:text-rose-300',
  degraded: 'text-rose-700 dark:text-rose-300',
  progressing: 'text-indigo-700 dark:text-indigo-300',
  paused: 'text-amber-700 dark:text-amber-300',
}

function Tile({ label, kind, value }: { label: string; kind: StatusKind; value: string }) {
  return (
    <div className='rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5'>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</div>
      <div className={cn('mt-0.5 truncate text-[15px] font-semibold tabular-nums', TILE_TEXT[kind] ?? 'text-content')} title={value}>{value}</div>
    </div>
  )
}

function KeyValueList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className='divide-y divide-edge-subtle text-sm'>
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`} className='flex items-baseline justify-between gap-4 py-1.5'>
          <span className='shrink-0 text-content-muted'>{k}</span>
          <code className='min-w-0 truncate font-mono text-xs text-content' title={v}>{v}</code>
        </div>
      ))}
    </div>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className='min-w-0'>
      <dt className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</dt>
      <dd className={cn('truncate text-content', mono && 'font-mono text-[11px]')} title={value}>{value}</dd>
    </div>
  )
}

const I = ({ children, size = 13 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden className='shrink-0'>{children}</svg>
)
const IconClose = () => <I size={16}><path d='M18 6 6 18M6 6l12 12' /></I>
const IconRerun = () => <I><path d='M21 12a9 9 0 1 1-3-6.7L21 8' /><path d='M21 3v5h-5' /></I>
const IconStopSquare = () => <I><rect x='6' y='6' width='12' height='12' rx='2' /></I>
const IconBolt = () => <I><path d='M13 2 4 14h7l-1 8 9-12h-7z' /></I>
const IconTrash = () => <I><path d='M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6' /></I>

/* ─────────── empty state ─────────── */

function WorkflowsEmpty({
  filtered,
  argoUrl,
  templateCount,
}: {
  filtered: boolean
  argoUrl: string
  templateCount: number
}) {
  if (filtered) {
    return (
      <EmptyState compact title='No matching workflows' description='Relax the phase, namespace or search filter.' />
    )
  }
  return (
    <EmptyState
      title='No workflows have run yet'
      description={
        <>
          Argo Workflows runs everything on this platform that is a DAG of containers but isn't CI —
          data backfills, ML training, scheduled housekeeping, fan-out batch jobs. CI itself is Tekton
          and lives under Platform → CI / CD.
          {templateCount > 0
            ? <> This cluster already has {templateCount} workflow template{templateCount === 1 ? '' : 's'} you can submit from.</>
            : (
              <>
                {' '}Start by writing a <code className='font-mono'>Workflow</code> or a reusable{' '}
                <code className='font-mono'>WorkflowTemplate</code>.
              </>
            )}{' '}
          <a className='text-brand-700 underline dark:text-brand-300' href={ARGO_WRITING_DOCS} target='_blank' rel='noreferrer'>
            Workflow concepts ↗
          </a>
        </>
      }
      action={argoUrl ? <ExternalLink href={`${argoUrl}/workflows`}>Open Argo Workflows</ExternalLink> : undefined}
    />
  )
}

/* ─────────── small parts ─────────── */

function StatTile({
  label,
  value,
  hint,
  tone,
  active = false,
  onClick,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: StatusKind
  active?: boolean
  onClick?(): void
}) {
  const toneText: Record<string, string> = {
    healthy: 'text-emerald-600 dark:text-emerald-300',
    degraded: 'text-amber-600 dark:text-amber-300',
    failed: 'text-rose-600 dark:text-rose-300',
    progressing: 'text-indigo-600 dark:text-indigo-300',
    info: 'text-sky-600 dark:text-sky-300',
  }
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? active : undefined}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
        active
          ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10'
          : 'border-edge-default bg-surface-raised hover:border-edge-strong',
        !onClick && 'cursor-default',
      )}
    >
      <span className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</span>
      <span className={cn('text-xl font-semibold leading-none tabular-nums tracking-tight', tone ? toneText[tone] : 'text-content')}>
        {value}
      </span>
      {hint ? <span className='truncate text-[10.5px] text-content-subtle'>{hint}</span> : null}
    </button>
  )
}

function PhaseTile({
  label,
  count,
  tone,
  phase,
  active,
  setTab,
  setPhase,
}: {
  label: string
  count: number
  tone?: StatusKind
  phase: PhaseFilter
  active: PhaseFilter
  setTab(t: Tab): void
  setPhase(p: PhaseFilter): void
}) {
  return (
    <StatTile
      label={label}
      value={count}
      tone={tone}
      active={active === phase}
      onClick={() => {
        setTab('workflows')
        setPhase(active === phase ? 'all' : phase)
      }}
    />
  )
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
        on ? 'bg-surface-raised text-content shadow-sm' : 'text-content-subtle hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function ProgressBar({ progress }: { progress?: string }) {
  const frac = progressFraction(progress)
  if (frac === undefined) return <span className='text-content-subtle'>—</span>
  return (
    <span className='flex items-center gap-2'>
      <span className='h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken'>
        <span
          className='block h-full rounded-full bg-brand-500'
          style={{ width: `${Math.round(frac * 100)}%` }}
        />
      </span>
      <span className='text-[11px] tabular-nums text-content-muted'>{progress}</span>
    </span>
  )
}

function ExternalLink({
  href,
  children,
  className,
  bare = false,
}: {
  href: string
  children: ReactNode
  className?: string
  /** Text-only, for use inside a table cell. */
  bare?: boolean
}) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noreferrer'
      onClick={(e) => e.stopPropagation()}
      className={cn(
        bare
          ? 'text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300'
          : 'inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700',
        className,
      )}
    >
      {children} <span aria-hidden>↗</span>
    </a>
  )
}

/* ─────────── helpers ─────────── */

/** Argo reports progress as `done/total`. */
function progressFraction(progress?: string): number | undefined {
  if (!progress) return undefined
  const [done, total] = progress.split('/').map((n) => Number(n))
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return undefined
  return Math.min(1, Math.max(0, done / total))
}

/** Argo ≥ 3.6 moved the single `schedule` to a `schedules` list. */
function scheduleOf(c: CronWorkflow): string | undefined {
  return c.spec?.schedules?.join(', ') || c.spec?.schedule
}

export default WorkflowList
