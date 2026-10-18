import { assertEquals } from 'jsr:@std/assert@1'
import type { argocd, kargo } from '@adhar/api-clients'
import type { Entity } from './catalog.ts'
import { matchRun } from './catalog-pipelines.ts'
import { deriveDeployment, kargoEnvironments, repoUrlFromDeployment, unhealthyNodes, withRepoLink, workloadNamespace } from './catalog-deployment.ts'

const entity = (name: string, annotations: Record<string, string> = {}): Entity =>
  ({ kind: 'Component', metadata: { name, annotations }, spec: {} }) as unknown as Entity

// The real run the platform's app-ci trigger created for my-service.
const appCiRun = {
  metadata: {
    name: 'app-ci-my-service-rc82v',
    namespace: 'adhar-system',
    labels: { 'adhar.io/app': 'my-service', 'tekton.dev/pipeline': 'app-ci', 'triggers.tekton.dev/eventlistener': 'app-ci' },
  },
  spec: { params: [{ name: 'repo-name', value: 'my-service' }, { name: 'revision', value: '2796743' }] },
}

Deno.test('the app-ci run is matched to its service', () => {
  assertEquals(matchRun(appCiRun, entity('my-service'), 'https://gitea.cloud.adhar.io/adhar/my-service.git'), true)
  assertEquals(matchRun(appCiRun, entity('my-service')), true)
})

Deno.test('a shared pipeline name never hands one service another service\'s runs', () => {
  const other = entity('billing', { 'adhar.io/ci-pipeline': 'app-ci' })
  assertEquals(matchRun(appCiRun, other, 'https://gitea.x/adhar/billing.git'), false)
})

Deno.test('the repository name matches when the entity is named differently', () => {
  assertEquals(matchRun(appCiRun, entity('My Service API'.toLowerCase().replace(/ /g, '-')), 'https://gitea.x/adhar/my-service'), true)
})

Deno.test('unlabelled runs still match by repo-name or the trigger\'s name prefix', () => {
  const bare = { metadata: { name: 'app-pr-ci-cart-x1y2z' }, spec: { params: [] } }
  assertEquals(matchRun(bare, entity('cart')), true)
  assertEquals(matchRun({ metadata: { name: 'zzz' }, spec: { params: [{ name: 'repo-name', value: 'cart' }] } }, entity('cart')), true)
  assertEquals(matchRun({ metadata: { name: 'cartography-1' }, spec: {} }, entity('cart')), false)
})

const app = (resourceList: Array<{ kind: string; name: string; namespace?: string }>, dest = 'default') =>
  ({ spec: { destination: { namespace: dest } }, status: { resourceList } }) as unknown as argocd.Application

Deno.test('workloadNamespace follows the managed resources, not the destination', () => {
  assertEquals(
    workloadNamespace(app([
      { kind: 'Service', name: 'my-service', namespace: 'adhar-system' },
      { kind: 'Rollout', name: 'my-service', namespace: 'adhar-system' },
      { kind: 'HTTPRoute', name: 'my-service', namespace: 'adhar-system' },
    ])),
    'adhar-system',
  )
  assertEquals(workloadNamespace(app([{ kind: 'ConfigMap', name: 'x', namespace: 'shop' }, { kind: 'Deployment', name: 'api', namespace: 'shop-prod' }])), 'shop-prod')
  assertEquals(workloadNamespace(app([], 'payments')), 'payments')
})

Deno.test('unhealthyNodes puts the crashing pod before its owners and keeps the reason', () => {
  const nodes: argocd.ResourceNode[] = [
    { kind: 'Rollout', name: 'my-service', health: { status: 'Degraded', message: 'ProgressDeadlineExceeded: ReplicaSet "my-service-6f969b9759" has timed out progressing.' } },
    { kind: 'Pod', name: 'my-service-6f969b9759-sww9l', health: { status: 'Degraded' }, info: [{ name: 'Status Reason', value: 'CrashLoopBackOff' }] },
    { kind: 'Service', name: 'my-service', health: { status: 'Healthy' } },
    { kind: 'Cluster', name: 'my-service-db', health: { status: 'Progressing' } },
  ]
  const bad = unhealthyNodes(nodes)
  assertEquals(bad.map((n) => `${n.kind}:${n.reason}`), [
    'Pod:CrashLoopBackOff',
    'Rollout:ProgressDeadlineExceeded: ReplicaSet "my-service-6f969b9759" has timed out progressing.',
  ])
})

/* ─────────── environments are environments, not namespaces ─────────── */

const depApp = (
  name: string,
  resourceList: Array<{ kind: string; name: string; namespace?: string }>,
  dest = 'default',
  labels: Record<string, string> = {},
): argocd.Application =>
  ({
    metadata: { name, namespace: 'adhar-system', labels },
    spec: { destination: { namespace: dest } },
    status: { resourceList, sync: {}, health: {} },
  }) as unknown as argocd.Application

const derive = (apps: argocd.Application[], name = 'my-service') =>
  deriveDeployment(entity(name), apps, { isLoading: false, isError: false })

