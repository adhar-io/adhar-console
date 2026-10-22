/**
 * Support-ticket configuration: one tenant-scoped singleton document,
 * `workspace.support-tickets` / `current`, edited from Settings → Notification
 * routing. Everything has a default, so a tenant that never saved the page gets
 * automatic tickets for the platform's failure signals out of the box — and
 * every stored value is clamped on read, because the document is written by a
 * browser and read by a background worker that must not be steered into
 * fetching a million log lines.
 */

export const SUPPORT_CONFIG_KIND = 'workspace.support-tickets'
export const SUPPORT_CONFIG_ID = 'current'

export type Severity = 'low' | 'medium' | 'high' | 'critical'
export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 }

/**
 * The incident families a ticket can be opened for — one per platform signal
 * source that reports a FAILURE (see `classify.ts` for how a notification maps
 * to one). The ids are what the settings page lists.
 */
export const INCIDENT_FAMILIES = [
  'argocd',
  'rollout',
  'kargo-promotion',
  'kargo-verification',
  'tekton',
  'xr',
  'autoscaler',
  'resilience-gate',
  'event',
  'alertmanager',
] as const
export type IncidentFamily = (typeof INCIDENT_FAMILIES)[number]

export interface EvidenceLimits {
  /** Log lines per ticket (errors first, then the most recent tail). */
  logLines: number
  /** Window the logs, metrics and traces are read over. */
  windowMinutes: number
  /** Error traces listed. */
  traceLimit: number
  /** Kubernetes Events listed. */
  eventLimit: number
  /** Ceiling per backend query; a slow backend costs this much, never more. */
  queryTimeoutMs: number
  /** Bytes per evidence section in the ticket body (the attachment is uncapped by this). */
  maxSectionBytes: number
}

export interface SupportTicketConfig {
  enabled: boolean
  /** A failure below this severity never opens a ticket on its own. */
  minSeverity: Severity
  /** Also open tickets for WARNING-level notifications at or above `minSeverity` (OOMKilled, Evicted, scale-up stalled). */
  includeWarnings: boolean
  /** Alertmanager alerts open tickets only for these `severity` labels. */
  alertSeverities: string[]
  /** Families allowed to open tickets automatically. */
  sources: IncidentFamily[]
  /** Where an incident goes when its Adhar project has no Plane project. */
  defaultProject: { id?: string; name: string; identifier: string }
  /** Adhar project slug → Plane project id, overriding the name match. */
  projectMap: Record<string, string>
  evidence: EvidenceLimits
  /** A recurrence while the ticket is open comments at most this often. */
  commentCooldownMinutes: number
  /** Move the ticket to the project's completed state when the platform reports recovery. */
  autoResolve: boolean
  /** Upload the full (redacted) evidence as a JSON attachment. */
  attachRawEvidence: boolean
}

export const DEFAULT_SUPPORT_CONFIG: SupportTicketConfig = {
  enabled: true,
  minSeverity: 'high',
  includeWarnings: true,
  alertSeverities: ['critical'],
  sources: [...INCIDENT_FAMILIES],
  defaultProject: { name: 'Platform Support', identifier: 'SUP' },
  projectMap: {},
  evidence: {
    logLines: 200,
    windowMinutes: 60,
    traceLimit: 5,
    eventLimit: 20,
    queryTimeoutMs: 8_000,
    maxSectionBytes: 24_000,
  },
  commentCooldownMinutes: 30,
  autoResolve: true,
  attachRawEvidence: true,
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt
}
const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt)
const isSeverity = (v: unknown): v is Severity => typeof v === 'string' && v in SEVERITY_RANK

/** Merge a stored (partial, untrusted) document over the defaults. Pure. */
export function mergeSupportConfig(raw: unknown): SupportTicketConfig {
  const d = DEFAULT_SUPPORT_CONFIG
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const ev = (r.evidence && typeof r.evidence === 'object' ? r.evidence : {}) as Record<string, unknown>
  const dp = (r.defaultProject && typeof r.defaultProject === 'object' ? r.defaultProject : {}) as Record<string, unknown>
  const families = new Set<string>(INCIDENT_FAMILIES)
  const sources = Array.isArray(r.sources)
    ? (r.sources.filter((s) => typeof s === 'string' && families.has(s)) as IncidentFamily[])
    : [...d.sources]
  const identifier = typeof dp.identifier === 'string' && /^[A-Z0-9]{1,12}$/.test(dp.identifier.toUpperCase())
    ? dp.identifier.toUpperCase()
    : d.defaultProject.identifier
  const projectMap: Record<string, string> = {}
  if (r.projectMap && typeof r.projectMap === 'object') {
    for (const [k, v] of Object.entries(r.projectMap as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) projectMap[k] = v.trim()
    }
  }
  return {
    enabled: bool(r.enabled, d.enabled),
    minSeverity: isSeverity(r.minSeverity) ? r.minSeverity : d.minSeverity,
    includeWarnings: bool(r.includeWarnings, d.includeWarnings),
    alertSeverities: Array.isArray(r.alertSeverities)
      ? r.alertSeverities.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase())
      : [...d.alertSeverities],
    sources,
    defaultProject: {
      ...(typeof dp.id === 'string' && dp.id.trim() ? { id: dp.id.trim() } : {}),
      name: typeof dp.name === 'string' && dp.name.trim() ? dp.name.trim().slice(0, 80) : d.defaultProject.name,
      identifier,
    },
    projectMap,
    evidence: {
      logLines: clamp(ev.logLines, 0, 1000, d.evidence.logLines),
      windowMinutes: clamp(ev.windowMinutes, 5, 24 * 60, d.evidence.windowMinutes),
      traceLimit: clamp(ev.traceLimit, 0, 50, d.evidence.traceLimit),
      eventLimit: clamp(ev.eventLimit, 0, 100, d.evidence.eventLimit),
      queryTimeoutMs: clamp(ev.queryTimeoutMs, 1_000, 30_000, d.evidence.queryTimeoutMs),
      maxSectionBytes: clamp(ev.maxSectionBytes, 2_000, 200_000, d.evidence.maxSectionBytes),
    },
    commentCooldownMinutes: clamp(r.commentCooldownMinutes, 0, 7 * 24 * 60, d.commentCooldownMinutes),
    autoResolve: bool(r.autoResolve, d.autoResolve),
    attachRawEvidence: bool(r.attachRawEvidence, d.attachRawEvidence),
  }
}

/** The tenant's configuration; defaults when unsaved or unreadable. Never throws. */
export async function loadSupportConfig(
  store: { get<T>(kind: string, id: string): Promise<{ data: T } | null> },
): Promise<SupportTicketConfig> {
  try {
    const doc = await store.get<Record<string, unknown>>(SUPPORT_CONFIG_KIND, SUPPORT_CONFIG_ID)
    return mergeSupportConfig(doc?.data)
  } catch {
    return mergeSupportConfig(undefined)
  }
}
