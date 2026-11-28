import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { CONSOLE_PERMISSIONS, consoleCheck } from '@adhar/auth/server'
import { ARGO_GROUP, checkFor } from './authz.ts'
import type { Route, RouteOp } from './model.ts'

/**
 * The authz table is the boundary between a team member and another team's
 * runs whenever the BFF reaches argo-server as its ServiceAccount (D-5), so
 * it is pinned row by row: every route, exactly one check, in the route's
 * own namespace.
 */

const ns = 'team-a'
const uid = '0b9b5c5e-2f9f-4c1e-9d1a-3c1f2a1b0c9d'
const run = { namespace: ns, name: 'wf' }

const TABLE: Array<[Route, { verb: string; group: string; resource: string; subresource?: string; namespace?: string } | null]> = [
  [{ op: 'capabilities' }, null],
  [{ op: 'run.get', ...run }, { verb: 'get', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'run.retry', ...run }, { verb: 'update', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'run.resubmit', ...run }, { verb: 'create', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'run.approve', ...run }, { verb: 'update', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'run.logs', ...run }, { verb: 'get', group: '', resource: 'pods', subresource: 'log', namespace: ns }],
  [{ op: 'run.artifact', ...run, nodeId: 'wf-1', artifact: 'a' }, { verb: 'get', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'archive.list', namespace: ns }, { verb: 'list', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'archive.get', namespace: ns, uid }, { verb: 'get', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'archive.retry', namespace: ns, uid }, { verb: 'create', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'archive.resubmit', namespace: ns, uid }, { verb: 'create', group: ARGO_GROUP, resource: 'workflows', namespace: ns }],
  [{ op: 'archive.delete', namespace: ns, uid }, consoleCheck(CONSOLE_PERMISSIONS.workflowsAdmin) as never],
  [{ op: 'drafts.test-run', namespace: ns }, { verb: 'create', group: ARGO_GROUP, resource: 'workflowtemplates', namespace: ns }],
  [{ op: 'engine.get' }, consoleCheck(CONSOLE_PERMISSIONS.workflowsAdmin) as never],
  [{ op: 'engine.suspend-all' }, consoleCheck(CONSOLE_PERMISSIONS.workflowsAdmin) as never],
]

Deno.test('every route maps to exactly the check in the table', () => {
  for (const [route, want] of TABLE) {
    assertEquals(checkFor(route), want, route.op)
  }
})

Deno.test('the table covers every route the BFF serves', () => {
  const ops: RouteOp[] = [
    'capabilities',
    'run.get',
    'run.retry',
    'run.resubmit',
    'run.approve',
    'run.logs',
    'run.artifact',
    'archive.list',
    'archive.get',
    'archive.retry',
    'archive.resubmit',
    'archive.delete',
    'lint',
    'drafts.test-run',
    'engine.get',
    'engine.suspend-all',
  ]
  const covered = new Set<string>([...TABLE.map(([r]) => r.op), 'lint'])
  for (const op of ops) assert(covered.has(op), `${op} has no row`)
})

Deno.test('every namespaced check is asked in the route\'s own namespace', () => {
  for (const [route] of TABLE) {
    if (!('namespace' in route)) continue
    const c = checkFor(route)
    if (c?.group === 'console.adhar.io') continue
    assertEquals(c?.namespace, route.namespace, route.op)
  }
})

Deno.test('lint asks create of the linted kind; a cluster template is asked cluster-wide', () => {
  assertEquals(checkFor({ op: 'lint' }, { kind: 'WorkflowTemplate', namespace: ns, manifest: {} }), { verb: 'create', group: ARGO_GROUP, resource: 'workflowtemplates', namespace: ns })
  assertEquals(checkFor({ op: 'lint' }, { kind: 'CronWorkflow', namespace: ns, manifest: {} })?.resource, 'cronworkflows')
  assertEquals(checkFor({ op: 'lint' }, { kind: 'Workflow', namespace: ns, manifest: {} })?.resource, 'workflows')
  const cwt = checkFor({ op: 'lint' }, { kind: 'ClusterWorkflowTemplate', manifest: {} })
  assertEquals(cwt, { verb: 'create', group: ARGO_GROUP, resource: 'clusterworkflowtemplates' })
  assertThrows(() => checkFor({ op: 'lint' }))
})

Deno.test('workflowsAdmin is the virtual workflows-admin update in console.adhar.io', () => {
  assertEquals(consoleCheck(CONSOLE_PERMISSIONS.workflowsAdmin), { verb: 'update', group: 'console.adhar.io', resource: 'workflows-admin' })
})
