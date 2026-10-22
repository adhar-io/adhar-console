import { assertEquals } from 'jsr:@std/assert'
import { DEFAULT_SUPPORT_CONFIG, INCIDENT_FAMILIES, loadSupportConfig, mergeSupportConfig } from './config.ts'

Deno.test('defaults: on, high and above, every family, SUP project, 200 log lines over 60 minutes', () => {
  const c = mergeSupportConfig(undefined)
  assertEquals(c, DEFAULT_SUPPORT_CONFIG)
  assertEquals(c.enabled, true)
  assertEquals(c.minSeverity, 'high')
  assertEquals(c.sources, [...INCIDENT_FAMILIES])
  assertEquals(c.defaultProject, { name: 'Platform Support', identifier: 'SUP' })
  assertEquals(c.evidence.logLines, 200)
  assertEquals(c.alertSeverities, ['critical'])
})

Deno.test('a stored document is clamped and validated, never trusted', () => {
  const c = mergeSupportConfig({
    enabled: 'yes', // not a boolean → default
    minSeverity: 'catastrophic', // unknown → default
    sources: ['argocd', 'nope', 42],
    defaultProject: { name: '  Ops  ', identifier: 'ops' },
    projectMap: { adhar: ' p-1 ', bad: 3 },
    evidence: { logLines: 1_000_000, windowMinutes: '15', queryTimeoutMs: 1, traceLimit: -4 },
    commentCooldownMinutes: 'NaN',
  })
  assertEquals(c.enabled, true)
  assertEquals(c.minSeverity, 'high')
  assertEquals(c.sources, ['argocd'])
  assertEquals(c.defaultProject, { name: 'Ops', identifier: 'OPS' })
  assertEquals(c.projectMap, { adhar: 'p-1' })
  assertEquals(c.evidence.logLines, 1000)
  assertEquals(c.evidence.windowMinutes, 15)
  assertEquals(c.evidence.queryTimeoutMs, 1000)
  assertEquals(c.evidence.traceLimit, 0)
  assertEquals(c.commentCooldownMinutes, 30)
  // An identifier Plane would reject falls back.
  assertEquals(mergeSupportConfig({ defaultProject: { identifier: 'way-too-long-id!' } }).defaultProject.identifier, 'SUP')
})

Deno.test('loadSupportConfig: an unreadable store is the defaults, not an exception', async () => {
  const c = await loadSupportConfig({ get: () => Promise.reject(new Error('db down')) })
  assertEquals(c, DEFAULT_SUPPORT_CONFIG)
  const saved = await loadSupportConfig({ get: <T>() => Promise.resolve({ data: { enabled: false } as T }) })
  assertEquals(saved.enabled, false)
})
