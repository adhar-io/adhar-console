import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, DocStoreError, DrawerWidenButton, EmptyState, Spinner, StatusBadge, type StatusKind, useDrawerWidth, useElementWidth } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName, memberInitials, useMembers } from '../data/plane.ts'
import { planeProblem } from '../data/planning-plane.ts'
import { storeError } from '../data/planning-store.ts'
import type { Health } from '../data/planning-model.ts'

/**
 * Small shared pieces for Define's planning pages: honest error states,
 * health badges, avatars, meters and two hand-drawn charts.
 *
 * Charts are drawn at the container's measured width and a fixed pixel
 * height so axis text stays 10–11px at any width (shell-ui's TimeSeriesChart
 * scales its text with width). Thin marks, one y-axis, a legend for two or
 * more series, labels in text colours, and a hover tooltip.
 */

/* ───── states ───── */

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-content-muted">
      <Spinner size={14} /> {label}
    </div>
  )
}

/**
 * A failed read, said plainly: rate limit (with a countdown when Plane gave
 * one), permission, not configured, store unavailable — never a blank panel.
 */
export function ProblemState({ error, onRetry, compact }: { error: unknown; onRetry?(): void; compact?: boolean }) {
  const store = error instanceof DocStoreError
  const p = store ? { title: 'Console store unavailable', message: storeError(error), retryAfter: undefined as number | undefined, kind: 'other' } : planeProblem(error)
  const [left, setLeft] = useState(p.retryAfter ?? 0)
  useEffect(() => {
    setLeft(p.retryAfter ?? 0)
    if (!p.retryAfter) return
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [p.retryAfter])
  return (
    <EmptyState
      compact={compact}
      title={p.title}
      description={p.message}
      action={onRetry
        ? (
          <Button size="sm" onClick={onRetry} disabled={left > 0}>
            {left > 0 ? `Retry in ${left}s` : 'Retry'}
          </Button>
        )
        : undefined}
    />
  )
}

/** One-line inline notice (store unavailable, partial data). */
export function Notice({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-[12px]',
        tone === 'warn'
          ? 'border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200'
          : 'border-edge-default bg-surface-sunken text-content-muted',
      )}
    >
      {children}
    </div>
  )
}

/* ───── health ───── */

export const HEALTH_META: Record<Health, { label: string; kind: StatusKind }> = {
  'on-track': { label: 'On track', kind: 'healthy' },
  'at-risk': { label: 'At risk', kind: 'paused' },
  'off-track': { label: 'Off track', kind: 'degraded' },
}

export function HealthBadge({ health, overridden, title }: { health: Health; overridden?: boolean; title?: string }) {
  const m = HEALTH_META[health]
  return (
    <span title={title} className="inline-flex items-center gap-1">
      <StatusBadge kind={m.kind}>{m.label}</StatusBadge>
      {overridden ? <span className="text-[10px] text-content-subtle">manual</span> : null}
    </span>
  )
}

/* ───── people ───── */

export interface Person {
  id: string
  name: string
  initials: string
  avatar?: string | null
  email?: string
}

/** Plane user id → display info, from the workspace member list. */
export function usePeople(): { people: Map<string, Person>; list: Person[]; loading: boolean } {
  const q = useMembers()
  return useMemo(() => {
    const list: Person[] = (q.data ?? []).map((m: plane.Member) => ({
      id: m.member?.id ?? m.id,
      name: memberDisplayName(m),
      initials: memberInitials(m),
      avatar: m.member?.avatar ?? m.avatar,
      email: m.member?.email ?? m.email,
    }))
    return { people: new Map(list.map((p) => [p.id, p])), list, loading: q.isLoading }
  }, [q.data, q.isLoading])
}

export function Avatar({ person, size = 20, title }: { person?: Person; size?: number; title?: string }) {
  const label = person?.name ?? 'Unknown'
  return (
    <span
      title={title ?? label}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-50 font-semibold text-brand-700 ring-2 ring-surface-raised dark:bg-brand-500/15 dark:text-brand-200"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42) }}
    >
      {person?.avatar ? <img src={person.avatar} alt="" className="h-full w-full object-cover" /> : (person?.initials ?? '?')}
    </span>
  )
}

export function AvatarStack({ ids, people, max = 3, size = 20 }: { ids: string[]; people: Map<string, Person>; max?: number; size?: number }) {
  if (!ids.length) return <span className="text-[11px] text-content-subtle">—</span>
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {ids.slice(0, max).map((id) => <Avatar key={id} person={people.get(id)} size={size} />)}
      {ids.length > max ? <span className="pl-2.5 text-[11px] text-content-muted">+{ids.length - max}</span> : null}
    </span>
  )
}

