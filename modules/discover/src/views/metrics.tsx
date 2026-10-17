import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Button, Card, PrometheusIcon, useToast, useToolPublicUrl } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { DEFAULT_RANGE, TIME_RANGES, type TimeRangeId } from '../data/observability.ts'
import { detectSources, pickSource, withResponsesResolved } from '../data/golden-signals.ts'
import {
  autoStep,
  type InstantSample,
  type MetricMeta,
  promInstant,
  promLabelNames,
  promLabelValues,
  promRange,
  rangeMs,
  type RangeSeries,
  useMetricMetadata,
  useMetricNames,
} from '../data/prom.ts'
import {
  applySuggestion,
  type Context,
  cursorContext,
  formatValue,
  goldenPresets,
  guessUnit,
  loadHistory,
  pushHistory,
  saveHistory,
  starterFor,
  suggest,
  type Suggestion,
  type Unit,
} from '../data/promql-lite.ts'
import { readParams, replaceParams } from '../data/discover-links.ts'
import { IconCopy, IconExternal, Loading, MiniSelect, NoData, QueryError, Segmented, SERIES_MAX, seriesColor, SignalChart, VizStyle } from './viz.tsx'

/**
 * Metrics explorer.
 *
 * Left: a metric browser over everything Prometheus scrapes — search, type /
 * help / unit from `/api/v1/metadata`, label names and values for the picked
 * metric. Right: up to four PromQL queries (A–D) with autocomplete-lite and
 * history, drawn together on one chart (one y-axis, toggleable legend) or as a
 * table; instant or range mode; step control; golden-signal presets; copy as
 * PromQL and open in Grafana Explore.
 *
 * State lives in the URL (`q`, `q2`…`q4`, `range`, `step`, `mode`, `view`,
 * `unit`) so every dashboard widget can deep-link here with its own query.
 */

const MAX_QUERIES = 4
const REF = ['A', 'B', 'C', 'D']

const STEP_OPTIONS = [
  { value: 'auto', label: 'Step auto' },
  { value: '15', label: 'Step 15s' },
  { value: '30', label: 'Step 30s' },
  { value: '60', label: 'Step 1m' },
  { value: '300', label: 'Step 5m' },
  { value: '900', label: 'Step 15m' },
  { value: '3600', label: 'Step 1h' },
]
const UNIT_OPTIONS: Array<{ value: Unit; label: string }> = [
  { value: 'auto', label: 'Unit auto' },
  { value: 'short', label: 'Number' },
  { value: 'percent', label: 'Percent' },
  { value: 'ms', label: 'Milliseconds' },
  { value: 'seconds', label: 'Seconds' },
  { value: 'rps', label: 'Per second' },
  { value: 'bytes', label: 'Bytes' },
  { value: 'bytes/s', label: 'Bytes / s' },
  { value: 'cores', label: 'CPU cores' },
]

type Mode = 'range' | 'instant'
type View = 'chart' | 'table'

interface QueryRow {
  id: number
  expr: string
  enabled: boolean
}

function bootQueries(p: Record<string, string>): QueryRow[] {
  const exprs = [p.q, p.q2, p.q3, p.q4].filter((x): x is string => !!x && !!x.trim())
  return (exprs.length ? exprs : ['']).map((expr, i) => ({ id: i + 1, expr, enabled: true }))
}

