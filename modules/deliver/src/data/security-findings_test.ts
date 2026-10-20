import { assert, assertEquals } from 'jsr:@std/assert@^1'
import {
  buildFindings,
  buildLicenses,
  componentPath,
  findingStatus,
  groupIdentical,
  latestCiScans,
  licenseRisk,
  matchesFinding,
  placeNamespace,
  slaOf,
  summaryDiff,
  type TrivyReportObj,
  waiverCovers,
  waiversCsv,
  weekOf,
  workloadOf,
} from './security-findings.ts'
import type { GateView, Waiver } from './security-types.ts'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const DAY = 86_400_000
const D1 = `sha256:${'1'.repeat(64)}`
const D2 = `sha256:${'2'.repeat(64)}`

function report(ns: string, rs: string, digest: string, vulns: TrivyReportObj['report'] extends infer R ? R extends { vulnerabilities?: infer V } ? V : never : never): TrivyReportObj {
  return {
    metadata: { name: `replicaset-${rs}-app`, namespace: ns, labels: { 'trivy-operator.resource.kind': 'ReplicaSet', 'trivy-operator.resource.name': rs, 'trivy-operator.container.name': 'app' } },
    report: { registry: { server: 'harbor.local' }, artifact: { repository: 'shop/cart', tag: '1.2.0', digest }, updateTimestamp: '2026-10-20T00:00:00Z', vulnerabilities: vulns },
  }
}

const reports = [
  report('shop-dev', 'cart-7d9f8c6b5', D1, [
    { vulnerabilityID: 'CVE-1', resource: 'openssl', installedVersion: '3.0.1', fixedVersion: '3.0.2', severity: 'CRITICAL', score: 9.8, primaryLink: 'https://avd/CVE-1' },
    { vulnerabilityID: 'CVE-2', resource: 'zlib', installedVersion: '1.2', severity: 'LOW' },
  ]),
  report('shop-prod', 'cart-5f6d7c8b9', D2, [
    { vulnerabilityID: 'CVE-1', resource: 'openssl', installedVersion: '3.0.1', fixedVersion: '3.0.2', severity: 'CRITICAL' },
  ]),
]

function waiver(over: Partial<Waiver>): Waiver {
  return {
    id: 'w', kind: 'vuln', scope: 'project', target: { project: 'shop' }, findingId: 'CVE-1', justification: 'x', vex: { status: 'not_affected', justification: 'component_not_present' },
    requestedBy: { id: 'a', label: 'A' }, requestedAt: '2026-10-01T00:00:00Z', expiresAt: new Date(NOW + 10 * DAY).toISOString(), status: 'approved', history: [], ...over,
  }
}

Deno.test('placeNamespace / workloadOf', () => {
  assertEquals(placeNamespace('shop-dev', ['shop', 'shop-api']), { project: 'shop', env: 'dev' })
  assertEquals(placeNamespace('shop-api-prod', ['shop', 'shop-api']), { project: 'shop-api', env: 'prod' })
  assertEquals(placeNamespace('shop', ['shop']), { project: 'shop' })
  assertEquals(placeNamespace('kube-system', ['shop']), {})
  assertEquals(workloadOf({ 'trivy-operator.resource.kind': 'ReplicaSet', 'trivy-operator.resource.name': 'cart-7d9f8c6b5' }).name, 'cart')
  assertEquals(workloadOf({ 'trivy-operator.resource.kind': 'StatefulSet', 'trivy-operator.resource.name': 'db' }).name, 'db')
})

Deno.test('buildFindings: one finding per CVE+package, occurrences across environments', () => {
  const f = buildFindings(reports, ['shop'])
  assertEquals(f.map((x) => x.key), ['CVE-1|openssl', 'CVE-2|zlib'])
  const c = f[0]
  assertEquals(c.severity, 'critical')
  assert(c.fixable)
  assertEquals(c.fixedVersions, ['3.0.2'])
  assertEquals(c.occurrences.map((o) => `${o.project}/${o.env}/${o.app}`), ['shop/dev/cart', 'shop/prod/cart'])
  assertEquals(c.occurrences[0].image, 'harbor.local/shop/cart:1.2.0@' + D1)
  assertEquals(c.links, ['https://avd/CVE-1'])
  assertEquals(c.epss, undefined, 'never invented')
})

Deno.test('waiverCovers: scope targeting', () => {
  const [f] = buildFindings(reports, ['shop'])
  const [dev, prod] = f.occurrences
  assert(waiverCovers(waiver({ scope: 'platform' }), f, dev, NOW))
  assert(waiverCovers(waiver({ scope: 'project' }), f, prod, NOW))
  assert(!waiverCovers(waiver({ scope: 'project', target: { project: 'blog' } }), f, dev, NOW))
  assert(waiverCovers(waiver({ scope: 'app', target: { project: 'shop', app: 'cart' } }), f, dev, NOW))
  assert(waiverCovers(waiver({ scope: 'digest', target: { project: 'shop', app: 'cart', digest: D1 } }), f, dev, NOW))
  assert(!waiverCovers(waiver({ scope: 'digest', target: { project: 'shop', app: 'cart', digest: D1 } }), f, prod, NOW))
  assert(!waiverCovers(waiver({ target: { project: 'shop', package: 'libssl' } }), f, dev, NOW))
  assert(!waiverCovers(waiver({ status: 'requested' }), f, dev, NOW))
  assert(!waiverCovers(waiver({ expiresAt: new Date(NOW - 1).toISOString() }), f, dev, NOW))
})

