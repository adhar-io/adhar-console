import { useState } from 'react'
import {
  CONSOLE_PERMISSIONS,
  DataTable,
  EmptyState,
  Modal,
  StatusBadge,
  type StatusKind,
  useCan,
  useToast,
} from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { roleLabel } from '../data/access.ts'
import {
  APPROVAL_SCOPES,
  isDbUnavailable,
  useApprovalPolicies,
  useApprovalRequests,
  useCreateApprovalRequest,
  useDecideApproval,
  useSaveApprovalPolicy,
  useWorkspaceMe,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalScope,
} from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const SCOPE_LABEL: Record<string, string> = {
  'production-deploy': 'Production deploy',
  'budget-increase': 'Budget increase',
  // The id predates admins being plural; it now guards granting organization admin.
  'role-grant-owner': 'Grant organization admin',
  'data-export': 'Data export',
  'destructive-rbac': 'Destructive RBAC change',
  'cluster-delete': 'Delete cluster',
}

const STATUS_KIND: Record<ApprovalRequest['status'], StatusKind> = {
  pending: 'progressing',
  approved: 'healthy',
  rejected: 'failed',
}

export function Approvals() {
  const me = useWorkspaceMe()
  const requests = useApprovalRequests()
  const policies = useApprovalPolicies()
  const [requestOpen, setRequestOpen] = useState(false)

  const all = requests.data ?? []
  const pending = all.filter((a) => a.status === 'pending')

  return (
    <ViewShell
      title="Approvals"
      description="High-blast-radius actions can require a second person. Requests are persisted as workspace.approval documents; a requester can never approve their own."
      writeCheck={CONSOLE_PERMISSIONS.approvalsDecide}
      // Raising a request is a member action — the BFF does not guard
      // POST /api/workspace/approvals, so the button is offered to everyone.
      actions={
        <PrimaryButton onClick={() => setRequestOpen(true)}>
          <IconPlus /> Request approval
        </PrimaryButton>
      }
    >
      {requests.isError ? (
        <StoreErrorState error={requests.error} retry={() => requests.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Open requests" value={requests.isLoading ? '…' : pending.length} tone={pending.length ? 'warn' : 'good'} />
            <StatTile label="Approved" value={all.filter((a) => a.status === 'approved').length} tone="good" />
            <StatTile label="Rejected" value={all.filter((a) => a.status === 'rejected').length} />
            <StatTile label="Total" value={all.length} />
          </div>

          <ApprovalQueue requests={all} selfId={me.data?.userId} />

          <PolicyList policies={policies.data ?? []} loading={policies.isLoading} />
        </>
      )}

      <RequestApprovalModal open={requestOpen} onClose={() => setRequestOpen(false)} />
    </ViewShell>
  )
}

/* ─────────────────── request queue ─────────────────── */

function ApprovalQueue({
  requests,
  selfId,
}: {
  requests: ApprovalRequest[]
  selfId?: string
}) {
  const decide = useDecideApproval()
  const toast = useToast()
  // POST /api/workspace/approvals/:id/{approve,reject} → approvalsDecide.
  const canDecide = useCan(CONSOLE_PERMISSIONS.approvalsDecide)
  const run = (a: ApprovalRequest, decision: 'approve' | 'reject') =>
    decide.mutate(
      { id: a.id, decision },
      {
        onSuccess: () => toast.success(decision === 'approve' ? 'Request approved' : 'Request rejected'),
        onError: (e) => toast.error(`Could not ${decision} the request`, { description: (e as Error)?.message }),
      },
    )
  return (
    <SettingsCard title="Approval requests" description="Newest first. Segregation of duty is enforced server-side.">
      <DataTable
        rows={requests}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No approval requests" description="Raise one with the button above." compact />}
        columns={[
          {
            key: 'scope',
            header: 'Request',
            cell: (a) => (
              <div className="min-w-0 max-w-md">
                <div className="font-medium text-content">{SCOPE_LABEL[a.scope] ?? a.scope}</div>
                <div className="truncate text-[11px] text-content-muted" title={a.summary}>{a.summary}</div>
              </div>
            ),
          },
          {
            key: 'by',
            header: 'Requested by',
            cell: (a) => (
              <div>
                <div className="text-sm text-content">{a.requestedBy.label}</div>
                <div className="text-[11px] text-content-muted">{formatRelative(a.requestedAt)}</div>
              </div>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            cell: (a) => (
              <div>
                <StatusBadge kind={STATUS_KIND[a.status]}>{a.status}</StatusBadge>
                {a.decidedBy ? (
                  <div className="mt-1 text-[10px] text-content-muted">
                    by {a.decidedBy.label} · {a.decidedAt ? formatRelative(a.decidedAt) : ''}
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            key: 'actions',
            header: '',
            cell: (a) => {
              if (a.status !== 'pending') return <span className="text-[11px] text-content-subtle">—</span>
              const ownRequest = a.requestedBy.id === selfId
              if (ownRequest) {
                return <span className="text-[11px] text-content-subtle">awaiting another approver</span>
              }
              if (!canDecide) return null
              return (
                <div className="flex justify-end gap-1.5">
                  <SecondaryButton
                    disabled={decide.isPending}
                    onClick={() => run(a, 'approve')}
                  >
                    Approve
                  </SecondaryButton>
                  <SecondaryButton
                    tone="rose"
                    disabled={decide.isPending}
                    onClick={() => run(a, 'reject')}
                  >
                    Reject
                  </SecondaryButton>
                </div>
              )
            },
          },
        ]}
      />
    </SettingsCard>
  )
}

function RequestApprovalModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const create = useCreateApprovalRequest()
  const [scope, setScope] = useState<ApprovalScope>('production-deploy')
  const [summary, setSummary] = useState('')

  const submit = () =>
    create.mutate(
      { scope, summary: summary.trim() },
      {
        onSuccess: () => {
          setSummary('')
          setScope('production-deploy')
          create.reset()
          onClose()
        },
      },
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      title="Request approval"
      description="Raise a request for a high-blast-radius action. Someone else with approval rights must approve it."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!summary.trim() || create.isPending} onClick={submit}>
            {create.isPending ? 'Submitting…' : 'Submit request'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Scope</span>
          <SelectField<ApprovalScope>
            value={scope}
            onChange={setScope}
            options={APPROVAL_SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] ?? s }))}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Summary</span>
          <TextField value={summary} onChange={setSummary} placeholder="What needs approving and why" />
        </label>
        {create.isError ? (
          <p className="text-[12px] text-rose-700 dark:text-rose-400">
            {(create.error as Error)?.message ?? 'Could not submit the request.'}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

/* ─────────────────── policy reference ─────────────────── */

function PolicyList({ policies, loading }: { policies: ApprovalPolicy[]; loading: boolean }) {
  const toast = useToast()
  const save = useSaveApprovalPolicy()
  if (loading) {
    return (
      <SettingsCard title="Approval policies">
        <p className="text-[12px] text-content-muted">Loading…</p>
      </SettingsCard>
    )
  }
  const setReq = (a: ApprovalPolicy, next: number) =>
    save.mutate(
      { ...a, approversRequired: Math.max(1, Math.min(5, next)) },
      { onError: (e) => toast.error('Could not update the approval policy', { description: (e as Error)?.message }) },
    )
  return (
    // Policies are saved to the generic document store, which has no
    // CONSOLE_PERMISSIONS entry of its own — editing them is gated on the
    // closest one, approvalsDecide (whoever decides approvals sets the rules).
    <RequirePermission check={CONSOLE_PERMISSIONS.approvalsDecide} readOnly>
      <div className="space-y-3">
        {policies.map((a) => (
          <SettingsCard
            key={a.id}
            title={SCOPE_LABEL[a.scope] ?? a.scope}
            description={a.description}
            actions={
              <ToggleField
                checked={a.enabled}
                label={a.enabled ? 'Enabled' : 'Disabled'}
                onChange={(enabled) => save.mutate({ ...a, enabled }, { onError: (e) => toast.error('Could not update the approval policy', { description: (e as Error)?.message }) })}
              />
            }
          >
            <SettingsRow
              label="Approvers required"
              description="Distinct members who must approve before the action commits."
            >
              <div className="flex items-center gap-2">
                <SecondaryButton
                  onClick={() => setReq(a, a.approversRequired - 1)}
                  disabled={a.approversRequired <= 1 || save.isPending}
                >
                  −
                </SecondaryButton>
                <span className="min-w-6 text-center font-mono text-base font-semibold tabular-nums text-content">
                  {a.approversRequired}
                </span>
                <SecondaryButton
                  onClick={() => setReq(a, a.approversRequired + 1)}
                  disabled={a.approversRequired >= 5 || save.isPending}
                >
                  +
                </SecondaryButton>
                <span className="text-xs text-content-muted">approvals</span>
              </div>
            </SettingsRow>
            <SettingsRow
              label="Approver roles"
              description="Members holding any of these roles can approve. The requester is excluded automatically."
            >
              <div className="flex flex-wrap gap-1.5">
                {a.approverRoles.map((r) => (
                  <span
                    key={r}
                    className="rounded-md bg-surface-sunken px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-content-muted ring-1 ring-edge-subtle"
                  >
                    {roleLabel(r)}
                  </span>
                ))}
              </div>
            </SettingsRow>
          </SettingsCard>
        ))}
      </div>
    </RequirePermission>
  )
}

/** DB-unavailable / fetch-error state — no fake data, ever. */
function StoreErrorState({ error, retry }: { error: unknown; retry(): void }) {
  if (isDbUnavailable(error)) {
    return (
      <EmptyState
        title="Connect a database"
        description="The approval queue persists to Postgres. Set DATABASE_URL for the console server to enable it — no stubbed data is shown."
      />
    )
  }
  return (
    <EmptyState
      title="Couldn't load approvals"
      description={(error as Error)?.message ?? 'Unexpected error.'}
      action={<SecondaryButton onClick={retry}>Retry</SecondaryButton>}
    />
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

export default Approvals
