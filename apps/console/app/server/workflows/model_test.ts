import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  approvalOf,
  archiveListQuery,
  decideApproval,
  fnv32a,
  inflateNodes,
  isEligibleApprover,
  isTimerNode,
  kubeUsername,
  matchRoute,
  nodesOf,
  parseApprove,
  parseArchiveFilters,
  parseLint,
  parseParameters,
  parseResubmit,
  parseRetry,
  podNameFor,
  setBody,
  stripIdentityKeys,
  submitterOf,
  submitterSlug,
  summarizeArchived,
  type WfNode,
  type WfObject,
} from './model.ts'

/* ─────────── routes ─────────── */

Deno.test('every route parses, and a wrong method is 405 rather than a different route', () => {
  const uid = '0b9b5c5e-2f9f-4c1e-9d1a-3c1f2a1b0c9d'
  const ok: Array<[string, string, string]> = [
    ['GET', '/capabilities', 'capabilities'],
    ['GET', '/runs/team-a/nightly-abc12', 'run.get'],
    ['POST', '/runs/team-a/nightly-abc12/retry', 'run.retry'],
    ['POST', '/runs/team-a/nightly-abc12/resubmit', 'run.resubmit'],
    ['POST', '/runs/team-a/nightly-abc12/approve', 'run.approve'],
    ['GET', '/runs/team-a/nightly-abc12/logs', 'run.logs'],
    ['GET', '/runs/team-a/nightly-abc12/artifacts/nightly-abc12-123/report.json', 'run.artifact'],
    ['GET', '/archive/team-a', 'archive.list'],
    ['GET', `/archive/team-a/${uid}`, 'archive.get'],
    ['DELETE', `/archive/team-a/${uid}`, 'archive.delete'],
    ['POST', `/archive/team-a/${uid}/retry`, 'archive.retry'],
    ['POST', `/archive/team-a/${uid}/resubmit`, 'archive.resubmit'],
    ['POST', '/lint', 'lint'],
    ['GET', '/engine', 'engine.get'],
    ['POST', '/engine/schedules/suspend-all', 'engine.suspend-all'],
  ]
  for (const [m, p, op] of ok) {
    const r = matchRoute(m, p)
    assert('route' in r, `${m} ${p}: ${JSON.stringify(r)}`)
    assertEquals(r.route.op, op)
  }
  const r = matchRoute('GET', '/runs/team-a/x/retry')
  assert('error' in r && r.error === 'method_not_allowed')
})

Deno.test('a malformed namespace, name, uid, node or artifact is refused before anything is asked', () => {
  const cases = [
    '/runs/Team_A/x',
    '/runs/team-a/..',
    '/runs/team-a/x%2Fy',
    '/archive/team-a/not-a-uid',
    '/archive/../etc',
    '/runs/team-a/x/artifacts/node/..',
    '/runs/team-a/x/artifacts/BAD_NODE/a',
  ]
  for (const p of cases) {
    const r = matchRoute('GET', p)
    assert('error' in r && r.error !== 'method_not_allowed', `${p} was accepted: ${JSON.stringify(r)}`)
  }
})

/* ─────────── bodies ─────────── */

Deno.test('retry names a node by id only; a wider node selector is refused', () => {
  const ok = parseRetry({ restartSuccessful: true, nodeId: 'wf-1234' })
  assert(ok.ok)
  assertEquals(ok.value, { restartSuccessful: true, nodeFieldSelector: 'id=wf-1234' })
  const alt = parseRetry({ nodeFieldSelector: 'id=wf-1234' })
  assert(alt.ok && alt.value.nodeFieldSelector === 'id=wf-1234')
  for (const sel of ['templateName=build', 'phase=Failed', 'id=wf-1,id=wf-2', 'id=']) {
    assert(!parseRetry({ nodeFieldSelector: sel }).ok, sel)
  }
  assert(!parseRetry({ nodeId: 'a', nodeFieldSelector: 'id=b' }).ok)
})

Deno.test('parameters are name=value strings with valid names, from a list or an object', () => {
  assertEquals(parseParameters(['a=1', 'b=x=y']), { ok: true, value: ['a=1', 'b=x=y'] })
  assertEquals(parseParameters({ a: '1' }), { ok: true, value: ['a=1'] })
  assert(!parseParameters(['=1']).ok)
  assert(!parseParameters({ 'bad name': '1' }).ok)
  assert(!parseParameters({ a: 1 }).ok)
  assert(!parseParameters(Array.from({ length: 101 }, (_, i) => `p${i}=x`)).ok)
})

