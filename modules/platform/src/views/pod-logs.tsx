import { useEffect, useMemo, useState } from 'react'
import { Button } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { LogConsole, type LogSource, useLogStream } from '../components/log-console.tsx'
import {
  SEVERITIES,
  SEVERITY_DOT,
  SEVERITY_LABEL,
  SINCE_OPTIONS,
  sinceSecondsFor,
  TAIL_OPTIONS,
  type Severity,
  type SinceLabel,
} from '@adhar-console/shell-ui'

/**
 * Pod logs (drawer panel).
 *
 * The console itself — toolbar, search, wrap, timestamps, line numbers, ANSI,
 * copy/download, fullscreen, jump-to-live — is `LogConsole`, the same component
 * the pipeline step console renders. This panel only decides *what* to stream:
 * which container, how much history, and whether to read the previous instance.
 *
 * It previously carried its own copy of all of that, plus its own streaming and
 * reconnect logic, which is why its behaviour drifted from the pipeline console.
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
  const [follow, setFollow] = useState(true)
  const [previous, setPrevious] = useState(false)
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

  // "Previous" is a static snapshot of the last-terminated instance — there is
  // nothing live to tail, so following is disabled while it is on.
  const effectiveFollow = follow && !previous

  const sources = useMemo<LogSource[]>(
    () => (container ? [{ pod: podName, container, label: container }] : []),
    [podName, container],
  )

  const stream = useLogStream({
    namespace,
    sources,
    follow: effectiveFollow,
    tailLines,
    previous,
    sinceSeconds: sinceSecondsFor(since),
  })

  const lines = useMemo(
    () => stream.lines.filter((l) => shown[l.severity]),
    [stream.lines, shown],
  )

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
          {effectiveFollow
            ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300/80" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                Following
              </span>
            )
            : 'Paused'}
        </Button>
        <span className="ml-auto text-[11px] tabular-nums text-content-subtle">
          {lines.length.toLocaleString()}
          {lines.length !== stream.lines.length ? ` of ${stream.lines.length.toLocaleString()}` : ''}{' '}
          {stream.lines.length === 1 ? 'line' : 'lines'}
        </span>
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

      {previous
        ? (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
            <IconHistory />
            <span>
              Showing logs from the <strong>previous terminated instance</strong> of{' '}
              <code className="font-mono">{container}</code> — the last run before the current one
              (restart/crash). Live tailing is paused.
            </span>
          </div>
        )
        : null}

      <LogConsole
        lines={lines}
        status={stream.status}
        error={stream.error}
        reconnect={stream.reconnect}
        label={container}
        live={effectiveFollow && stream.status === 'streaming'}
        filename={`${podName}-${container || 'container'}`}
        height="h-[30rem]"
        emptyMessage={previous
          ? 'The previous instance produced no output.'
          : effectiveFollow
          ? 'No log output yet.'
          : 'No log output.'}
      />
    </div>
  )
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised px-2.5 py-1">
      {children}
    </span>
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
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 1 0 2.64-6.36" />
      <path d="M3 3v6h6" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
