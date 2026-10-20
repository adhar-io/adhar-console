import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, EmptyState, Field, Input, Modal, Select, StatusBadge, type StatusKind, Textarea, usePlaneWorkspace, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import {
  planeClient,
  planeError,
  priorityKind,
  useCreateIntake,
  useCycles,
  useDeleteIntake,
  useIntake,
  useLabels,
  useModules,
  usePlaneLink,
  useProject,
  useProjectMembers,
  useUpdateIntake,
  useUpdateProject,
} from '../data/plane.ts'
import { planeProblem, planning, toItemView, useDefineNotify, useRunAutomation } from '../data/planning-plane.ts'
import { storeError, useIntakeMeta, usePatchIntakeMeta, useStoreList } from '../data/planning-store.ts'
import { DEFAULT_SLA, formatDuration, type SlaPolicy, slaState, sprintStatus } from '../data/planning-model.ts'
import { planningHref, usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { BUILTIN_TEMPLATES, type TemplateDoc } from '../data/work-store.ts'
import { IssueSearch } from '../components/issue-search.tsx'
import { IssueDrawer } from '../components/issue-drawer.tsx'
import { IconLink, Loading, Notice, ProblemState } from '../components/planning-ui.tsx'

/**
 * Intake — the project's triage queue (Plane Intake). Requests land pending;
 * a triager accepts (optionally "as" a template, into a sprint or epic, with
 * an owner), declines, snoozes, or marks them duplicate — one at a time or in
 * bulk. Each pending request carries an SLA timer from the project's triage
 * policy (console-side, `define.intake`). Everything else is Plane's public
 * `intake-issues` API.
 */

type Tab = 'pending' | 'snoozed' | 'accepted' | 'declined' | 'duplicate' | 'all'
const TAB_STATUS: Record<Tab, plane.IntakeStatus | undefined> = {
  pending: -2,
  snoozed: 0,
  accepted: 1,
  declined: -1,
  duplicate: 2,
  all: undefined,
}
const STATUS_META: Record<plane.IntakeStatus, { label: string; kind: StatusKind }> = {
  [-2]: { label: 'pending', kind: 'progressing' },
  [-1]: { label: 'declined', kind: 'failed' },
  [0]: { label: 'snoozed', kind: 'paused' },
  [1]: { label: 'accepted', kind: 'healthy' },
  [2]: { label: 'duplicate', kind: 'unknown' },
}

export function Intake({ projectId }: { projectId?: string }) {
  const project = useProject(projectId)
  const all = useIntake(projectId)
  const meta = useIntakeMeta(projectId)
  const params = usePlanningParams()
  const setParams = useSetPlanningParams()
  const [tab, setTab] = useState<Tab>('pending')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [openIssue, setOpenIssue] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const updateProject = useUpdateProject()
  const notify = useDefineNotify(projectId)
  const qc = useQueryClient()
  const slug = usePlaneWorkspace()
  const toast = useToast()
  const policy = meta.data?.sla ?? DEFAULT_SLA

  // `?section=intake&tab=request` opens the request form (the shareable link).
  useEffect(() => {
    if (params.tab === 'request') {
      setCreating(true)
      setParams({ tab: undefined })
    }
  }, [params.tab, setParams])

  const items = useMemo(() => [...(all.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)), [all.data])
  const counts = useMemo(() => {
    const m = new Map<plane.IntakeStatus, number>()
    for (const i of items) m.set(i.status, (m.get(i.status) ?? 0) + 1)
    return m
  }, [items])
  const shown = TAB_STATUS[tab] === undefined ? items : items.filter((i) => i.status === TAB_STATUS[tab])
  const current = shown.find((i) => i.issue === selected) ?? shown[0]
  const breached = useMemo(() => items.filter((i) => i.status === -2 && slaState(i.created_at, i.issue_detail?.priority, policy)?.breached), [items, policy])

  // SLA breach notifications, once per request (keyed), when enabled.
  useEffect(() => {
    for (const i of breached) {
      notify('intakeBreached', {
        title: `Intake SLA breached: ${i.issue_detail?.name ?? 'request'}`,
        description: `Pending since ${formatRelative(i.created_at)}`,
        key: `define:intake-sla:${i.issue}`,
        href: planningHref('intake'),
      })
    }
  }, [breached, notify])

  if (!projectId) return <EmptyState title="Pick a project" />
  const p = project.data
  const enabled = p ? Boolean(p.intake_view ?? p.inbox_view) : true

  if (p && !enabled) {
    return (
      <EmptyState
        title={`Intake is off for ${p.name}`}
        description="Intake is a triage queue: requests arrive as pending items, and someone accepts, declines, snoozes or merges them before they reach the backlog. Turn it on to use it here and in Plane."
        action={
          <Button
            variant="primary"
            loading={updateProject.isPending}
            onClick={() =>
              updateProject.mutate(
                { id: p.id, patch: { intake_view: true } },
                {
                  onSuccess: () => {
                    qc.invalidateQueries({ queryKey: ['plane', 'project', slug, p.id] })
                    qc.invalidateQueries({ queryKey: ['plane', 'intake', slug, p.id] })
                    toast.success('Intake turned on')
                  },
                  onError: (e) => toast.error(planeError(e, "Couldn't turn on intake.")),
                },
              )}
          >
            Turn on intake
          </Button>
        }
      />
    )
  }

  const TABS: Array<[Tab, string, number | undefined]> = [
    ['pending', 'Pending', counts.get(-2)],
    ['snoozed', 'Snoozed', counts.get(0)],
    ['accepted', 'Accepted', counts.get(1)],
    ['declined', 'Declined', counts.get(-1)],
    ['duplicate', 'Duplicate', counts.get(2)],
    ['all', 'All', items.length],
  ]
  const selectable = shown.filter((i) => i.status === -2 || i.status === 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-edge-default bg-surface-raised p-1" role="tablist">
          {TABS.map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id)
                setSelected(null)
                setChecked(new Set())
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                tab === id ? 'bg-content text-surface-raised' : 'text-content-muted hover:bg-surface-sunken hover:text-content',
              )}
            >
              {label}
              {n ? <span className={cn('tabular-nums', tab === id ? 'opacity-70' : 'text-content-subtle')}>{n}</span> : null}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPolicyOpen(true)}>Triage SLA</Button>
          <Button size="sm" leading={<IconLink />} onClick={() => setSharing(true)}>Share form</Button>
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>New request</Button>
        </div>
      </div>

      {breached.length ? <Notice tone="warn">{breached.length} pending request{breached.length === 1 ? ' is' : 's are'} past the triage SLA.</Notice> : null}

      {all.isLoading ? <Loading label="Loading intake…" /> : all.isError ? <ProblemState error={all.error} onRetry={() => all.refetch()} /> : shown.length === 0
        ? (
          <EmptyState
            title={tab === 'pending' ? 'Nothing to triage' : `No ${tab} requests`}
            description={tab === 'pending' ? 'New requests appear here until someone accepts, declines, snoozes or merges them.' : undefined}
            action={tab === 'pending' ? <Button size="sm" onClick={() => setCreating(true)}>Submit a request</Button> : undefined}
          />
        )
        : (
          <>
            {checked.size
              ? <BulkBar projectId={projectId} ids={[...checked]} onDone={() => setChecked(new Set())} />
              : null}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
              <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
                {selectable.length
                  ? (
                    <label className="flex items-center gap-2 border-b border-edge-subtle px-4 py-2 text-[11px] text-content-muted">
                      <input
                        type="checkbox"
                        checked={selectable.length > 0 && selectable.every((i) => checked.has(i.issue))}
                        onChange={(e) => setChecked(e.target.checked ? new Set(selectable.map((i) => i.issue)) : new Set())}
                      />
                      Select all {selectable.length}
                    </label>
                  )
                  : null}
                <ul className="max-h-[70vh] divide-y divide-edge-subtle overflow-y-auto">
                  {shown.map((i) => {
                    const d = i.issue_detail
                    const on = current?.issue === i.issue
                    const sla = i.status === -2 ? slaState(i.created_at, d?.priority, policy) : null
                    const canCheck = i.status === -2 || i.status === 0
                    return (
                      <li key={i.id} className={cn('flex items-start gap-2 px-3 py-3 transition-colors', on ? 'bg-brand-50/60 dark:bg-brand-500/10' : 'hover:bg-surface-sunken/50')}>
                        {canCheck
                          ? (
                            <input
                              type="checkbox"
                              className="mt-1"
                              aria-label={`Select ${d?.name ?? 'request'}`}
                              checked={checked.has(i.issue)}
                              onChange={(e) => {
                                const next = new Set(checked)
                                if (e.target.checked) next.add(i.issue)
                                else next.delete(i.issue)
                                setChecked(next)
                              }}
                            />
                          )
                          : <span className="w-3.25" />}
                        <button type="button" onClick={() => setSelected(i.issue)} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
                          <span className="flex flex-wrap items-center gap-2">
                            {p ? <span className="font-mono text-[11px] text-content-subtle">{p.identifier}-{d?.sequence_id ?? '?'}</span> : null}
                            <StatusBadge kind={STATUS_META[i.status].kind}>{STATUS_META[i.status].label}</StatusBadge>
                            {sla ? <SlaChip sla={sla} /> : null}
                            <span className="ml-auto text-[11px] text-content-subtle">{formatRelative(i.created_at)}</span>
                          </span>
                          <span className="line-clamp-2 text-[13px] font-medium text-content">{d?.name ?? 'Untitled request'}</span>
                          {d?.priority && d.priority !== 'none' ? <span className="self-start"><StatusBadge kind={priorityKind(d.priority)} dot={false}>{d.priority}</StatusBadge></span> : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
              {current ? <IntakeDetail key={current.issue} projectId={projectId} identifier={p?.identifier} item={current} policy={policy} onOpenIssue={() => setOpenIssue(current.issue)} /> : null}
            </div>
          </>
        )}

      <NewRequestModal
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(i) => {
          setTab('pending')
          setSelected(i.issue)
        }}
      />
      {sharing ? <ShareFormModal projectId={projectId} note={meta.data?.formNote} onClose={() => setSharing(false)} /> : null}
      {policyOpen ? <SlaPolicyModal projectId={projectId} policy={policy} error={meta.error} onClose={() => setPolicyOpen(false)} /> : null}
      {openIssue ? <IssueDrawer projectId={projectId} issueId={openIssue} onClose={() => setOpenIssue(null)} onPick={setOpenIssue} /> : null}
    </div>
  )
}

function SlaChip({ sla }: { sla: NonNullable<ReturnType<typeof slaState>> }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
        sla.breached ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300' : sla.used > 0.75 ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-surface-sunken text-content-muted',
      )}
      title={`Triage due ${new Date(sla.dueAt).toLocaleString()}`}
    >
      {sla.breached ? `SLA −${formatDuration(sla.remainingMs)}` : `${formatDuration(sla.remainingMs)} left`}
    </span>
  )
}

