import { useMemo, useState, type ReactNode } from 'react'
import { DataTable, EmptyState, Modal, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  ENVIRONMENT_KINDS,
  useCloudConnections,
  useDeleteEnvironment,
  useEnvironments,
  useSaveEnvironment,
  type EnvironmentKind,
  type WorkspaceEnvironment,
} from '../data/clouds.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const KIND_LABEL: Record<EnvironmentKind, string> = Object.fromEntries(
  ENVIRONMENT_KINDS.map((k) => [k.value, k.label]),
) as Record<EnvironmentKind, string>

export function Environments() {
  const q = useEnvironments()
  const del = useDeleteEnvironment()
  const [editing, setEditing] = useState<WorkspaceEnvironment | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<WorkspaceEnvironment | null>(null)

  const all = q.data ?? []

  return (
    <ViewShell
      title="Environments"
      description="Deployment targets for this workspace. Promotion rules and protected change windows recorded here are the source of record the delivery pipeline reads — they are enforced by the pipeline once it is wired to this list."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="environments.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton
            onClick={() => {
              setEditing(null)
              setAdding(true)
            }}
          >
            <IconPlus /> New environment
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total" value={all.length} />
        <StatTile label="Production" value={all.filter((e) => e.kind === 'prod').length} tone="warn" />
        <StatTile
          label="Approval required"
          value={all.filter((e) => e.requireApproval).length}
          tone="good"
        />
        <StatTile
          label="Clusters"
          value={new Set(all.map((e) => e.clusterRef).filter(Boolean)).size}
        />
      </div>

      {q.isError ? (
        <StoreErrorBlock error={q.error as Error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <LoadingBlock label="Loading environments…" />
      ) : (
        <SettingsCard title="All environments">
          <div className="overflow-x-auto">
            <DataTable
              rows={all}
              rowKey={(e) => e.id}
              empty={
                <EmptyState
                  title="No environments configured"
                  description="Add a deployment target to record its cluster, namespace, and promotion rules."
                  action={
                    <RequirePermission
                      perm="environments.write"
                      required={['admin', 'owner']}
                      readOnly
                    >
                      <PrimaryButton
                        onClick={() => {
                          setEditing(null)
                          setAdding(true)
                        }}
                      >
                        <IconPlus /> New environment
                      </PrimaryButton>
                    </RequirePermission>
                  }
                />
              }
              columns={[
                {
                  key: 'name',
                  header: 'Environment',
                  cell: (e) => (
                    <div>
                      <div className="font-medium text-content">{e.name}</div>
                      <code className="font-mono text-[11px] text-content-muted">{e.namespace}</code>
                    </div>
                  ),
                },
                {
                  key: 'kind',
                  header: 'Kind',
                  cell: (e) => (
                    <StatusBadge
                      kind={e.kind === 'prod' ? 'failed' : e.kind === 'staging' ? 'progressing' : 'info'}
                    >
                      {KIND_LABEL[e.kind]}
                    </StatusBadge>
                  ),
                },
                {
                  key: 'cluster',
                  header: 'Cluster',
                  cell: (e) => (
                    <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">
                      {e.clusterRef}
                    </code>
                  ),
                },
                {
                  key: 'promote',
                  header: 'Promote from',
                  cell: (e) => {
                    const from = e.promoteFromEnvId
                      ? all.find((x) => x.id === e.promoteFromEnvId)
                      : undefined
                    return from ? from.name : '—'
                  },
                },
                {
                  key: 'rules',
                  header: 'Protection',
                  cell: (e) =>
                    e.requireApproval ? (
                      <div className="text-[11px]">
                        <StatusBadge kind="progressing">Approval required</StatusBadge>
                        {e.approvers.length ? (
                          <div className="mt-1 text-content-muted">{e.approvers.join(', ')}</div>
                        ) : null}
                        {e.windowsCron ? (
                          <div className="mt-0.5 text-content-subtle">
                            Window <code>{e.windowsCron}</code>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <StatusBadge kind="info">Open</StatusBadge>
                    ),
                },
                { key: 'created', header: 'Created', cell: (e) => formatRelative(e.createdAt) },
                {
                  key: 'actions',
                  header: '',
                  cell: (e) => (
                    <RequirePermission
                      perm="environments.write"
                      required={['admin', 'owner']}
                      readOnly
                    >
                      <div className="flex justify-end gap-1.5">
                        <SecondaryButton
                          onClick={() => {
                            setAdding(false)
                            setEditing(e)
                          }}
                        >
                          Edit
                        </SecondaryButton>
                        <SecondaryButton tone="rose" onClick={() => setRemoving(e)}>
                          Delete
                        </SecondaryButton>
                      </div>
                    </RequirePermission>
                  ),
                },
              ]}
            />
          </div>
        </SettingsCard>
      )}

      <EnvironmentModal
        open={adding || editing !== null}
        initial={editing}
        existing={all}
        onClose={() => {
          setAdding(false)
          setEditing(null)
        }}
      />

      <ConfirmDeleteModal
        env={removing}
        pending={del.isPending}
        error={del.isError ? ((del.error as Error)?.message ?? 'Could not delete.') : undefined}
        onCancel={() => {
          setRemoving(null)
          del.reset()
        }}
        onConfirm={() =>
          removing &&
          del.mutate(removing.id, {
            onSuccess: () => setRemoving(null),
          })
        }
      />
    </ViewShell>
  )
}

function EnvironmentModal({
  open,
  initial,
  existing,
  onClose,
}: {
  open: boolean
  initial: WorkspaceEnvironment | null
  existing: WorkspaceEnvironment[]
  onClose(): void
}) {
  const save = useSaveEnvironment()
  const conns = useCloudConnections()

  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<EnvironmentKind>(initial?.kind ?? 'dev')
  const [clusterRef, setClusterRef] = useState(initial?.clusterRef ?? '')
  const [namespace, setNamespace] = useState(initial?.namespace ?? '')
  const [promoteFromEnvId, setPromoteFromEnvId] = useState(initial?.promoteFromEnvId ?? '')
  const [requireApproval, setRequireApproval] = useState(initial?.requireApproval ?? false)
  const [approvers, setApprovers] = useState((initial?.approvers ?? []).join(', '))
  const [windowsCron, setWindowsCron] = useState(initial?.windowsCron ?? '')

  // Re-seed the form whenever the modal opens for a different target.
  const seedKey = `${open}:${initial?.id ?? 'new'}`
  const [lastSeed, setLastSeed] = useState(seedKey)
  if (seedKey !== lastSeed) {
    setLastSeed(seedKey)
    setName(initial?.name ?? '')
    setKind(initial?.kind ?? 'dev')
    setClusterRef(initial?.clusterRef ?? '')
    setNamespace(initial?.namespace ?? '')
    setPromoteFromEnvId(initial?.promoteFromEnvId ?? '')
    setRequireApproval(initial?.requireApproval ?? false)
    setApprovers((initial?.approvers ?? []).join(', '))
    setWindowsCron(initial?.windowsCron ?? '')
    save.reset()
  }

  // Cluster suggestions from registered cloud connections (real, may be empty).
  const clusterOptions = useMemo(() => {
    const names = new Set<string>()
    for (const c of conns.data ?? []) for (const cl of c.clusters) names.add(cl)
    if (clusterRef) names.add(clusterRef)
    return [...names].sort()
  }, [conns.data, clusterRef])

  const canSave =
    name.trim().length > 0 &&
    clusterRef.trim().length > 0 &&
    namespace.trim().length > 0 &&
    !save.isPending

  const submit = () =>
    save.mutate(
      {
        id: initial?.id,
        input: {
          name,
          kind,
          clusterRef,
          namespace,
          promoteFromEnvId: promoteFromEnvId || undefined,
          requireApproval,
          approvers: approvers.split(',').map((a) => a.trim()).filter(Boolean),
          windowsCron: windowsCron || undefined,
        },
      },
      { onSuccess: onClose },
    )

  const promoteOptions = [
    { value: '', label: '— None —' },
    ...existing
      .filter((e) => e.id !== initial?.id)
      .map((e) => ({ value: e.id, label: `${e.name} (${e.kind})` })),
  ]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? 'Edit environment' : 'New environment'}
      description="Deployment target for this workspace. Cluster, namespace, and promotion rules are persisted in the tenant document store."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton onClick={submit} disabled={!canSave}>
            {save.isPending ? 'Saving…' : initial ? 'Save changes' : 'Create environment'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Labeled label="Name">
            <TextField value={name} onChange={setName} placeholder="production-eu" />
          </Labeled>
          <Labeled label="Kind">
            <SelectField<EnvironmentKind> value={kind} onChange={setKind} options={ENVIRONMENT_KINDS} />
          </Labeled>
          <Labeled
            label="Cluster"
            hint={
              clusterOptions.length === 0
                ? 'No cluster names reported yet — type one to record it.'
                : undefined
            }
          >
            <TextField value={clusterRef} onChange={setClusterRef} placeholder="prod-eu-1" mono />
            {clusterOptions.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {clusterOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setClusterRef(c)}
                    className="rounded-md border border-edge-default bg-surface-sunken px-2 py-0.5 font-mono text-[11px] text-content-muted hover:border-edge-strong"
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : null}
          </Labeled>
          <Labeled label="Namespace">
            <TextField value={namespace} onChange={setNamespace} placeholder="app-production" mono />
          </Labeled>
        </div>

        <Labeled label="Promote from" hint="Environment whose changes flow into this one.">
          <SelectField<string>
            value={promoteFromEnvId}
            onChange={setPromoteFromEnvId}
            options={promoteOptions}
          />
        </Labeled>

        <ToggleField
          checked={requireApproval}
          onChange={setRequireApproval}
          label="Require approval to promote"
          description="Gate promotions into this environment on a reviewer's approval."
        />

        {requireApproval ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Labeled label="Approvers" hint="Comma-separated roles or emails.">
              <TextField value={approvers} onChange={setApprovers} placeholder="security, owner" />
            </Labeled>
            <Labeled label="Change window (cron)" hint="Optional — restricts when changes may land.">
              <TextField value={windowsCron} onChange={setWindowsCron} placeholder="0 9-17 * * 1-5" mono />
            </Labeled>
          </div>
        ) : null}

        {save.isError ? (
          <p className="text-[12px] text-rose-700 dark:text-rose-400">
            {(save.error as Error)?.message ?? 'Could not save the environment.'}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

function ConfirmDeleteModal({
  env,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  env: WorkspaceEnvironment | null
  pending: boolean
  error?: string
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      open={env !== null}
      onClose={onCancel}
      title="Delete environment"
      description={
        env
          ? `Removes "${env.name}" and its promotion rules. Workloads already running are not affected; this only removes the recorded target.`
          : ''
      }
      footer={
        <>
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <SecondaryButton tone="rose" disabled={pending} onClick={onConfirm}>
            {pending ? 'Deleting…' : 'Delete environment'}
          </SecondaryButton>
        </>
      }
    >
      {error ? <p className="text-[12px] text-rose-700 dark:text-rose-400">{error}</p> : null}
    </Modal>
  )
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-content-muted">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-[11px] text-content-subtle">{hint}</div> : null}
    </div>
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

export default Environments
