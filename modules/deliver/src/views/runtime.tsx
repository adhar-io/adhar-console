import { useEffect, useMemo, useState } from 'react'
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
import type { falco } from '@adhar-console/api-clients'
import { useFalcoEvents, useFalcoRules, useToggleFalcoRule } from '../data/delivery.ts'

const PRIORITIES: falco.FalcoPriority[] = [
  'Emergency',
  'Alert',
  'Critical',
  'Error',
  'Warning',
  'Notice',
  'Informational',
  'Debug',
]

const PRIORITY_TONE: Record<falco.FalcoPriority, 'failed' | 'degraded' | 'progressing' | 'paused' | 'info' | 'unknown'> = {
  Emergency: 'failed',
  Alert: 'failed',
  Critical: 'failed',
  Error: 'degraded',
  Warning: 'progressing',
  Notice: 'info',
  Informational: 'unknown',
  Debug: 'unknown',
}

const WINDOWS = [
  { label: '1h', ms: 1 * 3600 * 1000 },
  { label: '6h', ms: 6 * 3600 * 1000 },
  { label: '24h', ms: 24 * 3600 * 1000 },
  { label: '7d', ms: 7 * 24 * 3600 * 1000 },
]

/**
 * Falco runtime security feed — events tab + rule library tab.
 *
 * Events: live tail filterable by priority and time window. Click an event
 * to open the detail drawer with the full output, MITRE tags, and the
 * matched rule.
 *
 * Rules: enable / disable per-rule with a toggle. 24h hit counts surface
 * which rules are noisiest.
 */
export function Runtime() {
  const [tab, setTab] = useState<'events' | 'rules'>('events')

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
        <TabBtn on={tab === 'events'} onClick={() => setTab('events')}>
          Events
        </TabBtn>
        <TabBtn on={tab === 'rules'} onClick={() => setTab('rules')}>
          Rules
        </TabBtn>
      </div>
      {tab === 'events' ? <Events /> : <Rules />}
    </div>
  )
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        on
          ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
          : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
      }
    >
      {children}
    </button>
  )
}

/* ─────────── events ─────────── */

function Events() {
  const [priority, setPriority] = useState<falco.FalcoPriority | 'all'>('all')
  const [windowMs, setWindowMs] = useState<number>(24 * 3600 * 1000)
  const [openId, setOpenId] = useState<string | null>(null)

  const q = useFalcoEvents({
    priority: priority === 'all' ? undefined : priority,
    sinceMs: windowMs,
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Tailing Falco feed…
      </div>
    )
  }
  if (q.isError) {
    return <EmptyState title="Couldn't reach Falco" />
  }

  const list = q.data ?? []
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const e of list) out[e.priority] = (out[e.priority] ?? 0) + 1
    return out
  }, [list])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PriorityFilter value={priority} onChange={setPriority} counts={counts} total={list.length} />
        <WindowSelect value={windowMs} onChange={setWindowMs} />
      </div>

      {list.length === 0 ? (
        <EmptyState title="Nothing to investigate 🎉" description="No events in the selected window." />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {list.map((e) => (
                <EventRow key={e.id} event={e} onOpen={() => setOpenId(e.id)} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {openId ? (
        <EventDetail event={list.find((e) => e.id === openId)!} onClose={() => setOpenId(null)} />
      ) : null}
    </div>
  )
}

function PriorityFilter({
  value,
  onChange,
  counts,
  total,
}: {
  value: falco.FalcoPriority | 'all'
  onChange(v: falco.FalcoPriority | 'all'): void
  counts: Record<string, number>
  total: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
      <PriBtn on={value === 'all'} onClick={() => onChange('all')}>
        All
        <span className="ml-1 font-mono text-[10px] tabular-nums opacity-60">{total}</span>
      </PriBtn>
      {PRIORITIES.filter((p) => counts[p] > 0).map((p) => (
        <PriBtn key={p} on={value === p} onClick={() => onChange(p)}>
          {p}
          <span className="ml-1 font-mono text-[10px] tabular-nums opacity-60">{counts[p]}</span>
        </PriBtn>
      ))}
    </div>
  )
}

function PriBtn({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        on
          ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700'
          : 'rounded-md px-2.5 py-1 text-[11px] text-content-muted hover:bg-surface-sunken'
      }
    >
      {children}
    </button>
  )
}

function WindowSelect({ value, onChange }: { value: number; onChange(v: number): void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
      {WINDOWS.map((w) => (
        <button
          key={w.label}
          type="button"
          onClick={() => onChange(w.ms)}
          className={
            value === w.ms
              ? 'rounded-md bg-brand-50 px-2 py-1 text-[11px] font-semibold text-brand-700'
              : 'rounded-md px-2 py-1 text-[11px] text-content-muted hover:bg-surface-sunken'
          }
        >
          {w.label}
        </button>
      ))}
    </div>
  )
}

function EventRow({ event: e, onOpen }: { event: falco.FalcoEvent; onOpen(): void }) {
  const ns = e.output_fields?.['k8s.ns.name']
  const pod = e.output_fields?.['k8s.pod.name']
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full px-5 py-3 text-left transition-colors hover:bg-brand-50/40"
      >
        <div className="flex items-center gap-2">
          <StatusBadge kind={PRIORITY_TONE[e.priority]}>{e.priority.toLowerCase()}</StatusBadge>
          <span className="truncate text-sm font-semibold text-content">{e.rule}</span>
          <span className="ml-auto shrink-0 text-[11px] text-content-muted">
            {formatRelative(e.timestamp)}
          </span>
        </div>
        <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
          {e.output}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] font-mono text-content-subtle">
          {ns ? <span className="rounded bg-surface-sunken px-1.5 py-0.5">{ns}</span> : null}
          {pod ? <span className="rounded bg-surface-sunken px-1.5 py-0.5">{pod}</span> : null}
          {e.tags?.map((t) => (
            <span key={t} className="rounded-full bg-brand-50 px-1.5 py-0.5 text-brand-700">
              {t}
            </span>
          ))}
        </div>
      </button>
    </li>
  )
}

