import { assert, assertEquals } from 'jsr:@std/assert@^1'
import type { argoRollouts } from '@adhar/api-clients'
import {
  analysisRefs,
  type ArgoAppLike,
  attentionNote,
  byAppAttention,
  envFromNamespace,
  envOptions,
  envOrder,
  filterApps,
  groupRollouts,
  identifyRollout,
  parseImage,
  summariseApps,
} from './rollout-apps.ts'

function rollout(over: {
  name?: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  templateLabels?: Record<string, string>
  image?: string
  status?: Record<string, unknown>
} = {}): argoRollouts.Rollout {
  return {
    metadata: {
      name: over.name ?? 'checkout',
      namespace: over.namespace ?? 'adhar-dev',
      creationTimestamp: '2026-10-01T00:00:00Z',
      labels: over.labels,
      annotations: over.annotations,
    },
    spec: {
      replicas: 3,
      strategy: { canary: { steps: [{ setWeight: 20 }, { pause: {} }, { setWeight: 60 }] } },
      template: {
        metadata: { labels: over.templateLabels ?? {} },
        spec: { containers: [{ name: 'app', image: over.image ?? 'harbor.local/adhar/checkout:1.4.0' }] },
      },
    },
    status: {
      phase: 'Healthy',
      currentStepIndex: 3,
      replicas: 3,
      updatedReplicas: 3,
      readyReplicas: 3,
      availableReplicas: 3,
      ...over.status,
    },
  } as unknown as argoRollouts.Rollout
}

Deno.test('envOrder: dev → test → prod, unknown between pre-prod and prod', () => {
  const sorted = ['prod', 'custom', 'test', 'dev', 'staging'].sort((a, b) => envOrder(a) - envOrder(b))
  assertEquals(sorted, ['dev', 'test', 'staging', 'custom', 'prod'])
})

Deno.test('envFromNamespace: project prefix, else a known env suffix', () => {
  assertEquals(envFromNamespace('adhar-prod', 'adhar'), { project: 'adhar', env: 'prod' })
  assertEquals(envFromNamespace('shop-test'), { project: 'shop', env: 'test' })
  assertEquals(envFromNamespace('adhar-system'), { project: undefined })
})

Deno.test('parseImage: tag, digest and registry ports', () => {
  assertEquals(parseImage('app', 'harbor.local:5000/adhar/api:1.2.3').tag, '1.2.3')
  assertEquals(parseImage('app', 'harbor.local:5000/adhar/api:1.2.3').repo, 'harbor.local:5000/adhar/api')
  assertEquals(parseImage('app', 'nginx').tag, 'latest')
  assertEquals(parseImage('app', 'r/api@sha256:abcdef0123456789aa').tag, '@abcdef012345')
})

Deno.test('identifyRollout: labels on the Rollout win', () => {
  const id = identifyRollout(rollout({
    namespace: 'adhar-test',
    labels: { 'adhar.io/application': 'shop', 'adhar.io/project': 'adhar', 'adhar.io/environment': 'test' },
  }))
  assertEquals(id, { app: 'shop', project: 'adhar', env: 'test', envLabelled: true, argoApp: undefined })
})

Deno.test('identifyRollout: pod-template labels, then the owning Argo CD app', () => {
  assertEquals(identifyRollout(rollout({ templateLabels: { 'adhar.io/application': 'shop' } })).app, 'shop')

  const apps: ArgoAppLike[] = [{
    metadata: { name: 'adhar-shop-prod', labels: { 'adhar.io/application': 'shop', 'adhar.io/project': 'adhar', 'adhar.io/environment': 'prod' } },
    spec: { project: 'adhar' },
  }]
  const tracked = identifyRollout(
    rollout({ name: 'shop-web', namespace: 'adhar-prod', annotations: { 'argocd.argoproj.io/tracking-id': 'adhar-shop-prod:argoproj.io/Rollout:adhar-prod/shop-web' } }),
    apps,
  )
  assertEquals(tracked, { app: 'shop', project: 'adhar', env: 'prod', envLabelled: true, argoApp: 'adhar-shop-prod' })

  // Found through the app's managed-resource list when nothing is annotated.
  const listed = identifyRollout(rollout({ name: 'shop-web', namespace: 'adhar-prod' }), [{
    ...apps[0],
    status: { resourceList: [{ kind: 'Rollout', name: 'shop-web', namespace: 'adhar-prod' }] },
  }])
  assertEquals(listed.argoApp, 'adhar-shop-prod')
})

