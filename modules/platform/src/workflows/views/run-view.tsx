import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Can,
  canResource,
  detectSeverity,
  EmptyState,
  LogConsole,
  type LogLine,
  StatusBadge,
  Tabs,
  useToast,
  useToolPublicUrl,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { YamlView } from '../../components/yaml-view.tsx'
import { toYaml } from '../../data/manifest-yaml.ts'
import { artifactUrl, type Capabilities, getRunLogs, getTemplate, retryRun } from '../data/api.ts'
import { pendingApprovals } from '../data/approvals.ts'
import { entryOf, templateVersion } from '../data/catalog.ts'
import { LABEL, WORKFLOWS } from '../data/gvr.ts'
import { useInvalidateWorkflows, useIsPlatformStaff, useNow, useRun, useRunEvents, useWorkflowCluster } from '../data/hooks.ts'
import {
  elapsedMs,
  isFinished,
  logNodeFor,
  nodeStatus,
  nodesUnder,
  podNodes,
  progressOf,
  runGraph,
  type RunGraphNode,
  shortDuration,
  submitterOf,
  templateOf,
  timelineRows,
  triggerOf,
  type WfNode,
  type Workflow,
} from '../data/nodes.ts'
import { ApprovalCard } from './approval-card.tsx'
import { Drawer, ErrorNote, Loading, RunPhase } from './common.tsx'
import { RunActions } from './run-actions.tsx'

/**
 * The run view (design 0026 §6.9): one run, live from its own watch — header,
 * actions, and the Graph / Timeline / Logs / Inputs & outputs / Events / YAML
 * tabs, with a node panel for the selected step (attempts, logs, outputs,
 * "Retry from here", and the approval card for a waiting suspend node).
 *
 * The graph is the only part that needs React Flow, and it is loaded when the
 * Graph tab first renders — never by the overview or the lists that open this
 * drawer (W1 acceptance 5).
 */

const WorkflowCanvas = lazy(() => import('../canvas/workflow-canvas.tsx'))

type Tab = 'graph' | 'timeline' | 'logs' | 'io' | 'events' | 'yaml'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'graph', label: 'Graph' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'logs', label: 'Logs' },
  { id: 'io', label: 'Inputs & outputs' },
  { id: 'events', label: 'Events' },
  { id: 'yaml', label: 'YAML' },
]

export interface RunViewProps {
  namespace: string
  name: string
  tab?: string
  node?: string
  caps: Capabilities
  onClose(): void
  onParams(p: { tab?: string; node?: string }): void
}