Deno.test('a client-chosen service account never survives into an upstream body', () => {
  // The routes BUILD their bodies; these are what a hostile client would send.
  const r = parseResubmit({ memoized: true, serviceAccount: 'adhar-resilience-gate', submitOptions: { serviceAccount: 'admin' } })
  assert(r.ok)
  assertEquals(Object.keys(r.value).sort(), ['memoized'])
  const stripped: Record<string, unknown> = stripIdentityKeys<Record<string, unknown>>({ name: 'x', serviceAccount: 'admin', serviceAccountName: 'admin', submitOptions: { serviceAccount: 'admin', labels: 'a=b' } })
  assertEquals(stripped, { name: 'x', submitOptions: { labels: 'a=b' } })
})

Deno.test('approve needs a node, a decision and at most a bounded comment', () => {
  assert(parseApprove({ nodeId: 'wf-1', decision: 'approve' }).ok)
  assert(!parseApprove({ nodeId: 'wf-1', decision: 'maybe' }).ok)
  assert(!parseApprove({ decision: 'approve' }).ok)
  assert(!parseApprove({ nodeId: 'wf-1', decision: 'reject', comment: 'x'.repeat(2001) }).ok)
})

Deno.test('lint pins the manifest to the request namespace and refuses a different one', () => {
  const ok = parseLint({ namespace: 'team-a', kind: 'WorkflowTemplate', manifest: { metadata: { name: 't' }, spec: {} } })
  assert(ok.ok)
  assertEquals((ok.value.manifest.metadata as Record<string, unknown>).namespace, 'team-a')
  assert(!parseLint({ namespace: 'team-a', kind: 'WorkflowTemplate', manifest: { metadata: { name: 't', namespace: 'team-b' } } }).ok)
  assert(!parseLint({ namespace: 'team-a', kind: 'Pod', manifest: {} }).ok)
  assert(!parseLint({ namespace: 'team-a', kind: 'Workflow', manifest: { kind: 'CronWorkflow' } }).ok)
  const cwt = parseLint({ kind: 'ClusterWorkflowTemplate', manifest: { metadata: { name: 'c', namespace: 'x' } } })
  assert(cwt.ok && cwt.value.namespace === undefined)
  assertEquals((cwt.value.manifest.metadata as Record<string, unknown>).namespace, undefined)
})

/* ─────────── archive query (GHSA-q65w-j2vp-47c4) ─────────── */

Deno.test('a crafted fieldSelector or namespace in the archive query never reaches argo-server', () => {
  const crafted = new URLSearchParams({
    fieldSelector: 'metadata.namespace=team-b',
    'listOptions.fieldSelector': 'metadata.namespace=team-b',
    namespace: 'team-b',
    'listOptions.labelSelector': 'x=y',
    phase: 'Failed',
    limit: '1000',
  })
  const f = parseArchiveFilters(crafted)
  assert(f.ok)
  const q = archiveListQuery('team-a', f.value)
  assertEquals(q.getAll('namespace'), ['team-a'])
  for (const k of q.keys()) assert(!/fieldselector/i.test(k), `forwarded ${k}`)
  assert(![...q.values()].some((v) => v.includes('team-b')))
  assertEquals(q.get('listOptions.labelSelector'), 'workflows.argoproj.io/phase=Failed')
  assertEquals(q.get('listOptions.limit'), '100')
})

Deno.test('archive filters are validated', () => {
  assert(!parseArchiveFilters(new URLSearchParams({ phase: 'Done' })).ok)
  assert(!parseArchiveFilters(new URLSearchParams({ template: 'a,b=c' })).ok)
  assert(!parseArchiveFilters(new URLSearchParams({ submitter: 'x!y' })).ok)
  assert(!parseArchiveFilters(new URLSearchParams({ since: 'yesterday' })).ok)
  const f = parseArchiveFilters(new URLSearchParams({ template: 'nightly', submitter: 'ana', since: '2026-11-01T00:00:00Z', continue: 'abc=' }))
  assert(f.ok)
  const q = archiveListQuery('team-a', f.value)
  assertEquals(q.get('listOptions.labelSelector'), 'workflows.argoproj.io/workflow-template=nightly,adhar.io/submitter=ana')
  assertEquals(q.get('listOptions.continue'), 'abc=')
  assert(!q.has('since'), 'since is applied by the BFF, not sent')
})