function EventDetail({ event: e, onClose }: { event: falco.FalcoEvent; onClose(): void }) {
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusBadge kind={PRIORITY_TONE[e.priority]}>{e.priority.toLowerCase()}</StatusBadge>
              <span className="text-[11px] text-content-subtle">{e.source}</span>
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">
              {e.rule}
            </h2>
            <div className="mt-1 text-[11px] text-content-muted">
              {formatRelative(e.timestamp)}
              {e.hostname ? ` · ${e.hostname}` : ''}
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
                Output
              </div>
            </CardHeader>
            <CardBody>
              <pre className="whitespace-pre-wrap rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                {e.output}
              </pre>
            </CardBody>
          </Card>

          {e.output_fields && Object.keys(e.output_fields).length ? (
            <Card>
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                  Output fields
                </div>
              </CardHeader>
              <CardBody>
                <table className="w-full text-[11px]">
                  <tbody>
                    {Object.entries(e.output_fields).map(([k, v]) => (
                      <tr key={k} className="border-b border-edge-subtle last:border-0">
                        <td className="py-1.5 pr-3 font-mono text-content-subtle">{k}</td>
                        <td className="py-1.5 font-mono text-content">{String(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          ) : null}

          {e.tags?.length ? (
            <Card>
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                  Tags
                </div>
              </CardHeader>
              <CardBody>
                <div className="flex flex-wrap gap-1">
                  {e.tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ─────────── rules ─────────── */

function Rules() {
  const q = useFalcoRules()
  const toggle = useToggleFalcoRule()

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading rules…
      </div>
    )
  }
  const list = q.data ?? []
  const enabled = list.filter((r) => r.enabled).length

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-content-muted">
        {list.length} rules · {enabled} enabled
      </div>
      <Card>
        <CardBody className="p-0!">
          <ul className="divide-y divide-edge-subtle">
            {list.map((r) => (
              <li key={r.name} className="flex items-center gap-3 px-5 py-3">
                <StatusBadge kind={PRIORITY_TONE[r.priority]}>{r.priority.toLowerCase()}</StatusBadge>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-content">{r.name}</span>
                    {r.hits_24h ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                        {r.hits_24h} hits 24h
                      </span>
                    ) : null}
                  </div>
                  {r.description ? (
                    <div className="mt-0.5 truncate text-[11px] text-content-muted">{r.description}</div>
                  ) : null}
                  {r.tags?.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9px] font-mono text-content-subtle"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <Toggle
                  enabled={r.enabled}
                  onChange={(en) => toggle.mutate({ name: r.name, enabled: en })}
                />
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange(v: boolean): void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        enabled ? 'bg-brand-500' : 'bg-edge-default'
      }`}
      role="switch"
      aria-checked={enabled}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          enabled ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
