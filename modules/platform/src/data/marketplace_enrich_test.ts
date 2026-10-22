import { assertEquals } from 'jsr:@std/assert@1'
import { enrichApp } from './marketplace.ts'

Deno.test('enrichment never borrows another tool through a shared tag or partial prefix', () => {
  // These used to come back as "Argo CD" and "Ollama".
  assertEquals(enrichApp('argo-rollout'), undefined)
  assertEquals(enrichApp('argo-events'), undefined)
  assertEquals(enrichApp('llm-d'), undefined)
})

Deno.test('enrichment still matches exact names and whole-segment suffixes', () => {
  assertEquals(enrichApp('argocd')?.title, 'Argo CD')
  assertEquals(enrichApp('argo-cd')?.title, 'Argo CD')
  assertEquals(enrichApp('kube-prometheus')?.name, 'kube-prometheus-stack')
})
