import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, LegendDot, Spinner, TempoIcon, TimeSeriesChart, useElementWidth, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { DEFAULT_RANGE, rangeToWindow, TIME_RANGES, type TimeRangeId } from '../data/observability.ts'
import {
  buildTraceQL,
  compareTraces,
  criticalPath,
  EMPTY_FORM,
  fmtMs,
  orderSpans,
  percentile,
  selfTimes,
  serviceBreakdown,
  type TagOp,
  type TraceHit,
  type TraceSearchForm,
  type TraceSpan,
} from '../data/traceql.ts'
import {
  type RedRow,
  type SpanMetricsFamily,
  useRedSeries,
  useRedTable,
  useSpanMetricsFamily,
  useTempoTrace,
  useTraceOperations,
  useTraceSearch,
  useTraceServices,
  useTraceTagNames,
} from '../data/traces-api.ts'
import { discoverUrl, goLogs, patchParams, readParam } from '../data/discover-nav.ts'
import { SourceError } from './states.tsx'
import {
  copyText,
  Drawer,
  IconBad,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconOk,
  IconPlus,
  InlineHint,
  KvTable,
  MiniSelect,
  Panel,
  Segmented,
  StatTile,
} from './discover-ui.tsx'

/**
 * Traces — a Tempo workbench.
 *
 *   • Search    — TraceQL built from service / operation / status / kind /
 *                 duration / attribute filters (or typed raw), over a time
 *                 window. Results as a duration-over-time scatter (click a
 *                 point to open it) plus a sortable table; pick two rows to
 *                 compare them.
 *   • Services  — RED (rate, errors, p95) per service and per operation from
 *                 spanmetrics, when Tempo's metrics-generator or the OTel
 *                 spanmetrics connector is scraped. Honest hint otherwise.
 *   • Trace     — collapsible waterfall in tree order with a time ruler,
 *                 critical-path highlighting, per-service self-time breakdown,
 *                 span attributes / resource / events / links, and a jump to
 *                 the logs that carry the trace id.
 *
 * `?trace=<id>` deep-links straight into a trace.
 */

const SERVICE_PALETTE = [
  'var(--color-brand-500)',
  'var(--color-sky-500)',
  'var(--color-violet-500)',
  'var(--color-teal-500)',
  'var(--color-fuchsia-500)',
  'var(--color-lime-600)',
  'var(--color-indigo-400)',
  'var(--color-cyan-600)',
]
const ERR_COLOR = 'var(--color-rose-500)'

function colorFor(services: string[], svc: string): string {
  const i = services.indexOf(svc)
  return SERVICE_PALETTE[(i < 0 ? 0 : i) % SERVICE_PALETTE.length]
}

const LIMITS = [20, 50, 100, 200, 500]
const TAG_OPS: TagOp[] = ['=', '!=', '=~', '!~', '>', '>=', '<', '<=']

interface Submitted {
  query: string
  start: string
  end: string
  limit: number
}

