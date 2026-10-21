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
 *   - Synced + Healthy in a production environment, running a RELEASED image
 *     → `production`
 *   - otherwise the same in a pre-production one → `staging`
 *   - otherwise the declared lifecycle stands.
 *
 * "Released" matters because every environment overlay starts on the
 * template's `:latest` placeholder: test and prod came up Synced + Healthy on
 * it as soon as the first build existed, before anyone had promoted anything,
 * so health alone would have called an unpromoted app production. A Kargo
 * promotion pins a digest (`app@sha256:…`) or a release tag (`app:1.4.2`);
 * Argo CD reports the placeholder as `app:latest@sha256:…`.
 *
 * Two declarations always win, because they are decisions rather than
 * observations: `deprecated` (a team retiring the app), and a declared
 * `production` (it does not drop back to staging while a prod sync is in
 * flight or briefly Degraded).
 */

/** The fields of an Argo CD Application this needs. */
export interface DeployedApp {
  metadata: { labels?: Record<string, string> }
  status?: { sync?: { status?: string }; health?: { status?: string }; images?: string[] }
}

const PRODUCTION_ENVS = new Set(['prod', 'production', 'live'])
const PRE_PRODUCTION_ENVS = new Set(['test', 'staging', 'stage', 'qa', 'uat', 'preprod'])

/** Whether an image reference is a release rather than the `:latest` placeholder. */
export function isReleasedImage(ref: string): boolean {
  const [name, digest] = ref.split('@', 2)
  const slash = name.lastIndexOf('/')
  const colon = name.lastIndexOf(':')
  const tag = colon > slash ? name.slice(colon + 1) : ''
  if (tag === 'latest') return false
  return tag !== '' || Boolean(digest)
}

function running(app: DeployedApp): boolean {
  const images = app.status?.images ?? []
  return app.status?.sync?.status === 'Synced' &&
    app.status?.health?.status === 'Healthy' &&
    images.length > 0 &&
    images.every(isReleasedImage)
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
