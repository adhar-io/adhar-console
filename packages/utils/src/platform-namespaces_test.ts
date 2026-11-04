import { assertEquals } from 'jsr:@std/assert@1'
import { isPlatformNamespace } from './platform-namespaces.ts'

Deno.test('platform namespaces: the list, kube-*, openshift-* and *-system', () => {
  for (const ns of ['adhar-system', 'kube-system', 'kube-flannel', 'argocd', 'crossplane-system', 'knative-serving-system', 'openshift-ingress']) {
    assertEquals(isPlatformNamespace(ns), true, ns)
  }
})

Deno.test('application namespaces are not platform', () => {
  for (const ns of ['dev', 'test', 'prod', 'payments-dev', 'shop', 'default', 'systems-team']) {
    assertEquals(isPlatformNamespace(ns), false, ns)
  }
})
