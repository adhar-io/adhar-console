import { assertEquals } from 'jsr:@std/assert@1'
import type { argocd } from '@adhar/api-clients'
import type { Entity } from './catalog.ts'
import { matchRun } from './catalog-pipelines.ts'
import { unhealthyNodes, workloadNamespace } from './catalog-deployment.ts'

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
