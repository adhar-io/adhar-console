import type { ComposedRef } from './xr-ops.ts'

/**
 * The badge vocabulary, spelled out here rather than imported: this module is
 * pure data and its tests run without the UI package (which pulls React).
 * Structurally identical to shell-ui's `StatusKind`, so the view passes these
 * straight to `StatusBadge`.
 */
export type StatusKind = 'healthy' | 'degraded' | 'progressing' | 'paused' | 'failed' | 'unknown' | 'info'

/**
 * What the Adhar Resources drawer shows for a `Database`.
 *
 * A Database XR carries almost nothing of its own — conditions, a composition
 * ref — while everything a person actually wants to know (is the primary up,
 * are the replicas streaming, when was the last backup, how much traffic) sits
 * on the CloudNativePG `Cluster` it composed and in the `cnpg_*` series that
 * cluster's exporter publishes. These helpers turn both into one summary; the
 * view only lays it out. Pure, so the judgement calls (what counts as a stale
 * backup, when a certificate is "expiring") are tested rather than eyeballed.
 */

export const CNPG_GROUP = 'postgresql.cnpg.io'

export const CNPG_GVR = {
  cluster: { group: CNPG_GROUP, version: 'v1', resource: 'clusters', namespaced: true },
  backup: { group: CNPG_GROUP, version: 'v1', resource: 'backups', namespaced: true },
  scheduledBackup: { group: CNPG_GROUP, version: 'v1', resource: 'scheduledbackups', namespaced: true },
} as const

/** The composed CNPG cluster, if this Database composed one (a Redis-backed Database did not). */
export function cnpgClusterRef(refs: ComposedRef[]): ComposedRef | undefined {
  return refs.find((r) => r.kind === 'Cluster' && (r.apiVersion ?? '').startsWith(`${CNPG_GROUP}/`))
}

/* ───── CNPG Cluster shape (the fields read here; everything else passes through) ───── */

export interface CnpgCluster {
  metadata: { name: string; namespace?: string }
  spec?: {
    instances?: number
    imageName?: string
    minSyncReplicas?: number
    maxSyncReplicas?: number
    storage?: { size?: string }
    backup?: {
      retentionPolicy?: string
      target?: string
      barmanObjectStore?: { destinationPath?: string }
    }
  }
  status?: {
    phase?: string
    phaseReason?: string
    instances?: number
    readyInstances?: number
    currentPrimary?: string
    targetPrimary?: string
    currentPrimaryTimestamp?: string
    timelineID?: number
    image?: string
    pgDataImageInfo?: { majorVersion?: number }
    instancesStatus?: Record<string, string[]>
    instancesReportedState?: Record<string, { ip?: string; isPrimary?: boolean; timeLineID?: number }>
    instanceNames?: string[]
    firstRecoverabilityPoint?: string
    lastSuccessfulBackup?: string
    lastFailedBackup?: string
    writeService?: string
    readService?: string
    pvcCount?: number
    healthyPVC?: string[]
    certificates?: { expirations?: Record<string, string> }
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>
  }
}

export interface CnpgBackup {
  metadata: { name: string; creationTimestamp?: string }
  spec?: { cluster?: { name?: string }; method?: string }
  status?: { phase?: string; startedAt?: string; stoppedAt?: string; error?: string; backupId?: string }
}

export interface DatabaseMember {
  name: string
  role: 'primary' | 'replica'
  healthy: boolean
  timeline?: number
  ip?: string
  pvcHealthy: boolean
}

export interface DatabaseSummary {
  phase: string
  phaseKind: StatusKind
  phaseReason?: string
  instances: number
  readyInstances: number
  primary?: string
  primarySince?: string
  timeline?: number
  image?: string
  majorVersion?: number
  members: DatabaseMember[]
  replication: { replicas: number; minSync?: number; maxSync?: number; kind: StatusKind; label: string }
  backup: {
    enabled: boolean
    lastSuccessful?: string
    lastFailed?: string
    firstRecoverabilityPoint?: string
    destination?: string
    retention?: string
    target?: string
    kind: StatusKind
    label: string
  }
  storage: { size?: string; pvcCount: number; healthyPvc: number; kind: StatusKind }
  certificates: { soonestExpiry?: string; soonestName?: string; daysLeft?: number; kind: StatusKind }
  endpoints: { rw?: string; ro?: string; r?: string }
}

/** A backup older than this is reported stale — daily schedules give 12h of slack. */
export const BACKUP_STALE_MS = 36 * 3_600_000
/** Certificates inside this window are flagged; CNPG renews at 7 days, so 30 means "renewal is late". */
export const CERT_WARN_DAYS = 30

export function phaseKind(phase: string | undefined): StatusKind {
  const p = (phase ?? '').toLowerCase()
  if (!p) return 'unknown'
  if (p.includes('healthy')) return 'healthy'
  if (p.includes('failed') || p.includes('unrecoverable') || p.includes('unable')) return 'failed'
  if (p.includes('hibernat') || p.includes('paused')) return 'paused'
  if (
    p.includes('setting up') || p.includes('creating') || p.includes('upgrad') || p.includes('switchover') ||
    p.includes('failing over') || p.includes('waiting') || p.includes('promot') || p.includes('restart') ||
    p.includes('rolling') || p.includes('applying') || p.includes('replica cluster') || p.includes('online update')
  ) return 'progressing'
  return 'info'
}

