import { useMemo, useRef, useState } from 'react'
import { Button, Modal, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { planeError } from '../data/plane.ts'
import { type BulkChange, type BulkPlan, planBulk, requestCount } from '../data/work-bulk.ts'
import { useBulkRunner, type WorkItem } from '../data/work-hooks.ts'
import type { WorkScope } from '../data/work-scope.ts'
import { memberItems } from './issue-fields.tsx'
import { IconArchive, IconClose, IconDownload, PickMenu, type PickItem, Popover, PRIORITIES, PRIORITY_LABEL, PriorityIcon, StateDot } from './work-ui.tsx'

/**
 * Bulk edit bar for a selection: status, assignees (add / replace / remove),
 * priority, labels (add / remove), sprint, epic, estimate, archive. Every
 * change is planned first (unchanged items skipped, sprint/epic moves batched
 * into one request each) and confirmed with the request count against
 * Plane's shared 60-a-minute budget before it runs.
 */

const mergePlans = (plans: BulkPlan[]): BulkPlan => ({
  patches: plans.flatMap((p) => p.patches),
  cycleAdd: plans.flatMap((p) => p.cycleAdd),
  cycleRemove: plans.flatMap((p) => p.cycleRemove),
  moduleAdd: plans.flatMap((p) => p.moduleAdd),
  moduleRemove: plans.flatMap((p) => p.moduleRemove),
  archive: plans.flatMap((p) => p.archive),
  skipped: plans.flatMap((p) => p.skipped),
})

type Menu = 'state' | 'assignees' | 'priority' | 'labels' | 'sprint' | 'epic' | 'estimate' | null

export function IssueBulkBar({ selected, scope, onClear, onExport }: { selected: WorkItem[]; scope: WorkScope; onClear(): void; onExport(items: WorkItem[]): void }) {
  const toast = useToast()
  const run = useBulkRunner()
  const [menu, setMenu] = useState<Menu>(null)
  const [mode, setMode] = useState<'add' | 'set' | 'remove'>('add')
  const [estimate, setEstimate] = useState('')
  const [pending, setPending] = useState<{ title: string; plan: BulkPlan } | null>(null)
  const [running, setRunning] = useState(false)
  const anchors = {
    state: useRef<HTMLButtonElement>(null),
    assignees: useRef<HTMLButtonElement>(null),
    priority: useRef<HTMLButtonElement>(null),
    labels: useRef<HTMLButtonElement>(null),
    sprint: useRef<HTMLButtonElement>(null),
    epic: useRef<HTMLButtonElement>(null),
    estimate: useRef<HTMLButtonElement>(null),
  }
  const projects = useMemo(() => [...new Set(selected.map((i) => i.project))], [selected])
  const single = projects.length === 1 ? projects[0] : undefined
  const lite = selected.some((i) => scope.liteProjects.includes(i.project))
  const groupOf = (s: string) => scope.stateById.get(s)?.group

  /** Plan per project, mapping a picked state / label to the same-named one in each project. */
  const planFor = (change: BulkChange): BulkPlan => {
    const byProject = new Map<string, WorkItem[]>()
    for (const i of selected) (byProject.get(i.project) ?? byProject.set(i.project, []).get(i.project)!).push(i)
    const plans: BulkPlan[] = []
    for (const [p, items] of byProject) {
      let c: BulkChange | undefined = change
      if (change.kind === 'state') {
        const name = scope.stateById.get(change.state)?.name.toLowerCase()
        const own = scope.states.find((s) => s.project === p && s.name.toLowerCase() === name)
        c = own ? { kind: 'state', state: own.id } : undefined
        if (!c) {
          plans.push({ ...planBulk([], change), skipped: items.map((i) => ({ id: i.id, reason: `no "${name}" state in ${scope.projectById.get(p)?.identifier ?? 'its project'}` })) })
          continue
        }
      }
      if (change.kind === 'labels') {
        const names = change.ids.map((id) => scope.labelById.get(id)?.name.toLowerCase())
        const ids = scope.labels.filter((l) => l.project === p && names.includes(l.name.toLowerCase())).map((l) => l.id)
        c = { ...change, ids }
      }
      plans.push(planBulk(items, c, { stateGroup: groupOf, stateProject: (s) => scope.stateById.get(s)?.project }))
    }
    return mergePlans(plans)
  }

  const propose = (title: string, change: BulkChange) => {
    setMenu(null)
    const plan = planFor(change)
    if (!requestCount(plan)) {
      toast.info('Nothing to change', { description: plan.skipped[0] ? `Every selected item was skipped — ${plan.skipped[0].reason}.` : undefined })
      return
    }
    setPending({ title, plan })
  }

  const execute = async () => {
    if (!pending) return
    const { plan, title } = pending
    setRunning(true)
    const id = toast.loading(`${title} — 0 / ${requestCount(plan)} requests`)
    try {
      const res = await run(plan, (done, total) => toast.loading(`${title} — ${done} / ${total} requests`, { id }))
      if (res.failed.length) {
        toast.error(`${title}: ${res.ok} updated, ${res.failed.reduce((n, f) => n + f.ids.length, 0)} failed`, { id, description: planeError(res.failed[0].error) })
      } else {
        toast.success(`${title}: ${res.ok} item${res.ok === 1 ? '' : 's'} updated`, { id, description: plan.skipped.length ? `${plan.skipped.length} skipped (no change needed or not allowed).` : undefined })
        if (plan.archive.length) onClear()
      }
    } catch (e) {
      toast.error(planeError(e, 'Bulk update failed.'), { id })
    } finally {
      setRunning(false)
      setPending(null)
    }
  }

  const stateItems: PickItem[] = (single ? scope.states.filter((s) => s.project === single) : uniqueByName(scope.states)).map((s) => ({ id: s.id, label: s.name, hint: s.group, icon: <StateDot state={s} /> }))
  const labelItems: PickItem[] = (single ? scope.labels.filter((l) => l.project === single) : uniqueByName(scope.labels)).map((l) => ({ id: l.id, label: l.name, icon: <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} /> }))
  const sprintItems: PickItem[] = single ? [{ id: '_none', label: 'Remove from sprint' }, ...scope.cycles.filter((c) => c.project === single && c.status !== 'completed').map((c) => ({ id: c.id, label: c.name, hint: c.status }))] : []
  const epicItems: PickItem[] = single ? [{ id: '_none', label: 'Remove from epic' }, ...scope.modules.filter((m) => m.project === single).map((m) => ({ id: m.id, label: m.name, hint: m.status }))] : []

  const btn = 'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-content hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50'
  const modeTabs = (
    <div className="flex gap-0.5 border-b border-edge-subtle p-1">
      {(['add', 'set', 'remove'] as const).map((m) => (
        <button key={m} type="button" onClick={() => setMode(m)} className={cn('flex-1 rounded px-2 py-1 text-[11px] font-medium', mode === m ? 'bg-surface-sunken text-content' : 'text-content-muted hover:text-content')}>
          {m === 'add' ? 'Add' : m === 'set' ? 'Replace with' : 'Remove'}
        </button>
      ))}
    </div>
  )
  const [multiPick, setMultiPick] = useState<string[]>([])

  return (
    <>
      <div role="toolbar" aria-label="Bulk actions" className="sticky top-2 z-20 flex flex-wrap items-center gap-1 rounded-xl border border-brand-300 bg-surface-raised px-2 py-1.5 shadow-lg dark:border-brand-500/40">
        <span className="px-1.5 text-[12px] font-semibold text-content">{selected.length} selected</span>
        <span className="mx-1 h-4 w-px bg-edge-default" />
        <button ref={anchors.state} type="button" className={btn} onClick={() => setMenu('state')}>Status ▾</button>
        <button ref={anchors.assignees} type="button" className={btn} onClick={() => { setMultiPick([]); setMenu('assignees') }}>Assignee ▾</button>
        <button ref={anchors.priority} type="button" className={btn} onClick={() => setMenu('priority')}>Priority ▾</button>
        <button ref={anchors.labels} type="button" className={btn} onClick={() => { setMultiPick([]); setMenu('labels') }}>Labels ▾</button>
        <button ref={anchors.sprint} type="button" className={btn} disabled={!single || lite} title={!single ? 'Sprints belong to one project — select items from a single project' : undefined} onClick={() => setMenu('sprint')}>Sprint ▾</button>
        <button ref={anchors.epic} type="button" className={btn} disabled={!single || lite} title={!single ? 'Epics belong to one project — select items from a single project' : undefined} onClick={() => setMenu('epic')}>Epic ▾</button>
        <button ref={anchors.estimate} type="button" className={btn} onClick={() => setMenu('estimate')}>Estimate ▾</button>
        <button type="button" className={btn} onClick={() => propose('Archive', { kind: 'archive' })}><IconArchive /> Archive</button>
        <button type="button" className={btn} onClick={() => onExport(selected)}><IconDownload /> CSV</button>
        <button type="button" aria-label="Clear selection" onClick={onClear} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"><IconClose /></button>
      </div>

      <Popover anchor={anchors.state} open={menu === 'state'} onClose={() => setMenu(null)}>
        <PickMenu items={stateItems} selected={[]} onPick={(id) => propose(`Move to ${scope.stateById.get(id)?.name}`, { kind: 'state', state: id })} onClose={() => setMenu(null)} placeholder="Move to status…" />
      </Popover>
      <Popover anchor={anchors.priority} open={menu === 'priority'} onClose={() => setMenu(null)} width={200}>
        <PickMenu items={PRIORITIES.map((p) => ({ id: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))} selected={[]} onPick={(p) => propose(`Priority → ${PRIORITY_LABEL[p as plane.Priority]}`, { kind: 'priority', priority: p })} onClose={() => setMenu(null)} />
      </Popover>
      <Popover anchor={anchors.assignees} open={menu === 'assignees'} onClose={() => setMenu(null)} width={260}>
        {modeTabs}
        <PickMenu
          items={memberItems(scope.members)}
          selected={multiPick}
          multi
          onPick={(id) => setMultiPick((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
          onClose={() => setMenu(null)}
          placeholder="People…"
          footer={<Button size="xs" variant="primary" block disabled={mode !== 'set' && !multiPick.length} onClick={() => propose(mode === 'add' ? 'Add assignees' : mode === 'set' ? (multiPick.length ? 'Replace assignees' : 'Unassign') : 'Remove assignees', { kind: 'assignees', mode, ids: multiPick })}>{mode === 'set' && !multiPick.length ? 'Unassign all' : 'Apply'}</Button>}
        />
      </Popover>
      <Popover anchor={anchors.labels} open={menu === 'labels'} onClose={() => setMenu(null)} width={260}>
        {modeTabs}
        <PickMenu
          items={labelItems}
          selected={multiPick}
          multi
          onPick={(id) => setMultiPick((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
          onClose={() => setMenu(null)}
          placeholder="Labels…"
          footer={<Button size="xs" variant="primary" block disabled={mode !== 'set' && !multiPick.length} onClick={() => propose(mode === 'add' ? 'Add labels' : mode === 'set' ? 'Replace labels' : 'Remove labels', { kind: 'labels', mode, ids: multiPick })}>Apply</Button>}
        />
      </Popover>
      <Popover anchor={anchors.sprint} open={menu === 'sprint'} onClose={() => setMenu(null)}>
        <PickMenu items={sprintItems} selected={[]} onPick={(id) => propose(id === '_none' ? 'Remove from sprint' : `Move to ${scope.cycleById.get(id)?.name}`, { kind: 'cycle', cycle: id === '_none' ? null : id })} onClose={() => setMenu(null)} placeholder="Sprint…" />
      </Popover>
      <Popover anchor={anchors.epic} open={menu === 'epic'} onClose={() => setMenu(null)}>
        <PickMenu items={epicItems} selected={[]} onPick={(id) => propose(id === '_none' ? 'Remove from epic' : `Move to ${scope.moduleById.get(id)?.name}`, { kind: 'module', module: id === '_none' ? null : id })} onClose={() => setMenu(null)} placeholder="Epic…" />
      </Popover>
      <Popover anchor={anchors.estimate} open={menu === 'estimate'} onClose={() => setMenu(null)} width={220}>
        <form
          className="space-y-2 p-2"
          onSubmit={(e) => {
            e.preventDefault()
            const v = estimate.trim() === '' ? null : Number(estimate)
            if (v !== null && !Number.isFinite(v)) return
            propose(v === null ? 'Clear estimate' : `Estimate → ${v}`, { kind: 'estimate', value: v })
          }}
        >
          <input autoFocus inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="Points (empty clears)" className="h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12.5px]" />
          <p className="text-[11px] text-content-subtle">Must be one of the project's Plane estimate points.</p>
          <Button size="xs" variant="primary" block type="submit">Apply</Button>
        </form>
      </Popover>

      <Modal
        open={!!pending}
        onClose={() => !running && setPending(null)}
        title={pending?.title ?? ''}
        description={pending ? `${requestCount(pending.plan)} Plane request${requestCount(pending.plan) === 1 ? '' : 's'} for ${selected.length} selected item${selected.length === 1 ? '' : 's'}.` : undefined}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)} disabled={running}>Cancel</Button>
            <Button size="sm" variant={pending?.plan.archive.length ? 'danger' : 'primary'} loading={running} onClick={execute}>
              {pending?.plan.archive.length ? `Archive ${pending.plan.archive.length}` : 'Apply'}
            </Button>
          </>
        }
      >
        {pending ? <PlanSummary plan={pending.plan} scope={scope} /> : null}
      </Modal>
    </>
  )
}

function PlanSummary({ plan, scope }: { plan: BulkPlan; scope: WorkScope }) {
  const n = requestCount(plan)
  const key = (id: string) => {
    const i = scope.itemById.get(id)
    return i ? scope.keyOf(i) : id.slice(0, 8)
  }
  const reasons = new Map<string, string[]>()
  for (const s of plan.skipped) (reasons.get(s.reason) ?? reasons.set(s.reason, []).get(s.reason)!).push(key(s.id))
  return (
    <div className="space-y-3 text-[13px]">
      <ul className="list-disc space-y-0.5 pl-5 text-content-muted">
        {plan.patches.length ? <li>{plan.patches.length} item update{plan.patches.length === 1 ? '' : 's'} (one request each — Plane has no bulk edit)</li> : null}
        {plan.cycleAdd.map((c) => <li key={c.cycle}>{c.ids.length} into sprint <strong className="text-content">{scope.cycleById.get(c.cycle)?.name}</strong> (one request)</li>)}
        {plan.cycleRemove.length ? <li>{plan.cycleRemove.length} removed from their sprint</li> : null}
        {plan.moduleAdd.map((m) => <li key={m.module}>{m.ids.length} into epic <strong className="text-content">{scope.moduleById.get(m.module)?.name}</strong> (one request)</li>)}
        {plan.moduleRemove.length ? <li>{plan.moduleRemove.length} removed from their epic</li> : null}
        {plan.archive.length ? <li><strong className="text-content">{plan.archive.length} archived</strong> — Plane hides archived items everywhere; restore them from Plane's Archives.</li> : null}
      </ul>
      {reasons.size ? (
        <div className="rounded-lg bg-surface-sunken/70 p-2.5 text-[12px] text-content-muted">
          <p className="font-medium text-content">Skipped</p>
          {[...reasons].map(([r, keys]) => <p key={r}>{keys.slice(0, 6).join(', ')}{keys.length > 6 ? ` +${keys.length - 6}` : ''} — {r}</p>)}
        </div>
      ) : null}
      {n > 40 ? (
        <p className="rounded-lg bg-amber-50 p-2.5 text-[12px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          This uses most of the console's shared Plane budget (60 requests a minute for every user). It runs two at a time and waits out Plane's rate limit if it hits it, so it may take a minute or two.
        </p>
      ) : null}
    </div>
  )
}

function uniqueByName<T extends { name: string }>(xs: T[]): T[] {
  const seen = new Set<string>()
  return xs.filter((x) => {
    const k = x.name.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
