import type { WfNode, Workflow } from './nodes.ts'
import { isTimerNode, submitterOf } from './nodes.ts'

/**
 * Pending approvals (design 0026 §6.4, §6.9): a suspend node that is waiting,
 * with what it asks, who may answer and whether the submitter may. This is the
 * UI's reading only — it decides what to OFFER. The BFF decides (it re-reads
 * the run and applies the same policy as the user), so the two cannot disagree
 * in the person's favour. Pure: `approvals_test.ts`.
 */

export interface PendingApproval {
  namespace: string
  run: string
  nodeId: string
  /** The task the node belongs to, as the graph names it. */
  task: string
  question?: string
  /** Groups and users; empty = anyone allowed to update the workflow. */
  approvers: string[]
  forbidSelfApproval: boolean
  /** Supplied output parameters the node declares (decision, comment, approver …). */
  outputs: string[]
  startedAt?: string
  /** Suspend timeout from the node's input, when the template declares one. */
  timeout?: string
  submitter?: string
}

export interface Person {
  id?: string
  name?: string
  email?: string
  groups?: string[]
}

const param = (n: WfNode, name: string) => {
  const p = n.inputs?.parameters?.find((x) => x?.name === name)
  return p?.value ?? p?.default
}

/** The approval a node waits for, or null when it is not a waiting suspend node. */
export function approvalOf(w: Workflow, node: WfNode | undefined): PendingApproval | null {
  if (!node?.id || node.type !== 'Suspend' || node.phase !== 'Running') return null
  if (isTimerNode(w, node)) return null
  return {
    namespace: w.metadata.namespace ?? '',
    run: w.metadata.name,
    nodeId: node.id,
    task: (node.displayName ?? node.name).replace(/\(\d+\)$/, ''),
    question: param(node, 'question') ?? node.message,
    approvers: (param(node, 'approvers') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    forbidSelfApproval: (param(node, 'forbidSelfApproval') ?? '').toLowerCase() === 'true',
    outputs: (node.outputs?.parameters ?? []).filter((p) => p?.name && p.valueFrom && 'supplied' in p.valueFrom).map((p) => p.name),
    startedAt: node.startedAt,
    timeout: param(node, 'timeout'),
    submitter: submitterOf(w),
  }
}

/** Every approval a run is waiting for. */
export function pendingApprovals(w: Workflow, nodes: Record<string, WfNode>): PendingApproval[] {
  return Object.values(nodes).map((n) => approvalOf(w, n)).filter((a): a is PendingApproval => a !== null)
}

const norm = (s: string | undefined) => (s ?? '').replace(/^oidc:/i, '').trim().toLowerCase()

function names(p: Person): Set<string> {
  return new Set([norm(p.name), norm(p.email), norm(p.id)].filter(Boolean))
}

/** Is `who` one of the approvers (by group, username or email)? An empty list means anyone. */
export function isApprover(a: PendingApproval, who: Person): boolean {
  if (!a.approvers.length) return true
  const mine = names(who)
  const groups = new Set((who.groups ?? []).map((g) => norm(g.replace(/^\//, ''))).filter(Boolean))
  return a.approvers.some((raw) => {
    const n = norm(raw.replace(/^(group|user):/i, '').replace(/^\//, ''))
    if (/^group:/i.test(raw)) return groups.has(n)
    if (/^user:/i.test(raw)) return mine.has(n)
    return groups.has(n) || mine.has(n)
  })
}

/**
 * The console's own argo-server identity (design §4.4). A run that still names
 * it as its submitter (the BFF's provenance restore failed after a memoized
 * resubmit) has an UNKNOWN submitter — the BFF refuses such an approval with
 * 409 `submitter_unknown` (`server/workflows/model.ts` decideApproval), so the
 * card must not offer one.
 */
export const CONSOLE_ARGO_USER = 'system:serviceaccount:adhar-system:adhar-console-argo'

/** Did `who` submit the run? Unknown submitter is not "someone else". */
export function isSubmitter(a: PendingApproval, who: Person): boolean | undefined {
  if (!a.submitter || a.submitter.trim().toLowerCase() === CONSOLE_ARGO_USER) return undefined
  return names(who).has(norm(a.submitter))
}

export type Eligibility =
  | { ok: true }
  | { ok: false; reason: 'not-approver' | 'self' | 'submitter-unknown'; detail: string }

/** What the approval card shows: Approve/Reject, or why not. */
export function eligibility(a: PendingApproval, who: Person | null): Eligibility {
  if (!who) return { ok: false, reason: 'not-approver', detail: 'Sign in to answer approvals.' }
  if (!isApprover(a, who)) return { ok: false, reason: 'not-approver', detail: `Only ${a.approvers.join(', ')} may decide this.` }
  if (a.forbidSelfApproval) {
    const self = isSubmitter(a, who)
    if (self === undefined) return { ok: false, reason: 'submitter-unknown', detail: 'This approval forbids self-approval and the run does not record its submitter.' }
    if (self) return { ok: false, reason: 'self', detail: 'You submitted this run, and its approval forbids self-approval.' }
  }
  return { ok: true }
}

/** Approvals across runs that `who` may decide now, oldest first (they have waited longest). */
export function approvalsFor(all: readonly PendingApproval[], who: Person | null): PendingApproval[] {
  return all.filter((a) => eligibility(a, who).ok).sort((x, y) => (x.startedAt ?? '').localeCompare(y.startedAt ?? ''))
}