Deno.test('an archived item is summarised with its provenance', () => {
  const s = summarizeArchived({
    metadata: { uid: 'u', name: 'n', namespace: 'team-a', labels: { 'workflows.argoproj.io/workflow-template': 't', 'workflows.argoproj.io/phase': 'Failed' }, annotations: { 'adhar.io/submitted-by': 'oidc:ana' } },
    status: { startedAt: '2026-11-01T00:00:00Z' },
  })
  assertEquals(s, { uid: 'u', name: 'n', namespace: 'team-a', phase: 'Failed', startedAt: '2026-11-01T00:00:00Z', template: 't', submittedBy: 'oidc:ana' })
  assertEquals(summarizeArchived({ metadata: { name: 'n' } }), null)
})

/* ─────────── nodes ─────────── */

async function gzipB64(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return btoa(String.fromCharCode(...bytes))
}

Deno.test('compressedNodes (base64 gzip, F-8) inflate to the node map; anything else is null', async () => {
  const nodes = { 'wf-1': { id: 'wf-1', name: 'wf', type: 'DAG', phase: 'Running' } }
  const z = await gzipB64(JSON.stringify(nodes))
  assertEquals(await inflateNodes(z), nodes)
  assertEquals(await nodesOf({ status: { compressedNodes: z } }), nodes)
  assertEquals(await inflateNodes(btoa('not gzip')), null)
  assertEquals(await nodesOf({ status: { offloadNodeStatusVersion: 'abc' } }), null)
  assertEquals(await nodesOf({}), {})
})

Deno.test('fnv32a matches Go hash/fnv New32a', () => {
  assertEquals(fnv32a(''), 0x811c9dc5)
  assertEquals(fnv32a('a'), 0xe40c292c)
  assertEquals(fnv32a('foobar'), 0xbf9cf968)
})

Deno.test('a node\'s pod name follows Argo v4 GeneratePodName', () => {
  const wf = 'nightly-abc12'
  const node: WfNode = { id: `${wf}-${fnv32a(`${wf}.build`)}`, name: `${wf}.build`, templateName: 'compile', type: 'Pod' }
  const pod = podNameFor(wf, node)
  assertEquals(pod, `${wf}-compile-${fnv32a(`${wf}.build`)}`)
  // The pod's hash and the node id's hash are the same hash of the node name.
  assertEquals(pod?.split('-').at(-1), node.id?.split('-').at(-1))
  assertEquals(podNameFor(wf, node, 'v1'), node.id)
  assertEquals(podNameFor(wf, { ...node, templateName: undefined, templateRef: { name: 'adhar-steps', template: 'http' } }), `${wf}-http-${fnv32a(`${wf}.build`)}`)
  assertEquals(podNameFor(wf, { ...node, name: `${wf}.inline` }), `${wf}-${fnv32a(`${wf}.inline`)}`)
  assertEquals(podNameFor(wf, { id: wf, name: wf }), wf)
})

/* ─────────── approvals ─────────── */

const waiting = (extra: Partial<WfNode> = {}, inputs: Record<string, string> = {}): WfNode => ({
  id: 'wf-777',
  type: 'Suspend',
  phase: 'Running',
  inputs: { parameters: Object.entries(inputs).map(([name, value]) => ({ name, value })) },
  outputs: { parameters: [{ name: 'decision', valueFrom: { supplied: {} } }, { name: 'comment', valueFrom: { supplied: {} } }, { name: 'approver', valueFrom: { supplied: {} } }] },
  ...extra,
})

Deno.test('only a running suspend node is an approval', () => {
  assert(approvalOf(waiting()))
  assertEquals(approvalOf(waiting({ phase: 'Succeeded' })), null)
  assertEquals(approvalOf(waiting({ type: 'Pod' })), null)
  const a = approvalOf(waiting({}, { approvers: 'release-managers, user:bob', forbidSelfApproval: 'true', question: 'Ship?' }))
  assertEquals(a?.approvers, ['release-managers', 'user:bob'])
  assertEquals(a?.forbidSelfApproval, true)
  assertEquals(a?.outputs, ['decision', 'comment', 'approver'])
})