// The bug this guards: the environment key fell back to the workload NAMESPACE,
// so the Deployment tab drew `Adhar-system`, `Default` and `Adhar` as though
// they were stages of a promotion pipeline beside the real dev/test/prod.
// Every platform package runs in `adhar-system`, a scaffolded service's
// bootstrap app reports `default`, and `adhar` is the org's home namespace.
Deno.test('a namespace that is not an environment never becomes one', () => {
  for (const ns of ['adhar-system', 'default', 'adhar']) {
    const d = derive([depApp('my-service', [{ kind: 'Deployment', name: 'my-service', namespace: ns }], ns)])
    assertEquals(d.environments.map((e) => e.label), [], `namespace ${ns} was published as an environment`)
    assertEquals(d.unscoped.length, 1, `namespace ${ns} should leave the app unscoped`)
    assertEquals(d.apps.length, 1)
  }
})

Deno.test('the platform\'s own environment label is authoritative', () => {
  const d = derive([
    depApp('my-service', [{ kind: 'Deployment', name: 'my-service', namespace: 'adhar-system' }], 'adhar-system', {
      'adhar.io/environment': 'dev',
    }),
  ])
  assertEquals(d.environments.map((e) => e.key), ['dev'])
  assertEquals(d.environments.map((e) => e.label), ['Development'])
  assertEquals(d.unscoped.length, 0)
})

Deno.test('an environment in the app name or the namespace is still recognised', () => {
  const byName = derive([depApp('my-service-prod', [{ kind: 'Deployment', name: 'x', namespace: 'adhar-system' }])])
  assertEquals(byName.environments.map((e) => e.key), ['prod'])

  const byNamespace = derive([depApp('my-service', [{ kind: 'Deployment', name: 'x', namespace: 'shop-test' }], 'shop-test')])
  assertEquals(byNamespace.environments.map((e) => e.key), ['test'])
})

Deno.test('environments sort along the promotion chain, dev first', () => {
  const d = derive([
    depApp('my-service-dev', [{ kind: 'Deployment', name: 'x', namespace: 'adhar-system' }]),
    depApp('my-service-prod', [{ kind: 'Deployment', name: 'x', namespace: 'adhar-system' }]),
    depApp('my-service-test', [{ kind: 'Deployment', name: 'x', namespace: 'adhar-system' }]),
  ])
  assertEquals(d.environments.map((e) => e.key), ['dev', 'test', 'prod'])
  // The primary is the production app, not whichever was listed first.
  assertEquals(d.primary?.metadata.name, 'my-service-prod')
})

Deno.test('control-plane apps named <project>-<app>-<env> match the entity by their labels', () => {
  const cp = (env: string) => ({
    metadata: { name: `adhar-ngapp-${env}`, labels: { 'adhar.io/application': 'ngapp', 'adhar.io/environment': env } },
    spec: { destination: { namespace: env }, source: { repoURL: 'http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/ngapp.git' }, project: 'adhar' },
    status: { resourceList: [] },
  }) as unknown as argocd.Application
  const other = { metadata: { name: 'billing-dev', labels: { 'adhar.io/application': 'billing' } }, spec: { destination: { namespace: 'dev' } }, status: { resourceList: [] } } as unknown as argocd.Application
  const d = deriveDeployment(entity('ngapp'), [cp('dev'), cp('test'), cp('prod'), other], { isLoading: false, isError: false })
  assertEquals(d.apps.length, 3)
  assertEquals(d.environments.map((e) => e.key), ['dev', 'test', 'prod'])
  assertEquals(d.unmatched, false)
  assertEquals(repoUrlFromDeployment(d, 'https://gitea.test.adhar.io'), 'https://gitea.test.adhar.io/adhar/ngapp')
  const linked = withRepoLink(entity('ngapp'), repoUrlFromDeployment(d, 'https://gitea.test.adhar.io'))
  assertEquals(linked.metadata.links?.find((l) => l.icon === 'repo')?.url, 'https://gitea.test.adhar.io/adhar/ngapp')
})

Deno.test('an application shows its own Kargo chain, not the platform environments stages', () => {
  const cp = (env: string) => ({
    metadata: { name: `adhar-ngapp-${env}`, labels: { 'adhar.io/application': 'ngapp', 'adhar.io/environment': env } },
    spec: { destination: { namespace: env }, source: { repoURL: 'x' }, project: 'adhar' }, status: { resourceList: [] },
  }) as unknown as argocd.Application
  const d = deriveDeployment(entity('ngapp'), [cp('dev'), cp('test'), cp('prod')], { isLoading: false, isError: false })
  const stage = (name: string, labels: Record<string, string>, upstream: string[] = []) =>
    ({ name, project: 'adhar', labels, upstream }) as unknown as kargo.Stage
  const stages = [
    stage('dev', {}), stage('test', {}, ['dev']),
    stage('ngapp-dev', { 'adhar.io/application': 'ngapp', 'adhar.io/environment': 'dev' }),
    stage('ngapp-test', { 'adhar.io/application': 'ngapp', 'adhar.io/environment': 'test' }, ['ngapp-dev']),
  ]
  const envs = kargoEnvironments(stages, d)
  assertEquals(envs.map((e) => e.stage.name), ['ngapp-dev', 'ngapp-test'])
  assertEquals(envs.map((e) => e.app?.metadata.name), ['adhar-ngapp-dev', 'adhar-ngapp-test'])
})