export function RunView({ namespace, name, tab, node, caps, onClose, onParams }: RunViewProps) {
  const r = useRun(namespace, name)
  const run = r.run
  const active = (TABS.some((t) => t.id === tab) ? tab : 'graph') as Tab
  const now = useNow(Boolean(run && !isFinished(run)))
  const graph = useMemo(() => (run && r.nodes ? runGraph(run, r.nodes) : null), [run, r.nodes])
  const argoUi = useToolPublicUrl('argo-workflows')
  const staff = useIsPlatformStaff()

  return (
    <Drawer
      widthKey="workflow-run"
      eyebrow={`Workflow run · ${namespace}`}
      title={name}
      badge={run ? <RunPhase run={run} /> : null}
      onClose={onClose}
      actions={
        <>
          {run ? <RunActions run={run} onDeleted={onClose} /> : null}
          {staff && argoUi ? (
            <a className="inline-flex h-8 items-center rounded-md px-2 text-xs text-content-muted hover:bg-surface-sunken hover:text-content" href={`${argoUi}/workflows/${namespace}/${name}`} target="_blank" rel="noreferrer">
              Open in Argo UI ↗
            </a>
          ) : null}
        </>
      }
    >
      {r.isLoading ? <Loading label="Loading the run…" /> : r.error ? <ErrorNote title="Could not read this run" error={r.error} /> : r.gone || !run ? (
        <div className="p-6">
          <EmptyState
            title="This run is no longer on the cluster"
            description="Finished runs are removed after their TTL (a day after success, three after failure). If the archive is on, it is in History."
          />
        </div>
      ) : (
        <div className="space-y-4 p-4 sm:p-5">
          <RunHeader run={run} now={now} />
          <Tabs tabs={TABS} value={active} onChange={(t) => onParams({ tab: t })} ariaLabel="Run views">
            {() => (
              <div className="pt-3">
                {active === 'graph' ? (
                  r.nodes === null && r.hydrated ? (
                    <EmptyState compact tone="error" title="The run's node status could not be read" description="It is offloaded or compressed in a form the browser cannot read, and argo-server did not return it." />
                  ) : !graph ? <Loading label="Reading the run's steps…" /> : graph.nodes.length === 0 ? (
                    <EmptyState compact title="No steps yet" description="The controller has not started this run." />
                  ) : (
                    <div className="space-y-3">
                      <Suspense fallback={<Loading label="Loading the graph…" />}>
                        <WorkflowCanvas mode="run" graph={graph} now={now} selected={node ?? null} onSelect={(id) => onParams({ node: id === node ? undefined : id })} />
                      </Suspense>
                      {node && r.nodes ? (
                        <NodePanel run={run} nodes={r.nodes} task={graph.nodes.find((n) => n.id === node)} now={now} caps={caps} />
                      ) : (
                        <p className="text-xs text-content-subtle">Select a step to see its attempts, logs and outputs.</p>
                      )}
                    </div>
                  )
                ) : null}
                {active === 'timeline' ? <Timeline nodes={r.nodes ?? {}} now={now} /> : null}
                {active === 'logs' ? <RunLogs run={run} nodes={r.nodes ?? {}} initialNode={graph?.nodes.find((n) => n.id === node)?.nodeId} /> : null}
                {active === 'io' ? <InputsOutputs run={run} nodes={r.nodes ?? {}} caps={caps} /> : null}
                {active === 'events' ? <RunEvents namespace={namespace} name={name} /> : null}
                {active === 'yaml' ? <YamlView value={toYaml(stripManaged(run))} ariaLabel={`YAML of ${name}`} /> : null}
              </div>
            )}
          </Tabs>
        </div>
      )}
    </Drawer>
  )
}

function stripManaged(w: Workflow): Record<string, unknown> {
  const { managedFields: _m, ...metadata } = w.metadata as Workflow['metadata'] & { managedFields?: unknown }
  return { ...w, metadata } as unknown as Record<string, unknown>
}

/* ─────────────────────────── header ─────────────────────────── */

const TRIGGER_TEXT = { manual: 'Manual', cron: 'Schedule', event: 'Event', resubmit: 'Resubmit' } as const

function RunHeader({ run, now }: { run: Workflow; now: number }) {
  const { cluster } = useWorkflowCluster()
  const trig = triggerOf(run)
  const tpl = templateOf(run)
  const prog = progressOf(run.status?.progress)
  const ranVersion = run.metadata.labels?.[LABEL.templateSpecHash]
  const current = useQuery({
    queryKey: ['workflows', 'template-version', cluster, run.metadata.namespace, tpl?.cluster, tpl?.name],
    queryFn: async () => {
      if (!tpl) return null
      const kind = tpl.cluster ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate'
      const t = await getTemplate(kind, run.metadata.namespace, tpl.name, cluster)
      return t ? await templateVersion(entryOf(t, kind)) : null
    },
    enabled: Boolean(tpl && ranVersion),
    staleTime: 60_000,
  })
  const elapsed = elapsedMs(run.status?.startedAt, run.status?.finishedAt, now)
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-edge-default bg-surface-raised p-4 text-sm sm:grid-cols-4">
      <Meta label="Template">
        {tpl ? <span className="font-mono text-[13px]">{tpl.cluster ? 'cluster/' : ''}{tpl.name}</span> : <span className="text-content-subtle">inline</span>}
        {ranVersion ? (
          <div className="text-[11px] text-content-subtle">
            ran version <span className="font-mono">{ranVersion.slice(0, 8)}</span>
            {current.data && current.data !== ranVersion ? <Badge tone="amber" className="ml-1">template changed since</Badge> : null}
          </div>
        ) : null}
      </Meta>
      <Meta label="Trigger">
        {TRIGGER_TEXT[trig.kind]}
        {trig.detail ? <div className="truncate font-mono text-[11px] text-content-subtle">{trig.detail}</div> : null}
      </Meta>
      <Meta label="Submitted by">{submitterOf(run) ?? <span className="text-content-subtle">unknown</span>}</Meta>
      <Meta label={isFinished(run) ? 'Duration' : 'Elapsed'}>
        {shortDuration(elapsed)}
        {run.status?.startedAt ? <div className="text-[11px] text-content-subtle" title={formatAbsolute(run.status.startedAt)}>started {formatRelative(run.status.startedAt)}</div> : null}
      </Meta>
      {prog ? (
        <Meta label="Progress">
          <div className="flex items-center gap-2">
            <span className="tabular-nums">{prog.done}/{prog.total}</span>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken"><span className="block h-full bg-brand-500" style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} /></span>
          </div>
        </Meta>
      ) : null}
      {run.metadata.labels?.[LABEL.resubmittedFrom] ? <Meta label="Resubmitted from"><span className="font-mono text-[13px]">{run.metadata.labels[LABEL.resubmittedFrom]}</span></Meta> : null}
      {run.status?.message ? <div className="col-span-2 sm:col-span-4"><Meta label="Message"><span className="text-content-muted">{run.status.message}</span></Meta></div> : null}
    </dl>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-content">{children}</dd>
    </div>
  )
}

