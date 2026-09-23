import { env } from '@adhar-console/utils'
import { openStore } from './workspace/store.ts'
import { emitNotification, type NotificationDoc } from './notify.ts'

/**
 * `POST /api/alerts/alertmanager` — the platform's Alertmanager receiver.
 *
 * Until this existed, Alertmanager's route was the chart default: every alert on
 * the platform — CIS findings, budget breaches, backup failures, a node under
 * memory pressure — was delivered to a receiver literally named `null`. The
 * rules were written, evaluated, fired, and discarded. "Incident response is in
 * the box" (ADR-0021) was a config file that ended in /dev/null.
 *
 * This turns each alert into a Notification Center entry visible to the whole
 * tenant, so the page called "Notifications & Insights" carries what the
 * platform is actually alerting on. A firing alert becomes a warning/error; its
 * resolution becomes a `success` entry so the timeline shows both edges.
 *
 * AUTHENTICATION is a shared bearer token, not a session: Alertmanager is not a
 * user. The token lives in the `alertmanager-console-webhook` Secret (minted by
 * an ESO Password generator in the kube-prometheus package) and reaches both
 * sides by reference — Alertmanager reads it from a mounted file, this server
 * from `ALERTMANAGER_WEBHOOK_TOKEN`. Neither has it in git. With the variable
 * unset the endpoint refuses everything rather than accepting anything: an open
 * ingest would let any pod in the cluster write to every user's notifications.
 *
 * DE-DUPLICATION uses the alert's fingerprint as the notification `key`, so a
 * repeat_interval re-delivery updates the existing entry instead of stacking a
 * new one every 12 hours for as long as the condition holds.
 */

/** Alertmanager webhook payload (version 4). */
interface AlertmanagerPayload {
  version?: string
  status?: 'firing' | 'resolved'
  receiver?: string
  groupLabels?: Record<string, string>
  commonLabels?: Record<string, string>
  externalURL?: string
  alerts?: AmAlert[]
}

interface AmAlert {
  status?: 'firing' | 'resolved'
  labels?: Record<string, string>
  annotations?: Record<string, string>
  startsAt?: string
  endsAt?: string
  generatorURL?: string
  fingerprint?: string
}

const MAX_ALERTS_PER_POST = 200

function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? ''
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : ''
}

/** Constant-time compare so the token cannot be recovered byte by byte. */
function tokenMatches(presented: string, expected: string): boolean {
  if (!presented || !expected || presented.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/** Map Alertmanager severity to the Notification Center's level + severity. */
export function levelOf(a: AmAlert): { kind: NotificationDoc['kind']; severity: NotificationDoc['severity'] } {
  if (a.status === 'resolved') return { kind: 'success', severity: undefined }
  const s = (a.labels?.severity ?? '').toLowerCase()
  switch (s) {
    case 'critical':
      return { kind: 'error', severity: 'critical' }
    case 'warning':
      return { kind: 'warning', severity: 'high' }
    case 'info':
      return { kind: 'info', severity: 'low' }
    default:
      return { kind: 'warning', severity: 'medium' }
  }
}

/**
 * The source bucket the Notification Center filters on. Derived from the
 * rule's own labels where the platform sets them (`adhar_component`), else from
 * the alert name, so a cost alert files under the same heading as the page that
 * explains it.
 */
export function sourceOf(a: AmAlert): NotificationDoc['source'] {
  const comp = (a.labels?.adhar_component ?? '').toLowerCase()
  const name = (a.labels?.alertname ?? '').toLowerCase()
  if (comp.includes('cost') || name.includes('budget')) return 'platform'
  if (comp.includes('policy') || name.includes('kyverno') || name.includes('policy')) return 'policy'
  if (comp.includes('security') || name.includes('cve') || name.includes('vulnerab')) return 'security'
  if (name.includes('argo') || name.includes('sync')) return 'gitops'
  return 'system'
}

/** One notification per alert. Exported for tests; no I/O. */
export function toNotification(a: AmAlert, externalURL?: string): NotificationDoc {
  const name = a.labels?.alertname ?? 'Alert'
  const ns = a.labels?.namespace
  const resolved = a.status === 'resolved'
  const { kind, severity } = levelOf(a)
  const summary = a.annotations?.summary ?? a.annotations?.description ?? name
  const title = `${resolved ? 'Resolved: ' : ''}${summary}`.slice(0, 200)
  const lines: string[] = []
  if (a.annotations?.description && a.annotations.description !== summary) lines.push(a.annotations.description)
  if (ns) lines.push(`Namespace: ${ns}`)
  if (a.annotations?.runbook_url) lines.push(`Runbook: ${a.annotations.runbook_url}`)
  return {
    kind,
    source: sourceOf(a),
    title,
    description: lines.join('\n').slice(0, 2000) || undefined,
    href: a.generatorURL || externalURL || undefined,
    // Fingerprint identifies the alert instance across re-deliveries; the
    // status suffix keeps "firing" and "resolved" as two entries, which is the
    // timeline a person wants to see.
    key: a.fingerprint ? `alertmanager:${a.fingerprint}:${resolved ? 'resolved' : 'firing'}` : undefined,
    severity,
    actor: { id: 'alertmanager', label: 'Alertmanager' },
    target: ns ? { type: 'namespace', id: ns, label: ns } : { type: 'alert', id: name, label: name },
    // No audience: platform alerts are for everyone in the tenant.
    at: (resolved ? a.endsAt : a.startsAt) || new Date().toISOString(),
  }
}

export async function handleAlertmanagerWebhook(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const expected = env('ALERTMANAGER_WEBHOOK_TOKEN') ?? ''
  if (!expected) {
    // Refuse rather than accept: see the header.
    return Response.json({ error: 'webhook_not_configured' }, { status: 503 })
  }
  if (!tokenMatches(bearer(req), expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let payload: AlertmanagerPayload
  try {
    payload = (await req.json()) as AlertmanagerPayload
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const alerts = (payload.alerts ?? []).slice(0, MAX_ALERTS_PER_POST)
  if (!alerts.length) return Response.json({ ok: true, created: 0 })

  // Platform alerts belong to the shared space, which is what every session
  // falls back to when it has no tenant of its own (request-user.ts).
  const store = await openStore(env('ALERTMANAGER_TENANT') ?? 'default')
  if (!store) return Response.json({ ok: false, error: 'store_unavailable' }, { status: 503 })

  let created = 0
  for (const a of alerts) {
    // Watchdog is Alertmanager's own "I am alive" heartbeat; it is not news.
    if (a.labels?.alertname === 'Watchdog') continue
    const id = await emitNotification(store, toNotification(a, payload.externalURL), 'alertmanager')
    if (id) created++
  }
  return Response.json({ ok: true, received: alerts.length, created })
}
