import { type ReactNode, useState } from 'react'
import { Button, EmptyState, Field, SearchInput, Select, Textarea, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import {
  describeWrites,
  SCOPE_LABEL,
  useResyncWaivers,
  useWaiverAction,
  VEX_JUSTIFICATION_LABEL,
  VEX_STATUS_LABEL,
  type Waiver,
  type WaiverKind,
  type WaiverScope,
  type WaiverStatus,
} from '../../data/security-api.ts'
import { daysLeft, isExpiringSoon, toSeverity, waiversCsv } from '../../data/security-findings.ts'
import { securityLink, useSecurityParams, useSetSecurityParams } from '../../data/security-nav.ts'
import type { SecurityModel } from '../../data/security-model.ts'
import { DecisionModal, type DecisionMode, ExtendModal } from './dialogs.tsx'
import { useCanRequestWaiver, useScanGovernanceAccess } from '../../data/security-access.ts'
import { download, Drawer, fmtDate, fmtDateTime, KV, Loading, Notice, Section, SevChip, shortDigest, TableWrap, TD, TH, WaiverStatusChip } from './shared.tsx'

/** Waivers registry: every waiver, filterable, exportable, each with its audit trail. */
export function WaiversRegistry({ model }: { model: SecurityModel }) {
  const toast = useToast()
  const params = useSecurityParams()
  const setParams = useSetSecurityParams()
  const resync = useResyncWaivers()
  const [status, setStatus] = useState<WaiverStatus | 'active' | ''>('')
  const [scope, setScope] = useState<WaiverScope | ''>('')
  const [kind, setKind] = useState<WaiverKind | ''>('')
  const [soon, setSoon] = useState(false)
  const [search, setSearch] = useState('')
  const now = Date.now()
  const access = useScanGovernanceAccess()
  const all = model.waiverItems

  if (model.waivers.isLoading) return <Loading text="Loading waivers…" />
  if (model.waivers.isError) {
    const e = model.waivers.error as { status?: number; message?: string }
    return (
      <Notice tone="error" title={e.status === 503 ? 'Waivers cannot be recorded — no database' : "Couldn't load waivers"}>
        {e.message}
      </Notice>
    )
  }

  const q = search.trim().toLowerCase()
  const rows = all.filter((w) =>
    (!status || (status === 'active' ? w.status === 'approved' && Date.parse(w.expiresAt) > now : w.status === status)) &&
    (!scope || w.scope === scope) &&
    (!kind || w.kind === kind) &&
    (!soon || isExpiringSoon(w, now)) &&
    (!q || [w.id, w.findingId, w.target.project, w.target.app, w.target.package, w.requestedBy.label, w.justification].join(' ').toLowerCase().includes(q))
  )
  const open = params.waiver ? all.find((w) => w.id === params.waiver) : undefined
  const soonCount = all.filter((w) => isExpiringSoon(w, now)).length

  const doResync = async () => {
    try {
      const r = await resync.mutateAsync({})
      const d = describeWrites(r.writes)
      if (d.ok) toast.success('Waiver ConfigMaps re-synced', { description: d.text ?? 'Nothing to write.' })
      else toast.warning('Some ConfigMaps could not be written', { description: d.text, duration: 0 })
    } catch (e) {
      toast.error('Re-sync failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search finding, project, app, requester…" label="Search waivers" />
        </div>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as WaiverStatus | 'active' | '')} wrapperClassName="w-36">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="requested">Pending review</option>
          <option value="approved">Approved (incl. lapsed)</option>
          <option value="rejected">Rejected</option>
          <option value="expired">Expired</option>
          <option value="revoked">Revoked</option>
        </Select>
        <Select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value as WaiverScope | '')} wrapperClassName="w-36">
          <option value="">Any scope</option>
          {(Object.keys(SCOPE_LABEL) as WaiverScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
        </Select>
        <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as WaiverKind | '')} wrapperClassName="w-32">
          <option value="">Any kind</option>
          <option value="vuln">Vulnerability</option>
          <option value="license">License</option>
          <option value="misconfig">Misconfiguration</option>
          <option value="secret">Secret</option>
        </Select>
        <button
          type="button"
          aria-pressed={soon}
          onClick={() => setSoon((v) => !v)}
          className={cn(
            'rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset',
            soon ? 'bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/15 dark:text-amber-200' : 'bg-surface-sunken text-content-muted ring-edge-subtle',
          )}
        >
          Expiring soon ({soonCount})
        </button>
        <div className="ml-auto flex gap-2">
          {access.canApprove ? <Button size="sm" onClick={doResync} loading={resync.isPending}>Re-sync to cluster</Button> : null}
          <Button size="sm" onClick={() => download(`waivers-${new Date().toISOString().slice(0, 10)}.csv`, waiversCsv(rows))} disabled={!rows.length}>Export CSV</Button>
        </div>
      </div>

      {!all.length ? (
        <EmptyState title="No waivers yet" description="Request one from a finding or a license — it shows up here with its review history." />
      ) : !rows.length ? (
        <EmptyState compact title="No matching waivers" description="Relax the filters or the search." />
      ) : (
        <TableWrap>
          <thead>
            <tr className="border-b border-edge-subtle">
              <th className={TH}>Finding</th>
              <th className={TH}>Scope</th>
              <th className={TH}>Status</th>
              <th className={TH}>Expires</th>
              <th className={TH}>Requested</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {rows.map((w) => {
              const left = daysLeft(w.expiresAt, now)
              return (
                <tr key={w.id} className="cursor-pointer hover:bg-surface-sunken/50" onClick={() => setParams({ waiver: w.id }, { push: true })}>
                  <td className={TD}>
                    <div className="flex items-center gap-2">
                      {w.severity ? <SevChip severity={toSeverity(w.severity)} /> : null}
                      <span className="font-mono font-medium text-content">{w.findingId}</span>
                    </div>
                    <div className="text-[11px] text-content-subtle">{w.kind}{w.target.package ? ` · ${w.target.package}` : ''}</div>
                  </td>
                  <td className={TD}>
                    {SCOPE_LABEL[w.scope]}
                    <div className="text-[11px] text-content-subtle">{w.scope === 'platform' ? 'all projects' : `${w.target.project}${w.target.app ? `/${w.target.app}` : ''}${w.target.digest ? ` @${shortDigest(w.target.digest)}` : ''}`}</div>
                  </td>
                  <td className={TD}>
                    <WaiverStatusChip status={w.status} expiringSoon={isExpiringSoon(w, now)} />
                    {w.sync && !w.sync.ok ? <div className="mt-0.5 text-[10px] text-rose-700 dark:text-rose-300">cluster not updated</div> : null}
                  </td>
                  <td className={TD}>
                    {fmtDate(w.expiresAt)}
                    {w.status === 'approved' && left > 0 ? <div className="text-[11px] text-content-subtle">{left} day{left === 1 ? '' : 's'} left</div> : null}
                  </td>
                  <td className={TD}>{w.requestedBy.label}<div className="text-[11px] text-content-subtle">{fmtDate(w.requestedAt)}</div></td>
                </tr>
              )
            })}
          </tbody>
        </TableWrap>
      )}

      {open ? <WaiverDrawer waiver={open} model={model} onClose={() => setParams({ waiver: undefined })} /> : params.waiver && !model.waivers.isFetching ? (
        <Notice tone="warn" title={`Waiver ${params.waiver} not found`} action={<Button size="xs" onClick={() => setParams({ waiver: undefined })}>Dismiss</Button>}>It may belong to another organization.</Notice>
      ) : null}
    </div>
  )
}

