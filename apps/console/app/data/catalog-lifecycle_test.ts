import { assertEquals } from 'jsr:@std/assert'
import { deployedLifecycle, type DeployedApp, withDeployedLifecycle } from './catalog-lifecycle.ts'
import type { Entity } from './catalog.ts'

const app = (application: string, env: string, sync: string, health: string): DeployedApp => ({
  metadata: { labels: { 'adhar.io/application': application, 'adhar.io/environment': env } },
  status: { sync: { status: sync }, health: { status: health } },
})

// Templates seed `experimental`; an app serving prod was listed that way for good.
Deno.test('an app running in prod is in production', () => {
  const apps = [
    app('reactapp', 'dev', 'Synced', 'Healthy'),
    app('reactapp', 'test', 'Synced', 'Healthy'),
    app('reactapp', 'prod', 'Synced', 'Healthy'),
  ]
  assertEquals(deployedLifecycle('reactapp', 'experimental', apps), 'production')
})

Deno.test('a prod deployment that is not yet healthy does not count', () => {
  const apps = [app('reactapp', 'test', 'Synced', 'Healthy'), app('reactapp', 'prod', 'Synced', 'Degraded')]
  assertEquals(deployedLifecycle('reactapp', 'experimental', apps), 'staging')
  assertEquals(
    deployedLifecycle('reactapp', 'experimental', [app('reactapp', 'prod', 'OutOfSync', 'Healthy')]),
    'experimental',
  )
})

Deno.test('dev alone leaves the declared lifecycle', () => {
  assertEquals(deployedLifecycle('reactapp', 'experimental', [app('reactapp', 'dev', 'Synced', 'Healthy')]), 'experimental')
  assertEquals(deployedLifecycle('reactapp', undefined, []), undefined)
})

Deno.test('deprecated and a declared production are decisions, not overridden', () => {
  const prod = [app('reactapp', 'prod', 'Synced', 'Healthy')]
  assertEquals(deployedLifecycle('reactapp', 'deprecated', prod), 'deprecated')
  assertEquals(deployedLifecycle('reactapp', 'production', [app('reactapp', 'prod', 'Synced', 'Degraded')]), 'production')
  // A prod sync in flight must not demote it to staging because test is healthy.
  assertEquals(
    deployedLifecycle('reactapp', 'production', [
      app('reactapp', 'test', 'Synced', 'Healthy'),
      app('reactapp', 'prod', 'Synced', 'Progressing'),
    ]),
    'production',
  )
})

Deno.test("another app's deployments do not count, and names compare case-insensitively", () => {
  const apps = [app('ngapp', 'prod', 'Synced', 'Healthy'), app('Cart', 'prod', 'Synced', 'Healthy')]
  assertEquals(deployedLifecycle('reactapp', 'experimental', apps), 'experimental')
  assertEquals(deployedLifecycle('cart', 'experimental', apps), 'production')
})

Deno.test('only Components change', () => {
  const comp = { kind: 'Component', metadata: { name: 'reactapp' }, spec: { lifecycle: 'experimental' } } as Entity
  const sys = { kind: 'System', metadata: { name: 'reactapp' }, spec: { lifecycle: 'experimental' } } as Entity
  const [c, s] = withDeployedLifecycle([comp, sys], [app('reactapp', 'prod', 'Synced', 'Healthy')])
  assertEquals(c.spec.lifecycle, 'production')
  assertEquals(s.spec.lifecycle, 'experimental')
})
