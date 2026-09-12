import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LokiIcon, Spinner, StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { lgtm } from '@adhar-console/api-clients'
import {
  useLogLabelValues,
  useLogLabels,
  useLogs,
  type HistogramBucket,
  type TimeSelection,
} from '../data/observability.ts'
import {
  formatDateTime,
  formatTs,
  labelsOf,
  parseLine,
  parseSelector,
  relative,
  selectorFor,
  withLineFilter,
  withMatcher,
} from '../data/log-fields.ts'

/* ─────────── level styling (shared) ─────────── */

export type Level = NonNullable<lgtm.LogEntry['level']>
export const LEVELS: Level[] = ['debug', 'info', 'warn', 'error', 'fatal']

export const LEVEL_TONE: Record<Level, StatusKind> = {
  debug: 'unknown',
  info: 'info',
  warn: 'progressing',
  error: 'failed',
  fatal: 'failed',
}

/** Chip styling when a level filter is ON. */
export const LEVEL_CHIP: Record<Level, string> = {
  debug: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-500/15 dark:text-slate-300 dark:ring-slate-500/30',
  info: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30',
  warn: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  error: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30',
  fatal: 'bg-rose-100 text-rose-900 ring-rose-300 dark:bg-rose-500/25 dark:text-rose-200 dark:ring-rose-500/40',
}

/** Left gutter colour per level in the stream. */
export const LEVEL_BAR: Record<Level, string> = {
  debug: 'bg-slate-300 dark:bg-slate-600',
  info: 'bg-sky-400',
  warn: 'bg-amber-400',
  error: 'bg-rose-500',
  fatal: 'bg-rose-700',
}

export const HIST_COLOR = {
  error: 'var(--color-rose-500)',
  warn: 'var(--color-amber-500)',
  info: 'var(--color-sky-400)',
} as const

export function levelOf(e: lgtm.LogEntry): Level {
  return e.level ?? 'info'
}

/* ─────────── histogram ─────────── */

