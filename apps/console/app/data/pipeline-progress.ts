/**
 * Stage progress of a Tekton PipelineRun, as a person would count it.
 *
 * The Deployment tab used to show `childReferences.length / pipelineSpec.tasks`
 * as "done/total". A child reference exists for every TaskRun that was ever
 * STARTED — running, failed or retried ones included — and a task that was
 * skipped because an earlier one failed never gets one at all. So a release
 * whose build failed read "3/7 tasks" for ever, and a run still building read
 * as further along than it was.
 *
 * Tekton writes the truth into the run's `Succeeded` condition message, in one
 * of two shapes:
 *
 *   Tasks Completed: 3 (Failed: 1, Cancelled 0), Skipped: 4
 *   Tasks Completed: 2 (Failed: 0, Cancelled 0), Incomplete: 4, Skipped: 0
 *
 * `done` counts tasks that reached a terminal state, failures included —
 * "done" is about progress through the graph, and the failure is reported
 * beside it rather than hidden inside it. `total` is the whole graph:
 * completed + incomplete + skipped when Tekton says so, else the spec's
 * task count. Child references remain the fallback for a run so young it
 * has no message yet.
 */
export interface TaskProgress {
  done: number
  total: number
  failed?: number
  skipped?: number
}

const COUNT = (label: string, message: string): number | undefined => {
  const m = new RegExp(`${label}:?\\s*(\\d+)`).exec(message)
  return m ? Number(m[1]) : undefined
}

export function taskProgress(
  message: string | undefined,
  specTotal: number | undefined,
  childReferences: number | undefined,
): TaskProgress | undefined {
  const completed = message ? COUNT('Tasks Completed', message) : undefined
  if (typeof completed === 'number') {
    const failed = COUNT('Failed', message!) ?? 0
    const cancelled = COUNT('Cancelled', message!) ?? 0
    const skipped = COUNT('Skipped', message!) ?? 0
    const incomplete = COUNT('Incomplete', message!)
    const total = typeof incomplete === 'number'
      ? completed + incomplete + skipped
      : Math.max(specTotal ?? 0, completed + skipped)
    const out: TaskProgress = { done: Math.min(completed, total), total }
    if (failed + cancelled > 0) out.failed = failed + cancelled
    if (skipped > 0) out.skipped = skipped
    return out
  }
  if (typeof specTotal === 'number' && typeof childReferences === 'number') {
    return { done: Math.min(childReferences, specTotal), total: specTotal }
  }
  return undefined
}

/** `3/7 tasks`, with what went wrong beside it: `3/7 tasks · 1 failed · 4 skipped`. */
export function describeProgress(p: TaskProgress): string {
  const parts = [`${p.done}/${p.total} tasks`]
  if (p.failed) parts.push(`${p.failed} failed`)
  if (p.skipped) parts.push(`${p.skipped} skipped`)
  return parts.join(' · ')
}