Deno.test('identifyRollout: falls back to the Rollout name and the namespace', () => {
  assertEquals(identifyRollout(rollout({ name: 'gateway', namespace: 'adhar-system' })), {
    app: 'gateway',
    project: undefined,
    env: 'adhar-system',
    envLabelled: false,
    argoApp: undefined,
  })
})

const threeEnvs = () => [
  rollout({ namespace: 'adhar-prod', image: 'r/checkout:1.3.0', annotations: { 'rollout.argoproj.io/revision': '7' } }),
  rollout({
    namespace: 'adhar-test',
    image: 'r/checkout:1.4.0',
    status: { phase: 'Paused', currentStepIndex: 1, updatedReplicas: 1, pauseConditions: [{ reason: 'CanaryPauseStep' }] },
  }),
  rollout({ namespace: 'adhar-dev', image: 'r/checkout:1.4.0' }),
  rollout({ name: 'gateway', namespace: 'adhar-system', image: 'r/gw:2' }),
]

Deno.test('groupRollouts: one entry per app, environments dev → test → prod', () => {
  const apps = groupRollouts(threeEnvs()).sort(byAppAttention)
  assertEquals(apps.length, 2)
  const checkout = apps.find((a) => a.app === 'checkout')!
  assertEquals(checkout.key, 'adhar/checkout')
  assertEquals(checkout.envs.map((e) => e.env), ['dev', 'test', 'prod'])
  assertEquals(checkout.envs.map((e) => e.tag), ['1.4.0', '1.4.0', '1.3.0'])
  assertEquals(checkout.envs[2].revision, 7)
  assertEquals(checkout.phase, 'Paused')
  assertEquals(checkout.strategy, 'canary')
  // The paused app outranks the healthy platform rollout.
  assertEquals(apps[0].app, 'checkout')
  assertEquals(attentionNote(checkout.envs[1]), 'Waiting for promotion')
})

Deno.test('groupRollouts: an abort outranks every phase', () => {
  const apps = groupRollouts([
    rollout({ name: 'a', namespace: 'x-dev', status: { phase: 'Degraded' } }),
    rollout({ name: 'b', namespace: 'x-dev', status: { phase: 'Paused', abort: true } }),
  ]).sort(byAppAttention)
  assertEquals(apps.map((a) => a.app), ['b', 'a'])
  assert(apps[0].aborted)
})

Deno.test('summariseApps + filterApps: apps and environments by phase', () => {
  const apps = groupRollouts(threeEnvs())
  const s = summariseApps(apps)
  assertEquals(s.apps, 2)
  assertEquals(s.envs, 4)
  assertEquals(s.by.Paused, { apps: 1, envs: 1 })
  assertEquals(s.by.Healthy, { apps: 2, envs: 3 })

  assertEquals(filterApps(apps, { phase: 'Paused' }).map((a) => a.app), ['checkout'])
  assertEquals(filterApps(apps, { env: 'prod' }).map((a) => a.app), ['checkout'])
  assertEquals(filterApps(apps, { project: 'adhar-system' }).map((a) => a.app), ['gateway'])
  assertEquals(filterApps(apps, { query: '1.3.0' }).map((a) => a.app), ['checkout'])
  // Phase AND env: the paused env is test, not prod.
  assertEquals(filterApps(apps, { phase: 'Paused', env: 'prod' }), [])
  // An unrecognised env (a platform namespace) sorts before production.
  assertEquals(envOptions(apps), ['dev', 'test', 'adhar-system', 'prod'])
})

Deno.test('analysisRefs: the analysis runs the rollout points at', () => {
  assertEquals(
    analysisRefs({
      canary: {
        currentStepAnalysisRunStatus: { name: 'checkout-abc-2', status: 'Running' },
        currentBackgroundAnalysisRunStatus: { name: 'checkout-abc-bg', status: 'Successful', message: 'ok' },
      },
    }),
    [
      { kind: 'step', name: 'checkout-abc-2', status: 'Running', message: undefined },
      { kind: 'background', name: 'checkout-abc-bg', status: 'Successful', message: 'ok' },
    ],
  )
  assertEquals(analysisRefs(undefined), [])
})
