import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert'
import type { NotificationDoc } from '../notify.ts'
import { type Backends, collectEvidence, errorSignature, groupErrors, type LinkBases, type LokiStream, type PromSample } from './evidence.ts'
import { DEFAULT_SUPPORT_CONFIG } from './config.ts'
import type { IncidentRef } from './classify.ts'
import { descriptionHtml } from './render.ts'

/**
 * The collector against a fake cluster built from objects, log lines and
 * query results copied (trimmed) from the live DigitalOcean cluster on
 * 2026-10-22, where `gateway-service` (dev) was crash-looping on a YAML error
 * in its Spring config. The rule under test: every backend can fail on its own
 * and the evidence — and therefore the ticket — still comes out.
 */

const NOW = Date.parse('2026-10-22T16:20:00Z')
const lim = { ...DEFAULT_SUPPORT_CONFIG.evidence, queryTimeoutMs: 1_000 }
const links: LinkBases = {
  console: 'https://console.example',
  grafana: 'https://grafana.example',
  argocd: 'https://argocd.example',
  kargo: 'https://kargo.example',
  ds: { prometheus: 'prometheus', loki: 'loki', tempo: 'tempo' },
}

const ref: IncidentRef = {
  family: 'argocd',
  source: 'argocd',
  incidentId: 'argocd:adhar-system/adhar-gateway-service-dev',
  namespace: 'adhar-system',
  name: 'adhar-gateway-service-dev',
  objectKind: 'Application',
  app: 'gateway-service',
  env: 'dev',
}
const doc: NotificationDoc = {
  kind: 'error',
  source: 'gitops',
  severity: 'high',
  title: 'gateway-service (dev) is degraded',
  href: '/deliver?section=apps&app=adhar-gateway-service-dev',
  key: 'argocd:adhar-system/adhar-gateway-service-dev:Degraded/Synced',
  target: { type: 'application', id: 'adhar-gateway-service-dev', label: 'gateway-service (dev)' },
  prompt: 'Argo CD application adhar-gateway-service-dev is Degraded. Diagnose why and tell me what to do about it.',
  at: '2026-10-22T16:19:00Z',
}

const ARGO = {
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Application',
  metadata: { name: 'adhar-gateway-service-dev', namespace: 'adhar-system', labels: { 'adhar.io/application': 'gateway-service', 'adhar.io/environment': 'dev', 'adhar.io/project': 'adhar' } },
  spec: { project: 'adhar', destination: { namespace: 'dev' }, source: { repoURL: 'http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/gateway-service.git', path: '.', targetRevision: 'stage/dev' } },
  status: {
    health: { status: 'Degraded' },
    sync: { status: 'Synced', revision: '5063d91e7f9b0c43f6ce06eaf258e99e36f47c1a' },
    resources: [{ kind: 'Rollout', name: 'gateway-service', namespace: 'dev' }, { kind: 'Service', name: 'gateway-service', namespace: 'dev' }],
    summary: { images: ['harbor-core.adhar-system.svc.cluster.local/library/gateway-service@sha256:ea742b3f6cc1432a8ed0ae54722040ab8ea89098d767399c1cc6e1cdbd638813'] },
    operationState: {
      phase: 'Succeeded',
      message: 'successfully synced (all tasks run)',
      startedAt: '2026-10-22T13:23:32Z',
      finishedAt: '2026-10-22T13:23:35Z',
      operation: { initiatedBy: { automated: true, username: 'kargo-controller' }, info: [{ name: 'kargo.akuity.io/promotion', value: 'dev.01m5hwfm0eaeekq9vsxexvzbhb.58d96bb' }] },
    },
  },
}
const ROLLOUT = { kind: 'Rollout', metadata: { name: 'gateway-service', namespace: 'dev' }, spec: { selector: { matchLabels: { app: 'gateway-service' } } } }
const pod = (name: string, restarts: number) => ({
  kind: 'Pod',
  metadata: { name, namespace: 'dev', labels: { app: 'gateway-service' } },
  spec: { nodeName: 'adhar-adhar-workers-8' },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'False' }],
    containerStatuses: [{
      name: 'app',
      ready: false,
      restartCount: restarts,
      state: { waiting: { reason: 'CrashLoopBackOff' } },
      lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: '2026-10-22T16:16:38Z' } },
    }],
  },
})
const PODS = { items: [pod('gateway-service-689ffd8cf6-7kj2j', 36), pod('gateway-service-5cd88799d8-68cfn', 36)] }
const EVENTS = {
  items: [{
    type: 'Warning',
    reason: 'BackOff',
    count: 197,
    lastTimestamp: '2026-10-22T16:18:19Z',
    message: 'Back-off restarting failed container app in pod gateway-service-689ffd8cf6-7kj2j_dev',
    involvedObject: { kind: 'Pod', name: 'gateway-service-689ffd8cf6-7kj2j' },
  }],
}
const PROMOTION = {
  items: [{
    metadata: { name: 'dev.01m5hwfm0eaeekq9vsxexvzbhb.58d96bb', namespace: 'adhar' },
    spec: { stage: 'dev' },
    status: { phase: 'Succeeded', freight: { name: '58d96bbc80a03f2f8be0c73cb97fe8cfe54b5769', images: [{ repoURL: 'harbor-core.adhar-system.svc.cluster.local/library/gateway-service', tag: 'dabceacceaaa1c198296c1b8b5e0b930ebb37643' }] } },
  }],
}
const STAGE = { metadata: { name: 'dev', namespace: 'adhar' }, status: { health: { status: 'Unhealthy', issues: ['Argo CD Application "adhar-gateway-service-dev" in namespace "adhar-system" has health state "Degraded"'] }, freightHistory: [{ id: 'c1', items: {} }] } }

