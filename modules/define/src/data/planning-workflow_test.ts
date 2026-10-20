import { assertEquals } from 'jsr:@std/assert@1'
import {
  allowedTargets,
  type AutomationRule,
  checkTransition,
  evaluateAutomation,
  issueKeysIn,
  type ItemView,
  pruneRules,
  type WorkflowRules,
} from './planning-workflow.ts'
import type { StateGroup } from './planning-model.ts'

const rules: WorkflowRules = {
  enforce: true,
  transitions: { todo: ['doing'], doing: ['review', 'todo'], done: [] },
  requireAssignee: ['doing'],
}

Deno.test('transitions: listed targets only, terminal states, unrestricted states, assignee rule', () => {
  assertEquals(checkTransition(rules, 'todo', 'done').ok, false)
  assertEquals(checkTransition(rules, 'todo', 'doing', { assignees: ['u'] }).ok, true)
  const blocked = checkTransition(rules, 'todo', 'doing', { assignees: [] })
  assertEquals(blocked.ok ? '' : blocked.reason, 'Assign someone before moving to doing.')
  const terminal = checkTransition(rules, 'done', 'todo')
  assertEquals(terminal.ok ? '' : terminal.reason, 'done is a final state in this project\'s workflow.')
  assertEquals(checkTransition(rules, 'review', 'done').ok, true)
  assertEquals(checkTransition({ ...rules, enforce: false }, 'todo', 'done').ok, true)
  assertEquals(allowedTargets(rules, 'doing', ['todo', 'doing', 'review', 'done']), ['review', 'todo'])
  assertEquals(pruneRules(rules, ['todo', 'doing']).transitions, { todo: ['doing'], doing: ['todo'] })
})

const groups: Record<string, StateGroup> = { todo: 'unstarted', doing: 'started', done: 'completed', review: 'started' }
const view = (o: Partial<ItemView> = {}): ItemView => ({ id: 'i', state: 'todo', priority: 'none', labels: [], assignees: [], target_date: null, ...o })

Deno.test('automation: moving into Done fires; later rules win; no-op patches are dropped', () => {
  const r: AutomationRule[] = [
    { id: 'r1', name: 'Done clears assignees', enabled: true, trigger: { kind: 'entered-group', group: 'completed' }, actions: [{ kind: 'unassign-all' }, { kind: 'add-label', label: 'shipped' }] },
    { id: 'r2', name: 'disabled', enabled: false, trigger: { kind: 'entered-group', group: 'completed' }, actions: [{ kind: 'set-priority', priority: 'urgent' }] },
    { id: 'r3', name: 'urgent only', enabled: true, trigger: { kind: 'entered-group', group: 'completed' }, when: { priority: ['urgent'] }, actions: [{ kind: 'set-priority', priority: 'low' }] },
  ]
  const res = evaluateAutomation(r, { kind: 'updated', before: view({ assignees: ['u'] }), after: view({ state: 'done', assignees: ['u'] }), groupOf: (s) => groups[s] })
  assertEquals(res.fired.map((f) => f.id), ['r1'])
  assertEquals(res.patch, { labels: ['shipped'], assignees: [] })
  // Re-evaluating on the result does not fire again (already in Done).
  const again = evaluateAutomation(r, { kind: 'updated', before: view({ state: 'done' }), after: view({ state: 'done', labels: ['shipped'] }), groupOf: (s) => groups[s] })
  assertEquals(again.fired, [])
})

Deno.test('automation: PR merged moves the item; assignment and creation triggers', () => {
  const r: AutomationRule[] = [
    { id: 'pr', name: 'PR merged → Review', enabled: true, trigger: { kind: 'pr-merged' }, actions: [{ kind: 'set-state', state: 'review' }] },
    { id: 'as', name: 'Assigned → Doing', enabled: true, trigger: { kind: 'assigned' }, actions: [{ kind: 'set-state', state: 'doing' }] },
    { id: 'cr', name: 'Created → due today', enabled: true, trigger: { kind: 'created' }, actions: [{ kind: 'set-target-today' }] },
  ]
  assertEquals(evaluateAutomation(r, { kind: 'pr-merged', after: view(), groupOf: (s) => groups[s] }).patch, { state: 'review' })
  assertEquals(evaluateAutomation(r, { kind: 'updated', before: view(), after: view({ assignees: ['u'] }), groupOf: (s) => groups[s] }).patch, { state: 'doing' })
  assertEquals(evaluateAutomation(r, { kind: 'created', after: view(), groupOf: (s) => groups[s], today: '2026-10-21' }).patch, { target_date: '2026-10-21' })
})

Deno.test('issue keys in PR text match project identifiers case-insensitively', () => {
  assertEquals(issueKeysIn('feat/con-42-cards: fixes CON-42, see WEB-7 and XCON-9', ['CON', 'WEB']), [
    { identifier: 'CON', sequence: 42 },
    { identifier: 'WEB', sequence: 7 },
  ])
  assertEquals(issueKeysIn('nothing here', ['CON']), [])
})
