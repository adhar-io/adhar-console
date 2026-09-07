import type { AuditDoc, Store } from './workspace/store.ts'

/**
 * Notification emission — the ONE place that turns "something happened" into
 * a durable, per-tenant notification document. Producers:
 *
 *   • every workspace mutation (via `writeAudit` → `notifyFromAudit`)
 *   • the insights scanner (`notifications.ts` → cluster signals)
 *   • Adhar Assist (proposals / finished diagnoses, `ai/handlers.ts`)
 *   • any client through `POST /api/notifications` (`useNotifications().notify`)
 *
 * Documents live in the generic document store under `console.notification`;
 * per-user read/dismissed flags live in the `notification_state` table.
 */

export const NOTIFICATION_KIND = 'console.notification'

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error' | 'insight'
export type NotificationSource = 'workspace' | 'platform' | 'gitops' | 'policy' | 'security' | 'ai' | 'system' | 'user'

export interface NotificationDoc {
  kind: NotificationLevel
  source: NotificationSource
  title: string
  description?: string
  /** Deep link (console path or external URL). */
  href?: string
  /** Stable key for de-duplication (insights re-scan). */
  key?: string
  severity?: 'low' | 'medium' | 'high' | 'critical'
  actor?: { id: string; label: string }
  target?: { type: string; id: string; label: string }
  /** User ids allowed to see it; everyone in the tenant when omitted. */
  audience?: string[]
  /** Suggested Adhar Assist prompt ("Ask Assist"). */
  prompt?: string
  at: string
  [k: string]: unknown
}

/** Keep the newest N per tenant; older ones are pruned opportunistically. */
const RETENTION = 3000
const PRUNE_BATCH = 300
let pruneCounter = 0

export async function emitNotification(store: Store, doc: NotificationDoc, byUserId = 'system'): Promise<string | null> {
  try {
    // De-dupe keyed notifications within 6 h so a re-scan doesn't spam.
    if (doc.key) {
      const recent = await store.query<NotificationDoc>(NOTIFICATION_KIND, {
        equals: [{ path: 'key', value: doc.key }],
        range: { path: 'at', from: new Date(Date.now() - 6 * 60 * 60_000).toISOString() },
        limit: 1,
        offset: 0,
      })
      if (recent.items.length) return recent.items[0].id
    }
    const id = crypto.randomUUID()
    await store.put(NOTIFICATION_KIND, id, doc, byUserId)
    if (++pruneCounter % 50 === 0) void prune(store)
    return id
  } catch (e) {
    console.warn('[notify] failed to write notification:', e)
    return null
  }
}

async function prune(store: Store) {
  try {
    const page = await store.query<NotificationDoc>(NOTIFICATION_KIND, { limit: 1, offset: 0 })
    if (page.total <= RETENTION) return
    const oldest = await store.query<NotificationDoc>(NOTIFICATION_KIND, {
      sort: { path: 'at', direction: 'asc' },
      limit: Math.min(PRUNE_BATCH, page.total - RETENTION),
      offset: 0,
    })
    for (const d of oldest.items) await store.remove(NOTIFICATION_KIND, d.id)
  } catch {
    // best-effort
  }
}

/* ─────────── audit → notification ─────────── */

const VERB: Record<string, string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  invite: 'invited',
  revoke: 'revoked',
  rotate: 'rotated',
  approve: 'approved',
  reject: 'rejected',
  activate: 'activated',
  transfer: 'transferred',
  add: 'added',
  remove: 'removed',
  mint: 'minted',
  enable: 'enabled',
  disable: 'disabled',
  save: 'saved',
}

const HREF_BY_TYPE: Record<string, string> = {
  team: '/workspace?section=teams',
  member: '/workspace?section=members',
  invitation: '/workspace?section=members',
  role: '/workspace?section=roles',
  project: '/workspace?section=projects',
  environment: '/workspace?section=environments',
  token: '/workspace?section=tokens',
  'api-token': '/workspace?section=tokens',
  webhook: '/workspace?section=webhooks',
  approval: '/workspace?section=approvals',
  organization: '/workspace?section=organization',
  settings: '/workspace',
}

/** `team.create` + target → "Team created: Platform Engineering". */
export function notifyFromAudit(store: Store, audit: AuditDoc): Promise<string | null> {
  const [noun = 'resource', verb = 'changed'] = audit.action.split('.')
  const past = VERB[verb] ?? verb
  const label = audit.target.label || audit.target.id
  const nounLabel = noun.replace(/[-_]/g, ' ')
  const title = `${cap(nounLabel)} ${past}: ${label}`
  const failed = audit.outcome !== 'success'
  return emitNotification(
    store,
    {
      kind: failed ? 'error' : verb === 'delete' || verb === 'revoke' || verb === 'remove' ? 'warning' : 'success',
      source: 'workspace',
      title: failed ? `Failed — ${title}` : title,
      description: `${audit.actor.label} · ${audit.action}${audit.ip ? ` · ${audit.ip}` : ''}`,
      href: HREF_BY_TYPE[audit.target.type] ?? HREF_BY_TYPE[noun] ?? '/workspace?section=audit',
      actor: { id: audit.actor.id, label: audit.actor.label },
      target: audit.target,
      severity: failed ? 'high' : 'low',
      prompt: failed ? `The workspace action "${audit.action}" on ${audit.target.type} "${label}" failed. Explain likely causes and how to fix it.` : undefined,
      at: audit.at,
    },
    audit.actor.id,
  )
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
