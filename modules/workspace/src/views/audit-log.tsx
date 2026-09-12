import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EmptyState, StatusBadge, useToast } from '@adhar-console/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar-console/utils'
import {
  fetchAllAuditEvents,
  isDbUnavailable,
  useAuditEvents,
  useAuditFacets,
  type AuditParams,
  type WsAuditEvent,
} from '../data/client.ts'
import { PrimaryButton, SecondaryButton, StatTile, ViewShell } from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

/**
 * Audit log — built for millions of events.
 *
 * Every filter, the free-text search, the ordering and the total count run
 * in Postgres (`documents` JSONB, see `queryDocuments`), so a page is always
 * one bounded query. The UI adds: keyset-style paging with page-size choice
 * and jump-to-page, a debounced search, facet menus (actions, actors, actor /
 * target types) from a server sample, quick time ranges + absolute bounds,
 * one-click "filter by this" from any row, a detail drawer with the raw
 * event and copy-as-JSON, live tail (auto-refresh newest), and CSV / JSON
 * export of the page or the whole filtered set (bounded).
 */

const PAGE_SIZES = [25, 50, 100, 200]
const QUICK_RANGES: Array<{ id: string; label: string; ms: number | null }> = [
  { id: 'any', label: 'Any time', ms: null },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '24h', label: 'Last 24h', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60_000 },
  { id: 'custom', label: 'Custom…', ms: null },
]

interface Filters {
  q: string
  outcome: 'all' | 'success' | 'failure'
  action: string
  actor: string
  actorType: '' | 'user' | 'token' | 'system'
  targetType: string
  range: string
  from: string
  to: string
  sort: 'asc' | 'desc'
}

const EMPTY: Filters = { q: '', outcome: 'all', action: '', actor: '', actorType: '', targetType: '', range: 'any', from: '', to: '', sort: 'desc' }

function toParams(f: Filters, limit: number, offset: number): AuditParams {
  const quick = QUICK_RANGES.find((r) => r.id === f.range)
  let from: string | undefined
  let to: string | undefined
  if (f.range === 'custom') {
    from = f.from ? new Date(f.from).toISOString() : undefined
    to = f.to ? new Date(f.to).toISOString() : undefined
  } else if (quick?.ms) {
    from = new Date(Date.now() - quick.ms).toISOString()
  }
  return {
    limit,
    offset,
    q: f.q.trim() || undefined,
    outcome: f.outcome === 'all' ? undefined : f.outcome,
    action: f.action || undefined,
    actor: f.actor || undefined,
    actorType: f.actorType || undefined,
    targetType: f.targetType || undefined,
    from,
    to,
    sort: f.sort,
  }
}

