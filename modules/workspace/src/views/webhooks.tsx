import { useEffect, useState } from 'react'
import { DataTable, EmptyState, Modal, StatusBadge } from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import type { workspace } from '@adhar-console/api-clients'
import {
  useDeleteWebhook,
  useSaveWebhook,
  useTestWebhook,
  useWebhookDeliveries,
  useWebhooks,
} from '../data/settings.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

type Webhook = workspace.Webhook

/** Selectable outbound events. */
const EVENT_CATALOG: { id: string; label: string }[] = [
  { id: 'deployment.succeeded', label: 'Deployment succeeded' },
  { id: 'deployment.failed', label: 'Deployment failed' },
  { id: 'rollout.paused', label: 'Rollout paused' },
  { id: 'rollout.promoted', label: 'Rollout promoted' },
  { id: 'member.invited', label: 'Member invited' },
  { id: 'member.removed', label: 'Member removed' },
  { id: 'budget.exceeded', label: 'Budget exceeded' },
  { id: 'security.alert', label: 'Security alert' },
]

export function Webhooks() {
  const q = useWebhooks()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Webhook | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; status: string; at: string } | null>(null)

  const del = useDeleteWebhook()
  const test = useTestWebhook()

  const all = q.data ?? []
  const active = all.filter((w) => w.active).length
  const failed = all.filter((w) => w.lastDeliveryStatus && w.lastDeliveryStatus !== 'success').length

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (w: Webhook) => {
    setEditing(w)
    setEditorOpen(true)
  }
  const runTest = (w: Webhook) => {
    setTestResult(null)
    test.mutate(w.id, {
      onSuccess: (d) => setTestResult({ id: w.id, status: d.status, at: d.at }),
    })
  }

  return (
    <ViewShell
      title="Webhooks"
      description="Outbound event delivery to Slack, PagerDuty, or custom endpoints. Every payload is signed with a shared secret (HMAC-SHA256)."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="webhooks.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton onClick={openCreate}>
            <IconPlus /> Add webhook
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Webhooks" value={all.length} />
        <StatTile label="Active" value={active} tone="good" />
        <StatTile label="Last delivery failed" value={failed} tone={failed ? 'warn' : 'good'} />
        <StatTile label="Signing" value="HMAC-SHA256" />
      </div>

      <SettingsCard title="Endpoints">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(w) => w.id}
          empty={<EmptyState title="No webhooks configured" />}
          columns={[
            {
              key: 'url',
              header: 'URL',
              cell: (w) => (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content">
                  {w.url}
                </code>
              ),
            },
            {
              key: 'events',
              header: 'Events',
              cell: (w) => (
                <div className="flex flex-wrap gap-1">
                  {w.events.map((e) => (
                    <code
                      key={e}
                      className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
                    >
                      {e}
                    </code>
                  ))}
                </div>
              ),
            },
            {
              key: 'active',
              header: 'State',
              cell: (w) => (
                <StatusBadge kind={w.active ? 'healthy' : 'unknown'}>
                  {w.active ? 'active' : 'disabled'}
                </StatusBadge>
              ),
            },
            {
              key: 'last',
              header: 'Last delivery',
              cell: (w) =>
                w.lastDeliveryAt ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-content-muted">
                      {formatRelative(w.lastDeliveryAt)}
                    </span>
                    <StatusBadge kind={w.lastDeliveryStatus === 'success' ? 'healthy' : 'failed'}>
                      {w.lastDeliveryStatus ?? '—'}
                    </StatusBadge>
                  </div>
                ) : (
                  '—'
                ),
            },
            {
              key: 'actions',
              header: '',
              cell: (w) => (
                <RequirePermission perm="webhooks.write" required={['admin', 'owner']} readOnly>
                  <div className="flex justify-end gap-1.5">
                    <SecondaryButton
                      disabled={test.isPending && test.variables === w.id}
                      onClick={() => runTest(w)}
                    >
                      {test.isPending && test.variables === w.id ? 'Testing…' : 'Test'}
                    </SecondaryButton>
                    <SecondaryButton onClick={() => openEdit(w)}>Edit</SecondaryButton>
                    <SecondaryButton
                      tone="rose"
                      disabled={del.isPending && del.variables === w.id}
                      onClick={() => del.mutate(w.id)}
                    >
                      Delete
                    </SecondaryButton>
                  </div>
                </RequirePermission>
              ),
            },
          ]}
        />
        {testResult ? (
          <div
            className={cn(
              'mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]',
              testResult.status === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-rose-200 bg-rose-50 text-rose-800',
            )}
          >
            <StatusBadge kind={testResult.status === 'success' ? 'healthy' : 'failed'}>
              {testResult.status}
            </StatusBadge>
            Test event delivered {formatRelative(testResult.at)} ·{' '}
            <span className="font-mono">
              {all.find((w) => w.id === testResult.id)?.url ?? testResult.id}
            </span>
          </div>
        ) : null}
      </SettingsCard>

      <RecentDeliveries webhooks={all} />

      <WebhookEditor open={editorOpen} initial={editing} onClose={() => setEditorOpen(false)} />
    </ViewShell>
  )
}