/* ───── meters + controls ───── */

export function Meter({ value, max = 100, tone = 'brand', className, label }: { value: number; max?: number; tone?: 'brand' | 'good' | 'warn' | 'bad'; className?: string; label?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  const color = tone === 'good' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : tone === 'bad' ? 'bg-rose-500' : 'bg-brand-500'
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken', className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cn('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange(v: T): void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-lg border border-edge-default bg-surface-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
            value === o.value ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="min-w-0 rounded-lg border border-edge-subtle bg-surface-raised px-3 py-2">
      <div className="truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-content-subtle">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-lg font-semibold tabular-nums',
          tone === 'good' ? 'text-emerald-700 dark:text-emerald-300' : tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : tone === 'bad' ? 'text-rose-700 dark:text-rose-300' : 'text-content',
        )}
      >
        {value}
      </div>
      {hint ? <div className="truncate text-[11px] text-content-muted">{hint}</div> : null}
    </div>
  )
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">{children}</h3>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/* ───── charts ───── */

const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500']

export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const el = document.documentElement
    const mo = new MutationObserver(() => setDark(el.classList.contains('dark')))
    mo.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

export function useSeriesColor(): (i: number) => string {
  const dark = useIsDark()
  return (i: number) => (i < 4 ? (dark ? SERIES_DARK : SERIES_LIGHT)[i] : 'var(--color-content-subtle)')
}

export const IDEAL_COLOR = 'var(--color-content-subtle)'

export interface LineSeries {
  name: string
  values: Array<number | null>
  color: string
  dashed?: boolean
}

function niceMax(v: number): number {
  if (!(v > 0)) return 2
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : n <= 8 ? 8 : 10) * p
}

const fmtDay = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })
const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))

export function ChartLegend({ items }: { items: Array<{ name: string; color: string; dashed?: boolean }> }) {
  if (items.length < 2) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-content-muted">
      {items.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1.5">
          <svg width="14" height="8" aria-hidden>
            <line x1="1" x2="13" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '3 2' : undefined} strokeLinecap="round" />
          </svg>
          {s.name}
        </span>
      ))}
    </div>
  )
}

