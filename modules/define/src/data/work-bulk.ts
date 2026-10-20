/**
 * Bulk edit planning + execution for work items.
 *
 * Plane's public API has no bulk-update endpoint, so a bulk edit is one PATCH
 * per item — except sprint (cycle) and epic (module) moves, whose membership
 * endpoints take `{issues: [...]}` and so cost ONE request for the whole
 * selection. The plan skips items that would not change (no wasted calls
 * against the console's shared 60-requests-a-minute Plane budget), and the
 * runner throttles, waits out a 429 once, and reports per-item failures.
 */

export interface BulkIssue {
  id: string
  project: string
  state: string
  priority: string
  assignees: string[]
  labels: string[]
  cycle?: string | null
  module?: string | null
  estimate_point?: number | null
}

export type BulkChange =
  | { kind: 'state'; state: string }
  | { kind: 'priority'; priority: string }
  | { kind: 'assignees'; mode: 'add' | 'remove' | 'set'; ids: string[] }
  | { kind: 'labels'; mode: 'add' | 'remove' | 'set'; ids: string[] }
  | { kind: 'cycle'; cycle: string | null }
  | { kind: 'module'; module: string | null }
  | { kind: 'estimate'; value: number | null }
  | { kind: 'archive' }

export interface BulkPatch {
  id: string
  project: string
  patch: Record<string, unknown>
  /** `mapped` goes through the client that maps estimate values to Plane point ids. */
  via: 'raw' | 'mapped'
}

