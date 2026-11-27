import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { approvalsFor, eligibility, pendingApprovals } from './approvals.ts'
import { runGraph, type WfNode, type Workflow } from './nodes.ts'

/**
 * Approvals the UI offers (design 0026 §6.4): a waiting suspend node, its
 * approvers (groups or users; empty = anyone with update), and separation of
 * duties when `forbidSelfApproval`. The BFF re-decides; these only decide what
 * to SHOW.
 */

const RUN: Workflow = {
  metadata: { name: 'release-1', namespace: 'shop-dev', annotations: { 'adhar.io/submitted-by': 'oidc:alice' } },
}

const suspend = (id: string, params: Record<string, string>, phase = 'Running'): WfNode => ({
  id,
  name: `release-1.${id}`,
  displayName: id,
  type: 'Suspend',
  phase,
  inputs: { parameters: Object.entries(params).map(([name, value]) => ({ name, value })) },
  outputs: { parameters: [{ name: 'decision', valueFrom: { supplied: {} } }, { name: 'comment', valueFrom: { supplied: {} } }] },
})

const NODES: Record<string, WfNode> = {
  gate: suspend('gate', { question: 'Ship to test?', approvers: 'release-managers,user:bob', forbidSelfApproval: 'true' }),
  open: suspend('open', {}),
  done: suspend('done', { approvers: 'anyone' }, 'Succeeded'),
  pod: { id: 'pod', name: 'release-1.pod', type: 'Pod', phase: 'Running' },
}

Deno.test('only waiting suspend nodes are approvals, with what they ask', () => {
  const all = pendingApprovals(RUN, NODES)
  assertEquals(all.map((a) => a.nodeId), ['gate', 'open'])
  const gate = all[0]
  assertEquals(gate.question, 'Ship to test?')
  assertEquals(gate.approvers, ['release-managers', 'user:bob'])
  assertEquals(gate.forbidSelfApproval, true)
  assertEquals(gate.outputs, ['decision', 'comment'])
  assertEquals(gate.submitter, 'oidc:alice')
})

Deno.test('approvers by group or by user; an empty list is anyone with update', () => {
  const [gate, open] = pendingApprovals(RUN, NODES)
  assertEquals(eligibility(gate, { name: 'carol', groups: ['/release-managers'] }).ok, true)
  assertEquals(eligibility(gate, { name: 'bob', groups: [] }).ok, true)
  assertEquals(eligibility(gate, { name: 'dave', groups: ['developers'] }), { ok: false, reason: 'not-approver', detail: 'Only release-managers, user:bob may decide this.' })
  assertEquals(eligibility(open, { name: 'dave' }).ok, true)
  assertEquals(eligibility(open, null).ok, false)
})

Deno.test('the submitter cannot approve when self-approval is forbidden; an unknown submitter is not "someone else"', () => {
  const [gate] = pendingApprovals(RUN, NODES)
  assertEquals(eligibility(gate, { name: 'alice', groups: ['release-managers'] }).ok, false)
  assertEquals((eligibility(gate, { name: 'alice', groups: ['release-managers'] }) as { reason: string }).reason, 'self')
  const [anon] = pendingApprovals({ metadata: { name: 'r', namespace: 'n' } }, { gate: NODES.gate })
  assertEquals((eligibility(anon, { name: 'carol', groups: ['release-managers'] }) as { reason: string }).reason, 'submitter-unknown')
})

Deno.test('"approvals waiting for me" keeps only the ones I may decide, oldest first', () => {
  const all = pendingApprovals(RUN, { ...NODES, gate: { ...NODES.gate, startedAt: '2026-11-25T02:00:00Z' }, open: { ...NODES.open, startedAt: '2026-11-25T01:00:00Z' } })
  assertEquals(approvalsFor(all, { name: 'dave', groups: [] }).map((a) => a.nodeId), ['open'])
  assertEquals(approvalsFor(all, { name: 'carol', groups: ['release-managers'] }).map((a) => a.nodeId), ['open', 'gate'])
})

Deno.test('a run that names the console\'s argo-server identity as submitter has an UNKNOWN submitter (the BFF answers 409)', () => {
  const run: Workflow = { metadata: { name: 'r', namespace: 'n', annotations: { 'adhar.io/submitted-by': 'system:serviceaccount:adhar-system:adhar-console-argo' } } }
  const [gate] = pendingApprovals(run, { gate: NODES.gate })
  assertEquals((eligibility(gate, { name: 'carol', groups: ['release-managers'] }) as { reason: string }).reason, 'submitter-unknown')
  // Without forbidSelfApproval the submitter does not matter.
  const [open] = pendingApprovals(run, { open: NODES.open })
  assertEquals(eligibility(open, { name: 'carol' }).ok, true)
})

Deno.test('a waiting timer (suspend with a duration, nothing asked) is not an approval; an approval with a timeout still is', () => {
  const run: Workflow = {
    metadata: { name: 'r', namespace: 'n' },
    spec: { entrypoint: 'main', templates: [{ name: 'wait-5m', suspend: { duration: '5m' } }, { name: 'gate', suspend: { duration: '24h' } }, { name: 'hand', suspend: {} }] },
  }
  const timer: WfNode = { id: 't', name: 'r.wait', displayName: 'wait', type: 'Suspend', phase: 'Running', templateName: 'wait-5m' }
  const gated: WfNode = { ...suspend('g', { question: 'Ship?' }), templateName: 'gate' }
  const hand: WfNode = { id: 'h', name: 'r.hand', displayName: 'hand', type: 'Suspend', phase: 'Running', templateName: 'hand' }
  assertEquals(pendingApprovals(run, { t: timer, g: gated, h: hand }).map((a) => a.nodeId), ['g', 'h'])
  const g = runGraph({ ...run, spec: { ...run.spec, templates: [...run.spec!.templates!, { name: 'main', dag: { tasks: [{ name: 'wait', template: 'wait-5m' }] } }] } }, { r: { id: 'r', name: 'r', type: 'DAG', phase: 'Running', children: ['t'] }, t: { ...timer, boundaryID: 'r' } })
  assertEquals(g.nodes.find((x) => x.id === 'wait')?.awaitingApproval, false)
})
