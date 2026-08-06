import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { client, LOCAL_CLUSTER } from '../data/client.ts'

/**
 * Full-featured log viewer for a pod.
 *
 * Features
 *   • Container picker (multi-container pods).
 *   • Tail-lines (100 / 500 / 1000 / 5000) and since-duration filters.
 *   • Timestamps toggle, line wrap toggle.
 *   • Follow (auto-poll) + Pause; "live" pulse when actively tailing.
 *   • Search filter — case-insensitive, hits highlighted inline + match count.
 *   • Per-line level tint (INFO / WARN / ERROR / DEBUG).
 *   • Pin-to-bottom auto-scroll with a "Jump to live" rescue button when the
 *     user scrolls back through history.
 *   • Copy-all-visible + download-as-`.log`.
 */

const TAIL_OPTIONS = [100, 500, 1000, 5000] as const
const SINCE_OPTIONS = [
  { label: 'all', seconds: undefined as number | undefined },
  { label: '5m', seconds: 5 * 60 },
  { label: '15m', seconds: 15 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '6h', seconds: 6 * 60 * 60 },
  { label: '24h', seconds: 24 * 60 * 60 },
] as const

export function PodLogsPanel({
  namespace,
  podName,
  containers,
}: {
  namespace: string
  podName: string
  containers: string[]
}) {
  const [container, setContainer] = useState<string>(containers[0] ?? '')
  const [tailLines, setTailLines] = useState<(typeof TAIL_OPTIONS)[number]>(500)
  const [since, setSince] = useState<(typeof SINCE_OPTIONS)[number]['label']>('all')
  const [timestamps, setTimestamps] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [follow, setFollow] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!container && containers.length) setContainer(containers[0])
  }, [container, containers])

  const sinceSeconds = SINCE_OPTIONS.find((s) => s.label === since)?.seconds
  // "Previous" is a static snapshot of the last-terminated instance — there's
  // nothing live to tail, so following is disabled while it's on.
  const effectiveFollow = follow && !previous

  const q = useQuery({
    queryKey: [
      'k8s',
      'pod-logs',
      namespace,
      podName,
      container,
      tailLines,
      timestamps,
      previous,
      sinceSeconds ?? null,
    ],
    queryFn: () =>
      client.podLogs(LOCAL_CLUSTER, namespace, podName, {
        container,
        tailLines,
        timestamps,
        sinceSeconds,
        previous,
      }),
    enabled: Boolean(container && podName),
    refetchInterval: effectiveFollow ? 2_000 : false,
    refetchOnWindowFocus: effectiveFollow,
    retry: false,
  })

  const text = q.data ?? ''
  const lines = useMemo(() => (text ? text.replace(/\n$/, '').split('\n') : []), [text])
  const filtered = useMemo(() => {
    if (!search) return lines
    const needle = search.toLowerCase()
    return lines.filter((l) => l.toLowerCase().includes(needle))
  }, [lines, search])

  const download = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    a.download = `${podName}_${container}_${stamp}.log`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    void navigator.clipboard.writeText(filtered.join('\n'))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken p-2">
        <Pill>
          <label className="text-[11px] font-medium text-content-subtle">Container</label>
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="rounded border border-edge-default bg-white px-2 py-0.5 text-xs"
          >
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Pill>
        <Pill>
          <label className="text-[11px] font-medium text-content-subtle">Tail</label>
          <select
            value={tailLines}
            onChange={(e) => setTailLines(Number(e.target.value) as typeof tailLines)}
            className="rounded border border-edge-default bg-white px-2 py-0.5 text-xs"
          >
            {TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </Pill>
        <Pill>
          <label className="text-[11px] font-medium text-content-subtle">Since</label>
          <select
            value={since}
            onChange={(e) => setSince(e.target.value as typeof since)}
            className="rounded border border-edge-default bg-white px-2 py-0.5 text-xs"
          >
            {SINCE_OPTIONS.map((s) => (
              <option key={s.label} value={s.label}>
                {s.label}
              </option>
            ))}
          </select>
        </Pill>
        <ToggleChip checked={timestamps} onChange={setTimestamps} label="timestamps" />
        <ToggleChip checked={wrap} onChange={setWrap} label="wrap" />
        <button
          type="button"
          onClick={() => setPrevious((p) => !p)}
          title="Show logs from the previous (last-terminated) container instance — useful after a crash/restart"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
            previous
              ? 'border-amber-300 bg-amber-100 text-amber-900'
              : 'border-edge-default bg-white text-content-muted hover:border-edge-strong',
          )}
        >
          <IconHistory />
          Previous
        </button>
        <Button
          size="sm"
          variant={effectiveFollow ? 'primary' : 'secondary'}
          disabled={previous}
          onClick={() => setFollow((f) => !f)}
          title={previous ? 'Following is unavailable for previous-instance logs' : undefined}
        >
          {effectiveFollow ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300/80" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Following
            </span>
          ) : (
            'Paused'
          )}
        </Button>
        <div className="relative ml-auto">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter lines…"
            className="h-7 w-56 rounded-md border border-edge-default bg-white pl-7 pr-2 text-xs"
          />
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-subtle">
            <IconSearch />
          </span>
        </div>
        <Button size="sm" variant="secondary" onClick={copy} title="Copy visible lines">
          Copy
        </Button>
        <Button size="sm" variant="secondary" onClick={download} title="Download as .log">
          Download
        </Button>
      </div>

      {previous ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          <IconHistory />
          <span>
            Showing logs from the <strong>previous terminated instance</strong> of{' '}
            <code className="font-mono">{container}</code> — the last run before the current one
            (restart/crash). Live tailing is paused.
          </span>
        </div>
      ) : null}

      <div className="flex items-center gap-3 text-[11px] text-content-subtle">
        {q.isFetching ? <Spinner size={10} /> : null}
        <span>
          {filtered.length.toLocaleString()} {filtered.length === 1 ? 'line' : 'lines'}
          {search ? ` matching "${search}"` : ''} · tail {tailLines.toLocaleString()}
          {sinceSeconds ? ` · last ${since}` : ''}
          {previous ? ' · previous instance' : ''}
        </span>
        {q.isError ? (
          <StatusBadge kind="failed">
            {previous
              ? 'No previous instance — this container has not restarted'
              : q.error instanceof Error
                ? q.error.message
                : 'error'}
          </StatusBadge>
        ) : null}
      </div>

      <LogStream
        lines={filtered}
        search={search}
        wrap={wrap}
        follow={effectiveFollow}
        loading={q.isLoading}
      />
    </div>
  )
}

