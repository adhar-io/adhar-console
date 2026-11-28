import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import type { AccessCheck } from '@adhar/auth/server'
import type { K8sIdentity } from '../k8s/gateway.ts'
import { type ArgoMode, ArgoUnavailable } from './argo-server.ts'
import { artifactFilename, handleWorkflows, resetCapabilitiesCache, type WorkflowsDeps } from './handler.ts'
import { fnv32a, type WfNode, type WfObject } from './model.ts'

/* ─────────── a small cluster + argo-server ─────────── */

const UID_A = '0b9b5c5e-2f9f-4c1e-9d1a-3c1f2a1b0c9d'
const UID_B = '1c9b5c5e-2f9f-4c1e-9d1a-3c1f2a1b0c9e'

interface Call {
  path: string
  method: string
  query?: string
  body?: unknown
}

interface World {
  /** `verb resource[/sub]@namespace` the caller is allowed; '*' = everything. */
  allow: Set<string>
  degraded?: boolean
  signedIn?: boolean
  mode: ArgoMode
  runs: Map<string, WfObject>
  archived: Map<string, WfObject>
  pods: Map<string, string>
  podLogStatus?: number
  lokiLines?: Array<[string, string]>
  lokiFails?: boolean
  argo: Call[]
  k8s: Call[]
  loki: Array<{ query: string; startMs: number; endMs: number; limit: number }>
  patches: Array<{ ns: string; name: string; patch: unknown }>
  records: Array<{ action: string; outcome: string; meta: Record<string, unknown> }>
  argoAnswer?: (c: Call) => Response | undefined
  /** argo-server does not answer at all. */
  argoDown?: boolean
  /** CronWorkflow list pages, chosen by the `continue` token (page index). */
  cronPages?: Array<{ items: unknown[]; continue?: string }>
  checks: AccessCheck[]
  /** Namespace → its labels (the tier check of a test run). A namespace not listed is unreadable (403). */
  namespaces?: Record<string, Record<string, string>>
  /** WorkflowTemplates on the cluster, by `ns/name`. */
  templates?: Map<string, WfObject>
  /** Answer a gateway call before the defaults (drafts tests). */
  k8sAnswer?: (c: Call) => Response | undefined
}

const NOW = Date.parse('2026-11-25T10:00:00Z')

function world(over: Partial<World> = {}): World {
  return {
    allow: new Set(['*']),
    mode: 'user',
    runs: new Map(),
    archived: new Map(),
    pods: new Map(),
    argo: [],
    k8s: [],
    loki: [],
    patches: [],
    records: [],
    checks: [],
    ...over,
  }
}

const ana: K8sIdentity = { token: 'kc-ana', user: { id: 'u-ana', name: 'Ana', email: 'ana@x.io', username: 'ana', groups: ['ws-team-acme.shop'] } }

const keyOf = (c: AccessCheck) => `${c.verb} ${c.resource}${c.subresource ? `/${c.subresource}` : ''}@${c.namespace ?? ''}`
const j = (body: unknown, status = 200) => Response.json(body, { status })

