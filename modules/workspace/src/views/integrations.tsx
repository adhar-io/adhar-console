import { useEffect, useState } from 'react'
import { CONSOLE_PERMISSIONS, EmptyState, Modal, StatusBadge, useCan, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  INTEGRATION_TYPES,
  useDeleteIntegration,
  useIntegrations,
  useSaveIntegration,
  useTestIntegration,
  type Integration,
  type IntegrationType,
} from '../data/security.ts'
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

/**
 * Integration configs are docStore writes (`/api/store/workspace.integration`)
 * with no dedicated catalogue entry — organisation settings, so they need
 * `update organizations`. "Test" records its outcome on the same document, so
 * it takes the same gate.
 */
const WRITE = CONSOLE_PERMISSIONS.orgUpdate

export function Integrations() {
  const toast = useToast()
  const q = useIntegrations()
  const del = useDeleteIntegration()
  const test = useTestIntegration()
  const canWrite = useCan(WRITE)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Integration | null>(null)

  const all = q.data ?? []
  const enabled = all.filter((i) => i.enabled).length
  const lastFailed = all.filter((i) => i.lastTestOk === false).length

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (i: Integration) => {
    setEditing(i)
    setEditorOpen(true)
  }

  return (
    <ViewShell
      title="Integrations"
      description="Third-party integration configs persisted in the tenant document store. The status shown is the outcome of the last real connectivity test from your browser — never a simulated health probe."
      writeCheck={WRITE}
      actions={
        <RequirePermission check={WRITE}>
          <PrimaryButton onClick={openCreate}>
            <IconPlus /> Add integration
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Configured" value={all.length} />
        <StatTile label="Enabled" value={enabled} tone="good" />
        <StatTile label="Last test failed" value={lastFailed} tone={lastFailed ? 'warn' : 'good'} />
        <StatTile
          label="Untested"
          value={all.filter((i) => i.lastTestOk === undefined).length}
          hint="no connectivity test run yet"
        />
      </div>

      {q.isError ? (
        <StoreErrorBlock error={q.error as Error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <LoadingBlock label="Loading integrations…" />
      ) : (
        <SettingsCard title="Connections">
          {all.length === 0 ? (
            <EmptyState
              title="No integrations configured"
              description={
                canWrite
                  ? 'Add Slack, PagerDuty, GitHub, or a custom HTTP integration. Configs persist per tenant; secrets are stored masked.'
                  : 'Nothing is connected yet. Ask a workspace admin to add Slack, PagerDuty, GitHub, or a custom HTTP integration.'
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {all.map((i) => (
                <div
                  key={i.id}
                  className="min-w-0 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm transition-colors hover:border-edge-strong"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-content" title={i.name}>{i.name}</div>
                      <code className="mt-0.5 block truncate font-mono text-[11px] text-content-muted">
                        {i.baseUrl ?? 'no URL configured'}
                      </code>
                    </div>
                    <TestBadge integration={i} />
                  </div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                    <KV label="Type" value={INTEGRATION_TYPES.find((t) => t.value === i.type)?.label ?? i.type} />
                    <KV label="State" value={i.enabled ? 'enabled' : 'disabled'} />
                    <KV label="Token" value={i.tokenMasked ?? 'not set'} />
                  </div>
                  {i.lastTestDetail ? (
                    <p className="mt-2 break-words text-[11px] text-content-subtle">
                      Last test {i.lastTestAt ? formatRelative(i.lastTestAt) : ''}: {i.lastTestDetail}
                    </p>
                  ) : null}
                  <RequirePermission check={WRITE}>
                    <div className="mt-3 flex items-center justify-end gap-1.5">
                      <SecondaryButton
                        disabled={!i.baseUrl || (test.isPending && test.variables?.id === i.id)}
                        onClick={() =>
                          test.mutate(i, {
                            onSuccess: (res) =>
                              res.ok
                                ? toast.success(`${i.name} is reachable`, { description: res.detail })
                                : toast.error(`${i.name} is not reachable`, { description: res.detail }),
                            onError: (e) => toast.error(`Could not test ${i.name}`, { description: (e as Error)?.message }),
                          })}
                      >
                        {test.isPending && test.variables?.id === i.id ? 'Testing…' : 'Test'}
                      </SecondaryButton>
                      <SecondaryButton onClick={() => openEdit(i)}>Configure</SecondaryButton>
                      <SecondaryButton
                        tone="rose"
                        disabled={del.isPending && del.variables === i.id}
                        onClick={() => del.mutate(i.id, { onError: (e) => toast.error(`Could not delete ${i.name}`, { description: (e as Error)?.message }) })}
                      >
                        Delete
                      </SecondaryButton>
                    </div>
                  </RequirePermission>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      )}

      {canWrite ? (
        <IntegrationEditor open={editorOpen} initial={editing} onClose={() => setEditorOpen(false)} />
      ) : null}
    </ViewShell>
  )
}

function TestBadge({ integration: i }: { integration: Integration }) {
  if (i.lastTestOk === undefined) return <StatusBadge kind="unknown">untested</StatusBadge>
  return (
    <StatusBadge kind={i.lastTestOk ? 'healthy' : 'failed'}>
      {i.lastTestOk ? 'reachable' : 'unreachable'}
    </StatusBadge>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-surface-sunken px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[12px] font-medium text-content">{value}</div>
    </div>
  )
}

/* ─────────────────── Editor modal ─────────────────── */

function IntegrationEditor({
  open,
  initial,
  onClose,
}: {
  open: boolean
  initial: Integration | null
  onClose(): void
}) {
  const save = useSaveIntegration()
  const toast = useToast()
  const [type, setType] = useState<IntegrationType>('slack')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [notes, setNotes] = useState('')
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (!open) return
    setType(initial?.type ?? 'slack')
    setName(initial?.name ?? '')
    setBaseUrl(initial?.baseUrl ?? '')
    setToken('')
    setNotes(initial?.notes ?? '')
    setEnabled(initial?.enabled ?? true)
    save.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])

  const urlOk = !baseUrl.trim() || /^https?:\/\/.+/.test(baseUrl.trim())
  const canSave = name.trim().length > 0 && urlOk && !save.isPending

  const submit = () =>
    save.mutate(
      {
        id: initial?.id,
        input: {
          type,
          name: name.trim(),
          enabled,
          baseUrl: baseUrl.trim() || undefined,
          token: token.trim() || undefined,
          notes: notes.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          toast.success(initial ? 'Integration saved' : 'Integration added')
          onClose()
        },
        onError: (e) => toast.error('Could not save the integration', { description: (e as Error)?.message }),
      },
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      width="lg"
      title={initial ? 'Configure integration' : 'Add integration'}
      description="Config metadata only — tokens are masked before they are persisted; the console never stores the plaintext secret."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!canSave} onClick={submit}>
            {save.isPending ? 'Saving…' : initial ? 'Save changes' : 'Add integration'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Type</span>
            <SelectField<IntegrationType> value={type} onChange={setType} options={INTEGRATION_TYPES} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Name</span>
            <TextField value={name} onChange={setName} placeholder="Slack — #alerts" />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">
            Base / health URL <span className="text-content-subtle">(used by the connectivity test)</span>
          </span>
          <TextField
            mono
            type="url"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://hooks.slack.com/services/…"
          />
          {!urlOk ? (
            <span className="mt-1 block text-[11px] text-rose-600 dark:text-rose-400">
              Must be a valid http(s) URL.
            </span>
          ) : null}
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">
            API token{' '}
            {initial?.tokenMasked ? (
              <span className="text-content-subtle">(set: {initial.tokenMasked} — leave blank to keep)</span>
            ) : (
              <span className="text-content-subtle">(optional)</span>
            )}
          </span>
          <TextField
            type="password"
            mono
            value={token}
            onChange={setToken}
            placeholder={initial?.tokenMasked ? '•••••••• (unchanged)' : 'Stored masked (last 4 only)'}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">
            Notes <span className="text-content-subtle">(optional)</span>
          </span>
          <TextField value={notes} onChange={setNotes} placeholder="Routing, ownership, escalation…" />
        </label>

        <ToggleField
          checked={enabled}
          onChange={setEnabled}
          label="Enabled"
          description="Marks this integration active for the workspace."
        />

      </div>
    </Modal>
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

export default Integrations
