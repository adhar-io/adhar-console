import { env } from '@adhar/utils'
import type { NotificationDoc } from '../notify.ts'
import { openStore } from '../workspace/store.ts'
import { toolPublicUrl } from '../domain.ts'
import { classify, type Origin } from './classify.ts'
import { DEFAULT_SUPPORT_CONFIG, loadSupportConfig } from './config.ts'
import { collectEvidence } from './evidence.ts'
import { clusterBackends, linkBases } from './backends.ts'
import { planeApiFromEnv } from './plane.ts'
import { BoundedQueue } from './queue.ts'
import { type Outcome, PlaneCatalog, processDecision } from './tickets.ts'

/**
 * Automatic support tickets — the entry point the notification pipeline
 * calls. `observeNotification` is synchronous, cheap and cannot throw: it
 * drops what can never matter (user notes, info) and queues the rest; all the
 * work — config, classification, evidence, Plane — happens on the queue's one
 * worker, off the watcher's path.
 */

export interface ObservedNotification {
  tenant: string
  notificationId: string | null
  doc: NotificationDoc
  /** False when `emitNotification` collapsed it onto an existing notification. */
  created: boolean
  origin: Origin
}

interface Job extends ObservedNotification {}

let catalog: PlaneCatalog | null = null
let warnedNoPlane = false

async function runJob(job: Job): Promise<Outcome> {
  const store = await openStore(job.tenant)
  if (!store) return { outcome: 'noop', reason: 'no database' }
  const config = await loadSupportConfig(store)
  const decision = classify(job.doc, job.origin, config)
  if (decision.action === 'ignore') return { outcome: 'noop', reason: decision.reason }
  const plane = planeApiFromEnv(env, safePublic())
  if (!plane) {
    if (!warnedNoPlane) {
      warnedNoPlane = true
      console.log('[support] Plane is not configured (PLANE_URL / PLANE_TOKEN) — support tickets are off')
    }
    return { outcome: 'noop', reason: 'Plane is not configured (PLANE_URL / PLANE_TOKEN)' }
  }
  catalog ??= new PlaneCatalog(plane)
  const backends = clusterBackends(config.evidence.queryTimeoutMs)
  const links = linkBases()
  return processDecision(
    {
      store,
      plane,
      catalog,
      config,
      collect: (ref, doc) => collectEvidence(ref, doc, config.evidence, backends, links),
      now: Date.now,
      log: (m) => console.warn(`[support] ${m}`),
    },
    { notificationId: job.notificationId ?? undefined, doc: job.doc, decision, created: job.created, manual: job.origin === 'manual' },
  )
}

function safePublic(): string {
  try {
    return toolPublicUrl('plane', 'PLANE_URL')
  } catch {
    return ''
  }
}

const queue = new BoundedQueue<Job>(runJob, Number(env('SUPPORT_TICKET_QUEUE') ?? 200))

/**
 * Hand a freshly emitted platform / Alertmanager notification to the ticket
 * pipeline. Never throws, never awaits.
 */
export function observeNotification(n: ObservedNotification): void {
  try {
    if (!n.notificationId) return
    if (env('ADHAR_SUPPORT_TICKETS_DISABLED') === 'true') return
    if (n.doc.source === 'workspace' || n.doc.source === 'user') return
    if (n.doc.kind === 'info' || n.doc.kind === 'insight') return
    // A success only matters if it is a recovery some incident could be open
    // for; checking that here keeps every "build succeeded" off the queue.
    if (n.doc.kind === 'success' && classify(n.doc, n.origin, DEFAULT_SUPPORT_CONFIG).action !== 'resolve') return
    queue.push(n)
  } catch (e) {
    console.warn('[support] observe failed:', e)
  }
}

/** The manual "Create support ticket" action: same pipeline, awaited. */
export function createTicketFor(tenant: string, notificationId: string, doc: NotificationDoc): Promise<Outcome> {
  return queue.run<Outcome>({ tenant, notificationId, doc, created: true, origin: 'manual' })
}

export function supportStatus() {
  return {
    planeConfigured: Boolean(env('PLANE_TOKEN')),
    disabled: env('ADHAR_SUPPORT_TICKETS_DISABLED') === 'true',
    queue: { depth: queue.depth, processed: queue.processed, failed: queue.failed, dropped: queue.dropped },
    lastError: queue.lastError,
  }
}
