import { useState } from 'react'
import { Card, CardBody, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useSessions } from '../data/observability.ts'
import { LoadingCard, SourceError } from './states.tsx'

export function Sessions() {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const q = useSessions({ hasErrors: errorsOnly })

  if (q.isLoading) return <LoadingCard label="Loading sessions…" />
  if (q.isError) return <SourceError tool="PostHog" error={q.error} onRetry={() => q.refetch()} />
  const list = q.data ?? []
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-content-muted">{list.length} sessions</span>
        <label className="ml-2 inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-xs">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
            className="h-3 w-3"
          />
          errors only
        </label>
      </div>
      {list.length === 0 ? (
        <EmptyState title="No sessions" />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {list.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-[11px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                    {(s.person.name ?? s.person.distinct_id).slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-content">
                        {s.person.name ?? s.person.distinct_id}
                      </span>
                      {s.country ? <StatusBadge kind="info">{s.country}</StatusBadge> : null}
                      {s.device ? (
                        <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                          {s.device}
                        </span>
                      ) : null}
                      {s.recording_available ? <StatusBadge kind="info">replay</StatusBadge> : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-3 text-[11px] text-content-muted">
                      <span>{formatDuration(s.duration_s)}</span>
                      <span>· {s.pageview_count} pages</span>
                      <span>· {s.click_count} clicks</span>
                      {s.rage_click_count ? <span className="text-rose-700">· {s.rage_click_count} rage</span> : null}
                      {s.console_error_count ? <span className="text-rose-700">· {s.console_error_count} errors</span> : null}
                      <span className="ml-auto">{formatRelative(s.start_time)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
