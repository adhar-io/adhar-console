import { useMemo, useState } from 'react'
import { CONSOLE_PERMISSIONS, EmptyState, StatusBadge, useAccessReview, useToast } from '@adhar/shell-ui'
import {
  isDbUnavailable,
  useDeleteOrg,
  useMembers,
  useOrg,
  useTransferOwnership,
  useWorkspaceMe,
  type WsMember,
} from '../data/client.ts'
import { SecondaryButton, SelectField, ViewShell } from '../components/section-shell.tsx'

export function DangerZone() {
  const org = useOrg()
  const members = useMembers()
  const me = useWorkspaceMe()
  // POST /api/workspace/org/transfer → orgUpdate, and the BFF additionally
  // requires the caller to BE the owner (only an owner can hand ownership on).
  const transferRbac = useAccessReview(CONSOLE_PERMISSIONS.orgUpdate)
  // DELETE /api/workspace/org → orgDelete.
  const deleteRbac = useAccessReview(CONSOLE_PERMISSIONS.orgDelete)
  const canTransfer = transferRbac.allowed && me.data?.role === 'owner'
  const canDelete = deleteRbac.allowed
  const settled = !transferRbac.loading && !deleteRbac.loading && !me.isLoading

  const err = org.error ?? members.error
  if (org.isError || members.isError) {
    return (
      <ViewShell
        title="Danger zone"
        description="Irreversible organization actions."
        writeCheck={CONSOLE_PERMISSIONS.orgDelete}
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
      writeCheck={CONSOLE_PERMISSIONS.orgDelete}
    >
      {canTransfer || canDelete ? (
        <div className="space-y-4">
          {canTransfer ? <TransferOwnership members={members.data ?? []} /> : null}
          {canDelete ? <DeleteOrganization orgName={org.data?.name ?? ''} loading={org.isLoading} /> : null}
        </div>
      ) : settled ? (
        <EmptyState
          title="Nothing you can change here"
          description="Transferring ownership and deleting the organization are reserved for the organization owner. Ask them if either is needed."
        />
      ) : null}
    </ViewShell>
  )
}

/* ─────────────────── Transfer ownership ─────────────────── */

function TransferOwnership({ members }: { members: WsMember[] }) {
  const candidates = useMemo(() => members.filter((m) => m.role !== 'owner'), [members])
  const [target, setTarget] = useState('')
  const transfer = useTransferOwnership()
  const toast = useToast()

  const submit = () => {
    const email = candidates.find((m) => m.userId === target)?.email ?? 'the selected member'
    transfer.mutate(target, {
      onSuccess: (r) => {
        setTarget('')
        toast.success(`Ownership transferred to ${email}`, {
          description: r.keycloakSynced ? 'Keycloak role groups updated.' : 'Console-only — Keycloak sync is not configured.',
        })
      },
      onError: (e) => toast.error('Could not transfer ownership', { description: (e as Error)?.message }),
    })
  }

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
            onChange={setTarget}
            options={[
              { value: '', label: candidates.length ? 'Select a member…' : 'No eligible members' },
              ...candidates.map((m) => ({ value: m.userId, label: `${m.name} · ${m.email}` })),
            ]}
          />
        </label>
        <button
          type="button"
          disabled={!target || transfer.isPending}
          onClick={submit}
          className="inline-flex h-9 items-center rounded-lg border border-rose-300 bg-surface-raised px-4 text-sm font-medium text-rose-900 shadow-sm transition-colors hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-800 dark:text-rose-200 dark:hover:bg-rose-950/50"
        >
          {transfer.isPending ? 'Transferring…' : 'Transfer'}
        </button>
      </div>
    </div>
  )
}

/* ─────────────────── Delete organization ─────────────────── */

function DeleteOrganization({ orgName, loading }: { orgName: string; loading: boolean }) {
  const [confirm, setConfirm] = useState('')
  const del = useDeleteOrg()
  const toast = useToast()
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
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={orgName}
              disabled={loading}
              className="mt-1 w-full rounded-lg border border-rose-300 bg-surface-raised px-3 py-2 font-mono text-sm text-content shadow-sm focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-400/20 disabled:opacity-60 dark:border-rose-800"
            />
          </label>
          <button
            type="button"
            disabled={!matches || del.isPending}
            onClick={() =>
              del.mutate(confirm.trim(), {
                onError: (e) => toast.error('Could not delete the organization', { description: (e as Error)?.message }),
              })}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-rose-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {del.isPending ? 'Deleting…' : 'Delete organization'}
          </button>
        </>
      )}
    </div>
  )
}

export default DangerZone