/** Apply one triage decision to many requests, one Plane call each; stops at a rate limit. */
function BulkBar({ projectId, ids, onDone }: { projectId: string; ids: string[]; onDone(): void }) {
  const update = useUpdateIntake(projectId)
  const remove = useDeleteIntake(projectId)
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (label: string, fn: (id: string) => Promise<unknown>) => {
    setBusy(label)
    let ok = 0
    try {
      for (const id of ids) {
        await fn(id)
        ok++
      }
      toast.success(`${label}: ${ok} request${ok === 1 ? '' : 's'}`)
      onDone()
    } catch (e) {
      const p = planeProblem(e)
      toast.error(`${label} stopped after ${ok} of ${ids.length}. ${p.message}`)
    } finally {
      setBusy(null)
    }
  }
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString()
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-300/60 bg-brand-50/60 px-3 py-2 dark:border-brand-400/30 dark:bg-brand-500/10">
      <span className="text-[12px] font-medium text-content">{ids.length} selected</span>
      <Button size="xs" variant="primary" loading={busy === 'Accepted'} disabled={!!busy} onClick={() => run('Accepted', (id) => update.mutateAsync({ issue: id, patch: { status: 1 } }))}>Accept</Button>
      <Button size="xs" loading={busy === 'Declined'} disabled={!!busy} onClick={() => run('Declined', (id) => update.mutateAsync({ issue: id, patch: { status: -1 } }))}>Decline</Button>
      <Button size="xs" loading={busy === 'Snoozed a week'} disabled={!!busy} onClick={() => run('Snoozed a week', (id) => update.mutateAsync({ issue: id, patch: { status: 0, snoozed_till: week } }))}>Snooze 1 week</Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={!!busy}
        onClick={() => {
          if (confirm(`Delete ${ids.length} requests? Requests that were not accepted are removed with their work items.`)) void run('Deleted', (id) => remove.mutateAsync(id))
        }}
      >
        Delete
      </Button>
      <button type="button" onClick={onDone} className="ml-auto text-[12px] text-content-muted hover:text-content">Clear</button>
    </div>
  )
}