function LogStream({
  lines,
  search,
  wrap,
  follow,
  loading,
}: {
  lines: string[]
  search: string
  wrap: boolean
  follow: boolean
  loading: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  // Pin behaviour: stay glued to the bottom while the user is at the bottom;
  // detach as soon as they scroll up so we don't fight their reading.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      setPinned(atBottom)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (pinned) el.scrollTop = el.scrollHeight
  }, [lines, pinned])

  const jump = () => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setPinned(true)
  }

  return (
    <div className="relative">
      <div
        ref={ref}
        className="max-h-[55vh] overflow-auto rounded-xl border border-slate-800 bg-slate-950 font-mono text-[11px] leading-[1.55]"
      >
        {loading ? (
          <div className="p-6 text-center text-xs text-slate-500">Loading…</div>
        ) : lines.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            No matching log lines{search ? ` for "${search}"` : ''}.
          </div>
        ) : (
          <div>
            {lines.map((line, i) => (
              <LogLine key={i} line={line} search={search} index={i} wrap={wrap} />
            ))}
          </div>
        )}
      </div>
      {!pinned && follow ? (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/60 bg-emerald-500/90 px-3 py-1 text-[11px] font-semibold text-white shadow-lg backdrop-blur hover:bg-emerald-500"
        >
          <IconArrowDown />
          Jump to live
        </button>
      ) : null}
    </div>
  )
}

function LogLine({
  line,
  search,
  index,
  wrap,
}: {
  line: string
  search: string
  index: number
  wrap: boolean
}) {
  const level = detectLevel(line)
  const tone =
    level === 'error'
      ? 'text-rose-300'
      : level === 'warn'
        ? 'text-amber-200'
        : level === 'debug'
          ? 'text-slate-400'
          : 'text-slate-200'
  return (
    <div
      className={cn(
        'grid grid-cols-[4rem_auto] gap-3 px-3 py-0.5 hover:bg-white/[0.04]',
        tone,
      )}
    >
      <span className="select-none text-right tabular-nums text-slate-600">{index + 1}</span>
      <span className={cn(wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
        {search ? highlight(line, search) : line}
      </span>
    </div>
  )
}

/* ───── helpers ───── */

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-edge-default bg-white px-2 py-1">
      {children}
    </span>
  )
}

function ToggleChip({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange(v: boolean): void
  label: string
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-edge-default bg-white px-2 py-1 text-[11px] text-content-muted">
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

function detectLevel(line: string): 'error' | 'warn' | 'info' | 'debug' | undefined {
  const s = line.toLowerCase()
  if (/\berror\b|\bfatal\b|\bpanic\b|\be\d{4}\b/.test(s)) return 'error'
  if (/\bwarn(ing)?\b|\bw\d{4}\b/.test(s)) return 'warn'
  if (/\bdebug\b|\btrace\b/.test(s)) return 'debug'
  if (/\binfo\b|\bi\d{4}\b/.test(s)) return 'info'
  return undefined
}

function highlight(line: string, q: string): React.ReactNode {
  if (!q) return line
  const lower = line.toLowerCase()
  const needle = q.toLowerCase()
  const out: React.ReactNode[] = []
  let from = 0
  let key = 0
  while (true) {
    const idx = lower.indexOf(needle, from)
    if (idx < 0) {
      out.push(<span key={`p${key++}`}>{line.slice(from)}</span>)
      break
    }
    if (idx > from) out.push(<span key={`p${key++}`}>{line.slice(from, idx)}</span>)
    out.push(
      <mark
        key={`m${key++}`}
        className="rounded bg-amber-300/30 px-0.5 text-amber-200"
      >
        {line.slice(idx, idx + needle.length)}
      </mark>,
    )
    from = idx + needle.length
  }
  return <>{out}</>
}

function IconSearch() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function IconHistory() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l4 2" />
    </svg>
  )
}

function IconArrowDown() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  )
}
