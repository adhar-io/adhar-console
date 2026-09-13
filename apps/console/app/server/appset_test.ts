import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { resolvePackageName } from './appset.ts'

// The five names that produced five confident, wrong "set ADHAR_APPSET_REPO and
// ADHAR_APPSET_FILE" errors in one onboarding run — against a repo and file that
// were already configured correctly.
Deno.test('bootstrap components are always installed, not togglable', () => {
  for (const n of ['gitea', 'argocd', 'argo-cd', 'Gitea', 'cilium', 'crossplane']) {
    const r = resolvePackageName(n)
    assertEquals(r.kind, 'always-installed', `${n} should be always-installed`)
  }
})

Deno.test('a sub-component resolves to the package that ships it', () => {
  for (const n of ['grafana', 'prometheus', 'alertmanager', 'kube-prometheus-stack']) {
    assertEquals(resolvePackageName(n), { kind: 'package', name: 'kube-prometheus' })
  }
})

Deno.test('argo-rollouts is a spelling of the argo-rollout package', () => {
  // The package directory is singular; the console names it plural.
  assertEquals(resolvePackageName('argo-rollouts'), { kind: 'package', name: 'argo-rollout' })
})

Deno.test('a real package name passes through untouched', () => {
  for (const n of ['keycloak', 'harbor', 'kyverno', 'airbyte', 'adhar-ai', 'kube-prometheus']) {
    assertEquals(resolvePackageName(n), { kind: 'package', name: n })
  }
})

Deno.test('resolution is case-insensitive but preserves an unmapped name verbatim', () => {
  assertEquals(resolvePackageName('GRAFANA'), { kind: 'package', name: 'kube-prometheus' })
  // Unmapped names keep their original casing — the appset is the authority on
  // spelling, so we must not silently lower-case something we do not know.
  assertEquals(resolvePackageName('MyCustomPkg'), { kind: 'package', name: 'MyCustomPkg' })
})
