import { type ReactNode, useMemo, useState } from 'react'
import { Card, CardBody, CardHeader, Spinner, TimeSeriesChart, type Threshold, type TimeSeries } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { Health } from '../data/golden-signals.ts'
import { routeClick } from '../data/discover-links.ts'
import { formatValue, type Unit } from '../data/promql-lite.ts'
import type { RangeSeries } from '../data/prom.ts'

/**
 * Shared chart + widget atoms for the Discover dashboard, metrics explorer and
 * service map.
 *
 * Colour roles:
 *  - categorical series colours come from a fixed 8-slot order (`--viz-1..8`),
 *    stepped separately for dark mode — assigned by series identity, never
 *    cycled; a 9th series is not drawn (the caller caps or folds);
 *  - status colours (ok / warning / critical) are reserved for health and
 *    always ship with an icon and a text label;
 *  - text stays in text tokens.
 */

const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const PALETTE_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const vars = (p: string[]) => p.map((c, i) => `--viz-${i + 1}:${c};`).join('')
const PALETTE_CSS = `:root{${vars(PALETTE_LIGHT)}}.dark{${vars(PALETTE_DARK)}}`

/** Injects the categorical palette tokens (idempotent — React dedupes identical style text poorly, so keep one per view). */
export function VizStyle() {
  return <style>{PALETTE_CSS}</style>
}

export const SERIES_MAX = 8
export const seriesColor = (i: number) => `var(--viz-${(i % SERIES_MAX) + 1})`

/* ─────────── health ─────────── */

const HEALTH: Record<Health, { label: string; cls: string; icon: ReactNode }> = {
  ok: { label: 'Healthy', cls: 'text-emerald-700 dark:text-emerald-300', icon: <IconCheck /> },
  warn: { label: 'Warning', cls: 'text-amber-700 dark:text-amber-300', icon: <IconWarn /> },
  crit: { label: 'Critical', cls: 'text-rose-700 dark:text-rose-300', icon: <IconCrit /> },
  none: { label: 'No data', cls: 'text-content-subtle', icon: <IconDash /> },
}

/** Health as icon + label (never colour alone). `label` overrides the word. */
export function HealthTag({ health, label, compact = false }: { health: Health; label?: ReactNode; compact?: boolean }) {
  const h = HEALTH[health]
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium', h.cls)}>
      {h.icon}
      {compact ? <span className="sr-only">{h.label}</span> : <span>{label ?? h.label}</span>}
    </span>
  )
}

export function healthStroke(h: Health): string {
  return h === 'crit'
    ? 'var(--color-rose-500)'
    : h === 'warn'
    ? 'var(--color-amber-500)'
    : h === 'ok'
    ? 'var(--color-emerald-500)'
    : 'var(--color-edge-strong, var(--color-edge-default))'
}

/* ─────────── links ─────────── */

/** In-app link: a real `<a href>` that routes without a reload. */
export function DLink({ href, children, className, title }: { href: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a href={href} onClick={routeClick} title={title} className={className}>
      {children}
    </a>
  )
}

export function OpenLink({ href, label = 'Open' }: { href: string; label?: string }) {
  return (
    <DLink
      href={href}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-50 hover:underline dark:text-brand-300 dark:hover:bg-brand-500/10"
    >
      {label}
      <IconArrow />
    </DLink>
  )
}

/* ─────────── widget shell ─────────── */

export function Widget({
  title,
  subtitle,
  href,
  hrefLabel,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode
  subtitle?: ReactNode
  href?: string
  hrefLabel?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-content">{title}</div>
            {subtitle ? <div className="truncate text-[11px] text-content-subtle">{subtitle}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            {href ? <OpenLink href={href} label={hrefLabel} /> : null}
          </div>
        </div>
      </CardHeader>
      <CardBody className={cn('min-w-0', bodyClassName)}>{children}</CardBody>
    </Card>
  )
}

/** Honest empty state: what is missing and what would provide it. */
export function NoData({ title = 'No data in this range', hint, height }: { title?: string; hint?: ReactNode; height?: number }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-edge-default px-3 py-4 text-center"
      style={height ? { minHeight: height } : undefined}
    >
      <div className="text-xs font-medium text-content-muted">{title}</div>
      {hint ? <div className="max-w-sm text-[11px] leading-relaxed text-content-subtle">{hint}</div> : null}
    </div>
  )
}

