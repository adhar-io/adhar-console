import { useEffect, useState } from 'react'
import { Button, Checkbox, Field, Input, Select, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { type ScanPolicy, usePolicy, useSavePolicy } from '../../data/security-api.ts'
import { useSecurityParams, useSetSecurityParams } from '../../data/security-nav.ts'
import type { SecurityModel } from '../../data/security-model.ts'
import { Loading, Notice, Section } from './shared.tsx'

const SEVS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const
const SCANNERS = [
  { id: 'vuln', label: 'Vulnerabilities' },
  { id: 'secret', label: 'Secrets' },
  { id: 'misconfig', label: 'Misconfigurations' },
  { id: 'license', label: 'Licenses' },
] as const

const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)

/**
 * Scan policy editor — the platform-wide default (`scan-policy-global` in
 * adhar-system) and per-project overrides (`scan-policy` in the project's
 * namespace). Saved as the signed-in user; the cluster's RBAC has the last word.
 */
export function PolicyEditor({ model }: { model: SecurityModel }) {
  const params = useSecurityParams()
  const setParams = useSetSecurityParams()
  const scope = params.project ?? ''
  const policy = usePolicy(scope || undefined)
  const save = useSavePolicy()
  const toast = useToast()
  const [draft, setDraft] = useState<ScanPolicy | null>(null)
  const [deny, setDeny] = useState('')
  const [warn, setWarn] = useState('')

  const source = scope ? policy.data?.project : policy.data?.global
  useEffect(() => {
    if (!policy.data) return
    const p = scope ? policy.data.effective : policy.data.global.policy
    setDraft(p)
    setDeny(p.licenseDeny.join(', '))
    setWarn(p.licenseWarn.join(', '))
  }, [policy.data, scope])

  if (policy.isLoading || !draft) return <Loading text="Reading scan policy…" />
  if (policy.isError) return <Notice tone="error" title="Couldn't read the scan policy">{policy.error instanceof Error ? policy.error.message : ''}</Notice>
  const canEdit = Boolean(policy.data?.me.canEditPolicy)
  const set = <K extends keyof ScanPolicy>(k: K, v: ScanPolicy[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d))
  // The threshold UI: failing on HIGH means HIGH and everything above it.
  const threshold = SEVS.find((s) => draft.failOnSeverity.includes(s)) ?? ''
  const setThreshold = (t: string) => set('failOnSeverity', t ? SEVS.slice(0, SEVS.indexOf(t as typeof SEVS[number]) + 1).filter((s) => s !== 'UNKNOWN' || t === 'UNKNOWN') : [])

  const submit = async () => {
    try {
      const r = await save.mutateAsync({ scope: scope ? 'project' : 'global', project: scope || undefined, policy: { ...draft, licenseDeny: list(deny), licenseWarn: list(warn) } })
      toast.success('Scan policy saved', { description: r.write.detail })
    } catch (e) {
      toast.error('Could not save the policy', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Policy for" className="w-full sm:w-64">
          <Select value={scope} onChange={(e) => setParams({ project: e.target.value || undefined })}>
            <option value="">Platform default (global)</option>
            {model.projects.names.map((p) => <option key={p} value={p}>Project {p}</option>)}
          </Select>
        </Field>
        <p className="pb-2 text-[12px] text-content-muted">
          {scope
            ? source?.exists
              ? <>Project override in <code>{scope}/scan-policy</code>; unset keys follow the global policy.</>
              : <>No override for {scope} yet — showing the effective (global) policy. Saving creates <code>{scope}/scan-policy</code>.</>
            : policy.data?.global.exists
            ? <>Stored in <code>adhar-system/scan-policy-global</code>.</>
            : <>No global policy exists yet — showing the defaults.</>}
        </p>
        <div className="ml-auto pb-0.5">
          {canEdit ? <Button variant="primary" onClick={submit} loading={save.isPending}>Save policy</Button> : null}
        </div>
      </div>
      {source?.error ? <Notice tone="warn" title="Could not read the stored policy">{source.error}</Notice> : null}
      {!canEdit ? <Notice tone="info" title="Read-only">Changing scan policy needs the platform-admin, platform-engineer or security-admin role.</Notice> : null}

      <fieldset disabled={!canEdit} className="grid gap-5 lg:grid-cols-2">
        <Section title="Gate">
          <div className="space-y-4 rounded-xl border border-edge-default bg-surface-raised p-4">
            <Field label="Fail the build at" hint="This severity and everything above it.">
              <Select value={threshold} onChange={(e) => setThreshold(e.target.value)}>
                <option value="">Never (report only)</option>
                {SEVS.slice(0, 4).map((s) => <option key={s} value={s}>{s.toLowerCase()} and above</option>)}
              </Select>
            </Field>
            <Field label="Mode">
              <div className="grid grid-cols-2 gap-2">
                {(['enforce', 'warn'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={draft.mode === m}
                    onClick={() => set('mode', m)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left text-[12px]',
                      draft.mode === m ? 'border-brand-400 bg-brand-50 text-brand-900 dark:border-brand-500/50 dark:bg-brand-500/15 dark:text-brand-100' : 'border-edge-default text-content',
                    )}
                  >
                    <div className="font-medium">{m === 'enforce' ? 'Enforce' : 'Warn'}</div>
                    <div className="text-[11px] opacity-80">{m === 'enforce' ? 'A failing gate stops the pipeline' : 'Report, never block'}</div>
                  </button>
                ))}
              </div>
            </Field>
            <Checkbox checked={draft.ignoreUnfixed} onChange={(e) => set('ignoreUnfixed', e.currentTarget.checked)} label="Ignore findings without a fix" description="Only fixable vulnerabilities count against the gate." />
            <Checkbox
              checked={draft.manualApproval}
              onChange={(e) => set('manualApproval', e.currentTarget.checked)}
              label="Manual approval instead of failing"
              description="A failing gate pauses the run until a reviewer approves or rejects it in the review queue."
            />
          </div>
        </Section>
        <Section title="Scanners and waivers">
          <div className="space-y-4 rounded-xl border border-edge-default bg-surface-raised p-4">
            <Field label="Scanners">
              <div className="grid grid-cols-2 gap-2">
                {SCANNERS.map((s) => (
                  <Checkbox
                    key={s.id}
                    checked={draft.scanners.includes(s.id)}
                    onChange={(e) => set('scanners', e.currentTarget.checked ? [...draft.scanners, s.id] : draft.scanners.filter((x) => x !== s.id))}
                    label={s.label}
                  />
                ))}
              </div>
            </Field>
            <Field label="Maximum waiver duration (days)" hint="Requests and extensions cannot run longer.">
              <Input type="number" min={1} max={365} value={draft.maxWaiverDays} onChange={(e) => set('maxWaiverDays', Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
            </Field>
          </div>
        </Section>
        <Section title="Licenses">
          <div className="space-y-4 rounded-xl border border-edge-default bg-surface-raised p-4 lg:col-span-2">
            <Field label="Deny" hint="SPDX ids, comma-separated — a denied license fails the gate (with the license scanner on).">
              <Input value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="AGPL-3.0, SSPL-1.0" />
            </Field>
            <Field label="Warn" hint="Reported, never blocking.">
              <Input value={warn} onChange={(e) => setWarn(e.target.value)} placeholder="GPL-2.0, GPL-3.0, LGPL-3.0" />
            </Field>
          </div>
        </Section>
      </fieldset>
    </div>
  )
}
