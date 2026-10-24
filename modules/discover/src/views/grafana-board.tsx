import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  EmptyState,
  GrafanaIcon,
  Markdown,
  Spinner,
  useElementWidth,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  ALL_VALUE,
  boardLink,
  expandRepeats,
  GRID_CELL_MARGIN,
  type GrafanaPanel,
  interpolate,
  layoutSections,
  NO_QUERY_PANELS,
  normalizePanels,
  panelLink,
  panelPixelHeight,
  parseDuration,
  QUICK_RANGES,
  rangeLabel,
  readBoardUrl,
  clampRefresh,
  REFRESH_INTERVALS,
  resolveRange,
  SUPPORTED_PANELS,
  type VarMap,
  writeBoardUrl,
} from '../data/grafana-board.ts'
import {
  type BoardVariable,
  type PanelContext,
  type PanelData,
  panelTime,
  useBoardVariables,
  useGrafanaDashboard,
  useGrafanaDatasources,
  usePanelData,
  useStarDashboard,
} from '../data/grafana.ts'
import { framesFromQueries, interpolateLink, resolveFields } from '../data/grafana-fields.ts'
import { applyTransformations } from '../data/grafana-transforms.ts'
import { consoleBoardHref, panelLinks } from '../data/grafana-links.ts'
import { SourceError } from './states.tsx'
import { DLink, VizStyle } from './viz.tsx'
import { anchorOf, HoverTip } from './grafana-viz.tsx'
import { TimeseriesViz } from './grafana-timeseries.tsx'
import { TimelineViz } from './grafana-timeline.tsx'
import { HeatmapViz, HistogramViz } from './grafana-heatmap.tsx'
import { TableViz } from './grafana-table.tsx'
import { BarGaugeViz, GaugeViz, PieViz, StatViz } from './grafana-single.tsx'
import { AlertListViz, AnnoListViz, DashListViz } from './grafana-lists.tsx'

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
  const [refresh, setRefresh] = useState(clampRefresh(initialUrl.refresh))
  const [tick, setTick] = useState(0)
  const [isStarred, setIsStarred] = useState(!!starred)
  useEffect(() => setIsStarred(!!(dash.data?.meta?.isStarred ?? starred)), [dash.data, starred])

  // Board defaults once the JSON arrives (URL wins).
  useEffect(() => {
    if (!d) return
    if (!initialUrl.from) setFrom(d.time?.from ?? 'now-6h')
    if (!initialUrl.to) setTo(d.time?.to ?? 'now')
    if (!initialUrl.refresh && typeof d.refresh === 'string') setRefresh(clampRefresh(d.refresh))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per board
  }, [d?.uid])

  // Auto-refresh: bump the tick, which re-resolves `now` and refetches. Every
  // tick re-queries every panel, so a background tab skips ticks and catches
  // up with one refresh when it is shown again.
  useEffect(() => {
    const ms = parseDuration(clampRefresh(refresh))
    if (!ms) return
    let missed = false
    const id = setInterval(() => {
      if (document.hidden) missed = true
      else setTick((t) => t + 1)
    }, ms)
    const onVisible = () => {
      if (document.hidden || !missed) return
      missed = false
      setTick((t) => t + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
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
        {v.error ? <span className="text-rose-600 dark:text-rose-400" title={(v.error as Error).message}>⚠ query failed</span> : null}
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
        {error ? <span className="text-rose-600 dark:text-rose-400">⚠ query failed</span> : null}
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
  const width = useElementWidth(ref)
  // Grafana's maxDataPoints defaults to the panel width — freeze the first
  // measurement so a resize does not refetch every panel.
  const widthRef = useRef(0)
  if (!widthRef.current && width > 0) widthRef.current = width
  const [showQuery, setShowQuery] = useState(false)
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const supported = SUPPORTED_PANELS.has(panel.type)
  const needsData = supported && !NO_QUERY_PANELS.has(panel.type)
  const q = usePanelData(panel, ctx, inView && needsData && widthRef.current > 0, widthRef.current)
  const title = interpolate(panel.title ?? '', ctx.vars, {}, panel.scopedVars, 'text')
  const link = panelLink(base, uid, panel.sourceId ?? panel.id, from, to, ctx.vars)
  const timeInfo = panel.hideTimeOverride ? undefined : panelTime(panel, ctx).info
  const description = panel.description ? interpolate(panel.description, ctx.vars, {}, panel.scopedVars, 'text') : ''
  const links = panelLinks(panel.links, (u) => interpolateLink(u, {}, ctx.vars, { __url_time_range: `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` }))

  let body: ReactNode
  if (!supported) {
    body = <Placeholder link={link} reason={`“${panel.type}” panels are not drawn in the console.`} />
  } else if (panel.type === 'text') {
    body = <TextPanel panel={panel} vars={ctx.vars} />
  } else if (panel.type === 'alertlist') {
    body = <AlertListViz panel={panel} dashboardUid={uid} enabled={inView} tick={ctx.tick} />
  } else if (panel.type === 'dashlist') {
    body = <DashListViz panel={panel} enabled={inView} from={from} to={to} />
  } else if (panel.type === 'annolist') {
    body = <AnnoListViz panel={panel} dashboardUid={uid} range={panelTime(panel, ctx)} enabled={inView} tick={ctx.tick} />
  } else if (!inView || q.isLoading || (needsData && !q.data && !q.isError && (panel.targets ?? []).length > 0)) {
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
    body = <PanelBody panel={panel} data={q.data} ctx={ctx} base={base} from={from} to={to} />
  }

  return (
    <div
      ref={ref}
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-lg',
        (panel as { transparent?: boolean }).transparent ? '' : 'border border-edge-default bg-surface-raised',
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-1.5 px-2.5">
        <span className="truncate text-[12px] font-semibold text-content" title={title}>{title}</span>
        {description ? (
          <button
            type="button"
            aria-label={`About this panel: ${description}`}
            className="shrink-0 rounded text-[11px] leading-none text-content-subtle hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
            onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setTip(null)}
            onFocus={(e) => setTip(anchorOf(e.currentTarget))}
            onBlur={() => setTip(null)}
          >
            ⓘ
          </button>
        ) : null}
        {timeInfo ? <span className="shrink-0 truncate font-mono text-[10px] text-sky-700 dark:text-sky-300" title="Panel time override">{timeInfo}</span> : null}
        {q.isFetching && !q.isLoading ? <Spinner size={9} /> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1 opacity-70 hover:opacity-100">
          {links.map((l) => {
            const internal = consoleBoardHref(l.url, typeof location !== 'undefined' ? location.search : '', { from, to })
            return internal ? (
              <DLink key={l.url} href={internal} title={l.title} className="max-w-[8rem] truncate rounded px-1 text-[10px] text-content-subtle hover:bg-surface-sunken hover:text-content">
                {l.title} ↗
              </DLink>
            ) : (
              <a key={l.url} href={/^https?:/.test(l.url) ? l.url : `${base.replace(/\/$/, '')}${l.url.startsWith('/') ? '' : '/'}${l.url}`} target="_blank" rel="noopener noreferrer" title={l.title} className="max-w-[8rem] truncate rounded px-1 text-[10px] text-content-subtle hover:bg-surface-sunken hover:text-content">
                {l.title} ↗
              </a>
            )
          })}
          {q.data?.queries?.length ? (
            <button type="button" onClick={() => setShowQuery((s) => !s)} className="rounded px-1 text-[10px] text-content-subtle hover:bg-surface-sunken hover:text-content" title="Show query" aria-pressed={showQuery}>
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
      {tip && description ? (
        <HoverTip x={tip.x} y={tip.y}>
          <div className="whitespace-pre-line font-sans text-[11px] leading-snug text-content">{description}</div>
        </HoverTip>
      ) : null}
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

function PanelBody({ panel, data, ctx, base, from, to }: { panel: GrafanaPanel; data: PanelData; ctx: PanelContext; base: string; from: string; to: string }) {
  const logs = useMemo(() => data.frames.flatMap((f) => f.logs ?? []), [data])
  const prepared = useMemo(() => {
    const raw = framesFromQueries(data.frames.filter((f) => !f.logs))
    const t = applyTransformations(raw, panel.transformations)
    const resolved = resolveFields(t.frames, panel.fieldConfig?.defaults, panel.fieldConfig?.overrides, ctx.vars, panel.scopedVars)
    return { resolved, fields: resolved.flatMap((r) => r.fields), skipped: t.skipped }
    // ctx.vars identity changes per render; displayName templates only need values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, panel, JSON.stringify(Object.fromEntries(Object.entries(ctx.vars).map(([k, v]) => [k, v.values])))])
  if (panel.type === 'logs' || logs.length) return <LogsPanel panel={panel} lines={logs} />
  const range = data.range ?? ctx.time
  const hasValues = prepared.fields.some((f) => f.type !== 'time' && f.values.some((v) => v != null))
  if (!hasValues) {
    const nv = panel.fieldConfig?.defaults?.noValue
    return (
      <div className="flex h-full items-center justify-center text-center">
        <span className={nv && ['stat', 'singlestat', 'gauge', 'bargauge'].includes(panel.type) ? 'text-2xl font-semibold text-content-muted' : 'text-[11px] text-content-subtle'}>
          {nv ?? 'No data in this range'}
        </span>
      </div>
    )
  }
  const note = prepared.skipped.length ? (
    <div className="pt-0.5 text-[10px] text-content-subtle">Not applied here: {prepared.skipped.join(', ')} transformation{prepared.skipped.length === 1 ? '' : 's'}</div>
  ) : null
  let viz: ReactNode
  switch (panel.type) {
    case 'stat':
    case 'singlestat':
      viz = <StatViz panel={panel} frames={prepared.resolved} />
      break
    case 'gauge':
      viz = <GaugeViz panel={panel} frames={prepared.resolved} />
      break
    case 'bargauge':
    case 'barchart':
      viz = <BarGaugeViz panel={panel} frames={prepared.resolved} />
      break
    case 'piechart':
      viz = <PieViz panel={panel} frames={prepared.resolved} />
      break
    case 'table':
    case 'table-old':
      viz = <TableViz panel={panel} frames={prepared.resolved} vars={ctx.vars} grafanaBase={base} timeRange={{ from, to }} />
      break
    case 'state-timeline':
    case 'status-history':
      viz = <TimelineViz panel={panel} fields={prepared.fields} range={range} stepMs={data.stepMs} kind={panel.type} />
      break
    case 'heatmap':
      viz = <HeatmapViz panel={panel} series={data.frames.flatMap((f) => f.series)} fields={prepared.fields} range={range} />
      break
    case 'histogram':
      viz = <HistogramViz panel={panel} fields={prepared.fields} />
      break
    default:
      viz = <TimeseriesViz panel={panel} fields={prepared.fields} range={range} stepMs={data.stepMs} />
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{viz}</div>
      {note}
    </div>
  )
}

function LogsPanel({ panel, lines }: { panel: GrafanaPanel; lines: Array<{ ts: number; line: string; labels: Record<string, string> }> }) {
  const o = (panel.options ?? {}) as { showTime?: boolean; wrapLogMessage?: boolean; sortOrder?: string; dedupStrategy?: string; showLabels?: boolean }
  const shown = useMemo(() => {
    let l = [...lines].sort((a, b) => (o.sortOrder === 'Ascending' ? a.ts - b.ts : b.ts - a.ts))
    if (o.dedupStrategy === 'exact' || o.dedupStrategy === 'signature') {
      const sig = (s: string) => (o.dedupStrategy === 'signature' ? s.replace(/\d+/g, '0') : s)
      l = l.filter((x, i) => i === 0 || sig(x.line) !== sig(l[i - 1].line))
    }
    return l.slice(0, 200)
  }, [lines, o.sortOrder, o.dedupStrategy])
  if (!lines.length) return <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">No log lines in this range</div>
  return (
    <ul className="h-full overflow-auto font-mono text-[10px] leading-relaxed">
      {shown.map((l, i) => (
        <li key={i} className="flex gap-2 border-b border-edge-subtle/50 py-0.5">
          {o.showTime !== false ? <span className="shrink-0 text-content-subtle">{new Date(l.ts).toLocaleTimeString()}</span> : null}
          {o.showLabels ? <span className="shrink-0 text-content-subtle">{Object.entries(l.labels).map(([k, v]) => `${k}=${v}`).join(' ')}</span> : null}
          <span className={cn('min-w-0 text-content', o.wrapLogMessage === false ? 'truncate whitespace-nowrap' : 'break-all')}>{l.line}</span>
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
