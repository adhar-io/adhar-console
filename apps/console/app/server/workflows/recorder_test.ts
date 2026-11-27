import { assert, assertEquals, assertNotEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { type KubeObject, requestHeaders } from '../k8s/sa-watch.ts'
import type { NotificationDoc } from '../notify.ts'
import { APPROVALS_WATCH, eventId, failureNotification, failureRecipient, LIFECYCLE_WATCH, type RecorderDeps, runMetaOf, tenantsThenWatches, triggerOf, WorkflowRecorder } from './recorder.ts'

/* ─────────── a recorder with recording sinks ─────────── */

function recorder() {
  const sent: Array<{ tenant: string; doc: NotificationDoc }> = []
  const deps: RecorderDeps = {
    emit: (tenant, doc) => {
      sent.push({ tenant, doc })
      return Promise.resolve()
    },
    tenantOf: (ns) => (ns.startsWith('shop') ? 'acme' : 'default'),
    usersByName: (names) => Promise.resolve(names.flatMap((n) => (n.replace(/^oidc:/, '') === 'ana' ? ['u-ana'] : n === 'bob' ? ['u-bob'] : []))),
    groupMembers: (groups) => Promise.resolve(groups.includes('release-managers') ? ['u-rm1', 'u-rm2'] : []),
    now: () => Date.parse('2026-11-25T10:00:00Z'),
    log: () => {},
  }
  return { r: new WorkflowRecorder(deps), sent }
}

const meta = (phase: string, labels: Record<string, string> = {}, annotations: Record<string, string> = { 'adhar.io/submitted-by': 'oidc:ana' }): KubeObject => ({
  kind: 'PartialObjectMetadata',
  metadata: { uid: 'u-1', name: 'nightly-x', namespace: 'shop-dev', labels: { 'workflows.argoproj.io/phase': phase, ...labels }, annotations },
})

/* ─────────── watches ─────────── */

Deno.test('the lifecycle watch is metadata only and cluster-wide; the approvals watch is narrowed by label', () => {
  // The LIST asks for the List kind first; the WATCH asks for the singular
  // kind and never names the List kind. The API server takes the first
  // transform it is offered without telling a list from a watch: a watch
  // negotiated as PartialObjectMetadataList answers 200 with no frames, a list
  // negotiated as PartialObjectMetadata is a 406 (kube-apiserver 1.36.2).
  const list = requestHeaders(LIFECYCLE_WATCH, 'list')?.accept ?? ''
  const watch = requestHeaders(LIFECYCLE_WATCH, 'watch')?.accept ?? ''
  assert(list.startsWith('application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1'), list)
  assert(watch.startsWith('application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1'), watch)
  assert(!watch.includes('PartialObjectMetadataList'), `a watch must not offer the List kind: ${watch}`)
  assertEquals(requestHeaders(APPROVALS_WATCH, 'watch'), undefined)
  // A source with one set of headers sends it on both requests.
  const one = { id: 'x', group: '', version: 'v1', resource: 'pods', headers: { 'x-a': '1' } }
  assertEquals([requestHeaders(one, 'list'), requestHeaders(one, 'watch')], [{ 'x-a': '1' }, { 'x-a': '1' }])
  assertEquals(LIFECYCLE_WATCH.search, undefined)
  assertEquals(LIFECYCLE_WATCH.resource, 'workflows')
  assertEquals(APPROVALS_WATCH.search?.labelSelector, 'adhar.io/has-approvals=true,workflows.argoproj.io/completed=false')
  assertEquals(APPROVALS_WATCH.headers, undefined, 'approvals need the nodes, so the full object')
})

/* ─────────── ids ─────────── */

Deno.test('event ids are deterministic: sha256(uid:phase), 32 hex', async () => {
  const a = await eventId('u-1', 'Failed')
  assertEquals(a, await eventId('u-1', 'Failed'))
  assertEquals(a.length, 32)
  assert(/^[0-9a-f]{32}$/.test(a))
  assertNotEquals(a, await eventId('u-1', 'Error'))
  // sha256("u-1:Failed"), computed independently.
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('u-1:Failed'))
  assertEquals(a, [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32))
})

