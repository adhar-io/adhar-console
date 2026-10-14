import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  backupPhaseKind,
  cnpgClusterRef,
  databaseQueries,
  lagStatus,
  parseCnpgTime,
  phaseKind,
  sortBackups,
  summarizeCnpg,
  type CnpgCluster,
} from './database-insight.ts'

// A trimmed copy of a live cluster (console-db, 2026-10-14).
const NOW = Date.parse('2026-10-14T16:00:00Z')
const healthy: CnpgCluster = {
  metadata: { name: 'console-db', namespace: 'adhar-system' },
  spec: {
    instances: 1,
    imageName: 'ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie',
    storage: { size: '5Gi' },
    backup: { retentionPolicy: '7d', target: 'prefer-standby', barmanObjectStore: { destinationPath: 's3://adhar-backups/cnpg/console-db' } },
  },
  status: {
    phase: 'Cluster in healthy state',
    instances: 1,
    readyInstances: 1,
    currentPrimary: 'console-db-1',
    currentPrimaryTimestamp: '2026-10-13T22:29:30.863755Z',
    timelineID: 1,
    image: 'ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie',
    pgDataImageInfo: { majorVersion: 18 },
    instancesStatus: { healthy: ['console-db-1'] },
    instancesReportedState: { 'console-db-1': { ip: '10.244.3.58', isPrimary: true, timeLineID: 1 } },
    firstRecoverabilityPoint: '2026-10-14T02:40:04Z',
    lastSuccessfulBackup: '2026-10-14T02:40:04Z',
    writeService: 'console-db-rw',
    readService: 'console-db-r',
    pvcCount: 1,
    healthyPVC: ['console-db-1'],
    certificates: {
      expirations: {
        'console-db-ca': '2027-01-11 22:24:03 +0000 UTC',
        'console-db-replication': '2027-01-11 22:24:03 +0000 UTC',
        'console-db-server': '2027-01-11 22:24:03 +0000 UTC',
      },
    },
  },
}

Deno.test('a healthy single-instance cluster summarises as healthy everywhere that applies', () => {
  const s = summarizeCnpg(healthy, NOW)
  assertEquals(s.phaseKind, 'healthy')
  assertEquals(s.instances, 1)
  assertEquals(s.readyInstances, 1)
  assertEquals(s.primary, 'console-db-1')
  assertEquals(s.majorVersion, 18)
  assertEquals(s.members, [
    { name: 'console-db-1', role: 'primary', healthy: true, timeline: 1, ip: '10.244.3.58', pvcHealthy: true },
  ])
  assertEquals(s.replication.kind, 'info') // one node: nothing to replicate to, and that is not a fault
  assertEquals(s.backup.kind, 'healthy')
  assertStringIncludes(s.backup.label, '13h ago')
  assertEquals(s.storage, { size: '5Gi', pvcCount: 1, healthyPvc: 1, kind: 'healthy' })
  assertEquals(s.certificates.kind, 'healthy')
  assertEquals(s.certificates.daysLeft, 89)
  assertEquals(s.endpoints, { rw: 'console-db-rw', ro: 'console-db-ro', r: 'console-db-r' })
})

Deno.test('CNPG certificate timestamps parse even though Date.parse rejects their spelling', () => {
  assertEquals(parseCnpgTime('2027-01-11 22:24:03 +0000 UTC'), Date.parse('2027-01-11T22:24:03+00:00'))
  assertEquals(parseCnpgTime('2026-10-14T02:40:04Z'), Date.parse('2026-10-14T02:40:04Z'))
  assertEquals(parseCnpgTime('garbage'), undefined)
})

Deno.test('a backup older than the stale window is degraded, and a failure after the last success is too', () => {
  const stale = summarizeCnpg(healthy, NOW + 2 * 86_400_000)
  assertEquals(stale.backup.kind, 'degraded')
  assertStringIncludes(stale.backup.label, 'Stale')

  const failedAfter = summarizeCnpg(
    { ...healthy, status: { ...healthy.status, lastFailedBackup: '2026-10-14T09:00:00Z' } },
    NOW,
  )
  assertEquals(failedAfter.backup.kind, 'degraded')
  assertEquals(failedAfter.backup.label, 'Last attempt failed')

  const off = summarizeCnpg({ ...healthy, spec: { ...healthy.spec, backup: undefined } }, NOW)
  assertEquals(off.backup.enabled, false)
  assertEquals(off.backup.kind, 'info')
})

