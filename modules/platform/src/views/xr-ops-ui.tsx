import { useEffect, useState } from 'react'
import { Button, StatusBadge, useToast, type StatusKind } from '@adhar/shell-ui'
import { kube } from '@adhar/api-clients/k8s'
import type { k8s } from '@adhar/api-clients'
import { cn } from '@adhar/utils'
import { age } from '../data/format.ts'
import {
  type AttentionItem,
  changeLog,
  type GroupKey,
  isPaused,
  isProtected,
  OWNERSHIP,
  ownership,
  type OwnershipKey,
  ownershipPatch,
  pausePatch,
  protectPatch,
  reconcilePatch,
  RECONCILE_ANNOTATION,
  toCsv,
  toYamlBundle,
  validLabelValue,
  type XrLike,
  type XrState,
} from '../data/xr-ops.ts'

/**
 * Day-2 tooling shared by every Adhar Resources page: what needs attention,
 * filters and grouping, bulk operations, and the drawer's operations and
 * change-log panels. Logic lives in `xr-ops.ts`; this file is presentation
 * and the API calls.
 */

export const STATE_META: Record<XrState, { label: string; kind: StatusKind }> = {
  ready: { label: 'Ready', kind: 'healthy' },
  progressing: { label: 'Provisioning', kind: 'progressing' },
  stuck: { label: 'Stuck', kind: 'degraded' },
  failing: { label: 'Failing', kind: 'failed' },
  paused: { label: 'Paused', kind: 'paused' },
  deleting: { label: 'Deleting', kind: 'paused' },
}

/** Save text as a file. A normal console page may start downloads. */
export function downloadText(filename: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/* ───────────── needs attention ───────────── */

export function AttentionPanel({ items, plural, onOpen }: { items: AttentionItem[]; plural: string; onOpen(xr: XrLike): void }) {
  const [open, setOpen] = useState(true)
  if (!items.length) return null
  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10" aria-label="Needs attention">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
      >
        <span className="text-[13px] font-semibold text-rose-800 dark:text-rose-200">
          {items.length} {items.length === 1 ? plural.replace(/s$/, '').toLowerCase() : plural.toLowerCase()} need attention
        </span>
        <span className="text-[11px] text-rose-700/80 dark:text-rose-300/80">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open ? (
        <ul className="divide-y divide-rose-200/70 border-t border-rose-200/70 dark:divide-rose-500/20 dark:border-rose-500/20">
          {items.slice(0, 6).map((it) => (
            <li key={`${it.xr.metadata.namespace}/${it.xr.metadata.name}`}>
              <button
                type="button"
                onClick={() => onOpen(it.xr)}
                className="flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-left hover:bg-rose-100/60 dark:hover:bg-rose-500/10"
              >
                <StatusBadge kind={STATE_META[it.state].kind} className="px-1.5 py-0 text-[10px]">{STATE_META[it.state].label}</StatusBadge>
                <span className="font-mono text-[12px] font-medium text-content">{it.xr.metadata.namespace ? `${it.xr.metadata.namespace}/` : ''}{it.xr.metadata.name}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-content-muted" title={it.reason}>{it.reason}</span>
                {it.since ? <span className="text-[11px] text-content-subtle">for {age(it.since)}</span> : null}
              </button>
            </li>
          ))}
          {items.length > 6 ? <li className="px-4 py-2 text-[11px] text-content-subtle">+{items.length - 6} more — filter by Stuck or Failing to see them all.</li> : null}
        </ul>
      ) : null}
    </section>
  )
}

/* ───────────── filters ───────────── */

const SELECT = 'h-9 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'

export function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange(v: string): void }) {
  if (options.length < 2 && !value) return null
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={cn(SELECT, 'max-w-48')}>
      <option value="">All {label.toLowerCase()}s</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

export function GroupSelect({ value, onChange }: { value: GroupKey; onChange(v: GroupKey): void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as GroupKey)} aria-label="Group by" className={SELECT}>
      <option value="none">No grouping</option>
      <option value="state">Group by status</option>
      <option value="namespace">Group by namespace</option>
      <option value="team">Group by team</option>
      <option value="composition">Group by composition</option>
    </select>
  )
}

/* ───────────── bulk operations ───────────── */

type BulkAction = 'pause' | 'resume' | 'reconcile' | 'label' | 'protect' | 'unprotect' | 'delete'

