import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { kube } from '@adhar-console/api-clients/k8s'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { Button, Card, CardBody, CardHeader, EmptyState, Input, Select, Spinner } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { useLiveList } from '../data/live.ts'
import { GVRS } from '../data/gvr.ts'
import { NamespacePicker } from '../components/namespace-picker.tsx'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sPermissionDenied } from '../components/role-gate.tsx'
import {
  buildMatcher,
  containerColor,
  detectSeverity,
  renderSegments,
  SEVERITIES,
  SEVERITY_DOT,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  SINCE_OPTIONS,
  sinceSecondsFor,
  stripAnsi,
  TAIL_OPTIONS,
  type Severity,
  type SinceLabel,
  type Tail,
} from './log-format.tsx'

/**
 * OpenShift-grade live log viewer.
 *
 * Streams a pod's container logs over `kube.logStream` (follow mode) into a
 * bounded, dark, monospace pane. Everything renders the *real* stream — nothing
 * is fabricated; empty / connecting / reconnecting / error / RBAC states are all
 * honest.
 *
 * Source selection    — namespace / pod / container (or **All containers**,
 *                        streamed concurrently and merged with colour-coded
 *                        prefixes) / tail-lines / **Since** duration.
 * Find & filter        — one search box in plain or regex mode, case toggle,
 *                        highlight-all + match count + next/prev, plus a
 *                        show-only-matching **filter** toggle. A **severity**
 *                        filter (Error/Warn/Info/Debug/Other) hides/shows by
 *                        parsed level and colours each line.
 * Display              — timestamps / wrap / line-numbers / previous-instance
 *                        toggles; ANSI SGR colours rendered inline.
 * Streaming UX         — Follow/Pause, jump-to-bottom with a "new logs" badge,
 *                        Clear, a bounded 10k-line buffer (drop oldest), live
 *                        line count + rate, and auto-reconnect on drop.
 * Output               — download raw or filtered buffer as `.log`, copy
 *                        selection or all (ANSI stripped).
 * Layout               — OpenShift-style toolbar, fullscreen, resizable pane.
 *
 * Each source change / unmount aborts every in-flight stream + reconnect timer.
 */

const MAX_LINES = 10_000
const ALL_CONTAINERS = '__all__'

type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'paused'
  | 'empty'
  | 'reconnecting'
  | 'ended'
  | 'error'

interface Line {
  /** Source container — only set in the merged "All containers" view. */
  c?: string
  /** Raw text, ANSI codes intact (rendered inline). */
  text: string
  /** ANSI-stripped text — cached for search / filter / severity / export. */
  plain: string
  /** Severity parsed once at ingest, not on every render. */
  sev: Severity
}

function makeLine(c: string | undefined, text: string, multi: boolean): Line {
  const plain = stripAnsi(text)
  return { c: multi ? c : undefined, text, plain, sev: detectSeverity(plain) }
}

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

/** A single log source — one container of one pod. */
interface Source {
  pod: string
  container: string
  /** Prefix shown in merged views (container name, or pod/container across pods). */
  label: string
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
  const [timestamps, setTimestamps] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [lineNumbers, setLineNumbers] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  // Find / filter.
  const [query, setQuery] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [filterMode, setFilterMode] = useState(false)
  const [matchCursor, setMatchCursor] = useState(0)
  const [shown, setShown] = useState<Record<Severity, boolean>>({
    error: true,
    warn: true,
    info: true,
    debug: true,
    other: true,
  })