Deno.test('a three-instance cluster with a lagging replica reports replication degraded', () => {
  const s = summarizeCnpg(
    {
      ...healthy,
      spec: { ...healthy.spec, instances: 3, minSyncReplicas: 1 },
      status: {
        ...healthy.status,
        instances: 3,
        readyInstances: 2,
        instancesStatus: { healthy: ['console-db-1', 'console-db-2'], failed: ['console-db-3'] },
        instancesReportedState: {
          'console-db-1': { isPrimary: true, timeLineID: 1 },
          'console-db-2': { isPrimary: false, timeLineID: 1 },
        },
      },
    },
    NOW,
  )
  assertEquals(s.replication.kind, 'degraded')
  assertEquals(s.replication.label, '2/3 instances ready')
  assertEquals(s.members.map((m) => [m.name, m.role, m.healthy]), [
    ['console-db-1', 'primary', true],
    ['console-db-2', 'replica', true],
    ['console-db-3', 'replica', false],
  ])
  assertEquals(lagStatus(0.2, 2), { label: '200ms', kind: 'healthy' })
  assertEquals(lagStatus(75, 2), { label: '75s', kind: 'degraded' })
  assertEquals(lagStatus(undefined, 0), { label: 'n/a', kind: 'info' })
})

Deno.test('a certificate inside the warning window is flagged; an expired one is failed', () => {
  const soon = summarizeCnpg(healthy, Date.parse('2026-12-20T00:00:00Z'))
  assertEquals(soon.certificates.kind, 'degraded')
  assert((soon.certificates.daysLeft ?? 99) < 30)
  const gone = summarizeCnpg(healthy, Date.parse('2027-02-01T00:00:00Z'))
  assertEquals(gone.certificates.kind, 'failed')
})

Deno.test('phase wording maps onto the status vocabulary', () => {
  assertEquals(phaseKind('Cluster in healthy state'), 'healthy')
  assertEquals(phaseKind('Setting up primary'), 'progressing')
  assertEquals(phaseKind('Failing over'), 'progressing')
  assertEquals(phaseKind('Cluster in unrecoverable state'), 'failed')
  assertEquals(phaseKind('Cluster is hibernated'), 'paused')
  assertEquals(phaseKind(undefined), 'unknown')
})

Deno.test('the PromQL selects the cluster by anchored pod name, so a sibling with a longer name is excluded', () => {
  const q = databaseQueries('keycloak-db', 'adhar-system')
  for (const expr of Object.values(q)) {
    assertStringIncludes(expr, 'namespace="adhar-system"')
    assertStringIncludes(expr, 'pod=~"keycloak-db-[0-9]+"')
  }
  // a dot in a name must be literal, not a regex wildcard
  assertStringIncludes(databaseQueries('a.b', 'ns').size, 'pod=~"a\\.b-[0-9]+"')
  assertStringIncludes(q.cacheHit, 'clamp_min(')
  assertStringIncludes(q.maxConnections, 'name="max_connections"')
})

Deno.test('only the CNPG Cluster ref is picked out of the composed set', () => {
  const refs = [
    { apiVersion: 'postgresql.cnpg.io/v1', kind: 'ScheduledBackup', name: 'x-daily' },
    { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', name: 'x' },
    { apiVersion: 'redis.redis.opstreelabs.in/v1beta2', kind: 'Redis', name: 'y' },
  ]
  assertEquals(cnpgClusterRef(refs)?.name, 'x')
  assertEquals(cnpgClusterRef([refs[2]]), undefined)
})

Deno.test('backups sort newest first and phases map onto badges', () => {
  const sorted = sortBackups([
    { metadata: { name: 'old' }, status: { startedAt: '2026-10-12T02:40:00Z' } },
    { metadata: { name: 'new' }, status: { startedAt: '2026-10-14T02:40:00Z' } },
    { metadata: { name: 'mid', creationTimestamp: '2026-10-13T02:40:00Z' } },
  ])
  assertEquals(sorted.map((b) => b.metadata.name), ['new', 'mid', 'old'])
  assertEquals(backupPhaseKind('completed'), 'healthy')
  assertEquals(backupPhaseKind('failed'), 'failed')
  assertEquals(backupPhaseKind('running'), 'progressing')
})
