import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { kube } from '@adhar-console/api-clients/k8s'
import { LOCAL_CLUSTER } from '../data/client.ts'
import {
  buildMatcher,
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
} from './log-format.tsx'

/**
 * Full-featured log viewer for a pod (drawer panel).
 *
 * Features
 *   • Container picker (multi-container pods).
 *   • Tail-lines and since-duration filters.
 *   • Timestamps / wrap / line-numbers toggles.
 *   • Follow (auto-poll) + Pause; "live" pulse when actively tailing.
 *   • Find — plain or regex, case-(in)sensitive, hits highlighted inline +
 *     match count, plus a show-only-matching filter toggle.
 *   • Severity filter (Error/Warn/Info/Debug/Other) with per-line colour.
 *   • ANSI SGR colours rendered inline (stripped for copy / download).
 *   • Pin-to-bottom auto-scroll with a "Jump to live" rescue button.
 *   • Copy visible + download-as-`.log`.
 */

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
  const [tailLines, setTailLines] = useState<number>(500)
  const [since, setSince] = useState<SinceLabel>('all')
  const [timestamps, setTimestamps] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [lineNumbers, setLineNumbers] = useState(true)
  const [follow, setFollow] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [search, setSearch] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [filterMode, setFilterMode] = useState(false)
  const [shown, setShown] = useState<Record<Severity, boolean>>({
    error: true,
    warn: true,
    info: true,
    debug: true,
    other: true,
  })

  useEffect(() => {
    if (!container && containers.length) setContainer(containers[0])
  }, [container, containers])

  const sinceSeconds = sinceSecondsFor(since)
  // "Previous" is a static snapshot of the last-terminated instance — there's
  // nothing live to tail, so following is disabled while it's on.
  const effectiveFollow = follow && !previous

  /**
   * True log streaming, the same mechanism the pipeline console uses.
   *
   * This panel used to refetch the whole tail every two seconds. That has three
   * problems a real tail does not: new lines appear up to two seconds late, the
   * entire buffer is re-transferred each tick (expensive on a chatty pod), and
   * anything that scrolled past `tailLines` between polls is lost forever.
   * `logStream` holds one `follow` connection open and appends each chunk as
   * the kubelet emits it, so output arrives as it is written.
   *
   * "Previous" reads the last-terminated container, which is a fixed snapshot
   * with nothing to tail, so it always takes the one-shot path.
   */
  const [text, setText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [logError, setLogError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  /** Bumped by Reload to restart the stream without changing any option. */
  const [reloadNonce, setReloadNonce] = useState(0)
  /**
   * Bumped to *resume* a follow stream that ended on its own, keeping whatever
   * has already been read.
   *
   * A `follow` request is not a permanent subscription: the apiserver closes
   * idle log streams, and any network blip ends one too. The first version of
   * this panel treated that as "done" and stopped, so logs silently froze after
   * a while and looked disconnected. Resuming keeps the tail live.
   */
  const [resumeNonce, setResumeNonce] = useState(0)
  const resumeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!container || !podName) return
    const ctrl = new AbortController()
    // A resume continues the same session, so the buffer survives; every other
    // dependency change is a genuinely new query and starts clean.
    const resuming = resumeNonce > 0
    if (!resuming) {
      setText('')
      setLoading(true)
    }
    setLogError(null)
    setStreaming(effectiveFollow)

    kube
      .logStream(
        namespace,
        podName,
        {
          container,
          // On resume take a short overlap window instead of the whole tail:
          // re-reading `tailLines` would duplicate the buffer on every reconnect.
          tailLines: resumeNonce > 0 ? 0 : tailLines,
          timestamps,
          previous,
          sinceSeconds: resumeNonce > 0 ? 2 : sinceSeconds,
          follow: effectiveFollow,
          cluster: LOCAL_CLUSTER,
          signal: ctrl.signal,
        },
        (chunk) => {
          setLoading(false)
          setText((t) => t + chunk)
        },
      )
      .then((full) => {
        if (ctrl.signal.aborted) return
        setLoading(false)
        // Non-follow resolves with the whole body and never calls onChunk.
        if (!effectiveFollow) {
          setStreaming(false)
          setText((t) => (t ? t : full))
          return
        }
        // Following, and the apiserver ended the stream. Pick it back up rather
        // than leaving a dead tail on screen.
        resumeTimer.current = setTimeout(() => setResumeNonce((n) => n + 1), 1000) as unknown as number
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return
        setLoading(false)
        setStreaming(false)
        setLogError(e as Error)
      })

    return () => {
      ctrl.abort()
      if (resumeTimer.current) clearTimeout(resumeTimer.current)
    }
  }, [
    namespace,
    podName,
    container,
    tailLines,
    timestamps,
    previous,
    sinceSeconds,
    effectiveFollow,
    reloadNonce,
    resumeNonce,
  ])

  // Starting a genuinely new query resets the resume counter, so the next
  // stream clears the buffer instead of appending to the previous pod's output.
  useEffect(() => {
    setResumeNonce(0)
  }, [namespace, podName, container, tailLines, timestamps, previous, sinceSeconds, effectiveFollow, reloadNonce])

  // Shaped like the query object the rest of this component already reads, so
  // the switch from polling to streaming stays local to this block.
  const q = useMemo(
    () => ({
      data: text,
      isLoading: loading && !text,
      isError: logError !== null,
      error: logError,
      isFetching: streaming || loading,
      refetch: () => setReloadNonce((n) => n + 1),
    }),
    [text, loading, logError, streaming],
  )

  const lines = useMemo(() => (text ? text.replace(/\n$/, '').split('\n') : []), [text])

  const matcher = useMemo(
    () => buildMatcher(search.trim(), { regex: useRegex, caseSensitive }),
    [search, useRegex, caseSensitive],
  )

  const processed = useMemo(() => {
    const out: Array<{ text: string; plain: string; sev: Severity }> = []
    for (const l of lines) {
      const plain = stripAnsi(l)
      const sev = detectSeverity(plain)
      if (!shown[sev]) continue
      if (filterMode && matcher.active && !matcher.error && !matcher.test(plain)) continue
      out.push({ text: l, plain, sev })
    }
    return out
  }, [lines, shown, filterMode, matcher])

  const matchCount = useMemo(() => {
    if (!matcher.active || matcher.error) return 0
    let n = 0
    for (const p of processed) n += matcher.ranges(p.plain).length
    return n
  }, [processed, matcher])

  const download = () => {
    try {
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
    } catch {
      /* download blocked by sandbox — Copy still works */
    }
  }

  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    void navigator.clipboard.writeText(processed.map((p) => p.plain).join('\n'))
  }

  const toggleSeverity = (s: Severity) => setShown((prev) => ({ ...prev, [s]: !prev[s] }))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken p-2">
        <Pill>
          <label className="text-[11px] font-medium text-content-subtle">Container</label>
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="rounded border border-edge-default bg-surface-raised px-2 py-0.5 text-xs"
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
            onChange={(e) => setTailLines(Number(e.target.value))}
            className="rounded border border-edge-default bg-surface-raised px-2 py-0.5 text-xs"
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
            onChange={(e) => setSince(e.target.value as SinceLabel)}
            className="rounded border border-edge-default bg-surface-raised px-2 py-0.5 text-xs"
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
        <ToggleChip checked={lineNumbers} onChange={setLineNumbers} label="line #" />
        <button
          type="button"
          onClick={() => setPrevious((p) => !p)}
          title="Show logs from the previous (last-terminated) container instance — useful after a crash/restart"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
            previous
              ? 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/15 dark:text-amber-200'
              : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong',
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
            placeholder={useRegex ? 'Filter (regex)…' : 'Filter lines…'}
            className={cn(
              'h-7 w-56 rounded-md border bg-surface-raised pl-7 pr-2 text-xs',
              matcher.error ? 'border-rose-400' : 'border-edge-default',
            )}
          />
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-subtle">
            <IconSearch />
          </span>
        </div>
        <FilterChip active={useRegex} onClick={() => setUseRegex((v) => !v)} title="Regular-expression search">
          .*
        </FilterChip>
        <FilterChip active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="Case sensitive">
          Aa
        </FilterChip>
        <FilterChip active={filterMode} onClick={() => setFilterMode((v) => !v)} title="Show only matching lines">
          Only
        </FilterChip>
        <Button size="sm" variant="secondary" onClick={copy} title="Copy visible lines">
          Copy
        </Button>
        <Button size="sm" variant="secondary" onClick={download} title="Download as .log">
          Download
        </Button>
      </div>

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
      </div>

      {previous ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
          <IconHistory />
          <span>
            Showing logs from the <strong>previous terminated instance</strong> of{' '}
            <code className="font-mono">{container}</code> — the last run before the current one (restart/crash).
            Live tailing is paused.
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-content-subtle">
        {q.isFetching ? <Spinner size={10} /> : null}
        <span className="tabular-nums">
          {processed.length.toLocaleString()} shown
          {processed.length !== lines.length ? ` of ${lines.length.toLocaleString()}` : ''}{' '}
          {lines.length === 1 ? 'line' : 'lines'}
          {matcher.active && !matcher.error ? ` · ${matchCount.toLocaleString()} matches` : ''} · tail{' '}
          {tailLines.toLocaleString()}
          {sinceSeconds ? ` · last ${since}` : ''}
          {previous ? ' · previous instance' : ''}
        </span>
        {matcher.error ? <span className="text-rose-500">regex: {matcher.error}</span> : null}
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
        lines={processed}
        matcher={matcher}
        wrap={wrap}
        lineNumbers={lineNumbers}
        follow={effectiveFollow}
        loading={q.isLoading}
        hasSearch={matcher.active}
      />
    </div>
  )
}

