import { useMemo, useState } from 'react'
import { Button, Checkbox, EmptyState } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { type GateView, SCOPE_LABEL, useGates, VEX_JUSTIFICATION_LABEL, VEX_STATUS_LABEL, type Waiver } from '../../data/security-api.ts'
import { groupIdentical, previousRun, slaOf, summaryDiff, toSeverity } from '../../data/security-findings.ts'
import { useSetSecurityParams } from '../../data/security-nav.ts'
import type { SecurityModel } from '../../data/security-model.ts'
import { DecisionModal, type DecisionMode, GateDecisionModal } from './dialogs.tsx'
import { useScanGovernanceAccess } from '../../data/security-access.ts'
import { fmtDate, Loading, Notice, Section, SevChip, shortDigest } from './shared.tsx'

const SLA_TONE = {
  fresh: 'text-content-subtle',
  ageing: 'text-amber-700 dark:text-amber-300',
  overdue: 'text-rose-700 dark:text-rose-300',
}

/**
 * Review queue — waiver requests and pipeline runs paused at the manual scan
 * gate. Only reviewers can decide; everyone else sees the queue read-only.
 */
export function ReviewQueue({ model }: { model: SecurityModel }) {
  const gates = useGates()
  const me = model.waivers.data?.me
  const setParams = useSetSecurityParams()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [decision, setDecision] = useState<{ mode: DecisionMode; waivers: Waiver[] } | null>(null)
  const [gate, setGate] = useState<{ g: GateView; d: 'approved' | 'rejected' } | null>(null)
  const now = Date.now()

  const pending = useMemo(() => model.waiverItems.filter((w) => w.status === 'requested').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)), [model.waiverItems])
  const groups = useMemo(() => groupIdentical(pending), [pending])
  const awaiting = (gates.data?.items ?? []).filter((g) => g.state === 'awaiting')
  // RBAC `approve scan-waivers` (docs/rbac.md) — the check the BFF enforces.
  const access = useScanGovernanceAccess()
  const canDecide = access.canApprove

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const picked = pending.filter((w) => selected.has(w.id))

  if (model.waivers.isLoading) return <Loading text="Loading the review queue…" />

  return (
    <div className="space-y-6">
      {!canDecide && access.decided ? (
        <Notice tone="info" title="Read-only">
          Decisions need the Kubernetes RBAC permission <code>approve scan-waivers.console.adhar.io</code>. You can still withdraw your own requests.
        </Notice>
      ) : null}

      <Section title={`Scan gates awaiting approval (${awaiting.length})`}>
        {gates.isLoading ? (
          <p className="text-[12px] text-content-subtle">Reading pipeline runs…</p>
        ) : gates.data?.state && gates.data.state !== 'ok' ? (
          <p className="text-[12px] text-content-subtle">
            {gates.data.state === 'absent' ? 'Tekton is not installed.' : gates.data.state === 'forbidden' ? 'Your account may not list PipelineRuns.' : `Couldn't read PipelineRuns: ${gates.data.detail ?? ''}`}
          </p>
        ) : !awaiting.length ? (
          <p className="rounded-xl border border-dashed border-edge-default px-3 py-5 text-center text-[12px] text-content-subtle">
            No pipeline is paused at a scan gate. Runs pause here when the scan policy asks for manual approval and the gate fails.
          </p>
        ) : (
          <ul className="space-y-2">
            {awaiting.map((g) => {
              const prev = previousRun(gates.data?.items ?? [], g)
              const diff = summaryDiff(prev?.summary, g.summary)
              return (
                <li key={`${g.namespace}/${g.name}`} className="rounded-xl border border-indigo-200 bg-surface-raised p-3 dark:border-indigo-500/30">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-content">{g.app ?? g.pipeline ?? g.name}</div>
                      <div className="font-mono text-[11px] text-content-subtle">
                        {g.namespace}/{g.name}{g.digest ? ` · ${shortDigest(g.digest)}` : ''}{g.createdAt ? ` · ${formatRelative(g.createdAt)}` : ''}
                      </div>
                      {g.summary ? (
                        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
                          {(['critical', 'high', 'medium', 'low'] as const).map((s) => g.summary?.[s] !== undefined ? (
                            <span key={s} className="inline-flex items-center gap-1">
                              <SevChip severity={s} /> <b className="tabular-nums">{g.summary[s]}</b>
                              {diff[s] ? <span className={cn('text-[11px] tabular-nums', diff[s]! > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300')}>({diff[s]! > 0 ? '+' : ''}{diff[s]} vs previous)</span> : null}
                            </span>
                          ) : null)}
                          {g.summary.fixable !== undefined ? <span className="text-content-muted">{g.summary.fixable} fixable</span> : null}
                        </div>
                      ) : <div className="mt-1 text-[12px] text-content-subtle">The run did not publish a summary.</div>}
                      {g.findings?.length ? (
                        <div className="mt-1 line-clamp-2 font-mono text-[11px] text-content-muted" title={g.findings.join(', ')}>{g.findings.slice(0, 12).join(', ')}{g.findings.length > 12 ? ` +${g.findings.length - 12}` : ''}</div>
                      ) : null}
                    </div>
                    {canDecide ? (
                      <div className="flex w-full shrink-0 justify-end gap-2 sm:w-auto">
                        <Button size="sm" variant="danger" onClick={() => setGate({ g, d: 'rejected' })}>Reject</Button>
                        <Button size="sm" variant="primary" onClick={() => setGate({ g, d: 'approved' })}>Approve</Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section
        title={`Waiver requests (${pending.length})`}
        aside={canDecide && picked.length ? (
          <div className="flex gap-2">
            <Button size="xs" variant="danger" onClick={() => setDecision({ mode: 'reject', waivers: picked })}>Reject {picked.length}</Button>
            <Button size="xs" variant="primary" onClick={() => setDecision({ mode: 'approve', waivers: picked })}>Approve {picked.length}</Button>
          </div>
        ) : undefined}
      >
        {model.waivers.isError ? (
          <Notice tone="error" title="Couldn't load waiver requests">{model.waivers.error instanceof Error ? model.waivers.error.message : ''}</Notice>
        ) : !pending.length ? (
          <EmptyState compact title="Nothing to review" description="New waiver requests from findings and licenses land here." />
        ) : (
          <div className="space-y-3">
            {groups.map(({ key, items }) => (
              <div key={key} className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
                {items.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-2 border-b border-edge-subtle bg-surface-sunken/50 px-3 py-1.5 text-[11px] text-content-muted">
                    <span>{items.length} identical requests — {items[0].findingId}{items[0].target.package ? ` in ${items[0].target.package}` : ''}</span>
                    {canDecide ? (
                      <Button size="xs" className="ml-auto" onClick={() => setDecision({ mode: 'approve', waivers: items })}>Approve all {items.length}</Button>
                    ) : null}
                  </div>
                ) : null}
                <ul className="divide-y divide-edge-subtle">
                  {items.map((w) => {
                    const sla = slaOf(w.requestedAt, now)
                    const mine = me?.id === w.requestedBy.id
                    return (
                      <li key={w.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                        {canDecide ? <Checkbox aria-label={`Select ${w.id}`} checked={selected.has(w.id)} onChange={() => toggle(w.id)} /> : null}
                        <button type="button" onClick={() => setParams({ tab: 'waivers', waiver: w.id }, { push: true })} className="min-w-0 flex-1 text-left">
                          <div className="flex flex-wrap items-center gap-2">
                            {w.severity ? <SevChip severity={toSeverity(w.severity)} /> : null}
                            <span className="font-mono text-[12px] font-medium text-content">{w.findingId}</span>
                            <span className="text-[11px] text-content-muted">{w.kind === 'license' ? 'license' : w.target.package ?? ''}</span>
                            {w.supersedes ? <span className="rounded bg-surface-sunken px-1.5 text-[10px] text-content-muted">extension</span> : null}
                            {w.falsePositive ? <span className="rounded bg-surface-sunken px-1.5 text-[10px] text-content-muted">false positive</span> : null}
                          </div>
                          <div className="mt-0.5 text-[12px] text-content">
                            {SCOPE_LABEL[w.scope]} · {w.target.project}{w.target.app ? `/${w.target.app}` : ''}{w.target.digest ? ` @ ${shortDigest(w.target.digest)}` : ''} · until {fmtDate(w.expiresAt)}
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-[12px] text-content-muted">{w.justification}</div>
                          <div className="mt-0.5 text-[11px] text-content-subtle">
                            VEX {VEX_STATUS_LABEL[w.vex.status]}{w.vex.justification ? ` — ${VEX_JUSTIFICATION_LABEL[w.vex.justification]}` : ''} · {w.requestedBy.label} · <span className={SLA_TONE[sla.tone]}>waiting {sla.days === 0 ? 'since today' : `${sla.days} day${sla.days === 1 ? '' : 's'}`}{sla.tone === 'overdue' ? ' (over SLA)' : ''}</span>
                          </div>
                        </button>
                        <div className="flex w-full shrink-0 justify-end gap-2 sm:w-auto">
                          {mine ? <Button size="xs" onClick={() => setDecision({ mode: 'withdraw', waivers: [w] })}>Withdraw</Button> : null}
                          {canDecide ? (
                            <>
                              <Button size="xs" variant="danger" onClick={() => setDecision({ mode: 'reject', waivers: [w] })}>Reject</Button>
                              <Button size="xs" variant="primary" onClick={() => setDecision({ mode: 'approve', waivers: [w] })}>Approve</Button>
                            </>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <DecisionModal mode={decision?.mode ?? null} waivers={decision?.waivers ?? []} me={me} onClose={() => setDecision(null)} onDone={() => setSelected(new Set())} />
      <GateDecisionModal key={gate ? `${gate.g.namespace}/${gate.g.name}/${gate.d}` : 'none'} gate={gate?.g ?? null} decision={gate?.d ?? null} onClose={() => setGate(null)} />
    </div>
  )
}
