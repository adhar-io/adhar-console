import { assert, assertEquals } from 'jsr:@std/assert'
import {
  byRisk,
  byVulnRisk,
  matchesVuln,
  readArtifact,
  summariseScans,
  vulnSeverity,
} from './scan-rollup.ts'
import type { harbor } from '@adhar-console/api-clients'

function artifact(over: Partial<harbor.Artifact> = {}): harbor.Artifact {
  return {
    digest: 'sha256:121c48defb73aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    size: 100,
    push_time: '2026-10-04T04:24:36Z',
    ...over,
  } as harbor.Artifact
}

/** The real verdict Harbor returned for `library/sample-app` after a scan. */
const SAMPLE = artifact({
  tags: [{ name: 'b1.20261004.041911' }, { name: 'latest' }],
  vulnerabilities: { critical: 1, high: 21, medium: 24, low: 17 },
  scan: { status: 'Success', scanner: 'Trivy', endTime: '2026-10-04T09:40:00Z', total: 64, fixable: 40 },
})

Deno.test('a scanned artifact is read into counts, label and worst severity', () => {
  const a = readArtifact('library/sample-app', SAMPLE)
  assertEquals(a.project, 'library')
  assertEquals(a.label, 'b1.20261004.041911')
  assertEquals(a.tags.length, 2)
  assertEquals(a.counts, { critical: 1, high: 21, medium: 24, low: 17 })
  assertEquals(a.total, 63)
  assertEquals(a.worst, 'critical')
  assertEquals([a.scanned, a.failed, a.running], [true, false, false])
})

/** An untagged artifact still has to be nameable in a list. */
Deno.test('an artifact with no tags is labelled by its short digest', () => {
  assertEquals(readArtifact('library/x', artifact()).label, '121c48defb73')
})

/**
 * The distinction the old page collapsed: never scanned and scanned-with-
 * nothing-found are both zero on a summary row and mean opposite things.
 */
Deno.test('never scanned is not the same as scanned and clean', () => {
  const never = readArtifact('library/x', artifact())
  const clean = readArtifact('library/y', artifact({ scan: { status: 'Success' } }))
  assertEquals([never.scanned, never.total], [false, 0])
  assertEquals([clean.scanned, clean.total], [true, 0])

  const s = summariseScans([never, clean])
  assertEquals(s.scanned, 1)
  assertEquals(s.unscanned, 1)
  assertEquals(s.clean, 1)
})

Deno.test("Harbor's scan vocabulary maps onto scanned, failed and running", () => {
  const state = (status: string) => {
    const a = readArtifact('r', artifact({ scan: { status } }))
    return [a.scanned, a.failed, a.running]
  }
  assertEquals(state('Success'), [true, false, false])
  assertEquals(state('Error'), [false, true, false])
  assertEquals(state('Running'), [false, false, true])
  assertEquals(state('Pending'), [false, false, true])
  assertEquals(state('Not Scanned'), [false, false, false])
  // A status a future Harbor invents must not be counted as a clean scan.
  assertEquals(state('Whatever'), [false, false, false])
})

/** A scanner erroring is a problem to surface, not a backlog of unscanned work. */
Deno.test('failed and running scans are not counted as waiting to be scanned', () => {
  const s = summariseScans([
    readArtifact('r', artifact({ scan: { status: 'Error' } })),
    readArtifact('r', artifact({ scan: { status: 'Running' } })),
    readArtifact('r', artifact()),
  ])
  assertEquals([s.failed, s.running, s.unscanned, s.scanned], [1, 1, 1, 0])
})

Deno.test('the roll-up adds findings across artifacts and counts those at risk', () => {
  const s = summariseScans([
    readArtifact('library/sample-app', SAMPLE),
    readArtifact('library/b', artifact({ vulnerabilities: { critical: 0, high: 0, medium: 2, low: 0 }, scan: { status: 'Success', fixable: 1 } })),
    readArtifact('library/c', artifact({ scan: { status: 'Success' } })),
  ])
  assertEquals(s.counts, { critical: 1, high: 21, medium: 26, low: 17 })
  assertEquals(s.total, 65)
  assertEquals(s.scanned, 3)
  assertEquals(s.fixable, 41)
  // Only critical or high puts an artifact at risk; two mediums does not.
  assertEquals(s.atRisk, 1)
  assertEquals(s.clean, 1)
})

Deno.test('an empty registry summarises to zeros rather than failing', () => {
  const s = summariseScans([])
  assertEquals(s.total, 0)
  assertEquals([s.artifacts, s.scanned, s.unscanned], [0, 0, 0])
})

Deno.test('artifacts sort worst-first and never shuffle between polls', () => {
  const crit = readArtifact('a', artifact({ vulnerabilities: { critical: 1, high: 0, medium: 0, low: 0 }, scan: { status: 'Success' } }))
  const highMany = readArtifact('b', artifact({ vulnerabilities: { critical: 0, high: 9, medium: 0, low: 0 }, scan: { status: 'Success' } }))
  const highFew = readArtifact('c', artifact({ vulnerabilities: { critical: 0, high: 2, medium: 0, low: 0 }, scan: { status: 'Success' } }))
  const none = readArtifact('d', artifact({ scan: { status: 'Success' } }))
  assertEquals([none, highFew, crit, highMany].sort(byRisk).map((a) => a.repo), ['a', 'b', 'c', 'd'])
})

/* ── the per-artifact CVE list ── */

function vuln(over: Partial<harbor.Vulnerability> = {}): harbor.Vulnerability {
  return {
    id: 'CVE-2025-0001',
    severity: 'High',
    package: 'openssl',
    version: '3.0.1',
    links: [],
    ...over,
  } as harbor.Vulnerability
}

/**
 * Harbor reports `Negligible` and `Unknown` as well. They are real findings:
 * bucketing them keeps them visible under a filter instead of dropping them.
 */
Deno.test('every severity Harbor reports lands in a bucket', () => {
  assertEquals(vulnSeverity(vuln({ severity: 'Critical' })), 'critical')
  assertEquals(vulnSeverity(vuln({ severity: 'Medium' })), 'medium')
  assertEquals(vulnSeverity(vuln({ severity: 'Negligible' })), 'low')
  assertEquals(vulnSeverity(vuln({ severity: 'Unknown' })), 'low')
})

Deno.test('findings filter by severity, fixability and free text', () => {
  const fixable = vuln({ fixVersion: '3.0.9' })
  const stuck = vuln({ id: 'CVE-2025-0002', severity: 'Low', package: 'zlib' })
  assert(matchesVuln(fixable, {}))
  assert(matchesVuln(fixable, { fixableOnly: true }))
  assert(!matchesVuln(stuck, { fixableOnly: true }))
  assert(matchesVuln(stuck, { severities: ['low'] }))
  assert(!matchesVuln(stuck, { severities: ['critical', 'high'] }))
  assert(matchesVuln(fixable, { search: 'OPENSSL' }))
  assert(matchesVuln(fixable, { search: 'cve-2025-0001' }))
  assert(!matchesVuln(fixable, { search: 'nothing' }))
})

Deno.test('findings read worst first, then by CVSS', () => {
  const list = [
    vuln({ id: 'a', severity: 'Low' }),
    vuln({ id: 'b', severity: 'Critical', cvssScore: 7.1 }),
    vuln({ id: 'c', severity: 'Critical', cvssScore: 9.8 }),
  ]
  assertEquals([...list].sort(byVulnRisk).map((v) => v.id), ['c', 'b', 'a'])
})