export function AuditLog() {
  const toast = useToast()
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [debouncedQ, setDebouncedQ] = useState('')
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(0)
  const [live, setLive] = useState(false)
  const [selected, setSelected] = useState<WsAuditEvent | null>(null)
  const [exporting, setExporting] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Debounce the free-text search so every keystroke doesn't hit Postgres.
  useEffect(() => {
    const id = globalThis.setTimeout(() => setDebouncedQ(filters.q), 300)
    return () => globalThis.clearTimeout(id)
  }, [filters.q])

  const params = useMemo(() => toParams({ ...filters, q: debouncedQ }, pageSize, page * pageSize), [filters, debouncedQ, pageSize, page])
  const q = useAuditEvents(params)
  const facets = useAuditFacets()

  // Live tail — poll the current page while enabled (newest-first only).
  useEffect(() => {
    if (!live) return
    const id = globalThis.setInterval(() => q.refetch(), 5000)
    return () => globalThis.clearInterval(id)
  }, [live, q])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  const patch = (p: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...p }))
    setPage(0)
  }

  const data = q.data
  const events = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const failedOnPage = events.filter((e) => e.outcome !== 'success').length
  const activeFilters = countActive(filters)

  const exportRows = (rows: WsAuditEvent[], kind: 'csv' | 'json', name: string) => {
    let body: string
    if (kind === 'json') body = JSON.stringify(rows, null, 2)
    else {
      const head = ['at', 'actor', 'actorType', 'actorId', 'action', 'targetType', 'target', 'targetId', 'outcome', 'ip', 'userAgent']
      const esc = (c: unknown) => `"${String(c ?? '').replace(/"/g, '""')}"`
      body = [head.join(','), ...rows.map((e) => [e.at, e.actor.label, e.actor.type, e.actor.id, e.action, e.target.type, e.target.label, e.target.id, e.outcome, e.ip ?? '', e.userAgent ?? ''].map(esc).join(','))].join('\n')
    }
    const url = URL.createObjectURL(new Blob([body], { type: kind === 'json' ? 'application/json' : 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.${kind}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportAll = async (kind: 'csv' | 'json') => {
    setExporting(true)
    const id = toast.loading(`Exporting ${total.toLocaleString()} events…`)
    try {
      const rows = await fetchAllAuditEvents(toParams({ ...filters, q: debouncedQ }, 500, 0))
      exportRows(rows, kind, `audit-log-${new Date().toISOString().slice(0, 10)}`)
      toast.success(`Exported ${rows.length.toLocaleString()} events`, { id, description: rows.length < total ? 'Capped at 50,000 — narrow the filters for a full set.' : undefined })
    } catch (e) {
      toast.error('Export failed', { id, description: (e as Error)?.message })
    } finally {
      setExporting(false)
    }
  }

  return (
    <ViewShell
      title="Audit log"
      description="Every privileged workspace mutation, persisted as workspace.audit documents. Filters, search and paging run in the database, so this stays fast at any volume."
      required={['admin', 'security', 'owner']}
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={live}
            onClick={() => {
              setLive((v) => !v)
              if (!live) {
                patch({ sort: 'desc' })
              }
            }}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition-colors',
              live ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', live ? 'animate-pulse bg-emerald-500' : 'bg-slate-400')} />
            Live
          </button>
          <RequirePermission perm="audit.export" required={['security', 'owner']} readOnly>
            <ExportMenu
              disabled={events.length === 0 || exporting}
              total={total}
              onPage={(k) => exportRows(events, k, `audit-log-page-${page + 1}`)}
              onAll={exportAll}
            />
          </RequirePermission>
        </div>
      }
    >
      {q.isError ? (
        <StoreErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Matching events" value={q.isLoading ? '…' : total.toLocaleString()} hint={activeFilters ? `${activeFilters} filter${activeFilters === 1 ? '' : 's'} active` : 'entire trail'} />
            <StatTile label="Failures on page" value={failedOnPage} tone={failedOnPage > 0 ? 'warn' : 'good'} />
            <StatTile label="Distinct actions" value={facets.data ? facets.data.actions.length : '…'} hint={facets.data ? `from newest ${facets.data.sampled.toLocaleString()}` : undefined} />
            <StatTile label="Page" value={`${Math.min(page + 1, pageCount)} / ${pageCount.toLocaleString()}`} hint={`${pageSize} per page`} />
          </div>

          {/* ── search + filter bar ── */}
          <section className="overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <div className="relative flex min-w-64 flex-1 items-center">
                <span className="pointer-events-none absolute left-3 text-content-subtle"><IconSearch /></span>
                <input
                  ref={searchRef}
                  value={filters.q}
                  onChange={(e) => patch({ q: e.target.value })}
                  placeholder="Search action, actor, target, id, IP…  (press / to focus)"
                  className="h-9 w-full rounded-lg border border-edge-default bg-surface-app pl-9 pr-8 text-[13px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
                />
                {filters.q ? (
                  <button type="button" onClick={() => patch({ q: '' })} aria-label="Clear search" className="absolute right-2 flex h-5 w-5 items-center justify-center rounded text-content-subtle hover:bg-surface-sunken hover:text-content"><IconX /></button>
                ) : null}
              </div>
              <Segmented
                value={filters.outcome}
                onChange={(v) => patch({ outcome: v as Filters['outcome'] })}
                options={[
                  ['all', 'All'],
                  ['success', 'Success', 'bg-emerald-500'],
                  ['failure', 'Failure', 'bg-rose-500'],
                ]}
              />
              <Select value={filters.range} onChange={(v) => patch({ range: v })} title="Time range" options={QUICK_RANGES.map((r) => [r.id, r.label])} />
              {filters.range === 'custom' ? (
                <div className="flex items-center gap-1">
                  <input type="datetime-local" value={filters.from} onChange={(e) => patch({ from: e.target.value })} className="h-9 rounded-lg border border-edge-default bg-surface-app px-2 font-mono text-[11px] text-content focus:border-brand-400 focus:outline-none" aria-label="From" />
                  <span className="text-content-subtle">→</span>
                  <input type="datetime-local" value={filters.to} onChange={(e) => patch({ to: e.target.value })} className="h-9 rounded-lg border border-edge-default bg-surface-app px-2 font-mono text-[11px] text-content focus:border-brand-400 focus:outline-none" aria-label="To" />
                </div>
              ) : null}
              <Select
                value={filters.sort}
                onChange={(v) => {
                  patch({ sort: v as Filters['sort'] })
                  if (v === 'asc') setLive(false)
                }}
                title="Sort"
                options={[['desc', 'Newest first'], ['asc', 'Oldest first']]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-edge-subtle bg-surface-sunken/50 px-3 py-2">
              <FacetSelect label="Action" value={filters.action} onChange={(v) => patch({ action: v })} options={(facets.data?.actions ?? []).map((a) => [a.value, `${a.value} · ${a.n}`])} allowPrefix />
              <FacetSelect label="Actor" value={filters.actor} onChange={(v) => patch({ actor: v })} options={(facets.data?.actors ?? []).map((a) => [a.id, `${a.label} · ${a.n}`])} />
              <FacetSelect label="Actor type" value={filters.actorType} onChange={(v) => patch({ actorType: v as Filters['actorType'] })} options={(facets.data?.actorTypes ?? []).map((a) => [a.value, `${a.value} · ${a.n}`])} />
              <FacetSelect label="Target type" value={filters.targetType} onChange={(v) => patch({ targetType: v })} options={(facets.data?.targetTypes ?? []).map((a) => [a.value, `${a.value} · ${a.n}`])} />
              {activeFilters ? (
                <button type="button" onClick={() => { setFilters(EMPTY); setPage(0) }} className="ml-auto text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                  Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
                </button>
              ) : (
                <span className="ml-auto text-[11px] text-content-subtle">Click any actor, action or target in a row to filter by it.</span>
              )}
            </div>
          </section>

          {/* ── table ── */}
          <section className="overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-surface-sunken/70 text-[11px] uppercase tracking-wider text-content-subtle">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">When</th>
                    <th className="px-3 py-2 text-left font-semibold">Actor</th>
                    <th className="px-3 py-2 text-left font-semibold">Action</th>
                    <th className="px-3 py-2 text-left font-semibold">Target</th>
                    <th className="px-3 py-2 text-left font-semibold">Outcome</th>
                    <th className="px-3 py-2 text-left font-semibold">Context</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {q.isLoading && events.length === 0 ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        {Array.from({ length: 6 }).map((__, j) => (
                          <td key={j} className="px-3 py-3"><div className="h-3 rounded bg-surface-sunken" style={{ width: `${40 + ((i * 17 + j * 23) % 50)}%` }} /></td>
                        ))}
                      </tr>
                    ))
                  ) : events.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-8">
                        <EmptyState title={activeFilters ? 'No events match' : 'No audit events yet'} description={activeFilters ? 'Loosen or clear the filters.' : 'Privileged actions (invites, role changes, team edits, token mints, deletes) show up here as they happen.'} />
                      </td>
                    </tr>
                  ) : (
                    events.map((e) => (
                      <tr key={e.id} onClick={() => setSelected(e)} className={cn('cursor-pointer transition-colors hover:bg-brand-50/40 dark:hover:bg-brand-500/5', e.outcome !== 'success' && 'bg-rose-50/30 dark:bg-rose-500/5')}>
                        <td className="whitespace-nowrap px-3 py-2 align-top">
                          <div className="font-medium text-content">{formatRelative(e.at)}</div>
                          <div className="font-mono text-[11px] text-content-subtle">{formatAbsolute(e.at)}</div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <FilterLink title={`Only ${e.actor.label}`} onClick={() => patch({ actor: e.actor.id })}>
                            <span className="font-medium text-content">{e.actor.label}</span>
                          </FilterLink>
                          <div className="text-[11px] text-content-muted">
                            <FilterLink title={`Only ${e.actor.type} actors`} onClick={() => patch({ actorType: e.actor.type })}>{e.actor.type}</FilterLink>
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <FilterLink title={`Only ${e.action}`} onClick={() => patch({ action: e.action })}>
                            <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">{e.action}</code>
                          </FilterLink>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="text-content">{e.target.label}</div>
                          <div className="text-[11px] text-content-muted">
                            <FilterLink title={`Only ${e.target.type} targets`} onClick={() => patch({ targetType: e.target.type })}>{e.target.type}</FilterLink>
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <StatusBadge kind={e.outcome === 'success' ? 'healthy' : 'failed'}>{e.outcome}</StatusBadge>
                        </td>
                        <td className="max-w-56 px-3 py-2 align-top font-mono text-[11px] text-content-muted">
                          {e.ip ? <div>{e.ip}</div> : null}
                          {e.userAgent ? <div className="truncate" title={e.userAgent}>{e.userAgent}</div> : null}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* ── pager ── */}
            <div className="flex flex-wrap items-center gap-3 border-t border-edge-subtle bg-surface-sunken/50 px-3 py-2 text-[12px] text-content-muted">
              <span>
                {total ? (
                  <>Showing <span className="font-semibold tabular-nums text-content">{(page * pageSize + 1).toLocaleString()}–{Math.min((page + 1) * pageSize, total).toLocaleString()}</span> of <span className="tabular-nums">{total.toLocaleString()}</span></>
                ) : 'Nothing to show'}
                {q.isFetching ? <span className="ml-2 text-content-subtle">· refreshing…</span> : null}
              </span>
              <Select value={String(pageSize)} onChange={(v) => { setPageSize(Number(v)); setPage(0) }} title="Rows per page" options={PAGE_SIZES.map((n) => [String(n), `${n} / page`])} />
              <div className="ml-auto flex items-center gap-1">
                <PagerBtn disabled={page === 0} onClick={() => setPage(0)} label="First">«</PagerBtn>
                <PagerBtn disabled={page === 0} onClick={() => setPage((p) => p - 1)} label="Previous">‹</PagerBtn>
                <JumpTo page={page} pageCount={pageCount} onJump={setPage} />
                <PagerBtn disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)} label="Next">›</PagerBtn>
                <PagerBtn disabled={page + 1 >= pageCount} onClick={() => setPage(pageCount - 1)} label="Last">»</PagerBtn>
              </div>
            </div>
          </section>
        </div>
      )}

      {selected ? <EventDrawer event={selected} onClose={() => setSelected(null)} onFilter={(p) => { patch(p); setSelected(null) }} /> : null}
    </ViewShell>
  )
}

