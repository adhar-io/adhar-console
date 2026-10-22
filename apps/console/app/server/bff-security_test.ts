/**
 * Regression tests for the BFF authorization fixes of the 2026-10-22 review —
 * one per hole, so reopening any of them fails here.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { isReservedKind } from './api-handlers.ts'
import { slugConflict } from './organizations.ts'
import { CONSOLE_PERMISSIONS } from '@adhar/auth/server'
import { redactSecret } from './ai/tools.ts'
import { safeHref } from './notifications.ts'
import { fixPathRefused } from './scorecard-fix.ts'
import { redactForAnonymous, type StatusSnapshot } from './status.ts'

Deno.test('/api/store refuses every server-owned kind, keeps client settings kinds', () => {
  for (const k of ['auth.session', 'billing.subscription', 'billing.invoice', 'console.notification', 'security.waiver', 'resilience.report', 'workspace.member', 'workspace.invitation', 'workspace.audit', 'workspace.api-token', 'workspace.org']) {
    assert(isReservedKind(k), k)
  }
  for (const k of ['workspace.theme', 'workspace.webhook', 'workspace.role', 'okr.objective', 'define.page', 'decide.budget']) {
    assertFalse(isReservedKind(k), k)
  }
})

Deno.test('org create: system namespaces and existing tenants cannot be taken', async () => {
  const none = { namespaceExists: () => Promise.resolve(false), groupExists: () => Promise.resolve(false) }
  for (const slug of ['kube-system', 'default', 'argocd', 'adhar-system', 'keycloak', 'gitea']) {
    assertEquals(await slugConflict(slug, none), 'reserved', slug)
  }
  assertEquals(await slugConflict('acme', none), null)
  assertEquals(await slugConflict('acme', { ...none, namespaceExists: () => Promise.resolve(true) }), 'taken')
  assertEquals(await slugConflict('acme', { ...none, groupExists: (n) => Promise.resolve(n === 'org-acme') }), 'taken')
  // A check that cannot run (null) does not block.
  assertEquals(await slugConflict('acme', { namespaceExists: () => Promise.resolve(null), groupExists: () => Promise.resolve(null) }), null)
})

Deno.test('platform package toggle is gated on update packages.console.adhar.io', () => {
  // Granted by the platform's console ClusterRoles to platform-admin /
  // platform-engineer (cluster-admin) only — see docs/rbac.md.
  const p = CONSOLE_PERMISSIONS.packagesToggle
  assertEquals([p.verb, p.group, p.resource], ['update', 'console.adhar.io', 'packages'])
})

Deno.test('AI tools never see Secret values', () => {
  const s = redactSecret({
    kind: 'Secret',
    metadata: { name: 'db', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"pw":"aHVudGVyMg=="}}', keep: 'x' } },
    data: { pw: 'aHVudGVyMg==' },
    stringData: { token: 'abc' },
  } as never) as unknown as Record<string, Record<string, unknown>>
  assertEquals(s.data, { pw: '<redacted>' })
  assertEquals(s.stringData, { token: '<redacted>' })
  assertEquals(s.metadata.annotations, { keep: 'x' })
  const cm = { kind: 'ConfigMap', data: { a: '1' } }
  assertEquals(redactSecret(cm as never), cm as never)
})

Deno.test('notification links stay inside the console', () => {
  assertEquals(safeHref('/deliver/apps?x=1'), '/deliver/apps?x=1')
  for (const bad of ['javascript:alert(1)', '//evil.test', '/\\evil.test', 'https://evil.test', 42]) {
    assertEquals(safeHref(bad), undefined, String(bad))
  }
})

Deno.test('scorecard fixes never write CI definitions', () => {
  for (const p of ['.gitea/workflows/x.yaml', '.github/workflows/ci.yml', '.tekton/pipeline.yaml', 'Jenkinsfile', '.drone.yml']) assert(fixPathRefused(p), p)
  for (const p of ['catalog-info.yaml', 'deploy/deployment.yaml', 'docs/.github-notes.md']) assertFalse(fixPathRefused(p), p)
})

Deno.test('anonymous status: no workload names, images or messages', () => {
  const snap = {
    console: { version: '1', image: 'reg/console:1', startedAt: '', runtime: 'deno' },
    platform: { image: 'reg/ctl:1', conditions: [{ type: 'Ready', status: 'False', message: 'pod x in ns y crashlooping' }] },
    kubernetes: {},
    dependencies: [{ id: 'db', name: 'Postgres', status: 'down', detail: 'connect ECONNREFUSED 10.0.0.5:5432' }],
    components: [{ id: 'argocd', health: 'healthy', workloads: [{ name: 'argocd-server', namespace: 'argocd' }] }],
  } as unknown as StatusSnapshot
  const out = redactForAnonymous(snap)
  assertEquals(out.console.image, undefined)
  assertEquals(out.platform.image, undefined)
  assertEquals(out.platform.conditions[0].message, undefined)
  assertEquals(out.dependencies[0].detail, undefined)
  assertEquals(out.components[0].workloads, [])
  assertEquals(out.components[0].health, 'healthy')
})
