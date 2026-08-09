import { useEffect, useMemo, useRef, useState } from 'react'
import { kube } from '@adhar-console/api-clients/k8s'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { Button, Card, CardBody, CardHeader, EmptyState, Select, Spinner } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { useLiveList } from '../data/live.ts'
import { GVRS } from '../data/gvr.ts'
import { NamespacePicker } from '../components/namespace-picker.tsx'

/**
 * Live pod log viewer.
 *
 * Streams a container's logs over `kube.logStream` (follow-mode) into a bounded,
 * dark, monospace pane. Supports namespace / pod / container / tail selection,
 * timestamps + wrap + previous-container toggles, a client-side highlight
 * filter, auto-scroll pinning, and pause / clear / download / copy actions.
 * Each stream owns an AbortController that is torn down + restarted whenever the
 * source (pod, container, tail, previous, follow) changes or the view unmounts.
 */

const TAIL_OPTIONS = [100, 500, 2000] as const
type Tail = (typeof TAIL_OPTIONS)[number]

const MAX_LINES = 5000

type StreamStatus = 'idle' | 'streaming' | 'ended' | 'error'

interface PodSpecish {
  spec?: {
    containers?: { name?: string }[]
    initContainers?: { name?: string }[]
  }
}

interface LogsViewerProps {
  namespace?: string
  pod?: string
  container?: string
}

