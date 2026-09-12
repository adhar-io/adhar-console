import { useEffect, useMemo, useState } from 'react'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { Button, Card, CardBody, CardHeader, EmptyState, Select } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { useLiveList } from '../data/live.ts'
import { GVRS } from '../data/gvr.ts'
import { NamespacePicker } from '../components/namespace-picker.tsx'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sPermissionDenied } from '../components/role-gate.tsx'
import {
  LogConsole,
  type LogSource,
  type StreamStatus,
  useLogStream,
} from '../components/log-console.tsx'
import {
  SEVERITIES,
  SEVERITY_DOT,
  SEVERITY_LABEL,
  SINCE_OPTIONS,
  sinceSecondsFor,
  TAIL_OPTIONS,
  type Severity,
  type SinceLabel,
  type Tail,
} from '@adhar-console/shell-ui'

/**
 * The Logs page — live container logs for a pod, or merged across a workload.
 *
 * This view is now only about **choosing a source**: namespace, a pod or a
 * whole workload, which container(s), how much history. Everything after that —
 * the console surface, search, wrap, timestamps, line numbers, ANSI, copy,
 * download, fullscreen, jump-to-live — is `LogConsole`, the same component the
 * pipeline step console and the pod drawer render.
 *
 * It used to carry its own console *and* its own streaming loop. That loop was
 * the source of the reconnect flapping: every source shared one
 * `AbortController` and one `Promise.all`, so one pod closing its stream tore
 * down all of them, stale settle handlers could start parallel reconnect loops,
 * and each reconnect re-requested `tailLines` — re-appending lines the pane
 * already showed. `useLogStream` replaces all of it: one connection per source,
 * generation-guarded, resuming from the last timestamp seen.
 */

const ALL_CONTAINERS = '__all__'

interface PodSpecish {
  spec?: {
    containers?: { name?: string }[]
    initContainers?: { name?: string }[]
  }
}

/** Workloads whose pods we can aggregate logs across. */
type WorkloadKind = 'deployments' | 'statefulsets' | 'daemonsets' | 'jobs'
const WORKLOAD_KINDS: { value: WorkloadKind; label: string }[] = [
  { value: 'deployments', label: 'Deployment' },
  { value: 'statefulsets', label: 'StatefulSet' },
  { value: 'daemonsets', label: 'DaemonSet' },
  { value: 'jobs', label: 'Job' },
]

/** Container names of a pod (init + regular), in order. */
function containersOf(pod: PodSpecish | undefined): string[] {
  const spec = pod?.spec
  return [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])]
    .map((c) => c.name)
    .filter((n): n is string => Boolean(n))
}

/** True when every label in `selector` is present with the same value on the pod. */
function selectorMatches(
  podLabels: Record<string, string> | undefined,
  selector: Record<string, string> | undefined,
): boolean {
  if (!selector || Object.keys(selector).length === 0) return false
  if (!podLabels) return false
  return Object.entries(selector).every(([k, v]) => podLabels[k] === v)
}

interface LogsViewerProps {
  namespace?: string
  pod?: string
  container?: string
}