const ns = (ms: number) => `${ms}000000`
const ERRORS: LokiStream[] = [
  { stream: { pod: 'gateway-service-5cd88799d8-68cfn' }, values: [[ns(NOW - 100_000), '16:16:38.066 [main] ERROR org.springframework.boot.SpringApplication -- Application run failed\n'], [ns(NOW - 400_000), '16:11:14.354 [main] ERROR org.springframework.boot.SpringApplication -- Application run failed\n']] },
  { stream: { pod: 'gateway-service-689ffd8cf6-7kj2j' }, values: [[ns(NOW - 200_000), '16:14:41.968 [main] ERROR org.springframework.boot.SpringApplication -- Application run failed\n'], [ns(NOW - 201_000), 'Picked up JAVA_TOOL_OPTIONS: -XX:+UseZGC -XX:+ExitOnOutOfMemoryError -Xmx1595769K']] },
]
const CONTEXT: LokiStream[] = [{
  stream: { pod: 'gateway-service-5cd88799d8-68cfn' },
  values: [
    [ns(NOW - 99_000), 'while scanning an alias'],
    [ns(NOW - 99_100), " in 'reader', line 151, column 22:"],
    [ns(NOW - 99_200), '        allowed-origins: *'],
    [ns(NOW - 99_300), 'unexpected character found'],
    [ns(NOW - 100_000), '16:16:38.066 [main] ERROR org.springframework.boot.SpringApplication -- Application run failed'],
  ],
}]
const TAIL: LokiStream[] = [{
  stream: { pod: 'gateway-service-5cd88799d8-68cfn' },
  values: [[ns(NOW - 90_000), '-           Object Monitors (reserved=1400, committed=1400)'], [ns(NOW - 91_000), ''], [ns(NOW - 92_000), 'connecting with password=hunter22 to cache']],
}]
const PROM: Record<string, PromSample[]> = {
  restarts: [{ metric: { pod: 'gateway-service-5cd88799d8-68cfn' }, value: [NOW / 1000, '12.100840336134453'] }],
  reason: [{ metric: { pod: 'gateway-service-5cd88799d8-68cfn', reason: 'Error' }, value: [NOW / 1000, '1'] }],
  limit: [{ metric: { pod: 'gateway-service-5cd88799d8-68cfn' }, value: [NOW / 1000, '2147483648'] }],
}

interface FakeOpts { fail?: Partial<Record<keyof Backends, boolean>>; hang?: keyof Backends; lokiEmpty?: boolean }

