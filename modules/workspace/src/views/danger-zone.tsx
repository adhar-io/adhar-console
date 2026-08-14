import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { StatusBadge } from '@adhar-console/shell-ui'
import { CURRENT_ORG_SLUG, wsClient } from '../data/client.ts'
import { SelectField, ViewShell } from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function DangerZone() {
  const org = useQuery({
    queryKey: ['ws', 'org', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.getOrganization(CURRENT_ORG_SLUG),
  })
  const members = useQuery({
    queryKey: ['ws', 'members', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listMembers(CURRENT_ORG_SLUG),
  })

  return (
    <ViewShell
      title="Danger zone"
      description="These actions are irreversible. Approval policies in Security may add a multi-person gate before execution."
      required={['owner']}
    >
      <RequirePermission perm="org.transfer" required={['owner']}>
        <TransferOwnership members={members.data ?? []} />
        <div className="mt-4">
          <DeleteOrganization orgName={org.data?.name ?? ''} loading={org.isLoading} />
        </div>
      </RequirePermission>
    </ViewShell>
  )
}

/* ─────────────────── Transfer ownership ─────────────────── */

function TransferOwnership({
  members,
}: {
  members: { userId: string; name: string; email: string; role: string }[]
}) {
  const candidates = useMemo(() => members.filter((m) => m.role !== 'owner'), [members])
  const [target, setTarget] = useState('')

  const transfer = useMutation({
    mutationFn: (email: string) => wsClient.transferOwnership(CURRENT_ORG_SLUG, email),
  })

  const selectedEmail = candidates.find((m) => m.userId === target)?.email ?? ''

  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-rose-900">Transfer ownership</div>
          <p className="mt-1 text-[12px] text-rose-800">
            Moves the organization to another owner. You lose administrative access immediately;
            billing remains under the prior payment method until the next renewal.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block min-w-[240px] flex-1">
          <span className="mb-1 block text-xs font-medium text-rose-900">New owner</span>
          <SelectField
            value={target}
            onChange={(v) => {
              setTarget(v)
              transfer.reset()
            }}
            options={[
              { value: '', label: 'Select a member…' },
              ...candidates.map((m) => ({ value: m.userId, label: `${m.name} · ${m.email}` })),
            ]}
          />
        </label>
        <button
          type="button"
          disabled={!target || transfer.isPending}
          onClick={() => transfer.mutate(selectedEmail)}
          className="inline-flex h-9 items-center rounded-lg border border-rose-300 bg-surface-raised px-4 text-sm font-medium text-rose-900 shadow-sm transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {transfer.isPending ? 'Transferring…' : 'Transfer'}
        </button>
      </div>

      {transfer.isSuccess ? (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-emerald-800">
          <StatusBadge kind="healthy">done</StatusBadge>
          Ownership transferred to {selectedEmail}. A confirmation was emailed to both parties.
        </div>
      ) : null}
      {transfer.isError ? (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-rose-800">
          <StatusBadge kind="failed">error</StatusBadge>
          {(transfer.error as Error)?.message ?? 'Transfer failed. Try again.'}
        </div>
      ) : null}
    </div>
  )
}

/* ─────────────────── Delete organization ─────────────────── */

function DeleteOrganization({ orgName, loading }: { orgName: string; loading: boolean }) {
  const [confirm, setConfirm] = useState('')
  const matches = orgName.length > 0 && confirm.trim() === orgName

  const del = useMutation({
    mutationFn: () => wsClient.deleteOrganization(CURRENT_ORG_SLUG),
  })

  return (
    <div className="rounded-2xl border border-rose-300 bg-rose-50/60 p-5">
      <div className="text-sm font-semibold text-rose-900">Delete organization</div>
      <p className="mt-1 text-[12px] text-rose-800">
        Permanently deletes the org, every project, and every managed namespace. Backing Git repos
        and container images remain in Gitea / Harbor unless you explicitly remove them. This action
        requires Security + Owner approval per the destructive-RBAC policy.
      </p>

      {del.isSuccess ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          <StatusBadge kind="healthy">deleted</StatusBadge>
          Deletion scheduled for <span className="font-medium">{orgName}</span>. The workspace will
          be purged after the 24-hour grace window.
        </div>
      ) : (
        <>
          <label className="mt-4 block">
            <span className="block text-xs font-medium text-rose-900">
              Type{' '}
              <code className="font-mono">{loading ? '…' : orgName || 'the organization name'}</code>{' '}
              to confirm
            </span>
            <input
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
                del.reset()
              }}
              placeholder={orgName}
              disabled={loading}
              className="mt-1 w-full rounded-lg border border-rose-300 bg-surface-raised px-3 py-2 font-mono text-sm text-content shadow-sm focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-400/20 disabled:opacity-60"
            />
          </label>
          <button
            type="button"
            disabled={!matches || del.isPending}
            onClick={() => del.mutate()}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {del.isPending ? 'Deleting…' : 'Delete organization'}
          </button>
          {del.isError ? (
            <div className="mt-3 flex items-center gap-2 text-[12px] text-rose-800">
              <StatusBadge kind="failed">error</StatusBadge>
              {(del.error as Error)?.message ?? 'Deletion failed. Try again.'}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

export default DangerZone
