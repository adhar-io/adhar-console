import { useMemo, useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { lgtm } from '@adhar-console/api-clients'
import {
  DEFAULT_RANGE,
  TIME_RANGES,
  useLogs,
  type TimeRangeId,
} from '../data/observability.ts'

const LEVELS: Array<lgtm.LogEntry['level']> = ['debug', 'info', 'warn', 'error', 'fatal']

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

/**
 * Logs — LogQL search against Loki with level chips, label filters, and a
 * level histogram across the chosen time window.
 */
export function Logs() {
  const [range, setRange] = useState<TimeRangeId>(DEFAULT_RANGE)
  const [query, setQuery] = useState('')
  const [levels, setLevels] = useState<Set<string>>(new Set(['info', 'warn', 'error', 'fatal']))

  const q = useLogs(query, range, 200)
  const all = q.data ?? []
  const list = useMemo(
    () => all.filter((l) => !l.level || levels.has(l.level)),
    [all, levels],
  )

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const l of all) out[l.level ?? 'info'] = (out[l.level ?? 'info'] ?? 0) + 1
    return out
  }, [all])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-white p-2 shadow-sm">
        <RangeSelect value={range} onChange={setRange} />
        <LevelFilter levels={levels} setLevels={setLevels} counts={counts} />
        <div className="ml-2 flex flex-1 min-w-0 items-center gap-2">
          <span className="hidden font-mono text-[10px] uppercase tracking-wider text-content-subtle sm:inline">
            LogQL
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='{namespace="acme-billing"} |~ "error"'
            className="block min-w-0 flex-1 rounded-md border border-edge-default bg-white px-2 py-1 font-mono text-[12px] focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
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
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-content">Stream</div>
            <StatusBadge kind="info">{list.length} entries</StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="p-0!">
          {q.isLoading ? (
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

function RangeSelect({
  value,
  onChange,
}: {
  value: TimeRangeId
  onChange(v: TimeRangeId): void
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-edge-default bg-white p-1">
      {TIME_RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onChange(r.id)}
          className={
            value === r.id
              ? 'rounded bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700'
              : 'rounded px-2 py-0.5 text-[11px] text-content-muted hover:bg-surface-sunken'
          }
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

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
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-edge-default bg-white p-1">
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
