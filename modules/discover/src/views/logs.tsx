import { useEffect, useMemo, useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LegendDot,
  LokiIcon,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { lgtm } from '@adhar-console/api-clients'
import {
  DEFAULT_RANGE,
  TIME_RANGES,
  bucketLogsByLevel,
  presetSelection,
  selectionLabel,
  selectionToWindow,
  useLogs,
  type HistogramBucket,
  type TimeRangeId,
  type TimeSelection,
} from '../data/observability.ts'
import { SourceError } from './states.tsx'

const LEVELS: Array<lgtm.LogEntry['level']> = ['debug', 'info', 'warn', 'error', 'fatal']

/** One-click LogQL starters shown before a query is entered. */
const EXAMPLE_QUERIES: Array<{ label: string; query: string }> = [
  { label: 'all errors', query: '{namespace=~".+"} |= "error"' },
  { label: 'by namespace', query: '{namespace="acme-billing"}' },
  { label: 'by app', query: '{app="platform-bff"}' },
  { label: 'rate limited', query: '{namespace=~".+"} |~ "rate limit"' },
]

const LEVEL_TONE: Record<string, StatusKind> = {
  debug: 'unknown',
  info: 'info',
  warn: 'progressing',
  error: 'failed',
  fatal: 'failed',
}

const LEVEL_BG: Record<string, string> = {
  debug: 'bg-slate-100 text-slate-700',
  info: 'bg-sky-100 text-sky-700',
  warn: 'bg-amber-100 text-amber-700',
  error: 'bg-rose-100 text-rose-800',
  fatal: 'bg-rose-200 text-rose-900',
}

/** Histogram-bar colors, keyed to the three volume buckets. */
const HIST_COLOR = {
  error: 'var(--color-rose-500)',
  warn: 'var(--color-amber-500)',
  info: 'var(--color-sky-400)',
} as const

/**
 * Logs — LogQL search against Loki with level chips, label filters, a
 * quick-preset OR absolute time-range picker, and a clickable log-volume
 * histogram (colored by level) that zooms the query window.
 */
export function Logs() {
  const [sel, setSel] = useState<TimeSelection>(presetSelection(DEFAULT_RANGE))
  const [query, setQuery] = useState('')
  const [levels, setLevels] = useState<Set<string>>(new Set(['info', 'warn', 'error', 'fatal']))

  const hasQuery = query.trim().length > 0
  const q = useLogs(query, sel, 200)
  const all = q.data ?? []
  const list = useMemo(
    () => all.filter((l) => !l.level || levels.has(l.level)),
    [all, levels],
  )

  // Real log-volume histogram, bucketed by timestamp from the returned stream.
  const buckets = useMemo(() => {
    const { start, end } = selectionToWindow(sel)
    return bucketLogsByLevel(all, start, end)
  }, [all, sel])

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const l of all) out[l.level ?? 'info'] = (out[l.level ?? 'info'] ?? 0) + 1
    return out
  }, [all])

  const zoomTo = (b: HistogramBucket) =>
    setSel({ kind: 'absolute', from: new Date(b.start).toISOString(), to: new Date(b.end).toISOString() })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
        <RangeSelect sel={sel} onPreset={(id) => setSel(presetSelection(id))} />
        <CustomRange
          sel={sel}
          onApply={(from, to) => setSel({ kind: 'absolute', from, to })}
        />
        <LevelFilter levels={levels} setLevels={setLevels} counts={counts} />
        <div className="ml-2 flex flex-1 min-w-0 items-center gap-2">
          <span className="hidden font-mono text-[10px] uppercase tracking-wider text-content-subtle sm:inline">
            LogQL
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='{namespace="acme-billing"} |~ "error"'
            className="block min-w-0 flex-1 rounded-md border border-edge-default bg-surface-raised px-2 py-1 font-mono text-[12px] focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </div>
        {q.isFetching ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-content-subtle">
            <Spinner size={10} /> tailing
          </span>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-1 items-center justify-between gap-3">
            <div className="text-sm font-semibold text-content">
              Volume
              <span className="ml-2 text-[11px] font-normal text-content-subtle">{selectionLabel(sel)}</span>
            </div>
            <div className="flex items-center gap-3">
              <LegendDot color={HIST_COLOR.error}>error</LegendDot>
              <LegendDot color={HIST_COLOR.warn}>warn</LegendDot>
              <LegendDot color={HIST_COLOR.info}>info</LegendDot>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <Histogram buckets={buckets} levels={levels} onZoom={zoomTo} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-content">Stream</div>
            <StatusBadge kind="info">{list.length} entries</StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="p-0!">
          {!hasQuery ? (
            <div className="p-6">
              <EmptyState
                compact
                icon={<LokiIcon size={20} />}
                title="Enter a LogQL query"
                description="Loki needs a stream selector to start. Pick a starter or type your own above."
                action={
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {EXAMPLE_QUERIES.map((ex) => (
                      <button
                        key={ex.query}
                        type="button"
                        onClick={() => setQuery(ex.query)}
                        className="rounded-md border border-edge-default bg-surface-raised px-2 py-1 font-mono text-[11px] text-content-muted hover:border-brand-400 hover:text-content"
                      >
                        {ex.label}
                      </button>
                    ))}
                  </div>
                }
              />
            </div>
          ) : q.isError ? (
            <div className="p-6">
              <SourceError compact tool="Loki" error={q.error} onRetry={() => q.refetch()} icon={<LokiIcon size={20} />} />
            </div>
          ) : q.isLoading ? (
            <div className="flex h-40 items-center justify-center text-xs text-content-subtle">
              <Spinner size={12} />
            </div>
          ) : list.length === 0 ? (
            <EmptyState compact title="No log lines" description="Try a different range or query." />
          ) : (
            <ul className="divide-y divide-edge-subtle font-mono text-[12px]">
              {list.map((l, i) => (
                <LogRow key={i} entry={l} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

/* ─────────── time range controls ─────────── */

function RangeSelect({
  sel,
  onPreset,
}: {
  sel: TimeSelection
  onPreset(v: TimeRangeId): void
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-edge-default bg-surface-raised p-1">
      {TIME_RANGES.map((r) => {
        const active = sel.kind === 'preset' && sel.id === r.id
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onPreset(r.id)}
            className={
              active
                ? 'rounded bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700'
                : 'rounded px-2 py-0.5 text-[11px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {r.label}
          </button>
        )
      })}
    </div>
  )
}

function CustomRange({
  sel,
  onApply,
}: {
  sel: TimeSelection
  onApply(from: string, to: string): void
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // Sync the inputs to the active window whenever it changes (preset click,
  // histogram zoom) so opening the editor starts from the current range.
  useEffect(() => {
    const w = selectionToWindow(sel)
    setFrom(toLocalInput(w.start))
    setTo(toLocalInput(w.end))
  }, [sel])

  const active = sel.kind === 'absolute'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px]',
          active ? 'font-semibold text-brand-700' : 'text-content-muted hover:bg-surface-sunken',
        )}
      >
        <IconClock />
        {active ? selectionLabel(sel) : 'custom'}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-edge-default bg-surface-raised p-3 shadow-lg">
          <div className="space-y-2">
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              From
              <input
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 block w-full rounded border border-edge-default bg-surface-raised px-2 py-1 font-mono text-[11px] focus:border-brand-400 focus:outline-none"
              />
            </label>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              To
              <input
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 block w-full rounded border border-edge-default bg-surface-raised px-2 py-1 font-mono text-[11px] focus:border-brand-400 focus:outline-none"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-2 py-1 text-[11px] text-content-muted hover:bg-surface-sunken"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!from || !to || new Date(from) >= new Date(to)}
              onClick={() => {
                onApply(new Date(from).toISOString(), new Date(to).toISOString())
                setOpen(false)
              }}
              className="rounded bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── histogram ─────────── */

function Histogram({
  buckets,
  levels,
  onZoom,
}: {
  buckets: HistogramBucket[]
  levels: Set<string>
  onZoom(b: HistogramBucket): void
}) {
  const showError = levels.has('error') || levels.has('fatal')
  const showWarn = levels.has('warn')
  const showInfo = levels.has('info') || levels.has('debug')

  const shown = (b: HistogramBucket) =>
    (showError ? b.error : 0) + (showWarn ? b.warn : 0) + (showInfo ? b.info : 0)

  const max = Math.max(1, ...buckets.map(shown))
  const H = 76

  if (buckets.length === 0) {
    return (
      <div className="flex h-[76px] items-center justify-center text-xs text-content-subtle">
        No volume in range.
      </div>
    )
  }

  return (
    <div className="flex items-end gap-px" style={{ height: H }}>
      {buckets.map((b, i) => {
        const total = shown(b)
        const segs: Array<{ key: string; n: number; color: string }> = [
          showError ? { key: 'error', n: b.error, color: HIST_COLOR.error } : null,
          showWarn ? { key: 'warn', n: b.warn, color: HIST_COLOR.warn } : null,
          showInfo ? { key: 'info', n: b.info, color: HIST_COLOR.info } : null,
        ].filter(Boolean) as Array<{ key: string; n: number; color: string }>
        return (
          <button
            key={i}
            type="button"
            onClick={() => onZoom(b)}
            title={`${fmtRange(b)}\nerror ${b.error} · warn ${b.warn} · info ${b.info}`}
            className="group relative flex h-full flex-1 flex-col justify-end rounded-sm hover:bg-surface-sunken/50"
          >
            {segs.map((s) => (
              <div
                key={s.key}
                style={{ height: `${(s.n / max) * 100}%`, backgroundColor: s.color }}
                className="w-full first:rounded-t-sm"
              />
            ))}
            <span className="pointer-events-none absolute -top-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100">
              {total} lines
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ─────────── stream rows ─────────── */

function LevelFilter({
  levels,
  setLevels,
  counts,
}: {
  levels: Set<string>
  setLevels(s: Set<string>): void
  counts: Record<string, number>
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-edge-default bg-surface-raised p-1">
      {LEVELS.map((lvl) => {
        const on = lvl ? levels.has(lvl) : false
        const c = counts[lvl ?? ''] ?? 0
        return (
          <button
            key={lvl}
            type="button"
            onClick={() => {
              const next = new Set(levels)
              if (on) next.delete(lvl!)
              else next.add(lvl!)
              setLevels(next)
            }}
            className={cn(
              'rounded px-2 py-0.5 text-[11px] font-semibold transition-colors',
              on ? LEVEL_BG[lvl ?? 'info'] : 'text-content-subtle hover:bg-surface-sunken',
            )}
          >
            {lvl}
            <span className="ml-1 font-mono text-[9px] tabular-nums opacity-70">{c}</span>
          </button>
        )
      })}
    </div>
  )
}

function LogRow({ entry }: { entry: lgtm.LogEntry }) {
  const tone = LEVEL_TONE[entry.level ?? 'info']
  return (
    <li className="grid grid-cols-[auto_60px_1fr_auto] items-start gap-3 px-5 py-1.5 hover:bg-brand-50/40">
      <span className="text-[10px] tabular-nums text-content-subtle">
        {fmtTs(entry.timestamp)}
      </span>
      <StatusBadge kind={tone}>{entry.level ?? 'info'}</StatusBadge>
      <span className="break-all text-content">{entry.message}</span>
      {entry.labels ? (
        <div className="hidden flex-wrap gap-1 sm:flex">
          {Object.entries(entry.labels)
            .slice(0, 3)
            .map(([k, v]) => (
              <span
                key={k}
                className="inline-flex items-center rounded bg-surface-sunken px-1.5 py-0.5 text-[9px] text-content-subtle"
              >
                <span className="opacity-60">{k}=</span>
                {v}
              </span>
            ))}
        </div>
      ) : null}
    </li>
  )
}

/* ─────────── helpers ─────────── */

function fmtTs(iso: string): string {
  try {
    const d = new Date(iso)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  } catch {
    return '—'
  }
}
function pad(n: number) {
  return String(n).padStart(2, '0')
}

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtRange(b: HistogramBucket): string {
  const f = new Date(b.start)
  const t = new Date(b.end)
  return `${pad(f.getHours())}:${pad(f.getMinutes())} – ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