function fake(opts: FakeOpts = {}): Backends & { calls: string[] } {
  const calls: string[] = []
  const guard = (k: keyof Backends) => {
    if (opts.hang === k) return new Promise<never>(() => {})
    if (opts.fail?.[k]) return Promise.reject(new Error(`${k} is down`))
    return null
  }
  return {
    calls,
    k8s: (path, search) => {
      calls.push(`k8s ${path} ${JSON.stringify(search ?? {})}`)
      const g = guard('k8s')
      if (g) return g
      if (path.endsWith('/applications/adhar-gateway-service-dev')) return Promise.resolve(ARGO)
      if (path.endsWith('/rollouts/gateway-service')) return Promise.resolve(ROLLOUT)
      if (path === '/api/v1/namespaces/dev/pods') return Promise.resolve(search?.labelSelector === 'app=gateway-service' ? PODS : { items: [] })
      if (path.endsWith('/events')) return Promise.resolve(search?.fieldSelector?.includes('7kj2j') ? EVENTS : { items: [] })
      if (path === '/apis/kargo.akuity.io/v1alpha1/promotions') return Promise.resolve(PROMOTION)
      if (path.endsWith('/stages/dev')) return Promise.resolve(STAGE)
      return Promise.reject(new Error(`404 ${path}`))
    },
    k8sText: (path, search) => {
      calls.push(`log ${path} ${JSON.stringify(search ?? {})}`)
      const g = guard('k8sText')
      if (g) return g
      return Promise.resolve(search?.previous
        ? 'Starting GatewayApplication\n16:16:38.066 [main] ERROR o.s.boot.SpringApplication -- Application run failed\nwhile scanning an alias\n        allowed-origins: *\n'
        : 'Starting GatewayApplication\n')
    },
    loki: (q, _s, _e, _l, dir) => {
      calls.push(`loki ${dir ?? 'backward'} ${q}`)
      const g = guard('loki')
      if (g) return g
      if (opts.lokiEmpty) return Promise.resolve([])
      if (dir === 'forward') return Promise.resolve(CONTEXT)
      return Promise.resolve(q.includes('|~') ? ERRORS : TAIL)
    },
    prom: (q) => {
      calls.push(`prom ${q}`)
      const g = guard('prom')
      if (g) return g
      if (q.includes('restarts_total')) return Promise.resolve(PROM.restarts)
      if (q.includes('last_terminated_reason')) return Promise.resolve(PROM.reason)
      if (q.includes('resource_limits')) return Promise.resolve(PROM.limit)
      return Promise.resolve([])
    },
    tempo: (q) => {
      calls.push(`tempo ${q}`)
      const g = guard('tempo')
      return g ?? Promise.resolve([])
    },
  }
}

Deno.test('evidence: the full picture for a crash-looping app', async () => {
  const b = fake()
  const ev = await collectEvidence(ref, doc, lim, b, links, NOW)
  assertEquals(ev.subject.workloadNamespace, 'dev')
  assertEquals(ev.subject.project, 'adhar')
  assertEquals(ev.subject.pods.length, 2)
  assertEquals(ev.k8s.status, 'ok')
  assertEquals(ev.k8s.data?.pods[0].containers[0].lastTermination?.reason, 'Error')
  assertEquals(ev.k8s.data?.events[0].reason, 'BackOff')

  // Logs: the three "Application run failed" lines are ONE error with a count,
  // the JVM option echo is not an error, and the cause that FOLLOWS the error
  // line is carried as context.
  assertEquals(ev.logs.data?.source, 'loki')
  const errs = ev.logs.data!.errorLines
  assertStringIncludes(errs[0], 'Application run failed (×3 across 2 pods)')
  assert(errs.some((l) => l.includes('allowed-origins: *')), 'the YAML cause must follow the error')
  assert(!errs.some((l) => l.includes('JAVA_TOOL_OPTIONS')))
  // Secrets in the tail were redacted; blank lines dropped.
  assert(!ev.logs.data!.lines.some((l) => l.includes('hunter22')))
  assert(!ev.logs.data!.lines.some((l) => /\] $/.test(l)))

  assertEquals(ev.metrics.status, 'ok')
  const restarts = ev.metrics.data!.results.find((m) => m.title.startsWith('Container restarts'))!
  assertEquals(restarts.values[0].value, 12.100840336134453)
  assertStringIncludes(restarts.exploreUrl!, 'https://grafana.example/explore?schemaVersion=1')
  assertStringIncludes(decodeURIComponent(restarts.exploreUrl!), 'gateway-service-689ffd8cf6-7kj2j|gateway-service-5cd88799d8-68cfn')

  assertEquals(ev.traces.status, 'empty')
  assertStringIncludes(ev.traces.note!, 'not appear to be instrumented')

  assertEquals(ev.delivery.data?.argo?.lastOperation?.promotion, 'dev.01m5hwfm0eaeekq9vsxexvzbhb.58d96bb')
  assertEquals(ev.delivery.data?.kargo?.promotion?.stage, 'dev')
  assertEquals(ev.delivery.data?.kargo?.verification?.health, 'Unhealthy')
  assertEquals(ev.links.argocd, 'https://argocd.example/applications/adhar-system/adhar-gateway-service-dev')
  assertEquals(ev.links.kargo, 'https://kargo.example/project/adhar/stage/dev')
  assertEquals(ev.links.console, 'https://console.example/deliver?section=apps&app=adhar-gateway-service-dev')

  const html = descriptionHtml(doc, ref, ev, { maxSectionBytes: lim.maxSectionBytes })
  assertStringIncludes(html, 'allowed-origins: *')
  assertStringIncludes(html, '2.00 GiB')
})