export function Traces() {
  const toast = useToast()
  // Deep-link context from the dashboard / service map:
  // ?section=traces&service=<svc>&status=error&range=1h (and ?trace=<id>).
  const boot = useMemo(() => {
    const r = readParam('range')
    const st = readParam('status')
    const form: TraceSearchForm = {
      ...EMPTY_FORM,
      service: readParam('service') || undefined,
      status: st === 'error' || st === 'ok' || st === 'unset' ? st : 'any',
    }
    return { range: (TIME_RANGES.some((x) => x.id === r) ? r : DEFAULT_RANGE) as TimeRangeId, form }
  }, [])
  const [range, setRange] = useState<TimeRangeId>(boot.range)
  const [form, setForm] = useState<TraceSearchForm>(boot.form)
  const [mode, setMode] = useState<'builder' | 'traceql'>('builder')
  const [raw, setRaw] = useState('{}')
  const [limit, setLimit] = useState(50)
  const [tab, setTab] = useState<'search' | 'services'>('search')
  const [openId, setOpenId] = useState<string | null>(() => readParam('trace') ?? null)
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)

  const built = useMemo(() => buildTraceQL(form), [form])
  const [submitted, setSubmitted] = useState<Submitted>(() => {
    const { start, end } = rangeToWindow(boot.range)
    return { query: buildTraceQL(boot.form), start: start.toISOString(), end: end.toISOString(), limit: 50 }
  })

  const win = useMemo(() => rangeToWindow(range), [range])
  const services = useTraceServices(win.start, win.end)
  const operations = useTraceOperations(form.service || undefined, win.start, win.end)
  const tagNames = useTraceTagNames(win.start, win.end)

  const search = useTraceSearch(submitted.query, new Date(submitted.start), new Date(submitted.end), submitted.limit, tab === 'search')
  const hits = useMemo(() => search.data ?? [], [search.data])

  const run = (query = mode === 'builder' ? built : raw) => {
    const { start, end } = rangeToWindow(range)
    setSubmitted({ query: query.trim() || '{}', start: start.toISOString(), end: end.toISOString(), limit })
    setPicked([])
  }

  const open = (id: string | null) => {
    setOpenId(id)
    patchParams({ trace: id ?? undefined })
  }

  const togglePick = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2)))

  const allServices = useMemo(() => {
    const s = new Set<string>()
    for (const h of hits) if (h.rootServiceName) s.add(h.rootServiceName)
    return [...s].sort()
  }, [hits])

  return (
    <div className="space-y-4">
      {/* ═══ toolbar ═══ */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={tab}
          onChange={setTab}
          ariaLabel="Traces view"
          options={[
            { id: 'search', label: 'Search' },
            { id: 'services', label: 'Services · RED' },
          ]}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <MiniSelect
            label="Time range"
            value={range}
            onChange={(v) => setRange(v as TimeRangeId)}
            options={TIME_RANGES.map((r) => [r.id, `Last ${r.label}`])}
          />
          {tab === 'search' ? (
            <>
              <MiniSelect label="Result limit" value={String(limit)} onChange={(v) => setLimit(Number(v))} options={LIMITS.map((n) => [String(n), `${n} traces`])} />
              <Button size="sm" variant="primary" onClick={() => run()} loading={search.isFetching}>
                Search
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {tab === 'search' ? (
        <>
          <SearchBuilder
            form={form}
            onForm={setForm}
            mode={mode}
            onMode={(m) => {
              if (m === 'traceql') setRaw(built)
              setMode(m)
            }}
            raw={raw}
            onRaw={setRaw}
            built={built}
            services={services.data ?? []}
            servicesError={services.isError}
            operations={operations.data ?? []}
            tagNames={tagNames.data ?? []}
            onRun={run}
          />

          {search.isError ? (
            <SourceError tool="Tempo" error={search.error} onRetry={() => search.refetch()} icon={<TempoIcon size={20} />} />
          ) : search.isLoading ? (
            <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted">
              <Spinner size={14} /> Searching Tempo…
            </div>
          ) : hits.length === 0 ? (
            <EmptyState
              icon={<TempoIcon size={20} />}
              title="No traces match"
              description={`Tempo found nothing for ${submitted.query} in this window. Widen the time range, relax the filters, or check that services export OTLP traces to Tempo.`}
            />
          ) : (
            <>
              <ResultsSummary hits={hits} query={submitted.query} />
              <Panel
                title={`Duration over time · ${hits.length} traces`}
                right={allServices.length >= 2 || hits.some((h) => h.error) ? (
                  <div className="flex flex-wrap items-center gap-3">
                    {allServices.slice(0, 6).map((s) => <LegendDot key={s} color={colorFor(allServices, s)}>{s}</LegendDot>)}
                    {hits.some((h) => h.error) ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-rose-700 dark:text-rose-300"><IconBad /> error (ringed)</span>
                    ) : null}
                  </div>
                ) : null}
              >
                <Scatter hits={hits} services={allServices} start={+new Date(submitted.start)} end={+new Date(submitted.end)} onOpen={open} />
              </Panel>
              <ResultsTable
                hits={hits}
                services={allServices}
                picked={picked}
                onPick={togglePick}
                onOpen={open}
                onCompare={() => setComparing(true)}
                onClearPick={() => setPicked([])}
              />
            </>
          )}
        </>
      ) : (
        <ServicesRed start={win.start} end={win.end} onSearch={(svc) => {
          const next = { ...EMPTY_FORM, service: svc }
          setForm(next)
          setMode('builder')
          setTab('search')
          const { start, end } = rangeToWindow(range)
          setSubmitted({ query: buildTraceQL(next), start: start.toISOString(), end: end.toISOString(), limit })
        }} />
      )}

      <TraceDrawer
        traceID={openId}
        hint={hits.find((h) => h.traceID === openId)}
        onClose={() => open(null)}
        onCopyLink={(id) => {
          copyText(discoverUrl('traces', { trace: id }))
          toast.success('Trace link copied')
        }}
      />
      {comparing && picked.length === 2 ? (
        <CompareDrawer a={picked[0]} b={picked[1]} hits={hits} onClose={() => setComparing(false)} />
      ) : null}
    </div>
  )
}

/* ─────────────────────── search builder ─────────────────────── */

function SearchBuilder({
  form,
  onForm,
  mode,
  onMode,
  raw,
  onRaw,
  built,
  services,
  servicesError,
  operations,
  tagNames,
  onRun,
}: {
  form: TraceSearchForm
  onForm(f: TraceSearchForm): void
  mode: 'builder' | 'traceql'
  onMode(m: 'builder' | 'traceql'): void
  raw: string
  onRaw(v: string): void
  built: string
  services: string[]
  servicesError: boolean
  operations: string[]
  tagNames: Array<{ scope: 'span' | 'resource'; key: string }>
  onRun(q?: string): void
}) {
  const set = (patch: Partial<TraceSearchForm>) => onForm({ ...form, ...patch })
  const inputCls = 'h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none'
  return (
    <section className="rounded-xl border border-edge-default bg-surface-raised p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-sunken px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-content-muted">
          <TempoIcon size={12} /> TraceQL
        </span>
        <Segmented
          size="xs"
          value={mode}
          onChange={onMode}
          ariaLabel="Query mode"
          options={[{ id: 'builder', label: 'Builder' }, { id: 'traceql', label: 'Code' }]}
        />
        {mode === 'builder' ? (
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-content-muted" title={built}>{built}</code>
        ) : null}
      </div>

      {mode === 'traceql' ? (
        <textarea
          value={raw}
          onChange={(e) => onRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onRun(raw)
            }
          }}
          rows={3}
          spellCheck={false}
          aria-label="TraceQL query"
          placeholder='{ resource.service.name = "api" && status = error } | select(span.http.route)'
          className="w-full resize-y rounded-lg border border-edge-default bg-surface-app px-3 py-2 font-mono text-[12px] leading-5 text-content outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20"
        />
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <label className="flex flex-col gap-1 lg:col-span-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Service</span>
              <input
                list="trace-services"
                value={form.service ?? ''}
                onChange={(e) => set({ service: e.target.value || undefined, operation: undefined })}
                placeholder={servicesError ? 'type a service name' : 'any service'}
                className={inputCls}
              />
              <datalist id="trace-services">{services.map((s) => <option key={s} value={s} />)}</datalist>
            </label>
            <label className="flex flex-col gap-1 lg:col-span-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Operation (span name)</span>
              <input
                list="trace-ops"
                value={form.operation ?? ''}
                onChange={(e) => set({ operation: e.target.value || undefined })}
                placeholder="any operation"
                className={inputCls}
              />
              <datalist id="trace-ops">{operations.slice(0, 500).map((s) => <option key={s} value={s} />)}</datalist>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Min duration</span>
              <input value={form.minDuration ?? ''} onChange={(e) => set({ minDuration: e.target.value })} placeholder="e.g. 250ms" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Max duration</span>
              <input value={form.maxDuration ?? ''} onChange={(e) => set({ maxDuration: e.target.value })} placeholder="e.g. 5s" className={inputCls} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Status</span>
            <Segmented
              size="xs"
              value={form.status ?? 'any'}
              onChange={(v) => set({ status: v })}
              options={[{ id: 'any', label: 'Any' }, { id: 'error', label: 'Error' }, { id: 'ok', label: 'OK' }, { id: 'unset', label: 'Unset' }]}
            />
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Kind</span>
            <MiniSelect
              label="Span kind"
              value={form.kind ?? 'any'}
              onChange={(v) => set({ kind: v as TraceSearchForm['kind'] })}
              options={[['any', 'any'], ['server', 'server'], ['client', 'client'], ['producer', 'producer'], ['consumer', 'consumer'], ['internal', 'internal']]}
              className="h-7"
            />
          </div>
          {form.tags.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <MiniSelect
                label="Attribute scope"
                value={t.scope}
                onChange={(v) => set({ tags: form.tags.map((x, j) => (j === i ? { ...x, scope: v as 'span' } : x)) })}
                options={[['span', 'span.'], ['resource', 'resource.'], ['any', '.']]}
                className="h-7"
              />
              <input
                list="trace-tags"
                value={t.key}
                onChange={(e) => set({ tags: form.tags.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
                placeholder="http.status_code"
                aria-label="Attribute"
                className={cn(inputCls, 'h-7 w-48 font-mono')}
              />
              <MiniSelect
                label="Operator"
                value={t.op}
                onChange={(v) => set({ tags: form.tags.map((x, j) => (j === i ? { ...x, op: v as TagOp } : x)) })}
                options={TAG_OPS.map((o) => [o, o])}
                className="h-7 font-mono"
              />
              <input
                value={t.value}
                onChange={(e) => set({ tags: form.tags.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                placeholder="500"
                aria-label="Value"
                className={cn(inputCls, 'h-7 w-48 font-mono')}
              />
              <button
                type="button"
                aria-label="Remove filter"
                onClick={() => set({ tags: form.tags.filter((_, j) => j !== i) })}
                className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
              >
                <IconClose />
              </button>
            </div>
          ))}
          <datalist id="trace-tags">{tagNames.map((t) => <option key={`${t.scope}.${t.key}`} value={t.key}>{t.scope}</option>)}</datalist>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => set({ tags: [...form.tags, { scope: 'span', key: '', op: '=', value: '' }] })}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content"
            >
              <IconPlus /> Attribute filter
            </button>
            {form.service || form.operation || form.tags.length || form.minDuration || form.maxDuration || (form.status && form.status !== 'any') ? (
              <button
                type="button"
                onClick={() => onForm(EMPTY_FORM)}
                className="inline-flex h-7 items-center rounded-md px-2 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
}

/* ─────────────────────── results ─────────────────────── */

function ResultsSummary({ hits, query }: { hits: TraceHit[]; query: string }) {
  const d = hits.map((h) => h.durationMs)
  const known = hits.filter((h) => h.error !== undefined)
  const errors = known.filter((h) => h.error).length
  const slowest = hits.reduce((a, b) => (b.durationMs > a.durationMs ? b : a), hits[0])
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile label="Traces" value={hits.length} hint={<code className="font-mono">{query}</code>} />
      <StatTile label="p50 duration" value={fmtMs(percentile(d, 50))} hint="of the returned traces" />
      <StatTile label="p95 duration" value={fmtMs(percentile(d, 95))} hint="of the returned traces" />
      <StatTile label="p99 duration" value={fmtMs(percentile(d, 99))} hint={`slowest ${fmtMs(slowest?.durationMs ?? NaN)}`} />
      {known.length ? (
        <StatTile
          label="With errors"
          value={errors}
          tone={errors ? 'bad' : 'ok'}
          icon={errors ? <IconBad /> : <IconOk />}
          hint={errors ? 'matched an error span' : 'no error spans matched'}
        />
      ) : (
        <StatTile label="Services" value={new Set(hits.map((h) => h.rootServiceName)).size} hint="distinct root services" />
      )}
    </div>
  )
}

function Scatter({
  hits,
  services,
  start,
  end,
  onOpen,
}: {
  hits: TraceHit[]
  services: string[]
  start: number
  end: number
  onOpen(id: string): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref) || 640
  const [log, setLog] = useState(false)
  const [hover, setHover] = useState<TraceHit | null>(null)
  const H = 180
  const PAD = { l: 52, r: 12, t: 10, b: 22 }
  const plotW = Math.max(10, width - PAD.l - PAD.r)
  const plotH = H - PAD.t - PAD.b
  const maxD = Math.max(1, ...hits.map((h) => h.durationMs))
  const minD = Math.max(0.01, Math.min(...hits.map((h) => h.durationMs || maxD)))
  const t0 = Math.min(start, ...hits.map((h) => h.startMs))
  const t1 = Math.max(end, ...hits.map((h) => h.startMs))
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * plotW
  const y = (d: number) => {
    if (log) {
      const a = Math.log10(minD)
      const b = Math.log10(maxD)
      return PAD.t + plotH - ((Math.log10(Math.max(minD, d)) - a) / Math.max(1e-9, b - a)) * plotH
    }
    return PAD.t + plotH - (d / maxD) * plotH
  }
  const yTicks = log
    ? [minD, Math.sqrt(minD * maxD), maxD]
    : [0, maxD / 2, maxD]
  const xTicks = [t0, t0 + (t1 - t0) / 2, t1]
  const fmtT = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div ref={ref} className="relative">
      <div className="absolute right-0 -top-1 z-10">
        <button
          type="button"
          onClick={() => setLog((v) => !v)}
          aria-pressed={log}
          className={cn('rounded-md px-2 py-0.5 text-[10px] font-medium', log ? 'bg-surface-sunken text-content' : 'text-content-subtle hover:text-content')}
        >
          log scale
        </button>
      </div>
      <svg width={width} height={H} role="img" aria-label="Trace duration over time" onMouseLeave={() => setHover(null)}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--color-edge-subtle)" strokeDasharray={i === 0 ? undefined : '3 4'} />
            <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">{fmtMs(v)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">{fmtT(t)}</text>
        ))}
        {hits.map((h) => {
          const c = colorFor(services, h.rootServiceName)
          const on = hover?.traceID === h.traceID
          return (
            <circle
              key={h.traceID}
              cx={x(h.startMs)}
              cy={y(h.durationMs)}
              r={on ? 5 : 3.5}
              fill={c}
              fillOpacity={0.75}
              stroke={h.error ? ERR_COLOR : 'var(--color-surface-raised)'}
              strokeWidth={h.error ? 2 : 1}
              className="cursor-pointer"
              onMouseEnter={() => setHover(h)}
              onClick={() => onOpen(h.traceID)}
            />
          )
        })}
      </svg>
      {hover ? (
        <div
          className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-edge-default bg-surface-raised px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: Math.min(width - 220, Math.max(0, x(hover.startMs) + 8)), top: Math.max(0, y(hover.durationMs) - 40) }}
        >
          <div className="truncate font-medium text-content">{hover.rootServiceName} · {hover.rootTraceName}</div>
          <div className="font-mono text-content-muted">{fmtMs(hover.durationMs)} · {new Date(hover.startMs).toLocaleTimeString()}</div>
        </div>
      ) : null}
    </div>
  )
}