/** Multi-series line chart over days (`x` = UTC-midnight ms). */
export function DayLineChart({
  days,
  series,
  height = 200,
  unit = '',
  emptyLabel = 'No data yet.',
  markers = [],
}: {
  days: number[]
  series: LineSeries[]
  height?: number
  unit?: string
  emptyLabel?: string
  /** Vertical markers (today, release date). */
  markers?: Array<{ t: number; label: string }>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [hover, setHover] = useState<number | null>(null)
  const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const pad = { l: 36, r: 12, t: 10, b: 22 }
  const top = niceMax(Math.max(0, ...values) * 1.05)
  const plotW = Math.max(1, width - pad.l - pad.r)
  const plotH = height - pad.t - pad.b
  const n = Math.max(1, days.length - 1)
  const x = (k: number) => pad.l + (k / n) * plotW
  const y = (v: number) => pad.t + plotH - (Math.min(v, top) / top) * plotH
  const xOf = (t: number) => (days.length ? pad.l + ((t - days[0]) / Math.max(1, days[days.length - 1] - days[0])) * plotW : 0)
  const path = (vals: Array<number | null>) => {
    let d = ''
    let pen = false
    vals.forEach((v, k) => {
      if (v === null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)} `
      pen = true
    })
    return d.trim()
  }
  const tickEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotW / 70))))
  return (
    <div className="space-y-2">
      <ChartLegend items={series} />
      <div ref={ref} className="relative" style={{ height }}>
        {!days.length || !values.length
          ? <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-edge-default px-3 text-center text-xs text-content-subtle">{emptyLabel}</div>
          : width > 0
          ? (
            <svg
              width={width}
              height={height}
              className="block"
              role="img"
              aria-label={series.map((s) => s.name).join(', ')}
              onMouseMove={(e) => {
                const px = e.clientX - e.currentTarget.getBoundingClientRect().left
                setHover(Math.max(0, Math.min(days.length - 1, Math.round(((px - pad.l) / plotW) * n))))
              }}
              onMouseLeave={() => setHover(null)}
            >
              {[0, 0.5, 1].map((fr) => (
                <g key={fr}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(fr * top)} y2={y(fr * top)} stroke="var(--color-edge-default)" strokeDasharray={fr === 0 ? undefined : '2 4'} />
                  <text x={pad.l - 6} y={y(fr * top) + 3} textAnchor="end" fontSize="10" fill="var(--color-content-subtle)">{fmtNum(fr * top)}</text>
                </g>
              ))}
              {days.map((t, k) => {
                const last = k === days.length - 1
                // Regular ticks, plus the last day unless a regular tick sits too close to it.
                const show = last ? true : k % tickEvery === 0 && x(days.length - 1) - x(k) > 44
                return show
                  ? <text key={t} x={x(k)} y={height - 6} textAnchor={k === 0 ? 'start' : last ? 'end' : 'middle'} fontSize="10" fill="var(--color-content-subtle)">{fmtDay(t)}</text>
                  : null
              })}
              {markers.map((m) =>
                m.t >= days[0] && m.t <= days[days.length - 1]
                  ? (
                    <g key={m.label}>
                      <line x1={xOf(m.t)} x2={xOf(m.t)} y1={pad.t} y2={pad.t + plotH} stroke="var(--color-content-subtle)" strokeDasharray="3 3" />
                      <text
                        x={xOf(m.t) > width - pad.r - 60 ? xOf(m.t) - 4 : xOf(m.t) + 4}
                        y={pad.t + 9 + markers.indexOf(m) * 12}
                        textAnchor={xOf(m.t) > width - pad.r - 60 ? 'end' : 'start'}
                        fontSize="10"
                        fill="var(--color-content-muted)"
                      >
                        {m.label}
                      </text>
                    </g>
                  )
                  : null
              )}
              {series.map((s) => (
                <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="1.75" strokeDasharray={s.dashed ? '4 3' : undefined} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {hover !== null
                ? (
                  <g>
                    <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} stroke="var(--color-edge-strong)" />
                    {series.map((s) => (s.values[hover] !== null && s.values[hover] !== undefined ? <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r="3" fill={s.color} /> : null))}
                  </g>
                )
                : null}
            </svg>
          )
          : null}
        {hover !== null && width > 0 && days[hover] !== undefined
          ? (
            <div
              className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-edge-default bg-surface-raised px-2 py-1.5 text-[11px] text-content shadow-md"
              style={{ left: Math.min(Math.max(x(hover), 80), Math.max(80, width - 80)) }}
            >
              <div className="font-medium">{fmtDay(days[hover])}</div>
              {series.map((s) => (
                <div key={s.name} className="flex items-center gap-1.5 text-content-muted">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  {s.name}: <span className="tabular-nums text-content">{s.values[hover] === null || s.values[hover] === undefined ? '—' : `${fmtNum(s.values[hover]!)}${unit}`}</span>
                </div>
              ))}
            </div>
          )
          : null}
      </div>
    </div>
  )
}

/** Grouped vertical bars per category (velocity: committed vs completed). */
export function GroupedBars({
  categories,
  series,
  height = 200,
  unit = '',
  refLine,
}: {
  categories: string[]
  series: Array<{ name: string; values: number[]; color: string }>
  height?: number
  unit?: string
  refLine?: { value: number; label: string }
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 36, r: 12, t: 10, b: 22 }
  const top = niceMax(Math.max(0, ...series.flatMap((s) => s.values), refLine?.value ?? 0) * 1.05)
  const plotW = Math.max(1, width - pad.l - pad.r)
  const plotH = height - pad.t - pad.b
  const band = plotW / Math.max(1, categories.length)
  const gap = Math.min(16, band * 0.3)
  const bw = Math.max(2, Math.min(18, (band - gap) / Math.max(1, series.length)))
  const y = (v: number) => pad.t + plotH - (Math.min(v, top) / top) * plotH
  return (
    <div className="space-y-2">
      <ChartLegend items={series} />
      <div ref={ref} className="relative" style={{ height }}>
        {!categories.length
          ? <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-edge-default text-xs text-content-subtle">No completed sprints yet.</div>
          : width > 0
          ? (
            <svg width={width} height={height} className="block" role="img" aria-label={series.map((s) => s.name).join(' vs ')} onMouseLeave={() => setHover(null)}>
              {[0, 0.5, 1].map((fr) => (
                <g key={fr}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(fr * top)} y2={y(fr * top)} stroke="var(--color-edge-default)" strokeDasharray={fr === 0 ? undefined : '2 4'} />
                  <text x={pad.l - 6} y={y(fr * top) + 3} textAnchor="end" fontSize="10" fill="var(--color-content-subtle)">{fmtNum(fr * top)}</text>
                </g>
              ))}
              {refLine
                ? (
                  <g>
                    <line x1={pad.l} x2={width - pad.r} y1={y(refLine.value)} y2={y(refLine.value)} stroke="var(--color-content-subtle)" strokeDasharray="4 3" />
                    <text x={width - pad.r - 2} y={y(refLine.value) - 3} textAnchor="end" fontSize="10" fill="var(--color-content-muted)">{refLine.label}</text>
                  </g>
                )
                : null}
              {categories.map((c, k) => {
                const x0 = pad.l + k * band + (band - bw * series.length) / 2
                return (
                  <g key={c} onMouseEnter={() => setHover(k)}>
                    <rect x={pad.l + k * band} y={pad.t} width={band} height={plotH} fill={hover === k ? 'var(--color-surface-sunken)' : 'transparent'} />
                    {series.map((s, j) => (
                      <rect key={s.name} x={x0 + j * bw} y={y(s.values[k] ?? 0)} width={Math.max(1, bw - 2)} height={Math.max(0, pad.t + plotH - y(s.values[k] ?? 0))} rx="1.5" fill={s.color} />
                    ))}
                    {band > 36
                      ? <text x={pad.l + k * band + band / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--color-content-subtle)">{c.length > Math.floor(band / 6) ? `${c.slice(0, Math.max(3, Math.floor(band / 6) - 1))}…` : c}</text>
                      : null}
                  </g>
                )
              })}
            </svg>
          )
          : null}
        {hover !== null && width > 0
          ? (
            <div
              className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-edge-default bg-surface-raised px-2 py-1.5 text-[11px] text-content shadow-md"
              style={{ left: Math.min(Math.max(pad.l + hover * band + band / 2, 80), Math.max(80, width - 80)) }}
            >
              <div className="font-medium">{categories[hover]}</div>
              {series.map((s) => (
                <div key={s.name} className="flex items-center gap-1.5 text-content-muted">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  {s.name}: <span className="tabular-nums text-content">{fmtNum(s.values[hover] ?? 0)}{unit}</span>
                </div>
              ))}
            </div>
          )
          : null}
      </div>
    </div>
  )
}

/* ───── formatting ───── */

export function fmtDate(v?: string | null, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  if (!v) return '—'
  const ms = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { ...opts, timeZone: v.length === 10 ? 'UTC' : undefined }) : '—'
}

export function fmtRange(start?: string | null, end?: string | null): string {
  if (!start && !end) return 'No dates'
  return `${fmtDate(start)} → ${fmtDate(end)}`
}

export function IconButton({ label, onClick, children, disabled }: { label: string; onClick(): void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content disabled:opacity-40"
    >
      {children}
    </button>
  )
}

export function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

export function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconLink() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  )
}

/**
 * Right-side sliding panel used by the planning detail views (sprint, epic,
 * release). Escape and the scrim close it.
 */
export function SidePanel({ title, eyebrow, meta, actions, onClose, children, wide, widthId = 'define.panel' }: {
  title: ReactNode
  eyebrow?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  onClose(): void
  children: ReactNode
  /** A roomier standard width (sprints). */
  wide?: boolean
  /** Key the remembered wide-mode preference is stored under. */
  widthId?: string
}) {
  const width = useDrawerWidth(widthId, { base: wide ? 'max-w-6xl' : 'max-w-5xl' })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"][data-nested]')) onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className={cn('relative flex h-full w-full flex-col overflow-hidden border-l border-edge-default bg-surface-canvas shadow-2xl', width.className)}>
        <header className="border-b border-edge-default bg-surface-raised px-4 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {eyebrow ? <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{eyebrow}</div> : null}
              <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-content">{title}</h2>
              {meta ? <div className="mt-1 text-[12px] text-content-muted">{meta}</div> : null}
            </div>
            {actions ? <div className="hidden shrink-0 flex-wrap items-center justify-end gap-2 md:flex">{actions}</div> : null}
            <div className="flex shrink-0 items-center gap-1">
              <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
              <IconButton label="Close" onClick={onClose}>
                <IconClose />
              </IconButton>
            </div>
          </div>
          {/* Narrow screens: actions get their own row under the title. */}
          {actions ? <div className="mt-3 flex flex-wrap items-center gap-2 md:hidden">{actions}</div> : null}
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">{children}</div>
      </aside>
    </div>,
    document.body,
  )
}
