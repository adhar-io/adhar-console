import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, useToast } from '@adhar/shell-ui'
import {
  describeWrites,
  type GateDecisionInput,
  type GateView,
  type Me,
  SCOPE_LABEL,
  useBulkWaivers,
  useDecideGate,
  usePolicy,
  useRequestWaiver,
  useWaiverAction,
  VEX_JUSTIFICATION_LABEL,
  VEX_STATUS_LABEL,
  type VexJustification,
  type VexStatus,
  type Waiver,
  type WaiverKind,
  type WaiverScope,
} from '../../data/security-api.ts'
import { useScanGovernanceAccess } from '../../data/security-access.ts'
import { shortDigest } from './shared.tsx'

const DAY = 86_400_000
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)
/** End of the chosen day, UTC — a waiver "until 2026-11-20" covers that whole day. */
const endOfDay = (d: string) => new Date(`${d}T23:59:59Z`).toISOString()
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface WaiverTargetOption {
  project: string
  app?: string
  env?: string
  digest?: string
  image?: string
  repo?: string
}

export interface WaiverPreset {
  kind: WaiverKind
  findingId: string
  severity?: string
  title?: string
  package?: string
  purl?: string
  version?: string
  path?: string
  /** Where the finding occurs — the scopes offered are built from these. */
  targets: WaiverTargetOption[]
  falsePositive?: boolean
  defaultScope?: WaiverScope
}

/* ───────────────────────────── request ───────────────────────────── */

export function RequestWaiverModal({ preset, onClose }: { preset: WaiverPreset | null; onClose(): void }) {
  if (!preset) return null
  return <RequestWaiverForm preset={preset} onClose={onClose} />
}

