import { assertEquals } from 'jsr:@std/assert'
import { isPlatformRepo, isSystemNamespace, PLATFORM_REPOS } from './catalog-live.ts'

/**
 * Every repo in the Gitea org used to become a catalog Component, and the
 * platform keeps its own repos in that org — so scaffolding ONE service made six
 * appear next to it. The k8s half of the live catalog always filtered its
 * equivalent (system namespaces); the Gitea half had no counterpart.
 */
Deno.test('platform repos are not catalog services', () => {
  for (const name of ['packages', 'environments', 'templates', 'adhar-templates', 'adhar-ui', 'adhar-kit']) {
    assertEquals(isPlatformRepo(name), true, `${name} is platform infrastructure, not a service`)
  }
})

Deno.test('a team repo is a catalog service', () => {
  for (const name of ['cart', 'checkout-api', 'my-adhar-thing', 'packages-service', 'ui']) {
    assertEquals(isPlatformRepo(name), false, `${name} is the team's software and must still list`)
  }
})

/** Gitea repo names are case-insensitive for our purposes; a missing name is not a service. */
Deno.test('matching tolerates case and a missing name', () => {
  assertEquals(isPlatformRepo('Packages'), true)
  assertEquals(isPlatformRepo('ADHAR-UI'), true)
  assertEquals(isPlatformRepo(undefined), false)
  assertEquals(isPlatformRepo(''), false)
})

/**
 * Kept in lockstep with the CEL interceptor in
 * packages/application/adhar-supply-chain/manifests/70-app-ci.yaml, which skips
 * exactly these repos: a push to one is platform traffic, not an app build.
 */
Deno.test('the set matches the supply-chain pipeline exclusions', () => {
  assertEquals(
    [...PLATFORM_REPOS].sort(),
    ['adhar-kit', 'adhar-templates', 'adhar-ui', 'environments', 'packages', 'templates'],
  )
})

/**
 * `csi-gce-pd-controller` appeared in the Service Catalog on a GCP cluster that
 * nobody had deployed anything to. It is Google's persistent-disk CSI driver,
 * installed by `adhar up`'s cloud-integration step into `gce-pd-csi-driver` — a
 * namespace that is neither `kube-*` nor `*-system`, so the filter waved it
 * straight through. Every cloud provider had the same hole.
 */
Deno.test('cloud provider CSI and CCM namespaces are not user namespaces', () => {
  const addons = [
    'gce-pd-csi-driver',
    'aws-ebs-csi-driver',
    'aws-cloud-controller-manager',
    'azuredisk-csi-driver',
  ]
  for (const ns of addons) {
    assertEquals(isSystemNamespace(ns), true, `${ns} is a cloud addon, not the team's software`)
  }
})

/** A provider added later must not reintroduce the bug, so the rule is conventional. */
Deno.test('an unlisted cloud addon is still filtered by convention', () => {
  assertEquals(isSystemNamespace('oracle-block-csi-driver'), true)
  assertEquals(isSystemNamespace('hetzner-cloud-controller-manager'), true)
})

/** Kargo's chart namespaces: one ends in `-resources`, so the `*-system` rule misses it. */
Deno.test('kargo platform namespaces are filtered', () => {
  const kargo = [
    'kargo-cluster-secrets',
    'kargo-shared-resources',
    'kargo-system-resources',
    'adhar-environments',
  ]
  for (const ns of kargo) {
    assertEquals(isSystemNamespace(ns), true, `${ns} is release plumbing, not a service`)
  }
})

/** Data-plane vclusters are registered clusters, not services inside this one. */
Deno.test('data-plane vcluster namespaces are filtered', () => {
  assertEquals(isSystemNamespace('dp-staging'), true)
})

/**
 * The filter exists to leave the team's software alone. `default` surfaces on
 * purpose (an object with no namespace is treated as living there), and a name
 * that merely CONTAINS a platform word is still somebody's app.
 */
Deno.test('user namespaces still surface', () => {
  const mine = ['default', undefined, 'cart', 'checkout', 'team-payments', 'my-csi-app', 'kargo1']
  for (const ns of mine) {
    assertEquals(isSystemNamespace(ns), false, `${String(ns)} is the team's namespace`)
  }
})

/** The namespaces that were already covered must stay covered. */
Deno.test('previously filtered namespaces are unaffected', () => {
  for (const ns of ['kube-system', 'adhar-system', 'cnpg-system', 'cert-manager', 'argocd']) {
    assertEquals(isSystemNamespace(ns), true, ns)
  }
})