export function Loading({ height = 120 }: { height?: number }) {
  return (
    <div className="flex items-center justify-center text-content-subtle" style={{ minHeight: height }}>
      <Spinner size={14} />
    </div>
  )
}

/** Error message from a failed query, shown in place of the chart. */
export function QueryError({ error, height }: { error: unknown; height?: number }) {
  const msg = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: number } | null)?.status
  const title = status === 503 || status === 404 ? 'Source not configured' : status && status >= 500 ? 'Source unavailable' : 'Query failed'
  return <NoData title={title} hint={msg} height={height} />
}

/* ─────────── charts ─────────── */

export interface Annotation {
  t: number
  label: string
  detail?: string
}

/** Convert range series to TimeSeries with stable palette slots. */
export function toTimeSeries(series: RangeSeries[], name: (s: RangeSeries, i: number) => string, offset = 0): TimeSeries[] {
  return series.slice(0, SERIES_MAX).map((s, i) => ({ name: name(s, i), points: s.points, color: seriesColor(i + offset) }))
}

/**
 * TimeSeriesChart + deploy annotations + a toggleable legend.
 *
 * The shell chart's built-in legend is hidden (it can't toggle) and replaced by
 * one where a click hides a series and Alt/⌥-click isolates it. Annotations are
 * drawn as an overlay using the chart's own geometry (fixed padding on a 640-wide
 * viewBox, x-domain = the visible samples' extent).
 */
