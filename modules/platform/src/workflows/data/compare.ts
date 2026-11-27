import { elapsedMs, msOf, runPhase, type WfNode, type Workflow } from './nodes.ts'

/**
 * "Compare two runs" (design 0026 §6.9 History): the parameter diff, the
 * per-step duration delta and each outcome. Pure: `compare_test.ts`.
 */

export interface ParamDiff {
  name: string
  a?: string
  b?: string
}

export interface StepDelta {
  step: string
  aPhase?: string
  bPhase?: string
  aMs?: number
  bMs?: number
  /** b − a, when both ran. */
  deltaMs?: number
}

export interface RunComparison {
  a: { name: string; phase: string; durationMs?: number }
  b: { name: string; phase: string; durationMs?: number }
  params: ParamDiff[]
  steps: StepDelta[]
}

function params(w: Workflow): Map<string, string | undefined> {
  const list = w.spec?.arguments?.parameters ?? w.status?.storedWorkflowTemplateSpec?.arguments?.parameters ?? []
  return new Map(list.map((p) => [p.name, p.value ?? p.default]))
}

/** One entry per step display name: the LAST attempt of a retried step is the one that counted. */
function steps(nodes: Record<string, WfNode> | undefined): Map<string, WfNode> {
  const out = new Map<string, WfNode>()
  for (const n of Object.values(nodes ?? {})) {
    if (n.type !== 'Pod' && n.type !== 'Suspend' && n.type !== 'Container' && n.type !== 'HTTP') continue
    const key = (n.displayName ?? n.name).replace(/\(\d+\)$/, '')
    const prev = out.get(key)
    if (!prev || (msOf(n.startedAt) ?? 0) >= (msOf(prev.startedAt) ?? 0)) out.set(key, n)
  }
  return out
}

const runDuration = (w: Workflow) => {
  const s = msOf(w.status?.startedAt), f = msOf(w.status?.finishedAt)
  return s !== undefined && f !== undefined ? f - s : undefined
}

export function compareRuns(a: Workflow, b: Workflow): RunComparison {
  const pa = params(a), pb = params(b)
  const names = [...new Set([...pa.keys(), ...pb.keys()])].sort()
  const diff: ParamDiff[] = names.filter((n) => pa.get(n) !== pb.get(n)).map((name) => ({ name, a: pa.get(name), b: pb.get(name) }))
  const sa = steps(a.status?.nodes), sb = steps(b.status?.nodes)
  const order = [...new Set([...sa.keys(), ...sb.keys()])].sort((x, y) => (msOf(sa.get(x)?.startedAt ?? sb.get(x)?.startedAt) ?? 0) - (msOf(sa.get(y)?.startedAt ?? sb.get(y)?.startedAt) ?? 0) || x.localeCompare(y))
  const stepRows: StepDelta[] = order.map((step) => {
    const x = sa.get(step), y = sb.get(step)
    const aMs = x?.finishedAt ? elapsedMs(x.startedAt, x.finishedAt, 0) : undefined
    const bMs = y?.finishedAt ? elapsedMs(y.startedAt, y.finishedAt, 0) : undefined
    return { step, aPhase: x?.phase, bPhase: y?.phase, aMs, bMs, deltaMs: aMs !== undefined && bMs !== undefined ? bMs - aMs : undefined }
  })
  return {
    a: { name: a.metadata.name, phase: runPhase(a), durationMs: runDuration(a) },
    b: { name: b.metadata.name, phase: runPhase(b), durationMs: runDuration(b) },
    params: diff,
    steps: stepRows,
  }
}