function ResultsTable({
  hits,
  services,
  picked,
  onPick,
  onOpen,
  onCompare,
  onClearPick,
}: {
  hits: TraceHit[]
  services: string[]
  picked: string[]
  onPick(id: string): void
  onOpen(id: string): void
  onCompare(): void
  onClearPick(): void
}) {
  const [sort, setSort] = useState<{ key: 'start' | 'duration' | 'spans'; dir: 1 | -1 }>({ key: 'start', dir: -1 })
  const rows = useMemo(() => {
    const val = (h: TraceHit) => (sort.key === 'start' ? h.startMs : sort.key === 'duration' ? h.durationMs : h.matched)
    return [...hits].sort((a, b) => (val(a) - val(b)) * sort.dir)
  }, [hits, sort])
  const maxD = Math.max(1, ...hits.map((h) => h.durationMs))
  const head = (key: typeof sort.key, label: string, cls = '') => (
    <th className={cn('px-3 py-2 font-semibold', cls)}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}
        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-content"
      >
        {label}
        {sort.key === key ? <span aria-hidden>{sort.dir === -1 ? '↓' : '↑'}</span> : null}
      </button>
    </th>
  )
  return (
    <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge-subtle px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Traces</span>
        <span className="ml-auto text-[11px] text-content-muted">
          {picked.length === 0 ? 'Tick two traces to compare them' : `${picked.length} of 2 selected`}
        </span>
        {picked.length ? <Button size="xs" variant="ghost" onClick={onClearPick}>Clear</Button> : null}
        <Button size="xs" variant="primary" disabled={picked.length !== 2} onClick={onCompare}>Compare</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-180 text-left text-[12px]">
          <thead className="bg-surface-sunken/50 text-[10px] uppercase tracking-wider text-content-subtle">
            <tr>
              <th className="w-8 px-3 py-2"><span className="sr-only">Compare</span></th>
              {head('start', 'Start')}
              <th className="px-3 py-2 font-semibold">Root</th>
              {head('duration', 'Duration', 'w-56')}
              {head('spans', 'Matched')}
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Trace ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {rows.map((h) => (
              <tr key={h.traceID} className="cursor-pointer hover:bg-surface-sunken/40" onClick={() => onOpen(h.traceID)}>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${h.traceID} for compare`} checked={picked.includes(h.traceID)} onChange={() => onPick(h.traceID)} className="h-3.5 w-3.5" />
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-content-muted">{new Date(h.startMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                <td className="max-w-[320px] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(services, h.rootServiceName) }} />
                    <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">{h.rootServiceName || '—'}</span>
                    <span className="truncate font-mono text-content">{h.rootTraceName || <span className="text-content-subtle">root span not received yet</span>}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${(h.durationMs / maxD) * 100}%` }} />
                    </div>
                    <span className="w-16 text-right font-mono tabular-nums text-content">{fmtMs(h.durationMs)}</span>
                  </div>
                </td>
                <td className="px-3 py-2 font-mono tabular-nums text-content-muted">{h.matched || h.spans.length}</td>
                <td className="px-3 py-2">
                  {h.error === undefined ? (
                    <span className="text-[11px] text-content-subtle">—</span>
                  ) : h.error ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-700 dark:text-rose-300"><IconBad /> error</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300"><IconOk /> ok</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-[10px] text-content-subtle">{h.traceID.slice(0, 16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/* ─────────────────────── trace drawer ─────────────────────── */

function logsQueryFor(spans: TraceSpan[], traceID: string): { query: string; from: Date; to: Date } {
  const res = spans.find((s) => s.resource['k8s.namespace.name'])?.resource ?? spans[0]?.resource ?? {}
  const ns = res['k8s.namespace.name']
  const sel = ns ? `{namespace="${ns}"}` : '{namespace=~".+"}'
  const start = Math.min(...spans.map((s) => s.startMs))
  const end = Math.max(...spans.map((s) => s.endMs))
  return {
    query: `${sel} |= "${traceID}"`,
    from: new Date((Number.isFinite(start) ? start : Date.now()) - 60_000),
    to: new Date((Number.isFinite(end) ? end : Date.now()) + 60_000),
  }
}

function TraceDrawer({
  traceID,
  hint,
  onClose,
  onCopyLink,
}: {
  traceID: string | null
  hint?: TraceHit
  onClose(): void
  onCopyLink(id: string): void
}) {
  const q = useTempoTrace(traceID)
  const spans = useMemo(() => q.data ?? [], [q.data])
  const [view, setView] = useState<'waterfall' | 'services'>('waterfall')
  const [critical, setCritical] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    setSelectedId(null)
  }, [traceID])

  const t0 = spans.length ? Math.min(...spans.map((s) => s.startMs)) : 0
  const t1 = spans.length ? Math.max(...spans.map((s) => s.endMs)) : 0
  const total = Math.max(0.001, t1 - t0)
  const servicesInTrace = useMemo(() => [...new Set(spans.map((s) => s.serviceName))], [spans])
  const errors = spans.filter((s) => s.status === 'error').length
  const root = spans.find((s) => !s.parentSpanID) ?? spans[0]

  return (
    <Drawer
      open={!!traceID}
      onClose={onClose}
      width="max-w-6xl"
      title={<span className="font-mono">{root ? `${root.serviceName} · ${root.name}` : hint ? `${hint.rootServiceName} · ${hint.rootTraceName}` : traceID}</span>}
      badges={
        <>
          <code className="font-mono text-[10px] text-content-muted">{traceID}</code>
          {errors ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-700 dark:text-rose-300"><IconBad /> {errors} error span{errors === 1 ? '' : 's'}</span>
          ) : spans.length ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300"><IconOk /> no errors</span>
          ) : null}
        </>
      }
      subtitle={spans.length ? `${spans.length} spans · ${servicesInTrace.length} services · ${fmtMs(total)} · ${new Date(t0).toLocaleString()}` : undefined}
      actions={
        traceID ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => onCopyLink(traceID)} leading={<IconCopy />}>Link</Button>
            {spans.length ? (
              <Button
                size="sm"
                onClick={() => {
                  const l = logsQueryFor(spans, traceID)
                  onClose()
                  goLogs(l.query, l.from, l.to)
                }}
              >
                Logs for trace
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {q.isLoading ? (
        <div className="flex h-60 items-center justify-center gap-2 text-sm text-content-muted"><Spinner size={14} /> Loading trace…</div>
      ) : q.isError ? (
        <div className="p-5"><SourceError tool="Tempo" error={q.error} onRetry={() => q.refetch()} icon={<TempoIcon size={20} />} /></div>
      ) : spans.length === 0 ? (
        <div className="p-5"><EmptyState compact title="Trace not found" description="Tempo has no spans for this id — it may be outside retention or still being ingested." /></div>
      ) : (
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="xs"
              value={view}
              onChange={setView}
              options={[{ id: 'waterfall', label: 'Waterfall' }, { id: 'services', label: 'Service breakdown' }]}
            />
            {view === 'waterfall' ? (
              <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-content-muted">
                <input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} className="h-3.5 w-3.5" />
                Highlight critical path
              </label>
            ) : null}
          </div>
          {view === 'waterfall' ? (
            <div className={cn('grid gap-4', selectedId ? 'xl:grid-cols-[minmax(0,1fr)_380px]' : '')}>
              <Waterfall
                spans={spans}
                t0={t0}
                total={total}
                services={servicesInTrace}
                critical={critical}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
              />
              {selectedId ? (
                <SpanPanel
                  span={spans.find((s) => s.spanID === selectedId)!}
                  spans={spans}
                  t0={t0}
                  total={total}
                  onClose={() => setSelectedId(null)}
                />
              ) : null}
            </div>
          ) : (
            <ServiceBreakdownView spans={spans} services={servicesInTrace} total={total} />
          )}
        </div>
      )}
    </Drawer>
  )
}

