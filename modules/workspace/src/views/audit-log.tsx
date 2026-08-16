import { useState } from 'react'
import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar-console/utils'
import { isDbUnavailable, useAuditEvents } from '../data/client.ts'
import {
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const PAGE_SIZE = 50

export function AuditLog() {
  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState<'all' | 'success' | 'failure'>('all')
  const [page, setPage] = useState(0)

  const q = useAuditEvents({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    q: search.trim() || undefined,
    outcome: outcome === 'all' ? undefined : outcome,
  })

  const data = q.data
  const events = data?.items ?? []
  const total = data?.total ?? 0
  const failed = events.filter((e) => e.outcome !== 'success').length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const onFilterChange = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v)
    setPage(0)
  }

  const exportCsv = () => {
    const rows = [
      ['at', 'actor', 'actorType', 'action', 'targetType', 'target', 'outcome', 'ip'],
      ...events.map((e) => [
        e.at,
        e.actor.label,
        e.actor.type,
        e.action,
        e.target.type,
        e.target.label,
        e.outcome,
        e.ip ?? '',
      ]),
    ]
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-log-page-${page + 1}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <ViewShell
      title="Audit log"
      description="Every privileged workspace mutation, persisted as workspace.audit documents and served newest-first."
      required={['admin', 'security', 'owner']}
      actions={
        <RequirePermission perm="audit.export" required={['security', 'owner']} readOnly>
          <SecondaryButton onClick={exportCsv} disabled={events.length === 0}>
            <IconDownload /> Export CSV
          </SecondaryButton>
        </RequirePermission>
      }
    >
      {q.isError ? (
        <StoreErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Total events" value={q.isLoading ? '…' : total} />
            <StatTile label="Failures (page)" value={failed} tone={failed > 0 ? 'warn' : 'good'} />
            <StatTile label="On this page" value={events.length} />
            <StatTile label="Page" value={`${page + 1} / ${pageCount}`} />
          </div>

          <SettingsCard
            title="Events"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <TextField
                  value={search}
                  onChange={onFilterChange(setSearch)}
                  placeholder="Search action, actor, target, IP…"
                />
                <SelectField<typeof outcome>
                  value={outcome}
                  onChange={onFilterChange(setOutcome)}
                  options={[
                    { value: 'all', label: 'Any outcome' },
                    { value: 'success', label: 'Success' },
                    { value: 'failure', label: 'Failure' },
                  ]}
                />
              </div>
            }
          >
            <DataTable
              loading={q.isLoading}
              rows={events}
              rowKey={(e) => e.id}
              empty={
                <EmptyState
                  title="No audit events"
                  description="Privileged actions (invites, role changes, team edits, token mints, deletes) show up here as they happen."
                />
              }
              columns={[
                {
                  key: 'when',
                  header: 'When',
                  cell: (e) => (
                    <div>
                      <div className="font-medium text-content">{formatRelative(e.at)}</div>
                      <div className="font-mono text-[11px] text-content-subtle">{formatAbsolute(e.at)}</div>
                    </div>
                  ),
                },
                {
                  key: 'actor',
                  header: 'Actor',
                  cell: (e) => (
                    <div>
                      <div className="text-sm font-medium text-content">{e.actor.label}</div>
                      <div className="text-[11px] text-content-muted">{e.actor.type}</div>
                    </div>
                  ),
                },
                {
                  key: 'action',
                  header: 'Action',
                  cell: (e) => (
                    <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
                      {e.action}
                    </code>
                  ),
                },
                {
                  key: 'target',
                  header: 'Target',
                  cell: (e) => (
                    <div>
                      <div className="text-sm text-content">{e.target.label}</div>
                      <div className="text-[11px] text-content-muted">{e.target.type}</div>
                    </div>
                  ),
                },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  cell: (e) => (
                    <StatusBadge kind={e.outcome === 'success' ? 'healthy' : 'failed'}>
                      {e.outcome}
                    </StatusBadge>
                  ),
                },
                {
                  key: 'ip',
                  header: 'Context',
                  cell: (e) => (
                    <div className="font-mono text-[11px] text-content-muted">
                      {e.ip ? <div>{e.ip}</div> : null}
                      {e.userAgent ? <div className="max-w-xs truncate">{e.userAgent}</div> : null}
                    </div>
                  ),
                },
              ]}
            />

            {total > PAGE_SIZE ? (
              <div className="mt-4 flex items-center justify-between">
                <span className="text-[12px] text-content-muted">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <SecondaryButton disabled={page === 0 || q.isFetching} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </SecondaryButton>
                  <SecondaryButton
                    disabled={page + 1 >= pageCount || q.isFetching}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </SecondaryButton>
                </div>
              </div>
            ) : null}
          </SettingsCard>
        </>
      )}
    </ViewShell>
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

export default AuditLog