export function LogsViewer({ namespace, pod, container }: LogsViewerProps = {}) {
  const [ns, setNs] = useState<string | undefined>(namespace)
  const [podName, setPodName] = useState<string>(pod ?? '')
  const [containerName, setContainerName] = useState<string>(container ?? '')
  const [tailLines, setTailLines] = useState<Tail>(500)
  const [follow, setFollow] = useState(true)
  const [timestamps, setTimestamps] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [filter, setFilter] = useState('')

  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const pods = useLiveList(GVRS.pods, { namespace: ns, enabled: true })
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
    const names = [
      ...(spec?.initContainers ?? []),
      ...(spec?.containers ?? []),
    ]
      .map((c) => c.name)
      .filter((n): n is string => Boolean(n))
    return names
  }, [selectedPod])

  // Keep the selected container valid as the pod changes.
  useEffect(() => {
    if (containerName && containerNames.includes(containerName)) return
    setContainerName(container && containerNames.includes(container) ? container : (containerNames[0] ?? ''))
  }, [containerNames, container, containerName])

  // Stable ref for appending stream chunks without stale closures / re-renders.
  const pendingRef = useRef('')
  const paneRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  // The log stream. Re-runs (abort + restart) on any source change.
  useEffect(() => {
    if (!podName || !containerName) {
      setLines([])
      setStatus('idle')
      return
    }

    const ac = new AbortController()
    pendingRef.current = ''
    setLines([])
    setError(null)
    setStatus('streaming')

    const append = (text: string) => {
      const combined = pendingRef.current + text
      const parts = combined.split('\n')
      pendingRef.current = parts.pop() ?? ''
      if (parts.length === 0) return
      setLines((prev) => {
        const next = prev.length ? prev.concat(parts) : parts
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
      })
    }

    kube
      .logStream(
        ns ?? '',
        podName,
        { container: containerName, follow, tailLines, timestamps, previous, signal: ac.signal },
        append,
      )
      .then(() => {
        if (ac.signal.aborted) return
        // Flush any trailing partial line the stream left buffered.
        if (pendingRef.current) {
          const tail = pendingRef.current
          pendingRef.current = ''
          setLines((prev) => {
            const next = prev.concat([tail])
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
          })
        }
        setStatus('ended')
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })

    return () => ac.abort()
  }, [ns, podName, containerName, tailLines, timestamps, previous, follow])

  // Auto-scroll pinning: glue to the bottom until the user scrolls up.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      setPinned(atBottom)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    if (follow && pinned) el.scrollTop = el.scrollHeight
  }, [lines, follow, pinned])

  const needle = filter.trim().toLowerCase()
  const matchCount = useMemo(() => {
    if (!needle) return lines.length
    return lines.reduce((n, l) => (l.toLowerCase().includes(needle) ? n + 1 : n), 0)
  }, [lines, needle])

  const download = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    a.download = `${podName || 'pod'}_${containerName || 'container'}_${stamp}.log`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    void navigator.clipboard.writeText(lines.join('\n'))
  }

  const jump = () => {
    const el = paneRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setPinned(true)
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <NamespacePicker value={ns} onChange={setNs} />

          <label className="flex items-center gap-2 text-xs text-content-muted">
            Pod
            <Select
              value={podName}
              onChange={(e) => setPodName(e.target.value)}
              className="min-w-52"
              disabled={podNames.length === 0}
            >
              {podNames.length === 0 ? <option value="">No pods</option> : null}
              {podNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex items-center gap-2 text-xs text-content-muted">
            Container
            <Select
              value={containerName}
              onChange={(e) => setContainerName(e.target.value)}
              className="min-w-40"
              disabled={containerNames.length === 0}
            >
              {containerNames.length === 0 ? <option value="">—</option> : null}
              {containerNames.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex items-center gap-2 text-xs text-content-muted">
            Tail
            <Select
              value={String(tailLines)}
              onChange={(e) => setTailLines(Number(e.target.value) as Tail)}
              className="min-w-24"
            >
              {TAIL_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </Select>
          </label>

          <StatusPill status={status} follow={follow} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Toggle label="Follow" checked={follow} onChange={setFollow} />
          <Toggle label="Timestamps" checked={timestamps} onChange={setTimestamps} />
          <Toggle label="Wrap" checked={wrap} onChange={setWrap} />
          <Toggle label="Previous (crashed)" checked={previous} onChange={setPrevious} />

          <div className="relative ml-auto">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Highlight lines…"
              className="h-8 w-56 rounded-md border border-edge-default bg-surface-raised px-2.5 text-xs"
            />
          </div>
          <Button size="sm" variant={follow ? 'secondary' : 'primary'} onClick={() => setFollow((f) => !f)}>
            {follow ? 'Pause' : 'Resume'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setLines([])}>
            Clear
          </Button>
          <Button size="sm" variant="secondary" onClick={copy} disabled={lines.length === 0}>
            Copy
          </Button>
          <Button size="sm" variant="secondary" onClick={download} disabled={lines.length === 0}>
            Download
          </Button>
        </div>
      </CardHeader>

      <CardBody>
        <div className="mb-2 flex items-center gap-3 text-[11px] text-content-subtle">
          {status === 'streaming' ? <Spinner size={10} /> : null}
          <span>
            {matchCount.toLocaleString()} {matchCount === 1 ? 'line' : 'lines'}
            {needle ? ` matching "${filter.trim()}"` : ''}
            {lines.length >= MAX_LINES ? ` · buffer capped at ${MAX_LINES.toLocaleString()}` : ''}
          </span>
          {error ? <span className="text-rose-500">{error}</span> : null}
        </div>

        <div className="relative">
          <div
            ref={paneRef}
            className="max-h-[60vh] min-h-[16rem] overflow-auto rounded-xl border border-slate-800 bg-slate-950 font-mono text-[11px] leading-[1.55]"
          >
            {!podName || !containerName ? (
              <div className="p-6">
                <EmptyState
                  compact
                  title="No container selected"
                  description="Pick a namespace, pod, and container to start streaming logs."
                />
              </div>
            ) : status === 'streaming' && lines.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">Waiting for log output…</div>
            ) : lines.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                {status === 'ended' ? 'Stream ended — no log output.' : 'No log lines.'}
              </div>
            ) : (
              <div>
                {lines.map((line, i) => (
                  <LogLine key={i} index={i} line={line} wrap={wrap} needle={needle} />
                ))}
              </div>
            )}
          </div>
          {follow && !pinned && lines.length > 0 ? (
            <button
              type="button"
              onClick={jump}
              className="absolute bottom-3 right-3 rounded-full border border-emerald-400/60 bg-emerald-500/90 px-3 py-1 text-[11px] font-semibold text-white shadow-lg hover:bg-emerald-500"
            >
              Jump to live ↓
            </button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  )
}

export default LogsViewer

function LogLine({
  index,
  line,
  wrap,
  needle,
}: {
  index: number
  line: string
  wrap: boolean
  needle: string
}) {
  const level = detectLevel(line)
  const tone =
    level === 'error'
      ? 'text-rose-300'
      : level === 'warn'
        ? 'text-amber-200'
        : 'text-slate-200'
  const dimmed = needle.length > 0 && !line.toLowerCase().includes(needle)
  return (
    <div
      className={cn(
        'grid grid-cols-[3.5rem_auto] gap-3 px-3 py-0.5 hover:bg-white/[0.04]',
        tone,
        dimmed && 'opacity-30',
      )}
    >
      <span className="select-none text-right tabular-nums text-slate-600">{index + 1}</span>
      <span className={cn(wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
        {needle ? highlight(line, needle) : line}
      </span>
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange(v: boolean): void
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised px-2.5 py-1 text-[11px] text-content-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3"
      />
      {label}
    </label>
  )
}

function StatusPill({ status, follow }: { status: StreamStatus; follow: boolean }) {
  const map: Record<StreamStatus, { tone: string; label: string }> = {
    idle: { tone: 'bg-surface-sunken text-content-subtle', label: 'idle' },
    streaming: {
      tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
      label: follow ? 'streaming' : 'loading',
    },
    ended: { tone: 'bg-surface-sunken text-content-muted', label: 'ended' },
    error: { tone: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300', label: 'error' },
  }
  const { tone, label } = map[status]
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium', tone)}
    >
      {status === 'streaming' ? (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300/80" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
      ) : null}
      {label}
    </span>
  )
}

function detectLevel(line: string): 'error' | 'warn' | undefined {
  const s = line.toLowerCase()
  if (/\berror\b|\bfatal\b|\bpanic\b|\be\d{4}\b/.test(s)) return 'error'
  if (/\bwarn(ing)?\b|\bw\d{4}\b/.test(s)) return 'warn'
  return undefined
}

function highlight(line: string, needle: string): React.ReactNode {
  const lower = line.toLowerCase()
  const out: React.ReactNode[] = []
  let from = 0
  let key = 0
  for (;;) {
    const idx = lower.indexOf(needle, from)
    if (idx < 0) {
      out.push(<span key={`p${key++}`}>{line.slice(from)}</span>)
      break
    }
    if (idx > from) out.push(<span key={`p${key++}`}>{line.slice(from, idx)}</span>)
    out.push(
      <mark key={`m${key++}`} className="rounded bg-amber-300/30 px-0.5 text-amber-200">
        {line.slice(idx, idx + needle.length)}
      </mark>,
    )
    from = idx + needle.length
  }
  return <>{out}</>
}
