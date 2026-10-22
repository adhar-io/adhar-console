import { NOTIFICATION_KIND, type NotificationDoc } from '../notify.ts'
import type { SupportTicketConfig } from './config.ts'
import type { Decision, IncidentRef } from './classify.ts'
import type { Evidence } from './evidence.ts'
import type { PlaneApi, PlaneLabel, PlaneProject, PlaneState } from './plane.ts'
import { descriptionHtml, labelNamesOf, priorityOf, recurrenceCommentHtml, resolutionCommentHtml, titleOf } from './render.ts'

/**
 * The ticket lifecycle: one Plane work item per incident, for as long as the
 * incident lasts.
 *
 *   first failure        → a work item with the evidence
 *   recurrence, open     → a comment with fresh evidence (at most one per cooldown)
 *   recovery reported    → a resolution comment, and the item moves to the
 *                          project's completed state
 *   failure after that   → a NEW work item that links the resolved one
 *
 * The incident → work item mapping is the `console.support-incident` document
 * kind (server-owned: `console.*` is reserved in /api/store), one document per
 * incident id. Every notification that touched a ticket is annotated with
 * `ticket: {key, url, state}` so the Notification Center links to it.
 */

export const INCIDENT_KIND = 'console.support-incident'

export interface IncidentRecord {
  incidentId: string
  family: string
  state: 'open' | 'resolved'
  projectId: string
  issueId: string
  key?: string
  url?: string
  title: string
  openedAt: string
  lastSeenAt: string
  occurrences: number
  lastCommentAt?: string
  resolvedAt?: string
  notificationIds: string[]
  previous?: { issueId: string; key?: string; url?: string; resolvedAt?: string }
  [k: string]: unknown
}

export interface TicketRef { incidentId: string; issueId: string; projectId: string; key?: string; url?: string; state: 'open' | 'resolved' }

export type Outcome =
  | { outcome: 'created'; ticket: TicketRef }
  | { outcome: 'commented'; ticket: TicketRef }
  | { outcome: 'exists'; ticket: TicketRef }
  | { outcome: 'suppressed'; ticket: TicketRef; reason: string }
  | { outcome: 'resolved'; tickets: TicketRef[] }
  | { outcome: 'noop'; reason: string }

/** The store surface used here (the real `Store` satisfies it; tests pass a map). */
export interface StoreLike {
  get<T>(kind: string, id: string): Promise<{ data: T } | null>
  put<T extends Record<string, unknown>>(kind: string, id: string, data: T, userId: string): Promise<unknown>
  query<T>(kind: string, q: { equals?: Array<{ path: string; value: unknown }>; limit: number; offset: number }): Promise<{ items: Array<{ id: string; data: T }>; total: number }>
}

export interface TicketDeps {
  store: StoreLike
  plane: PlaneApi
  catalog: PlaneCatalog
  config: SupportTicketConfig
  collect(ref: IncidentRef, doc: NotificationDoc): Promise<Evidence>
  now(): number
  log(msg: string): void
}

/* ─────────────────────────── Plane catalog (projects, states, labels) ─────────────────────────── */

const CATALOG_TTL_MS = 5 * 60_000
const LABEL_COLORS: Record<string, string> = { incident: '#dc2626', source: '#7c3aed', env: '#0891b2', app: '#2563eb' }

/**
 * Plane metadata the lifecycle needs on every ticket, cached so a burst of
 * incidents does not spend the rate limit re-listing projects and labels.
 */
export class PlaneCatalog {
  private projects?: { at: number; rows: PlaneProject[] }
  private states = new Map<string, { at: number; rows: PlaneState[] }>()
  private labels = new Map<string, { at: number; rows: PlaneLabel[] }>()
  constructor(private readonly plane: PlaneApi, private readonly now: () => number = Date.now) {}

  async listProjects(): Promise<PlaneProject[]> {
    if (this.projects && this.now() - this.projects.at < CATALOG_TTL_MS) return this.projects.rows
    const rows = await this.plane.listProjects()
    this.projects = { at: this.now(), rows }
    return rows
  }

  async createProject(body: { name: string; identifier: string; description?: string }): Promise<PlaneProject> {
    const p = await this.plane.createProject(body)
    this.projects = { at: this.now(), rows: [...(this.projects?.rows ?? []), p] }
    return p
  }

  async completedState(project: string): Promise<PlaneState | undefined> {
    let c = this.states.get(project)
    if (!c || this.now() - c.at >= CATALOG_TTL_MS) {
      c = { at: this.now(), rows: await this.plane.listStates(project) }
      this.states.set(project, c)
    }
    return c.rows.find((s) => s.group === 'completed')
  }