/* ─────────── lifecycle ─────────── */

Deno.test('transitions only: priming is a baseline, a repeat is silent, a failure notifies its submitter once', async () => {
  const { r, sent } = recorder()
  await r.onRun(meta('Failed'), true) // already failed at boot: baseline, no news
  assertEquals(sent.length, 0)
  await r.onRun(meta('Failed'), false) // same phase again
  assertEquals(sent.length, 0)

  const fresh = recorder()
  await fresh.r.onRun(meta('Running'), false)
  await fresh.r.onRun(meta('Running'), false)
  await fresh.r.onRun(meta('Failed'), false)
  await fresh.r.onRun(meta('Failed'), false)
  assertEquals(fresh.sent.length, 1)
  const { tenant, doc } = fresh.sent[0]
  assertEquals(tenant, 'acme')
  assertEquals(doc.kind, 'error')
  assertEquals(doc.audience, ['u-ana'])
  assertEquals(doc.key, `workflow:${await eventId('u-1', 'Failed')}`)
  assertEquals(doc.href, '/platform?section=workflow-runs&run=shop-dev%2Fnightly-x')
})

Deno.test('success and running are not notified in W1; Error is', async () => {
  const { r, sent } = recorder()
  await r.onRun(meta('Pending'), false)
  await r.onRun(meta('Running'), false)
  await r.onRun(meta('Succeeded'), false)
  assertEquals(sent.length, 0)
  const e = recorder()
  await e.r.onRun(meta('Error'), false)
  assertEquals(e.sent.length, 1)
  assertStringIncludes(e.sent[0].doc.title, 'errored')
})

Deno.test('a scheduled run that fails goes to the organisation, not one person', async () => {
  const { r, sent } = recorder()
  await r.onRun(meta('Failed', { 'workflows.argoproj.io/cron-workflow': 'nightly' }), false)
  assertEquals(sent[0].doc.audience, undefined)
  assertEquals(sent[0].doc.severity, 'high')
  assertStringIncludes(sent[0].doc.title, 'Scheduled run of nightly')
})

Deno.test('a deleted run is forgotten, and a resync drops runs deleted while disconnected', async () => {
  const { r } = recorder()
  await r.onRun(meta('Running'), false)
  assertEquals(r.tracked, 1)
  r.onRunGone(meta('Running'))
  assertEquals(r.tracked, 0)
  await r.onRun(meta('Running'), false)
  r.onResync(new Set())
  assertEquals(r.tracked, 0)
})

Deno.test('trigger and failure documents from labels alone', () => {
  assertEquals(triggerOf({ 'workflows.argoproj.io/workflow-event-binding': 'on-push' }), 'event')
  assertEquals(triggerOf({ 'workflows.argoproj.io/resubmitted-from-workflow': 'x' }), 'resubmit')
  assertEquals(triggerOf({}), 'manual')
  const m = runMetaOf(meta('Succeeded'))!
  assertEquals(failureNotification(m, 'x'), null)
})

/* ─────────── approvals ─────────── */

const approvalRun = (nodes: Record<string, unknown>): KubeObject => ({
  metadata: { uid: 'r-1', name: 'release', namespace: 'shop' },
  status: { nodes },
} as unknown as KubeObject)

Deno.test('a waiting approval notifies its approvers once, deep-linked to the node', async () => {
  const { r, sent } = recorder()
  const run = approvalRun({
    'release-42': {
      id: 'release-42',
      type: 'Suspend',
      phase: 'Running',
      inputs: { parameters: [{ name: 'question', value: 'Ship 1.2?' }, { name: 'approvers', value: 'release-managers,user:bob' }] },
    },
    'release-1': { id: 'release-1', type: 'Pod', phase: 'Succeeded' },
  })
  await r.onApprovals(run)
  await r.onApprovals(run)
  assertEquals(sent.length, 1)
  const { tenant, doc } = sent[0]
  assertEquals(tenant, 'acme')
  assertEquals(doc.title, 'Approval requested: Ship 1.2?')
  assertEquals(doc.audience, ['u-rm1', 'u-rm2', 'u-bob'])
  assertEquals(doc.href, '/platform?section=workflow-runs&run=shop%2Frelease&node=release-42')
  assertEquals(doc.key, `workflow-approval:${await eventId('r-1', 'release-42')}`)
})