export interface BulkPlan {
  patches: BulkPatch[]
  /** One bulk POST per (project, container). */
  cycleAdd: Array<{ project: string; cycle: string; ids: string[] }>
  cycleRemove: Array<{ project: string; cycle: string; id: string }>
  moduleAdd: Array<{ project: string; module: string; ids: string[] }>
  moduleRemove: Array<{ project: string; module: string; id: string }>
  archive: Array<{ project: string; id: string }>
  skipped: Array<{ id: string; reason: string }>
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

function nextSet(cur: string[], mode: 'add' | 'remove' | 'set', ids: string[]): string[] {
  if (mode === 'set') return [...new Set(ids)]
  if (mode === 'add') return [...new Set([...cur, ...ids])]
  return cur.filter((x) => !ids.includes(x))
}

/**
 * Turn "change X on these items" into the smallest set of Plane requests.
 * `stateGroup` resolves an item's state to its group (archive needs done/cancelled);
 * `stateProject` the project a state id belongs to (states are per project).
 */
export function planBulk(
  issues: BulkIssue[],
  change: BulkChange,
  opts: { stateGroup?(stateId: string): string | undefined; stateProject?(stateId: string): string | undefined } = {},
): BulkPlan {
  const plan: BulkPlan = { patches: [], cycleAdd: [], cycleRemove: [], moduleAdd: [], moduleRemove: [], archive: [], skipped: [] }
  const addTo = (list: Array<{ project: string; ids: string[] } & Record<string, unknown>>, key: string, project: string, container: string, id: string) => {
    let entry = list.find((x) => x.project === project && x[key] === container)
    if (!entry) {
      entry = { project, [key]: container, ids: [] } as { project: string; ids: string[] } & Record<string, unknown>
      list.push(entry)
    }
    entry.ids.push(id)
  }
  for (const i of issues) {
    switch (change.kind) {
      case 'state': {
        const sp = opts.stateProject?.(change.state)
        if (sp && sp !== i.project) {
          plan.skipped.push({ id: i.id, reason: 'that state belongs to another project' })
          break
        }
        if (i.state === change.state) plan.skipped.push({ id: i.id, reason: 'already in that state' })
        else plan.patches.push({ id: i.id, project: i.project, patch: { state: change.state }, via: 'raw' })
        break
      }
      case 'priority':
        if (i.priority === change.priority) plan.skipped.push({ id: i.id, reason: 'already that priority' })
        else plan.patches.push({ id: i.id, project: i.project, patch: { priority: change.priority }, via: 'raw' })
        break
      case 'assignees': {
        const next = nextSet(i.assignees, change.mode, change.ids)
        if (sameSet(next, i.assignees)) plan.skipped.push({ id: i.id, reason: 'no assignee change' })
        else plan.patches.push({ id: i.id, project: i.project, patch: { assignees: next }, via: 'raw' })
        break
      }
      case 'labels': {
        const next = nextSet(i.labels, change.mode, change.ids)
        if (sameSet(next, i.labels)) plan.skipped.push({ id: i.id, reason: 'no label change' })
        else plan.patches.push({ id: i.id, project: i.project, patch: { labels: next }, via: 'raw' })
        break
      }
      case 'estimate':
        if ((i.estimate_point ?? null) === change.value) plan.skipped.push({ id: i.id, reason: 'already that estimate' })
        else plan.patches.push({ id: i.id, project: i.project, patch: { estimate_point: change.value }, via: 'mapped' })
        break
      case 'cycle': {
        const cur = i.cycle ?? null
        if (cur === change.cycle) {
          plan.skipped.push({ id: i.id, reason: 'already in that sprint' })
          break
        }
        // Adding to a cycle moves the item out of its old one server-side.
        if (change.cycle) addTo(plan.cycleAdd as never, 'cycle', i.project, change.cycle, i.id)
        else if (cur) plan.cycleRemove.push({ project: i.project, cycle: cur, id: i.id })
        break
      }
      case 'module': {
        const cur = i.module ?? null
        if (cur === change.module) {
          plan.skipped.push({ id: i.id, reason: 'already in that epic' })
          break
        }
        if (cur) plan.moduleRemove.push({ project: i.project, module: cur, id: i.id })
        if (change.module) addTo(plan.moduleAdd as never, 'module', i.project, change.module, i.id)
        break
      }
      case 'archive': {
        const g = opts.stateGroup?.(i.state)
        if (g !== 'completed' && g !== 'cancelled') plan.skipped.push({ id: i.id, reason: 'only done or cancelled items can be archived (Plane rule)' })
        else plan.archive.push({ project: i.project, id: i.id })
        break
      }
    }
  }
  return plan
}

/** Plane requests a plan will make. */
export function requestCount(plan: BulkPlan): number {
  return plan.patches.length + plan.cycleAdd.length + plan.cycleRemove.length + plan.moduleAdd.length + plan.moduleRemove.length + plan.archive.length
}

/** Seconds Plane asked us to wait, from a DRF throttle error ("Expected available in 37 seconds."). */
export function retryAfterSeconds(e: unknown): number | undefined {
  const err = e as { status?: number; body?: unknown; message?: string } | undefined
  if (err?.status !== 429) return undefined
  const body = err.body as { detail?: unknown; retry_after?: unknown } | undefined
  if (typeof body?.retry_after === 'number') return body.retry_after
  const text = typeof body?.detail === 'string' ? body.detail : err.message ?? ''
  const m = /(\d+)\s*sec/i.exec(text)
  return m ? Number(m[1]) : 60
}

export interface BulkExecutors {
  patch(p: BulkPatch): Promise<unknown>
  cycleAdd(project: string, cycle: string, ids: string[]): Promise<unknown>
  cycleRemove(project: string, cycle: string, id: string): Promise<unknown>
  moduleAdd(project: string, module: string, ids: string[]): Promise<unknown>
  moduleRemove(project: string, module: string, id: string): Promise<unknown>
  archive(project: string, id: string): Promise<unknown>
}

export interface BulkResult {
  ok: number
  failed: Array<{ ids: string[]; error: unknown }>
}

/**
 * Run a plan with bounded concurrency. A 429 pauses that task for the
 * advertised window (capped) and retries it once; other errors are recorded
 * per item and the rest of the plan continues.
 */
export async function runBulk(
  plan: BulkPlan,
  exec: BulkExecutors,
  opts: { concurrency?: number; maxWaitMs?: number; sleep?(ms: number): Promise<void>; onProgress?(done: number, total: number): void } = {},
): Promise<BulkResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxWait = opts.maxWaitMs ?? 65_000
  // Removals before additions, so a module move never leaves the item in both.
  const tasks: Array<{ ids: string[]; run(): Promise<unknown> }> = [
    ...plan.moduleRemove.map((t) => ({ ids: [t.id], run: () => exec.moduleRemove(t.project, t.module, t.id) })),
    ...plan.cycleRemove.map((t) => ({ ids: [t.id], run: () => exec.cycleRemove(t.project, t.cycle, t.id) })),
    ...plan.cycleAdd.map((t) => ({ ids: t.ids, run: () => exec.cycleAdd(t.project, t.cycle, t.ids) })),
    ...plan.moduleAdd.map((t) => ({ ids: t.ids, run: () => exec.moduleAdd(t.project, t.module, t.ids) })),
    ...plan.patches.map((p) => ({ ids: [p.id], run: () => exec.patch(p) })),
    ...plan.archive.map((t) => ({ ids: [t.id], run: () => exec.archive(t.project, t.id) })),
  ]
  const result: BulkResult = { ok: 0, failed: [] }
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++]
      try {
        await t.run()
        result.ok += t.ids.length
      } catch (e) {
        const wait = retryAfterSeconds(e)
        if (wait !== undefined) {
          await sleep(Math.min(wait * 1000 + 250, maxWait))
          try {
            await t.run()
            result.ok += t.ids.length
          } catch (e2) {
            result.failed.push({ ids: t.ids, error: e2 })
          }
        } else {
          result.failed.push({ ids: t.ids, error: e })
        }
      }
      done++
      opts.onProgress?.(done, tasks.length)
    }
  }
  const n = Math.max(1, Math.min(opts.concurrency ?? 2, tasks.length))
  await Promise.all(Array.from({ length: n }, worker))
  return result
}