function Waterfall({
  spans,
  t0,
  total,
  services,
  critical,
  selectedId,
  onSelect,
}: {
  spans: TraceSpan[]
  t0: number
  total: number
  services: string[]
  critical: boolean
  selectedId: string | null
  onSelect(id: string): void
}) {
  const ordered = useMemo(() => orderSpans(spans), [spans])
  const cp = useMemo(() => (critical ? criticalPath(spans) : null), [spans, critical])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const CAP = 2000
  const visible = ordered.filter((o) => !o.ancestors.some((a) => collapsed.has(a)))
  const f = filter.trim().toLowerCase()
  const shown = (f ? visible.filter((o) => `${o.span.serviceName} ${o.span.name}`.toLowerCase().includes(f)) : visible).slice(0, CAP)
  const ticks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <section className="min-w-0 rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge-subtle px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find span…"
          aria-label="Find span"
          className="h-7 w-44 rounded-md border border-edge-default bg-surface-app px-2 text-[11px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none"
        />
        <button type="button" onClick={() => setCollapsed(new Set())} className="rounded px-1.5 text-[11px] text-content-muted hover:text-content">Expand all</button>
        <button
          type="button"
          onClick={() => setCollapsed(new Set(ordered.filter((o) => o.depth === 1 && o.childCount > 0).map((o) => o.span.spanID)))}
          className="rounded px-1.5 text-[11px] text-content-muted hover:text-content"
        >
          Collapse level 1
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {services.length >= 2 ? services.slice(0, 8).map((s) => <LegendDot key={s} color={colorFor(services, s)}>{s}</LegendDot>) : null}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-160">
          {/* ruler */}
          <div className="grid grid-cols-[minmax(220px,38%)_1fr_64px] gap-2 border-b border-edge-subtle px-2 py-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Service · operation</span>
            <div className="relative h-4">
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 -translate-x-1/2 font-mono text-[9px] text-content-subtle first:translate-x-0 last:-translate-x-full" style={{ left: `${t * 100}%` }}>
                  {fmtMs(total * t)}
                </span>
              ))}
            </div>
            <span className="text-right text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Dur.</span>
          </div>
          <ol>
            {shown.map(({ span: s, depth, childCount }) => {
              const left = ((s.startMs - t0) / total) * 100
              const width = Math.max(0.3, (s.durationMs / total) * 100)
              const err = s.status === 'error'
              const onPath = cp?.ids.has(s.spanID)
              const active = s.spanID === selectedId
              const isCollapsed = collapsed.has(s.spanID)
              return (
                <li key={s.spanID}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={active}
                    onClick={() => onSelect(s.spanID)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelect(s.spanID)
                      }
                    }}
                    className={cn(
                      'grid cursor-pointer grid-cols-[minmax(220px,38%)_1fr_64px] items-center gap-2 px-2 py-0.75 text-[11px]',
                      active ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken/60',
                      cp && !onPath && 'opacity-45',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 12 }}>
                      {childCount > 0 ? (
                        <button
                          type="button"
                          aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                          onClick={(e) => {
                            e.stopPropagation()
                            setCollapsed((cur) => {
                              const n = new Set(cur)
                              if (n.has(s.spanID)) n.delete(s.spanID)
                              else n.add(s.spanID)
                              return n
                            })
                          }}
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle hover:bg-surface-sunken"
                        >
                          <IconChevronRight open={!isCollapsed} />
                        </button>
                      ) : (
                        <span className="w-4 shrink-0" />
                      )}
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(services, s.serviceName) }} />
                      <span className="shrink-0 font-mono text-[10px] text-content-subtle">{s.serviceName}</span>
                      <span className={cn('truncate font-mono', active ? 'font-semibold text-content' : 'text-content')}>{s.name}</span>
                      {isCollapsed ? <span className="shrink-0 rounded bg-surface-sunken px-1 font-mono text-[9px] text-content-subtle">+{childCount}</span> : null}
                      {err ? <span className="shrink-0 text-rose-600 dark:text-rose-400" title="error"><IconBad /></span> : null}
                    </div>
                    <div className="relative h-3.5">
                      <div className="absolute inset-y-1.5 left-0 right-0 rounded-full bg-surface-sunken/70" />
                      <div
                        className={cn('absolute inset-y-0 rounded-sm', onPath && 'ring-2 ring-content/60')}
                        style={{ left: `${left}%`, width: `${width}%`, backgroundColor: err ? ERR_COLOR : colorFor(services, s.serviceName) }}
                      />
                    </div>
                    <span className="text-right font-mono tabular-nums text-content-muted">{fmtMs(s.durationMs)}</span>
                  </div>
                </li>
              )
            })}
          </ol>
          {visible.length > CAP ? (
            <div className="px-3 py-2 text-[11px] text-content-subtle">Showing the first {CAP} of {visible.length} spans — collapse subtrees or use Find.</div>
          ) : null}
        </div>
      </div>
      {cp ? (
        <div className="border-t border-edge-subtle px-3 py-2 text-[11px] text-content-muted">
          Critical path: {cp.ids.size} spans gate the trace's {fmtMs(total)} end-to-end time. Outlined bars are on it; dimmed rows ran in parallel without delaying the end.
        </div>
      ) : null}
    </section>
  )
}