Deno.test('a timer is not announced as an approval', async () => {
  const { r, sent } = recorder()
  const run = approvalRun({ 'release-42': { id: 'release-42', type: 'Suspend', phase: 'Running', templateName: 'sleep' } })
  ;(run as unknown as { spec: unknown }).spec = { templates: [{ name: 'sleep', suspend: { duration: '10m' } }] }
  await r.onApprovals(run)
  assertEquals(sent.length, 0)
})

Deno.test('an approval with no approvers listed goes to the organisation', async () => {
  const { r, sent } = recorder()
  await r.onApprovals(approvalRun({ 'release-42': { id: 'release-42', type: 'Suspend', phase: 'Running' } }))
  assertEquals(sent.length, 1)
  assertEquals(sent[0].doc.audience, undefined)
})

/* ─────────── an audience that resolves to nobody is never "everyone" ─────────── */

Deno.test('a failed run whose submitter cannot be resolved is not broadcast to the organisation', async () => {
  // notify.ts: no audience = everyone in the tenant. A person's run must not
  // be widened to the whole organisation because Keycloak did not answer.
  const { r, sent } = recorder()
  await r.onRun(meta('Running', {}, { 'adhar.io/submitted-by': 'oidc:carol' }), false)
  await r.onRun(meta('Failed', {}, { 'adhar.io/submitted-by': 'oidc:carol' }), false)
  assertEquals(sent.length, 0)
})

Deno.test('a run a ServiceAccount submitted goes to the organisation, like a schedule', async () => {
  const sa = runMetaOf(meta('Failed', {}, { 'adhar.io/submitted-by': 'system:serviceaccount:shop-dev:ci' }))!
  assertEquals(failureRecipient(sa), undefined)
  const { r, sent } = recorder()
  await r.onRun(meta('Failed', {}, { 'adhar.io/submitted-by': 'system:serviceaccount:shop-dev:ci' }), false)
  assertEquals(sent.length, 1)
  assertEquals(sent[0].doc.audience, undefined)
})

Deno.test('named approvers who resolve to nobody are not announced to everyone, and are tried again later', async () => {
  const { r, sent } = recorder()
  const run = approvalRun({
    'release-42': { id: 'release-42', type: 'Suspend', phase: 'Running', inputs: { parameters: [{ name: 'approvers', value: 'nobody-group' }] } },
  })
  await r.onApprovals(run)
  assertEquals(sent.length, 0)
  // The group gains a member (or Keycloak comes back): the next sighting announces it.
  const later = approvalRun({
    'release-42': { id: 'release-42', type: 'Suspend', phase: 'Running', inputs: { parameters: [{ name: 'approvers', value: 'nobody-group,release-managers' }] } },
  })
  await r.onApprovals(later)
  assertEquals(sent.length, 1)
  assertEquals(sent[0].doc.audience, ['u-rm1', 'u-rm2'])
})

Deno.test('the namespace → organisation map is loaded before any watch starts, even when loading fails', async () => {
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((res) => (release = res))
  const done = tenantsThenWatches(async () => {
    await gate
    order.push('tenants')
  }, () => order.push('watches'), () => false)
  await Promise.resolve()
  assertEquals(order, [], 'no watch before the tenant map')
  release()
  await done
  assertEquals(order, ['tenants', 'watches'])
  const failed: string[] = []
  await tenantsThenWatches(() => Promise.reject(new Error('apiserver down')), () => failed.push('watches'), () => false)
  assertEquals(failed, ['watches'])
  const stopped: string[] = []
  await tenantsThenWatches(() => Promise.resolve(), () => stopped.push('watches'), () => true)
  assertEquals(stopped, [])
})
