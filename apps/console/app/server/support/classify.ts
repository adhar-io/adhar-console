import type { NotificationDoc } from '../notify.ts'
import { type IncidentFamily, SEVERITY_RANK, type Severity, type SupportTicketConfig } from './config.ts'

/**
 * Which notifications are incidents, which are recoveries, and what ONE
 * incident is.
 *
 * A notification's `key` names one transition of one object (`argocd:<ns>/<app>:Degraded/Synced`),
 * which is right for de-duplicating a feed and wrong for a ticket: the ticket
 * is about the THING, across every transition until it recovers. So each
 * family below maps a key to an `incidentId` that drops the state — the Argo
 * CD app, the rollout, the (namespace, app) a pipeline builds, the stage being
 * verified — and recognises the success notification that says the same thing
 * is healthy again.
 *
 * The key grammar is owned by the event sources (`events/*-sources.ts`,
 * `alertmanager.ts`); `classify_test.ts` runs the REAL source functions over
 * fixtures and parses what they emit, so a source that changes its key format
 * fails a test here instead of silently opening a ticket per transition.
 */

export type Origin = 'platform-watcher' | 'alertmanager' | 'manual'

export interface IncidentRef {
  family: IncidentFamily
  /** The key prefix the notification came from (`argocd`, `argocd-sync`, …). */
  source: string
  /** Stable identity of the incident — the ticket's de-dup key. */
  incidentId: string
  /** Namespace of the object the notification is about. */
  namespace?: string
  /** Name of that object. */
  name?: string
  /** Its kind (`Application`, `Rollout`, `PipelineRun`, `Pod`, an XR kind …). */
  objectKind?: string
  /** Application / environment / Kargo stage when the notification names them. */
  app?: string
  env?: string
  /** Free-form extras the evidence collector uses (alert labels, platform name). */
  extra?: Record<string, string>
}

export type Decision =
  | { action: 'open'; ref: IncidentRef }
  | { action: 'resolve'; ref: IncidentRef; /** Resolve every open incident whose id starts with this, instead of one id. */ prefix?: string }
  | { action: 'ignore'; reason: string }

const PAIR = /^([^/]+)\/([^:]+)$/

/** `gateway-service-689ffd8cf6-7kj2j` → `gateway-service`; `db-1` → `db`; anything else unchanged. */
export function workloadOfPod(name: string): string {
  return name.match(/^(.+)-[a-z0-9]{6,10}-[a-z0-9]{5}$/)?.[1] ??
    name.match(/^(.+)-\d+$/)?.[1] ??
    name.match(/^(.+)-[a-z0-9]{5}$/)?.[1] ??
    name
}

/** `qua-service (dev)` → { app: qua-service, env: dev }. */
function appEnvOfLabel(label?: string): { app?: string; env?: string } {
  const m = label?.match(/^(.+?) \(([^)]+)\)$/)
  return m ? { app: m[1], env: m[2] } : { app: label }
}

/**
 * Parse a notification into the incident it is about. Null when the
 * notification is not about a failure-capable object (freight discovered, a
 * user note) or its key is not one this module understands.
 */