function RequestWaiverForm({ preset, onClose }: { preset: WaiverPreset; onClose(): void }) {
  const toast = useToast()
  const request = useRequestWaiver()
  const targets = preset.targets.length ? preset.targets : []
  const projects = [...new Set(targets.map((t) => t.project))]
  const withDigest = targets.filter((t) => t.digest && t.app)
  const withApp = targets.filter((t) => t.app)
  const scopes: WaiverScope[] = [
    ...(preset.kind === 'vuln' && withDigest.length ? ['digest' as const] : []),
    ...(withApp.length ? ['app' as const] : []),
    'project',
    'platform',
  ]
  const [scope, setScope] = useState<WaiverScope>(preset.defaultScope && scopes.includes(preset.defaultScope) ? preset.defaultScope : scopes.includes('app') ? 'app' : 'project')
  const choices = scope === 'digest' ? withDigest : scope === 'app' ? uniqBy(withApp, (t) => `${t.project}/${t.app}`) : uniqBy(targets, (t) => t.project)
  const [pick, setPick] = useState(0)
  const target = choices[Math.min(pick, Math.max(0, choices.length - 1))] ?? { project: projects[0] ?? '' }
  const policy = usePolicy(target.project || undefined)
  const maxDays = policy.data?.effective.maxWaiverDays ?? 90
  const [expires, setExpires] = useState(() => isoDate(Date.now() + 30 * DAY))
  const [narrow, setNarrow] = useState(Boolean(preset.package))
  const [justification, setJustification] = useState('')
  const [vexStatus, setVexStatus] = useState<VexStatus>(preset.falsePositive ? 'not_affected' : preset.kind === 'vuln' ? 'not_affected' : 'affected')
  const [vexJust, setVexJust] = useState<VexJustification | ''>(preset.falsePositive ? 'vulnerable_code_not_present' : '')
  const [impact, setImpact] = useState('')

  useEffect(() => setPick(0), [scope])
  // Keep the default inside the policy maximum once it is known.
  useEffect(() => {
    const max = Date.now() + maxDays * DAY
    if (Date.parse(endOfDay(expires)) > max) setExpires(isoDate(max - DAY))
  }, [maxDays]) // eslint-disable-line react-hooks/exhaustive-deps

  const expMs = Date.parse(endOfDay(expires))
  const tooLong = expMs - Date.now() > maxDays * DAY + DAY
  const past = !(expMs > Date.now())
  const vexInvalid = vexStatus === 'not_affected' && !vexJust
  const shortJust = justification.trim().length < 10
  const invalid = past || tooLong || vexInvalid || shortJust || !target.project

  const submit = async () => {
    try {
      const res = await request.mutateAsync({
        kind: preset.kind,
        scope,
        target: {
          project: target.project,
          ...(scope === 'app' || scope === 'digest' ? { app: target.app } : {}),
          ...(scope === 'digest' ? { digest: target.digest, image: target.image, repo: target.repo } : {}),
          ...(narrow && preset.package ? { package: preset.package, purl: preset.purl, version: preset.version } : {}),
          ...(preset.path ? { path: preset.path } : {}),
        },
        findingId: preset.findingId,
        severity: preset.severity,
        title: preset.title,
        justification: justification.trim(),
        vex: { status: vexStatus, ...(vexJust ? { justification: vexJust } : {}), ...(impact.trim() ? { impact: impact.trim() } : {}) },
        falsePositive: preset.falsePositive,
        expiresAt: endOfDay(expires),
      })
      toast.success(preset.falsePositive ? 'False positive submitted for review' : 'Waiver requested', {
        description: `${res.item.findingId} — a security reviewer must approve it before CI honours it.`,
      })
      onClose()
    } catch (e) {
      toast.error('Could not request the waiver', { description: errText(e) })
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={preset.falsePositive ? 'Mark as false positive' : preset.kind === 'license' ? 'Request a license waiver' : 'Request a waiver'}
      description={
        <span className="font-mono text-[12px]">
          {preset.findingId}
          {preset.package ? ` · ${preset.package}${preset.version ? `@${preset.version}` : ''}` : ''}
        </span>
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={request.isPending} disabled={invalid}>
            Submit for review
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Scope" hint="The narrowest scope that covers the risk is the safest one.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {scopes.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
                className={
                  scope === s
                    ? 'rounded-lg border border-brand-400 bg-brand-50 px-2 py-2 text-left text-[12px] font-medium text-brand-900 dark:border-brand-500/50 dark:bg-brand-500/15 dark:text-brand-100'
                    : 'rounded-lg border border-edge-default bg-surface-raised px-2 py-2 text-left text-[12px] text-content hover:border-edge-strong'
                }
              >
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
        </Field>
        {scope !== 'platform' && choices.length > 1 ? (
          <Field label={scope === 'digest' ? 'Image' : scope === 'app' ? 'App' : 'Project'}>
            <Select value={String(pick)} onChange={(e) => setPick(Number(e.target.value))}>
              {choices.map((t, i) => (
                <option key={i} value={i}>
                  {scope === 'digest' ? `${t.project}/${t.app} · ${t.env ?? ''} · ${shortDigest(t.digest)}` : scope === 'app' ? `${t.project}/${t.app}` : t.project}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-[12px] text-content-muted">
            {scope === 'platform'
              ? 'Applies to every project on the platform (requested from ' + (target.project || 'this project') + ').'
              : scope === 'digest'
              ? `${target.project}/${target.app} at ${shortDigest(target.digest)} only — a rebuilt image is scanned afresh.`
              : scope === 'app'
              ? `Every image of ${target.project}/${target.app}.`
              : `Every app of project ${target.project}.`}
          </p>
        )}
        {preset.package ? (
          <Checkbox
            checked={narrow}
            onChange={(e) => setNarrow(e.currentTarget.checked)}
            label={`Only in ${preset.package}`}
            description="Untick to waive this id in every package (rarely right)."
          />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="VEX status" required>
            <Select value={vexStatus} onChange={(e) => setVexStatus(e.target.value as VexStatus)}>
              {(Object.keys(VEX_STATUS_LABEL) as VexStatus[]).map((s) => <option key={s} value={s}>{VEX_STATUS_LABEL[s]}</option>)}
            </Select>
          </Field>
          <Field label="VEX justification" required={vexStatus === 'not_affected'} error={vexInvalid ? 'Required for "not affected"' : undefined}>
            <Select value={vexJust} onChange={(e) => setVexJust(e.target.value as VexJustification | '')}>
              <option value="">—</option>
              {(Object.keys(VEX_JUSTIFICATION_LABEL) as VexJustification[]).map((s) => <option key={s} value={s}>{VEX_JUSTIFICATION_LABEL[s]}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Justification" required hint="What makes this acceptable, and what would change the answer." error={justification && shortJust ? 'At least 10 characters' : undefined}>
          <Textarea rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="e.g. The vulnerable parser is never fed untrusted input — requests are validated at the gateway." />
        </Field>
        {vexStatus === 'affected' ? (
          <Field label="Impact / mitigation (optional)">
            <Input value={impact} onChange={(e) => setImpact(e.target.value)} placeholder="Compensating control, upgrade plan…" />
          </Field>
        ) : null}
        <Field
          label="Expires"
          required
          hint={`Policy maximum: ${maxDays} days${policy.data?.project?.exists ? ` (project ${target.project})` : policy.data?.global.exists ? ' (global policy)' : ' (default)'}.`}
          error={past ? 'Must be in the future' : tooLong ? `At most ${maxDays} days` : undefined}
        >
          <Input type="date" value={expires} min={isoDate(Date.now() + DAY)} max={isoDate(Date.now() + maxDays * DAY)} onChange={(e) => setExpires(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function uniqBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>()
  return xs.filter((x) => {
    const k = key(x)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/* ───────────────────────────── decisions ───────────────────────────── */

export type DecisionMode = 'approve' | 'reject' | 'revoke' | 'withdraw'

const MODE_TEXT: Record<DecisionMode, { title: string; button: string; variant: 'primary' | 'danger'; needsComment: boolean }> = {
  approve: { title: 'Approve', button: 'Approve', variant: 'primary', needsComment: false },
  reject: { title: 'Reject', button: 'Reject', variant: 'danger', needsComment: true },
  revoke: { title: 'Revoke', button: 'Revoke', variant: 'danger', needsComment: true },
  withdraw: { title: 'Withdraw', button: 'Withdraw request', variant: 'danger', needsComment: false },
}

const PAST: Record<DecisionMode, string> = { approve: 'Approved', reject: 'Rejected', revoke: 'Revoked', withdraw: 'Withdrew' }

/** Confirm a decision on one or more waivers, with the comment that goes into their audit trail. */
export function DecisionModal({ mode, waivers, me, onClose, onDone }: { mode: DecisionMode | null; waivers: Waiver[]; me?: Me; onClose(): void; onDone?(): void }) {
  const toast = useToast()
  const one = useWaiverAction()
  const many = useBulkWaivers()
  const [comment, setComment] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => {
    setComment('')
    setReason('')
  }, [mode, waivers.length])
  const own = useMemo(() => waivers.filter((w) => me && w.requestedBy.id === me.id), [waivers, me])
  // Break-glass: RBAC `self-approve scan-waivers` lets a requester approve their own waiver (with a reason).
  const { canSelfApprove } = useScanGovernanceAccess()
  if (!mode || !waivers.length) return null
  const t = MODE_TEXT[mode]
  const selfBlocked = mode === 'approve' && own.length > 0 && !canSelfApprove
  const needsReason = mode === 'approve' && own.length > 0 && canSelfApprove
  const invalid = (t.needsComment && !comment.trim()) || selfBlocked || (needsReason && reason.trim().length < 10)
  const busy = one.isPending || many.isPending

  const submit = async () => {
    try {
      if (waivers.length === 1 || needsReason) {
        // Self-approval needs its reason per record, so it never goes through bulk.
        let writesOk = true
        let text: string | undefined
        for (const w of waivers) {
          const r = await one.mutateAsync({ id: w.id, action: mode, comment: comment.trim() || undefined, ...(needsReason && own.includes(w) ? { selfApproveReason: reason.trim() } : {}) })
          const d = describeWrites(r.writes)
          writesOk &&= d.ok
          text = d.text ?? text
        }
        if (writesOk) toast.success(`${PAST[mode]} ${waivers.length === 1 ? waivers[0].findingId : `${waivers.length} waivers`}`, { description: text })
        else toast.warning(`${t.title} recorded — cluster update failed`, { description: text, duration: 0 })
      } else {
        const r = await many.mutateAsync({ ids: waivers.map((w) => w.id), action: mode as 'approve' | 'reject' | 'revoke', comment: comment.trim() || undefined })
        const failed = r.results.filter((x) => !x.ok)
        const d = describeWrites(r.writes)
        if (failed.length) toast.warning(`${r.results.length - failed.length} of ${r.results.length} done`, { description: failed.map((f) => `${f.id}: ${f.detail}`).join('\n'), duration: 0 })
        else if (!d.ok) toast.warning(`${t.title} recorded — cluster update failed`, { description: d.text, duration: 0 })
        else toast.success(`${PAST[mode]} ${waivers.length} waivers`, { description: d.text })
      }
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(`Could not ${mode}`, { description: errText(e) })
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t.title} ${waivers.length === 1 ? 'waiver' : `${waivers.length} waivers`}`}
      description={waivers.length === 1 ? `${waivers[0].findingId} · ${SCOPE_LABEL[waivers[0].scope]} · ${waivers[0].target.project}${waivers[0].target.app ? `/${waivers[0].target.app}` : ''}` : 'The same comment is recorded on each.'}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={t.variant} onClick={submit} loading={busy} disabled={invalid}>{t.button}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        {mode === 'approve' ? (
          <p className="text-[12px] text-content-muted">
            Approved waivers are written to the project's <code>scan-waivers</code> ConfigMap with your cluster permissions, and CI stops failing on them until they expire.
          </p>
        ) : mode === 'revoke' ? (
          <p className="text-[12px] text-content-muted">The finding counts against the scan gate again from the next pipeline run.</p>
        ) : null}
        {selfBlocked ? (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-[12px] text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
            {own.length === waivers.length ? 'You requested this — another reviewer must approve it.' : `${own.length} of these are your own requests; deselect them, another reviewer must approve them.`}
          </p>
        ) : null}
        {needsReason ? (
          <Field label="Self-approval reason" required hint="Platform admins may approve their own request; the reason is kept in the audit trail.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why no other reviewer can decide this" />
          </Field>
        ) : null}
        <Field label="Comment" required={t.needsComment}>
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={mode === 'reject' ? 'What would make it acceptable' : 'Recorded in the audit trail'} />
        </Field>
      </div>
    </Modal>
  )
}

/* ───────────────────────────── extend ───────────────────────────── */

export function ExtendModal({ waiver, onClose }: { waiver: Waiver | null; onClose(): void }) {
  const toast = useToast()
  const act = useWaiverAction()
  const policy = usePolicy(waiver?.target.project)
  const maxDays = policy.data?.effective.maxWaiverDays ?? 90
  const [expires, setExpires] = useState(() => isoDate(Date.now() + 30 * DAY))
  const [justification, setJustification] = useState('')
  const [comment, setComment] = useState('')
  if (!waiver) return null
  const expMs = Date.parse(endOfDay(expires))
  const invalid = !(expMs > Date.now()) || expMs - Date.now() > maxDays * DAY + DAY
  const submit = async () => {
    try {
      const r = await act.mutateAsync({ id: waiver.id, action: 'extend', expiresAt: endOfDay(expires), justification: justification.trim() || undefined, comment: comment.trim() || undefined })
      toast.success('Extension requested', { description: `${r.created?.id ?? ''} goes to review; the current waiver applies until then.` })
      onClose()
    } catch (e) {
      toast.error('Could not request the extension', { description: errText(e) })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Extend waiver"
      description={`${waiver.findingId} — an extension is a new request and needs review again.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={act.isPending} disabled={invalid}>Request extension</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="New expiry" required hint={`Policy maximum: ${maxDays} days from today.`}>
          <Input type="date" value={expires} min={isoDate(Date.now() + DAY)} max={isoDate(Date.now() + maxDays * DAY)} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <Field label="Updated justification (optional)" hint="Leave empty to keep the current one.">
          <Textarea rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} placeholder={waiver.justification} />
        </Field>
        <Field label="Comment">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why the fix needs more time" />
        </Field>
      </div>
    </Modal>
  )
}

/* ───────────────────────────── scan gate ───────────────────────────── */

export function GateDecisionModal({ gate, decision, onClose }: { gate: GateView | null; decision: 'approved' | 'rejected' | null; onClose(): void }) {
  const toast = useToast()
  const decide = useDecideGate()
  const [comment, setComment] = useState('')
  const [withWaiver, setWithWaiver] = useState(false)
  const [justification, setJustification] = useState('')
  const [expires, setExpires] = useState(() => isoDate(Date.now() + 30 * DAY))
  if (!gate || !decision) return null
  const findings = gate.findings ?? []
  const canWaive = decision === 'approved' && findings.length > 0 && Boolean(gate.digest) && Boolean(gate.app)
  const invalid = !comment.trim() || (withWaiver && justification.trim().length < 10)
  const submit = async () => {
    const body: GateDecisionInput = { namespace: gate.namespace, name: gate.name, decision, comment: comment.trim() }
    if (withWaiver && canWaive) {
      body.waiver = {
        findings: findings.map((f) => ({ findingId: f })),
        expiresAt: endOfDay(expires),
        justification: justification.trim(),
        vex: { status: 'affected' },
      }
    }
    try {
      const r = await decide.mutateAsync(body)
      const d = describeWrites(r.writes)
      const msg = decision === 'approved' ? `Scan gate approved — ${gate.app ?? gate.name} continues` : `Scan gate rejected — ${gate.app ?? gate.name} stops`
      if (d.ok) toast.success(msg, { description: r.waivers.length ? `${r.waivers.length} digest-scoped waiver(s) recorded. ${d.text ?? ''}` : undefined })
      else toast.warning(msg, { description: d.text, duration: 0 })
      onClose()
    } catch (e) {
      toast.error('Could not record the decision', { description: errText(e) })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={decision === 'approved' ? 'Approve scan gate' : 'Reject scan gate'}
      description={`${gate.namespace}/${gate.name}${gate.app ? ` · ${gate.app}` : ''}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={decision === 'approved' ? 'primary' : 'danger'} onClick={submit} loading={decide.isPending} disabled={invalid}>
            {decision === 'approved' ? 'Approve and continue' : 'Reject run'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] text-content-muted">
          {decision === 'approved'
            ? 'The paused pipeline continues to push and deploy this image. Your name, the time and the comment are written on the PipelineRun.'
            : 'The pipeline stops here; nothing is pushed or deployed from this run.'}
        </p>
        <Field label="Comment" required>
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Recorded on the run and in the audit trail" />
        </Field>
        {decision === 'approved' ? (
          canWaive ? (
            <div className="space-y-3 rounded-lg border border-edge-subtle p-3">
              <Checkbox
                checked={withWaiver}
                onChange={(e) => setWithWaiver(e.currentTarget.checked)}
                label={`Also waive the ${findings.length} published finding${findings.length === 1 ? '' : 's'} for this image digest`}
                description={`${gate.app} @ ${shortDigest(gate.digest)} only — a rebuild is gated again.`}
              />
              {withWaiver ? (
                <>
                  <Field label="Justification" required>
                    <Textarea rows={2} value={justification} onChange={(e) => setJustification(e.target.value)} />
                  </Field>
                  <Field label="Waivers expire">
                    <Input type="date" value={expires} min={isoDate(Date.now() + DAY)} onChange={(e) => setExpires(e.target.value)} />
                  </Field>
                </>
              ) : null}
            </div>
          ) : (
            <p className="text-[11px] text-content-subtle">
              {findings.length ? 'This run did not publish its image digest, so its findings cannot be waived per digest from here.' : 'This run did not publish a list of findings, so only the gate is decided.'}
            </p>
          )
        ) : null}
      </div>
    </Modal>
  )
}