  // Stream state.
  const [lines, setLines] = useState<Line[]>([])
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [reconnect, setReconnect] = useState<{ attempt: number; message?: string } | null>(null)
  const [rate, setRate] = useState(0)
  const [newCount, setNewCount] = useState(0)
  const [reconnectNonce, setReconnectNonce] = useState(0)

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
    () => (pods.data as KubeObject[]).find((p) => p.metadata?.name === podName) as PodSpecish | undefined,
    [pods.data, podName],
  )
  const containerNames = useMemo(() => {
    const spec = selectedPod?.spec
    return [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])]
      .map((c) => c.name)
      .filter((n): n is string => Boolean(n))
  }, [selectedPod])

  // Keep the selected container valid as the pod changes (ALL sentinel is kept).
  useEffect(() => {
    if (containerSel === ALL_CONTAINERS) return
    if (containerSel && containerNames.includes(containerSel)) return
    setContainerSel(container && containerNames.includes(container) ? container : (containerNames[0] ?? ''))
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
    for (const { pod } of workloadPods) for (const c of containersOf(pod)) set.add(c)
    return [...set]
  }, [sourceMode, workloadPods, containerNames])

  const activeSources = useMemo<Source[]>(() => {
    if (sourceMode === 'workload') {
      const out: Source[] = []
      for (const { name, pod } of workloadPods) {
        const cs = containersOf(pod)
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
  const sourcesKey = activeSources.map((s) => `${s.pod}:${s.container}`).join(' ')

  const sinceSeconds = sinceSecondsFor(sinceLabel)
  const sourceKey = [
    ns ?? '',
    sourceMode,
    workloadKind,
    workloadName,
    podName,
    containerSel,
    tailLines,
    sinceLabel,
    timestamps,
    previous,
  ].join('|')

  /* ── buffer plumbing (refs so stream chunks don't churn React) ── */
  const bufferRef = useRef<Line[]>([])
  const pendingRef = useRef<Record<string, string>>({})
  const totalRef = useRef(0)
  const newCountRef = useRef(0)
  const gotFirstRef = useRef(false)
  const paneRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const flushTimer = useRef<number | null>(null)
  const lastFlush = useRef(0)
  const sampleRef = useRef({ t: Date.now(), n: 0 })
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    pinnedRef.current = pinned
  }, [pinned])

  const flush = useCallback(() => {
    const buf = bufferRef.current
    setLines(buf.length > MAX_LINES ? buf.slice(buf.length - MAX_LINES) : buf.slice())
    if (newCountRef.current) setNewCount(newCountRef.current)
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current != null) return
    const since = Date.now() - lastFlush.current
    const wait = since >= 100 ? 0 : 100 - since
    flushTimer.current = globalThis.setTimeout(() => {
      flushTimer.current = null
      lastFlush.current = Date.now()
      flush()
    }, wait)
  }, [flush])

  const appendLines = useCallback(
    (add: Line[]) => {
      if (add.length === 0) return
      const buf = bufferRef.current
      for (const l of add) buf.push(l)
      // Trim in a batch so we don't splice on every append.
      if (buf.length > MAX_LINES + 2000) bufferRef.current = buf.slice(buf.length - MAX_LINES)
      totalRef.current += add.length
      if (!pinnedRef.current) newCountRef.current += add.length
      scheduleFlush()
    },
    [scheduleFlush],
  )

  const resetBuffer = useCallback(() => {
    bufferRef.current = []
    pendingRef.current = {}
    totalRef.current = 0
    newCountRef.current = 0
    sampleRef.current = { t: Date.now(), n: 0 }
    setLines([])
    setNewCount(0)
    setRate(0)
    setError(null)
    setReconnect(null)
  }, [])

  /* ── the stream(s) ── */
  useEffect(() => {
    if (!canLogs) return
    if (activeSources.length === 0) {
      resetBuffer()
      setStatus('idle')
      return
    }

    let stopped = false
    let ac = new AbortController()
    let reconnectTimer: number | undefined
    let attempt = 0
    gotFirstRef.current = false

    const onFirst = () => {
      if (!gotFirstRef.current) {
        gotFirstRef.current = true
        setStatus('streaming')
        setReconnect(null)
      }
    }

    const appendChunk = (c: string, text: string) => {
      const pend = pendingRef.current
      const combined = (pend[c] ?? '') + text
      const parts = combined.split('\n')
      pend[c] = parts.pop() ?? ''
      if (parts.length === 0) return
      appendLines(parts.map((t) => makeLine(c, t, multi)))
      onFirst()
    }

    const flushPending = () => {
      const pend = pendingRef.current
      const add: Line[] = []
      for (const c of Object.keys(pend)) {
        if (pend[c]) {
          add.push(makeLine(c, pend[c], multi))
          pend[c] = ''
        }
      }
      appendLines(add)
    }

    const streamOne = (src: Source, doFollow: boolean) =>
      kube.logStream(
        ns ?? '',
        src.pod,
        { container: src.container, follow: doFollow, tailLines, timestamps, previous, sinceSeconds, signal: ac.signal },
        (text) => appendChunk(src.label, text),
      )

    const runOnce = (doFollow: boolean) => Promise.all(activeSources.map((s) => streamOne(s, doFollow)))

    const handleError = (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }

    // Paused with an existing buffer → freeze; no network activity.
    if (!follow && bufferRef.current.length > 0) {
      setStatus('paused')
      return () => {
        stopped = true
        ac.abort()
      }
    }

    resetBuffer()
    setStatus('connecting')

    if (!follow) {
      // One-shot load of the tail (started paused).
      runOnce(false)
        .then(() => {
          if (stopped || ac.signal.aborted) return
          flushPending()
          setStatus(bufferRef.current.length ? 'paused' : 'empty')
        })
        .catch((err) => {
          if (stopped || ac.signal.aborted) return
          handleError(err)
        })
      return () => {
        stopped = true
        ac.abort()
      }
    }

    const scheduleReconnect = (err: unknown) => {
      attempt += 1
      setReconnect({ attempt, message: err instanceof Error ? err.message : undefined })
      setStatus('reconnecting')
      const delay = Math.min(15_000, 1000 * 2 ** (attempt - 1))
      reconnectTimer = globalThis.setTimeout(() => {
        if (stopped) return
        gotFirstRef.current = false
        connect()
      }, delay) as unknown as number
    }

    const connect = () => {
      ac = new AbortController()
      runOnce(true)
        .then(() => {
          if (stopped || ac.signal.aborted) return
          flushPending()
          // A follow stream resolving means the server closed it (pod ended /
          // log rotated). Retry — the pod may restart.
          scheduleReconnect(undefined)
        })
        .catch((err) => {
          if (stopped || ac.signal.aborted) return
          const e = err as { status?: number; reason?: string }
          // Forbidden / NotFound are terminal — no point reconnecting.
          if (e?.status === 403 || e?.reason === 'Forbidden' || e?.status === 404 || e?.reason === 'NotFound') {
            handleError(err)
            return
          }
          scheduleReconnect(err)
        })
    }

    connect()
    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ac.abort()
    }
    // sourceKey + sourcesKey encode every value read above; refs cover the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, sourcesKey, follow, reconnectNonce, canLogs])

  // Live rate sampler (lines/sec over the last ~1s window).
  useEffect(() => {
    const id = globalThis.setInterval(() => {
      const now = Date.now()
      const { t, n } = sampleRef.current
      const dt = (now - t) / 1000
      const dn = totalRef.current - n
      sampleRef.current = { t: now, n: totalRef.current }
      setRate(dt > 0 ? dn / dt : 0)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(
    () => () => {
      if (flushTimer.current != null) clearTimeout(flushTimer.current)
    },
    [],
  )

  /* ── auto-scroll pinning ── */
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      setPinned(atBottom)
      if (atBottom) {
        newCountRef.current = 0
        setNewCount(0)
      }
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    if (pinned) el.scrollTop = el.scrollHeight
  }, [lines, pinned])

  /* ── derived view: severity filter + find/filter ── */
  const matcher = useMemo(
    () => buildMatcher(query.trim(), { regex: useRegex, caseSensitive }),
    [query, useRegex, caseSensitive],
  )

  const processed = useMemo(() => {
    const out: Line[] = []
    for (const l of lines) {
      if (!shown[l.sev]) continue
      if (filterMode && matcher.active && !matcher.error && !matcher.test(l.plain)) continue
      out.push(l)
    }
    return out
  }, [lines, shown, filterMode, matcher])

  const matchLines = useMemo(() => {
    if (!matcher.active || matcher.error) return [] as number[]
    const idxs: number[] = []
    processed.forEach((p, i) => {
      if (matcher.test(p.plain)) idxs.push(i)
    })
    return idxs
  }, [processed, matcher])

  const matchCount = useMemo(() => {
    if (!matcher.active || matcher.error) return 0
    let n = 0
    for (const p of processed) n += matcher.ranges(p.plain).length
    return n
  }, [processed, matcher])

  useEffect(() => {
    setMatchCursor(0)
  }, [query, useRegex, caseSensitive, filterMode])

  // Scroll the active find hit into view.
  useEffect(() => {
    if (!matchLines.length) return
    const li = matchLines[Math.min(matchCursor, matchLines.length - 1)]
    const el = paneRef.current?.querySelector(`[data-row="${li}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setPinned(false)
  }, [matchCursor, matchLines])

  const activeRow = matchLines.length ? matchLines[Math.min(matchCursor, matchLines.length - 1)] : -1

  const stepMatch = (dir: 1 | -1) => {
    if (!matchLines.length) return
    setMatchCursor((c) => {
      const n = matchLines.length
      return ((c + dir) % n + n) % n
    })
  }

  /* ── output ── */
  const rawText = useCallback(
    () => bufferRef.current.map((l) => (l.c ? `[${l.c}] ` : '') + l.plain).join('\n'),
    [],
  )
  const filteredText = useCallback(
    () => processed.map((l) => (l.c ? `[${l.c}] ` : '') + l.plain).join('\n'),
    [processed],
  )

  const doDownload = (text: string, suffix: string) => {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const base = sourceMode === 'workload'
        ? `${workloadKind}-${workloadName || 'workload'}`
        : podName || 'pod'
      a.download = `${base}_${containerSel === ALL_CONTAINERS ? 'all' : containerSel || 'container'}_${suffix}_${stamp}.log`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      // Sandboxes can block programmatic downloads — surface it honestly.
      setError('Download was blocked by the browser. Use Copy instead.')
    }
  }

  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString() : ''
    void navigator.clipboard.writeText(sel && sel.trim() ? sel : filteredText())
  }

  const jump = () => {
    const el = paneRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setPinned(true)
    newCountRef.current = 0
    setNewCount(0)
  }

  const clear = () => {
    resetBuffer()
    if (follow) setStatus('streaming')
  }

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

  const shell = (
    <Card className={fullscreen ? 'flex h-full flex-col overflow-hidden' : undefined}>
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

          {sourceMode === 'pod' ? (
            <FieldLabel text="Pod">
              <Select
                value={podName}
                onChange={(e) => setPodName(e.target.value)}
                className="min-w-52 py-1.5 text-xs"
                disabled={podNames.length === 0}
              >
                {podNames.length === 0 ? <option value="">No pods</option> : null}
                {podNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </FieldLabel>
          ) : (
            <>
              <FieldLabel text="Kind">
                <Select
                  value={workloadKind}
                  onChange={(e) => setWorkloadKind(e.target.value as WorkloadKind)}
                  className="min-w-32 py-1.5 text-xs"
                >
                  {WORKLOAD_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
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
                  {workloadNames.length === 0 ? <option value="">No {workloadKind}</option> : null}
                  {workloadNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
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
              {sourceMode === 'workload' || unionContainers.length > 1 ? (
                <option value={ALL_CONTAINERS}>All containers</option>
              ) : null}
              {unionContainers.length === 0 ? <option value="">—</option> : null}
              {unionContainers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </FieldLabel>

          <FieldLabel text="Since">
            <Select
              value={sinceLabel}
              onChange={(e) => setSinceLabel(e.target.value as SinceLabel)}
              className="min-w-20 py-1.5 text-xs"
            >
              {SINCE_OPTIONS.map((s) => (
                <option key={s.label} value={s.label}>
                  {s.label}
                </option>
              ))}
            </Select>
          </FieldLabel>

          <FieldLabel text="Tail">
            <Select
              value={String(tailLines)}
              onChange={(e) => setTailLines(Number(e.target.value) as Tail)}
              className="min-w-24 py-1.5 text-xs"
            >
              {TAIL_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </Select>
          </FieldLabel>

          <StatusPill status={status} reconnect={reconnect} />

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={follow ? 'secondary' : 'primary'}
              onClick={() => setFollow((f) => !f)}
              title={follow ? 'Pause the live stream (buffer is kept)' : 'Resume live tailing'}
            >
              {follow ? 'Pause' : 'Resume'}
            </Button>
            {status === 'error' ? (
              <Button size="sm" variant="secondary" onClick={() => setReconnectNonce((n) => n + 1)}>
                Reconnect
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={clear} disabled={lines.length === 0}>
              Clear
            </Button>
            <Button size="sm" variant="secondary" onClick={copy} disabled={lines.length === 0} title="Copy selection, or the filtered view">
              Copy
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => doDownload(rawText(), 'raw')}
              disabled={lines.length === 0}
              title="Download the raw buffer"
            >
              Download
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => doDownload(filteredText(), 'filtered')}
              disabled={processed.length === 0}
              title="Download the filtered view"
            >
              Download filtered
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setFullscreen((f) => !f)}>
              {fullscreen ? 'Exit full screen' : 'Full screen'}
            </Button>
          </div>
        </div>

        {/* Row 2 — find / filter + display toggles */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={useRegex ? 'Search (regex)…' : 'Search…'}
              invalid={Boolean(matcher.error)}
              className="h-8 w-56 py-1 text-xs"
              leading={<IconSearch />}
            />
            {matcher.active && !matcher.error ? (
              <div className="flex items-center gap-1 text-[11px] text-content-muted">
                <span className="tabular-nums">
                  {matchLines.length ? `${Math.min(matchCursor + 1, matchLines.length)}/${matchLines.length}` : '0/0'}
                </span>
                <IconBtn label="Previous match" onClick={() => stepMatch(-1)} disabled={!matchLines.length}>
                  ↑
                </IconBtn>
                <IconBtn label="Next match" onClick={() => stepMatch(1)} disabled={!matchLines.length}>
                  ↓
                </IconBtn>
              </div>
            ) : null}
          </div>

          <Chip active={useRegex} onClick={() => setUseRegex((v) => !v)} title="Regular-expression search">
            .*
          </Chip>
          <Chip active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="Case sensitive">
            Aa
          </Chip>
          <Chip active={filterMode} onClick={() => setFilterMode((v) => !v)} title="Show only matching lines">
            Filter
          </Chip>

          <span className="mx-1 h-4 w-px bg-edge-default" aria-hidden />

          {SEVERITIES.map((s) => (
            <SeverityChip key={s} sev={s} active={shown[s]} onClick={() => toggleSeverity(s)} />
          ))}

          <span className="mx-1 h-4 w-px bg-edge-default" aria-hidden />

          <Chip active={timestamps} onClick={() => setTimestamps((v) => !v)}>
            Timestamps
          </Chip>
          <Chip active={wrap} onClick={() => setWrap((v) => !v)}>
            Wrap
          </Chip>
          <Chip active={lineNumbers} onClick={() => setLineNumbers((v) => !v)}>
            Line #
          </Chip>
          <Chip active={previous} onClick={() => setPrevious((v) => !v)} title="Previous (last-terminated) container instance">
            Previous
          </Chip>
        </div>
      </CardHeader>

      <CardBody className={fullscreen ? 'flex min-h-0 flex-1 flex-col' : undefined}>
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-subtle">
          {status === 'streaming' || status === 'connecting' ? <Spinner size={10} /> : null}
          <span className="tabular-nums">
            {processed.length.toLocaleString()} shown
            {processed.length !== lines.length ? ` of ${lines.length.toLocaleString()}` : ''} {lines.length === 1 ? 'line' : 'lines'}
          </span>
          {matcher.active && !matcher.error ? (
            <span className="tabular-nums">
              · {matchCount.toLocaleString()} {matchCount === 1 ? 'match' : 'matches'}
            </span>
          ) : null}
          {follow && rate > 0 ? <span className="tabular-nums">· {formatRate(rate)}</span> : null}
          {lines.length >= MAX_LINES ? (
            <span>· showing last {MAX_LINES.toLocaleString()} (buffer capped)</span>
          ) : null}
          {multi ? (
            <span>
              · merging {activeSources.length}{' '}
              {sourceMode === 'workload' ? 'pod/container streams' : 'containers'}
            </span>
          ) : null}
          {previous ? <span className="text-amber-500">· previous instance</span> : null}
          {matcher.error ? <span className="text-rose-500">· regex: {matcher.error}</span> : null}
          {error ? <span className="text-rose-500">· {error}</span> : null}
          {reconnect ? (
            <span className="text-amber-500">
              · reconnecting (attempt {reconnect.attempt}){reconnect.message ? ` — ${reconnect.message}` : ''}
            </span>
          ) : null}
        </div>

        <div className={cn('relative', fullscreen && 'min-h-0 flex-1')}>
          <div
            ref={paneRef}
            className={cn(
              'overflow-auto rounded-xl border border-code-edge bg-code font-mono text-[11px] leading-[1.55]',
              fullscreen ? 'h-full' : 'max-h-[62vh] min-h-[18rem] resize-y',
            )}
          >
            {activeSources.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  compact
                  title={sourceMode === 'workload' ? 'No pods matched' : 'No container selected'}
                  description={
                    sourceMode === 'workload'
                      ? 'Pick a namespace and workload with running pods to stream its aggregated logs.'
                      : 'Pick a namespace, pod, and container to start streaming logs.'
                  }
                />
              </div>
            ) : status === 'error' ? (
              <div className="p-6 text-center text-xs text-rose-300">
                {error ?? 'Failed to stream logs.'}
              </div>
            ) : (status === 'connecting' || status === 'streaming' || status === 'reconnecting') &&
              lines.length === 0 ? (
              <div className="p-6 text-center text-xs text-code-fg/55">
                {status === 'reconnecting' ? 'Reconnecting…' : 'Waiting for log output…'}
              </div>
            ) : lines.length === 0 ? (
              <div className="p-6 text-center text-xs text-code-fg/55">
                {status === 'empty' || status === 'paused' ? 'No log output.' : 'No log lines.'}
              </div>
            ) : processed.length === 0 ? (
              <div className="p-6 text-center text-xs text-code-fg/55">
                No lines match the current search / severity filter.
              </div>
            ) : (
              <div className="py-1">
                {processed.map((line, i) => (
                  <LogRow
                    key={i}
                    row={i}
                    n={i + 1}
                    line={line}
                    wrap={wrap}
                    lineNumbers={lineNumbers}
                    matcher={matcher}
                    isActiveMatch={i === activeRow}
                  />
                ))}
              </div>
            )}
          </div>

          {!pinned && lines.length > 0 ? (
            <button
              type="button"
              onClick={jump}
              className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/60 bg-emerald-500/90 px-3 py-1 text-[11px] font-semibold text-white shadow-lg hover:bg-emerald-500"
            >
              {newCount > 0 ? `${newCount.toLocaleString()} new` : 'Jump to live'} ↓
            </button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  )

  if (fullscreen) {
    return <div className="fixed inset-0 z-50 flex flex-col bg-surface-app p-3">{shell}</div>
  }
  return shell
}

export default LogsViewer

/* ─────────────────────────────── rows ─────────────────────────────── */

function LogRow({
  row,
  n,
  line,
  wrap,
  lineNumbers,
  matcher,
  isActiveMatch,
}: {
  row: number
  n: number
  line: Line
  wrap: boolean
  lineNumbers: boolean
  matcher: ReturnType<typeof buildMatcher>
  isActiveMatch: boolean
}) {
  const currentRange = useMemo<[number, number] | null>(() => {
    if (!isActiveMatch || !matcher.active || matcher.error) return null
    const r = matcher.ranges(line.plain)
    return r.length ? r[0] : null
  }, [isActiveMatch, matcher, line.plain])

  return (
    <div
      data-row={row}
      className={cn(
        'flex gap-3 px-3 py-0.5 hover:bg-white/[0.04]',
        SEVERITY_TONE[line.sev],
        isActiveMatch && 'bg-amber-400/10 ring-1 ring-inset ring-amber-400/40',
      )}
    >
      {lineNumbers ? (
        <span className="w-12 shrink-0 select-none text-right tabular-nums text-code-fg/40">{n}</span>
      ) : null}
      {line.c ? (
        <span
          className="shrink-0 select-none font-semibold"
          style={{ color: containerColor(line.c) }}
          title={`container: ${line.c}`}
        >
          {line.c}
        </span>
      ) : null}
      <span className={cn('min-w-0', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
        {renderSegments(line.text, matcher, currentRange)}
      </span>
    </div>
  )
}

/* ─────────────────────────────── chrome ───────────────────────────── */

function FieldLabel({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs text-content-muted">
      {text}
      {children}
    </label>
  )
}

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick(): void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/15 dark:text-brand-300'
          : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong',
      )}
    >
      {children}
    </button>
  )
}

function SeverityChip({ sev, active, onClick }: { sev: Severity; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`${active ? 'Hide' : 'Show'} ${SEVERITY_LABEL[sev]} lines`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'border-edge-strong bg-surface-raised text-content'
          : 'border-edge-default bg-surface-sunken text-content-subtle line-through opacity-60',
      )}
    >
      <span className={cn('h-2 w-2 rounded-full', SEVERITY_DOT[sev])} />
      {SEVERITY_LABEL[sev]}
    </button>
  )
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick(): void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded border border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function StatusPill({ status, reconnect }: { status: StreamStatus; reconnect: { attempt: number } | null }) {
  const map: Record<StreamStatus, { tone: string; label: string }> = {
    idle: { tone: 'bg-surface-sunken text-content-subtle', label: 'idle' },
    connecting: { tone: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300', label: 'connecting' },
    streaming: {
      tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
      label: 'streaming',
    },
    reconnecting: {
      tone: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
      label: reconnect ? `reconnecting ×${reconnect.attempt}` : 'reconnecting',
    },
    paused: { tone: 'bg-surface-sunken text-content-muted', label: 'paused' },
    empty: { tone: 'bg-surface-sunken text-content-muted', label: 'no logs' },
    ended: { tone: 'bg-surface-sunken text-content-muted', label: 'ended' },
    error: { tone: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300', label: 'error' },
  }
  const { tone, label } = map[status]
  const live = status === 'streaming'
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium', tone)}>
      {live ? (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300/80" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
      ) : null}
      {label}
    </span>
  )
}

function IconSearch() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function formatRate(r: number): string {
  if (r >= 100) return `${Math.round(r).toLocaleString()} lines/s`
  if (r >= 10) return `${r.toFixed(0)} lines/s`
  return `${r.toFixed(1)} lines/s`
}