/** CNPG prints certificate expirations as `2027-01-11 22:24:03 +0000 UTC`; Date cannot parse that spelling. */
export function parseCnpgTime(s: string | undefined): number | undefined {
  if (!s) return undefined
  const direct = Date.parse(s)
  if (Number.isFinite(direct)) return direct
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}) /)
  if (!m) return undefined
  const t = Date.parse(`${m[1]}T${m[2]}${m[3].slice(0, 3)}:${m[3].slice(3)}`)
  return Number.isFinite(t) ? t : undefined
}

export function summarizeCnpg(c: CnpgCluster, now = Date.now()): DatabaseSummary {
  const st = c.status ?? {}
  const sp = c.spec ?? {}
  const instances = st.instances ?? sp.instances ?? 0
  const ready = st.readyInstances ?? 0
  const healthyNames = new Set(st.instancesStatus?.healthy ?? [])
  const pvcHealthy = new Set(st.healthyPVC ?? [])
  const reported = st.instancesReportedState ?? {}
  const names = new Set<string>([
    ...(st.instanceNames ?? []),
    ...Object.keys(reported),
    ...Object.values(st.instancesStatus ?? {}).flat(),
  ])
  const members: DatabaseMember[] = [...names]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => ({
      name,
      role: name === st.currentPrimary || reported[name]?.isPrimary ? 'primary' : 'replica',
      healthy: healthyNames.has(name),
      timeline: reported[name]?.timeLineID,
      ip: reported[name]?.ip,
      pvcHealthy: pvcHealthy.has(name),
    }))

  const replicas = Math.max(instances - 1, 0)
  const replication: DatabaseSummary['replication'] = instances <= 1
    ? { replicas: 0, kind: 'info', label: 'Single instance — no replica' }
    : ready < instances
      ? {
          replicas,
          minSync: sp.minSyncReplicas,
          maxSync: sp.maxSyncReplicas,
          kind: 'degraded',
          label: `${ready}/${instances} instances ready`,
        }
      : {
          replicas,
          minSync: sp.minSyncReplicas,
          maxSync: sp.maxSyncReplicas,
          kind: 'healthy',
          label: `${replicas} replica${replicas === 1 ? '' : 's'} streaming${
            sp.minSyncReplicas ? ` · ${sp.minSyncReplicas} synchronous` : ''
          }`,
        }

  const enabled = Boolean(sp.backup?.barmanObjectStore)
  const lastOk = parseCnpgTime(st.lastSuccessfulBackup)
  const lastBad = parseCnpgTime(st.lastFailedBackup)
  let backupKind: StatusKind
  let backupLabel: string
  if (!enabled) {
    backupKind = 'info'
    backupLabel = 'Not configured'
  } else if (lastOk === undefined) {
    backupKind = lastBad !== undefined ? 'degraded' : 'progressing'
    backupLabel = lastBad !== undefined ? 'Last attempt failed — none succeeded yet' : 'No backup yet'
  } else if (lastBad !== undefined && lastBad > lastOk) {
    backupKind = 'degraded'
    backupLabel = 'Last attempt failed'
  } else if (now - lastOk > BACKUP_STALE_MS) {
    backupKind = 'degraded'
    backupLabel = `Stale — last success ${hoursAgo(now - lastOk)}`
  } else {
    backupKind = 'healthy'
    backupLabel = `Last success ${hoursAgo(now - lastOk)}`
  }

  const pvcCount = st.pvcCount ?? 0
  const healthyPvcCount = st.healthyPVC?.length ?? 0
  const storageKind: StatusKind = pvcCount === 0 ? 'unknown' : healthyPvcCount >= pvcCount ? 'healthy' : 'degraded'

  let soonest: { name: string; at: number } | undefined
  for (const [name, raw] of Object.entries(st.certificates?.expirations ?? {})) {
    const at = parseCnpgTime(raw)
    if (at === undefined) continue
    if (!soonest || at < soonest.at) soonest = { name, at }
  }
  const daysLeft = soonest ? Math.floor((soonest.at - now) / 86_400_000) : undefined
  const certKind: StatusKind = daysLeft === undefined
    ? 'unknown'
    : daysLeft < 0
      ? 'failed'
      : daysLeft < CERT_WARN_DAYS
        ? 'degraded'
        : 'healthy'

  const svcBase = st.writeService?.replace(/-rw$/, '') ?? c.metadata.name
  return {
    phase: st.phase ?? 'Unknown',
    phaseKind: phaseKind(st.phase),
    phaseReason: st.phaseReason,
    instances,
    readyInstances: ready,
    primary: st.currentPrimary,
    primarySince: st.currentPrimaryTimestamp,
    timeline: st.timelineID,
    image: st.image ?? sp.imageName,
    majorVersion: st.pgDataImageInfo?.majorVersion,
    members,
    replication,
    backup: {
      enabled,
      lastSuccessful: st.lastSuccessfulBackup,
      lastFailed: st.lastFailedBackup,
      firstRecoverabilityPoint: st.firstRecoverabilityPoint,
      destination: sp.backup?.barmanObjectStore?.destinationPath,
      retention: sp.backup?.retentionPolicy,
      target: sp.backup?.target,
      kind: backupKind,
      label: backupLabel,
    },
    storage: { size: sp.storage?.size, pvcCount, healthyPvc: healthyPvcCount, kind: storageKind },
    certificates: {
      soonestExpiry: soonest ? new Date(soonest.at).toISOString() : undefined,
      soonestName: soonest?.name,
      daysLeft,
      kind: certKind,
    },
    endpoints: {
      rw: st.writeService ?? `${svcBase}-rw`,
      ro: `${svcBase}-ro`,
      r: st.readService ?? `${svcBase}-r`,
    },
  }
}