/* ─────────────────── Recent deliveries ─────────────────── */

function RecentDeliveries({ webhooks }: { webhooks: Webhook[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const active = selected ?? webhooks[0]?.id ?? null
  const deliveries = useWebhookDeliveries(active)
  const rows = deliveries.data ?? []

  return (
    <SettingsCard
      title="Recent deliveries"
      description="Simulated delivery attempts from the most recent test events."
      actions={
        webhooks.length ? (
          <select
            value={active ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            className="h-8 rounded-lg border border-edge-default bg-white px-2 text-[12px] text-content shadow-sm focus:border-brand-400 focus:outline-none"
          >
            {webhooks.map((w) => (
              <option key={w.id} value={w.id}>
                {w.url}
              </option>
            ))}
          </select>
        ) : null
      }
    >
      <DataTable
        rows={rows}
        rowKey={(d) => d.id}
        empty={<EmptyState title="No deliveries yet" description="Send a test event to see delivery attempts here." />}
        columns={[
          {
            key: 'event',
            header: 'Event',
            cell: (d) => <code className="font-mono text-[11px] text-content">{d.event}</code>,
          },
          {
            key: 'status',
            header: 'Result',
            cell: (d) => (
              <div className="flex items-center gap-2">
                <StatusBadge kind={d.status === 'success' ? 'healthy' : 'failed'}>
                  {d.status}
                </StatusBadge>
                <span className="font-mono text-[11px] text-content-muted">HTTP {d.statusCode}</span>
              </div>
            ),
          },
          { key: 'dur', header: 'Duration', cell: (d) => `${d.durationMs} ms` },
          { key: 'at', header: 'When', cell: (d) => formatRelative(d.at) },
        ]}
      />
    </SettingsCard>
  )
}

/* ─────────────────── Editor modal ─────────────────── */

function WebhookEditor({
  open,
  initial,
  onClose,
}: {
  open: boolean
  initial: Webhook | null
  onClose(): void
}) {
  const save = useSaveWebhook()
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<Set<string>>(new Set())
  const [activeState, setActiveState] = useState(true)
  const [secret, setSecret] = useState('')

  useEffect(() => {
    if (!open) return
    setUrl(initial?.url ?? '')
    setEvents(new Set(initial?.events ?? []))
    setActiveState(initial?.active ?? true)
    setSecret('')
    save.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])

  const toggleEvent = (id: string) =>
    setEvents((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const validUrl = /^https?:\/\/.+/.test(url.trim())
  const canSave = validUrl && events.size > 0 && !save.isPending

  const submit = () =>
    save.mutate(
      {
        id: initial?.id,
        input: {
          url: url.trim(),
          events: EVENT_CATALOG.filter((e) => events.has(e.id)).map((e) => e.id),
          active: activeState,
          secret: secret.trim() || undefined,
        },
      },
      { onSuccess: onClose },
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      width="lg"
      title={initial ? 'Edit webhook' : 'Add webhook'}
      description="Deliver signed events to an external endpoint."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!canSave} onClick={submit}>
            {save.isPending ? 'Saving…' : initial ? 'Save changes' : 'Create webhook'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Payload URL</span>
          <TextField type="url" value={url} onChange={setUrl} placeholder="https://hooks.example.com/…" mono />
          {url && !validUrl ? (
            <span className="mt-1 block text-[11px] text-rose-600">Must be a valid http(s) URL.</span>
          ) : null}
        </label>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-content">Events</span>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {EVENT_CATALOG.map((e) => {
              const on = events.has(e.id)
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => toggleEvent(e.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors',
                    on
                      ? 'border-brand-300 bg-brand-50 text-brand-900'
                      : 'border-edge-default bg-white text-content-muted hover:bg-surface-sunken',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      on ? 'border-brand-500 bg-brand-600 text-white' : 'border-edge-strong bg-white',
                    )}
                  >
                    {on ? (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{e.label}</span>
                    <span className="block font-mono text-[10px] text-content-subtle">{e.id}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">
            Signing secret {initial?.secretSet ? <span className="text-content-subtle">(set — leave blank to keep)</span> : null}
          </span>
          <TextField
            type="password"
            value={secret}
            onChange={setSecret}
            placeholder={initial?.secretSet ? '•••••••• (unchanged)' : 'Optional HMAC-SHA256 secret'}
            mono
          />
        </label>

        <ToggleField
          checked={activeState}
          onChange={setActiveState}
          label="Active"
          description="Deliver events to this endpoint."
        />

        {save.isError ? (
          <p className="text-[12px] text-rose-700">
            {(save.error as Error)?.message ?? 'Could not save the webhook.'}
          </p>
        ) : null}
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

export default Webhooks
