import { useState } from 'react'
import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  isValidCidr,
  useDeleteIpEntry,
  useIpAllowlist,
  useSaveIpEntry,
  type IpAllowEntry,
  type IpScope,
} from '../data/security.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function IpAllowlist() {
  const q = useIpAllowlist()
  const del = useDeleteIpEntry()
  const [editing, setEditing] = useState<IpAllowEntry | null>(null)
  const [adding, setAdding] = useState(false)

  const all = q.data ?? []

  return (
    <ViewShell
      title="IP allowlist"
      description="Restrict console + API access to known networks. Entries are recorded in the tenant document store; they are enforced at the gateway once it is configured to read this list — until then this page is the source of record, not a live firewall."
      required={['security', 'owner']}
      actions={
        <RequirePermission perm="ipallow.write" required={['security', 'owner']} readOnly>
          <PrimaryButton
            onClick={() => {
              setEditing(null)
              setAdding(true)
            }}
          >
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
          label="Enforcement"
          value="Recorded"
          hint="applied at gateway when configured"
        />
      </div>

      {adding || editing ? (
        <CidrEditor
          initial={editing}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      ) : null}

      {q.isError ? (
        <StoreErrorBlock error={q.error as Error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <LoadingBlock label="Loading allowlist…" />
      ) : (
        <SettingsCard
          title="Entries"
          description="Empty list = open to the world; adding any entry switches the recorded policy to deny-by-default."
        >
          <DataTable
            rows={all}
            rowKey={(e) => e.id}
            empty={
              <EmptyState
                title="No CIDRs configured"
                description="The recorded policy is currently open to all networks."
              />
            }
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
              { key: 'by', header: 'Added by', cell: (e) => e.addedBy ?? '—' },
              { key: 'at', header: 'Added', cell: (e) => formatRelative(e.addedAt) },
              {
                key: 'actions',
                header: '',
                cell: (e) => (
                  <RequirePermission perm="ipallow.write" required={['security', 'owner']} readOnly>
                    <div className="flex justify-end gap-1.5">
                      <SecondaryButton
                        onClick={() => {
                          setAdding(false)
                          setEditing(e)
                        }}
                      >
                        Edit
                      </SecondaryButton>
                      <SecondaryButton
                        tone="rose"
                        disabled={del.isPending && del.variables === e.id}
                        onClick={() => del.mutate(e.id)}
                      >
                        Remove
                      </SecondaryButton>
                    </div>
                  </RequirePermission>
                ),
              },
            ]}
          />
        </SettingsCard>
      )}
    </ViewShell>
  )
}

function CidrEditor({ initial, onClose }: { initial: IpAllowEntry | null; onClose(): void }) {
  const save = useSaveIpEntry()
  const [cidr, setCidr] = useState(initial?.cidr ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [scope, setScope] = useState<IpScope>(initial?.scope ?? 'both')

  const cidrOk = isValidCidr(cidr)
  const canSave = cidrOk && label.trim().length > 0 && !save.isPending

  const submit = () =>
    save.mutate(
      { id: initial?.id, input: { cidr, label, scope } },
      { onSuccess: onClose },
    )

  return (
    <SettingsCard title={initial ? 'Edit allowed range' : 'Add allowed range'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <div className="mb-1 text-xs font-medium text-content-muted">CIDR</div>
          <TextField mono value={cidr} onChange={setCidr} placeholder="203.0.113.0/24" />
          {cidr && !cidrOk ? (
            <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
              Not a valid IPv4/IPv6 CIDR (e.g. 203.0.113.0/24 or 2001:db8::/32).
            </div>
          ) : null}
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-content-muted">Label</div>
          <TextField value={label} onChange={setLabel} placeholder="HQ office (NYC)" />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-content-muted">Scope</div>
          <SelectField<IpScope>
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
      {save.isError ? (
        <p className="mt-3 text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save the entry.'}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={!canSave}>
          {save.isPending ? 'Saving…' : initial ? 'Save changes' : 'Add range'}
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