export function SignalChart({
  series,
  unit,
  height = 150,
  annotations = [],
  thresholds,
  yMax,
  emptyLabel,
  legend = 'auto',
}: {
  series: TimeSeries[]
  unit: Unit
  height?: number
  annotations?: Annotation[]
  thresholds?: Threshold[]
  yMax?: number
  emptyLabel?: string
  legend?: 'auto' | 'none'
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const visible = useMemo(() => series.filter((s) => !hidden.has(s.name)), [series, hidden])
  const extent = useMemo(() => {
    let t0 = Infinity
    let t1 = -Infinity
    for (const s of visible) {
      for (const [t, v] of s.points) {
        if (!Number.isFinite(t) || !Number.isFinite(v)) continue
        if (t < t0) t0 = t
        if (t > t1) t1 = t
      }
    }
    return Number.isFinite(t0) && t1 > t0 ? { t0, t1 } : null
  }, [visible])
  const marks = extent ? annotations.filter((a) => a.t >= extent.t0 && a.t <= extent.t1) : []
  const toggle = (name: string, isolate: boolean) =>
    setHidden((cur) => {
      if (isolate) {
        const others = series.map((s) => s.name).filter((n) => n !== name)
        const alreadyIsolated = others.every((n) => cur.has(n)) && !cur.has(name)
        return alreadyIsolated ? new Set() : new Set(others)
      }
      const next = new Set(cur)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  // Geometry of TimeSeriesChart: viewBox 640 × height, padding l44 r12 t10 b22.
  const W = 640
  const xPct = (t: number) => extent ? ((44 + ((t - extent.t0) / (extent.t1 - extent.t0)) * (W - 56)) / W) * 100 : 0
  return (
    <div className="min-w-0">
      <div className="relative">
        <TimeSeriesChart
          series={visible}
          height={height}
          formatY={(v) => formatValue(v, unit)}
          thresholds={thresholds}
          yMax={yMax}
          emptyLabel={emptyLabel ?? (series.length ? 'All series hidden' : 'No samples')}
          className="[&>div.mt-1]:hidden"
        />
        {marks.length ? (
          <div className="pointer-events-none absolute inset-0" aria-hidden={false}>
            {marks.map((a, i) => (
              <div
                key={`${a.t}-${i}`}
                className="group absolute flex w-3 -translate-x-1/2 justify-center"
                style={{ left: `${xPct(a.t)}%`, top: `${(10 / height) * 100}%`, bottom: `${(22 / height) * 100}%` }}
              >
                <div className="h-full border-l border-dashed border-content-subtle/70" />
                <span
                  tabIndex={0}
                  title={`${a.label}${a.detail ? ` — ${a.detail}` : ''} · ${new Date(a.t).toLocaleString()}`}
                  aria-label={`Deploy ${a.label} at ${new Date(a.t).toLocaleString()}`}
                  className="pointer-events-auto absolute -top-1 size-2 rotate-45 rounded-[1px] bg-content-muted ring-2 ring-surface-raised"
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {legend === 'auto' && (series.length > 1 || marks.length) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted">
          {series.length > 1
            ? series.map((s) => {
              const off = hidden.has(s.name)
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={(e) => toggle(s.name, e.altKey)}
                  title="Click to hide · Alt-click to isolate"
                  aria-pressed={!off}
                  className={cn('inline-flex max-w-[16rem] items-center gap-1.5 rounded px-0.5 hover:text-content', off && 'opacity-45 line-through')}
                >
                  <span className="inline-block h-0.5 w-3 shrink-0 rounded" style={{ backgroundColor: s.color }} />
                  <span className="truncate">{s.name}</span>
                </button>
              )
            })
            : null}
          {marks.length ? (
            <span className="inline-flex items-center gap-1.5 text-content-subtle">
              <span className="inline-block size-1.5 rotate-45 bg-content-muted" /> deploy ({marks.length})
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Horizontal meter with labelled markers — used for capacity (usage vs requests vs limits). */
export function Meter({
  label,
  max,
  bars,
  format,
}: {
  label: string
  max: number | null
  bars: Array<{ name: string; value: number | null; color: string }>
  format(v: number): string
}) {
  const top = Math.max(max ?? 0, ...bars.map((b) => b.value ?? 0)) || 1
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-medium text-content">{label}</span>
        <span className="font-mono text-content-subtle">{max != null ? `allocatable ${format(max)}` : 'allocatable —'}</span>
      </div>
      {bars.map((b) => (
        <div key={b.name} className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-2 text-[11px]">
          <span className="text-content-muted">{b.name}</span>
          <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
            {b.value != null ? (
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (b.value / top) * 100)}%`, backgroundColor: b.color }} />
            ) : null}
          </div>
          <span className="text-right font-mono tabular-nums text-content">
            {b.value != null ? format(b.value) : '—'}
            {b.value != null && max ? <span className="text-content-subtle"> · {Math.round((b.value / max) * 100)}%</span> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ─────────── segmented control ─────────── */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: ReadonlyArray<{ id: T; label: ReactNode; title?: string }>
  onChange(v: T): void
  ariaLabel?: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-edge-default bg-surface-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          title={o.title}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded px-2 py-0.5 text-[11px] transition-colors',
            value === o.id
              ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
              : 'text-content-muted hover:bg-surface-sunken hover:text-content',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Compact native select styled for filter rows. */
export function MiniSelect({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string
  onChange(v: string): void
  options: Array<{ value: string; label: string }>
  ariaLabel: string
  className?: string
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-7 min-w-0 max-w-[12rem] rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20',
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/* ─────────── icons ─────────── */

const svg = { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.25, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

export function IconCheck() {
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  )
}
export function IconWarn() {
  return (
    <svg {...svg}>
      <path d="M12 3 2 21h20L12 3z" />
      <path d="M12 10v4" />
      <path d="M12 17.5h.01" />
    </svg>
  )
}
export function IconCrit() {
  return (
    <svg {...svg}>
      <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </svg>
  )
}
export function IconDash() {
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
      <path d="M8 12h8" />
    </svg>
  )
}
export function IconArrow() {
  return (
    <svg {...svg} width={11} height={11}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
export function IconRefresh() {
  return (
    <svg {...svg} width={13} height={13}>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}
export function IconCopy() {
  return (
    <svg {...svg} width={13} height={13}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}
export function IconExternal() {
  return (
    <svg {...svg} width={13} height={13}>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  )
}
