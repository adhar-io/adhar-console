import { useState } from 'react'
import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useIpAllowlist } from '../data/enterprise.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function IpAllowlist() {
  const q = useIpAllowlist()
  const all = q.data ?? []
  const [adding, setAdding] = useState(false)

  return (
    <ViewShell
      title="IP allowlist"
      description="Restrict console + API access to known networks. Empty list = open to the world; adding any entry switches to deny-by-default."
      required={['security', 'owner']}
      actions={
        <RequirePermission perm="ipallow.write" required={['security', 'owner']} readOnly>
          <PrimaryButton onClick={() => setAdding(true)}>
            <IconPlus /> Add CIDR
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Allowed CIDRs" value={all.length} />
        <StatTile
          label="Console + API"
          value={all.filter((e) => e.scope === 'both').length}
          tone="good"
        />
        <StatTile label="API only" value={all.filter((e) => e.scope === 'api').length} />
        <StatTile
          label="Mode"
          value={all.length ? 'Allow-list' : 'Open'}
          tone={all.length ? 'good' : 'warn'}
          hint={all.length ? 'deny-by-default' : 'recommended: add HQ + VPN'}
        />
      </div>

      {adding ? <AddCidrCard onClose={() => setAdding(false)} /> : null}

      <SettingsCard title="Entries" description="Members signing in from outside these ranges hit a 403 with a self-serve appeal link.">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(e) => e.id}
          empty={<EmptyState title="No CIDRs configured" description="Currently open to all networks." />}
          columns={[
            {
              key: 'cidr',
              header: 'CIDR',
              cell: (e) => (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px]">
                  {e.cidr}
                </code>
              ),
            },
            { key: 'label', header: 'Label', cell: (e) => e.label },
            {
              key: 'scope',
              header: 'Scope',
              cell: (e) => (
                <StatusBadge kind={e.scope === 'both' ? 'healthy' : 'info'}>
                  {e.scope === 'both' ? 'console + api' : e.scope}
                </StatusBadge>
              ),
            },
            { key: 'by', header: 'Added by', cell: (e) => e.addedBy },
            { key: 'at', header: 'Added', cell: (e) => formatRelative(e.addedAt) },
            {
              key: 'actions',
              header: '',
              cell: () => (
                <div className="flex justify-end gap-1.5">
                  <SecondaryButton>Edit</SecondaryButton>
                  <SecondaryButton tone="rose">Remove</SecondaryButton>
                </div>
              ),
            },
          ]}
        />
      </SettingsCard>
    </ViewShell>
  )
}

function AddCidrCard({ onClose }: { onClose(): void }) {
  const [cidr, setCidr] = useState('')
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<'console' | 'api' | 'both'>('both')
  return (
    <SettingsCard title="Add allowed range">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <div className="mb-1 text-xs font-medium text-content-muted">CIDR</div>
          <TextField mono value={cidr} onChange={setCidr} placeholder="203.0.113.0/24" />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-content-muted">Label</div>
          <TextField value={label} onChange={setLabel} placeholder="HQ office (NYC)" />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-content-muted">Scope</div>
          <SelectField<'console' | 'api' | 'both'>
            value={scope}
            onChange={setScope}
            options={[
              { value: 'both', label: 'Console + API' },
              { value: 'console', label: 'Console only' },
              { value: 'api', label: 'API only' },
            ]}
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={onClose} disabled={!cidr || !label}>
          Add range
        </PrimaryButton>
      </div>
    </SettingsCard>
  )
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export default IpAllowlist
