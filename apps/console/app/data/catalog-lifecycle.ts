import type { Entity, Lifecycle } from './catalog.ts'

/**
 * A custom application's lifecycle follows where it is actually running.
 *
 * Templates seed `adhar.io/lifecycle: experimental` into catalog-info.yaml and
 * nothing ever moved it on, so an application serving production traffic was
 * still listed as experimental (2026-10-21). The catalog now derives the stage
 * from the Argo CD applications the control plane composes for it — one per
 * environment, labelled `adhar.io/application` and `adhar.io/environment`:
 *
 *   - Synced + Healthy in a production environment → `production`
 *   - otherwise Synced + Healthy in a pre-production one → `staging`
 *   - otherwise the declared lifecycle stands.
 *
 * Two declarations always win, because they are decisions rather than
 * observations: `deprecated` (a team retiring the app), and a declared
 * `production` (it does not drop back to staging while a prod sync is in
 * flight or briefly Degraded).
 */

/** The fields of an Argo CD Application this needs. */
export interface DeployedApp {
  metadata: { labels?: Record<string, string> }
  status?: { sync?: { status?: string }; health?: { status?: string } }
}

const PRODUCTION_ENVS = new Set(['prod', 'production', 'live'])
const PRE_PRODUCTION_ENVS = new Set(['test', 'staging', 'stage', 'qa', 'uat', 'preprod'])

function running(app: DeployedApp): boolean {
  return app.status?.sync?.status === 'Synced' && app.status?.health?.status === 'Healthy'
}

/** The lifecycle an application has earned from its deployments. */
export function deployedLifecycle(
  name: string,
  declared: Lifecycle | undefined,
  apps: readonly DeployedApp[],
): Lifecycle | undefined {
  if (declared === 'deprecated') return declared
  const own = apps.filter(
    (a) => (a.metadata.labels?.['adhar.io/application'] ?? '').toLowerCase() === name.toLowerCase(),
  )
  const envs = new Set(
    own.filter(running).map((a) => (a.metadata.labels?.['adhar.io/environment'] ?? '').toLowerCase()),
  )
  if ([...envs].some((e) => PRODUCTION_ENVS.has(e))) return 'production'
  if (declared === 'production') return declared
  if ([...envs].some((e) => PRE_PRODUCTION_ENVS.has(e))) return 'staging'
  return declared
}

/** Apply {@link deployedLifecycle} to every Component; other kinds pass through. */
export function withDeployedLifecycle(entities: readonly Entity[], apps: readonly DeployedApp[]): Entity[] {
  if (apps.length === 0) return [...entities]
  return entities.map((e) => {
    if (e.kind !== 'Component') return e
    const lifecycle = deployedLifecycle(e.metadata.name, e.spec.lifecycle, apps)
    return lifecycle === e.spec.lifecycle ? e : { ...e, spec: { ...e.spec, lifecycle } }
  })
}