export function parseRef(doc: Pick<NotificationDoc, 'key' | 'target' | 'title'> & Record<string, unknown>): IncidentRef | null {
  const key = doc.key ?? ''
  const prefix = key.slice(0, key.indexOf(':'))
  const rest = key.slice(prefix.length + 1)
  const label = doc.target?.label

  switch (prefix) {
    case 'argocd':
    case 'argocd-sync': {
      const m = rest.match(/^([^/]+)\/([^:]+):/)
      if (!m) return null
      return { family: 'argocd', source: prefix, incidentId: `argocd:${m[1]}/${m[2]}`, namespace: m[1], name: m[2], objectKind: 'Application', ...appEnvOfLabel(label) }
    }
    case 'rollout': {
      const m = rest.match(/^([^/]+)\/([^:]+):/)
      if (!m) return null
      const [app, env] = (label ?? '').split(' · ')
      return { family: 'rollout', source: prefix, incidentId: `rollout:${m[1]}/${m[2]}`, namespace: m[1], name: m[2], objectKind: 'Rollout', app: app || m[2], env: env || m[1] }
    }
    case 'tekton': {
      const m = rest.match(/^([^/]+)\/([^:]+):/)
      if (!m) return null
      // One incident per (namespace, thing being built): every run of the same
      // app's pipeline is the same problem until one succeeds.
      const subject = label?.includes(' · ') ? label.split(' · ')[0] : m[2]
      return { family: 'tekton', source: prefix, incidentId: `tekton:${m[1]}/${subject}`, namespace: m[1], name: m[2], objectKind: 'PipelineRun', app: label?.includes(' · ') ? subject : undefined }
    }
    case 'event': {
      // event:<ns>/<Kind>/<name>:<reason>:<bucket>
      const m = rest.match(/^([^/]+)\/([^/]+)\/([^:]+):([^:]+):/)
      if (!m) return null
      const [, ns, kind, name, reason] = m
      const workload = kind === 'Pod' ? workloadOfPod(name) : name
      return { family: 'event', source: prefix, incidentId: `event:${ns}/${kind}/${workload}`, namespace: ns, name, objectKind: kind, app: workload, extra: { reason } }
    }
    case 'kargo-promotion': {
      const m = rest.match(/^([^/]+)\/([^:]+):/)
      if (!m) return null
      const [app, stage] = (label ?? '').split(' → ')
      return { family: 'kargo-promotion', source: prefix, incidentId: `kargo-promotion:${m[1]}/${app ?? '?'}->${stage ?? '?'}`, namespace: m[1], name: m[2], objectKind: 'Promotion', app, env: stage }
    }
    case 'kargo-verification': {
      const m = rest.match(/^([^/]+)\/([^:]+):/)
      if (!m) return null
      const app = label?.includes(' · ') ? label.split(' · ')[0] : undefined
      return { family: 'kargo-verification', source: prefix, incidentId: `kargo-verification:${m[1]}/${m[2]}`, namespace: m[1], name: m[2], objectKind: 'Stage', app, env: m[2] }
    }
    case 'xr': {
      // xr:<Kind>:<ns>/<name>:<uid>:<state>
      const m = rest.match(/^([^:]+):([^/]+)\/([^:]+):/)
      if (!m) return null
      return { family: 'xr', source: prefix, incidentId: `xr:${m[1]}:${m[2]}/${m[3]}`, namespace: m[2], name: m[3], objectKind: m[1] }
    }
    case 'autoscaler': {
      const m = rest.match(/^([^:]+):([^:]+):/)
      if (!m) return null
      const direction = /down/i.test(m[2]) ? 'scale-down' : 'scale-up'
      return { family: 'autoscaler', source: prefix, incidentId: `autoscaler:${m[1]}:${direction}`, name: m[1], objectKind: 'AdharPlatform', namespace: 'adhar-system', extra: { reason: m[2] } }
    }
    case 'resilience-gate': {
      const m = rest.match(/^(.+):(passed|failed)$/)
      if (!m) return null
      const app = doc.target?.id ?? m[1]
      return { family: 'resilience-gate', source: prefix, incidentId: `resilience-gate:${app}`, namespace: 'adhar-system', name: m[1], objectKind: 'Job', app }
    }
    case 'node': {
      const name = rest.split(':')[0]
      return { family: 'autoscaler', source: prefix, incidentId: `node:${name}`, name, objectKind: 'Node' }
    }
    case 'alertmanager': {
      const m = rest.match(/^([^:]+):(firing|resolved)$/)
      if (!m) return null
      const labels = (doc.alert as { labels?: Record<string, string> } | undefined)?.labels ?? {}
      const ns = labels.namespace ?? (doc.target?.type === 'namespace' ? doc.target.id : undefined)
      return {
        family: 'alertmanager',
        source: prefix,
        incidentId: `alertmanager:${m[1]}`,
        namespace: ns,
        name: labels.pod ?? labels.deployment ?? labels.statefulset ?? labels.job_name ?? labels.alertname,
        objectKind: labels.pod ? 'Pod' : labels.deployment ? 'Deployment' : labels.statefulset ? 'StatefulSet' : labels.job_name ? 'Job' : undefined,
        app: labels.app ?? labels.service ?? labels.deployment ?? labels.statefulset,
        extra: { ...labels },
      }
    }
    default:
      return null
  }
}

