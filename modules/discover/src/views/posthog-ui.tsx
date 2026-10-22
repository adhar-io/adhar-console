import { type ComponentProps, useEffect, useRef, useState } from 'react'
import { Button, EmptyState, PostHogIcon, Spinner, TimeSeriesChart, useElementWidth, useToolPublicUrl } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import {
  DATE_RANGES,
  type DateRangeId,
  type FilterOperator,
  isStartingUp,
  type PropertyFilter,
  useEventDefinitions,
  usePHCohorts,
  usePropertyDefinitions,
} from '../data/posthog.ts'
import { SourceError } from './states.tsx'
import { MiniSelect } from './discover-ui.tsx'

/**
 * Shared bits for the PostHog-backed Discover pages: honest source states
 * (including PostHog's long first boot), the date-range and event pickers fed
 * by real event definitions, and the property-filter bar.
 */

export function usePostHogUrl(): string {
  return useToolPublicUrl('posthog')
}

export const fmtNum = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : Math.abs(n) >= 10_000 ? Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : n.toLocaleString(undefined, { maximumFractionDigits: 1 })

export const fmtPct = (n: number | null | undefined, digits = 1): string => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`)

/**
 * Error state for a PostHog call. A fresh install answers 502/503 for a long
 * while as PostHog runs its migrations; that is "starting up", not an outage,
 * so say so and retry on our own every 20 s.
 */
export function PostHogState({ error, onRetry, compact = false }: { error: unknown; onRetry(): void; compact?: boolean }) {
  const starting = isStartingUp(error)
  useEffect(() => {
    if (!starting) return
    // No point waking PostHog from a background tab; the next visible tick retries.
    const id = setInterval(() => {
      if (!document.hidden) onRetry()
    }, 20_000)
    return () => clearInterval(id)
  }, [starting, onRetry])
  const status = (error as { status?: number } | null)?.status
  if (starting) {
    return (
      <EmptyState
        compact={compact}
        icon={<PostHogMark />}
        title="PostHog is starting up"
        description="PostHog answered but is not ready yet — on a fresh install it runs database migrations for several minutes. This page retries on its own."
        action={
          <span className="inline-flex items-center gap-2 text-xs text-content-muted">
            <Spinner size={12} /> Retrying every 20 s
            <Button size="sm" onClick={onRetry}>Retry now</Button>
          </span>
        }
      />
    )
  }
  if (status === 401 || status === 403) {
    return (
      <EmptyState
        compact={compact}
        icon={<PostHogMark />}
        title="PostHog rejected the console’s API key"
        description="The console reaches PostHog with a personal API key (POSTHOG_TOKEN from the posthog-console-credentials Secret). Make sure it exists and has read access to insights, query, cohorts, recordings and feature flags."
        action={<Button size="sm" onClick={onRetry}>Retry</Button>}
      />
    )
  }
  return <SourceError tool="PostHog" error={error} onRetry={onRetry} compact={compact} icon={<PostHogMark />} />
}

export function RangePicker({ value, onChange, ranges = DATE_RANGES.map((r) => r.id) }: { value: DateRangeId; onChange(v: DateRangeId): void; ranges?: DateRangeId[] }) {
  return (
    <MiniSelect
      label="Date range"
      value={value}
      onChange={(v) => onChange(v as DateRangeId)}
      options={DATE_RANGES.filter((r) => ranges.includes(r.id)).map((r) => [r.id, r.label])}
    />
  )
}

/** Event select fed by PostHog's real event definitions. */
export function EventPicker({
  value,
  onChange,
  allowAll = false,
  label = 'Event',
  className,
}: {
  value: string | null
  onChange(v: string | null): void
  allowAll?: boolean
  label?: string
  className?: string
}) {
  const defs = useEventDefinitions()
  const names = (defs.data ?? []).map((d) => d.name)
  const opts: Array<[string, string]> = [
    ...(allowAll ? [['__all', 'All events'] as [string, string]] : []),
    ...(value && !names.includes(value) ? [[value, value] as [string, string]] : []),
    ...names.map((n) => [n, n] as [string, string]),
  ]
  if (!allowAll && !value) opts.unshift(['', defs.isLoading ? 'Loading events…' : 'Pick an event…'])
  return (
    <MiniSelect
      label={label}
      value={value ?? (allowAll ? '__all' : '')}
      onChange={(v) => onChange(v === '__all' || v === '' ? null : v)}
      options={opts}
      className={cn('max-w-[16rem]', className)}
    />
  )
}

/** Breakdown property select (event + person properties). */
export function BreakdownPicker({
  value,
  type,
  onChange,
}: {
  value: string
  type: 'event' | 'person'
  onChange(v: string, type: 'event' | 'person'): void
}) {
  const ev = usePropertyDefinitions('event')
  const pe = usePropertyDefinitions('person')
  return (
    <select
      aria-label="Breakdown"
      value={value ? `${type}:${value}` : ''}
      onChange={(e) => {
        const v = e.target.value
        if (!v) return onChange('', 'event')
        const i = v.indexOf(':')
        onChange(v.slice(i + 1), v.slice(0, i) as 'event' | 'person')
      }}
      className="h-8 max-w-[14rem] rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content"
    >
      <option value="">No breakdown</option>
      <optgroup label="Event properties">
        {(ev.data ?? []).map((p) => <option key={`e${p}`} value={`event:${p}`}>{p}</option>)}
      </optgroup>
      <optgroup label="Person properties">
        {(pe.data ?? []).map((p) => <option key={`p${p}`} value={`person:${p}`}>{p}</option>)}
      </optgroup>
    </select>
  )
}

const OPERATORS: Array<[FilterOperator, string]> = [
  ['exact', '='],
  ['is_not', '≠'],
  ['icontains', 'contains'],
  ['not_icontains', 'not contains'],
  ['is_set', 'is set'],
  ['is_not_set', 'is not set'],
  ['gt', '>'],
  ['lt', '<'],
]

/** Editable list of property filters (event / person properties, cohorts). */
export function FilterBar({ filters, onChange }: { filters: PropertyFilter[]; onChange(f: PropertyFilter[]): void }) {
  const ev = usePropertyDefinitions('event')
  const pe = usePropertyDefinitions('person')
  const cohorts = usePHCohorts()
  const [adding, setAdding] = useState(false)
  const set = (i: number, patch: Partial<PropertyFilter>) => onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filters.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-md border border-edge-default bg-surface-raised py-0.5 pl-1.5 pr-0.5 text-[11px]">
          {f.type === 'cohort' ? (
            <>
              <span className="text-content-subtle">cohort</span>
              <select value={String(f.value ?? '')} onChange={(e) => set(i, { value: e.target.value })} className="h-6 max-w-[10rem] rounded bg-transparent text-[11px] text-content">
                {(cohorts.data ?? []).map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            </>
          ) : (
            <>
              <select
                value={`${f.type}:${f.key}`}
                onChange={(e) => {
                  const v = e.target.value
                  const k = v.indexOf(':')
                  set(i, { type: v.slice(0, k) as 'event' | 'person', key: v.slice(k + 1) })
                }}
                className="h-6 max-w-[10rem] rounded bg-transparent font-mono text-[11px] text-content"
                aria-label="Property"
              >
                {!f.key ? <option value={`${f.type}:`}>property…</option> : null}
                <optgroup label="Event">{(ev.data ?? []).map((p) => <option key={`e${p}`} value={`event:${p}`}>{p}</option>)}</optgroup>
                <optgroup label="Person">{(pe.data ?? []).map((p) => <option key={`p${p}`} value={`person:${p}`}>{p}</option>)}</optgroup>
              </select>
              <select value={f.operator ?? 'exact'} onChange={(e) => set(i, { operator: e.target.value as FilterOperator })} className="h-6 rounded bg-transparent text-[11px] text-content-muted" aria-label="Operator">
                {OPERATORS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
              </select>
              {f.operator === 'is_set' || f.operator === 'is_not_set' ? null : (
                <input
                  value={Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '')}
                  onChange={(e) => set(i, { value: e.target.value })}
                  placeholder="value"
                  className="h-6 w-28 rounded border border-edge-subtle bg-surface-sunken px-1 text-[11px] text-content"
                  aria-label="Value"
                />
              )}
            </>
          )}
          <button type="button" onClick={() => onChange(filters.filter((_, j) => j !== i))} className="rounded px-1 text-content-subtle hover:bg-surface-sunken hover:text-content" aria-label="Remove filter">
            ×
          </button>
        </span>
      ))}
      <div className="relative">
        <button type="button" onClick={() => setAdding((a) => !a)} className="inline-flex h-7 items-center rounded-md border border-dashed border-edge-default px-2 text-[11px] text-content-muted hover:text-content">
          + Filter
        </button>
        {adding ? (
          <div className="absolute left-0 top-full z-20 mt-1 w-44 rounded-md border border-edge-default bg-surface-raised p-1 shadow-lg">
            {([['event', 'Event property'], ['person', 'Person property'], ['cohort', 'In cohort']] as const).map(([t, l]) => (
              <button
                key={t}
                type="button"
                disabled={t === 'cohort' && !(cohorts.data ?? []).length}
                onClick={() => {
                  onChange([...filters, t === 'cohort' ? { type: 'cohort', key: 'id', value: String(cohorts.data?.[0]?.id ?? '') } : { type: t, key: '', operator: 'exact', value: '' }])
                  setAdding(false)
                }}
                className="block w-full rounded px-2 py-1 text-left text-xs text-content hover:bg-surface-sunken disabled:opacity-40"
              >
                {l}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Change vs the previous period — direction by arrow + sign, never colour alone. */
export function Delta({ pct, invert = false }: { pct: number | null; invert?: boolean }) {
  if (pct == null) return <span className="text-[11px] text-content-subtle">no prior data</span>
  const up = pct >= 0
  const good = invert ? !up : up
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums', good ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300')}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
      <span className="font-normal text-content-subtle">vs prior</span>
    </span>
  )
}

/** "Open in PostHog" anchor (hidden until the public URL is known). */
export function OpenInPostHog({ path = '', label = 'Open in PostHog' }: { path?: string; label?: string }) {
  const base = usePostHogUrl()
  if (!base) return null
  return (
    <a
      href={`${base}${path}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-xs font-medium text-content hover:bg-surface-sunken"
    >
      <PostHogMark size={14} /> {label} ↗
    </a>
  )
}

/**
 * PostHog's brand mark is not exported from shell-ui's index (only used
 * inside the app launcher), so the module carries a neutral glyph.
 */
function PostHogMark({ size = 20 }: { size?: number }) {
  return <PostHogIcon size={size} />
}

/**
 * TimeSeriesChart draws into a 640-wide viewBox scaled to its container, so a
 * fixed `height` grows with the card's width (axis text balloons on wide
 * cards). This keeps the rendered height at `heightPx` real pixels.
 */
export function FitTimeSeries({ heightPx, ...rest }: Omit<ComponentProps<typeof TimeSeriesChart>, 'height'> & { heightPx: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const h = width > 0 ? Math.max(80, Math.round((heightPx * 640) / width)) : heightPx
  return (
    <div ref={ref} className="min-w-0">
      {width > 0 ? <TimeSeriesChart {...rest} height={h} /> : <div style={{ height: heightPx }} />}
    </div>
  )
}
