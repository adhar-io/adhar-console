import { useEffect, useState } from 'react'
import { CONSOLE_PERMISSIONS, StatusBadge, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  DEFAULT_SUPPORT_SETTINGS,
  SUPPORT_SOURCES,
  type SupportTicketSettings,
  type TicketSeverity,
  useSaveSupportTicketSettings,
  useSupportStatus,
  useSupportTicketSettings,
} from '../data/preferences.ts'
import { PrimaryButton, SecondaryButton, SelectField, SettingsCard, SettingsRow, TextField, ToggleField } from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const WRITE = CONSOLE_PERMISSIONS.orgUpdate

const SEVERITIES: { value: TicketSeverity; label: string }[] = [
  { value: 'critical', label: 'Critical only' },
  { value: 'high', label: 'High and above' },
  { value: 'medium', label: 'Medium and above' },
  { value: 'low', label: 'Everything that fails' },
]

const num = (v: string, dflt: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/**
 * Support tickets — platform failures become Plane work items carrying their
 * logs, metrics, traces and delivery context; recoveries close them. Lives in
 * the Notification routing view because it is the same question ("where does
 * this event go?") with a richer destination.
 */
export function SupportTicketsCard() {
  const q = useSupportTicketSettings()
  const status = useSupportStatus()
  if (!q.data) return null
  return (
    <SettingsCard
      title="Support tickets"
      description="Open a Plane work item for every platform failure — Argo CD degraded, failed promotions and verifications, rollouts, pipelines, control-plane resources, the autoscaler, OOMKills and critical alerts — with its logs, metrics, traces and delivery context attached. Recurrences comment on the open ticket; recoveries close it."
      actions={
        status.data ? (
          <StatusBadge kind={status.data.planeConfigured && !status.data.disabled ? 'healthy' : 'paused'}>
            {status.data.disabled ? 'disabled on this server' : status.data.planeConfigured ? 'Plane connected' : 'Plane not configured'}
          </StatusBadge>
        ) : null
      }
    >
      <RequirePermission check={WRITE} readOnly>
        <Editor initial={q.data.doc} saved={q.data.saved} updatedAt={q.data.updatedAt} />
      </RequirePermission>
      {status.data?.lastError ? (
        <p className="mt-3 text-[11px] text-rose-700 dark:text-rose-400">
          Last ticket error {formatRelative(status.data.lastError.at)}: {status.data.lastError.message}
        </p>
      ) : null}
    </SettingsCard>
  )
}

function Editor({ initial, saved, updatedAt }: { initial: SupportTicketSettings; saved: boolean; updatedAt?: string }) {
  const save = useSaveSupportTicketSettings()
  const toast = useToast()
  const [d, setD] = useState<SupportTicketSettings>(initial)
  useEffect(() => setD(initial), [initial])
  const dirty = JSON.stringify(d) !== JSON.stringify(initial)
  const set = (patch: Partial<SupportTicketSettings>) => setD((x) => ({ ...x, ...patch }))
  const setEv = (patch: Partial<SupportTicketSettings['evidence']>) => setD((x) => ({ ...x, evidence: { ...x.evidence, ...patch } }))
  const toggleSource = (id: string) => set({ sources: d.sources.includes(id) ? d.sources.filter((s) => s !== id) : [...d.sources, id] })
  const identifierOk = /^[A-Z0-9]{1,12}$/.test(d.defaultProject.identifier)

  return (
    <div>
      <SettingsRow label="Automatic tickets" description="Off still allows “Create support ticket” on a notification.">
        <ToggleField checked={d.enabled} onChange={(v) => set({ enabled: v })} label={d.enabled ? 'On' : 'Off'} />
      </SettingsRow>
      <SettingsRow label="Minimum severity" description="Failures below this never open a ticket on their own.">
        <div className="space-y-2">
          <SelectField<TicketSeverity> value={d.minSeverity} onChange={(v) => set({ minSeverity: v })} options={SEVERITIES} />
          <ToggleField checked={d.includeWarnings} onChange={(v) => set({ includeWarnings: v })} label="Include warnings" description="OOMKilled, Evicted, a scale-up that made no progress." />
          <ToggleField
            checked={d.alertSeverities.includes('warning')}
            onChange={(v) => set({ alertSeverities: v ? ['critical', 'warning'] : ['critical'] })}
            label="Alertmanager warnings too"
            description="Critical alerts always qualify."
          />
        </div>
      </SettingsRow>
      <SettingsRow label="Signals" description="Which platform failures may open tickets.">
        <div className="flex flex-wrap gap-1.5">
          {SUPPORT_SOURCES.map((s) => {
            const on = d.sources.includes(s.id)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => toggleSource(s.id)}
                aria-pressed={on}
                className={
                  on
                    ? 'rounded-full border border-brand-300 bg-brand-50 px-2.5 py-1 text-[12px] font-medium text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
                    : 'rounded-full border border-edge-default px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
                }
              >
                {s.label}
              </button>
            )
          })}
        </div>
      </SettingsRow>
      <SettingsRow
        label="Default Plane project"
        description="Incidents go to the Plane project matching their Adhar project; anything else lands here. Created on first use if it does not exist."
      >
        <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
          <TextField value={d.defaultProject.name} onChange={(v) => set({ defaultProject: { ...d.defaultProject, name: v } })} placeholder="Platform Support" />
          <TextField mono value={d.defaultProject.identifier} onChange={(v) => set({ defaultProject: { ...d.defaultProject, identifier: v.toUpperCase() } })} placeholder="SUP" />
        </div>
        {!identifierOk ? <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">1–12 capital letters or digits.</p> : null}
      </SettingsRow>
      <SettingsRow label="Evidence" description="Read with the console's service account and redacted before it leaves the cluster.">
        <div className="grid grid-cols-2 gap-2 text-[11px] text-content-muted">
          <label className="space-y-1">
            <span>Log lines</span>
            <TextField type="number" value={String(d.evidence.logLines)} onChange={(v) => setEv({ logLines: num(v, 200) })} />
          </label>
          <label className="space-y-1">
            <span>Window (minutes)</span>
            <TextField type="number" value={String(d.evidence.windowMinutes)} onChange={(v) => setEv({ windowMinutes: num(v, 60) })} />
          </label>
          <label className="space-y-1">
            <span>Error traces</span>
            <TextField type="number" value={String(d.evidence.traceLimit)} onChange={(v) => setEv({ traceLimit: num(v, 5) })} />
          </label>
          <label className="space-y-1">
            <span>Comment at most every (minutes)</span>
            <TextField type="number" value={String(d.commentCooldownMinutes)} onChange={(v) => set({ commentCooldownMinutes: num(v, 30) })} />
          </label>
        </div>
        <div className="mt-2 space-y-2">
          <ToggleField checked={d.attachRawEvidence} onChange={(v) => set({ attachRawEvidence: v })} label="Attach full evidence as JSON" />
          <ToggleField checked={d.autoResolve} onChange={(v) => set({ autoResolve: v })} label="Close tickets on recovery" />
        </div>
      </SettingsRow>
      <RequirePermission check={WRITE}>
        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-content-subtle">{saved && updatedAt ? `Saved ${formatRelative(updatedAt)}` : 'Defaults — not saved yet'}</span>
          <SecondaryButton disabled={!dirty || save.isPending} onClick={() => setD(saved ? initial : DEFAULT_SUPPORT_SETTINGS)}>
            Reset
          </SecondaryButton>
          <PrimaryButton
            disabled={!dirty || !identifierOk || save.isPending}
            onClick={() =>
              save.mutate(d, {
                onSuccess: () => toast.success('Support ticket settings saved'),
                onError: (e) => toast.error('Could not save support ticket settings', { description: (e as Error)?.message }),
              })}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </RequirePermission>
    </div>
  )
}
