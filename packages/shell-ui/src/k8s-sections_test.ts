import { assertEquals } from 'jsr:@std/assert@1'
import { K8S_CATEGORIES, k8sCategoryOf, k8sPageOf } from './k8s-sections.ts'
import { XR_SECTIONS } from './xr-sections.ts'

Deno.test('every Kubernetes page sits in exactly one category', () => {
  const ids = K8S_CATEGORIES.flatMap((c) => c.pages.flatMap((p) => [p.id, ...(p.aliases ?? [])]))
  assertEquals(ids.length, new Set(ids).size)
})

Deno.test('no Kubernetes page id collides with an Adhar Resource page', () => {
  // Both live under /platform?section=…; a shared id would light two rows.
  const xr = new Set(XR_SECTIONS.map((s) => s.id))
  const ids = K8S_CATEGORIES.flatMap((c) => c.pages.flatMap((p) => [p.id, ...(p.aliases ?? [])]))
  assertEquals(ids.filter((id) => xr.has(id)), [])
})

Deno.test('k8sCategoryOf resolves old per-page links to their category', () => {
  assertEquals(k8sCategoryOf('pods')?.id, 'workloads')
  // The retired "Deployments & Jobs" page id opens the Deployments tab.
  assertEquals(k8sCategoryOf('workloads')?.id, 'workloads')
  assertEquals(k8sPageOf('workloads')?.id, 'deployments')
  // …and so do the retired combined Networking / Storage / Config pages.
  assertEquals(k8sPageOf('networking')?.id, 'k8s-services')
  assertEquals(k8sPageOf('storage')?.id, 'pvcs')
  assertEquals(k8sPageOf('config')?.id, 'configmaps')
  assertEquals(k8sCategoryOf('secrets')?.id, 'config')
  assertEquals(k8sPageOf('rbac')?.id, 'service-accounts')
  assertEquals(k8sPageOf('policy')?.id, 'policies')
  assertEquals(k8sCategoryOf('rbac')?.id, 'access')
  assertEquals(k8sCategoryOf('policy-violations')?.id, 'access')
  assertEquals(k8sCategoryOf('ci'), undefined)
  assertEquals(k8sCategoryOf('explore')?.id, 'observe')
  // Full-page tools stand alone, like the Dashboard.
  assertEquals(k8sCategoryOf('shell'), undefined)
  assertEquals(k8sCategoryOf('marketplace'), undefined)
  // The Dashboard is its own page, not a tab.
  assertEquals(k8sCategoryOf('dashboard'), undefined)
  assertEquals(k8sCategoryOf(undefined), undefined)
})