const ACTION_LABEL: Record<string, string> = {
  request: 'requested',
  approve: 'approved',
  reject: 'rejected',
  revoke: 'revoked',
  withdraw: 'withdrew',
  expire: 'expired',
  comment: 'commented',
  extend: 'requested an extension',
  supersede: 'superseded',
}

export function WaiverDrawer({ waiver: w, model, onClose }: { waiver: Waiver; model: SecurityModel; onClose(): void }) {
  const toast = useToast()
  const setParams = useSetSecurityParams()
  const act = useWaiverAction()
  const me = model.waivers.data?.me
  const access = useScanGovernanceAccess()
  // Extending files a new request in the waiver's project namespace.
  const canExtend = useCanRequestWaiver([w.target.project])
  const [mode, setMode] = useState<DecisionMode | null>(null)
  const [extend, setExtend] = useState(false)
  const [comment, setComment] = useState('')
  const now = Date.now()
  const mine = me?.id === w.requestedBy.id
  const active = w.status === 'approved' && Date.parse(w.expiresAt) > now

  const addComment = async () => {
    try {
      await act.mutateAsync({ id: w.id, action: 'comment', comment: comment.trim() })
      setComment('')
      toast.success('Comment added')
    } catch (e) {
      toast.error('Could not add the comment', { description: e instanceof Error ? e.message : String(e) })
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(securityLink({ tab: 'waivers', waiver: w.id }))
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy the link')
    }
  }

  return (
    <Drawer
      widthId="deliver.security-waiver"
      onClose={onClose}
      eyebrow={`${w.kind === 'license' ? 'License' : w.kind === 'vuln' ? 'Vulnerability' : w.kind} waiver · ${w.id}`}
      title={<span className="font-mono">{w.findingId}</span>}
      subtitle={<span className="flex flex-wrap items-center gap-2"><WaiverStatusChip status={w.status} expiringSoon={isExpiringSoon(w, now)} /> {SCOPE_LABEL[w.scope]} · until {fmtDate(w.expiresAt)}</span>}
      actions={
        <>
          {w.status === 'requested' && access.canApprove ? (
            <>
              <Button size="sm" variant="primary" onClick={() => setMode('approve')}>Approve</Button>
              <Button size="sm" variant="danger" onClick={() => setMode('reject')}>Reject</Button>
            </>
          ) : null}
          {w.status === 'requested' && mine ? <Button size="sm" onClick={() => setMode('withdraw')}>Withdraw</Button> : null}
          {(w.status === 'approved' || w.status === 'expired') && !w.supersededBy && canExtend ? <Button size="sm" onClick={() => setExtend(true)}>Extend</Button> : null}
          {w.status === 'approved' && (access.canApprove || mine) ? <Button size="sm" variant="danger" onClick={() => setMode('revoke')}>Revoke</Button> : null}
          {w.kind === 'vuln' ? <Button size="sm" variant="ghost" onClick={() => setParams({ tab: 'findings', finding: w.target.package ? `${w.findingId}|${w.target.package}` : w.findingId, waiver: undefined }, { push: true })}>View finding</Button> : null}
          <Button size="sm" variant="ghost" onClick={copy}>Copy link</Button>
        </>
      }
    >
      {w.sync && !w.sync.ok ? (
        <Notice tone="error" title="The cluster was not updated">{w.sync.detail} — {active ? 'CI does not honour this waiver yet.' : 'CI may still honour it until its expiry.'} A reviewer can re-sync from the registry.</Notice>
      ) : null}
      {w.supersededBy ? (
        <Notice tone="info" title="An extension is under review" action={<Button size="xs" onClick={() => setParams({ waiver: w.supersededBy })}>Open</Button>}>{w.supersededBy}</Notice>
      ) : null}
      <Section title="What is waived">
        <KV
          rows={[
            ['Scope', SCOPE_LABEL[w.scope]],
            ['Project', w.scope === 'platform' ? `all (requested from ${w.target.project})` : w.target.project],
            ...(w.target.app ? [['App', w.target.app] as [string, ReactNode]] : []),
            ...(w.target.digest ? [['Digest', <span key="v" className="break-all font-mono text-[11px]">{w.target.digest}</span>] as [string, ReactNode]] : []),
            ...(w.target.package ? [['Package', `${w.target.package}${w.target.version ? `@${w.target.version}` : ''}`] as [string, ReactNode]] : []),
            ...(w.target.purl ? [['PURL', <span key="v" className="break-all font-mono text-[11px]">{w.target.purl}</span>] as [string, ReactNode]] : []),
            ...(w.target.path ? [['Path', <span key="v" className="break-all font-mono text-[11px]">{w.target.path}</span>] as [string, ReactNode]] : []),
            ['Expires', fmtDateTime(w.expiresAt)],
            ...(w.source?.pipelineRun ? [['From gate', <span key="v" className="font-mono text-[11px]">{w.source.pipelineRun}</span>] as [string, ReactNode]] : []),
          ]}
        />
      </Section>
      <Section title="Justification">
        <p className="whitespace-pre-line text-[13px] text-content">{w.justification}</p>
        <p className="mt-2 text-[12px] text-content-muted">
          VEX: <b className="text-content">{VEX_STATUS_LABEL[w.vex.status]}</b>
          {w.vex.justification ? ` — ${VEX_JUSTIFICATION_LABEL[w.vex.justification]}` : ''}
          {w.vex.impact ? ` · ${w.vex.impact}` : ''}
          {w.falsePositive ? ' · reported as a false positive' : ''}
        </p>
      </Section>
      <Section title="Review">
        <KV
          rows={[
            ['Requested', `${w.requestedBy.label} · ${fmtDateTime(w.requestedAt)}`],
            ...(w.approvedBy ? [['Approved', `${w.approvedBy.label} · ${fmtDateTime(w.approvedAt)}${w.selfApproved ? ' (self-approved)' : ''}`] as [string, ReactNode]] : []),
            ...(w.decidedBy && w.status !== 'approved' && w.decidedBy.id !== w.approvedBy?.id ? [['Decided', `${w.decidedBy.label} · ${fmtDateTime(w.decidedAt)}`] as [string, ReactNode]] : []),
            ...(w.sync ? [['Cluster', `${w.sync.ok ? 'written' : 'not written'} · ${fmtDateTime(w.sync.at)}`] as [string, ReactNode]] : []),
          ]}
        />
      </Section>
      <Section title={`Audit trail (${w.history.length})`}>
        <ol className="relative space-y-3 border-l border-edge-default pl-4">
          {w.history.map((h, i) => (
            <li key={i} className="text-[12px]">
              <span className="absolute -left-[5px] mt-1.5 h-2 w-2 rounded-full bg-brand-500" />
              <div className="text-content">
                <b>{h.by.label}</b> {ACTION_LABEL[h.action] ?? h.action}
                {h.from && h.to ? <span className="text-content-subtle"> · {h.from} → {h.to}</span> : null}
              </div>
              <div className="text-[11px] text-content-subtle">{fmtDateTime(h.at)}</div>
              {h.comment ? <p className="mt-0.5 whitespace-pre-line text-content-muted">{h.comment}</p> : null}
              {h.selfApproveReason ? <p className="mt-0.5 text-amber-700 dark:text-amber-300">Self-approval reason: {h.selfApproveReason}</p> : null}
            </li>
          ))}
        </ol>
        <div className="mt-3 space-y-2">
          <Field label="Add a comment">
            <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button size="sm" onClick={addComment} loading={act.isPending} disabled={!comment.trim()}>Comment</Button>
          </div>
        </div>
      </Section>
      <DecisionModal mode={mode} waivers={[w]} me={me} onClose={() => setMode(null)} />
      {extend ? <ExtendModal waiver={w} onClose={() => setExtend(false)} /> : null}
    </Drawer>
  )
}