function deps(w: World): WorkflowsDeps {
  return {
    identity: () => Promise.resolve(w.signedIn === false ? null : ana),
    tenant: () => Promise.resolve('acme'),
    authorize: (_req, check) => {
      w.checks.push(check)
      const ok = w.allow.has('*') || w.allow.has(keyOf(check))
      return Promise.resolve({ allowed: ok && !w.degraded, degraded: Boolean(w.degraded) })
    },
    k8s: (_id, path, init) => {
      const method = init?.method ?? 'GET'
      // A server-side apply sends YAML text, not JSON: kept as the string it is.
      let sent: unknown
      try {
        sent = init?.body ? JSON.parse(init.body) : undefined
      } catch {
        sent = init?.body
      }
      const made: Call & { headers?: Record<string, string> } = { path, method, query: init?.search, body: sent, headers: init?.headers }
      w.k8s.push(made)
      const custom = w.k8sAnswer?.(made)
      if (custom) return Promise.resolve(custom)
      const nsm = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(path)
      if (nsm && w.namespaces) {
        const labels = w.namespaces[nsm[1]]
        return Promise.resolve(labels ? j({ metadata: { name: nsm[1], labels } }) : j({ message: 'forbidden' }, 403))
      }
      const tm = /^\/apis\/argoproj\.io\/v1alpha1\/namespaces\/([^/]+)\/workflowtemplates\/([^/]+)$/.exec(path)
      if (tm && w.templates) {
        if (method === 'GET') {
          const t = w.templates.get(`${tm[1]}/${tm[2]}`)
          return Promise.resolve(t ? j(t) : j({ message: 'not found' }, 404))
        }
        return Promise.resolve(j({ metadata: { name: tm[2], namespace: tm[1] } }))
      }
      const wm2 = /^\/apis\/argoproj\.io\/v1alpha1\/namespaces\/([^/]+)\/workflows$/.exec(path)
      if (wm2 && method === 'POST') {
        const b = sent as { metadata?: { generateName?: string } }
        return Promise.resolve(j({ metadata: { name: `${b.metadata?.generateName}x7k2p`, namespace: wm2[1], uid: 'run-uid' }, status: {} }, 201))
      }
      let m = /^\/apis\/argoproj\.io\/v1alpha1\/namespaces\/([^/]+)\/workflows\/([^/]+)$/.exec(path)
      if (m) {
        const r = w.runs.get(`${m[1]}/${m[2]}`)
        return Promise.resolve(r ? j(r) : j({}, 404))
      }
      m = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/.exec(path)
      if (m) {
        if (w.podLogStatus) return Promise.resolve(new Response('nope', { status: w.podLogStatus }))
        const log = w.pods.get(`${m[1]}/${m[2]}`)
        return Promise.resolve(log !== undefined ? new Response(log) : j({}, 404))
      }
      if (/^\/api\/v1\/namespaces\/[^/]+\/pods$/.test(path)) return Promise.resolve(j({ items: [] }))
      if (path.endsWith('/cronworkflows') && w.cronPages) {
        const at = Number(new URLSearchParams(init?.search ?? '').get('continue') ?? '0')
        const page = w.cronPages[at]
        return Promise.resolve(j({ items: page.items, metadata: page.continue ? { continue: page.continue } : {} }))
      }
      if (path.endsWith('/cronworkflows')) {
        return Promise.resolve(j({ items: [
          { metadata: { name: 'nightly', namespace: 'shop' }, spec: { suspend: false } },
          { metadata: { name: 'weekly', namespace: 'shop' }, spec: { suspend: true } },
        ] }))
      }
      if (method === 'PATCH') return Promise.resolve(j({}))
      if (path.startsWith('/apis/argoproj.io/v1alpha1') && path.endsWith('/v1alpha1')) {
        return Promise.resolve(j({ resources: [{ name: 'workflows' }, { name: 'workflows/status' }, { name: 'workfloweventbindings' }] }))
      }
      if (path === '/apis/argoproj.io/v1alpha1') return Promise.resolve(j({ resources: [{ name: 'workflows' }, { name: 'workfloweventbindings' }] }))
      if (path.startsWith('/apis/')) return Promise.resolve(j({}, 404))
      if (path === '/api/v1/namespaces/adhar-system/configmaps/workflow-controller-configmap') return Promise.resolve(j({ data: { parallelism: '25', namespaceParallelism: '5' } }))
      if (path === '/api/v1/namespaces') return Promise.resolve(j({ items: [{ metadata: { name: 'shop-dev', labels: { 'workflows.argoproj.io/parallelism-limit': '3' } } }] }))
      if (method === 'PATCH') return Promise.resolve(j({}))
      return Promise.resolve(j({}, 404))
    },
    argo: (_id, path, init) => {
      const c: Call = { path, method: init?.method ?? 'GET', query: init?.query?.toString(), body: init?.body }
      w.argo.push(c)
      if (w.argoDown) return Promise.reject(new ArgoUnavailable('unreachable', 'argo-server did not answer: connection refused'))
      const custom = w.argoAnswer?.(c)
      if (custom) return Promise.resolve({ res: custom, mode: w.mode })
      let res: Response = j({}, 404)
      const m = /^\/api\/v1\/archived-workflows\/([^/]+)(\/(retry|resubmit))?$/.exec(path)
      if (path === '/api/v1/version') res = j({ version: 'v4.1.6' })
      else if (path === '/api/v1/archived-workflows') {
        res = j({ items: [...w.archived.values()], metadata: { continue: 'next' } })
      } else if (m) {
        const a = w.archived.get(m[1])
        res = a ? (m[3] ? j({ metadata: { name: 'wf-new', namespace: a.metadata?.namespace, uid: 'new' }, status: { phase: 'Pending' } }) : c.method === 'DELETE' ? j({}) : j(a)) : j({ message: 'not found' }, 404)
      } else if (/\/(retry|resubmit)$/.test(path)) res = j({ metadata: { name: path.endsWith('resubmit') ? 'wf-resub' : 'wf', namespace: 'shop' }, status: { phase: 'Running' } })
      else if (/\/(set|resume)$/.test(path)) res = j({})
      else if (/\/lint$/.test(path)) {
        const body = c.body as Record<string, unknown>
        const t = (body.template ?? body.workflow ?? body.cronWorkflow) as { spec?: { entrypoint?: string } }
        res = t?.spec?.entrypoint ? j({}) : j({ code: 3, message: 'spec.entrypoint is required' }, 400)
      } else if (path.startsWith('/artifact-files/')) res = new Response('data', { headers: { 'content-type': 'text/html' } })
      else {
        const wm = /^\/api\/v1\/workflows\/([^/]+)\/([^/]+)$/.exec(path)
        if (wm) {
          const r = w.runs.get(`${wm[1]}/${wm[2]}`)
          if (r) res = j(r)
        }
      }
      return Promise.resolve({ res, mode: w.mode })
    },
    argoConfigured: () => true,
    patchAsArgo: (ns, name, patch) => {
      w.patches.push({ ns, name, patch })
      return Promise.resolve(true)
    },
    clusterKnown: (c) => !c || c === 'default',
    loki: (query, startMs, endMs, limit) => {
      w.loki.push({ query, startMs, endMs, limit })
      if (w.lokiFails) return Promise.reject(new Error('Loki HTTP 502'))
      return Promise.resolve(w.lokiLines ?? [])
    },
    prom: (expr) => Promise.resolve(expr.includes('is_leader') ? [{ value: [0, '1'] as [number, string] }] : []),
    artifactNamespaces: () => ['adhar-system'],
    record: (_t, _a, action, _target, _req, meta, outcome) => {
      w.records.push({ action, outcome, meta })
      return Promise.resolve()
    },
    log: () => {},
    now: () => NOW,
  }
}

