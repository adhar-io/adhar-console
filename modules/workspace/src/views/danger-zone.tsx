import { useMemo, useState } from 'react'
import { EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import {
  isDbUnavailable,
  useDeleteOrg,
  useMembers,
  useOrg,
  useTransferOwnership,
  type WsMember,
} from '../data/client.ts'
import { SecondaryButton, SelectField, ViewShell } from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function DangerZone() {
  const org = useOrg()
  const members = useMembers()

  const err = org.error ?? members.error
  if (org.isError || members.isError) {
    return (
      <ViewShell
        title="Danger zone"
        description="Irreversible organization actions."
        required={['owner']}
      >
        {isDbUnavailable(err) ? (
          <EmptyState
            title="Connect a database"
            description="Ownership transfer and org deletion require the console database. Set DATABASE_URL for the console server to enable them."
          />
        ) : (
          <EmptyState
            title="Couldn't load the organization"
            description={(err as Error)?.message ?? 'Unexpected error.'}
            action={
              <SecondaryButton
                onClick={() => {
                  org.refetch()
                  members.refetch()
                }}
              >
                Retry
              </SecondaryButton>
            }
          />
        )}
      </ViewShell>
    )
  }

  return (
    <ViewShell
      title="Danger zone"
      description="These actions are irreversible and are recorded in the audit log."
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

function TransferOwnership({ members }: { members: WsMember[] }) {
  const candidates = useMemo(() => members.filter((m) => m.role !== 'owner'), [members])
  const [target, setTarget] = useState('')
  const transfer = useTransferOwnership()

  const selected = candidates.find((m) => m.userId === target)

  return (
    <div className="rounded-2xl border border-rose-300 bg-rose-50/60 p-5 dark:border-rose-900 dark:bg-rose-950/30">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-rose-900 dark:text-rose-200">Transfer ownership</div>
        <p className="mt-1 text-[12px] text-rose-800 dark:text-rose-300/90">
          Promotes another member to Owner and demotes you to Admin, immediately. Keycloak role groups
          are updated to match when RBAC sync is configured.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block min-w-60 flex-1">
          <span className="mb-1 block text-xs font-medium text-rose-900 dark:text-rose-200">New owner</span>
          <SelectField
            value={target}
            onChange={(v) => {
              setTarget(v)
              transfer.reset()
            }}
            options={[
              { value: '', label: candidates.length ? 'Select a member…' : 'No eligible members' },
              ...candidates.map((m) => ({ value: m.userId, label: `${m.name} · ${m.email}` })),
            ]}
          />
        </label>
        <button
          type="button"
          disabled={!target || transfer.isPending}
          onClick={() => transfer.mutate(target)}
          className="inline-flex h-9 items-center rounded-lg border border-rose-300 bg-surface-raised px-4 text-sm font-medium text-rose-900 shadow-sm transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-800 dark:text-rose-200 dark:hover:bg-rose-950/50"
        >
          {transfer.isPending ? 'Transferring…' : 'Transfer'}
        </button>
      </div>

      {transfer.isSuccess ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-emerald-800 dark:text-emerald-300">
          <StatusBadge kind="healthy">done</StatusBadge>
          Ownership transferred to {selected?.email ?? 'the selected member'}.
          <StatusBadge kind={transfer.data?.keycloakSynced ? 'healthy' : 'paused'}>
            {transfer.data?.keycloakSynced ? 'synced to Keycloak' : 'console-only'}
          </StatusBadge>
        </div>
      ) : null}
      {transfer.isError ? (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-rose-800 dark:text-rose-300">
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
  const del = useDeleteOrg()
  const matches = orgName.length > 0 && confirm.trim() === orgName

  return (
    <div className="rounded-2xl border border-rose-400 bg-rose-50/60 p-5 dark:border-rose-800 dark:bg-rose-950/30">
      <div className="text-sm font-semibold text-rose-900 dark:text-rose-200">Delete organization</div>
      <p className="mt-1 text-[12px] text-rose-800 dark:text-rose-300/90">
        Permanently deletes all workspace records — members, invitations, teams, projects, tokens, and
        approvals — and removes synced Keycloak team groups. Backing Git repos and images remain in
        Gitea / Harbor unless removed separately.
      </p>

      {del.isSuccess ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <StatusBadge kind="healthy">deleted</StatusBadge>
          Workspace records for <span className="font-medium">{orgName}</span> were purged.
        </div>
      ) : (
        <>
          <label className="mt-4 block">
            <span className="block text-xs font-medium text-rose-900 dark:text-rose-200">
              Type <code className="font-mono">{loading ? '…' : orgName || 'the organization name'}</code>{' '}
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
              className="mt-1 w-full rounded-lg border border-rose-300 bg-surface-raised px-3 py-2 font-mono text-sm text-content shadow-sm focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-400/20 disabled:opacity-60 dark:border-rose-800"
            />
          </label>
          <button
            type="button"
            disabled={!matches || del.isPending}
            onClick={() => del.mutate(confirm.trim())}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {del.isPending ? 'Deleting…' : 'Delete organization'}
          </button>
          {del.isError ? (
            <div className="mt-3 flex items-center gap-2 text-[12px] text-rose-800 dark:text-rose-300">
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