for (const backend of ['loki', 'prom', 'tempo', 'k8s'] as const) {
  Deno.test(`evidence: ${backend} failing costs its own section, never the ticket`, async () => {
    const ev = await collectEvidence(ref, doc, lim, fake({ fail: { [backend]: true } }), links, NOW)
    const html = descriptionHtml(doc, ref, ev, { maxSectionBytes: lim.maxSectionBytes })
    assertStringIncludes(html, 'gateway-service (dev) is degraded')
    switch (backend) {
      case 'loki':
        // Falls back to the apiserver's current + previous container logs.
        assertEquals(ev.logs.data?.source, 'apiserver')
        assertStringIncludes(ev.logs.note!, 'Loki unavailable (loki is down)')
        assert(ev.logs.data!.errorLines.some((l) => l.includes('(previous)') && l.includes('Application run failed')))
        assertEquals(ev.metrics.status, 'ok')
        break
      case 'prom':
        assertEquals(ev.metrics.status, 'error')
        assertStringIncludes(ev.metrics.note!, 'Prometheus unavailable')
        assertEquals(ev.logs.status, 'ok')
        break
      case 'tempo':
        assertEquals(ev.traces.status, 'error')
        assertStringIncludes(ev.traces.note!, 'Tempo unavailable')
        assertEquals(ev.logs.status, 'ok')
        break
      case 'k8s':
        // Without the apiserver nothing names the workload: every section says so.
        assertEquals(ev.k8s.status, 'empty')
        assertEquals(ev.logs.status, 'skipped')
        assertEquals(ev.delivery.status, 'skipped')
        assertStringIncludes(html, 'Argo CD application adhar-system/adhar-gateway-service-dev could not be read')
        break
    }
  })
}

Deno.test('evidence: a backend that hangs is cut off at the deadline', async () => {
  const t0 = Date.now()
  const ev = await collectEvidence(ref, doc, lim, fake({ hang: 'tempo' }), links, NOW)
  assert(Date.now() - t0 < 5_000)
  assertEquals(ev.traces.status, 'error')
  assertStringIncludes(ev.traces.note!, 'timed out after 1000 ms')
  assertEquals(ev.logs.status, 'ok')
})

Deno.test('evidence: Loki with nothing in the window falls back to previous-container logs', async () => {
  const b = fake({ lokiEmpty: true })
  const ev = await collectEvidence(ref, doc, lim, b, links, NOW)
  assertEquals(ev.logs.data?.source, 'apiserver')
  assert(b.calls.some((c) => c.startsWith('log ') && c.includes('"previous":"true"')))
  assert(ev.logs.data!.errorLines.some((l) => l.includes('allowed-origins')))
})

Deno.test('error signatures ignore timestamps, ids and numbers', () => {
  assertEquals(
    errorSignature('16:16:38.066 [main] ERROR x -- failed id=3fa85f64'),
    errorSignature('09:01:02.111 [main] ERROR x -- failed id=9bc0aa12'),
  )
  const g = groupErrors([
    { ts: '3', line: '12:00:01 ERROR boom 1', pod: 'a' },
    { ts: '2', line: '12:00:00 ERROR boom 2', pod: 'b' },
    { ts: '1', line: 'Picked up JAVA_TOOL_OPTIONS: -XX:+ExitOnOutOfMemoryError', pod: 'a' },
  ])
  assertEquals(g.length, 1)
  assertEquals(g[0].count, 2)
  assertEquals(g[0].pods.size, 2)
})
