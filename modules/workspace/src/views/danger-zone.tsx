import { useState } from 'react'
import { CONSOLE_PERMISSIONS, EmptyState, StatusBadge, useAccessReview, useToast } from '@adhar/shell-ui'
import { isDbUnavailable, useDeleteOrg, useOrg, useWorkspaceMe } from '../data/client.ts'
import { SecondaryButton, ViewShell } from '../components/section-shell.tsx'

export function DangerZone() {
  const org = useOrg()
  const me = useWorkspaceMe()
  // DELETE /api/workspace/org → orgDelete, which any admin of the organization
  // holds (organizations have admins, not a single owner).
  const deleteRbac = useAccessReview(CONSOLE_PERMISSIONS.orgDelete)
  // The platform's own organization is never deleted — the BFF refuses it too.
  const platformOrg = me.data?.isPlatformOrganisation === true
  const canDelete = deleteRbac.allowed && me.isSuccess && !platformOrg
  const settled = !deleteRbac.loading && !me.isLoading

  if (org.isError) {
    return (
      <ViewShell
        title="Danger zone"
        description="Irreversible organization actions."
        writeCheck={CONSOLE_PERMISSIONS.orgDelete}
      >
        {isDbUnavailable(org.error) ? (
          <EmptyState
            title="Connect a database"
            description="Deleting the organization requires the console database. Set DATABASE_URL for the console server to enable it."
          />
        ) : (
          <EmptyState
            title="Couldn't load the organization"
            description={(org.error as Error)?.message ?? 'Unexpected error.'}
            action={<SecondaryButton onClick={() => org.refetch()}>Retry</SecondaryButton>}
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
      {canDelete ? (
        <div className="space-y-4">
          <DeleteOrganization orgName={org.data?.name ?? ''} orgSlug={me.data?.orgSlug ?? null} loading={org.isLoading} />
        </div>
      ) : settled ? (
        <EmptyState
          title="Nothing you can change here"
          description={platformOrg
            ? 'This is the platform’s own organization, so it cannot be deleted.'
            : 'Deleting the organization is reserved for its admins. Ask one if it is needed.'}
        />
      ) : null}
    </ViewShell>
  )
}

/* ─────────────────── Delete organization ─────────────────── */

function DeleteOrganization({ orgName, orgSlug, loading }: { orgName: string; orgSlug: string | null; loading: boolean }) {
  const [confirm, setConfirm] = useState('')
  const del = useDeleteOrg()
  const toast = useToast()
  const matches = orgName.length > 0 && confirm.trim() === orgName
  const groups = orgSlug ? `org-${orgSlug}, org-${orgSlug}-admin and every ws-team-${orgSlug}.* team group` : 'its member, admin and team groups'

  return (
    <div className="rounded-2xl border border-rose-400 bg-rose-50/60 p-5 dark:border-rose-800 dark:bg-rose-950/30">
      <div className="text-sm font-semibold text-rose-900 dark:text-rose-200">Delete organization</div>
      <p className="mt-1 text-[12px] text-rose-800 dark:text-rose-300/90">
        Permanently deletes the organization's console records — teams, projects, tokens and approvals — and its
        Keycloak groups ({groups}), which ends everyone's membership. People's Keycloak accounts are kept. The
        Organisation resource, its namespace and the Gitea organization are retained, as are repositories and images
        in Gitea / Harbor; remove them separately if needed.
      </p>

      {del.isSuccess ? (
        <div className="mt-4 space-y-1 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <div className="flex items-center gap-2">
            <StatusBadge kind="healthy">deleted</StatusBadge>
            Records and Keycloak groups for <span className="font-medium">{orgName}</span> were removed.
          </div>
          {del.data?.retained?.length ? <div>Kept: {del.data.retained.join(', ')}.</div> : null}
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
