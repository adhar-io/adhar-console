/**
 * Console-side workflow rules and automation for Define.
 *
 * Plane's public API stores states (with groups, colours and a default) but
 * not transition rules or automations, so both live in the console's store
 * and are ENFORCED BY THE CONSOLE ONLY: a move made in Plane's own UI, or
 * through its API by another tool, is not checked. The UI says so wherever
 * these rules show.
 *
 * Pure functions — the hooks in `planning-store.ts` read the rules and call
 * these when an action happens in the console.
 */

import type { StateGroup } from './planning-model.ts'

/* ───── transitions ───── */

export interface WorkflowRules {
  /** When false the rules are documented but not enforced. */
  enforce: boolean
  /**
   * Allowed targets per source state id. A state that is absent from the map
   * is unrestricted; an empty array means "no moves out" (a terminal state).
   */
  transitions: Record<string, string[]>
  /** State ids that need at least one assignee before an item may enter. */
  requireAssignee?: string[]
}

export const EMPTY_RULES: WorkflowRules = { enforce: false, transitions: {} }

export type TransitionCheck = { ok: true } | { ok: false; reason: string }

export function checkTransition(
  rules: WorkflowRules | null | undefined,
  from: string,
  to: string,
  item?: { assignees?: string[] },
  stateName: (id: string) => string = (id) => id,
): TransitionCheck {
  if (!rules?.enforce || from === to) return { ok: true }
  const allowed = rules.transitions[from]
  if (allowed && !allowed.includes(to)) {
    return {
      ok: false,
      reason: allowed.length
        ? `${stateName(from)} can only move to ${allowed.map(stateName).join(', ')}.`
        : `${stateName(from)} is a final state in this project's workflow.`,
    }
  }
  if (rules.requireAssignee?.includes(to) && item && !(item.assignees ?? []).length) {
    return { ok: false, reason: `Assign someone before moving to ${stateName(to)}.` }
  }
  return { ok: true }
}

/** States an item in `from` may move to (all others when unrestricted). */
export function allowedTargets(rules: WorkflowRules | null | undefined, from: string, all: string[]): string[] {
  if (!rules?.enforce) return all.filter((s) => s !== from)
  const allowed = rules.transitions[from]
  return (allowed ?? all).filter((s) => s !== from)
}

/** Drop rules pointing at states that no longer exist. */
export function pruneRules(rules: WorkflowRules, stateIds: string[]): WorkflowRules {
  const ok = new Set(stateIds)
  const transitions: Record<string, string[]> = {}
  for (const [from, tos] of Object.entries(rules.transitions)) {
    if (ok.has(from)) transitions[from] = tos.filter((t) => ok.has(t))
  }
  return { ...rules, transitions, requireAssignee: rules.requireAssignee?.filter((s) => ok.has(s)) }
}

/* ───── automation ───── */

export type Trigger =
  | { kind: 'entered-group'; group: StateGroup }
  | { kind: 'entered-state'; state: string }
  | { kind: 'created' }
  | { kind: 'assigned' }
  | { kind: 'pr-merged' }
  | { kind: 'pr-opened' }

export type Action =
  | { kind: 'set-state'; state: string }
  | { kind: 'set-priority'; priority: 'urgent' | 'high' | 'medium' | 'low' | 'none' }
  | { kind: 'add-label'; label: string }
  | { kind: 'remove-label'; label: string }
  | { kind: 'assign'; member: string }
  | { kind: 'unassign-all' }
  | { kind: 'set-target-today' }

export interface AutomationRule {
  id: string
  name: string
  enabled: boolean
  trigger: Trigger
  /** Optional filters the item must match. */
  when?: { priority?: string[]; label?: string }
  actions: Action[]
}

/** What the console knows of an item around an action. */
export interface ItemView {
  id: string
  state: string
  priority: string
  labels: string[]
  assignees: string[]
  target_date?: string | null
}

export interface AutomationEvent {
  kind: 'created' | 'updated' | 'pr-merged' | 'pr-opened'
  before?: ItemView
  after: ItemView
  /** Group of a state id (from the project's states). */
  groupOf(state: string): StateGroup | undefined
  /** Today's `YYYY-MM-DD`, injectable for tests. */
  today?: string
}

export interface AutomationResult {
  /** Rules that fired, in order. */
  fired: Array<{ id: string; name: string }>
  /** The merged change to apply (empty when nothing changes). */
  patch: Partial<Pick<ItemView, 'state' | 'priority' | 'labels' | 'assignees' | 'target_date'>>
}