export function Metrics() {
  const boot = useMemo(readParams, [])
  const toast = useToast()
  const [rows, setRows] = useState<QueryRow[]>(() => bootQueries(boot))
  // What has actually been run — typing doesn't fire queries; Run (⌘/Ctrl+Enter) does.
  const [committed, setCommitted] = useState<QueryRow[]>(() => bootQueries(boot).filter((r) => r.expr.trim()))
  const [range, setRange] = useState<TimeRangeId>(TIME_RANGES.some((r) => r.id === boot.range) ? (boot.range as TimeRangeId) : DEFAULT_RANGE)
  const [step, setStep] = useState(STEP_OPTIONS.some((o) => o.value === boot.step) ? boot.step : 'auto')
  const [mode, setMode] = useState<Mode>(boot.mode === 'instant' ? 'instant' : 'range')
  const [view, setView] = useState<View>(boot.view === 'table' ? 'table' : 'chart')
  const [unit, setUnit] = useState<Unit>(UNIT_OPTIONS.some((o) => o.value === boot.unit) ? (boot.unit as Unit) : 'auto')
  const [history, setHistory] = useState<string[]>(loadHistory)
  const [focusIdx, setFocusIdx] = useState(0)
  const nextId = useRef(rows.length + 1)

  const names = useMetricNames()
  const meta = useMetricMetadata()
  const src = useMemo(() => {
    const s = pickSource(detectSources(names.data ?? []))
    return s ? withResponsesResolved(s, names.data ?? []) : null
  }, [names.data])
  const presets = useMemo(() => goldenPresets(src), [src])

  useEffect(() => {
    const p: Record<string, string | null> = { q: null, q2: null, q3: null, q4: null }
    committed.forEach((r, i) => (p[i === 0 ? 'q' : `q${i + 1}`] = r.expr))
    replaceParams({ ...p, range: range === DEFAULT_RANGE ? null : range, step: step === 'auto' ? null : step, mode: mode === 'range' ? null : mode, view: view === 'chart' ? null : view, unit: unit === 'auto' ? null : unit })
  }, [committed, range, step, mode, view, unit])

  const run = (list = rows) => {
    const active = list.filter((r) => r.expr.trim())
    setCommitted(active.map((r) => ({ ...r })))
    let h = history
    for (const r of active) h = pushHistory(h, r.expr)
    setHistory(h)
    saveHistory(h)
  }
  const setExpr = (i: number, expr: string) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, expr } : r)))
  const addQuery = (expr = '') => {
    if (rows.length >= MAX_QUERIES) {
      toast.warning(`Up to ${MAX_QUERIES} queries per chart`)
      return
    }
    const next = [...rows, { id: nextId.current++, expr, enabled: true }]
    setRows(next)
    setFocusIdx(next.length - 1)
    if (expr) run(next)
  }
  const replaceFocused = (expr: string) => {
    const next = rows.map((r, i) => (i === Math.min(focusIdx, rows.length - 1) ? { ...r, expr } : r))
    setRows(next)
    run(next)
  }
  const applyPreset = (label: string) => {
    const p = presets.find((x) => `${x.group}/${x.label}` === label)
    if (!p) return
    const next = p.queries.slice(0, MAX_QUERIES).map((expr) => ({ id: nextId.current++, expr, enabled: true }))
    setRows(next)
    setUnit(p.unit)
    run(next)
  }

  const enabled = committed.filter((r) => rows.find((x) => x.id === r.id)?.enabled ?? true)
  const effUnit: Unit = unit === 'auto' ? guessUnit(enabled[0]?.expr ?? '') : unit
  const windowMs = rangeMs(range)
  const stepSec = step === 'auto' ? autoStep(windowMs, 200) : Number(step)

  const grafana = useToolPublicUrl('grafana')
  const grafanaHref = useMemo(() => {
    if (!grafana || !enabled.length) return ''
    const panes = {
      a: {
        queries: enabled.map((r, i) => ({ refId: REF[i], expr: r.expr, range: mode === 'range', instant: mode === 'instant' })),
        range: { from: `now-${range}`, to: 'now' },
      },
    }
    return `${grafana.replace(/\/$/, '')}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`
  }, [grafana, enabled, mode, range])

  const copy = async () => {
    const text = enabled.map((r) => r.expr).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success(enabled.length > 1 ? `Copied ${enabled.length} queries` : 'Copied PromQL')
    } catch {
      toast.error('Clipboard is not available in this context')
    }
  }

  return (
    <div className="space-y-4">
      <VizStyle />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <MetricBrowser
          names={names}
          meta={meta.data}
          onQuery={(expr) => replaceFocused(expr)}
          onAdd={(expr) => addQuery(expr)}
        />

        <div className="min-w-0 space-y-3">
          {/* Controls — one row above the chart. */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
            <Segmented value={mode} onChange={setMode} ariaLabel="Query type" options={[{ id: 'range', label: 'Range' }, { id: 'instant', label: 'Instant' }]} />
            {mode === 'range' ? (
              <>
                <Segmented value={range} onChange={setRange} ariaLabel="Time range" options={TIME_RANGES.map((r) => ({ id: r.id, label: r.label }))} />
                <MiniSelect ariaLabel="Step" value={step} onChange={setStep} options={STEP_OPTIONS.map((o) => (o.value === 'auto' ? { ...o, label: `Step auto (${stepLabel(autoStep(windowMs, 200))})` } : o))} />
              </>
            ) : null}
            <MiniSelect ariaLabel="Unit" value={unit} onChange={(v) => setUnit(v as Unit)} options={UNIT_OPTIONS} />
            <select
              aria-label="Presets"
              value=""
              onChange={(e) => applyPreset(e.target.value)}
              className="h-7 min-w-0 max-w-[11rem] rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] text-content focus:outline-none"
            >
              <option value="">Presets…</option>
              {[...new Set(presets.map((p) => p.group))].map((g) => (
                <optgroup key={g} label={g}>
                  {presets.filter((p) => p.group === g).map((p) => (
                    <option key={p.label} value={`${p.group}/${p.label}`}>{p.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <select
              aria-label="Query history"
              value=""
              onChange={(e) => e.target.value && replaceFocused(e.target.value)}
              disabled={!history.length}
              className="h-7 min-w-0 max-w-[11rem] rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] text-content focus:outline-none disabled:opacity-50"
            >
              <option value="">{history.length ? `History (${history.length})…` : 'No history'}</option>
              {history.map((h) => (
                <option key={h} value={h}>{h.length > 90 ? `${h.slice(0, 90)}…` : h}</option>
              ))}
            </select>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => run()}>Run</Button>
            </div>
          </div>

          <div className="space-y-2">
            {rows.map((r, i) => (
              <QueryEditor
                key={r.id}
                refId={REF[i]}
                color={seriesColor(i)}
                row={r}
                names={names.data ?? []}
                meta={meta.data}
                onChange={(expr) => setExpr(i, expr)}
                onFocus={() => setFocusIdx(i)}
                onRun={() => run()}
                onToggle={() => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))}
                onRemove={rows.length > 1 ? () => {
                  const next = rows.filter((_, j) => j !== i)
                  setRows(next)
                  setCommitted((c) => c.filter((x) => x.id !== r.id))
                } : undefined}
              />
            ))}
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-content-subtle">
              {rows.length < MAX_QUERIES ? (
                <button type="button" onClick={() => addQuery()} className="font-medium text-brand-700 hover:underline dark:text-brand-300">+ Add query</button>
              ) : null}
              <span className="hidden sm:inline">⌘/Ctrl + Enter to run · Tab accepts a suggestion</span>
            </div>
          </div>

          <Card className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge-subtle px-4 py-2.5">
              <Segmented value={view} onChange={setView} ariaLabel="Result view" options={[{ id: 'chart', label: 'Chart' }, { id: 'table', label: 'Table' }]} />
              <div className="flex items-center gap-1.5">
                <Button size="xs" variant="ghost" onClick={copy} disabled={!enabled.length} leading={<IconCopy />}>Copy PromQL</Button>
                {grafanaHref ? (
                  <a href={grafanaHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content">
                    <IconExternal /> Grafana Explore
                  </a>
                ) : null}
              </div>
            </div>
            <div className="p-4">
              {enabled.length === 0 ? (
                <NoData
                  title="No query yet"
                  hint="Pick a metric on the left, choose a preset, or type PromQL and press Run."
                  height={200}
                />
              ) : mode === 'range' ? (
                <RangeResult queries={enabled} windowMs={windowMs} stepSec={stepSec} unit={effUnit} view={view} />
              ) : (
                <InstantResult queries={enabled} unit={effUnit} view={view} />
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function stepLabel(s: number): string {
  return s >= 3600 ? `${s / 3600}h` : s >= 60 ? `${s / 60}m` : `${s}s`
}

/* ─────────────────────────── editor ─────────────────────────── */

function QueryEditor({
  refId,
  color,
  row,
  names,
  meta,
  onChange,
  onFocus,
  onRun,
  onToggle,
  onRemove,
}: {
  refId: string
  color: string
  row: QueryRow
  names: string[]
  meta?: Record<string, MetricMeta>
  onChange(v: string): void
  onFocus(): void
  onRun(): void
  onToggle(): void
  onRemove?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [ctx, setCtx] = useState<Context | null>(null)
  const [sel, setSel] = useState(0)
  const [open, setOpen] = useState(false)

  const labels = useQuery({
    queryKey: ['prom', 'labels', ctx?.metric ?? ''],
    queryFn: () => promLabelNames(ctx?.metric),
    enabled: open && !!ctx && (ctx.where === 'labelName' || ctx.where === 'grouping'),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const values = useQuery({
    queryKey: ['prom', 'label-values', ctx?.label ?? '', ctx?.metric ?? ''],
    queryFn: () => promLabelValues(ctx!.label!, ctx?.metric),
    enabled: open && ctx?.where === 'labelValue' && !!ctx.label,
    staleTime: 2 * 60_000,
    retry: false,
  })
  const suggestions: Suggestion[] = useMemo(
    () => (ctx ? suggest(ctx, { metrics: names, labels: labels.data, values: values.data, meta }) : []),
    [ctx, names, labels.data, values.data, meta],
  )
  const showList = open && suggestions.length > 0 && !(suggestions.length === 1 && suggestions[0].text === ctx?.prefix)

  const update = (el: HTMLTextAreaElement) => {
    setCtx(cursorContext(el.value, el.selectionStart ?? el.value.length))
    setSel(0)
  }
  const accept = (s: Suggestion) => {
    const el = ref.current
    if (!el || !ctx) return
    const cur = el.selectionStart ?? el.value.length
    const out = applySuggestion(el.value, ctx, s, cur)
    onChange(out.text)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(out.cursor, out.cursor)
      setCtx(cursorContext(out.text, out.cursor))
    })
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === 'Enter') {
      e.preventDefault()
      setOpen(false)
      onRun()
      return
    }
    if (!showList) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => (s + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => (s - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      accept(suggestions[sel])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className={cn('relative flex items-start gap-2 rounded-lg border border-edge-default bg-surface-raised p-2', !row.enabled && 'opacity-60')}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={row.enabled}
        title={row.enabled ? `Hide query ${refId}` : `Show query ${refId}`}
        className="mt-1 inline-flex h-6 w-7 shrink-0 items-center justify-center gap-1 rounded border border-edge-subtle font-mono text-[11px] font-semibold text-content"
      >
        <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: row.enabled ? color : 'transparent', outline: `1px solid ${color}` }} />
        {refId}
      </button>
      <div className="relative min-w-0 flex-1">
        <textarea
          ref={ref}
          value={row.expr}
          rows={Math.min(6, Math.max(1, row.expr.split('\n').length, Math.ceil(row.expr.length / 90)))}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`PromQL query ${refId}`}
          placeholder='sum by (namespace) (rate(container_cpu_usage_seconds_total[5m]))'
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
            update(e.target)
          }}
          onKeyDown={onKey}
          onClick={(e) => update(e.currentTarget)}
          onFocus={onFocus}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          className="block w-full resize-y rounded-md border border-edge-subtle bg-surface-sunken/50 px-2 py-1.5 font-mono text-[12px] leading-relaxed text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        {showList ? (
          <ul
            role="listbox"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-md border border-edge-default bg-surface-raised py-1 shadow-lg sm:right-auto sm:min-w-[22rem]"
          >
            {suggestions.map((s, i) => (
              <li
                key={`${s.kind}-${s.text}`}
                role="option"
                aria-selected={i === sel}
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(s)
                }}
                className={cn('flex cursor-pointer items-center gap-2 px-2 py-1 text-[11px]', i === sel ? 'bg-brand-50 dark:bg-brand-500/15' : 'hover:bg-surface-sunken')}
              >
                <span className="w-14 shrink-0 text-[9px] uppercase tracking-wide text-content-subtle">{s.kind}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-content">{s.text}</span>
                {s.detail ? <span className="shrink-0 text-[10px] text-content-subtle">{s.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove query ${refId}`} className="mt-1 rounded px-1.5 py-0.5 text-[13px] leading-none text-content-subtle hover:bg-surface-sunken hover:text-content">
          ×
        </button>
      ) : null}
    </div>
  )
}

/* ─────────────────────────── results ─────────────────────────── */

function labelText(metric: Record<string, string>): string {
  const name = metric.__name__ ?? ''
  const rest = Object.entries(metric).filter(([k]) => k !== '__name__')
  if (!rest.length) return name || '{}'
  return `${name}{${rest.map(([k, v]) => `${k}="${v}"`).join(', ')}}`
}

/** Short legend label: only labels that vary across the result set. */
function shortLabels(all: Array<Record<string, string>>): (m: Record<string, string>) => string {
  const keys = new Set<string>()
  for (const m of all) for (const k of Object.keys(m)) keys.add(k)
  const varying = [...keys].filter((k) => new Set(all.map((m) => m[k] ?? '')).size > 1)
  return (m) => {
    const parts = varying.filter((k) => m[k] !== undefined).map((k) => (k === '__name__' ? m[k] : `${k}=${m[k]}`))
    return parts.length ? parts.join(', ') : labelText(m)
  }
}

interface Tagged {
  ref: string
  metric: Record<string, string>
}

function RangeResult({ queries, windowMs, stepSec, unit, view }: { queries: QueryRow[]; windowMs: number; stepSec: number; unit: Unit; view: View }) {
  const results = useQueries({
    queries: queries.map((q) => ({
      queryKey: ['prom', 'explore-range', q.expr, windowMs, stepSec],
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        const end = Date.now()
        return promRange(q.expr, end - windowMs, end, stepSec, signal)
      },
      retry: false,
      staleTime: 10_000,
    })),
  })
  const combined: Array<RangeSeries & Tagged> = []
  results.forEach((r, i) => {
    for (const s of r.data ?? []) combined.push({ ...s, ref: REF[i] ?? '?' })
  })
  const errors = results.map((r, i) => (r.isError ? { ref: REF[i], error: r.error } : null)).filter(Boolean) as Array<{ ref: string; error: unknown }>
  if (results.every((r) => r.isLoading)) return <Loading height={220} />
  const name = shortLabels(combined.map((s) => ({ ...s.metric, ...(queries.length > 1 ? { query: s.ref } : {}) })))
  // Cap the chart at the palette size: the series with the highest peaks.
  const ranked = combined
    .map((s) => ({ s, peak: Math.max(...s.points.map((p) => p[1]), -Infinity) }))
    .sort((a, b) => b.peak - a.peak)
  const drawn = ranked.slice(0, SERIES_MAX).map((x) => x.s)
  return (
    <div className="space-y-3">
      {errors.map((e) => (
        <div key={e.ref} className="flex items-start gap-2 text-[11px]">
          <span className="font-mono font-semibold text-content">{e.ref}</span>
          <div className="min-w-0 flex-1"><QueryError error={e.error} /></div>
        </div>
      ))}
      {combined.length === 0 && !errors.length ? (
        <NoData title="Empty result" hint="The query is valid but matched no series in this window. Check the metric exists (left) and the label matchers." height={200} />
      ) : view === 'chart' && combined.length ? (
        <>
          <SignalChart
            series={drawn.map((s, i) => ({ name: name({ ...s.metric, ...(queries.length > 1 ? { query: s.ref } : {}) }), points: s.points, color: seriesColor(i) }))}
            unit={unit}
            height={240}
          />
          {combined.length > SERIES_MAX ? (
            <div className="text-[11px] text-content-subtle">
              Showing the {SERIES_MAX} series with the highest peaks of {combined.length}. Use the table for all, or aggregate the query (e.g. <code className="font-mono">topk(5, …)</code>).
            </div>
          ) : null}
        </>
      ) : combined.length ? (
        <SeriesTable rows={combined.map((s) => ({ ref: s.ref, metric: s.metric, values: s.points.map((p) => p[1]) }))} unit={unit} />
      ) : null}
    </div>
  )
}

function InstantResult({ queries, unit, view }: { queries: QueryRow[]; unit: Unit; view: View }) {
  const results = useQueries({
    queries: queries.map((q) => ({
      queryKey: ['prom', 'explore-instant', q.expr],
      queryFn: ({ signal }: { signal: AbortSignal }) => promInstant(q.expr, undefined, signal),
      retry: false,
      staleTime: 10_000,
    })),
  })
  if (results.every((r) => r.isLoading)) return <Loading height={160} />
  const all: Array<InstantSample & Tagged> = []
  results.forEach((r, i) => (r.data ?? []).forEach((s) => all.push({ ...s, ref: REF[i] })))
  const errors = results.map((r, i) => (r.isError ? { ref: REF[i], error: r.error } : null)).filter(Boolean) as Array<{ ref: string; error: unknown }>
  const sorted = all.slice().sort((a, b) => b.value - a.value)
  const max = Math.max(...sorted.map((s) => Math.abs(s.value)), 0) || 1
  const name = shortLabels(all.map((s) => s.metric))
  return (
    <div className="space-y-3">
      {errors.map((e) => (
        <div key={e.ref} className="flex items-start gap-2 text-[11px]">
          <span className="font-mono font-semibold text-content">{e.ref}</span>
          <div className="min-w-0 flex-1"><QueryError error={e.error} /></div>
        </div>
      ))}
      {all.length === 0 && !errors.length ? <NoData title="Empty result" hint="No series matched at the current instant." height={160} /> : view === 'table' ? (
        <SeriesTable rows={sorted.map((s) => ({ ref: s.ref, metric: s.metric, values: [s.value] }))} unit={unit} instant />
      ) : (
        <ol className="space-y-1.5">
          {sorted.slice(0, 30).map((s, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,40%)_5.5rem] items-center gap-2 text-[11px]">
              <span className="truncate font-mono text-content" title={labelText(s.metric)}>
                {queries.length > 1 ? <span className="mr-1 text-content-subtle">{s.ref}</span> : null}
                {name(s.metric)}
              </span>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <div className="h-full rounded-full" style={{ width: `${(Math.abs(s.value) / max) * 100}%`, backgroundColor: 'var(--viz-1)' }} />
              </div>
              <span className="text-right font-mono tabular-nums text-content">{formatValue(s.value, unit)}</span>
            </li>
          ))}
          {sorted.length > 30 ? <li className="text-[11px] text-content-subtle">{sorted.length - 30} more — switch to Table.</li> : null}
        </ol>
      )}
    </div>
  )
}

function SeriesTable({ rows, unit, instant = false }: { rows: Array<{ ref: string; metric: Record<string, string>; values: number[] }>; unit: Unit; instant?: boolean }) {
  type Key = 'last' | 'min' | 'max' | 'avg'
  const [sortKey, setSortKey] = useState<Key>('last')
  const stats = rows.map((r) => {
    const v = r.values
    const last = v.length ? v[v.length - 1] : null
    return {
      ...r,
      last,
      min: v.length ? Math.min(...v) : null,
      max: v.length ? Math.max(...v) : null,
      avg: v.length ? v.reduce((a, x) => a + x, 0) / v.length : null,
    }
  }).sort((a, b) => (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity))
  const cols: Key[] = instant ? ['last'] : ['last', 'min', 'max', 'avg']
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[520px] text-[11px]">
        <thead>
          <tr className="border-b border-edge-subtle text-left text-[10px] uppercase tracking-wide text-content-subtle">
            <th className="px-4 py-1.5 font-medium">Series</th>
            {cols.map((c) => (
              <th key={c} className="px-2 py-1.5 text-right font-medium last:pr-4">
                <button type="button" onClick={() => setSortKey(c)} className={cn('uppercase hover:text-content', sortKey === c && 'text-content')}>
                  {instant ? 'Value' : c}{sortKey === c ? ' ↓' : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-subtle">
          {stats.slice(0, 500).map((r, i) => (
            <tr key={i} className="hover:bg-surface-sunken/50">
              <td className="max-w-[36rem] px-4 py-1.5 font-mono text-content">
                <span className="mr-1.5 text-content-subtle">{r.ref}</span>
                <span className="break-all">{labelText(r.metric)}</span>
              </td>
              {cols.map((c) => (
                <td key={c} className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums text-content last:pr-4">{formatValue(r[c], unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {stats.length > 500 ? <div className="px-4 pt-2 text-[11px] text-content-subtle">First 500 of {stats.length} series.</div> : null}
    </div>
  )
}

/* ─────────────────────────── metric browser ─────────────────────────── */

const TYPE_TONE: Record<string, string> = {
  counter: 'bg-sky-50 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300',
  gauge: 'bg-violet-50 text-violet-800 dark:bg-violet-500/10 dark:text-violet-300',
  histogram: 'bg-orange-50 text-orange-800 dark:bg-orange-500/10 dark:text-orange-300',
  summary: 'bg-teal-50 text-teal-800 dark:bg-teal-500/10 dark:text-teal-300',
}

function MetricBrowser({
  names,
  meta,
  onQuery,
  onAdd,
}: {
  names: { data?: string[]; isLoading: boolean; isError: boolean; error: unknown }
  meta?: Record<string, MetricMeta>
  onQuery(expr: string): void
  onAdd(expr: string): void
}) {
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [picked, setPicked] = useState<string | null>(null)
  const [label, setLabel] = useState<string | null>(null)
  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    return (names.data ?? []).filter((n) => {
      if (type !== 'all' && (meta?.[n]?.type ?? 'unknown') !== type) return false
      if (!terms.length) return true
      const hay = `${n} ${meta?.[n]?.help ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [names.data, meta, search, type])
  const labels = useQuery({
    queryKey: ['prom', 'labels', picked ?? ''],
    queryFn: () => promLabelNames(picked!),
    enabled: !!picked,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const values = useQuery({
    queryKey: ['prom', 'label-values', label ?? '', picked ?? ''],
    queryFn: () => promLabelValues(label!, picked!),
    enabled: !!picked && !!label,
    staleTime: 2 * 60_000,
    retry: false,
  })
  const m = picked ? meta?.[picked] : undefined
  const shown = list.slice(0, 300)
  return (
    <Card className="flex min-w-0 flex-col lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)]">
      <div className="space-y-2 border-b border-edge-subtle p-3">
        <div className="flex items-center gap-2">
          <PrometheusIcon size={16} />
          <span className="text-sm font-semibold text-content">Metric browser</span>
          <span className="ml-auto text-[10px] text-content-subtle">{names.data ? `${list.length.toLocaleString()} / ${names.data.length.toLocaleString()}` : ''}</span>
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search names and help text…"
          aria-label="Search metrics"
          className="block h-8 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        <Segmented
          value={type}
          onChange={setType}
          ariaLabel="Metric type"
          options={[{ id: 'all', label: 'All' }, { id: 'counter', label: 'Counter' }, { id: 'gauge', label: 'Gauge' }, { id: 'histogram', label: 'Histo' }]}
        />
      </div>
      <div className="max-h-72 min-h-0 flex-1 overflow-y-auto lg:max-h-none">
        {names.isLoading ? <Loading height={120} /> : names.isError ? <div className="p-3"><QueryError error={names.error} /></div> : (
          <ul>
            {shown.map((n) => (
              <li key={n}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(n === picked ? null : n)
                    setLabel(null)
                  }}
                  className={cn('flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left text-[11px]', n === picked ? 'bg-brand-50 dark:bg-brand-500/15' : 'hover:bg-surface-sunken')}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-content" title={n}>{n}</span>
                  {meta?.[n] ? <span className={cn('shrink-0 rounded px-1 text-[9px] font-medium', TYPE_TONE[meta[n].type] ?? 'bg-surface-sunken text-content-subtle')}>{meta[n].type}</span> : null}
                </button>
                {n === picked ? (
                  <div className="space-y-2 border-y border-edge-subtle bg-surface-sunken/40 px-3 py-2 text-[11px]">
                    {m?.help ? <p className="leading-relaxed text-content-muted">{m.help}</p> : <p className="text-content-subtle">No HELP text in metadata.</p>}
                    {m?.unit ? <div className="text-content-subtle">unit <span className="font-mono text-content">{m.unit}</span></div> : null}
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="xs" variant="primary" onClick={() => onQuery(starterFor(n, m?.type))}>Query</Button>
                      <Button size="xs" onClick={() => onAdd(starterFor(n, m?.type))}>Add as new query</Button>
                    </div>
                    <div>
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-content-subtle">Labels</div>
                      {labels.isLoading ? <Loading height={30} /> : (
                        <div className="flex flex-wrap gap-1">
                          {(labels.data ?? []).map((l) => (
                            <button
                              key={l}
                              type="button"
                              onClick={() => setLabel(l === label ? null : l)}
                              aria-pressed={l === label}
                              className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px]', l === label ? 'border-brand-400 text-brand-700 dark:text-brand-300' : 'border-edge-default text-content-muted hover:text-content')}
                            >
                              {l}
                            </button>
                          ))}
                          {labels.data && !labels.data.length ? <span className="text-content-subtle">none</span> : null}
                        </div>
                      )}
                    </div>
                    {label ? (
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wide text-content-subtle">{label} values {values.data ? `(${values.data.length})` : ''}</div>
                        {values.isLoading ? <Loading height={30} /> : (
                          <ul className="max-h-40 overflow-y-auto">
                            {(values.data ?? []).slice(0, 100).map((v) => (
                              <li key={v}>
                                <button
                                  type="button"
                                  title={`Query ${n}{${label}="${v}"}`}
                                  onClick={() => onQuery(starterFor(`${n}`, m?.type).replace(n, `${n}{${label}="${v.replace(/"/g, '\\"')}"}`))}
                                  className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-content hover:bg-surface-raised"
                                >
                                  {v || '""'}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
            {list.length > shown.length ? <li className="px-3 py-2 text-[11px] text-content-subtle">{list.length - shown.length} more — refine the search.</li> : null}
            {list.length === 0 ? <li className="px-3 py-3 text-[11px] text-content-subtle">No metrics match.</li> : null}
          </ul>
        )}
      </div>
    </Card>
  )
}