const SNOOZE: Array<[string, number]> = [['Tomorrow', 1], ['Next week', 7], ['In two weeks', 14], ['Next month', 30]]

function IntakeDetail({ projectId, identifier, item, policy, onOpenIssue }: { projectId: string; identifier?: string; item: plane.IntakeItem; policy: SlaPolicy; onOpenIssue(): void }) {
  const update = useUpdateIntake(projectId)
  const remove = useDeleteIntake(projectId)
  const toast = useToast()
  const [mode, setMode] = useState<null | 'snooze' | 'duplicate' | 'accept'>(null)
  const d = item.issue_detail
  const sla = item.status === -2 ? slaState(item.created_at, d?.priority, policy) : null
  const act = (label: string, patch: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ issue: item.issue, patch }, {
      onSuccess: () => {
        toast.success(label)
        setMode(null)
      },
      onError: (e) => toast.error(planeError(e, `${label} failed.`)),
    })
  const pending = item.status === -2 || item.status === 0

  return (
    <article className="rounded-xl border border-edge-default bg-surface-raised">
      <header className="border-b border-edge-subtle px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-content-subtle">
          <span className="font-mono">{identifier}-{d?.sequence_id ?? '?'}</span>
          <StatusBadge kind={STATUS_META[item.status].kind}>{STATUS_META[item.status].label}</StatusBadge>
          {sla ? <SlaChip sla={sla} /> : null}
          <span>submitted {formatRelative(item.created_at)}{item.source ? ` · via ${item.source.replace('_', ' ')}` : ''}</span>
          {item.status === 0 && item.snoozed_till ? <span>· back {formatRelative(item.snoozed_till)}</span> : null}
        </div>
        <h3 className="mt-1.5 text-[17px] font-semibold leading-snug text-content">{d?.name ?? 'Untitled request'}</h3>
      </header>
      <div className="px-5 py-4">
        {d?.description_html && d.description_html !== '<p></p>'
          ? <div className="prose-sm max-w-none text-[13px] leading-relaxed text-content [&_a]:text-brand-700 [&_p]:my-1.5" dangerouslySetInnerHTML={{ __html: d.description_html }} />
          : <p className="text-[13px] italic text-content-subtle">No description.</p>}
      </div>

      {mode === 'snooze'
        ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-edge-subtle px-5 py-3">
            <span className="text-[12px] text-content-muted">Snooze until</span>
            {SNOOZE.map(([label, days]) => (
              <Button key={label} size="xs" onClick={() => act(`Snoozed until ${label.toLowerCase()}`, { status: 0, snoozed_till: new Date(Date.now() + days * 86_400_000).toISOString() })}>
                {label}
              </Button>
            ))}
            <Button size="xs" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        )
        : mode === 'duplicate'
        ? (
          <div className="space-y-2 border-t border-edge-subtle px-5 py-3">
            <div className="text-[12px] text-content-muted">Duplicate of which existing work item?</div>
            <IssueSearch autoFocus project={projectId} exclude={[item.issue]} onPick={(h) => act(`Marked as duplicate of ${h.project__identifier}-${h.sequence_id}`, { status: 2, duplicate_to: h.id })} />
            <Button size="xs" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        )
        : mode === 'accept'
        ? <AcceptAs projectId={projectId} item={item} onDone={() => setMode(null)} />
        : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-edge-subtle px-5 py-3">
        {pending && mode === 'accept'
          ? <span className="text-[12px] text-content-muted">Shape the work item above, then accept.</span>
          : pending
          ? (
            <>
              <Button variant="primary" size="sm" loading={update.isPending} onClick={() => act('Accepted — added to the backlog', { status: 1 })}>Accept</Button>
              <Button size="sm" onClick={() => setMode(mode === 'accept' ? null : 'accept')}>Accept as…</Button>
              <Button size="sm" onClick={() => act('Declined', { status: -1 })}>Decline</Button>
              <Button size="sm" variant="ghost" onClick={() => setMode('snooze')}>Snooze…</Button>
              <Button size="sm" variant="ghost" onClick={() => setMode('duplicate')}>Duplicate of…</Button>
            </>
          )
          : item.status === 1
          ? <Button variant="primary" size="sm" onClick={onOpenIssue}>Open work item</Button>
          : <Button size="sm" onClick={() => act('Moved back to pending', { status: -2, snoozed_till: null })}>Reopen</Button>}
        <button
          type="button"
          onClick={() => {
            if (!confirm('Delete this request? A request that was not accepted is removed with its work item.')) return
            remove.mutate(item.issue, { onSuccess: () => toast.success('Request deleted'), onError: (e) => toast.error(planeError(e, "Couldn't delete the request.")) })
          }}
          className="ml-auto text-[12px] font-medium text-rose-700 hover:underline dark:text-rose-300"
        >
          Delete
        </button>
      </footer>
    </article>
  )
}