/** Is this success notification the all-clear for its incident? */
function recovery(doc: NotificationDoc, ref: IncidentRef): Decision | null {
  if (doc.kind !== 'success') return null
  switch (ref.source) {
    // Synced + Healthy is the all-clear; a successful SYNC of an app that is
    // still degraded is not.
    case 'argocd':
    case 'rollout':
    case 'tekton':
    case 'kargo-verification':
    case 'kargo-promotion':
    case 'xr':
    case 'resilience-gate':
    case 'alertmanager':
      return { action: 'resolve', ref }
    // A node joining is what a stuck scale-up was waiting for.
    case 'node':
      return { action: 'resolve', ref, prefix: 'autoscaler:' }
    default:
      return null
  }
}

/**
 * Decide what a notification means for tickets. Pure.
 *
 *   resolve — a success notification about something an incident may be open for
 *   open    — a failure at or above the configured severity from an allowed family
 *   ignore  — everything else, with the reason (for the manual endpoint and logs)
 *
 * `manual` (somebody pressed "Create support ticket") skips the enable switch,
 * the allowlist and the severity floor — a person decided — but never turns a
 * success into a ticket.
 */
export function classify(doc: NotificationDoc, origin: Origin, cfg: SupportTicketConfig): Decision {
  if (doc.source === 'workspace' || doc.source === 'user') return { action: 'ignore', reason: 'user-created notification' }
  const ref = parseRef(doc)
  if (ref) {
    const rec = recovery(doc, ref)
    if (rec) return rec
  }
  if (doc.kind === 'success' || doc.kind === 'info' || doc.kind === 'insight') return { action: 'ignore', reason: `${doc.kind} notification` }

  if (origin === 'manual') {
    return { action: 'open', ref: ref ?? manualRef(doc) }
  }
  if (!cfg.enabled) return { action: 'ignore', reason: 'support tickets are disabled' }
  if (!ref) return { action: 'ignore', reason: 'not a recognised failure signal' }
  if (ref.source === 'node') return { action: 'ignore', reason: 'node change' }
  if (!cfg.sources.includes(ref.family)) return { action: 'ignore', reason: `${ref.family} is not in the allowlist` }

  if (ref.family === 'alertmanager') {
    const sev = (ref.extra?.severity ?? '').toLowerCase()
    if (!cfg.alertSeverities.includes(sev)) return { action: 'ignore', reason: `alert severity "${sev || 'none'}" is not in the allowlist` }
    return { action: 'open', ref }
  }

  const severity: Severity = doc.severity ?? (doc.kind === 'error' ? 'high' : 'medium')
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[cfg.minSeverity]) {
    return { action: 'ignore', reason: `severity ${severity} is below ${cfg.minSeverity}` }
  }
  if (doc.kind === 'warning' && !cfg.includeWarnings) return { action: 'ignore', reason: 'warnings do not open tickets' }
  if (doc.kind !== 'error' && doc.kind !== 'warning') return { action: 'ignore', reason: `${doc.kind} notification` }
  return { action: 'open', ref }
}

/** A notification no family understands, opened by hand: one ticket per key (or target). */
function manualRef(doc: NotificationDoc): IncidentRef {
  const id = doc.key ?? (doc.target ? `${doc.target.type}:${doc.target.id}` : doc.title)
  const prefix = (doc.key ?? '').split(':')[0]
  return {
    family: 'event',
    source: prefix || 'manual',
    incidentId: `manual:${id}`.slice(0, 400),
    name: doc.target?.id,
    objectKind: doc.target?.type,
  }
}