const call = (w: World, method: string, sub: string, body?: unknown) =>
  handleWorkflows(new Request(`http://console/api/workflows${sub}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), sub.split('?')[0], deps(w))

/* ─────────── fixtures ─────────── */

const approvalRun = (over: { inputs?: Record<string, string>; submittedBy?: string; outputs?: boolean } = {}): WfObject => ({
  metadata: {
    name: 'release',
    namespace: 'shop',
    uid: 'r-1',
    annotations: over.submittedBy === undefined ? { 'adhar.io/submitted-by': 'oidc:bob' } : over.submittedBy ? { 'adhar.io/submitted-by': over.submittedBy } : {},
  },
  status: {
    phase: 'Running',
    nodes: {
      'release-42': {
        id: 'release-42',
        name: 'release.approve',
        type: 'Suspend',
        phase: 'Running',
        inputs: { parameters: Object.entries(over.inputs ?? {}).map(([name, value]) => ({ name, value })) },
        ...(over.outputs === false ? {} : { outputs: { parameters: [{ name: 'decision', valueFrom: { supplied: {} } }, { name: 'approver', valueFrom: { supplied: {} } }] } }),
      },
    },
  },
})

const podRun = (finished = true): WfObject => ({
  metadata: { name: 'nightly', namespace: 'shop', uid: 'n-1' },
  status: {
    phase: finished ? 'Failed' : 'Running',
    nodes: {
      [`nightly-${fnv32a('nightly.build')}`]: {
        id: `nightly-${fnv32a('nightly.build')}`,
        name: 'nightly.build',
        templateName: 'compile',
        type: 'Pod',
        phase: finished ? 'Failed' : 'Running',
        startedAt: '2026-11-25T09:00:00Z',
        ...(finished ? { finishedAt: '2026-11-25T09:05:00Z' } : {}),
      },
      nightly: { id: 'nightly', name: 'nightly', type: 'DAG' },
    },
  },
})
const POD = `nightly-compile-${fnv32a('nightly.build')}`
const NODE = `nightly-${fnv32a('nightly.build')}`

/* ─────────── signed in, authorised, or nothing happens ─────────── */

const EVERY_ROUTE: Array<[string, string, unknown?]> = [
  ['GET', '/runs/shop/wf'],
  ['POST', '/runs/shop/wf/retry', {}],
  ['POST', '/runs/shop/wf/resubmit', {}],
  ['POST', '/runs/shop/wf/approve', { nodeId: 'wf-1', decision: 'approve' }],
  ['GET', `/runs/shop/wf/logs?node=wf-1`],
  ['GET', '/runs/adhar-system/wf/artifacts/wf-1/out'],
  ['GET', '/archive/shop'],
  ['GET', `/archive/shop/${UID_A}`],
  ['POST', `/archive/shop/${UID_A}/retry`, {}],
  ['POST', `/archive/shop/${UID_A}/resubmit`, {}],
  ['DELETE', `/archive/shop/${UID_A}`],
  ['POST', '/lint', { namespace: 'shop', kind: 'WorkflowTemplate', manifest: { spec: { entrypoint: 'main' } } }],
  ['GET', '/engine'],
  ['POST', '/engine/schedules/suspend-all', { reason: 'incident' }],
]

Deno.test('every route answers 401 to a caller who is not signed in, before any upstream call', async () => {
  for (const [m, p, b] of [...EVERY_ROUTE, ['GET', '/capabilities'] as [string, string]]) {
    const w = world({ signedIn: false })
    const res = await call(w, m, p, b)
    assertEquals(res.status, 401, `${m} ${p}`)
    assertEquals(w.argo.length + w.k8s.length, 0, `${m} ${p} called upstream`)
  }
})

Deno.test('every route is refused (403, naming the rule) when its one check says no — and nothing reaches upstream', async () => {
  for (const [m, p, b] of EVERY_ROUTE) {
    const w = world({ allow: new Set() })
    const res = await call(w, m, p, b)
    assertEquals(res.status, 403, `${m} ${p}`)
    assertEquals(w.checks.length, 1, `${m} ${p} asked ${w.checks.length} checks`)
    assertEquals(w.argo.length + w.k8s.length + w.loki.length, 0, `${m} ${p} called upstream after a refusal`)
    assertStringIncludes((await res.json()).detail, 'not permitted')
  }
})

Deno.test('a check that could not be asked is 503, never a pass', async () => {
  const w = world({ degraded: true })
  const res = await call(w, 'GET', '/archive/shop')
  assertEquals(res.status, 503)
  assertEquals(w.argo.length, 0)
})

/* ─────────── archive (acceptance 2) ─────────── */

const archivedIn = (ns: string, name = 'old'): WfObject => ({ metadata: { name, namespace: ns, uid: ns === 'shop' ? UID_A : UID_B, labels: {} }, status: { phase: 'Succeeded', startedAt: '2026-11-20T00:00:00Z' } })

Deno.test('archive: user A cannot read B\'s namespace — refused as A, and B\'s item is 404 even when asked through A\'s namespace', async () => {
  const w = world({ allow: new Set(['list workflows@shop', 'get workflows@shop']) })
  w.archived.set(UID_A, archivedIn('shop'))
  w.archived.set(UID_B, archivedIn('payments'))
  assertEquals((await call(w, 'GET', '/archive/payments')).status, 403)
  assertEquals((await call(w, 'GET', `/archive/payments/${UID_B}`)).status, 403)
  // B's uid through A's (authorised) namespace: the namespace does not match.
  const crossed = await call(w, 'GET', `/archive/shop/${UID_B}`)
  assertEquals(crossed.status, 404)
  const own = await call(w, 'GET', `/archive/shop/${UID_A}`)
  assertEquals(own.status, 200)
  assertEquals(w.argo.filter((c) => c.path.startsWith('/api/v1/archived-workflows/')).every((c) => c.query === 'namespace=shop'), true)
})

Deno.test('archive list: a crafted fieldSelector is dropped, the namespace is forced, foreign items are filtered', async () => {
  const w = world()
  w.archived.set(UID_A, archivedIn('shop'))
  w.archived.set(UID_B, archivedIn('payments'))
  const res = await call(w, 'GET', '/archive/shop?fieldSelector=metadata.namespace%3Dpayments&listOptions.fieldSelector=metadata.namespace%3Dpayments&namespace=payments&phase=Succeeded')
  assertEquals(res.status, 200)
  const q = new URLSearchParams(w.argo[0].query)
  assertEquals(q.getAll('namespace'), ['shop'])
  assert(![...q.keys()].some((k) => /fieldselector/i.test(k)))
  const body = await res.json()
  assertEquals(body.items.map((i: { namespace: string }) => i.namespace), ['shop'])
  assertEquals(body.continue, 'next')
})

Deno.test('archive retry/resubmit pin the namespace in the body, restore the submitter in service mode, and are audited', async () => {
  const w = world({ mode: 'service' })
  w.archived.set(UID_A, archivedIn('shop'))
  const res = await call(w, 'POST', `/archive/shop/${UID_A}/resubmit`, { memoized: true, serviceAccount: 'admin' })
  assertEquals(res.status, 200)
  const put = w.argo.find((c) => c.method === 'PUT')!
  assertEquals(put.body, { uid: UID_A, name: 'old', namespace: 'shop', memoized: true })
  assertEquals(w.patches, [{ ns: 'shop', name: 'wf-new', patch: { metadata: { annotations: { 'adhar.io/submitted-by': 'oidc:ana' }, labels: { 'adhar.io/submitter': 'oidc-ana' } } } }])
  assertEquals(w.records.map((r) => [r.action, r.outcome]), [['workflow.resubmit', 'success']])
  // B's item through A's namespace is 404 and nothing is resubmitted.
  w.archived.set(UID_B, archivedIn('payments'))
  const crossed = await call(w, 'POST', `/archive/shop/${UID_B}/retry`, {})
  assertEquals(crossed.status, 404)
  assertEquals(w.argo.filter((c) => c.method === 'PUT').length, 1)
})

Deno.test('archive delete needs workflowsAdmin and the item in the namespace', async () => {
  const w = world({ allow: new Set(['get workflows@shop']) })
  w.archived.set(UID_A, archivedIn('shop'))
  assertEquals((await call(w, 'DELETE', `/archive/shop/${UID_A}`)).status, 403)
  assertEquals(w.checks.at(-1), { verb: 'update', group: 'console.adhar.io', resource: 'workflows-admin' })
  const admin = world()
  admin.archived.set(UID_A, archivedIn('shop'))
  assertEquals((await call(admin, 'DELETE', `/archive/shop/${UID_A}`)).status, 200)
  assertEquals(admin.argo.at(-1)?.method, 'DELETE')
  assertEquals(admin.records[0].action, 'workflow.delete')
})

/* ─────────── runs ─────────── */

Deno.test('retry: the body is built (node by id only), sent to the authorised namespace, and audited', async () => {
  const w = world()
  const res = await call(w, 'POST', '/runs/shop/wf/retry', { restartSuccessful: true, nodeId: 'wf-12', serviceAccount: 'admin', namespace: 'payments' })
  assertEquals(res.status, 200)
  assertEquals(w.argo[0].path, '/api/v1/workflows/shop/wf/retry')
  assertEquals(w.argo[0].body, { name: 'wf', namespace: 'shop', restartSuccessful: true, nodeFieldSelector: 'id=wf-12' })
  assertEquals(w.records[0].action, 'workflow.retry')
  assertEquals((await call(world(), 'POST', '/runs/shop/wf/retry', { nodeFieldSelector: 'phase=Failed' })).status, 400)
})

Deno.test('resubmit: user mode leaves provenance to Kyverno; service mode restores the submitter', async () => {
  const u = world({ mode: 'user' })
  assertEquals((await call(u, 'POST', '/runs/shop/wf/resubmit', { memoized: true })).status, 200)
  assertEquals(u.patches.length, 0)
  const s = world({ mode: 'service' })
  assertEquals((await call(s, 'POST', '/runs/shop/wf/resubmit', { memoized: true })).status, 200)
  assertEquals(s.patches[0].name, 'wf-resub')
})

Deno.test('an argo-server refusal of the console SA is the platform\'s missing grant (502), not the user\'s 403', async () => {
  const w = world({ mode: 'service', argoAnswer: (c) => (c.path.endsWith('/retry') ? j({ message: 'forbidden' }, 403) : undefined) })
  const res = await call(w, 'POST', '/runs/shop/wf/retry', {})
  assertEquals(res.status, 502)
  assertEquals((await res.json()).error, 'argo_service_forbidden')
  assertEquals(w.records[0].outcome, 'failure')
})

Deno.test('the hydrated run is refused if argo-server hands back another namespace\'s object', async () => {
  const w = world()
  w.runs.set('shop/wf', { metadata: { name: 'wf', namespace: 'payments' } })
  assertEquals((await call(w, 'GET', '/runs/shop/wf')).status, 404)
})

/* ─────────── approvals (acceptance 1) ─────────── */

Deno.test('approve: set (decision + server-derived approver + message) then resume, audited', async () => {
  const w = world()
  w.runs.set('shop/release', approvalRun())
  const res = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'release-42', decision: 'approve', comment: 'lgtm', approver: 'mallory' })
  assertEquals(res.status, 200)
  const [set, resume] = w.argo
  assertEquals(set.path, '/api/v1/workflows/shop/release/set')
  const body = set.body as Record<string, string>
  assertEquals(JSON.parse(body.outputParameters), { decision: 'approve', approver: 'ana' })
  assertEquals(body.message, 'Approved by ana via Adhar console: lgtm')
  assertEquals(body.nodeFieldSelector, 'id=release-42')
  assertEquals(resume.path, '/api/v1/workflows/shop/release/resume')
  assertEquals(resume.body, { name: 'release', namespace: 'shop', nodeFieldSelector: 'id=release-42' })
  assertEquals(w.records[0], { action: 'workflow.approve', outcome: 'success', meta: { node: 'release-42', decision: 'approve', comment: 'lgtm', identity: 'user' } })
})

Deno.test('approve: self-approval is refused when the node forbids it', async () => {
  const w = world()
  w.runs.set('shop/release', approvalRun({ inputs: { forbidSelfApproval: 'true' }, submittedBy: 'oidc:ana' }))
  const res = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'release-42', decision: 'approve' })
  assertEquals(res.status, 403)
  assertEquals((await res.json()).error, 'self_approval_forbidden')
  assertEquals(w.argo.length, 0)
  assertEquals(w.records[0].outcome, 'failure')
})

Deno.test('approve: someone outside the approvers list is refused; a node that is not waiting is 409', async () => {
  const w = world()
  w.runs.set('shop/release', approvalRun({ inputs: { approvers: 'release-managers' } }))
  const res = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'release-42', decision: 'approve' })
  assertEquals(res.status, 403)
  assertEquals((await res.json()).error, 'not_an_approver')
  const gone = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'release-43', decision: 'approve' })
  assertEquals(gone.status, 409)
  assertEquals(w.argo.length, 0)
})

Deno.test('approve: a timer (a suspend with a duration that asks nothing) is not waiting for a decision — 409, nothing sent', async () => {
  const w = world()
  const run = approvalRun({ outputs: false })
  ;(run.spec as Record<string, unknown>) = { templates: [{ name: 'approve', suspend: { duration: '1h' } }] }
  ;(run.status!.nodes!['release-42'] as WfNode).templateName = 'approve'
  w.runs.set('shop/release', run)
  const res = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'release-42', decision: 'approve' })
  assertEquals(res.status, 409)
  assertEquals((await res.json()).error, 'not_waiting')
  assertEquals(w.argo.length, 0)
})

Deno.test('reject on a hand-written suspend (no decision output) fails the node and does not resume it', async () => {
  const w = world()
  w.runs.set('shop/release', approvalRun({ outputs: false }))
  const res = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'release-42', decision: 'reject', comment: 'no' })
  assertEquals(res.status, 200)
  assertEquals(w.argo.length, 1)
  assertEquals((w.argo[0].body as Record<string, unknown>).phase, 'Failed')
  assertEquals(w.records[0].action, 'workflow.reject')
})

/* ─────────── logs (acceptance 3) ─────────── */

Deno.test('logs of a live pod come from the pod, as the user, labelled live', async () => {
  const w = world()
  w.runs.set('shop/nightly', podRun(false))
  w.pods.set(`shop/${POD}`, 'compiling\ndone\n')
  const res = await call(w, 'GET', `/runs/shop/nightly/logs?node=${NODE}&tail=50`)
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { source: 'live', pod: POD, container: 'main', lines: ['compiling', 'done'] })
  assertEquals(w.loki.length, 0)
})

Deno.test('logs of a cleaned-up pod come from Loki, pinned to the namespace and pod, over the node window, labelled loki', async () => {
  const w = world({ lokiLines: [['1764061210000000000', 'second'], ['1764061200000000000', 'first']] })
  w.runs.set('shop/nightly', podRun(true))
  const res = await call(w, 'GET', `/runs/shop/nightly/logs?node=${NODE}`)
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.source, 'loki')
  assertEquals(body.lines, ['first', 'second'])
  assertStringIncludes(body.note, 'Loki')
  assertEquals(w.loki[0].query, `{namespace="shop", pod="${POD}", container="main"}`)
  assertEquals(w.loki[0].startMs, Date.parse('2026-11-25T08:59:00Z'))
  assertEquals(w.loki[0].endMs, Date.parse('2026-11-25T09:06:00Z'))
})

Deno.test('logs: Loki down is a 503 that still says the source, and a pods/log refusal is 403', async () => {
  const w = world({ lokiFails: true })
  w.runs.set('shop/nightly', podRun(true))
  const res = await call(w, 'GET', `/runs/shop/nightly/logs?node=${NODE}`)
  assertEquals(res.status, 503)
  assertEquals((await res.json()).source, 'loki')
  const f = world({ podLogStatus: 403 })
  f.runs.set('shop/nightly', podRun(false))
  assertEquals((await call(f, 'GET', `/runs/shop/nightly/logs?node=${NODE}`)).status, 403)
  assertEquals(f.loki.length, 0)
})

Deno.test('logs: a non-pod node or a bad query is refused', async () => {
  const w = world()
  w.runs.set('shop/nightly', podRun(true))
  assertEquals((await call(w, 'GET', '/runs/shop/nightly/logs?node=nightly')).status, 400)
  assertEquals((await call(w, 'GET', '/runs/shop/nightly/logs')).status, 400)
  assertEquals((await call(w, 'GET', `/runs/shop/nightly/logs?node=${NODE}&container=sidecar`)).status, 400)
})

/* ─────────── artifacts ─────────── */

Deno.test('artifacts: only artifact namespaces, streamed as a download', async () => {
  const w = world()
  const no = await call(w, 'GET', '/runs/shop/wf/artifacts/wf-1/out')
  assertEquals(no.status, 404)
  assertEquals(w.argo.length, 0)
  const res = await call(w, 'GET', '/runs/adhar-system/wf/artifacts/wf-1/out')
  assertEquals(res.status, 200)
  assertEquals(await res.text(), 'data')
  assertStringIncludes(res.headers.get('content-disposition') ?? '', 'attachment')
  assertEquals(res.headers.get('x-content-type-options'), 'nosniff')
  assertEquals(w.argo[0].path, '/artifact-files/adhar-system/workflows/wf/wf-1/outputs/out')
})

/* ─────────── lint ─────────── */

Deno.test('lint: create <kind> in the namespace is the check; argo-server\'s verdict comes back as valid/message', async () => {
  const w = world({ allow: new Set(['create workflowtemplates@shop']) })
  const ok = await call(w, 'POST', '/lint', { namespace: 'shop', kind: 'WorkflowTemplate', manifest: { spec: { entrypoint: 'main' } } })
  assertEquals(await ok.json(), { valid: true })
  const bad = await call(w, 'POST', '/lint', { namespace: 'shop', kind: 'WorkflowTemplate', manifest: { spec: {} } })
  assertEquals(await bad.json(), { valid: false, message: 'spec.entrypoint is required' })
  assertEquals((await call(w, 'POST', '/lint', { namespace: 'payments', kind: 'WorkflowTemplate', manifest: { spec: {} } })).status, 403)
  assertEquals((await call(w, 'POST', '/lint', { kind: 'ClusterWorkflowTemplate', manifest: { spec: {} } })).status, 403)
  assertEquals(w.checks.at(-1), { verb: 'create', group: 'argoproj.io', resource: 'clusterworkflowtemplates' })
})

/* ─────────── capabilities + engine ─────────── */

Deno.test('capabilities: installed from discovery, argo-server version and identity, unknown cluster refused', async () => {
  resetCapabilitiesCache()
  const w = world({ mode: 'service' })
  const res = await call(w, 'GET', '/capabilities')
  const caps = await res.json()
  assertEquals(caps.installed, true)
  assertEquals(caps.version, 'v4.1.6')
  assertEquals(caps.argoServer, { reachable: true, identity: 'service' })
  assertEquals(caps.artifactNamespaces, ['adhar-system'])
  assertEquals(caps.triggers, { bindings: true, platformEvents: false })
  assertEquals(caps.gamedays, false)
  assertEquals(w.checks.length, 0, 'capabilities asks no RBAC question')
  assertEquals((await call(world(), 'GET', '/capabilities?cluster=elsewhere')).status, 400)
  resetCapabilitiesCache()
})

Deno.test('engine: workflowsAdmin only; controller metrics, limits and namespace overrides', async () => {
  const w = world()
  const res = await call(w, 'GET', '/engine')
  const body = await res.json()
  assertEquals(body.controller.leader, 1)
  assertEquals(body.controller.queueDepth, null)
  assertEquals(body.limits, { parallelism: 25, namespaceParallelism: 5 })
  assertEquals(body.namespaces, [{ name: 'shop-dev', parallelismLimit: 3 }])
})

Deno.test('suspend-all: a reason is required; only running schedules are patched, as the user; audited once', async () => {
  const w = world()
  assertEquals((await call(w, 'POST', '/engine/schedules/suspend-all', {})).status, 400)
  const res = await call(w, 'POST', '/engine/schedules/suspend-all', { reason: 'incident 42', namespaces: ['shop'] })
  const body = await res.json()
  assertEquals(body, { suspended: ['shop/nightly'], failed: [], alreadySuspended: 1 })
  const patch = w.k8s.find((c) => c.method === 'PATCH')!
  assertEquals(patch.path, '/apis/argoproj.io/v1alpha1/namespaces/shop/cronworkflows/nightly')
  assertEquals((patch.body as { spec: { suspend: boolean } }).spec.suspend, true)
  assertEquals(w.records.map((r) => r.action), ['workflow.engine.suspend-all'])
})

Deno.test('unknown paths are 404 and wrong methods 405', async () => {
  assertEquals((await call(world(), 'GET', '/nope')).status, 404)
  assertEquals((await call(world(), 'GET', '/runs/shop/wf/retry')).status, 405)
  assertEquals((await call(world(), 'GET', '/runs/Shop/wf')).status, 400)
})

/* ─────────── verifier: attacks that the first pass let through ─────────── */

Deno.test('artifacts are ALWAYS a sandboxed download: argo-server\'s disposition is not passed through', async () => {
  // argo-server v4 sends `filename="<basename>"` with no disposition type;
  // passing it (or an `inline`) through would let an HTML artifact render on
  // the console's origin.
  for (const upstream of ['filename="report.html"', 'inline; filename="report.html"', 'inline']) {
    const w = world({ argoAnswer: (c) => (c.path.startsWith('/artifact-files/') ? new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html', 'content-disposition': upstream } }) : undefined) })
    const res = await call(w, 'GET', '/runs/adhar-system/wf/artifacts/wf-1/report')
    assertEquals(res.status, 200)
    const cd = res.headers.get('content-disposition') ?? ''
    assert(cd.startsWith('attachment;'), `${upstream} -> ${cd}`)
    assertStringIncludes(res.headers.get('content-security-policy') ?? '', 'sandbox')
    assertEquals(res.headers.get('x-content-type-options'), 'nosniff')
    await res.body?.cancel()
  }
  assertEquals(artifactFilename('filename="report.html"', 'report'), 'report.html')
  assertEquals(artifactFilename('filename="../../etc/pa\"ss wd"', 'report'), 'pa')
  assertEquals(artifactFilename("filename*=UTF-8''my%20report%3B.html", 'report'), 'my_report_.html')
  assertEquals(artifactFilename(null, 'out'), 'out')
})

Deno.test('approve: the node selector sent upstream is the validated id asked for, never the stored node\'s own id', async () => {
  const w = world()
  const run = approvalRun()
  // Someone with update rights rewrote the stored node id into a wider selector.
  run.status!.nodes!['release-42'].id = 'release-42,phase=Running'
  w.runs.set('shop/release', run)
  const res = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'release-42', decision: 'approve' })
  assertEquals(res.status, 409)
  assertEquals(w.argo.length, 0)
  // A node id that names an Object.prototype member is not a node.
  const proto = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'constructor', decision: 'approve' })
  assertEquals(proto.status, 409)
})

Deno.test('approve: self-approval is refused under a configured user prefix, and a run still naming the console SA is an unknown submitter', async () => {
  const w = world()
  w.runs.set('shop/release', approvalRun({ inputs: { forbidSelfApproval: 'true' }, submittedBy: 'system:serviceaccount:adhar-system:adhar-console-argo' }))
  const sa = await call(w, 'POST', '/runs/shop/release/approve', { nodeId: 'release-42', decision: 'approve' })
  assertEquals(sa.status, 409)
  assertEquals((await sa.json()).error, 'submitter_unknown')
  const prev = Deno.env.get('K8S_IMPERSONATE_USER_PREFIX')
  Deno.env.set('K8S_IMPERSONATE_USER_PREFIX', 'keycloak:')
  try {
    const k = world()
    k.runs.set('shop/release', approvalRun({ inputs: { forbidSelfApproval: 'true' }, submittedBy: 'keycloak:ana' }))
    const res = await call(k, 'POST', '/runs/shop/release/approve', { nodeId: 'release-42', decision: 'approve' })
    assertEquals(res.status, 403)
    assertEquals((await res.json()).error, 'self_approval_forbidden')
    assertEquals(k.argo.length, 0)
  } finally {
    if (prev === undefined) Deno.env.delete('K8S_IMPERSONATE_USER_PREFIX')
    else Deno.env.set('K8S_IMPERSONATE_USER_PREFIX', prev)
  }
})

Deno.test('service-mode resubmit restores the submitter label as well as the annotation', async () => {
  // argo-server copies the ORIGINAL run's labels into a resubmitted run, so
  // the "My runs" label must be rewritten too, to Kyverno's slug of the user.
  const s = world({ mode: 'service' })
  assertEquals((await call(s, 'POST', '/runs/shop/wf/resubmit', { memoized: true })).status, 200)
  assertEquals(s.patches[0].patch, { metadata: { annotations: { 'adhar.io/submitted-by': 'oidc:ana' }, labels: { 'adhar.io/submitter': 'oidc-ana' } } })
})

Deno.test('suspend-all reads every page of schedules, not just the first', async () => {
  const w = world({
    cronPages: [
      { items: [{ metadata: { name: 'a', namespace: 'shop' }, spec: {} }], continue: '1' },
      { items: [{ metadata: { name: 'b', namespace: 'shop' }, spec: {} }, { metadata: { name: 'c', namespace: 'shop' }, spec: { suspend: true } }] },
    ],
  })
  const body = await (await call(w, 'POST', '/engine/schedules/suspend-all', { reason: 'incident 7' })).json()
  assertEquals(body, { suspended: ['shop/a', 'shop/b'], failed: [], alreadySuspended: 1 })
})

Deno.test('argo-server down: argo-backed routes are 503 argo_unavailable after the check, live logs still work, capabilities say unreachable', async () => {
  for (const [m, p, b] of [
    ['GET', '/archive/shop'],
    ['GET', `/archive/shop/${UID_A}`],
    ['POST', '/runs/shop/wf/retry', {}],
    ['GET', '/runs/shop/wf'],
  ] as Array<[string, string, unknown?]>) {
    const w = world({ argoDown: true })
    const res = await call(w, m, p, b)
    assertEquals(res.status, 503, `${m} ${p}`)
    assertEquals((await res.json()).error, 'argo_unavailable')
    assertEquals(w.checks.length, 1, 'the check was still asked first')
  }
  const live = world({ argoDown: true })
  live.runs.set('shop/nightly', podRun(false))
  live.pods.set(`shop/${POD}`, 'still here\n')
  const logs = await call(live, 'GET', `/runs/shop/nightly/logs?node=${NODE}`)
  assertEquals((await logs.json()).lines, ['still here'])
  resetCapabilitiesCache()
  const caps = await (await call(world({ argoDown: true }), 'GET', '/capabilities')).json()
  assertEquals(caps.argoServer, { reachable: false, identity: 'none' })
  assertEquals(caps.archive, false)
  resetCapabilitiesCache()
})

/* ─────────── drafts: the designer's test run (W2-C3) ─────────── */

const DRAFT_YAML = `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: nightly
spec:
  entrypoint: main
  templates:
    - name: main
      container:
        image: docker.io/library/busybox:1.37
        securityContext: {runAsUser: 065532}
`

const draftWorld = (over: Partial<World> = {}) =>
  world({ namespaces: { 'shop-dev': { 'adhar.io/tier': 'dev' }, 'shop-prod': { 'adhar.io/tier': 'prod' }, 'adhar-system': {} }, templates: new Map(), ...over })

Deno.test('test run: the draft is applied as the user in a dev namespace, then a run of it is created', async () => {
  const w = draftWorld()
  const res = await call(w, 'POST', '/drafts/shop-dev/test-run', { yaml: DRAFT_YAML, parameters: { env: 'dev' } })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.draft, { name: 'nightly-draft-ana', namespace: 'shop-dev', expires: '2026-12-02T10:00:00Z' })
  assertEquals(body.workflow.name, 'nightly-draft-ana-x7k2p')
  // ONE authorization question, in the route's namespace.
  assertEquals(w.checks.map(keyOf), ['create workflowtemplates@shop-dev'])
  // Order: tier → existing → apply → submit. Nothing reaches argo-server.
  assertEquals(w.k8s.map((c) => `${c.method} ${c.path}`), [
    'GET /api/v1/namespaces/shop-dev',
    'GET /apis/argoproj.io/v1alpha1/namespaces/shop-dev/workflowtemplates/nightly-draft-ana',
    'PATCH /apis/argoproj.io/v1alpha1/namespaces/shop-dev/workflowtemplates/nightly-draft-ana',
    'POST /apis/argoproj.io/v1alpha1/namespaces/shop-dev/workflows',
  ])
  assertEquals(w.argo.length, 0)
  const apply = w.k8s[2] as Call & { headers?: Record<string, string> }
  assertEquals(apply.headers?.['content-type'], 'application/apply-patch+yaml')
  const q = new URLSearchParams(apply.query)
  assertEquals(q.get('fieldManager'), 'adhar-console-designer')
  assertEquals(q.get('dryRun'), null)
  // YAML TEXT, with the scalar the API server reads as octal left as typed.
  assert(typeof apply.body === 'string')
  assertStringIncludes(apply.body as string, 'runAsUser: 065532')
  assertStringIncludes(apply.body as string, 'adhar.io/workflow-draft: "true"')
  assertStringIncludes(apply.body as string, 'adhar.io/draft-expires: "2026-12-02T10:00:00Z"')
  assertStringIncludes(apply.body as string, 'namespace: shop-dev')
  const run = w.k8s[3].body as { metadata: Record<string, unknown>; spec: Record<string, unknown> }
  assertEquals(run.spec, { workflowTemplateRef: { name: 'nightly-draft-ana' }, arguments: { parameters: [{ name: 'env', value: 'dev' }] } })
  assert(!JSON.stringify(run).toLowerCase().includes('serviceaccount'))
  assertEquals(w.records.map((r) => `${r.action}:${r.outcome}`), ['workflow.draft.test-run:success'])
  assertEquals(w.records[0].meta.run, 'nightly-draft-ana-x7k2p')
})

Deno.test('test run: only in a dev namespace — prod, an unlabelled namespace and one the user cannot read are refused before anything is written', async () => {
  for (const [ns, code] of [['shop-prod', 'not_dev'], ['adhar-system', 'not_dev'], ['other-team', 'tier_unknown']] as const) {
    const w = draftWorld()
    const res = await call(w, 'POST', `/drafts/${ns}/test-run`, { yaml: DRAFT_YAML })
    assertEquals(res.status, 403, ns)
    assertEquals((await res.json()).error, code, ns)
    assert(w.k8s.every((c) => c.method === 'GET'), `${ns}: something was written`)
    assertEquals(w.k8s.length, 1, ns)
  }
})

Deno.test('test run: without create workflowtemplates the route answers 403 and asks the cluster nothing', async () => {
  const w = draftWorld({ allow: new Set(['create workflows@shop-dev']) })
  const res = await call(w, 'POST', '/drafts/shop-dev/test-run', { yaml: DRAFT_YAML })
  assertEquals(res.status, 403)
  assertEquals(w.k8s.length, 0)
})

Deno.test('test run: a template that exists under the draft name and is not a draft is never overwritten', async () => {
  const w = draftWorld({ templates: new Map([['shop-dev/nightly-draft-ana', { metadata: { name: 'nightly-draft-ana', namespace: 'shop-dev', labels: { 'argocd.argoproj.io/instance': 'shop' } } }]]) })
  const res = await call(w, 'POST', '/drafts/shop-dev/test-run', { yaml: DRAFT_YAML })
  assertEquals(res.status, 409)
  assertEquals((await res.json()).error, 'not_a_draft')
  assert(w.k8s.every((c) => c.method === 'GET'))
  // The user's own earlier draft is updated in place.
  const mine = draftWorld({ templates: new Map([['shop-dev/nightly-draft-ana', { metadata: { name: 'nightly-draft-ana', namespace: 'shop-dev', labels: { 'adhar.io/workflow-draft': 'true' } } }]]) })
  assertEquals((await call(mine, 'POST', '/drafts/shop-dev/test-run', { yaml: DRAFT_YAML })).status, 200)
})

Deno.test('test run: a dry run asks admission and stores nothing, starts nothing, records nothing', async () => {
  const w = draftWorld()
  const res = await call(w, 'POST', '/drafts/shop-dev/test-run', { yaml: DRAFT_YAML, dryRun: true })
  assertEquals(res.status, 200)
  assertEquals((await res.json()).dryRun, true)
  const writes = w.k8s.filter((c) => c.method !== 'GET')
  assertEquals(writes.length, 1)
  assertEquals(new URLSearchParams(writes[0].query).get('dryRun'), 'All')
  assertEquals(w.records.length, 0)
})

Deno.test('test run: admission\'s refusal is passed on in its own words, and a refused run still names the saved draft', async () => {
  const denied = draftWorld({ k8sAnswer: (c) => (c.method === 'PATCH' ? j({ kind: 'Status', message: 'admission webhook "validate.kyverno.svc-fail" denied the request: adhar-workflow-reserved-serviceaccounts' }, 403) : undefined) })
  const res = await call(denied, 'POST', '/drafts/shop-dev/test-run', { yaml: DRAFT_YAML })
  assertEquals(res.status, 403)
  assertStringIncludes((await res.json()).detail, 'adhar-workflow-reserved-serviceaccounts')
  assert(!denied.k8s.some((c) => c.method === 'POST'), 'no run after a refused draft')
  assertEquals(denied.records.map((r) => r.outcome), ['failure'])

  const noRun = draftWorld({ k8sAnswer: (c) => (c.method === 'POST' ? j({ kind: 'Status', message: 'workflows.argoproj.io is forbidden' }, 403) : undefined) })
  const r2 = await call(noRun, 'POST', '/drafts/shop-dev/test-run', { yaml: DRAFT_YAML })
  assertEquals(r2.status, 403)
  const b2 = await r2.json()
  assertEquals(b2.draft.name, 'nightly-draft-ana')
  assertEquals(noRun.records[0].meta.step, 'submit')
})

Deno.test('test run: a body that is not one WorkflowTemplate for this namespace is 400 before any write', async () => {
  for (const body of [{}, { yaml: 'kind: Workflow\napiVersion: argoproj.io/v1alpha1\nmetadata: {name: x}\n' }, { yaml: DRAFT_YAML.replace('  name: nightly', '  name: nightly\n  namespace: shop-prod') }, { yaml: DRAFT_YAML, parameters: { 'bad name': 'x' } }]) {
    const w = draftWorld()
    const res = await call(w, 'POST', '/drafts/shop-dev/test-run', body)
    assertEquals(res.status, 400, JSON.stringify(body).slice(0, 60))
    assert(w.k8s.every((c) => c.method === 'GET'))
  }
  assertEquals((await call(draftWorld(), 'GET', '/drafts/shop-dev/test-run')).status, 405)
  assertEquals((await call(draftWorld(), 'POST', '/drafts/Shop_Dev/test-run', { yaml: DRAFT_YAML })).status, 400)
  assertEquals((await call(draftWorld({ signedIn: false }), 'POST', '/drafts/shop-dev/test-run', { yaml: DRAFT_YAML })).status, 401)
})
