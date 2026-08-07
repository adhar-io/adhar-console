import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { lgtm } from '@adhar-console/api-clients'
import {
  useServices,
  useTrace,
  useTraces,
  type SpanDetail,
} from '../data/observability.ts'

/**
 * Traces — Tempo search with a span-timeline drawer.
 *
 * Filter by service, status (errors only), and minimum duration. Trace
 * rows show a duration badge, span count, and a tiny duration bar so the
 * slowest traces visually pop.
 */
export function Traces() {
  const [service, setService] = useState<string>('')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [minMs, setMinMs] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)

  const services = useServices()
  const q = useTraces({
    service: service || undefined,
    minDurationMs: minMs > 0 ? minMs : undefined,
    status: errorsOnly ? 'error' : undefined,
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Searching Tempo…
      </div>
    )
  }

  const list = q.data ?? []
  const peak = Math.max(...list.map((t) => t.durationMs), 1)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-white p-2 shadow-sm">
        <select
          value={service}
          onChange={(e) => setService(e.target.value)}
          className="rounded-md border border-edge-default bg-white px-2 py-1 text-xs"
        >
          <option value="">all services</option>
          {(services.data ?? []).map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>

        <label className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-white px-2 py-1 text-xs">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
            className="h-3 w-3"
          />
          errors only
        </label>

        <label className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-white px-2 py-1 text-xs">
          <span className="text-content-subtle">min duration</span>
          <input
            type="number"
            value={minMs}
            min={0}
            step={50}
            onChange={(e) => setMinMs(Math.max(0, Number(e.target.value)))}
            className="w-20 rounded border border-edge-default bg-white px-1 py-0.5 font-mono text-[11px] focus:border-brand-400 focus:outline-none"
          />
          <span className="text-content-subtle">ms</span>
        </label>

        <span className="ml-auto text-[11px] text-content-muted">{list.length} traces</span>
      </div>

      {list.length === 0 ? (
        <EmptyState title="No traces" description="Adjust the filters to widen the search." />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {list.map((t) => (
                <TraceRow key={t.traceID} trace={t} peakMs={peak} onOpen={() => setOpenId(t.traceID)} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {openId ? (
        <TraceDetail traceID={openId} list={list} onClose={() => setOpenId(null)} />
      ) : null}
    </div>
  )
}

function TraceRow({
  trace: t,
  peakMs,
  onOpen,
}: {
  trace: lgtm.Trace
  peakMs: number
  onOpen(): void
}) {
  const tone = t.status === 'error' ? 'failed' : 'healthy'
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-brand-50/40"
      >
        <code className="font-mono text-[10px] text-content-muted">{t.traceID.slice(0, 12)}</code>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] font-semibold text-content">
              {t.rootServiceName}
            </span>
            <span className="truncate font-mono text-sm text-content">{t.rootTraceName}</span>
            <StatusBadge kind={tone}>{t.status ?? 'ok'}</StatusBadge>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div
              className={`h-full ${t.status === 'error' ? 'bg-rose-500' : 'bg-brand-500'}`}
              style={{ width: `${(t.durationMs / peakMs) * 100}%` }}
            />
          </div>
        </div>
        <div className="flex flex-col items-end text-[11px]">
          <span className="font-mono tabular-nums text-content">{t.durationMs.toFixed(0)} ms</span>
          <span className="text-content-subtle">{t.spanCount} spans</span>
          <span className="text-content-subtle">{formatRelative(new Date(Number(t.startTimeUnixNano) / 1e6).toISOString())}</span>
        </div>
      </button>
    </li>
  )
}

/* ─────────── trace detail drawer ─────────── */

function TraceDetail({
  traceID,
  list,
  onClose,
}: {
  traceID: string
  list: lgtm.Trace[]
  onClose(): void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)
  const meta = list.find((t) => t.traceID === traceID)
  const q = useTrace(traceID)
  const spans = q.data ?? []
  const totalMs = Math.max(meta?.durationMs ?? 0, ...spans.map((s) => s.startTimeMs + s.durationMs), 1)
  const traceStartMs = meta ? Number(meta.startTimeUnixNano) / 1e6 : 0
  const selected = spans.find((s) => s.spanID === selectedSpanId) ?? null

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <code className="font-mono text-[10px] text-content-muted">{traceID}</code>
              {meta?.status === 'error' ? <StatusBadge kind="failed">error</StatusBadge> : null}
            </div>
            <h2 className="mt-1 truncate font-mono text-base font-semibold text-content">
              {meta?.rootServiceName} · {meta?.rootTraceName}
            </h2>
            <div className="mt-1 text-[11px] text-content-muted">
              {meta?.spanCount} spans · {meta?.durationMs.toFixed(0)} ms
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                Span timeline
              </div>
              <div className="text-[11px] text-content-subtle">
                {selected ? 'Click a span to inspect' : 'Total'} {totalMs.toFixed(0)} ms
              </div>
            </CardHeader>
            <CardBody>
              {q.isLoading ? (
                <div className="flex h-40 items-center justify-center"><Spinner size={12} /></div>
              ) : (
                <SpanTimeline
                  spans={spans}
                  totalMs={totalMs}
                  selectedId={selectedSpanId}
                  onSelect={(id) => setSelectedSpanId((cur) => (cur === id ? null : id))}
                />
              )}
            </CardBody>
          </Card>

          {selected ? (
            <SpanDetailPanel
              span={selected}
              traceStartMs={traceStartMs}
              onClose={() => setSelectedSpanId(null)}
            />
          ) : (
            <p className="px-1 text-[11px] text-content-subtle">
              Select a span in the waterfall to view its attributes, status, and events.
            </p>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function SpanTimeline({
  spans,
  totalMs,
  selectedId,
  onSelect,
}: {
  spans: SpanDetail[]
  totalMs: number
  selectedId: string | null
  onSelect(id: string): void
}) {
  if (spans.length === 0) {
    return <EmptyState compact title="No spans" />
  }
  // Index by service for color stability.
  const services = Array.from(new Set(spans.map((s) => s.serviceName)))
  const colorFor = (svc: string) => SVC_COLORS[services.indexOf(svc) % SVC_COLORS.length]

  // Determine depth (how many ancestors).
  const byId = new Map(spans.map((s) => [s.spanID, s]))
  const depthOf = (s: SpanDetail): number => {
    let d = 0
    let cur: SpanDetail | undefined = s
    while (cur?.parentSpanID) {
      const parent = byId.get(cur.parentSpanID)
      if (!parent) break
      d++
      cur = parent
    }
    return d
  }

  return (
    <div className="space-y-0.5">
      {spans.map((s) => {
        const left = (s.startTimeMs / totalMs) * 100
        const width = Math.max(0.5, (s.durationMs / totalMs) * 100)
        const depth = depthOf(s)
        const color = colorFor(s.serviceName)
        const error = s.status === 'error'
        const active = s.spanID === selectedId
        return (
          <button
            key={s.spanID}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(s.spanID)}
            className={`grid w-full grid-cols-[260px_1fr_70px] items-center gap-3 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors ${
              active ? 'bg-brand-50 ring-1 ring-brand-300' : 'hover:bg-surface-sunken/70'
            }`}
          >
            <div
              className="flex min-w-0 items-center gap-1.5"
              style={{ paddingLeft: depth * 12 }}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[10px] text-content-subtle">
                {s.serviceName}
              </span>
              <span className={`truncate font-mono ${active ? 'font-semibold text-brand-800' : 'text-content'}`}>
                {s.operationName}
              </span>
              {error ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" /> : null}
            </div>
            <div className={`relative h-4 rounded-full ${active ? 'bg-brand-100/70' : 'bg-surface-sunken/60'}`}>
              <div
                className={`absolute inset-y-0 rounded-full ${error ? 'bg-rose-500' : ''} ${active ? 'ring-1 ring-inset ring-brand-400' : ''}`}
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  backgroundColor: error ? undefined : color,
                }}
              />
            </div>
            <span className="text-right font-mono tabular-nums text-content-muted">
              {s.durationMs.toFixed(0)} ms
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ─────────── span detail inspector ─────────── */

function SpanDetailPanel({
  span,
  traceStartMs,
  onClose,
}: {
  span: SpanDetail
  traceStartMs: number
  onClose(): void
}) {
  const error = span.status === 'error'
  const attributes = useMemo(() => Object.entries(span.tags ?? {}).sort(), [span.tags])
  const spanStartMs = traceStartMs + span.startTimeMs

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
            Span detail
          </div>
          <div className="mt-0.5 truncate font-mono text-[13px] text-content">{span.operationName}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Deselect span"
          className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
        >
          <IconClose />
        </button>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* summary grid */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-4">
          <Meta label="Service" value={<span className="font-mono">{span.serviceName}</span>} />
          <Meta label="Duration" value={<span className="font-mono tabular-nums">{span.durationMs.toFixed(0)} ms</span>} />
          <Meta label="Start" value={<span className="font-mono tabular-nums">+{span.startTimeMs.toFixed(0)} ms</span>} />
          <Meta
            label="Status"
            value={<StatusBadge kind={error ? 'failed' : 'healthy'}>{span.status ?? 'ok'}</StatusBadge>}
          />
        </dl>

        {span.statusMessage ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800">
            {span.statusMessage}
          </div>
        ) : null}

        {/* attributes */}
        <section>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            Attributes
          </div>
          {attributes.length === 0 ? (
            <p className="text-[11px] text-content-subtle">No attributes.</p>
          ) : (
            <div className="overflow-hidden rounded-md border border-edge-subtle">
              <table className="w-full text-left text-[11px]">
                <tbody className="divide-y divide-edge-subtle">
                  {attributes.map(([k, v]) => (
                    <tr key={k} className="align-top hover:bg-surface-sunken/40">
                      <td className="w-1/3 whitespace-nowrap px-3 py-1.5 font-mono text-content-muted">{k}</td>
                      <td className="break-all px-3 py-1.5 font-mono text-content">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* events */}
        <section>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            Events {span.events?.length ? `(${span.events.length})` : ''}
          </div>
          {!span.events?.length ? (
            <p className="text-[11px] text-content-subtle">No span events.</p>
          ) : (
            <ul className="space-y-1.5">
              {span.events.map((ev, i) => {
                const evError = ev.name === 'exception' || ev.name.endsWith('.error')
                return (
                  <li key={i} className="flex items-start gap-2 text-[11px]">
                    <span
                      className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${evError ? 'bg-rose-500' : 'bg-brand-400'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono tabular-nums text-content-subtle">{fmtClock(spanStartMs + ev.timeMs)}</span>
                        <span className="text-[10px] tabular-nums text-content-subtle">+{ev.timeMs} ms</span>
                        <span className={`font-mono ${evError ? 'font-semibold text-rose-700' : 'text-content'}`}>{ev.name}</span>
                      </div>
                      {ev.attributes ? (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {Object.entries(ev.attributes).map(([k, v]) => (
                            <span
                              key={k}
                              className="inline-flex items-center rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-subtle"
                            >
                              <span className="opacity-60">{k}=</span>
                              {v}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </CardBody>
    </Card>
  )
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  )
}

function fmtClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

const SVC_COLORS = [
  'var(--color-brand-500)',
  'var(--color-emerald-500)',
  'var(--color-amber-500)',
  'var(--color-violet-500)',
  'var(--color-sky-500)',
  'var(--color-rose-500)',
]

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