Deno.test('approver policy: groups, users, empty = anyone with update', () => {
  const ask = approvalOf(waiting({}, { approvers: 'release-managers,user:bob,carol@x.io' }))!
  assert(isEligibleApprover(ask, { id: '1', username: 'ana', groups: ['release-managers'] }))
  assert(isEligibleApprover(ask, { id: '2', username: 'bob', groups: [] }))
  assert(isEligibleApprover(ask, { id: '3', username: 'c', email: 'Carol@x.io' }))
  assert(!isEligibleApprover(ask, { id: '4', username: 'dave', groups: ['developers'] }))
  // `user:` never matches a group of the same name.
  assert(!isEligibleApprover(ask, { id: '5', username: 'eve', groups: ['bob'] }))
  assert(isEligibleApprover(approvalOf(waiting())!, { id: '6' }))
})

Deno.test('separation of duties: the submitter may not approve when the node forbids it, and an unknown submitter is refused', () => {
  const ask = approvalOf(waiting({}, { forbidSelfApproval: 'true' }))!
  const ana = { id: 'u-ana', username: 'ana', groups: [] }
  const self = decideApproval(ask, ana, 'oidc:ana')
  assert(!self.ok && self.error === 'self_approval_forbidden' && self.status === 403)
  assert(decideApproval(ask, ana, 'oidc:bob').ok)
  const unknown = decideApproval(ask, ana, undefined)
  assert(!unknown.ok && unknown.error === 'submitter_unknown')
  // Allowed when the node does not forbid it.
  assert(decideApproval(approvalOf(waiting())!, ana, 'oidc:ana').ok)
  assertEquals(submitterOf({ metadata: { labels: { 'workflows.argoproj.io/creator-preferred-username': 'ana' } } }), 'ana')
})

Deno.test('the set body carries a server-derived approver and only declared outputs', () => {
  const ask = approvalOf(waiting())!
  const { body, resume } = setBody('team-a', 'wf', ask, { nodeId: 'wf-777', decision: 'reject', comment: 'not today' }, 'ana')
  assert(resume)
  assertEquals(body.nodeFieldSelector, 'id=wf-777')
  assertEquals(JSON.parse(body.outputParameters as string), { decision: 'reject', comment: 'not today', approver: 'ana' })
  assertEquals(body.message, 'Rejected by ana via Adhar console: not today')
  // A hand-written `suspend: {}` has no outputs: approve resumes it, reject fails the node.
  const plain = approvalOf({ id: 'wf-9', type: 'Suspend', phase: 'Running' })!
  const a = setBody('team-a', 'wf', plain, { nodeId: 'wf-9', decision: 'approve', comment: '' }, 'ana')
  assert(a.resume && a.body.outputParameters === undefined && a.body.phase === undefined)
  const r = setBody('team-a', 'wf', plain, { nodeId: 'wf-9', decision: 'reject', comment: '' }, 'ana')
  assert(!r.resume)
  assertEquals(r.body.phase, 'Failed')
})

Deno.test('separation of duties holds under a configured user prefix and never treats the console SA as a person', () => {
  const ask = approvalOf(waiting({}, { forbidSelfApproval: 'true' }))!
  const ana = { id: 'u-ana', username: 'ana', email: 'ana@x.io', groups: [] }
  const self = decideApproval(ask, ana, 'keycloak:ana', 'keycloak:')
  assert(!self.ok && self.error === 'self_approval_forbidden')
  const viaEmail = decideApproval(ask, ana, 'keycloak:ANA@x.io', 'keycloak:')
  assert(!viaEmail.ok && viaEmail.error === 'self_approval_forbidden')
  assert(decideApproval(ask, ana, 'keycloak:bob', 'keycloak:').ok)
  const sa = decideApproval(ask, ana, 'system:serviceaccount:adhar-system:adhar-console-argo')
  assert(!sa.ok && sa.error === 'submitter_unknown')
})

