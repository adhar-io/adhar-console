import { assertEquals } from 'jsr:@std/assert@^1'
import {
  cleanPkgVersion,
  driftOf,
  effectiveVersion,
  extractRunningVersions,
  matchReport,
  parsePurl,
  runningByEnv,
  runningForEnvironments,
  techForPackage,
  type SbomComponent,
  type TrivyReport,
  versionFromTag,
} from './catalog-running.ts'

const sbom = (repo: string, tag: string | undefined, digest: string | undefined, components: SbomComponent[], at = '2026-10-17T10:00:00Z'): TrivyReport => ({
  kind: 'SbomReport',
  metadata: { name: `replicaset-${repo.split('/').pop()}-app`, namespace: 'orders-prod', labels: { 'trivy-operator.container.name': 'app' } },
  report: {
    updateTimestamp: at,
    registry: { server: 'registry.adhar.io:5000' },
    artifact: { repository: repo, tag, digest },
    components: { components },
  },
})

const JAVA_COMPONENTS: SbomComponent[] = [
  { type: 'operating-system', name: 'debian', version: '12.5' },
  { type: 'library', name: 'openjdk-17-jre-headless', version: '17.0.11+9-1~deb12u1', purl: 'pkg:deb/debian/openjdk-17-jre-headless@17.0.11%2B9-1~deb12u1?distro=debian-12.5' },
  { type: 'library', group: 'org.springframework.boot', name: 'spring-boot', version: '3.2.1', purl: 'pkg:maven/org.springframework.boot/spring-boot@3.2.1' },
  { type: 'library', group: 'org.springframework', name: 'spring-core', version: '6.1.2', purl: 'pkg:maven/org.springframework/spring-core@6.1.2' },
  { type: 'library', group: 'org.apache.logging.log4j', name: 'log4j-core', version: '2.17.1', purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.17.1' },
  { type: 'library', name: 'postgresql', version: '42.7.3', purl: 'pkg:maven/org.postgresql/postgresql@42.7.3' },
]

Deno.test('parsePurl and cleanPkgVersion', () => {
  assertEquals(parsePurl('pkg:maven/org.springframework/spring-core@6.1.2'), { type: 'maven', coord: 'org.springframework:spring-core', version: '6.1.2' })
  assertEquals(parsePurl('pkg:npm/%40angular/core@17.3.0'), { type: 'npm', coord: '@angular/core', version: '17.3.0' })
  assertEquals(parsePurl('pkg:golang/stdlib@v1.22.5'), { type: 'golang', coord: 'stdlib', version: 'v1.22.5' })
  assertEquals(parsePurl('pkg:golang/github.com/gin-gonic/gin@v1.10.0')?.coord, 'github.com/gin-gonic/gin')
  assertEquals(cleanPkgVersion('1:17.0.11+9-1~deb12u1'), '17.0.11')
  assertEquals(cleanPkgVersion('17.0.11_p9-r0'), '17.0.11')
  assertEquals(cleanPkgVersion('v1.22.5'), '1.22.5')
})

Deno.test('techForPackage: runtimes from OS packages, libraries by coordinate', () => {
  assertEquals(techForPackage('openjdk-17-jre-headless', '17.0.11+9-1~deb12u1', 'deb'), { key: 'java', version: '17.0.11' })
  assertEquals(techForPackage('nodejs', '20.11.1-r0', 'apk'), { key: 'node', version: '20.11.1' })
  assertEquals(techForPackage('python3.11-minimal', '3.11.2-6', 'deb'), { key: 'python', version: '3.11.2' })
  assertEquals(techForPackage('stdlib', 'v1.22.5', 'golang'), { key: 'go', version: '1.22.5' })
  assertEquals(techForPackage('react', '18.3.1', 'npm'), { key: 'react', version: '18.3.1' })
  assertEquals(techForPackage('org.springframework.boot:spring-boot', '3.2.1', 'maven'), { key: 'spring-boot', version: '3.2.1' })
  // A JDBC driver is not the database.
  assertEquals(techForPackage('org.postgresql:postgresql', '42.7.3', 'maven'), undefined)
  // An npm package named like a runtime is not the runtime.
  assertEquals(techForPackage('node', '1.0.0', 'npm'), undefined)
})

Deno.test('extractRunningVersions: SBOM and vulnerability-report fallback', () => {
  const s = extractRunningVersions(sbom('org/orders-service', '1.4.2', undefined, JAVA_COMPONENTS))
  assertEquals(s.kind, 'sbom')
  assertEquals(s.os, 'debian 12.5')
  assertEquals(Object.fromEntries(s.versions.map((x) => [x.key, x.version])), { java: '17.0.11', 'spring-boot': '3.2.1', spring: '6.1.2', log4j: '2.17.1' })
  const vr = extractRunningVersions({
    metadata: { name: 'x' },
    report: { os: { family: 'alpine', name: '3.19.1' }, vulnerabilities: [{ resource: 'stdlib', installedVersion: 'v1.21.4', pkgIdentifier: { purl: 'pkg:golang/stdlib@v1.21.4' } }, { resource: 'github.com/gin-gonic/gin', installedVersion: 'v1.9.0' }] },
  })
  assertEquals(vr.kind, 'vulnerability-report')
  assertEquals(vr.os, 'alpine 3.19.1')
  assertEquals(vr.versions.map((x) => [x.key, x.version]), [['go', '1.21.4'], ['gin', '1.9.0']])
})

Deno.test('matchReport: digest beats tag, other repos ignored, newest wins', () => {
  const reports = [
    sbom('org/orders-service', '1.4.1', 'sha256:old', [], '2026-10-01T00:00:00Z'),
    sbom('org/orders-service', '1.4.2', 'sha256:new', [], '2026-10-16T00:00:00Z'),
    sbom('org/orders-service', '1.4.2', 'sha256:new', [], '2026-10-17T00:00:00Z'),
    sbom('org/billing', '1.4.2', 'sha256:bill', []),
  ]
  assertEquals(matchReport('registry.adhar.io:5000/org/orders-service@sha256:old', reports)?.report?.artifact?.tag, '1.4.1')
  assertEquals(matchReport('registry.adhar.io:5000/org/orders-service:1.4.2', reports)?.report?.updateTimestamp, '2026-10-17T00:00:00Z')
  assertEquals(matchReport('registry.adhar.io:5000/org/orders-service:9.9.9', reports), undefined)
  assertEquals(matchReport('other.io/org/orders-service:1.4.2', reports), undefined)
  // Docker Hub library images match with or without `library/`.
  assertEquals(Boolean(matchReport('redis:7.2', [{ metadata: { name: 'r' }, report: { registry: { server: 'index.docker.io' }, artifact: { repository: 'library/redis', tag: '7.2' } } }])), true)
})

Deno.test('runningForEnvironments: states, app version from OCI label or tag, per-env lookup', () => {
  const envs = runningForEnvironments(
    [
      { env: 'Production', app: 'orders-prod', namespace: 'orders-prod', images: ['registry.adhar.io:5000/org/orders-service:1.4.2'] },
      { env: 'Development', app: 'orders-dev', namespace: 'orders-dev', images: ['registry.adhar.io:5000/org/orders-service:main-abc123'] },
      { env: 'Test', app: 'orders-test', namespace: 'orders-test', images: ['registry.adhar.io:5000/org/orders-service:1.5.0-rc.1'] },
    ],
    new Map([
      ['orders-prod', { state: 'ok' as const, reports: [sbom('org/orders-service', '1.4.2', undefined, JAVA_COMPONENTS)] }],
      ['orders-dev', { state: 'ok' as const, reports: [] }],
      ['orders-test', { state: 'forbidden' as const, reports: [] }],
    ]),
    new Map([['registry.adhar.io:5000/org/orders-service:main-abc123', { 'org.opencontainers.image.version': 'v1.5.0-SNAPSHOT', 'org.opencontainers.image.revision': 'abc123' }]]),
  )
  assertEquals(envs.map((e) => e.state), ['ok', 'no-report', 'forbidden'])
  assertEquals(envs[0].images[0].appVersion, { version: '1.4.2', source: 'image-tag' })
  assertEquals(envs[1].images[0].appVersion, { version: '1.5.0-SNAPSHOT', source: 'oci-label', revision: 'abc123' })
  assertEquals(envs[2].images[0].appVersion?.version, '1.5.0-rc.1')
  assertEquals(runningByEnv(envs, 'spring-boot').map((r) => [r.env, r.version]), [['Production', '3.2.1']])
})

Deno.test('versionFromTag', () => {
  assertEquals(versionFromTag('v2.0.0'), '2.0.0')
  assertEquals(versionFromTag('release-1.2'), '1.2')
  assertEquals(versionFromTag('latest'), undefined)
  assertEquals(versionFromTag('sha-9f86d08'), undefined)
  assertEquals(versionFromTag('20'), undefined)
})

Deno.test('driftOf and effectiveVersion', () => {
  assertEquals(driftOf('3.3.4', '3.2.1'), 'drift')
  assertEquals(driftOf('3.3', '3.3.4'), 'match')
  assertEquals(driftOf('17+', '21.0.2'), 'match')
  assertEquals(driftOf('21+', '17.0.11'), 'drift')
  assertEquals(driftOf('6.1.x', '6.1.2'), 'match')
  assertEquals(driftOf('6.1.x', '6.2.0'), 'drift')
  assertEquals(driftOf(undefined, '1'), 'unknown')
  assertEquals(effectiveVersion('18.2.0', '18.3.1', [{ env: 'Production', version: '18.3.0' }]), { version: '18.3.0', basis: 'running', env: 'Production' })
  assertEquals(effectiveVersion('18.2.0', '18.3.1', []), { version: '18.3.1', basis: 'resolved' })
  assertEquals(effectiveVersion('18.2.0', undefined, []), { version: '18.2.0', basis: 'declared' })
})