function SpanPanel({
  span,
  spans,
  t0,
  total,
  onClose,
}: {
  span: TraceSpan
  spans: TraceSpan[]
  t0: number
  total: number
  onClose(): void
}) {
  const toast = useToast()
  const [tab, setTab] = useState<'attributes' | 'resource' | 'events' | 'links'>('attributes')
  const self = useMemo(() => selfTimes(spans).get(span.spanID) ?? 0, [spans, span.spanID])
  const err = span.status === 'error'
  const logs = () => {
    const ns = span.resource['k8s.namespace.name']
    const pod = span.resource['k8s.pod.name']
    const sel = ns && pod ? `{namespace="${ns}", pod="${pod}"}` : ns ? `{namespace="${ns}"}` : '{namespace=~".+"}'
    goLogs(`${sel} |= "${span.traceID}"`, new Date(span.startMs - 30_000), new Date(span.endMs + 30_000))
  }
  return (
    <section className="min-w-0 space-y-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-content-subtle">{span.serviceName} · {span.kind}</div>
          <div className="mt-0.5 break-all font-mono text-[13px] font-semibold text-content">{span.name}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Deselect span" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
          <IconClose />
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <Meta label="Duration" value={fmtMs(span.durationMs)} />
        <Meta label="Self time" value={fmtMs(self)} />
        <Meta label="Starts at" value={`+${fmtMs(span.startMs - t0)}`} />
        <Meta label="Share of trace" value={`${((span.durationMs / total) * 100).toFixed(1)}%`} />
        <Meta
          label="Status"
          value={err ? (
            <span className="inline-flex items-center gap-1 font-medium text-rose-700 dark:text-rose-300"><IconBad /> error</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-content"><IconOk /> {span.status}</span>
          )}
        />
        <Meta label="Scope" value={span.scope ?? '—'} />
      </dl>
      {span.statusMessage ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">{span.statusMessage}</div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" onClick={logs}>Logs for span</Button>
        <Button size="xs" variant="ghost" leading={<IconCopy />} onClick={() => { copyText(span.spanID); toast.success('Span ID copied') }}>Span ID</Button>
      </div>
      <Segmented
        size="xs"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'attributes', label: 'Attributes', count: Object.keys(span.attributes).length },
          { id: 'resource', label: 'Resource', count: Object.keys(span.resource).length },
          { id: 'events', label: 'Events', count: span.events.length },
          { id: 'links', label: 'Links', count: span.links.length },
        ]}
      />
      {tab === 'attributes' ? (
        <KvTable rows={Object.entries(span.attributes).sort(([a], [b]) => a.localeCompare(b))} />
      ) : tab === 'resource' ? (
        <KvTable rows={Object.entries(span.resource).sort(([a], [b]) => a.localeCompare(b))} />
      ) : tab === 'events' ? (
        span.events.length === 0 ? <p className="text-[11px] text-content-subtle">No span events.</p> : (
          <ul className="space-y-2">
            {span.events.map((ev, i) => {
              const isErr = ev.name === 'exception' || ev.name.endsWith('.error')
              return (
                <li key={i} className="rounded-lg border border-edge-subtle p-2 text-[11px]">
                  <div className="flex items-center gap-2">
                    {isErr ? <span className="text-rose-600 dark:text-rose-400"><IconBad /></span> : null}
                    <span className={cn('font-mono', isErr ? 'font-semibold text-rose-700 dark:text-rose-300' : 'text-content')}>{ev.name}</span>
                    <span className="ml-auto font-mono text-[10px] text-content-subtle">+{fmtMs(ev.timeMs - span.startMs)}</span>
                  </div>
                  {Object.keys(ev.attributes).length ? (
                    <div className="mt-1.5">
                      {ev.attributes['exception.stacktrace'] ? (
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-sunken p-2 font-mono text-[10px] text-content">{ev.attributes['exception.stacktrace']}</pre>
                      ) : null}
                      <KvTable rows={Object.entries(ev.attributes).filter(([k]) => k !== 'exception.stacktrace')} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )
      ) : span.links.length === 0 ? (
        <p className="text-[11px] text-content-subtle">No span links.</p>
      ) : (
        <ul className="space-y-1.5 text-[11px]">
          {span.links.map((l, i) => (
            <li key={i} className="flex items-center gap-2 font-mono">
              <a href={discoverUrl('traces', { trace: l.traceID })} className="text-brand-700 hover:underline dark:text-brand-300">{l.traceID.slice(0, 16)}…</a>
              <span className="text-content-subtle">span {l.spanID}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</dt>
      <dd className="mt-0.5 truncate font-mono tabular-nums text-content">{value}</dd>
    </div>
  )
}

function ServiceBreakdownView({ spans, services, total }: { spans: TraceSpan[]; services: string[]; total: number }) {
  const rows = useMemo(() => serviceBreakdown(spans), [spans])
  const cp = useMemo(() => criticalPath(spans), [spans])
  const cpBySvc = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of spans) {
      const c = cp.contribution.get(s.spanID)
      if (c) m.set(s.serviceName, (m.get(s.serviceName) ?? 0) + c)
    }
    return m
  }, [spans, cp])
  const max = Math.max(0.001, ...rows.map((r) => r.selfMs))
  return (
    <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-160 text-left text-[12px]">
          <thead className="bg-surface-sunken/50 text-[10px] uppercase tracking-wider text-content-subtle">
            <tr>
              <th className="px-3 py-2">Service</th>
              <th className="w-1/3 px-3 py-2">Self time</th>
              <th className="px-3 py-2 text-right">On critical path</th>
              <th className="px-3 py-2 text-right">Spans</th>
              <th className="px-3 py-2 text-right">Errors</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {rows.map((r) => (
              <tr key={r.service}>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 font-mono">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorFor(services, r.service) }} />
                    {r.service}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <div className="h-full rounded-full" style={{ width: `${(r.selfMs / max) * 100}%`, backgroundColor: colorFor(services, r.service) }} />
                    </div>
                    <span className="w-20 text-right font-mono tabular-nums">{fmtMs(r.selfMs)}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-content-muted">
                  {fmtMs(cpBySvc.get(r.service) ?? 0)} · {(((cpBySvc.get(r.service) ?? 0) / total) * 100).toFixed(0)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-content-muted">{r.spans}</td>
                <td className="px-3 py-2 text-right">
                  {r.errors ? (
                    <span className="inline-flex items-center gap-1 font-mono text-rose-700 dark:text-rose-300"><IconBad /> {r.errors}</span>
                  ) : <span className="font-mono text-content-subtle">0</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-edge-subtle px-3 py-2 text-[11px] text-content-muted">
        Self time is a span's duration minus the time covered by its children — where the work actually happened.
      </div>
    </section>
  )
}

/* ─────────────────────── compare ─────────────────────── */

function CompareDrawer({ a, b, hits, onClose }: { a: string; b: string; hits: TraceHit[]; onClose(): void }) {
  const qa = useTempoTrace(a)
  const qb = useTempoTrace(b)
  const rows = useMemo(() => (qa.data && qb.data ? compareTraces(qa.data, qb.data) : []), [qa.data, qb.data])
  const ha = hits.find((h) => h.traceID === a)
  const hb = hits.find((h) => h.traceID === b)
  const max = Math.max(0.001, ...rows.map((r) => Math.max(r.aMs, r.bMs)))
  return (
    <Drawer open onClose={onClose} width="max-w-5xl" title="Compare traces" subtitle="Total span time per service · operation, A → B. Sorted by the size of the change.">
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            { k: 'A', id: a, h: ha, data: qa.data },
            { k: 'B', id: b, h: hb, data: qb.data },
          ] as Array<{ k: string; id: string; h?: TraceHit; data?: TraceSpan[] }>).map(({ k, id, h, data }) => (
            <div key={k} className="rounded-xl border border-edge-default bg-surface-raised p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Trace {k}</div>
              <div className="mt-1 truncate font-mono text-[12px] text-content">{h?.rootServiceName} · {h?.rootTraceName}</div>
              <div className="font-mono text-[11px] text-content-muted">{fmtMs(h?.durationMs ?? NaN)} · {data?.length ?? '…'} spans · {id.slice(0, 16)}</div>
            </div>
          ))}
        </div>
        {qa.isLoading || qb.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-content-muted"><Spinner size={14} /> Loading both traces…</div>
        ) : qa.isError || qb.isError ? (
          <SourceError tool="Tempo" error={qa.error ?? qb.error} icon={<TempoIcon size={20} />} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
            <table className="w-full min-w-180 text-left text-[12px]">
              <thead className="bg-surface-sunken/50 text-[10px] uppercase tracking-wider text-content-subtle">
                <tr>
                  <th className="px-3 py-2">Service · operation</th>
                  <th className="w-1/3 px-3 py-2">A vs B</th>
                  <th className="px-3 py-2 text-right">A</th>
                  <th className="px-3 py-2 text-right">B</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.key}>
                    <td className="max-w-[320px] truncate px-3 py-1.5 font-mono"><span className="text-content-subtle">{r.service}</span> · {r.name}</td>
                    <td className="px-3 py-1.5">
                      <div className="space-y-0.5">
                        <div className="h-1.5 rounded-full bg-sky-500" style={{ width: `${(r.aMs / max) * 100}%` }} title={`A ${fmtMs(r.aMs)}`} />
                        <div className="h-1.5 rounded-full bg-violet-500" style={{ width: `${(r.bMs / max) * 100}%` }} title={`B ${fmtMs(r.bMs)}`} />
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-content-muted">{r.aCount ? `${fmtMs(r.aMs)} ×${r.aCount}` : '—'}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-content-muted">{r.bCount ? `${fmtMs(r.bMs)} ×${r.bCount}` : '—'}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-content">{r.deltaMs > 0 ? '+' : ''}{fmtMs(r.deltaMs).replace('—', '0')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-3 border-t border-edge-subtle px-3 py-2">
              <LegendDot color="var(--color-sky-500)">A</LegendDot>
              <LegendDot color="var(--color-violet-500)">B</LegendDot>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  )
}

/* ─────────────────────── services · RED ─────────────────────── */

function ServicesRed({ start, end, onSearch }: { start: Date; end: Date; onSearch(service: string): void }) {
  const fam = useSpanMetricsFamily()
  const [service, setService] = useState<string | null>(null)
  const table = useRedTable(fam.data, undefined)
  if (fam.isLoading) {
    return <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted"><Spinner size={14} /> Looking for spanmetrics in Prometheus…</div>
  }
  if (fam.isError) return <SourceError tool="Prometheus" error={fam.error} onRetry={() => fam.refetch()} />
  if (!fam.data) {
    return (
      <EmptyState
        icon={<TempoIcon size={20} />}
        title="No spanmetrics in Prometheus"
        description="RED metrics per service come from span metrics: none of traces_spanmetrics_calls_total, traces_span_metrics_calls_total or calls_total is scraped. Enable Tempo's metrics-generator (span-metrics processor, remote-writing to Prometheus) or the OTel collector spanmetrics connector, then this view fills in. Trace search works without it."
      />
    )
  }
  return (
    <div className="space-y-4">
      <InlineHint>
        Source: <span className="font-medium text-content">{fam.data.label}</span> — <code className="font-mono">{fam.data.calls}</code>
        {fam.data.latency ? <> and <code className="font-mono">{fam.data.latency}</code></> : ' (no latency histogram found — p95 unavailable)'}; rates over the last 5 minutes, server/consumer spans preferred.
      </InlineHint>
      <RedTable
        title="Services"
        q={table}
        onPick={(n) => setService(n)}
        picked={service}
        action={(n) => <Button size="xs" variant="ghost" onClick={() => onSearch(n)}>Traces</Button>}
      />
      {service ? <ServiceDetail fam={fam.data} service={service} start={start} end={end} onClose={() => setService(null)} /> : null}
    </div>
  )
}

function RedTable({
  title,
  q,
  onPick,
  picked,
  action,
}: {
  title: string
  q: ReturnType<typeof useRedTable>
  onPick?(name: string): void
  picked?: string | null
  action?(name: string): React.ReactNode
}) {
  if (q.isLoading) return <div className="flex items-center gap-2 p-4 text-sm text-content-muted"><Spinner size={12} /> Querying…</div>
  if (q.isError) return <SourceError compact tool="Prometheus" error={q.error} onRetry={() => q.refetch()} />
  const rows: RedRow[] = q.data ?? []
  if (!rows.length) return <EmptyState compact title="No span traffic in the last 5 minutes" />
  return (
    <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="border-b border-edge-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{title} · {rows.length}</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-140 text-left text-[12px]">
          <thead className="bg-surface-sunken/50 text-[10px] uppercase tracking-wider text-content-subtle">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">Errors</th>
              <th className="px-3 py-2 text-right">p95</th>
              {action ? <th className="w-px px-3 py-2" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {rows.map((r) => {
              const bad = (r.errorPct ?? 0) >= 5
              const warn = !bad && (r.errorPct ?? 0) >= 1
              return (
                <tr
                  key={r.name}
                  onClick={onPick ? () => onPick(r.name) : undefined}
                  className={cn(onPick && 'cursor-pointer hover:bg-surface-sunken/40', picked === r.name && 'bg-brand-50 dark:bg-brand-500/10')}
                >
                  <td className="max-w-90 truncate px-3 py-2 font-mono text-content">{r.name}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-content">{r.rps == null ? '—' : `${r.rps.toFixed(r.rps < 10 ? 2 : 0)}/s`}</td>
                  <td className="px-3 py-2 text-right">
                    {r.errorPct == null ? <span className="font-mono text-content-subtle">—</span> : (
                      <span className={cn('inline-flex items-center gap-1 font-mono tabular-nums', bad ? 'text-rose-700 dark:text-rose-300' : warn ? 'text-amber-700 dark:text-amber-300' : 'text-content-muted')}>
                        {bad ? <IconBad /> : null}
                        {r.errorPct.toFixed(2)}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-content">{r.p95Ms == null ? '—' : fmtMs(r.p95Ms)}</td>
                  {action ? <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>{action(r.name)}</td> : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ServiceDetail({ fam, service, start, end, onClose }: { fam: SpanMetricsFamily; service: string; start: Date; end: Date; onClose(): void }) {
  const series = useRedSeries(fam, service, start, end)
  const ops = useRedTable(fam, service)
  const fmtT = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="font-mono text-sm font-semibold text-content">{service}</h3>
        <Button size="xs" variant="ghost" onClick={onClose} className="ml-auto">Close</Button>
      </div>
      {series.isError ? (
        <SourceError compact tool="Prometheus" error={series.error} onRetry={() => series.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Rate · req/s">
            <TimeSeriesChart height={140} series={[{ name: 'rate', points: series.data?.rps ?? [] }]} formatY={(v) => v.toFixed(v < 10 ? 2 : 0)} formatTime={fmtT} emptyLabel={series.isLoading ? 'Loading…' : 'No samples'} />
          </Panel>
          <Panel title="Errors · req/s">
            <TimeSeriesChart height={140} series={[{ name: 'errors', points: series.data?.err ?? [], color: ERR_COLOR }]} formatY={(v) => v.toFixed(v < 10 ? 2 : 0)} formatTime={fmtT} emptyLabel={series.isLoading ? 'Loading…' : 'No error spans'} />
          </Panel>
          <Panel title="p95 latency">
            <TimeSeriesChart height={140} series={[{ name: 'p95', points: series.data?.p95 ?? [] }]} formatY={(v) => fmtMs(v)} formatTime={fmtT} emptyLabel={series.isLoading ? 'Loading…' : fam.latency ? 'No samples' : 'No latency histogram'} />
          </Panel>
        </div>
      )}
      <RedTable title={`Operations of ${service}`} q={ops} />
    </div>
  )
}