  /** Ids for these label names, creating the missing ones. Best effort: a label Plane refuses is skipped. */
  async labelIds(project: string, names: string[]): Promise<string[]> {
    let c = this.labels.get(project)
    if (!c || this.now() - c.at >= CATALOG_TTL_MS) {
      c = { at: this.now(), rows: await this.plane.listLabels(project) }
      this.labels.set(project, c)
    }
    const ids: string[] = []
    for (const name of names) {
      let l = c.rows.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (!l) {
        try {
          l = await this.plane.createLabel(project, { name, color: LABEL_COLORS[name.split(':')[0]] ?? '#64748b' })
          c.rows.push(l)
        } catch {
          continue
        }
      }
      ids.push(l.id)
    }
    return ids
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

/** Store id for an incident — a hash, so any incident id fits the store's id rules. */
export async function incidentDocId(incidentId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(incidentId))
  return `inc-${[...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const refOf = (r: IncidentRecord): TicketRef => ({ incidentId: r.incidentId, issueId: r.issueId, projectId: r.projectId, key: r.key, url: r.url, state: r.state })

/**
 * The Plane project an incident is filed in:
 *   1. the configured mapping for the incident's Adhar project,
 *   2. the project the Design module was pointed at for it (`design.settings`),
 *   3. a Plane project whose identifier or name matches the Adhar project,
 *   4. the default project — by configured id, else by identifier/name, else
 *      created (`Platform Support` / `SUP`).
 */
export async function resolveProject(deps: TicketDeps, adharProject?: string): Promise<PlaneProject> {
  const { config: cfg, catalog } = deps
  const projects = await catalog.listProjects()
  const byId = (id?: string) => (id ? projects.find((p) => p.id === id) : undefined)
  if (adharProject) {
    const mapped = byId(cfg.projectMap[adharProject])
    if (mapped) return mapped
    try {
      const design = await deps.store.get<{ planeProjectId?: string }>('design.settings', adharProject)
      const chosen = byId(design?.data.planeProjectId)
      if (chosen) return chosen
    } catch {
      // no design settings — fall through
    }
    const n = norm(adharProject)
    const match = projects.find((p) => norm(p.identifier) === n || norm(p.name) === n)
    if (match) return match
  }
  const d = cfg.defaultProject
  const dflt = byId(d.id) ??
    projects.find((p) => p.identifier.toUpperCase() === d.identifier) ??
    projects.find((p) => norm(p.name) === norm(d.name))
  if (dflt) return dflt
  return catalog.createProject({
    name: d.name,
    identifier: d.identifier,
    description: 'Incidents raised automatically by Adhar Console from platform failure signals, with their logs, metrics, traces and delivery context.',
  })
}

async function annotate(deps: TicketDeps, notificationId: string | undefined, ticket: TicketRef): Promise<void> {
  if (!notificationId) return
  try {
    const n = await deps.store.get<NotificationDoc>(NOTIFICATION_KIND, notificationId)
    if (!n) return
    await deps.store.put(NOTIFICATION_KIND, notificationId, { ...n.data, ticket: { key: ticket.key, url: ticket.url, state: ticket.state } }, 'system')
  } catch (e) {
    deps.log(`could not link notification ${notificationId} to ${ticket.key ?? ticket.issueId}: ${e instanceof Error ? e.message : e}`)
  }
}

/* ─────────────────────────── lifecycle ─────────────────────────── */

export interface ProcessInput {
  notificationId?: string
  doc: NotificationDoc
  decision: Decision
  /** False when `emitNotification` de-duplicated the notification onto an existing one. */
  created: boolean
  manual?: boolean
}

export async function processDecision(deps: TicketDeps, input: ProcessInput): Promise<Outcome> {
  const { decision } = input
  if (decision.action === 'ignore') return { outcome: 'noop', reason: decision.reason }
  if (decision.action === 'resolve') return resolve(deps, input, decision.ref, decision.prefix)
  return open(deps, input, decision.ref)
}

async function open(deps: TicketDeps, input: ProcessInput, ref: IncidentRef): Promise<Outcome> {
  const { store, plane, config: cfg } = deps
  const id = await incidentDocId(ref.incidentId)
  const existing = (await store.get<IncidentRecord>(INCIDENT_KIND, id))?.data
  const nowIso = new Date(deps.now()).toISOString()

  if (existing?.state === 'open') {
    const rec: IncidentRecord = {
      ...existing,
      lastSeenAt: nowIso,
      occurrences: existing.occurrences + (input.created ? 1 : 0),
      notificationIds: input.notificationId && !existing.notificationIds.includes(input.notificationId)
        ? [...existing.notificationIds, input.notificationId].slice(-50)
        : existing.notificationIds,
    }
    const ticket = refOf(rec)
    if (input.manual) {
      await store.put(INCIDENT_KIND, id, rec, 'system')
      await annotate(deps, input.notificationId, ticket)
      return { outcome: 'exists', ticket }
    }
    const last = Date.parse(existing.lastCommentAt ?? existing.openedAt)
    const cooling = deps.now() - last < cfg.commentCooldownMinutes * 60_000
    if (!input.created || cooling) {
      await store.put(INCIDENT_KIND, id, rec, 'system')
      await annotate(deps, input.notificationId, ticket)
      return { outcome: 'suppressed', ticket, reason: !input.created ? 'duplicate notification' : 'comment cooldown' }
    }
    const ev = await deps.collect(ref, input.doc)
    await plane.createComment(rec.projectId, rec.issueId, recurrenceCommentHtml(input.doc, ev, rec.occurrences))
    rec.lastCommentAt = nowIso
    await store.put(INCIDENT_KIND, id, rec, 'system')
    await annotate(deps, input.notificationId, ticket)
    return { outcome: 'commented', ticket }
  }

  // A new ticket — the first for this incident, or a recurrence after resolution.
  const ev = await deps.collect(ref, input.doc)
  const project = await resolveProject(deps, ev.subject.project)
  const labels = await deps.catalog.labelIds(project.id, labelNamesOf(ref, ev)).catch(() => [] as string[])
  const previous = existing?.state === 'resolved'
    ? { issueId: existing.issueId, key: existing.key, url: existing.url, resolvedAt: existing.resolvedAt }
    : undefined
  const issue = await plane.createIssue(project.id, {
    name: titleOf(input.doc),
    description_html: descriptionHtml(input.doc, ref, ev, { maxSectionBytes: cfg.evidence.maxSectionBytes, previous, attached: cfg.attachRawEvidence }),
    priority: priorityOf(input.doc),
    labels,
  })
  const rec: IncidentRecord = {
    incidentId: ref.incidentId,
    family: ref.family,
    state: 'open',
    projectId: project.id,
    issueId: issue.id,
    key: issue.sequence_id !== undefined ? `${project.identifier}-${issue.sequence_id}` : undefined,
    url: plane.issueUrl(project.id, issue.id) || undefined,
    title: titleOf(input.doc),
    openedAt: nowIso,
    lastSeenAt: nowIso,
    occurrences: 1,
    notificationIds: input.notificationId ? [input.notificationId] : [],
    previous,
  }
  // Persist the mapping before the optional extras, so a failure in them
  // can never produce a second ticket for the same incident.
  await store.put(INCIDENT_KIND, id, rec, 'system')
  if (previous && existing && existing.projectId === project.id) {
    await plane.relate(project.id, issue.id, previous.issueId).catch((e) => deps.log(`relation to ${previous.key ?? previous.issueId} failed: ${e instanceof Error ? e.message : e}`))
  }
  if (cfg.attachRawEvidence) {
    const bytes = new TextEncoder().encode(JSON.stringify({ incident: ref, notification: { ...input.doc, prompt: undefined }, evidence: ev }, null, 2))
    await plane.attach(project.id, issue.id, { name: `evidence-${nowIso.replace(/[:.]/g, '-')}.json`, type: 'application/json', bytes })
      .catch((e) => deps.log(`evidence attachment for ${rec.key ?? issue.id} failed (the ticket body still carries the trimmed evidence): ${e instanceof Error ? e.message : e}`))
  }
  const ticket = refOf(rec)
  await annotate(deps, input.notificationId, ticket)
  return { outcome: 'created', ticket }
}

async function resolve(deps: TicketDeps, input: ProcessInput, ref: IncidentRef, prefix?: string): Promise<Outcome> {
  const { store, plane, config: cfg } = deps
  const records: Array<{ id: string; data: IncidentRecord }> = []
  if (prefix) {
    const page = await store.query<IncidentRecord>(INCIDENT_KIND, { equals: [{ path: 'state', value: 'open' }], limit: 200, offset: 0 })
    records.push(...page.items.filter((r) => r.data.incidentId.startsWith(prefix)))
  } else {
    const id = await incidentDocId(ref.incidentId)
    const r = await store.get<IncidentRecord>(INCIDENT_KIND, id)
    if (r?.data.state === 'open') records.push({ id, data: r.data })
  }
  if (!records.length) return { outcome: 'noop', reason: 'no open ticket for this incident' }

  const done: TicketRef[] = []
  for (const { id, data } of records) {
    const completed = cfg.autoResolve ? await deps.catalog.completedState(data.projectId).catch(() => undefined) : undefined
    await plane.createComment(data.projectId, data.issueId, resolutionCommentHtml(input.doc, Boolean(completed)))
    if (completed) await plane.updateIssue(data.projectId, data.issueId, { state: completed.id })
    const rec: IncidentRecord = cfg.autoResolve
      ? { ...data, state: 'resolved', resolvedAt: new Date(deps.now()).toISOString() }
      : { ...data, lastCommentAt: new Date(deps.now()).toISOString() }
    await store.put(INCIDENT_KIND, id, rec, 'system')
    done.push(refOf(rec))
  }
  if (done.length === 1) await annotate(deps, input.notificationId, done[0])
  return { outcome: 'resolved', tickets: done }
}
