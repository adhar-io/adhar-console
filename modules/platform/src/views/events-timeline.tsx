import { useMemo } from 'react'
import { useLiveList } from '../data/live.ts'
import { GVRS } from '../data/gvr.ts'
import { age } from '../data/format.ts'

/**
 * Vertical, live-watched timeline of Kubernetes Events. Scopes to a single
 * involved object when `name`/`kind` are given (via a fieldSelector), otherwise
 * shows every event in the namespace. Newest-first, with a "● live" indicator
 * driven by the underlying watch status.
 */

interface TimelineEvent {
  type?: 'Normal' | 'Warning' | string
  reason?: string
  message?: string
  count?: number
  lastTimestamp?: string
  eventTime?: string
  involvedObject?: { kind?: string; name?: string; namespace?: string }
  metadata: { uid?: string; name?: string; namespace?: string; creationTimestamp?: string }
}

function eventTime(e: TimelineEvent): number {
  const iso = e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp
  return iso ? new Date(iso).getTime() : 0
}

function eventIso(e: TimelineEvent): string | undefined {
  return e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp
}

export function EventsTimeline({ namespace, name, kind }: { namespace?: string; name?: string; kind?: string }) {
  const fieldSelector = useMemo(() => {
    const parts: string[] = []
    if (name) parts.push(`involvedObject.name=${name}`)
    if (kind) parts.push(`involvedObject.kind=${kind}`)
    return parts.length ? parts.join(',') : undefined
  }, [name, kind])

  const live = useLiveList<TimelineEvent>(GVRS.events, { namespace, fieldSelector })

  const events = useMemo(() => {
    return (live.data ?? []).slice().sort((a, b) => eventTime(b) - eventTime(a))
  }, [live.data])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-content">
          Events
          <span className="ml-2 text-xs font-normal text-content-muted">{events.length}</span>
        </div>
        <LiveDot status={live.status} />
      </div>

      {live.isLoading && events.length === 0 ? (
        <div className="py-8 text-center text-sm text-content-muted">Loading events…</div>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-edge-default py-8 text-center text-sm text-content-subtle">
          No events in this scope
        </div>
      ) : (
        <ol className="relative ml-1.5 space-y-4 border-l border-edge-default pl-5">
          {events.map((e, i) => (
            <TimelineRow key={e.metadata?.uid ?? `${e.metadata?.namespace}/${e.metadata?.name}/${i}`} event={e} />
          ))}
        </ol>
      )}
    </div>
  )
}

function TimelineRow({ event: e }: { event: TimelineEvent }) {
  const warning = e.type === 'Warning'
  const obj = e.involvedObject
  const count = e.count ?? 1
  return (
    <li className="relative">
      <span
        className={cnDot(warning)}
        aria-hidden
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-content">{e.reason ?? '—'}</span>
            {count > 1 ? (
              <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted">
                ×{count}
              </span>
            ) : null}
          </div>
          {e.message ? <div className="mt-0.5 text-sm text-content-muted">{e.message}</div> : null}
          {obj?.kind || obj?.name ? (
            <div className="mt-1 text-[11px] text-content-subtle">
              <span className="font-mono text-content-muted">{obj?.kind || '—'}</span>
              {' / '}
              {obj?.name || '—'}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 whitespace-nowrap text-xs text-content-subtle" title={eventIso(e)}>
          {age(eventIso(e))}
        </div>
      </div>
    </li>
  )
}

function cnDot(warning: boolean): string {
  const base = 'absolute -left-[27px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface-app'
  return warning ? `${base} bg-amber-500` : `${base} bg-emerald-500`
}

function LiveDot({ status }: { status: string }) {
  const live = status === 'live'
  const color = live ? 'text-emerald-600' : status === 'error' ? 'text-rose-600' : 'text-amber-600'
  const label = live ? 'live' : status
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : status === 'error' ? 'bg-rose-500' : 'bg-amber-500'}`} />
      {label}
    </span>
  )
}