export function Histogram({
  buckets,
  levels,
  onZoom,
  height = 84,
}: {
  buckets: HistogramBucket[]
  levels: Set<string>
  onZoom(b: HistogramBucket): void
  height?: number
}) {
  const showError = levels.has('error') || levels.has('fatal')
  const showWarn = levels.has('warn')
  const showInfo = levels.has('info') || levels.has('debug')
  const shown = (b: HistogramBucket) =>
    (showError ? b.error : 0) + (showWarn ? b.warn : 0) + (showInfo ? b.info : 0)
  const max = Math.max(1, ...buckets.map(shown))
  const [hover, setHover] = useState<number | null>(null)

  if (buckets.length === 0 || buckets.every((b) => shown(b) === 0)) {
    return (
      <div className="flex items-center justify-center text-xs text-content-subtle" style={{ height }}>
        No volume in this window.
      </div>
    )
  }

  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  const mid = buckets[Math.floor(buckets.length / 2)]

  return (
    <div className="space-y-1">
      <div className="relative flex items-end gap-px" style={{ height }} onMouseLeave={() => setHover(null)}>
        {/* faint gridlines */}
        <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-t border-dashed border-edge-subtle/70" />
          ))}
        </div>
        {buckets.map((b, i) => {
          const total = shown(b)
          const segs = [
            showError ? { key: 'error', n: b.error, color: HIST_COLOR.error } : null,
            showWarn ? { key: 'warn', n: b.warn, color: HIST_COLOR.warn } : null,
            showInfo ? { key: 'info', n: b.info, color: HIST_COLOR.info } : null,
          ].filter(Boolean) as Array<{ key: string; n: number; color: string }>
          return (
            <button
              key={i}
              type="button"
              onClick={() => onZoom(b)}
              onMouseEnter={() => setHover(i)}
              title="Zoom to this bucket"
              className={cn(
                'relative flex h-full flex-1 flex-col justify-end rounded-sm transition-colors',
                hover === i ? 'bg-brand-500/10' : 'hover:bg-surface-sunken/60',
              )}
            >
              {segs.map((s) => (
                <div
                  key={s.key}
                  style={{ height: `${(s.n / max) * 100}%`, backgroundColor: s.color, opacity: hover === null || hover === i ? 1 : 0.55 }}
                  className="w-full transition-opacity first:rounded-t-sm"
                />
              ))}
              {hover === i ? (
                <span className="pointer-events-none absolute -top-7 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[10px] font-medium text-white shadow-md dark:bg-slate-100 dark:text-slate-900">
                  {fmtBucket(b)} · {total} line{total === 1 ? '' : 's'}
                  {b.error ? <span className="ml-1 text-rose-300 dark:text-rose-600">{b.error} err</span> : null}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-content-subtle">
        <span>{fmtAxis(first.start)}</span>
        <span>{fmtAxis(mid.start)}</span>
        <span>{fmtAxis(last.end)}</span>
      </div>
    </div>
  )
}

function fmtAxis(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtBucket(b: HistogramBucket): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const f = new Date(b.start)
  const t = new Date(b.end)
  return `${p(f.getHours())}:${p(f.getMinutes())}:${p(f.getSeconds())} – ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
}

/* ─────────── label browser ─────────── */

/**
 * Loki label explorer — pick a label, pick values, and the matcher is merged
 * into the draft query's stream selector. Values are narrowed by whatever
 * selector the draft already has, so choices stay consistent.
 */
export function LabelBrowser({
  sel,
  draft,
  onDraft,
  onClose,
}: {
  sel: TimeSelection
  draft: string
  onDraft(next: string): void
  onClose(): void
}) {
  const labels = useLogLabels(sel)
  const [label, setLabel] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const selector = useMemo(() => {
    const m = /^\s*\{[^}]*\}/.exec(draft)
    return m ? m[0].trim() : ''
  }, [draft])
  const values = useLogLabelValues(label, sel, selector)
  const current = useMemo(() => parseSelector(draft), [draft])

  useEffect(() => {
    if (!label && labels.data?.length) {
      const preferred = ['namespace', 'app', 'service_name', 'job', 'pod', 'container']
      setLabel(preferred.find((p) => labels.data!.includes(p)) ?? labels.data[0])
    }
  }, [label, labels.data])

  const shownValues = (values.data ?? []).filter((v) => !filter || v.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl ring-1 ring-black/5 dark:ring-white/10">
      <div className="flex items-center justify-between border-b border-edge-subtle px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Label browser</div>
        <div className="flex items-center gap-2">
          {selector ? (
            <span className="hidden font-mono text-[10px] text-content-subtle md:inline">narrowed by {selector}</span>
          ) : null}
          <button type="button" onClick={onClose} className="rounded p-1 text-content-subtle hover:bg-surface-sunken hover:text-content" aria-label="Close label browser">
            <IconX />
          </button>
        </div>
      </div>
      <div className="grid max-h-80 grid-cols-[180px_1fr]">
        <ul className="overflow-y-auto border-r border-edge-subtle py-1">
          {labels.isLoading ? (
            <li className="flex items-center gap-2 px-3 py-2 text-[11px] text-content-subtle"><Spinner size={11} /> Loading labels…</li>
          ) : labels.isError ? (
            <li className="px-3 py-2 text-[11px] text-rose-600">Couldn’t list labels.</li>
          ) : (labels.data ?? []).length === 0 ? (
            <li className="px-3 py-2 text-[11px] text-content-subtle">No labels in range.</li>
          ) : (
            labels.data!.map((l) => {
              const used = current.some((m) => m.key === l)
              return (
                <li key={l}>
                  <button
                    type="button"
                    onClick={() => {
                      setLabel(l)
                      setFilter('')
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-[11px] transition-colors',
                      label === l ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                    )}
                  >
                    <span className="truncate">{l}</span>
                    {used ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" /> : null}
                  </button>
                </li>
              )
            })
          )}
        </ul>
        <div className="flex min-h-0 flex-col">
          <div className="border-b border-edge-subtle p-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={label ? `Filter ${label} values…` : 'Pick a label'}
              className="h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 font-mono text-[11px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {!label ? null : values.isLoading ? (
              <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-content-subtle"><Spinner size={11} /> Loading values…</div>
            ) : values.isError ? (
              <div className="px-1 py-2 text-[11px] text-rose-600">Couldn’t list values.</div>
            ) : shownValues.length === 0 ? (
              <div className="px-1 py-2 text-[11px] text-content-subtle">No values.</div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {shownValues.map((v) => {
                  const on = current.some((m) => m.key === label && m.op === '=' && m.value === v)
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => onDraft(withMatcher(draft, label, v))}
                      className={cn(
                        'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                        on
                          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
                          : 'border-edge-default bg-surface-raised text-content-muted hover:border-brand-300 hover:text-content',
                      )}
                    >
                      <span className="truncate">{v}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-edge-subtle px-3 py-2 text-[11px] text-content-subtle">
        <span>Click a value to add <code className="font-mono">{label ?? 'label'}="…"</code> to the selector.</span>
        <span className="font-mono">{draft || '{…}'}</span>
      </div>
    </div>
  )
}

/* ─────────── detail drawer ─────────── */

export function LogDetailDrawer({
  entry,
  query,
  onClose,
  onQuery,
  onWindow,
}: {
  entry: lgtm.LogEntry
  query: string
  onClose(): void
  /** Replace the query (and run it). */
  onQuery(next: string): void
  /** Jump the page to an absolute window. */
  onWindow(from: string, to: string): void
}) {
  const [tab, setTab] = useState<'fields' | 'raw' | 'context'>('fields')
  const parsed = parseLine(entry)
  const lvl = levelOf(entry)
  const ts = new Date(entry.timestamp)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  const labels = Object.entries(labelsOf(entry)).filter(([k]) => !k.startsWith('__'))
  const fields = Object.entries(parsed.fields)

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Log line details">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px] dark:bg-black/60" />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind={LEVEL_TONE[lvl]}>{lvl}</StatusBadge>
                <span className="font-mono text-[12px] text-content">{formatDateTime(ts)}</span>
                <span className="text-[11px] text-content-subtle">{relative(Date.now() - ts.getTime())}</span>
                <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] uppercase text-content-subtle">{parsed.format}</span>
              </div>
              <p className="mt-2 line-clamp-3 break-all font-mono text-[12px] text-content-muted">{entry.message}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <IconBtn label="Copy line" onClick={() => copy(entry.message)}><IconCopy /></IconBtn>
              <IconBtn label="Copy as JSON" onClick={() => copy(JSON.stringify(entry, null, 2))}><IconBraces /></IconBtn>
              <IconBtn label="Close" onClick={onClose}><IconX /></IconBtn>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-1 rounded-lg bg-surface-sunken p-1">
            {(
              [
                ['fields', `Fields${fields.length ? ` · ${fields.length}` : ''}`],
                ['raw', 'Raw'],
                ['context', 'Context'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'h-7 rounded-md px-3 text-[12px] font-medium transition-colors',
                  tab === id ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'fields' ? (
            <div className="space-y-5 p-5">
              <Section title="Stream labels" hint="Click to pin or exclude in the selector">
                {labels.length === 0 ? (
                  <Muted>No labels on this stream.</Muted>
                ) : (
                  <KvTable
                    rows={labels}
                    actions={(k, v) => (
                      <>
                        <MiniBtn title={`Add ${k}="${v}" to selector`} onClick={() => onQuery(withMatcher(query, k, v))}>=</MiniBtn>
                        <MiniBtn title={`Exclude ${k}="${v}"`} onClick={() => onQuery(withMatcher(query, k, v, '!='))}>≠</MiniBtn>
                        <MiniBtn title="Copy value" onClick={() => copy(v)}><IconCopy /></MiniBtn>
                      </>
                    )}
                  />
                )}
              </Section>
              <Section
                title={parsed.format === 'text' ? 'Detected fields' : `Parsed fields (${parsed.format})`}
                hint="Filter the stream for or against a value"
              >
                {fields.length === 0 ? (
                  <Muted>No key=value pairs or JSON detected in this line.</Muted>
                ) : (
                  <KvTable
                    rows={fields}
                    actions={(_k, v) => (
                      <>
                        <MiniBtn title={`Lines containing "${v}"`} onClick={() => onQuery(withLineFilter(query, v))}><IconFilterIn /></MiniBtn>
                        <MiniBtn title={`Lines without "${v}"`} onClick={() => onQuery(withLineFilter(query, v, true))}><IconFilterOut /></MiniBtn>
                        <MiniBtn title="Copy value" onClick={() => copy(v)}><IconCopy /></MiniBtn>
                      </>
                    )}
                  />
                )}
              </Section>
            </div>
          ) : tab === 'raw' ? (
            <div className="p-5">
              <pre className="whitespace-pre-wrap break-all rounded-xl border border-edge-default bg-surface-sunken p-4 font-mono text-[12px] leading-relaxed text-content">
                {parsed.pretty ?? entry.message}
              </pre>
            </div>
          ) : (
            <ContextView entry={entry} onQuery={onQuery} onWindow={onWindow} />
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/** ±N lines from the same stream around the selected line. */
function ContextView({
  entry,
  onQuery,
  onWindow,
}: {
  entry: lgtm.LogEntry
  onQuery(next: string): void
  onWindow(from: string, to: string): void
}) {
  const selector = selectorFor(entry.labels)
  const t = new Date(entry.timestamp).getTime()
  const from = new Date(t - 5 * 60_000).toISOString()
  const to = new Date(t + 5 * 60_000).toISOString()
  const sel: TimeSelection = { kind: 'absolute', from, to }
  const q = useLogs(selector, sel, 400)
  const [span, setSpan] = useState(20)

  const rows = useMemo(() => {
    const list = [...(q.data ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    let idx = list.findIndex((l) => l.timestamp === entry.timestamp && l.message === entry.message)
    if (idx < 0) {
      // Fall back to the closest timestamp when the exact line isn't in the page.
      let best = 0
      let bestD = Infinity
      list.forEach((l, i) => {
        const d = Math.abs(new Date(l.timestamp).getTime() - t)
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      idx = best
    }
    const start = Math.max(0, idx - span)
    const end = Math.min(list.length, idx + span + 1)
    return { list: list.slice(start, end), target: idx - start, before: idx - start, after: end - idx - 1 }
  }, [q.data, entry, span, t])

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-content-muted">
          Same stream, <span className="font-mono text-content">±5m</span> around this line
        </div>
        <div className="flex items-center gap-1">
          {[10, 20, 50].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setSpan(n)}
              className={cn(
                'h-7 rounded-md px-2 text-[11px] font-medium',
                span === n ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/30' : 'text-content-muted hover:bg-surface-sunken',
              )}
            >
              ±{n}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              onWindow(from, to)
              onQuery(selector)
            }}
            className="ml-2 inline-flex h-7 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] font-medium text-content-muted hover:border-brand-300 hover:text-content"
          >
            <IconArrowUpRight /> Open as query
          </button>
        </div>
      </div>
      <div className="font-mono text-[10px] text-content-subtle">{selector}</div>
      {q.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-[12px] text-content-subtle"><Spinner size={12} /> Loading context…</div>
      ) : q.isError ? (
        <div className="py-8 text-[12px] text-rose-600">Couldn’t load context from Loki.</div>
      ) : rows.list.length === 0 ? (
        <div className="py-8 text-[12px] text-content-subtle">No surrounding lines.</div>
      ) : (
        <ol className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised font-mono text-[11.5px]">
          {rows.list.map((l, i) => {
            const isTarget = i === rows.target
            const lv = levelOf(l)
            return (
              <li
                key={`${l.timestamp}-${i}`}
                className={cn(
                  'grid grid-cols-[3px_86px_1fr] items-start gap-2 border-b border-edge-subtle px-2 py-1 last:border-b-0',
                  isTarget && 'bg-brand-50/70 ring-1 ring-inset ring-brand-300 dark:bg-brand-500/10 dark:ring-brand-500/40',
                )}
              >
                <span className={cn('mt-1 h-3 w-[3px] rounded-full', LEVEL_BAR[lv])} />
                <span className="pt-0.5 text-[10px] tabular-nums text-content-subtle">{formatTs(l.timestamp, 'time')}</span>
                <span className={cn('break-all', isTarget ? 'font-semibold text-content' : 'text-content-muted')}>{l.message}</span>
              </li>
            )
          })}
        </ol>
      )}
      {rows.list.length ? (
        <div className="text-[11px] text-content-subtle">
          {rows.before} before · {rows.after} after
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── bits ─────────── */

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{title}</h3>
        {hint ? <span className="text-[11px] text-content-subtle">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-edge-default px-3 py-2 text-[12px] text-content-subtle">{children}</p>
}

function KvTable({
  rows,
  actions,
}: {
  rows: Array<[string, string]>
  actions(k: string, v: string): ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-edge-default">
      <table className="w-full text-[12px]">
        <tbody className="divide-y divide-edge-subtle">
          {rows.map(([k, v]) => (
            <tr key={k} className="group bg-surface-raised hover:bg-surface-sunken/60">
              <td className="w-44 max-w-44 truncate px-3 py-1.5 align-top font-mono text-content-muted" title={k}>{k}</td>
              <td className="break-all px-3 py-1.5 font-mono text-content">{v === '' ? <span className="text-content-subtle">∅</span> : v}</td>
              <td className="w-24 px-2 py-1 text-right align-top">
                <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{actions(k, v)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MiniBtn({ title, onClick, children }: { title: string; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-6 min-w-6 items-center justify-center rounded px-1 font-mono text-[11px] text-content-subtle hover:bg-surface-raised hover:text-brand-700 dark:hover:text-brand-300"
    >
      {children}
    </button>
  )
}

export function IconBtn({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string
  onClick(): void
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
        active
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
          : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

export function copy(text: string) {
  try {
    void navigator.clipboard?.writeText(text)
  } catch {
    // clipboard unavailable — ignore
  }
}

export function LokiBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-subtle">
      <LokiIcon size={11} /> Loki
    </span>
  )
}

/* ─────────── icons ─────────── */

const I = (props: { children: ReactNode; size?: number; sw?: number }) => (
  <svg
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={props.sw ?? 2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className="shrink-0"
  >
    {props.children}
  </svg>
)

export const IconX = () => <I sw={2.25}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></I>
export const IconCopy = () => <I size={12}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></I>
export const IconBraces = () => <I size={12}><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" /><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></I>
export const IconFilterIn = () => <I size={12}><path d="M22 3H2l8 9.46V19l4 2v-8.54z" /></I>
export const IconFilterOut = () => <I size={12}><path d="M22 3H2l8 9.46V19l4 2v-8.54z" /><path d="m2 2 20 20" /></I>
export const IconArrowUpRight = () => <I size={12}><path d="M7 17 17 7" /><path d="M7 7h10v10" /></I>
export const IconPlay = () => <I size={13} sw={2.5}><path d="m6 4 14 8-14 8z" /></I>
export const IconPause = () => <I size={13} sw={2.5}><path d="M8 5v14M16 5v14" /></I>
export const IconTag = () => <I><path d="M12.6 2.6 21 11l-9.4 9.4a2 2 0 0 1-2.8 0L2.6 14.2a2 2 0 0 1 0-2.8L12 2.6Z" /><circle cx="8" cy="8" r="1.5" /></I>
export const IconHistory = () => <I><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></I>
export const IconStar = ({ filled = false }: { filled?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
    <path d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" />
  </svg>
)
export const IconSearch = () => <I><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></I>
export const IconClock = () => <I size={12}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>
export const IconWrap = () => <I><path d="M3 6h18" /><path d="M3 12h13a3 3 0 0 1 0 6h-4" /><path d="m14 16-2 2 2 2" /><path d="M3 18h6" /></I>
export const IconLabels = () => <I><path d="M4 6h16M4 12h10M4 18h6" /></I>
export const IconExpand = () => <I><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></I>
export const IconCollapse = () => <I><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></I>
export const IconDownload = () => <I><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></I>
export const IconChevron = () => <I size={12}><path d="m6 9 6 6 6-6" /></I>
export const IconTrash = () => <I size={12}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></I>
export const IconSidebar = () => <I><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></I>
export const IconReset = () => <I size={12}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></I>
export const IconBolt = () => <I size={12} sw={2.25}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></I>