Deno.test('findingStatus: partial vs waived, pending, earliest expiry', () => {
  const [f] = buildFindings(reports, ['shop'])
  const dig = waiver({ id: 'd', scope: 'digest', target: { project: 'shop', app: 'cart', digest: D1 } })
  const st = findingStatus(f, [dig, waiver({ id: 'p', status: 'requested' })], NOW)
  assertEquals(st.coverage, 'partial')
  assert(st.pending)
  const all = findingStatus(f, [waiver({ id: 'x', expiresAt: new Date(NOW + 2 * DAY).toISOString() }), waiver({ id: 'y' })], NOW)
  assertEquals(all.coverage, 'waived')
  assertEquals(all.expiresAt, new Date(NOW + 2 * DAY).toISOString())
  assert(!matchesFinding(f, all, { waived: 'open' }))
  assert(matchesFinding(f, st, { waived: 'open', env: 'prod', search: 'openssl' }))
})

Deno.test('licenses: risk by policy (expressions too), inventory, dependency path', () => {
  const policy = { licenseDeny: ['AGPL-3.0'], licenseWarn: ['GPL-2.0'] }
  assertEquals(licenseRisk('MIT', policy), 'ok')
  assertEquals(licenseRisk('MIT OR AGPL-3.0', policy), 'deny')
  assertEquals(licenseRisk('(GPL-2.0 WITH Classpath-exception-2.0)', policy), 'warn')
  assertEquals(licenseRisk('', policy), 'unknown')
  const sbom: TrivyReportObj = {
    metadata: { name: 'sbom', namespace: 'shop-dev', labels: { 'trivy-operator.resource.kind': 'Deployment', 'trivy-operator.resource.name': 'cart' } },
    report: {
      artifact: { repository: 'shop/cart', tag: '1' },
      components: {
        metadata: { component: { 'bom-ref': 'root', name: 'cart' } },
        components: [
          { 'bom-ref': 'a', name: 'express', version: '4', licenses: [{ license: { id: 'MIT' } }] },
          { 'bom-ref': 'b', name: 'evil', version: '1', licenses: [{ expression: 'AGPL-3.0' }] },
          { 'bom-ref': 'c', name: 'mystery', version: '0.1' },
          { 'bom-ref': 'os', type: 'operating-system', name: 'debian' },
        ],
        dependencies: [{ ref: 'root', dependsOn: ['a'] }, { ref: 'a', dependsOn: ['b'] }],
      },
    },
  }
  assertEquals(componentPath(sbom.report!.components!, 'b'), ['cart', 'express@4', 'evil@1'])
  const { rows, apps } = buildLicenses([sbom], ['shop'], policy)
  assertEquals(rows.map((r) => `${r.license || '(none)'}:${r.risk}`), ['AGPL-3.0:deny', '(none):unknown', 'MIT:ok'])
  assertEquals(rows[0].packages[0].path, ['cart', 'express@4', 'evil@1'])
  assertEquals(apps[0].components, 3)
  assertEquals(apps[0].byRisk, { deny: 1, warn: 0, ok: 1, unknown: 1 })
})

Deno.test('CI: latest scan per app and count diff', () => {
  const g = (name: string, at: string, critical: number): GateView => ({ namespace: 'shop', name, app: 'cart', createdAt: at, done: true, state: 'passed', summary: { critical, high: 1 } })
  const runs = [g('r3', '2026-10-21', 2), g('r2', '2026-10-20', 0)]
  assertEquals(latestCiScans(runs).map((x) => x.name), ['r3'])
  assertEquals(summaryDiff(runs[1].summary, runs[0].summary), { critical: 2 })
})

Deno.test('review helpers: SLA ageing, identical grouping, CSV escaping, week bucket', () => {
  assertEquals(slaOf(new Date(NOW - 1 * DAY).toISOString(), NOW).tone, 'fresh')
  assertEquals(slaOf(new Date(NOW - 3 * DAY).toISOString(), NOW).tone, 'ageing')
  assertEquals(slaOf(new Date(NOW - 6 * DAY).toISOString(), NOW).tone, 'overdue')
  const groups = groupIdentical([waiver({ id: '1', target: { project: 'a' } }), waiver({ id: '2', target: { project: 'b' } }), waiver({ id: '3', findingId: 'CVE-9' })])
  assertEquals(groups.map((x) => x.items.map((w) => w.id)), [['1', '2'], ['3']])
  const csv = waiversCsv([waiver({ justification: '=HYPERLINK("x"), "quoted"' })])
  assert(csv.includes(`"'=HYPERLINK(""x""), ""quoted"""`))
  assertEquals(weekOf('2026-10-21T10:00:00Z'), '2026-10-19')
})
