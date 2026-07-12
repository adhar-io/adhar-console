import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar-console/utils'
import { CURRENT_ORG_SLUG, wsClient } from '../data/client.ts'
import {
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function AuditLog() {
  const q = useQuery({
    queryKey: ['ws', 'audit', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listAuditEvents(CURRENT_ORG_SLUG, { limit: 200 }),
  })

  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState<'all' | 'success' | 'failure'>('all')

  const filtered = useMemo(() => {
    const all = q.data ?? []
    const needle = search.trim().toLowerCase()
    return all.filter((e) => {
      if (outcome !== 'all' && e.outcome !== outcome) return false
      if (!needle) return true
      return (
        e.action.toLowerCase().includes(needle) ||
        e.actor.label.toLowerCase().includes(needle) ||
        e.target.label.toLowerCase().includes(needle) ||
        (e.ip ?? '').includes(needle)
      )
    })
  }, [q.data, outcome, search])

  const total = q.data?.length ?? 0
  const failed = (q.data ?? []).filter((e) => e.outcome !== 'success').length

  return (
    <ViewShell
      title="Audit log"
      description="Every privileged action in the org. Retention follows the security policy (currently 365 days)."
      required={['admin', 'security', 'owner']}
      actions={
        <RequirePermission perm="audit.export" required={['security', 'owner']} readOnly>
          <SecondaryButton>
            <IconDownload /> Export CSV
          </SecondaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Events" value={total} />
        <StatTile label="Failures" value={failed} tone={failed > 0 ? 'warn' : 'good'} />
        <StatTile label="Visible" value={filtered.length} hint="after filters" />
        <StatTile label="Retention" value="365d" hint="Business plan" />
      </div>

      <SettingsCard
        title="Events"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TextField
              value={search}
              onChange={setSearch}
              placeholder="Search action, actor, target, IP…"
            />
            <SelectField<typeof outcome>
              value={outcome}
              onChange={setOutcome}
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
          rows={filtered}
          rowKey={(e) => e.id}
          empty={<EmptyState title="No audit events match" />}
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
      </SettingsCard>
    </ViewShell>
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
