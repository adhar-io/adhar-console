import { useState } from 'react'
import { ViewShell } from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function DangerZone() {
  const [confirm, setConfirm] = useState('')
  const ok = confirm === 'delete acme'
  return (
    <ViewShell
      title="Danger zone"
      description="These actions are irreversible. Approval policies in Security may add a multi-person gate before execution."
      required={['owner']}
    >
      <RequirePermission perm="org.transfer" required={['owner']}>
        <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-rose-900">Transfer ownership</div>
              <p className="mt-1 text-[12px] text-rose-800">
                Moves the organization to another owner. You lose administrative access immediately;
                billing remains under the prior payment method until the next renewal.
              </p>
            </div>
            <button
              type="button"
              className="rounded-lg border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-900 transition-colors hover:bg-rose-100"
            >
              Transfer
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-rose-300 bg-rose-50/60 p-5">
          <div className="text-sm font-semibold text-rose-900">Delete organization</div>
          <p className="mt-1 text-[12px] text-rose-800">
            Permanently deletes the org, every project, and every managed namespace. Backing Git
            repos and container images remain in Gitea / Harbor unless you explicitly remove them.
            This action requires Security + Owner approval per the destructive-RBAC policy.
          </p>
          <label className="mt-4 block">
            <span className="block text-xs font-medium text-rose-900">
              Type <code className="font-mono">delete acme</code> to confirm
            </span>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded-lg border border-rose-300 bg-white px-3 py-2 font-mono text-sm text-content shadow-sm focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-400/20"
            />
          </label>
          <button
            type="button"
            disabled={!ok}
            className="mt-3 inline-flex h-9 items-center rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete organization
          </button>
        </div>
      </RequirePermission>
    </ViewShell>
  )
}

export default DangerZone
