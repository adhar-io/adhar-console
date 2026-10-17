import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  DonutGauge,
  EmptyState,
  GrafanaIcon,
  Markdown,
  Spinner,
  type Threshold,
  TimeSeriesChart,
  type TimeSeries,
  useElementWidth,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  ALL_VALUE,
  boardLink,
  colorTone,
  expandRepeats,
  formatLegend,
  formatUnit,
  GRID_CELL_MARGIN,
  type GrafanaPanel,
  grafanaColor,
  interpolate,
  layoutSections,
  legacyCalc,
  mapValue,
  normalizePanels,
  panelLink,
  panelPixelHeight,
  panelUnit,
  QUICK_RANGES,
  rangeLabel,
  readBoardUrl,
  reduce,
  REFRESH_INTERVALS,
  resolveRange,
  SUPPORTED_PANELS,
  type ThresholdTone,
  thresholdFor,
  type VarMap,
  writeBoardUrl,
  parseDuration,
} from '../data/grafana-board.ts'
import {
  type BoardVariable,
  type PanelContext,
  type PanelData,
  useBoardVariables,
  useGrafanaDashboard,
  useGrafanaDatasources,
  usePanelData,
  useStarDashboard,
} from '../data/grafana.ts'
import { SourceError } from './states.tsx'
import { seriesColor, SERIES_MAX, VizStyle } from './viz.tsx'

/**
 * Native Grafana board renderer.
 *
 * Grafana on this platform refuses to be framed (`X-Frame-Options: deny`), so
 * instead of a kiosk iframe the console reads the dashboard JSON and draws it
 * itself: Grafana's 24-column grid, collapsible rows, template variables as
 * selects, a Grafana-style time picker, and each panel's PromQL / LogQL run
 * through that panel's datasource via Grafana's datasource proxy. Panel types
 * the console cannot draw faithfully render a placeholder that deep-links to
 * the panel in Grafana.
 */