function triggered(t: Trigger, e: AutomationEvent): boolean {
  const { before, after } = e
  switch (t.kind) {
    case 'created':
      return e.kind === 'created'
    case 'pr-merged':
      return e.kind === 'pr-merged'
    case 'pr-opened':
      return e.kind === 'pr-opened'
    case 'assigned':
      return e.kind === 'updated' && !!before && after.assignees.some((a) => !before.assignees.includes(a))
    case 'entered-state':
      return (e.kind === 'updated' || e.kind === 'created') && after.state === t.state && before?.state !== t.state
    case 'entered-group': {
      if (e.kind !== 'updated' && e.kind !== 'created') return false
      const was = before ? e.groupOf(before.state) : undefined
      return e.groupOf(after.state) === t.group && was !== t.group
    }
  }
}

function matches(r: AutomationRule, item: ItemView): boolean {
  if (r.when?.priority?.length && !r.when.priority.includes(item.priority)) return false
  if (r.when?.label && !item.labels.includes(r.when.label)) return false
  return true
}

/**
 * Rules that fire for an event and the single patch they produce. Later
 * rules win on the same field; a patch that would change nothing is dropped,
 * so applying the result and re-evaluating converges instead of looping.
 */
export function evaluateAutomation(rules: AutomationRule[] | null | undefined, e: AutomationEvent): AutomationResult {
  const fired: AutomationResult['fired'] = []
  const next: ItemView = { ...e.after, labels: [...e.after.labels], assignees: [...e.after.assignees] }
  for (const r of rules ?? []) {
    if (!r.enabled || !triggered(r.trigger, e) || !matches(r, e.after)) continue
    fired.push({ id: r.id, name: r.name })
    for (const a of r.actions) {
      switch (a.kind) {
        case 'set-state':
          next.state = a.state
          break
        case 'set-priority':
          next.priority = a.priority
          break
        case 'add-label':
          if (!next.labels.includes(a.label)) next.labels.push(a.label)
          break
        case 'remove-label':
          next.labels = next.labels.filter((l) => l !== a.label)
          break
        case 'assign':
          if (!next.assignees.includes(a.member)) next.assignees.push(a.member)
          break
        case 'unassign-all':
          next.assignees = []
          break
        case 'set-target-today':
          next.target_date = e.today ?? new Date().toISOString().slice(0, 10)
          break
      }
    }
  }
  const patch: AutomationResult['patch'] = {}
  const a = e.after
  if (next.state !== a.state) patch.state = next.state
  if (next.priority !== a.priority) patch.priority = next.priority
  if (!sameSet(next.labels, a.labels)) patch.labels = next.labels
  if (!sameSet(next.assignees, a.assignees)) patch.assignees = next.assignees
  if ((next.target_date ?? null) !== (a.target_date ?? null)) patch.target_date = next.target_date
  return { fired, patch }
}

const sameSet = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v))

export function describeTrigger(t: Trigger, stateName: (id: string) => string): string {
  switch (t.kind) {
    case 'entered-group':
      return `an item moves into ${t.group === 'completed' ? 'Done' : t.group}`
    case 'entered-state':
      return `an item moves to ${stateName(t.state)}`
    case 'created':
      return 'an item is created from the console'
    case 'assigned':
      return 'someone is assigned'
    case 'pr-merged':
      return 'a linked Gitea pull request is merged'
    case 'pr-opened':
      return 'a linked Gitea pull request is opened'
  }
}

export function describeAction(a: Action, names: { state(id: string): string; label(id: string): string; member(id: string): string }): string {
  switch (a.kind) {
    case 'set-state':
      return `move to ${names.state(a.state)}`
    case 'set-priority':
      return `set priority ${a.priority}`
    case 'add-label':
      return `add label ${names.label(a.label)}`
    case 'remove-label':
      return `remove label ${names.label(a.label)}`
    case 'assign':
      return `assign ${names.member(a.member)}`
    case 'unassign-all':
      return 'clear assignees'
    case 'set-target-today':
      return 'set the due date to today'
  }
}

/* ───── Gitea PR ↔ work item keys ───── */

/**
 * Work item keys (`CON-42`) mentioned in a PR's title, branch or body, for the
 * given project identifiers. Case-insensitive; `con-42` in a branch name counts.
 */
export function issueKeysIn(text: string, identifiers: string[]): Array<{ identifier: string; sequence: number }> {
  if (!text || !identifiers.length) return []
  const alt = identifiers.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`(?:^|[^A-Za-z0-9])(${alt})-(\\d+)(?![0-9])`, 'gi')
  const out = new Map<string, { identifier: string; sequence: number }>()
  for (const m of text.matchAll(re)) {
    const identifier = identifiers.find((i) => i.toLowerCase() === m[1].toLowerCase()) ?? m[1]
    const sequence = Number(m[2])
    out.set(`${identifier}-${sequence}`, { identifier, sequence })
  }
  return [...out.values()]
}