function hoursAgo(ms: number): string {
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`
  if (h < 48) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

/* ───── traffic + health series ───── */

/**
 * PromQL for the cluster's `cnpg_*` series. The exporter runs inside every
 * instance pod and CNPG names them `<cluster>-<n>`, so the selector is the pod
 * name, anchored — `keycloak-db` must not also match `keycloak-db-replica-1`
 * on a cluster that happens to have both.
 */
export function databaseQueries(cluster: string, namespace: string): Record<DatabaseSeries, string> {
  const sel = `namespace="${namespace}",pod=~"${escapeRe(cluster)}-[0-9]+"`
  const rate = (metric: string, w = '2m') => `sum(rate(${metric}{${sel}}[${w}]))`
  return {
    connections: `sum(cnpg_backends_total{${sel}})`,
    maxConnections: `max(cnpg_pg_settings_setting{${sel},name="max_connections"})`,
    transactions: `${rate('cnpg_pg_stat_database_xact_commit')} + ${rate('cnpg_pg_stat_database_xact_rollback')}`,
    cacheHit: `${rate('cnpg_pg_stat_database_blks_hit')} / clamp_min(${rate('cnpg_pg_stat_database_blks_hit')} + ${
      rate('cnpg_pg_stat_database_blks_read')
    }, 1)`,
    size: `sum(cnpg_pg_database_size_bytes{${sel}})`,
    rowsWritten: `${rate('cnpg_pg_stat_database_tup_inserted')} + ${rate('cnpg_pg_stat_database_tup_updated')} + ${
      rate('cnpg_pg_stat_database_tup_deleted')
    }`,
    rowsRead: rate('cnpg_pg_stat_database_tup_returned'),
    replicationLag: `max(cnpg_pg_replication_lag{${sel}})`,
    archiveFailures: `sum(cnpg_pg_stat_archiver_failed_count{${sel}})`,
    deadlocks: rate('cnpg_pg_stat_database_deadlocks', '5m'),
  }
}

export type DatabaseSeries =
  | 'connections'
  | 'maxConnections'
  | 'transactions'
  | 'cacheHit'
  | 'size'
  | 'rowsWritten'
  | 'rowsRead'
  | 'replicationLag'
  | 'archiveFailures'
  | 'deadlocks'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `1234.5` → `1.2k`, for per-second rates on tiles. */
export function formatRate(n: number | undefined, unit = '/s'): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const v = abs >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : abs >= 1000 ? `${(n / 1000).toFixed(1)}k` : abs >= 10 ? n.toFixed(0) : n.toFixed(1)
  return `${v}${unit}`
}

export function formatPercent(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(ratio >= 0.995 ? 1 : 0)}%`
}

/** Seconds of replication lag → a reading and the colour it deserves. */
export function lagStatus(seconds: number | undefined, replicas: number): { label: string; kind: StatusKind } {
  if (replicas === 0) return { label: 'n/a', kind: 'info' }
  if (seconds === undefined) return { label: '—', kind: 'unknown' }
  if (seconds >= 60) return { label: `${Math.round(seconds)}s`, kind: 'degraded' }
  if (seconds >= 5) return { label: `${seconds.toFixed(1)}s`, kind: 'progressing' }
  return { label: seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`, kind: 'healthy' }
}

/** Newest backups first; CNPG does not sort its list. */
export function sortBackups(items: CnpgBackup[]): CnpgBackup[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.status?.startedAt ?? a.metadata.creationTimestamp ?? '') || 0
    const tb = Date.parse(b.status?.startedAt ?? b.metadata.creationTimestamp ?? '') || 0
    return tb - ta
  })
}

export function backupPhaseKind(phase: string | undefined): StatusKind {
  switch ((phase ?? '').toLowerCase()) {
    case 'completed':
      return 'healthy'
    case 'failed':
      return 'failed'
    case 'running':
    case 'started':
    case 'pending':
    case 'walarchivingfailing':
      return 'progressing'
    default:
      return 'unknown'
  }
}