export function GrafanaBoard({
  uid,
  grafanaBase,
  onBack,
  starred,
}: {
  uid: string
  grafanaBase: string
  onBack(): void
  starred?: boolean
}) {
  const toast = useToast()
  const dash = useGrafanaDashboard(uid)
  const dsQ = useGrafanaDatasources()
  const star = useStarDashboard()
  const initialUrl = useMemo(() => readBoardUrl(typeof location !== 'undefined' ? location.search : ''), [uid])
  const d = dash.data?.dashboard
  const [from, setFrom] = useState(initialUrl.from ?? '')
  const [to, setTo] = useState(initialUrl.to ?? '')
  const [refresh, setRefresh] = useState(initialUrl.refresh ?? '')
  const [tick, setTick] = useState(0)
  const [isStarred, setIsStarred] = useState(!!starred)
  useEffect(() => setIsStarred(!!(dash.data?.meta?.isStarred ?? starred)), [dash.data, starred])

  // Board defaults once the JSON arrives (URL wins).
  useEffect(() => {
    if (!d) return
    if (!initialUrl.from) setFrom(d.time?.from ?? 'now-6h')
    if (!initialUrl.to) setTo(d.time?.to ?? 'now')
    if (!initialUrl.refresh && typeof d.refresh === 'string') setRefresh(d.refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per board
  }, [d?.uid])

  // Auto-refresh: bump the tick, which re-resolves `now` and refetches.
  useEffect(() => {
    const ms = parseDuration(refresh)
    if (!ms || ms < 5_000) return
    const id = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(id)
  }, [refresh])

  const effFrom = from || d?.time?.from || 'now-6h'
  const effTo = to || d?.time?.to || 'now'
  const time = useMemo(() => resolveRange(effFrom, effTo), [effFrom, effTo, tick])
  const datasources = dsQ.data ?? []
  const { variables, vars, selected, setValue } = useBoardVariables(d, datasources, time, initialUrl.vars)

  // Keep the URL in step so the address bar is a shareable deep link.
  useEffect(() => {
    if (typeof location === 'undefined' || !d) return
    const next = writeBoardUrl(location.search, { board: uid, from: effFrom, to: effTo, refresh, vars: selected })
    if (next !== location.search) history.replaceState(history.state, '', `${location.pathname}${next}${location.hash}`)
  }, [uid, effFrom, effTo, refresh, selected, d])

  const sections = useMemo(() => {
    if (!d) return []
    return layoutSections(expandRepeats(normalizePanels(d), vars))
    // Re-layout only when repeat variables change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, JSON.stringify(Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, [v.values, v.options.length]])))])

  const ctx: PanelContext = { datasources, dsKnown: dsQ.isSuccess && datasources.length > 0, vars, time, tick }
  const openUrl = d ? boardLink(grafanaBase, uid, effFrom, effTo, vars) : ''

  if (dash.isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-content-muted">
        <Spinner size={14} /> Loading board…
      </div>
    )
  }
  if (dash.isError || !d) {
    return (
      <div className="space-y-3">
        <Button size="sm" variant="ghost" onClick={onBack}>← All boards</Button>
        <SourceError tool="Grafana" error={dash.error} onRetry={() => dash.refetch()} icon={<GrafanaIcon size={20} />} />
      </div>
    )
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      toast.success('Link copied', { description: 'Board, time range and variables are in the URL.' })
    } catch {
      toast.error('Could not copy the link')
    }
  }

  const toggleStar = () => {
    const next = !isStarred
    setIsStarred(next)
    star.mutate(
      { uid, star: next },
      {
        onSuccess: () => toast.success(next ? 'Starred in Grafana' : 'Removed from starred'),
        onError: (e) => {
          setIsStarred(!next)
          toast.error('Grafana refused the star', { description: (e as Error).message })
        },
      },
    )
  }

  return (
    <div className="space-y-4">
      <VizStyle />
      {/* Board chrome — title left, actions right. */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onBack} className="text-[11px] font-medium text-content-muted hover:text-content">
            ← All boards
          </button>
          <div className="mt-0.5 flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-content">{d.title}</h2>
            <button
              type="button"
              onClick={toggleStar}
              title={isStarred ? 'Unstar (stars belong to the console’s Grafana account)' : 'Star (stars belong to the console’s Grafana account)'}
              aria-pressed={isStarred}
              className={cn('text-base leading-none', isStarred ? 'text-amber-500' : 'text-content-subtle hover:text-content')}
            >
              {isStarred ? '★' : '☆'}
            </button>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-content-subtle">
            <span>{dash.data?.meta?.folderTitle || 'General'}</span>
            {dash.data?.meta?.updated ? <span>· updated {formatRelative(dash.data.meta.updated)}</span> : null}
            {(d.tags ?? []).map((t) => (
              <span key={t} className="rounded-full bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px]">{t}</span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TimePicker from={effFrom} to={effTo} onChange={(f, t) => { setFrom(f); setTo(t) }} />
          <select
            aria-label="Auto refresh"
            value={refresh}
            onChange={(e) => setRefresh(e.target.value)}
            className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content"
          >
            {REFRESH_INTERVALS.map((r) => (
              <option key={r} value={r}>{r ? `Every ${r}` : 'Auto-refresh off'}</option>
            ))}
          </select>
          <Button size="sm" onClick={() => setTick((t) => t + 1)} title="Refresh now">
            ↻ Refresh
          </Button>
          <Button size="sm" onClick={copyLink}>Copy link</Button>
          {openUrl ? (
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-xs font-medium text-content hover:bg-surface-sunken"
            >
              <GrafanaIcon size={14} /> Open in Grafana ↗
            </a>
          ) : null}
        </div>
      </div>

      {variables.some((v) => (v.def.hide ?? 0) < 2) ? (
        <div className="flex flex-wrap items-end gap-3">
          {variables.filter((v) => (v.def.hide ?? 0) < 2).map((v) => (
            <VariablePicker key={v.def.name} v={v} selected={selected[v.def.name] ?? []} onChange={(vals) => setValue(v.def.name, vals)} />
          ))}
        </div>
      ) : null}

      {!dsQ.isSuccess && !dsQ.isLoading ? (
        <p className="text-[11px] text-content-muted">
          Grafana did not list its datasources for the console’s account, so Prometheus panels query the console’s own Prometheus proxy.
        </p>
      ) : null}

      {sections.length === 0 ? (
        <EmptyState compact title="This board has no panels" />
      ) : (
        sections.map((s, i) => (
          <BoardSection key={`${s.row?.id ?? 'top'}-${i}`} section={s} ctx={ctx} uid={uid} base={grafanaBase} from={effFrom} to={effTo} />
        ))
      )}
    </div>
  )
}

/* ─────────── time picker ─────────── */

function TimePicker({ from, to, onChange }: { from: string; to: string; onChange(from: string, to: string): void }) {
  const [open, setOpen] = useState(false)
  const [absFrom, setAbsFrom] = useState('')
  const [absTo, setAbsTo] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-xs font-medium text-content hover:bg-surface-sunken"
        aria-expanded={open}
      >
        <ClockIcon /> {rangeLabel(from, to)}
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 grid w-[min(92vw,420px)] grid-cols-1 gap-3 rounded-lg border border-edge-default bg-surface-raised p-3 shadow-lg sm:grid-cols-2">
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Absolute range</div>
            <label className="block text-[11px] text-content-muted">
              From
              <input type="datetime-local" value={absFrom} onChange={(e) => setAbsFrom(e.target.value)} className="mt-0.5 h-8 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content" />
            </label>
            <label className="block text-[11px] text-content-muted">
              To
              <input type="datetime-local" value={absTo} onChange={(e) => setAbsTo(e.target.value)} className="mt-0.5 h-8 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content" />
            </label>
            <Button
              size="sm"
              variant="primary"
              disabled={!absFrom || !absTo || new Date(absFrom) >= new Date(absTo)}
              onClick={() => {
                onChange(String(new Date(absFrom).getTime()), String(new Date(absTo).getTime()))
                setOpen(false)
              }}
            >
              Apply
            </Button>
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {QUICK_RANGES.map((r) => (
              <li key={r.from}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(r.from, 'now')
                    setOpen(false)
                  }}
                  className={cn(
                    'block w-full rounded px-2 py-1 text-left text-xs',
                    from === r.from && to === 'now' ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300' : 'text-content hover:bg-surface-sunken',
                  )}
                >
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── variables ─────────── */

function VariablePicker({ v, selected, onChange }: { v: BoardVariable; selected: string[]; onChange(vals: string[]): void }) {
  const label = v.def.label || v.def.name
  const showLabel = (v.def.hide ?? 0) === 0
  const opts = [...(v.def.includeAll ? [{ text: 'All', value: ALL_VALUE }] : []), ...v.options]
  if (v.def.type === 'textbox') {
    return (
      <label className="flex flex-col text-[11px] text-content-muted">
        {showLabel ? label : null}
        <input
          defaultValue={selected[0] ?? ''}
          onBlur={(e) => onChange([e.target.value])}
          onKeyDown={(e) => e.key === 'Enter' && onChange([(e.target as HTMLInputElement).value])}
          className="mt-0.5 h-8 w-40 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content"
        />
      </label>
    )
  }
  if (v.def.multi) return <MultiPicker label={showLabel ? label : ''} opts={opts} selected={selected} onChange={onChange} loading={v.loading} error={!!v.error} />
  return (
    <label className="flex flex-col text-[11px] text-content-muted">
      <span className="flex items-center gap-1">
        {showLabel ? label : null}
        {v.loading ? <Spinner size={10} /> : null}
        {v.error ? <span className="text-rose-600" title={(v.error as Error).message}>⚠ query failed</span> : null}
      </span>
      <select
        value={selected[0] ?? ''}
        onChange={(e) => onChange([e.target.value])}
        className="mt-0.5 h-8 max-w-[16rem] rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content"
      >
        {opts.length === 0 ? <option value={selected[0] ?? ''}>{selected[0] || 'No options'}</option> : null}
        {opts.map((o) => (
          <option key={o.value} value={o.value}>{o.text}</option>
        ))}
      </select>
    </label>
  )
}

function MultiPicker({
  label,
  opts,
  selected,
  onChange,
  loading,
  error,
}: {
  label: string
  opts: Array<{ text: string; value: string }>
  selected: string[]
  onChange(v: string[]): void
  loading: boolean
  error: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const summary = selected.includes(ALL_VALUE) ? 'All' : selected.length ? selected.join(' + ') : 'None'
  const toggle = (val: string) => {
    if (val === ALL_VALUE) return onChange([ALL_VALUE])
    const base = selected.filter((s) => s !== ALL_VALUE)
    const next = base.includes(val) ? base.filter((s) => s !== val) : [...base, val]
    onChange(next.length ? next : opts[0] ? [opts[0].value] : [])
  }
  const shown = opts.filter((o) => !q || o.text.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="relative flex flex-col text-[11px] text-content-muted" ref={ref}>
      <span className="flex items-center gap-1">
        {label}
        {loading ? <Spinner size={10} /> : null}
        {error ? <span className="text-rose-600">⚠ query failed</span> : null}
      </span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-0.5 h-8 max-w-[16rem] truncate rounded-md border border-edge-default bg-surface-raised px-2 text-left text-xs text-content"
      >
        {summary}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-lg">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter…"
            className="mb-1 h-7 w-full rounded border border-edge-default bg-surface-raised px-2 text-xs text-content"
          />
          <ul className="max-h-60 overflow-y-auto">
            {shown.map((o) => {
              const on = o.value === ALL_VALUE ? selected.includes(ALL_VALUE) : selected.includes(o.value)
              return (
                <li key={o.value}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-content hover:bg-surface-sunken">
                    <input type="checkbox" checked={on} onChange={() => toggle(o.value)} className="h-3 w-3" />
                    <span className="truncate">{o.text}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── sections & grid ─────────── */

function BoardSection({
  section,
  ctx,
  uid,
  base,
  from,
  to,
}: {
  section: ReturnType<typeof layoutSections>[number]
  ctx: PanelContext
  uid: string
  base: string
  from: string
  to: string
}) {
  const [collapsed, setCollapsed] = useState(!!section.row?.collapsed)
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const narrow = width > 0 && width < 760
  const title = section.row ? interpolate(section.row.title ?? '', ctx.vars, {}, section.row.scopedVars, 'text') : ''
  return (
    <section ref={ref} className="space-y-2">
      {section.row ? (
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center gap-2 border-b border-edge-subtle pb-1 text-left text-sm font-semibold text-content"
          aria-expanded={!collapsed}
        >
          <span className={cn('inline-block text-[10px] text-content-subtle transition-transform', collapsed ? '' : 'rotate-90')}>▶</span>
          {title || 'Row'}
          {collapsed ? <span className="text-[11px] font-normal text-content-subtle">({section.panels.length} panel{section.panels.length === 1 ? '' : 's'})</span> : null}
        </button>
      ) : null}
      {collapsed ? null : narrow ? (
        <div className="flex flex-col gap-2">
          {section.panels.map((p) => (
            <div key={p.id} style={{ height: Math.max(180, Math.min(panelPixelHeight(p.gridPos.h), 420)) }}>
              <Panel panel={p} ctx={ctx} uid={uid} base={base} from={from} to={to} />
            </div>
          ))}
        </div>
      ) : (
        <div
          className="grid"
          style={{
            gridTemplateColumns: 'repeat(24, minmax(0, 1fr))',
            gridAutoRows: '30px',
            gap: `${GRID_CELL_MARGIN}px`,
          }}
        >
          {section.panels.map((p) => (
            <div
              key={p.id}
              className="min-w-0"
              style={{ gridColumn: `${p.gridPos.x + 1} / span ${p.gridPos.w}`, gridRow: `${p.gridPos.y + 1} / span ${p.gridPos.h}` }}
            >
              <Panel panel={p} ctx={ctx} uid={uid} base={base} from={from} to={to} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Only query panels that are on (or near) screen. */
function useInView<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        setSeen(true)
        io.disconnect()
      }
    }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

/* ─────────── panel ─────────── */

function Panel({ panel, ctx, uid, base, from, to }: { panel: GrafanaPanel; ctx: PanelContext; uid: string; base: string; from: string; to: string }) {
  const [ref, inView] = useInView<HTMLDivElement>()
  const [showQuery, setShowQuery] = useState(false)
  const supported = SUPPORTED_PANELS.has(panel.type)
  const needsData = supported && panel.type !== 'text'
  const q = usePanelData(panel, ctx, inView && needsData)
  const title = interpolate(panel.title ?? '', ctx.vars, {}, panel.scopedVars, 'text')
  const link = panelLink(base, uid, panel.sourceId ?? panel.id, from, to, ctx.vars)

  let body: ReactNode
  if (!supported) {
    body = <Placeholder link={link} reason={`“${panel.type}” panels are not drawn in the console.`} />
  } else if (panel.type === 'text') {
    body = <TextPanel panel={panel} vars={ctx.vars} />
  } else if (!inView || q.isLoading) {
    body = <div className="flex h-full items-center justify-center"><Spinner size={12} /></div>
  } else if (q.isError) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center">
        <span className="text-[11px] font-medium text-rose-600 dark:text-rose-400">⚠ Query failed</span>
        <span className="line-clamp-3 text-[10px] text-content-subtle">{(q.error as Error).message}</span>
      </div>
    )
  } else if (q.data?.unsupported) {
    body = <Placeholder link={link} reason={`Queries against the ${q.data.unsupported} run only in Grafana.`} />
  } else if (!q.data || (panel.targets ?? []).length === 0) {
    body = <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">No queries</div>
  } else {
    body = <PanelBody panel={panel} data={q.data} />
  }

  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-edge-default bg-surface-raised">
      <div className="flex h-7 shrink-0 items-center gap-1.5 px-2.5">
        <span className="truncate text-[12px] font-semibold text-content" title={panel.description || title}>{title}</span>
        {q.isFetching && !q.isLoading ? <Spinner size={9} /> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1 opacity-70 hover:opacity-100">
          {q.data?.queries?.length ? (
            <button type="button" onClick={() => setShowQuery((s) => !s)} className="rounded px-1 text-[10px] text-content-subtle hover:bg-surface-sunken hover:text-content" title="Show query">
              {'{ }'}
            </button>
          ) : null}
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer" className="rounded px-1 text-[10px] text-content-subtle hover:bg-surface-sunken hover:text-content" title="Open this panel in Grafana">
              ↗
            </a>
          ) : null}
        </span>
      </div>
      {showQuery && q.data?.queries?.length ? (
        <pre className="mx-2.5 mb-1 max-h-24 shrink-0 overflow-auto whitespace-pre-wrap rounded bg-surface-sunken p-1.5 font-mono text-[10px] text-content-muted">
          {q.data.queries.join('\n')}
        </pre>
      ) : null}
      <div className="min-h-0 flex-1 px-2.5 pb-2">{body}</div>
    </div>
  )
}

function Placeholder({ link, reason }: { link: string; reason: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
      <span className="text-[11px] text-content-muted">{reason}</span>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          Open in Grafana ↗
        </a>
      ) : null}
    </div>
  )
}

function TextPanel({ panel, vars }: { panel: GrafanaPanel; vars: VarMap }) {
  const raw = String(panel.options?.content ?? panel.content ?? '')
  const mode = String(panel.options?.mode ?? panel.mode ?? 'markdown')
  const text = interpolate(raw, vars, {}, panel.scopedVars, 'text')
  // HTML mode is reduced to text — the console never injects board HTML.
  const md = mode === 'html' ? text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ') : text
  return (
    <div className="h-full overflow-auto text-[12px] text-content">
      <Markdown text={md} />
    </div>
  )
}

/* ─────────── data panels ─────────── */

interface FlatSeries {
  name: string
  points: Array<[number, number]>
  last: number | null
  labels: Record<string, string>
}

function flatten(data: PanelData): FlatSeries[] {
  const out: FlatSeries[] = []
  for (const f of data.frames) {
    for (const s of f.series) {
      const pts: Array<[number, number]> = s.values
        ? s.values.map(([t, v]) => [t * 1000, Number(v)] as [number, number])
        : s.value
          ? [[s.value[0] * 1000, Number(s.value[1])]]
          : []
      out.push({
        name: formatLegend(f.legendFormat, s.metric, f.refId),
        points: pts,
        last: pts.length ? pts[pts.length - 1][1] : null,
        labels: s.metric,
      })
    }
  }
  return out
}

const MAX_SERIES = SERIES_MAX

function PanelBody({ panel, data }: { panel: GrafanaPanel; data: PanelData }) {
  const logs = data.frames.flatMap((f) => f.logs ?? [])
  if (panel.type === 'logs' || logs.length) return <LogsPanel lines={logs} />
  const series = flatten(data)
  if (series.length === 0 || series.every((s) => s.points.length === 0)) {
    return <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">No data in this range</div>
  }
  switch (panel.type) {
    case 'timeseries':
    case 'graph':
      return <TimeseriesPanel panel={panel} series={series} />
    case 'stat':
    case 'singlestat':
      return <StatPanel panel={panel} series={series} />
    case 'gauge':
      return <GaugePanel panel={panel} series={series} />
    case 'bargauge':
    case 'barchart':
    case 'piechart':
      return <BarsPanel panel={panel} series={series} share={panel.type === 'piechart'} />
    case 'table':
    case 'table-old':
      return <TablePanel panel={panel} series={series} />
    default:
      return <TimeseriesPanel panel={panel} series={series} />
  }
}

function useCalc(panel: GrafanaPanel): string {
  return panel.options?.reduceOptions?.calcs?.[0] ?? legacyCalc(panel.valueName)
}

function TimeseriesPanel({ panel, series }: { panel: GrafanaPanel; series: FlatSeries[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [showAll, setShowAll] = useState(false)
  const u = panelUnit(panel)
  const shown = showAll ? series : series.slice(0, MAX_SERIES)
  const ts: TimeSeries[] = shown.map((s, i) => ({ name: s.name, points: s.points, color: seriesColor(i) }))
  const steps = panel.fieldConfig?.defaults?.thresholds?.steps ?? []
  const style = (panel.fieldConfig?.defaults?.custom?.thresholdsStyle as { mode?: string } | undefined)?.mode
  const thresholds: Threshold[] = style && style !== 'off'
    ? steps.filter((s) => s.value != null).map((s) => ({ value: s.value!, color: grafanaColor(s.color), label: formatUnit(s.value!, u.unit, u.decimals) }))
    : []
  return (
    <div ref={ref} className="flex h-full flex-col overflow-hidden">
      <MeasuredChart width={width} legendRows={ts.length > 1 ? Math.min(3, Math.ceil(ts.length / 4)) : 0}>
        {(h) => (
          <TimeSeriesChart
            series={ts}
            height={h}
            formatY={(v) => formatUnit(v, u.unit, u.decimals)}
            yMax={u.max}
            thresholds={thresholds}
            emptyLabel="No samples in this range"
          />
        )}
      </MeasuredChart>
      {series.length > MAX_SERIES ? (
        <button type="button" onClick={() => setShowAll((s) => !s)} className="mt-0.5 self-start text-[10px] text-content-subtle hover:text-content">
          {showAll ? 'Show fewer series' : `Showing ${MAX_SERIES} of ${series.length} series — show all`}
        </button>
      ) : null}
    </div>
  )
}

/**
 * TimeSeriesChart scales its viewBox (640 wide) to the container width, so a
 * pixel height H needs a viewBox height of H × 640 / width.
 */
function MeasuredChart({ width, legendRows, children }: { width: number; legendRows: number; children(h: number): ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hPx, setHPx] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((es) => setHPx(es[0]?.contentRect.height ?? 0))
    ro.observe(el)
    setHPx(el.getBoundingClientRect().height)
    return () => ro.disconnect()
  }, [])
  const avail = Math.max(60, hPx - legendRows * 16 - 4)
  const vbH = width > 0 ? Math.max(60, Math.round((avail * 640) / width)) : 140
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-hidden">
      {hPx > 0 ? children(vbH) : null}
    </div>
  )
}

const TONE_ICON: Record<ThresholdTone, string> = { ok: '●', warn: '▲', bad: '■', info: '●', neutral: '' }
const TONE_LABEL: Record<ThresholdTone, string> = { ok: 'OK', warn: 'Warning', bad: 'Critical', info: '', neutral: '' }

function valueDisplay(panel: GrafanaPanel, v: number | null) {
  const u = panelUnit(panel)
  const d = panel.fieldConfig?.defaults
  const mapped = mapValue(v, d?.mappings)
  const step = thresholdFor(v, d?.thresholds, u.min ?? 0, u.max ?? 100)
  const color = grafanaColor(mapped?.color ?? step?.color)
  const tone = colorTone(mapped?.color ?? step?.color)
  return { text: mapped?.text ?? formatUnit(v, u.unit, u.decimals), color, tone }
}

function StatPanel({ panel, series }: { panel: GrafanaPanel; series: FlatSeries[] }) {
  const calc = useCalc(panel)
  const items = series.slice(0, 24).map((s) => ({ s, v: reduce(s.points.map((p) => p[1]), calc) }))
  const many = items.length > 1
  return (
    <div className={cn('grid h-full gap-2', many ? 'auto-rows-fr grid-cols-[repeat(auto-fit,minmax(110px,1fr))] overflow-auto' : 'grid-cols-1')}>
      {items.map(({ s, v }) => {
        const disp = valueDisplay(panel, v)
        const showTone = disp.tone === 'warn' || disp.tone === 'bad'
        return (
          <div key={s.name} className="flex min-w-0 flex-col items-center justify-center text-center">
            {many ? <div className="max-w-full truncate text-[10px] text-content-subtle">{s.name}</div> : null}
            <div className={cn('flex items-baseline gap-1 font-semibold tabular-nums text-content', many ? 'text-lg' : 'text-3xl')}>
              {disp.color && disp.tone !== 'neutral' ? (
                <span aria-hidden className="text-[0.5em]" style={{ color: disp.color }}>{TONE_ICON[disp.tone] || '●'}</span>
              ) : null}
              {disp.text}
            </div>
            {showTone ? <div className="text-[10px] font-medium" style={{ color: disp.color }}>{TONE_LABEL[disp.tone]}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

function GaugePanel({ panel, series }: { panel: GrafanaPanel; series: FlatSeries[] }) {
  const calc = useCalc(panel)
  const u = panelUnit(panel)
  const items = series.slice(0, 8).map((s) => ({ s, v: reduce(s.points.map((p) => p[1]), calc) }))
  const max = u.max ?? (u.unit === 'percentunit' ? 1 : 100)
  const min = u.min ?? 0
  // Fit the dial to the panel: grid height minus the title bar and padding.
  const fit = Math.max(56, panelPixelHeight(panel.gridPos?.h ?? 6) - 44)
  const size = Math.min(items.length > 1 ? 84 : 120, fit - (items.length > 1 ? 18 : 0))
  return (
    <div className="flex h-full flex-wrap items-center justify-center gap-3 overflow-auto">
      {items.map(({ s, v }) => {
        const disp = valueDisplay(panel, v)
        return (
          <div key={s.name} className="flex flex-col items-center">
            <DonutGauge
              value={Math.max(0, (v ?? 0) - min)}
              max={Math.max(1e-9, max - min)}
              size={size}
              thickness={9}
              color={disp.color ?? 'var(--color-brand-500)'}
              label={<span className="text-sm font-semibold tabular-nums text-content">{disp.text}</span>}
            />
            {items.length > 1 ? <span className="mt-1 max-w-[9rem] truncate text-[10px] text-content-subtle">{s.name}</span> : null}
          </div>
        )
      })}
    </div>
  )
}

function BarsPanel({ panel, series, share }: { panel: GrafanaPanel; series: FlatSeries[]; share: boolean }) {
  const calc = useCalc(panel)
  const u = panelUnit(panel)
  const items = series.map((s) => ({ s, v: reduce(s.points.map((p) => p[1]), calc) ?? 0 })).sort((a, b) => b.v - a.v).slice(0, 30)
  const total = items.reduce((a, b) => a + Math.max(0, b.v), 0)
  const max = share ? total : (u.max ?? Math.max(...items.map((i) => i.v), 1e-9))
  return (
    <ul className="h-full space-y-1.5 overflow-auto pr-1">
      {items.map(({ s, v }, i) => {
        const disp = valueDisplay(panel, v)
        const pct = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0
        return (
          <li key={s.name} className="text-[11px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-content-muted">{s.name}</span>
              <span className="shrink-0 font-mono tabular-nums text-content">
                {disp.text}
                {share ? <span className="ml-1 text-content-subtle">{pct.toFixed(1)}%</span> : null}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: share ? seriesColor(i) : (disp.color ?? 'var(--color-brand-500)') }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function TablePanel({ panel, series }: { panel: GrafanaPanel; series: FlatSeries[] }) {
  const u = panelUnit(panel)
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null)
  const cols = useMemo(() => {
    const set = new Set<string>()
    for (const s of series) for (const k of Object.keys(s.labels)) if (k !== '__name__') set.add(k)
    return [...set]
  }, [series])
  const rows = useMemo(() => {
    const r = series.map((s) => ({ labels: s.labels, value: s.last }))
    if (!sort) return r
    return [...r].sort((a, b) => {
      if (sort.col === '__value') return ((a.value ?? -Infinity) - (b.value ?? -Infinity)) * sort.dir
      return String(a.labels[sort.col] ?? '').localeCompare(String(b.labels[sort.col] ?? '')) * sort.dir
    })
  }, [series, sort])
  const head = (col: string, label: string) => (
    <th key={col} className="sticky top-0 bg-surface-raised px-2 py-1 text-left font-semibold text-content-subtle">
      <button type="button" onClick={() => setSort((s) => (s?.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: -1 }))} className="hover:text-content">
        {label}
        {sort?.col === col ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  )
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-edge-subtle">
            {cols.map((c) => head(c, c))}
            {head('__value', 'Value')}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 500).map((r, i) => (
            <tr key={i} className="border-b border-edge-subtle/60">
              {cols.map((c) => (
                <td key={c} className="max-w-[16rem] truncate px-2 py-1 text-content-muted">{r.labels[c] ?? ''}</td>
              ))}
              <td className="px-2 py-1 text-right font-mono tabular-nums text-content">{formatUnit(r.value, u.unit, u.decimals)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LogsPanel({ lines }: { lines: Array<{ ts: number; line: string }> }) {
  if (!lines.length) return <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">No log lines in this range</div>
  return (
    <ul className="h-full overflow-auto font-mono text-[10px] leading-relaxed">
      {lines.slice(0, 200).map((l, i) => (
        <li key={i} className="flex gap-2 border-b border-edge-subtle/50 py-0.5">
          <span className="shrink-0 text-content-subtle">{new Date(l.ts).toLocaleTimeString()}</span>
          <span className="min-w-0 break-all text-content">{l.line}</span>
        </li>
      ))}
    </ul>
  )
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