/* ─────────────────────────── node panel ─────────────────────────── */

function NodePanel({ run, nodes, task, now, caps }: { run: Workflow; nodes: Record<string, WfNode>; task: RunGraphNode | undefined; now: number; caps: Capabilities }) {
  const { cluster } = useWorkflowCluster()
  const toast = useToast()
  const refresh = useInvalidateWorkflows()
  if (!task) return null
  const under = nodesUnder(nodes, task.nodeId)
  const attempts = under.filter((n) => n.type === 'Pod' || n.type === 'Container')
  const approvals = pendingApprovals(run, Object.fromEntries(under.map((n) => [n.id, n])))
  const own = task.nodeId ? nodes[task.nodeId] : undefined
  const ns = run.metadata.namespace ?? ''
  const failed = task.status === 'failed'
  return (
    <div className="space-y-3 rounded-xl border border-edge-default bg-surface-raised p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-content">{task.label}</h3>
        <StatusBadge kind={task.status}>{task.awaitingApproval ? 'Waiting for approval' : task.phase ?? 'Not started'}</StatusBadge>
        {task.attempts && task.attempts > 1 ? <Badge>{task.attempts} attempts</Badge> : null}
        <span className="ml-auto text-xs text-content-subtle tabular-nums">{shortDuration(elapsedMs(task.startedAt, task.finishedAt, now))}</span>
      </div>
      {task.message ? <p className="text-xs text-content-muted">{task.message}</p> : null}
      {approvals.map((a) => <ApprovalCard key={a.nodeId} approval={a} />)}
      {attempts.length ? (
        <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-subtle text-xs">
          {attempts.map((n) => (
            <li key={n.id} className="flex items-center gap-2 px-3 py-1.5">
              <StatusBadge kind={nodeStatus(n.phase, n.type)}>{n.phase ?? '—'}</StatusBadge>
              <span className="font-mono">{n.displayName ?? n.name}</span>
              <span className="ml-auto text-content-subtle tabular-nums">{shortDuration(elapsedMs(n.startedAt, n.finishedAt, now))}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {own?.outputs?.parameters?.length ? (
        <div className="text-xs">
          <div className="mb-1 font-medium text-content-muted">Outputs</div>
          <ParamTable params={own.outputs.parameters} />
        </div>
      ) : null}
      {own?.outputs?.artifacts?.length && caps.artifactNamespaces.includes(ns) ? (
        <ul className="flex flex-wrap gap-2 text-xs">
          {own.outputs.artifacts.map((a) => (
            <li key={a.name}><a className="text-brand-600 hover:underline dark:text-brand-400" href={artifactUrl(ns, run.metadata.name, own.id, a.name, cluster)}>⬇ {a.name}</a></li>
          ))}
        </ul>
      ) : null}
      {failed && task.nodeId && caps.argoServer.reachable ? (
        <Can check={canResource(WORKFLOWS, 'update', { namespace: ns })}>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              try {
                await retryRun(ns, run.metadata.name, { nodeId: task.nodeId, restartSuccessful: true }, cluster)
                toast.success(`Retrying from ${task.label}`)
                refresh()
              } catch (e) {
                toast.error('Could not retry from here', { description: e instanceof Error ? e.message : String(e) })
              }
            }}
          >
            Retry from here
          </Button>
        </Can>
      ) : null}
    </div>
  )
}

export function ParamTable({ params }: { params: Array<{ name: string; value?: string; default?: string }> }) {
  return (
    <table className="w-full text-left">
      <tbody>
        {params.map((p) => (
          <tr key={p.name} className="border-t border-edge-subtle first:border-0">
            <td className="py-1 pr-3 font-mono text-content-muted">{p.name}</td>
            <td className="break-all py-1 font-mono text-content">{p.value ?? p.default ?? <span className="text-content-subtle">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* ─────────────────────────── timeline ─────────────────────────── */

function Timeline({ nodes, now }: { nodes: Record<string, WfNode>; now: number }) {
  const rows = timelineRows(nodes)
  if (!rows.length) return <EmptyState compact title="Nothing has started yet" />
  const start = Math.min(...rows.map((r) => r.start))
  const end = Math.max(...rows.map((r) => r.end ?? now), start + 1)
  const span = end - start
  return (
    <div className="space-y-1 rounded-xl border border-edge-default bg-surface-raised p-3" role="table" aria-label="Step timeline">
      {rows.map((r) => {
        const left = ((r.start - start) / span) * 100
        const width = Math.max(0.6, (((r.end ?? now) - r.start) / span) * 100)
        const kind = nodeStatus(r.phase, r.type)
        return (
          <div key={r.id} role="row" className="grid grid-cols-[minmax(8rem,14rem)_1fr_4.5rem] items-center gap-2 text-xs">
            <span role="cell" className="truncate font-mono text-content-muted" title={r.label}>{r.label}</span>
            <span role="cell" className="relative h-4 rounded bg-surface-sunken">
              <span
                className={cn('absolute inset-y-0 rounded', kind === 'healthy' ? 'bg-emerald-500' : kind === 'failed' ? 'bg-rose-500' : kind === 'paused' ? 'bg-amber-500' : kind === 'progressing' ? 'bg-indigo-500' : 'bg-slate-400')}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </span>
            <span role="cell" className="text-right tabular-nums text-content-subtle">{shortDuration((r.end ?? now) - r.start)}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ─────────────────────────── logs ─────────────────────────── */

type Container = 'main' | 'wait' | 'init'

function RunLogs({ run, nodes, initialNode }: { run: Workflow; nodes: Record<string, WfNode>; initialNode?: string }) {
  const { cluster } = useWorkflowCluster()
  const pods = podNodes(nodes)
  const [picked, setNodeId] = useState<string | undefined>(undefined)
  // Re-derived each render: pods appear after the tab has opened.
  const nodeId = logNodeFor(nodes, picked, initialNode)
  const [container, setContainer] = useState<Container>('main')
  const node = nodeId ? nodes[nodeId] : undefined
  const running = node?.phase === 'Running' || node?.phase === 'Pending'
  const ns = run.metadata.namespace ?? ''
  const q = useQuery({
    queryKey: ['workflows', 'logs', cluster, ns, run.metadata.name, nodeId, container],
    queryFn: () => getRunLogs(ns, run.metadata.name, { node: nodeId!, container, tail: 2000 }, cluster),
    enabled: Boolean(nodeId),
    // Logs are not a Kubernetes object: there is nothing to watch. A running
    // step re-reads its tail; a finished one is read once.
    refetchInterval: running ? 4_000 : false,
    retry: false,
  })
  const lines: LogLine[] = useMemo(() => (q.data?.lines ?? []).map((text) => ({ text, severity: detectSeverity(text) })), [q.data])
  if (!pods.length) return <EmptyState compact title="No step has run a pod yet" />
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs"
          value={nodeId ?? ''}
          onChange={(e) => setNodeId(e.currentTarget.value)}
          aria-label="Step"
        >
          {pods.map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.name} · {p.phase}</option>)}
        </select>
        <div className="inline-flex rounded-md border border-edge-default p-0.5" role="tablist" aria-label="Container">
          {(['main', 'init', 'wait'] as const).map((c) => (
            <button key={c} type="button" role="tab" aria-selected={container === c} onClick={() => setContainer(c)} className={cn('rounded px-2 py-1', container === c ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted')}>
              {c}
            </button>
          ))}
        </div>
        {q.data ? <Badge tone={q.data.source === 'loki' ? 'violet' : 'emerald'}>{q.data.source === 'loki' ? 'Loki' : 'live'}</Badge> : null}
        {q.data?.note ? <span className="text-content-subtle">{q.data.note}</span> : null}
      </div>
      {q.error ? (
        <ErrorNote title="Could not read the logs" error={q.error} />
      ) : (
        <LogConsole
          lines={lines}
          status={q.isLoading ? 'connecting' : running ? 'streaming' : lines.length ? 'ended' : 'empty'}
          live={running}
          label={node?.displayName ?? node?.name}
          filename={`${run.metadata.name}-${node?.displayName ?? 'step'}`}
          height="28rem"
          emptyMessage={q.data?.waiting ? 'The step has not started its container yet.' : 'No output.'}
        />
      )}
    </div>
  )
}

/* ─────────────────────────── inputs & outputs ─────────────────────────── */

function InputsOutputs({ run, nodes, caps }: { run: Workflow; nodes: Record<string, WfNode>; caps: Capabilities }) {
  const { cluster } = useWorkflowCluster()
  const args = run.spec?.arguments?.parameters ?? run.status?.storedWorkflowTemplateSpec?.arguments?.parameters ?? []
  const ns = run.metadata.namespace ?? ''
  const withOutputs = Object.values(nodes).filter((n) => n.outputs?.parameters?.length || n.outputs?.artifacts?.length)
  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-xl border border-edge-default bg-surface-raised p-3">
        <div className="mb-1 font-medium text-content-muted">Arguments</div>
        {args.length ? <ParamTable params={args} /> : <p className="text-content-subtle">This run took no parameters.</p>}
      </div>
      {withOutputs.map((n) => (
        <div key={n.id} className="rounded-xl border border-edge-default bg-surface-raised p-3">
          <div className="mb-1 font-mono text-content">{n.displayName ?? n.name}</div>
          {n.outputs?.parameters?.length ? <ParamTable params={n.outputs.parameters} /> : null}
          {n.outputs?.artifacts?.length ? (
            <ul className="mt-2 flex flex-wrap gap-3">
              {n.outputs.artifacts.map((a) => (
                <li key={a.name}>
                  {caps.artifactNamespaces.includes(ns) ? (
                    <a className="text-brand-600 hover:underline dark:text-brand-400" href={artifactUrl(ns, run.metadata.name, n.id, a.name, cluster)}>⬇ {a.name}</a>
                  ) : (
                    <span className="text-content-subtle" title="Artifact downloads are available in adhar-system only until team artifact repositories ship (W5).">{a.name}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/* ─────────────────────────── events ─────────────────────────── */

function RunEvents({ namespace, name }: { namespace: string; name: string }) {
  const q = useRunEvents(namespace, name)
  if (q.isLoading) return <Loading />
  if (q.data?.forbidden) return <EmptyState compact title="You cannot read events in this namespace" />
  const items = [...(q.data?.items ?? [])].sort((a, b) => (b.lastTimestamp ?? b.eventTime ?? '').localeCompare(a.lastTimestamp ?? a.eventTime ?? ''))
  if (!items.length) return <EmptyState compact title="No events for this run or its pods" />
  return (
    <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised text-xs">
      {items.map((e) => (
        <li key={e.metadata.uid ?? e.metadata.name} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
          <StatusBadge kind={e.type === 'Warning' ? 'degraded' : 'info'}>{e.reason ?? e.type ?? 'Event'}</StatusBadge>
          <span className="font-mono text-content-muted">{e.involvedObject?.kind}/{e.involvedObject?.name}</span>
          <span className="min-w-0 flex-1 text-content">{e.message}</span>
          <span className="text-content-subtle">{e.lastTimestamp || e.eventTime ? formatRelative((e.lastTimestamp || e.eventTime)!) : ''}{e.count && e.count > 1 ? ` ×${e.count}` : ''}</span>
        </li>
      ))}
    </ul>
  )
}