/**
 * Accept and shape in one step: a template (its priority and labels), an
 * owner, a sprint and an epic. The work item is accepted through Plane's
 * intake API, then updated and placed; the project's automation then runs.
 */
function AcceptAs({ projectId, item, onDone }: { projectId: string; item: plane.IntakeItem; onDone(): void }) {
  const update = useUpdateIntake(projectId)
  const labels = useLabels(projectId)
  const members = useProjectMembers(projectId)
  const cycles = useCycles(projectId)
  const modules = useModules(projectId)
  const custom = useStoreList<TemplateDoc>('define.template')
  const automation = useRunAutomation(projectId)
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const templates = useMemo(
    () => [...BUILTIN_TEMPLATES, ...(custom.data ?? []).filter((d) => !d.data.projectId || d.data.projectId === projectId).map((d) => ({ ...d.data, id: d.id }))],
    [custom.data, projectId],
  )
  const [tpl, setTpl] = useState('')
  const [priority, setPriority] = useState<string>(item.issue_detail?.priority ?? 'none')
  const [owner, setOwner] = useState('')
  const [sprint, setSprint] = useState('')
  const [epic, setEpic] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = templates.find((t) => t.id === tpl)
  const labelIds = (chosen?.labelNames ?? []).map((n) => labels.data?.find((l) => l.name.toLowerCase() === n.toLowerCase())?.id).filter((x): x is string => !!x)
  const openSprints = (cycles.data ?? []).filter((c) => sprintStatus(c) !== 'completed')

  const go = async () => {
    setBusy(true)
    try {
      await update.mutateAsync({ issue: item.issue, patch: { status: 1 } })
      const patch: Record<string, unknown> = {}
      if (priority && priority !== (item.issue_detail?.priority ?? 'none')) patch.priority = priority
      if (labelIds.length) patch.labels = labelIds
      if (owner) patch.assignees = [owner]
      if (Object.keys(patch).length) await planning.patchIssue(slug, projectId, item.issue, patch)
      if (sprint) await planning.addCycleIssues(slug, projectId, sprint, [item.issue])
      if (epic) await planning.addModuleIssues(slug, projectId, epic, [item.issue])
      const after = await planeClient.getIssue(slug, projectId, item.issue).catch(() => null)
      if (after) automation.mutate({ kind: 'created', after: toItemView(after) })
      for (const k of ['issues', 'plan-issues', 'cycles', 'modules', 'cycle-ids', 'module-ids']) qc.invalidateQueries({ queryKey: ['plane', k, slug, projectId] })
      toast.success(`Accepted${chosen ? ` as ${chosen.name}` : ''}`)
      onDone()
    } catch (e) {
      toast.error(planeError(e, "Couldn't finish accepting it."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 border-t border-edge-subtle px-5 py-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Template" hint={chosen?.labelNames?.length && !labelIds.length ? `No label named ${chosen.labelNames.join(' / ')} in this project.` : undefined}>
          <Select
            value={tpl}
            onChange={(e) => {
              setTpl(e.target.value)
              const t = templates.find((x) => x.id === e.target.value)
              if (t?.priority) setPriority(t.priority)
            }}
            options={[{ value: '', label: 'None' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
          />
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)} options={['urgent', 'high', 'medium', 'low', 'none'].map((v) => ({ value: v, label: v }))} />
        </Field>
        <Field label="Owner">
          <Select value={owner} onChange={(e) => setOwner(e.target.value)} options={[{ value: '', label: 'Unassigned' }, ...(members.data ?? []).map((m) => ({ value: m.id, label: m.display_name || m.email || m.id }))]} />
        </Field>
        <Field label="Sprint">
          <Select value={sprint} onChange={(e) => setSprint(e.target.value)} options={[{ value: '', label: 'Backlog' }, ...openSprints.map((c) => ({ value: c.id, label: c.name }))]} />
        </Field>
        <Field label="Epic">
          <Select value={epic} onChange={(e) => setEpic(e.target.value)} options={[{ value: '', label: 'None' }, ...(modules.data ?? []).map((m) => ({ value: m.id, label: m.name }))]} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} onClick={go}>Accept{chosen ? ` as ${chosen.name}` : ''}</Button>
      </div>
    </div>
  )
}

function ShareFormModal({ projectId, note, onClose }: { projectId: string; note?: string; onClose(): void }) {
  const toast = useToast()
  const save = usePatchIntakeMeta()
  const planeUrl = usePlaneLink(`projects/${projectId}/intake`)
  const [text, setText] = useState(note ?? '')
  const link = typeof location !== 'undefined' ? `${location.origin}${planningHref('intake', { tab: 'request' })}` : ''
  return (
    <Modal open onClose={onClose} title="Share the request form" description="Anyone signed in to the console can open this link and submit a request straight into this project's intake.">
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input readOnly value={link} className="min-w-0 flex-1 font-mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
          <Button
            variant="primary"
            onClick={() => {
              void navigator.clipboard?.writeText(note ? `${note}\n${link}` : link)
              toast.success('Link copied')
            }}
          >
            Copy
          </Button>
        </div>
        <Field label="Message to send with it" hint="Saved for next time (console-side).">
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Found a bug or need something? File it here:" />
        </Field>
        <div className="flex items-center justify-between gap-2">
          {planeUrl ? <a href={planeUrl} target="_blank" rel="noreferrer" className="text-[12px] text-brand-700 hover:underline dark:text-brand-300">Open intake in Plane ↗</a> : <span />}
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ id: projectId, fn: (c) => ({ ...(c ?? {}), formNote: text.trim() || undefined }) }, { onSuccess: () => toast.success('Message saved'), onError: (e) => toast.error(storeError(e)) })}>Save message</Button>
        </div>
      </div>
    </Modal>
  )
}

