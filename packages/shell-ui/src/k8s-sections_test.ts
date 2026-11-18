import { assertEquals } from 'jsr:@std/assert@1'
import { K8S_CATEGORIES, k8sCategoryOf } from './k8s-sections.ts'
import { XR_SECTIONS } from './xr-sections.ts'

Deno.test('every Kubernetes page sits in exactly one category', () => {
  const ids = K8S_CATEGORIES.flatMap((c) => c.pages.map((p) => p.id))
  assertEquals(ids.length, new Set(ids).size)
})

Deno.test('no Kubernetes page id collides with an Adhar Resource page', () => {
  // Both live under /platform?section=…; a shared id would light two rows.
  const xr = new Set(XR_SECTIONS.map((s) => s.id))
  assertEquals(K8S_CATEGORIES.flatMap((c) => c.pages.filter((p) => xr.has(p.id)).map((p) => p.id)), [])
})

Deno.test('k8sCategoryOf resolves old per-page links to their category', () => {
  assertEquals(k8sCategoryOf('pods')?.id, 'workloads')
  assertEquals(k8sCategoryOf('rbac')?.id, 'access')
  assertEquals(k8sCategoryOf('ci'), undefined)
  assertEquals(k8sCategoryOf(undefined), undefined)
})
