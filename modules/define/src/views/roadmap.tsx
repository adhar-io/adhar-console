import { useMemo } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import type { plane } from '@adhar-console/api-clients'
import { priorityKind, useIssues, useStates } from '../data/plane.ts'

/**
 * Roadmap built from issues with a `target_date`. Groups by quarter (or
 * "Past due" / "No date") so the operator sees what's landing when. Pure
 * derivation from `useIssues({has_target_date: true})` — no separate
 * roadmap entity in Plane.
 */
export function Roadmap({ projectId }: { projectId?: string }) {
  // ⚠️ All hooks must run on every render — keep them above early returns or
  // React throws "Rendered fewer hooks than expected" the moment a query
  // transitions from loading → success.
  const issues = useIssues(projectId, { has_target_date: true })
  const states = useStates(projectId)
  const stateMap = useMemo(
    () => new Map((states.data ?? []).map((s) => [s.id, s])),
    [states.data],
  )
  const all = issues.data ?? []
  const grouped = useMemo(() => groupByQuarter(all), [all])
  const order = useMemo(() => sortGroupKeys(Object.keys(grouped)), [grouped])

  if (!projectId) return <EmptyState title="Pick a project" />
  if (issues.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading roadmap…
      </div>
    )
  }
  if (issues.isError) {
    return (
      <EmptyState
        title="Couldn't reach Plane"
        description={issues.error instanceof Error ? issues.error.message : 'Unknown error.'}
      />
    )
  }
  if (!all.length) {
    return (
      <EmptyState
        title="No dated issues"
        description="Issues with a target date show up here grouped by quarter."
      />
    )
  }

  return (
    <div className="space-y-6">
      {order.map((key) => {
        const items = grouped[key]
        return (
          <Card key={key}>
            <CardHeader>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.06em] text-brand-700">
                    {humanQuarter(key)}
                  </div>
                  <h3 className="mt-0.5 text-base font-semibold text-content">
                    {items.length} {items.length === 1 ? 'issue' : 'issues'} ·{' '}
                    {items.filter((i) => i.completed_at).length} done
                  </h3>
                </div>
                <ProgressPill items={items} />
              </div>
            </CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-edge-subtle">
                {items
                  .slice()
                  .sort((a, b) =>
                    new Date(a.target_date ?? 0).getTime() -
                    new Date(b.target_date ?? 0).getTime(),
                  )
                  .map((iss) => {
                    const st = stateMap.get(iss.state)
                    const overdue =
                      iss.target_date && !iss.completed_at && new Date(iss.target_date) < new Date()
                    return (
                      <li
                        key={iss.id}
                        className="grid grid-cols-[110px_1fr_auto] items-start gap-3 px-5 py-3 transition-colors hover:bg-brand-50/30 sm:grid-cols-[140px_1fr_auto]"
                      >
                        <div>
                          <div
                            className={
                              overdue
                                ? 'text-sm font-semibold text-rose-700'
                                : 'text-sm font-medium text-content'
                            }
                          >
                            {fmtDate(iss.target_date)}
                          </div>
                          <div className="text-[11px] text-content-subtle">
                            {overdue ? 'overdue' : daysFromNow(iss.target_date)}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-content">
                              {iss.name}
                            </span>
                            {iss.completed_at ? (
                              <StatusBadge kind="healthy" dot={false}>
                                done
                              </StatusBadge>
                            ) : null}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
                            {st ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span
                                  className="h-1.5 w-1.5 rounded-full"
                                  style={{ backgroundColor: st.color }}
                                />
                                {st.name}
                              </span>
                            ) : null}
                            <span>· {iss.estimate_point ?? '—'}pt</span>
                          </div>
                        </div>
                        <StatusBadge kind={priorityKind(iss.priority)} dot={false}>
                          {iss.priority}
                        </StatusBadge>
                      </li>
                    )
                  })}
              </ul>
            </CardBody>
          </Card>
        )
      })}
    </div>
  )
}

function ProgressPill({ items }: { items: plane.Issue[] }) {
  const total = items.length
  const done = items.filter((i) => i.completed_at).length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full bg-brand-500 transition-[width] duration-500 ease-smooth"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono tabular-nums text-content-muted">{pct}%</span>
    </div>
  )
}

function groupByQuarter(items: plane.Issue[]): Record<string, plane.Issue[]> {
  const out: Record<string, plane.Issue[]> = {}
  for (const i of items) {
    const key = i.target_date ? quarterKey(new Date(i.target_date)) : 'no-date'
    if (new Date(i.target_date ?? 0) < new Date() && !i.completed_at) {
      ;(out['past-due'] ??= []).push(i)
      continue
    }
    ;(out[key] ??= []).push(i)
  }
  return out
}

function quarterKey(d: Date) {
  const q = Math.floor(d.getMonth() / 3) + 1
  return `${d.getFullYear()}-Q${q}`
}

function humanQuarter(k: string): string {
  if (k === 'past-due') return 'Past due'
  if (k === 'no-date') return 'No date'
  return `${k.slice(-2)} ${k.slice(0, 4)}`
}

function sortGroupKeys(keys: string[]): string[] {
  return keys.slice().sort((a, b) => {
    if (a === 'past-due') return -1
    if (b === 'past-due') return 1
    if (a === 'no-date') return 1
    if (b === 'no-date') return -1
    return a.localeCompare(b)
  })
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function daysFromNow(iso?: string | null): string {
  if (!iso) return ''
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return 'today'
  return `in ${days}d`
}