function SlaPolicyModal({ projectId, policy, error, onClose }: { projectId: string; policy: SlaPolicy; error: unknown; onClose(): void }) {
  const save = usePatchIntakeMeta()
  const toast = useToast()
  const keys = ['urgent', 'high', 'medium', 'low', 'none'] as const
  const [hours, setHours] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, String(policy.hours[k] ?? policy.hours.default ?? '')])))
  return (
    <Modal
      open
      onClose={onClose}
      title="Triage SLA"
      description="How long a pending request may wait, by priority. Kept in the console; timers show on each pending request."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!!error}
            onClick={() => {
              const next: SlaPolicy = { hours: { default: 120 } }
              for (const k of keys) {
                const v = Number(hours[k])
                if (Number.isFinite(v) && v > 0) next.hours[k] = v
              }
              save.mutate({ id: projectId, fn: (c) => ({ ...(c ?? {}), sla: next }) }, {
                onSuccess: () => {
                  toast.success('Triage SLA saved')
                  onClose()
                },
                onError: (e) => toast.error(storeError(e)),
              })
            }}
          >
            Save
          </Button>
        </div>
      }
    >
      {error ? <Notice tone="warn">{storeError(error)}</Notice> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {keys.map((k) => (
            <Field key={k} label={k} hint="hours">
              <Input type="number" min={1} value={hours[k]} onChange={(e) => setHours({ ...hours, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
      )}
    </Modal>
  )
}

function NewRequestModal({ projectId, open, onClose, onCreated }: { projectId: string; open: boolean; onClose(): void; onCreated(i: plane.IntakeItem): void }) {
  const create = useCreateIntake(projectId)
  const toast = useToast()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [priority, setPriority] = useState<plane.Priority>('none')
  const reset = () => {
    setName('')
    setDesc('')
    setPriority('none')
  }
  const submit = () => {
    if (!name.trim()) return
    const html = desc.trim() ? desc.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('') : '<p></p>'
    create.mutate({ name: name.trim(), description_html: html, priority }, {
      onSuccess: (item) => {
        toast.success('Request submitted for triage')
        reset()
        onClose()
        onCreated(item)
      },
      onError: (e) => toast.error(planeError(e, "Couldn't submit the request.")),
    })
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New request"
      description="It lands in Intake as pending until someone triages it."
      footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!name.trim()} loading={create.isPending} onClick={submit}>Submit request</Button>
        </div>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Title" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="What is needed, in one line" />
        </Field>
        <Field label="Details">
          <Textarea rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Context, steps to reproduce, who asked…" />
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as plane.Priority)} options={['none', 'low', 'medium', 'high', 'urgent'].map((v) => ({ value: v, label: v }))} />
        </Field>
      </form>
    </Modal>
  )
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