export function BulkBar({
  gvr,
  singular,
  plural,
  selected,
  canMutate,
  cluster,
  onClear,
  onDone,
}: {
  gvr: k8s.GVR
  singular: string
  plural: string
  selected: XrLike[]
  canMutate: boolean
  cluster?: string
  onClear(): void
  onDone(): void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState<BulkAction | null>(null)
  const [labeling, setLabeling] = useState(false)
  const [team, setTeam] = useState('')
  const [owner, setOwner] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [typed, setTyped] = useState('')
  if (!selected.length) return null

  const noun = selected.length === 1 ? singular.toLowerCase() : plural.toLowerCase()
  const protectedRows = selected.filter(isProtected)
  const deletable = selected.filter((r) => !isProtected(r) && !r.metadata.deletionTimestamp)

  const run = async (action: BulkAction, rows: XrLike[], op: (r: XrLike) => Promise<unknown>, done: string) => {
    setBusy(action)
    const results = await Promise.allSettled(rows.map(op))
    setBusy(null)
    const failed = results.map((r, i) => ({ r, row: rows[i] })).filter((x) => x.r.status === 'rejected')
    if (failed.length) {
      const first = failed[0].r as PromiseRejectedResult
      toast.error(`${failed.length} of ${rows.length} failed`, {
        description: `${failed[0].row.metadata.name}: ${first.reason instanceof Error ? first.reason.message : String(first.reason)}`,
      })
    } else {
      toast.success(done)
    }
    onDone()
  }
  const patch = (body: unknown) => (r: XrLike) => kube.patch(gvr, r.metadata.namespace, r.metadata.name, body, 'merge', { cluster })

  const stamp = new Date().toISOString().slice(0, 10)
  return (
    <div className="sticky top-0 z-10 mb-3 rounded-xl border border-brand-200 bg-brand-50/80 px-3 py-2 shadow-sm backdrop-blur dark:border-brand-500/30 dark:bg-brand-500/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-brand-800 dark:text-brand-200">{selected.length} {noun} selected</span>
        <button type="button" onClick={onClear} className="text-[11px] text-brand-700 hover:underline dark:text-brand-300">Clear</button>
        <span className="mx-1 h-4 w-px bg-brand-200 dark:bg-brand-500/30" aria-hidden />
        <Button size="xs" variant="secondary" onClick={() => { downloadText(`${plural.toLowerCase()}-${stamp}.yaml`, toYamlBundle(selected), 'application/yaml'); toast.success(`Exported ${selected.length} as YAML`) }}>
          Export YAML
        </Button>
        <Button size="xs" variant="secondary" onClick={() => { downloadText(`${plural.toLowerCase()}-${stamp}.csv`, toCsv(selected), 'text/csv'); toast.success(`Exported ${selected.length} as CSV`) }}>
          Export CSV
        </Button>
        {canMutate ? (
          <>
            <Button size="xs" variant="secondary" loading={busy === 'reconcile'} onClick={() => run('reconcile', selected, patch(reconcilePatch()), `Reconcile requested for ${selected.length} ${noun}`)}>
              Reconcile now
            </Button>
            <Button size="xs" variant="secondary" loading={busy === 'pause'} onClick={() => run('pause', selected, patch(pausePatch(true)), `Paused ${selected.length} ${noun}`)}>
              Pause
            </Button>
            <Button size="xs" variant="secondary" loading={busy === 'resume'} onClick={() => run('resume', selected.filter(isPaused), patch(pausePatch(false)), `Resumed reconciliation`)} disabled={!selected.some(isPaused)}>
              Resume
            </Button>
            <Button size="xs" variant="secondary" loading={busy === 'protect'} onClick={() => run('protect', selected, patch(protectPatch(true)), `Deletion protection on for ${selected.length} ${noun}`)}>
              Protect
            </Button>
            <Button size="xs" variant="secondary" loading={busy === 'unprotect'} disabled={!protectedRows.length} onClick={() => run('unprotect', protectedRows, patch(protectPatch(false)), 'Deletion protection removed')}>
              Unprotect
            </Button>
            <Button size="xs" variant="secondary" onClick={() => setLabeling((v) => !v)} aria-expanded={labeling}>
              Set owner…
            </Button>
            <Button size="xs" variant="danger" disabled={!deletable.length} onClick={() => setDeleting(true)}>
              Delete…
            </Button>
          </>
        ) : null}
      </div>

      {labeling ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2 border-t border-brand-200/70 pt-2 dark:border-brand-500/20"
          onSubmit={(e) => {
            e.preventDefault()
            const values: Partial<Record<OwnershipKey, string>> = {}
            if (team.trim()) values.team = team.trim()
            if (owner.trim()) values.owner = owner.trim()
            if (!Object.keys(values).length) return
            run('label', selected, patch(ownershipPatch(values)), `Ownership set on ${selected.length} ${noun}`).then(() => setLabeling(false))
          }}
        >
          <input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Team" aria-label="Team" className={cn(SELECT, 'h-8 w-36', !validLabelValue(team) && 'border-rose-400')} />
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner" aria-label="Owner" className={cn(SELECT, 'h-8 w-36', !validLabelValue(owner) && 'border-rose-400')} />
          <Button size="xs" type="submit" variant="primary" loading={busy === 'label'} disabled={!validLabelValue(team) || !validLabelValue(owner) || (!team.trim() && !owner.trim())}>
            Apply
          </Button>
          <span className="text-[11px] text-content-subtle">Written as adhar.io/team and adhar.io/owner labels. Letters, digits, - _ . only.</span>
        </form>
      ) : null}

      {deleting ? (
        <div className="mt-2 space-y-2 border-t border-rose-200 pt-2 dark:border-rose-500/30">
          <p className="text-[12px] text-rose-800 dark:text-rose-200">
            Deleting {deletable.length} {deletable.length === 1 ? singular.toLowerCase() : plural.toLowerCase()} makes Crossplane tear down everything they composed — data included.
            {protectedRows.length ? ` ${protectedRows.length} protected ${protectedRows.length === 1 ? 'one is' : 'ones are'} skipped.` : ''}
            &nbsp;Type <code className="font-mono font-semibold">delete {deletable.length}</code> to confirm.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation" className={cn(SELECT, 'h-8 w-40 font-mono')} />
            <Button
              size="xs"
              variant="danger"
              loading={busy === 'delete'}
              disabled={typed.trim() !== `delete ${deletable.length}`}
              onClick={() =>
                run('delete', deletable, (r) => kube.delete(gvr, r.metadata.namespace, r.metadata.name, { cluster }), `Deleting ${deletable.length} ${noun}`).then(() => {
                  setDeleting(false)
                  setTyped('')
                  onClear()
                })}
            >
              Delete {deletable.length}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => { setDeleting(false); setTyped('') }}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ───────────── drawer: operations ───────────── */

export function OperationsPanel({
  gvr,
  xr,
  canMutate,
  cluster,
  onMutated,
  onClone,
}: {
  gvr: k8s.GVR
  xr: XrLike
  canMutate: boolean
  cluster?: string
  onMutated(): void
  onClone?(): void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const own = ownership(xr)
  const [draft, setDraft] = useState<Record<OwnershipKey, string>>({ team: '', owner: '', environment: '', costCenter: '' })
  useEffect(() => {
    setDraft({ team: own.team ?? '', owner: own.owner ?? '', environment: own.environment ?? '', costCenter: own.costCenter ?? '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xr.metadata.uid, own.team, own.owner, own.environment, own.costCenter])

  const paused = isPaused(xr)
  const prot = isProtected(xr)
  const lastReconcile = xr.metadata.annotations?.[RECONCILE_ANNOTATION]
  const dirty = OWNERSHIP.some((o) => (draft[o.key] ?? '') !== (own[o.key] ?? ''))
  const valid = OWNERSHIP.every((o) => validLabelValue(draft[o.key] ?? ''))

  const act = async (key: string, body: unknown, done: string) => {
    setBusy(key)
    try {
      await kube.patch(gvr, xr.metadata.namespace, xr.metadata.name, body, 'merge', { cluster })
      toast.success(done)
      onMutated()
    } catch (e) {
      toast.error('Change not applied', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <OpTile
          title="Reconciliation"
          state={paused ? 'Paused' : 'Active'}
          tone={paused ? 'paused' : 'healthy'}
          help={paused ? 'Crossplane is not acting on changes to this resource.' : 'Crossplane keeps the infrastructure matching the spec.'}
        >
          {canMutate ? (
            <Button size="xs" variant="secondary" loading={busy === 'pause'} onClick={() => act('pause', pausePatch(!paused), paused ? 'Reconciliation resumed' : 'Reconciliation paused')}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
          ) : null}
        </OpTile>
        <OpTile
          title="Reconcile now"
          state={lastReconcile ? `asked ${age(lastReconcile)} ago` : 'on its own schedule'}
          tone="info"
          help="Asks the controller to compare the spec with the cloud right away."
        >
          {canMutate ? (
            <Button size="xs" variant="secondary" loading={busy === 'reconcile'} disabled={paused} onClick={() => act('reconcile', reconcilePatch(), 'Reconcile requested')}>
              Reconcile
            </Button>
          ) : null}
        </OpTile>
        <OpTile
          title="Deletion protection"
          state={prot ? 'On' : 'Off'}
          tone={prot ? 'healthy' : 'unknown'}
          help={prot ? 'The console refuses to delete this resource.' : 'Anyone with write access can delete it here.'}
        >
          {canMutate ? (
            <Button size="xs" variant="secondary" loading={busy === 'protect'} onClick={() => act('protect', protectPatch(!prot), prot ? 'Deletion protection removed' : 'Deletion protection on')}>
              {prot ? 'Turn off' : 'Turn on'}
            </Button>
          ) : null}
        </OpTile>
      </div>

      <form
        className="rounded-xl border border-edge-default bg-surface-raised p-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && valid) act('owner', ownershipPatch(draft), 'Ownership updated')
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] font-semibold text-content">Ownership</div>
          <span className="text-[10px] text-content-subtle">adhar.io/* labels — used for filters, chargeback and routing alerts</span>
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {OWNERSHIP.map((o) => (
            <label key={o.key} className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{o.label}</span>
              <input
                value={draft[o.key] ?? ''}
                disabled={!canMutate}
                onChange={(e) => setDraft((d) => ({ ...d, [o.key]: e.target.value }))}
                className={cn(SELECT, 'mt-0.5 h-8 w-full', !validLabelValue(draft[o.key] ?? '') && 'border-rose-400')}
                placeholder="—"
              />
            </label>
          ))}
        </div>
        {canMutate ? (
          <div className="mt-2 flex items-center justify-end gap-2">
            {!valid ? <span className="text-[11px] text-rose-700 dark:text-rose-300">Letters, digits, - _ . only; up to 63 characters.</span> : null}
            <Button size="xs" type="submit" variant="primary" loading={busy === 'owner'} disabled={!dirty || !valid}>Save ownership</Button>
          </div>
        ) : null}
      </form>

      {onClone ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5">
          <div>
            <div className="text-[12px] font-semibold text-content">Clone</div>
            <div className="text-[11px] text-content-muted">Provision a copy with the same spec and labels, its own name and its own connection secret.</div>
          </div>
          <Button size="xs" variant="secondary" onClick={onClone}>Clone…</Button>
        </div>
      ) : null}
    </div>
  )
}

function OpTile({ title, state, tone, help, children }: { title: string; state: string; tone: StatusKind; help: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-edge-default bg-surface-raised p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{title}</div>
      <div className="mt-1"><StatusBadge kind={tone} className="px-1.5 py-0 text-[10px]">{state}</StatusBadge></div>
      <p className="mt-1.5 flex-1 text-[11px] leading-snug text-content-muted">{help}</p>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  )
}

/* ───────────── drawer: change log ───────────── */

const WRITER_LABEL: Record<string, string> = {
  console: 'Adhar console',
  gitops: 'GitOps',
  controller: 'Controller',
  person: 'CLI',
  other: 'Other',
}

export function ChangeLog({ xr }: { xr: XrLike }) {
  const log = changeLog(xr)
  if (!log.length) return <p className="text-[12px] text-content-subtle">Kubernetes kept no field-manager history for this resource.</p>
  return (
    <div>
      <ol className="relative space-y-2 border-l border-edge-subtle pl-4">
        {log.map((l, i) => (
          <li key={`${l.manager}-${l.subresource ?? ''}-${i}`} className="relative">
            <span className={cn('absolute -left-[19px] top-1.5 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-surface-raised', l.subresource === 'status' ? 'bg-slate-400' : 'bg-brand-500')} />
            <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className="font-mono font-medium text-content">{l.manager}</span>
              <span className="rounded bg-surface-sunken px-1 text-[10px] text-content-muted">{WRITER_LABEL[l.kindOfWriter]}</span>
              <span className="text-[11px] text-content-muted">{l.subresource === 'status' ? 'reported status' : l.operation === 'Apply' ? 'applied the spec' : 'updated'}</span>
              {l.time ? <span className="text-[11px] text-content-subtle" title={l.time}>{age(l.time)} ago</span> : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11px] text-content-subtle">
        Kubernetes records the last write per tool, not every edit. The apiserver audit log holds the full history.
      </p>
    </div>
  )
}