function LogStream({
  lines,
  matcher,
  wrap,
  lineNumbers,
  follow,
  loading,
  hasSearch,
}: {
  lines: Array<{ text: string; sev: Severity }>
  matcher: ReturnType<typeof buildMatcher>
  wrap: boolean
  lineNumbers: boolean
  follow: boolean
  loading: boolean
  hasSearch: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

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
        className="max-h-[55vh] overflow-auto rounded-xl border border-code-edge bg-code font-mono text-[11px] leading-[1.55]"
      >
        {loading ? (
          <div className="p-6 text-center text-xs text-code-fg/55">Loading…</div>
        ) : lines.length === 0 ? (
          <div className="p-6 text-center text-xs text-code-fg/55">
            {hasSearch ? 'No lines match the current search / severity filter.' : 'No log lines.'}
          </div>
        ) : (
          <div className="py-1">
            {lines.map((line, i) => (
              <LogLine key={i} line={line.text} sev={line.sev} matcher={matcher} index={i} wrap={wrap} lineNumbers={lineNumbers} />
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
  sev,
  matcher,
  index,
  wrap,
  lineNumbers,
}: {
  line: string
  sev: Severity
  matcher: ReturnType<typeof buildMatcher>
  index: number
  wrap: boolean
  lineNumbers: boolean
}) {
  return (
    <div className={cn('flex gap-3 px-3 py-0.5 hover:bg-white/[0.04]', SEVERITY_TONE[sev])}>
      {lineNumbers ? (
        <span className="w-14 shrink-0 select-none text-right tabular-nums text-code-fg/40">{index + 1}</span>
      ) : null}
      <span className={cn('min-w-0', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
        {renderSegments(line, matcher)}
      </span>
    </div>
  )
}

/* ───── helpers ───── */

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised px-2 py-1">
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
    <label className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-edge-default bg-surface-raised px-2 py-1 text-[11px] text-content-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3 w-3" />
      {label}
    </label>
  )
}

function FilterChip({
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
        'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
        active
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/15 dark:text-brand-300'
          : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong',
      )}
    >
      {children}
    </button>
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

function IconHistory() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l4 2" />
    </svg>
  )
}

function IconArrowDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  )
}