export function LogsViewer({ namespace, pod, container }: LogsViewerProps = {}) {
  const canLogs = useHasK8sPermission('pods.logs')

  const [ns, setNs] = useState<string | undefined>(namespace)
  const [sourceMode, setSourceMode] = useState<'pod' | 'workload'>('pod')
  const [workloadKind, setWorkloadKind] = useState<WorkloadKind>('deployments')
  const [workloadName, setWorkloadName] = useState<string>('')
  const [podName, setPodName] = useState<string>(pod ?? '')
  const [containerSel, setContainerSel] = useState<string>(container ?? '')
  const [tailLines, setTailLines] = useState<Tail>(1000)
  const [sinceLabel, setSinceLabel] = useState<SinceLabel>('all')
  const [follow, setFollow] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [shown, setShown] = useState<Record<Severity, boolean>>({
    error: true,
    warn: true,
    info: true,
    debug: true,
    other: true,
  })

  const pods = useLiveList(GVRS.pods, { namespace: ns, enabled: canLogs })
  const podNames = useMemo(
    () =>
      (pods.data as KubeObject[])
        .map((p) => p.metadata?.name)
        .filter((n): n is string => Boolean(n))
        .sort(),
    [pods.data],
  )

  // Keep the selected pod valid as the namespace / list changes.
  useEffect(() => {
    if (podName && podNames.includes(podName)) return
    setPodName(pod && podNames.includes(pod) ? pod : (podNames[0] ?? ''))
  }, [podNames, pod, podName])

  const selectedPod = useMemo(
    () =>
      (pods.data as KubeObject[]).find((p) => p.metadata?.name === podName) as PodSpecish | undefined,
    [pods.data, podName],
  )
  const containerNames = useMemo(() => containersOf(selectedPod), [selectedPod])

  // Keep the selected container valid as the pod changes (ALL sentinel is kept).
  useEffect(() => {
    if (containerSel === ALL_CONTAINERS) return
    if (containerSel && containerNames.includes(containerSel)) return
    setContainerSel(
      container && containerNames.includes(container) ? container : (containerNames[0] ?? ''),
    )
  }, [containerNames, container, containerSel])

  /* ── workload aggregation: resolve a workload's pods by label selector ── */
  const workloads = useLiveList(GVRS[workloadKind], {
    namespace: ns,
    enabled: canLogs && sourceMode === 'workload',
  })
  const workloadNames = useMemo(
    () =>
      (workloads.data as KubeObject[])
        .map((w) => w.metadata?.name)
        .filter((n): n is string => Boolean(n))
        .sort(),
    [workloads.data],
  )
  useEffect(() => {
    if (sourceMode !== 'workload') return
    if (workloadName && workloadNames.includes(workloadName)) return
    setWorkloadName(workloadNames[0] ?? '')
  }, [sourceMode, workloadNames, workloadName])

  const workloadPods = useMemo(() => {
    if (sourceMode !== 'workload' || !workloadName) return [] as { name: string; pod: PodSpecish }[]
    const wl = (workloads.data as KubeObject[]).find((w) => w.metadata?.name === workloadName) as
      | { spec?: { selector?: { matchLabels?: Record<string, string> } } }
      | undefined
    const selector = wl?.spec?.selector?.matchLabels
    return (pods.data as KubeObject[])
      .filter((p) => selectorMatches(p.metadata?.labels, selector))
      .map((p) => ({ name: p.metadata?.name ?? '', pod: p as PodSpecish }))
      .filter((p) => p.name)
  }, [sourceMode, workloadName, workloads.data, pods.data])

  // Union of container names across the resolved workload pods (drives the filter).
  const unionContainers = useMemo(() => {
    if (sourceMode !== 'workload') return containerNames
    const set = new Set<string>()
    for (const { pod: p } of workloadPods) for (const c of containersOf(p)) set.add(c)
    return [...set]
  }, [sourceMode, workloadPods, containerNames])

  const activeSources = useMemo<LogSource[]>(() => {
    if (sourceMode === 'workload') {
      const out: LogSource[] = []
      for (const { name, pod: p } of workloadPods) {
        const cs = containersOf(p)
        const chosen = containerSel && containerSel !== ALL_CONTAINERS
          ? cs.filter((c) => c === containerSel)
          : cs
        for (const c of chosen) out.push({ pod: name, container: c, label: `${name}/${c}` })
      }
      return out
    }
    if (containerSel === ALL_CONTAINERS) {
      return containerNames.map((c) => ({ pod: podName, container: c, label: c }))
    }
    return containerSel && containerNames.includes(containerSel)
      ? [{ pod: podName, container: containerSel, label: containerSel }]
      : []
  }, [sourceMode, workloadPods, containerSel, containerNames, podName])

  const multi = activeSources.length > 1

  const stream = useLogStream({
    namespace: ns,
    sources: activeSources,
    // "Previous" is a fixed snapshot of a terminated container — nothing to tail.
    follow: follow && !previous,
    tailLines,
    previous,
    sinceSeconds: sinceSecondsFor(sinceLabel),
    enabled: canLogs,
  })

  const visible = useMemo(
    () => stream.lines.filter((l) => shown[l.severity]),
    [stream.lines, shown],
  )

  const toggleSeverity = (s: Severity) => setShown((prev) => ({ ...prev, [s]: !prev[s] }))

  /* ── RBAC gate ── */
  if (!canLogs) {
    return (
      <Card>
        <CardBody>
          <K8sPermissionDenied perm="pods.logs" />
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        {/* Row 1 — source selectors (left) · stream controls (right) */}
        <div className="flex flex-wrap items-center gap-3">
          <NamespacePicker value={ns} onChange={setNs} />

          <FieldLabel text="Source">
            <div className="inline-flex overflow-hidden rounded-md border border-edge-default">
              {(['pod', 'workload'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setSourceMode(m)
                    if (m === 'workload') setContainerSel(ALL_CONTAINERS)
                  }}
                  className={cn(
                    'px-2.5 py-1.5 text-xs font-medium capitalize transition-colors',
                    sourceMode === m
                      ? 'bg-brand-600 text-white'
                      : 'bg-surface-raised text-content-muted hover:bg-surface-sunken',
                  )}
                  title={m === 'workload'
                    ? 'Aggregate logs across all pods of a workload'
                    : 'Stream a single pod'}
                >
                  {m}
                </button>
              ))}
            </div>
          </FieldLabel>

          {sourceMode === 'pod'
            ? (
              <FieldLabel text="Pod">
                <Select
                  value={podName}
                  onChange={(e) => setPodName(e.target.value)}
                  className="min-w-52 py-1.5 text-xs"
                  disabled={podNames.length === 0}
                >
                  {podNames.length === 0 ? <option value="">No pods</option> : null}
                  {podNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </FieldLabel>
            )
            : (
              <>
                <FieldLabel text="Kind">
                  <Select
                    value={workloadKind}
                    onChange={(e) => setWorkloadKind(e.target.value as WorkloadKind)}
                    className="min-w-32 py-1.5 text-xs"
                  >
                    {WORKLOAD_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>{k.label}</option>
                    ))}
                  </Select>
                </FieldLabel>
                <FieldLabel text="Workload">
                  <Select
                    value={workloadName}
                    onChange={(e) => setWorkloadName(e.target.value)}
                    className="min-w-52 py-1.5 text-xs"
                    disabled={workloadNames.length === 0}
                  >
                    {workloadNames.length === 0
                      ? <option value="">No {workloadKind}</option>
                      : null}
                    {workloadNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </Select>
                </FieldLabel>
              </>
            )}

          <FieldLabel text="Container">
            <Select
              value={containerSel}
              onChange={(e) => setContainerSel(e.target.value)}
              className="min-w-40 py-1.5 text-xs"
              disabled={unionContainers.length === 0}
            >
              {sourceMode === 'workload' || unionContainers.length > 1
                ? <option value={ALL_CONTAINERS}>All containers</option>
                : null}
              {unionContainers.length === 0 ? <option value="">—</option> : null}
              {unionContainers.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </FieldLabel>

          <FieldLabel text="Since">
            <Select
              value={sinceLabel}
              onChange={(e) => setSinceLabel(e.target.value as SinceLabel)}
              className="min-w-20 py-1.5 text-xs"
            >
              {SINCE_OPTIONS.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
            </Select>
          </FieldLabel>

          <FieldLabel text="Tail">
            <Select
              value={String(tailLines)}
              onChange={(e) => setTailLines(Number(e.target.value) as Tail)}
              className="min-w-24 py-1.5 text-xs"
            >
              {TAIL_OPTIONS.map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}
            </Select>
          </FieldLabel>

          <StatusPill status={stream.status} reconnect={stream.reconnect} />

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={follow ? 'secondary' : 'primary'}
              disabled={previous}
              onClick={() => setFollow((f) => !f)}
              title={previous
                ? 'Following is unavailable for previous-instance logs'
                : follow
                ? 'Pause the live stream (buffer is kept)'
                : 'Resume live tailing'}
            >
              {follow && !previous ? 'Pause' : 'Resume'}
            </Button>
            {stream.status === 'error'
              ? (
                <Button size="sm" variant="secondary" onClick={stream.reload}>
                  Reconnect
                </Button>
              )
              : null}
            <Button
              size="sm"
              variant="secondary"
              onClick={stream.clear}
              disabled={stream.lines.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>

        {/* Row 2 — severity filter + previous-instance toggle. Search, wrap,
            timestamps, line numbers, copy, download and fullscreen all live in
            the console's own toolbar now, so they are not repeated here. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggleSeverity(s)}
              aria-pressed={shown[s]}
              title={`${shown[s] ? 'Hide' : 'Show'} ${SEVERITY_LABEL[s]} lines`}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                shown[s]
                  ? 'border-edge-strong bg-surface-raised text-content'
                  : 'border-edge-default bg-surface-sunken text-content-subtle line-through opacity-60',
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', SEVERITY_DOT[s])} />
              {SEVERITY_LABEL[s]}
            </button>
          ))}

          <span className="mx-1 h-4 w-px bg-edge-default" aria-hidden />

          <button
            type="button"
            onClick={() => setPrevious((v) => !v)}
            aria-pressed={previous}
            title="Previous (last-terminated) container instance"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
              previous
                ? 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/15 dark:text-amber-200'
                : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong',
            )}
          >
            Previous instance
          </button>

          <span className="ml-auto text-[11px] tabular-nums text-content-subtle">
            {visible.length.toLocaleString()}
            {visible.length !== stream.lines.length
              ? ` of ${stream.lines.length.toLocaleString()}`
              : ''} {stream.lines.length === 1 ? 'line' : 'lines'}
            {multi ? ` · merging ${activeSources.length} streams` : ''}
          </span>
        </div>
      </CardHeader>

      <CardBody>
        {activeSources.length === 0
          ? (
            <div className="rounded-xl border border-edge-default p-6">
              <EmptyState
                compact
                title={sourceMode === 'workload' ? 'No pods matched' : 'No container selected'}
                description={sourceMode === 'workload'
                  ? 'Pick a namespace and workload with running pods to stream its aggregated logs.'
                  : 'Pick a namespace, pod, and container to start streaming logs.'}
              />
            </div>
          )
          : (
            <LogConsole
              lines={visible}
              status={stream.status}
              error={stream.error}
              reconnect={stream.reconnect}
              label={sourceMode === 'workload'
                ? `${workloadName || workloadKind}`
                : `${podName}${containerSel && containerSel !== ALL_CONTAINERS ? ` · ${containerSel}` : ''}`}
              live={follow && !previous && stream.status === 'streaming'}
              filename={sourceMode === 'workload'
                ? `${workloadKind}-${workloadName || 'workload'}`
                : podName || 'pod'}
              height="h-[62vh]"
              emptyMessage={previous
                ? 'The previous instance produced no output.'
                : follow
                ? 'Waiting for log output…'
                : 'No log output.'}
            />
          )}
      </CardBody>
    </Card>
  )
}

export default LogsViewer

/* ─────────────────────────────── chrome ─────────────────────────────── */

function FieldLabel({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">
        {text}
      </span>
      {children}
    </label>
  )
}

const STATUS_TONE: Record<StreamStatus, { label: string; cls: string }> = {
  idle: { label: 'Idle', cls: 'border-edge-default bg-surface-sunken text-content-muted' },
  connecting: { label: 'Connecting', cls: 'border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-500/25 dark:bg-brand-500/10 dark:text-brand-300' },
  streaming: { label: 'Streaming', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300' },
  reconnecting: { label: 'Reconnecting', cls: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300' },
  paused: { label: 'Paused', cls: 'border-edge-default bg-surface-sunken text-content-muted' },
  empty: { label: 'No output', cls: 'border-edge-default bg-surface-sunken text-content-muted' },
  error: { label: 'Error', cls: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300' },
  forbidden: { label: 'Forbidden', cls: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300' },
  notfound: { label: 'Gone', cls: 'border-edge-default bg-surface-sunken text-content-muted' },
}

function StatusPill(
  { status, reconnect }: { status: StreamStatus; reconnect?: { attempt: number } },
) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.idle
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        tone.cls,
      )}
    >
      {status === 'streaming'
        ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
        : null}
      {tone.label}
      {status === 'reconnecting' && reconnect && reconnect.attempt > 1
        ? ` (${reconnect.attempt})`
        : ''}
    </span>
  )
}