Deno.test('the restored submitter is the gateway\'s user name, and its label is Kyverno\'s slug', () => {
  const who = { id: 'u-ana', username: 'ana', email: 'Ana@x.io' }
  assertEquals(kubeUsername(who), 'oidc:ana')
  assertEquals(kubeUsername(who, 'oidc:', 'sub'), 'oidc:u-ana')
  assertEquals(kubeUsername(who, 'oidc:', 'email'), 'oidc:Ana@x.io')
  // trim(truncate(trim(regex_replace_all('[^a-z0-9._-]+', to_lower(u), '-'), '-._'), 63), '-._')
  assertEquals(submitterSlug('oidc:ana'), 'oidc-ana')
  assertEquals(submitterSlug('oidc:Ana@x.io'), 'oidc-ana-x.io')
  assertEquals(submitterSlug('system:serviceaccount:adhar-system:adhar-console-argo'), 'system-serviceaccount-adhar-system-adhar-console-argo')
  assertEquals(submitterSlug('._oidc:a__b..'), 'oidc-a__b')
  const long = submitterSlug(`oidc:${'a'.repeat(61)}.b`)
  assertEquals(long, `oidc-${'a'.repeat(58)}`)
  assert(long.length <= 63)
})

Deno.test('a compressedNodes gzip bomb is refused, not inflated without bound', async () => {
  // Anyone who may update a Workflow may write its compressedNodes (no status
  // subresource). A small gzip that inflates past the cap is unreadable (null:
  // the hydrated fallback), never held in memory whole.
  const big = JSON.stringify({ 'wf-1': { id: 'wf-1', message: 'x'.repeat(200_000) } })
  const z = await gzipB64(big)
  assert(z.length < 4_000, `fixture compresses well (${z.length})`)
  assertEquals(await inflateNodes(z, 100_000), null)
  assertEquals(Object.keys((await inflateNodes(z, 1_000_000)) ?? {}), ['wf-1'])
})

/* ─────────── timers (parity with the UI's isTimerNode and the CLI's IsTimer) ─────────── */

Deno.test('a timer — a suspend with a duration that asks nothing — is not an approval; a plain or asking suspend is', () => {
  const run: WfObject = {
    metadata: { name: 'r', namespace: 'shop' },
    spec: { templates: [{ name: 'sleep', suspend: { duration: '10m' } }, { name: 'gate', suspend: {} }] },
    status: {
      storedTemplates: { 'namespaced/steps/pause': { name: 'pause', suspend: { duration: '30s' } } },
    } as WfObject['status'],
  }
  const timer: WfNode = { id: 't', type: 'Suspend', phase: 'Running', templateName: 'sleep' }
  const ref: WfNode = { id: 'p', type: 'Suspend', phase: 'Running', templateRef: { name: 'steps', template: 'pause' } }
  const gate: WfNode = { id: 'g', type: 'Suspend', phase: 'Running', templateName: 'gate' }
  const asks: WfNode = { ...timer, id: 'a', inputs: { parameters: [{ name: 'question', value: 'ship?' }] } }
  const supplies: WfNode = { ...timer, id: 's', outputs: { parameters: [{ name: 'decision', valueFrom: { supplied: {} } }] } }
  assert(isTimerNode(run, timer) && isTimerNode(run, ref))
  assert(!isTimerNode(run, gate) && !isTimerNode(run, asks) && !isTimerNode(run, supplies))
  assertEquals(approvalOf(timer, run), null)
  assertEquals(approvalOf(ref, run), null)
  assert(approvalOf(gate, run) && approvalOf(asks, run) && approvalOf(supplies, run))
  // A template-ref run keeps its templates in storedWorkflowTemplateSpec.
  const fromTemplate: WfObject = { metadata: {}, status: { storedWorkflowTemplateSpec: { templates: [{ name: 'sleep', suspend: { duration: 60 } }] } } as WfObject['status'] }
  assert(isTimerNode(fromTemplate, timer))
})

Deno.test('a Keycloak full-path group is the same group, as the UI reads it', () => {
  const ask = approvalOf(waiting({}, { approvers: 'group:/release-managers' }))!
  assert(isEligibleApprover(ask, { id: '1', username: 'ana', groups: ['/release-managers'] }))
  assert(isEligibleApprover(ask, { id: '2', username: 'ana', groups: ['release-managers'] }))
  assert(!isEligibleApprover(ask, { id: '3', username: 'ana', groups: ['/ops'] }))
})
