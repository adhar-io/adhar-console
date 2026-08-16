import { useState } from 'react'
import { DataTable, EmptyState, Modal, StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { ROLE_LABEL, type Role } from '../data/access.ts'
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
  'role-grant-owner': 'Grant Owner role',
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
      required={['admin', 'security', 'owner']}
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

          <ApprovalQueue
            requests={all}
            selfId={me.data?.userId}
            canDecide={me.data?.role === 'owner' || me.data?.role === 'admin'}
          />

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
  canDecide,
}: {
  requests: ApprovalRequest[]
  selfId?: string
  canDecide: boolean
}) {
  const decide = useDecideApproval()
  return (
    <SettingsCard title="Approval requests" description="Newest first. Segregation of duty is enforced server-side.">
      {decide.isError ? (
        <p className="mb-3 text-[12px] text-rose-700 dark:text-rose-400">
          {(decide.error as Error)?.message}
        </p>
      ) : null}
      <DataTable
        rows={requests}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No approval requests" description="Raise one with the button above." compact />}
        columns={[
          {
            key: 'scope',
            header: 'Request',
            cell: (a) => (
              <div>
                <div className="font-medium text-content">{SCOPE_LABEL[a.scope] ?? a.scope}</div>
                <div className="text-[11px] text-content-muted">{a.summary}</div>
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
              if (!canDecide || ownRequest) {
                return (
                  <span className="text-[11px] text-content-subtle">
                    {ownRequest ? 'awaiting another approver' : 'view only'}
                  </span>
                )
              }
              return (
                <div className="flex justify-end gap-1.5">
                  <SecondaryButton
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: a.id, decision: 'approve' })}
                  >
                    Approve
                  </SecondaryButton>
                  <SecondaryButton
                    tone="rose"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: a.id, decision: 'reject' })}
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
      description="Raise a request for a high-blast-radius action. Another admin or owner must approve it."
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
  const save = useSaveApprovalPolicy()
  if (loading) {
    return (
      <SettingsCard title="Approval policies">
        <p className="text-[12px] text-content-muted">Loading…</p>
      </SettingsCard>
    )
  }
  const setReq = (a: ApprovalPolicy, next: number) =>
    save.mutate({ ...a, approversRequired: Math.max(1, Math.min(5, next)) })
  return (
    <RequirePermission perm="approvals.write" required={['security', 'owner']} readOnly>
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
                onChange={(enabled) => save.mutate({ ...a, enabled })}
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
                    {ROLE_LABEL[r as Role] ?? r}
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