function countActive(f: Filters): number {
  let n = 0
  if (f.q.trim()) n++
  if (f.outcome !== 'all') n++
  if (f.action) n++
  if (f.actor) n++
  if (f.actorType) n++
  if (f.targetType) n++
  if (f.range !== 'any') n++
  return n
}

/* ─────────── detail drawer ─────────── */

function EventDrawer({ event, onClose, onFilter }: { event: WsAuditEvent; onClose(): void; onFilter(p: Partial<Filters>): void }) {
  const toast = useToast()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  const rows: Array<[string, ReactNode]> = [
    ['Event id', <code key="id" className="font-mono text-[11px]">{event.id}</code>],
    ['When', `${formatAbsolute(event.at)} (${formatRelative(event.at)})`],
    ['Actor', `${event.actor.label} · ${event.actor.type} · ${event.actor.id}`],
    ['Action', <code key="a" className="font-mono">{event.action}</code>],
    ['Target', `${event.target.label} · ${event.target.type} · ${event.target.id}`],
    ['Outcome', <StatusBadge key="o" kind={event.outcome === 'success' ? 'healthy' : 'failed'}>{event.outcome}</StatusBadge>],
    ['IP', event.ip ?? '—'],
    ['User agent', event.userAgent ?? '—'],
  ]
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Audit event">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-edge-default bg-surface-raised px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusBadge kind={event.outcome === 'success' ? 'healthy' : 'failed'}>{event.outcome}</StatusBadge>
              <code className="font-mono text-[13px] font-semibold text-content">{event.action}</code>
            </div>
            <p className="mt-1 text-[12px] text-content-muted">
              {event.actor.label} → {event.target.label} · {formatRelative(event.at)}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <SecondaryButton onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(event, null, 2)); toast.success('Event copied as JSON') }}>Copy JSON</SecondaryButton>
            <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-content-subtle hover:bg-surface-sunken hover:text-content"><IconX /></button>
          </div>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section className="overflow-hidden rounded-xl border border-edge-default">
            <table className="w-full text-[12.5px]">
              <tbody className="divide-y divide-edge-subtle">
                {rows.map(([k, v]) => (
                  <tr key={k} className="bg-surface-raised">
                    <td className="w-32 px-3 py-2 align-top text-content-muted">{k}</td>
                    <td className="break-all px-3 py-2 text-content">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Filter the log by</div>
            <div className="flex flex-wrap gap-1.5">
              <SecondaryButton onClick={() => onFilter({ actor: event.actor.id })}>This actor</SecondaryButton>
              <SecondaryButton onClick={() => onFilter({ action: event.action })}>This action</SecondaryButton>
              <SecondaryButton onClick={() => onFilter({ action: event.action.split('.')[0] + '.' })}>{event.action.split('.')[0]}.* actions</SecondaryButton>
              <SecondaryButton onClick={() => onFilter({ targetType: event.target.type })}>{event.target.type} targets</SecondaryButton>
              <SecondaryButton onClick={() => onFilter({ q: event.target.id })}>Same target id</SecondaryButton>
            </div>
          </section>
          {event.metadata && Object.keys(event.metadata).length ? (
            <section>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Metadata</div>
              <pre className="whitespace-pre-wrap break-all rounded-xl border border-edge-default bg-code p-4 font-mono text-[11.5px] leading-relaxed text-code-fg">{JSON.stringify(event.metadata, null, 2)}</pre>
            </section>
          ) : null}
          <section>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Raw event</div>
            <pre className="whitespace-pre-wrap break-all rounded-xl border border-edge-default bg-code p-4 font-mono text-[11.5px] leading-relaxed text-code-fg">{JSON.stringify(event, null, 2)}</pre>
          </section>
        </div>
      </aside>
    </div>
  )
}

/* ─────────── bits ─────────── */

function ExportMenu({ disabled, total, onPage, onAll }: { disabled: boolean; total: number; onPage(k: 'csv' | 'json'): void; onAll(k: 'csv' | 'json'): void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <PrimaryButton disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <IconDownload /> Export
      </PrimaryButton>
      {open ? (
        <>
          <div className="fixed inset-0 z-30" aria-hidden onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1.5 w-60 rounded-xl border border-edge-default bg-surface-raised p-1 text-[12px] shadow-xl ring-1 ring-black/5 dark:ring-white/10">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">This page</div>
            <MenuItem onClick={() => { setOpen(false); onPage('csv') }}>CSV</MenuItem>
            <MenuItem onClick={() => { setOpen(false); onPage('json') }}>JSON</MenuItem>
            <div className="mt-1 border-t border-edge-subtle px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">All matching · {Math.min(total, 50_000).toLocaleString()}</div>
            <MenuItem onClick={() => { setOpen(false); void onAll('csv') }}>CSV (up to 50k)</MenuItem>
            <MenuItem onClick={() => { setOpen(false); void onAll('json') }}>JSON (up to 50k)</MenuItem>
          </div>
        </>
      ) : null}
    </div>
  )
}

function MenuItem({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="block w-full rounded-md px-2 py-1.5 text-left text-content-muted hover:bg-surface-sunken hover:text-content">{children}</button>
}

function Segmented({ value, onChange, options }: { value: string; onChange(v: string): void; options: Array<[string, string, string?]> }) {
  return (
    <div className="inline-flex h-9 items-center rounded-lg border border-edge-default bg-surface-sunken p-0.5">
      {options.map(([v, label, dot]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={cn('inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors', value === v ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content')}>
          {dot ? <span className={cn('h-1.5 w-1.5 rounded-full', dot)} /> : null}
          {label}
        </button>
      ))}
    </div>
  )
}

function Select({ value, onChange, options, title }: { value: string; onChange(v: string): void; options: Array<[string, string]>; title: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title={title} aria-label={title} className="h-9 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content-muted focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20">
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  )
}

/** Facet dropdown that also accepts a typed value (prefix match for actions). */
function FacetSelect({ label, value, onChange, options, allowPrefix = false }: { label: string; value: string; onChange(v: string): void; options: Array<[string, string]>; allowPrefix?: boolean }) {
  const known = options.some(([v]) => v === value)
  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] text-content-subtle">
      <span className="font-semibold uppercase tracking-wider">{label}</span>
      {allowPrefix ? (
        <>
          <input
            list={`facet-${label}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="any"
            className={cn('h-8 w-44 rounded-lg border bg-surface-raised px-2 font-mono text-[11px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none', value ? 'border-brand-300 dark:border-brand-500/40' : 'border-edge-default')}
          />
          <datalist id={`facet-${label}`}>
            {options.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </datalist>
        </>
      ) : (
        <select value={known ? value : value ? value : ''} onChange={(e) => onChange(e.target.value)} className={cn('h-8 max-w-52 rounded-lg border bg-surface-raised px-2 text-[11.5px] text-content focus:border-brand-400 focus:outline-none', value ? 'border-brand-300 dark:border-brand-500/40' : 'border-edge-default')}>
          <option value="">any</option>
          {!known && value ? <option value={value}>{value}</option> : null}
          {options.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      )}
    </label>
  )
}

function FilterLink({ children, title, onClick }: { children: ReactNode; title: string; onClick(): void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="rounded text-left hover:underline decoration-brand-400 underline-offset-2"
    >
      {children}
    </button>
  )
}

function PagerBtn({ disabled, onClick, label, children }: { disabled: boolean; onClick(): void; label: string; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-label={label} title={label} className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge-default bg-surface-raised text-[14px] text-content-muted hover:border-edge-strong hover:text-content disabled:cursor-not-allowed disabled:opacity-40">
      {children}
    </button>
  )
}

function JumpTo({ page, pageCount, onJump }: { page: number; pageCount: number; onJump(p: number): void }) {
  const [draft, setDraft] = useState(String(page + 1))
  useEffect(() => setDraft(String(page + 1)), [page])
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const n = Math.min(Math.max(Number(draft) || 1, 1), pageCount)
        onJump(n - 1)
      }}
      className="mx-1 flex items-center gap-1 text-[12px] text-content-muted"
    >
      <span>Page</span>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} inputMode="numeric" aria-label="Jump to page" className="h-8 w-14 rounded-lg border border-edge-default bg-surface-raised px-2 text-center font-mono text-[12px] text-content focus:border-brand-400 focus:outline-none" />
      <span>of {pageCount.toLocaleString()}</span>
    </form>
  )
}

/** DB-unavailable / fetch-error state — no fake data, ever. */
function StoreErrorState({ error, retry }: { error: unknown; retry(): void }) {
  if (isDbUnavailable(error)) {
    return (
      <EmptyState
        title="Connect a database"
        description="The audit log persists to Postgres. Set DATABASE_URL for the console server to enable it — no stubbed data is shown."
      />
    )
  }
  return (
    <EmptyState
      title="Couldn't load the audit log"
      description={(error as Error)?.message ?? 'Unexpected error.'}
      action={<SecondaryButton onClick={retry}>Retry</SecondaryButton>}
    />
  )
}

function IconDownload() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m6 11 6 6 6-6" />
      <path d="M5 21h14" />
    </svg>
  )
}
function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}
function IconX() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

export default AuditLog
