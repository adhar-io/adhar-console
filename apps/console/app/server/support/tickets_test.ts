import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert'
import { NOTIFICATION_KIND, type NotificationDoc } from '../notify.ts'
import { classify } from './classify.ts'
import { DEFAULT_SUPPORT_CONFIG, mergeSupportConfig, type SupportTicketConfig } from './config.ts'
import type { Evidence } from './evidence.ts'
import type { PlaneApi, PlaneIssue, PlaneLabel, PlaneProject, PlaneState } from './plane.ts'
import { incidentDocId, INCIDENT_KIND, type IncidentRecord, type Outcome, PlaneCatalog, processDecision, type StoreLike, type TicketDeps } from './tickets.ts'

/**
 * The ticket lifecycle against an in-memory store and a fake Plane that
 * records every call: create → recurrence comment → resolve → re-occur as a
 * NEW ticket linking the old one, with de-duplication and cooldown in between.
 */

class MemStore implements StoreLike {
  docs = new Map<string, Record<string, unknown>>()
  get<T>(kind: string, id: string) {
    const d = this.docs.get(`${kind}/${id}`)
    return Promise.resolve(d ? { data: structuredClone(d) as T } : null)
  }
  put<T extends Record<string, unknown>>(kind: string, id: string, data: T) {
    this.docs.set(`${kind}/${id}`, structuredClone(data))
    return Promise.resolve(data)
  }
  query<T>(kind: string, q: { equals?: Array<{ path: string; value: unknown }> }) {
    const items = [...this.docs.entries()]
      .filter(([k]) => k.startsWith(`${kind}/`))
      .map(([k, d]) => ({ id: k.slice(kind.length + 1), data: d as T }))
      .filter((r) => (q.equals ?? []).every((e) => (r.data as Record<string, unknown>)[e.path] === e.value))
    return Promise.resolve({ items, total: items.length })
  }
}

class FakePlane implements PlaneApi {
  calls: string[] = []
  projects: PlaneProject[] = []
  issues: Array<PlaneIssue & { project: string; description_html: string; priority: string; labels?: string[] }> = []
  comments: Array<{ issue: string; html: string }> = []
  labels: PlaneLabel[] = []
  states: PlaneState[] = [{ id: 's-backlog', name: 'Backlog', group: 'backlog' }, { id: 's-done', name: 'Done', group: 'completed' }]
  relations: Array<[string, string]> = []
  attachments: string[] = []
  failCreate = false
  failAttach = false
  listProjects() {
    this.calls.push('listProjects')
    return Promise.resolve([...this.projects])
  }
  createProject(body: { name: string; identifier: string }) {
    this.calls.push(`createProject ${body.identifier}`)
    const p = { id: `p-${this.projects.length + 1}`, ...body }
    this.projects.push(p)
    return Promise.resolve(p)
  }
  listStates() {
    this.calls.push('listStates')
    return Promise.resolve(this.states)
  }
  listLabels() {
    this.calls.push('listLabels')
    return Promise.resolve([...this.labels])
  }
  createLabel(_p: string, body: { name: string }) {
    this.calls.push(`createLabel ${body.name}`)
    const l = { id: `l-${this.labels.length + 1}`, name: body.name }
    this.labels.push(l)
    return Promise.resolve(l)
  }
  createIssue(project: string, body: { name: string; description_html: string; priority: string; labels?: string[] }) {
    this.calls.push(`createIssue ${body.name}`)
    if (this.failCreate) return Promise.reject(new Error('Plane 503'))
    const i = { id: `i-${this.issues.length + 1}`, sequence_id: this.issues.length + 1, project, ...body }
    this.issues.push(i)
    return Promise.resolve(i)
  }
  updateIssue(_p: string, id: string, patch: { state?: string }) {
    this.calls.push(`updateIssue ${id} ${patch.state}`)
    const i = this.issues.find((x) => x.id === id)!
    i.state = patch.state
    return Promise.resolve(i)
  }
  createComment(_p: string, id: string, html: string) {
    this.calls.push(`comment ${id}`)
    this.comments.push({ issue: id, html })
    return Promise.resolve()
  }
  relate(_p: string, id: string, other: string) {
    this.relations.push([id, other])
    return Promise.resolve()
  }
  attach(_p: string, id: string, file: { name: string }) {
    if (this.failAttach) return Promise.reject(new Error('upload refused'))
    this.attachments.push(`${id}:${file.name}`)
    return Promise.resolve()
  }
  issueUrl(p: string, id: string) {
    return `https://plane.example/adhar/projects/${p}/issues/${id}`
  }
}

const evidence = (over: Partial<Evidence['subject']> = {}): Evidence => ({
  collectedAt: '2026-10-22T16:20:00.000Z',
  windowMinutes: 60,
  subject: { family: 'argocd', app: 'gateway-service', env: 'dev', project: 'adhar', workloadNamespace: 'dev', pods: ['gateway-service-689ffd8cf6-7kj2j'], ...over },
  k8s: { status: 'ok', data: { events: [], pods: [{ name: 'gateway-service-689ffd8cf6-7kj2j', phase: 'Running', ready: false, restarts: 36, containers: [] }] } },
  logs: { status: 'ok', data: { source: 'loki', errorLines: ['[gateway-service-689ffd8cf6-7kj2j] ERROR Application run failed (×36)'], lines: [] } },
  metrics: { status: 'empty', data: { results: [] } },
  traces: { status: 'empty', note: 'not instrumented' },
  delivery: { status: 'skipped' },
  links: {},
})

const argoDoc = (health: 'Degraded' | 'Healthy'): NotificationDoc => ({
  kind: health === 'Degraded' ? 'error' : 'success',
  source: 'gitops',
  severity: health === 'Degraded' ? 'high' : undefined,
  title: health === 'Degraded' ? 'gateway-service (dev) is degraded' : 'gateway-service (dev) is synced and healthy',
  key: `argocd:adhar-system/adhar-gateway-service-dev:${health}/Synced`,
  target: { type: 'application', id: 'adhar-gateway-service-dev', label: 'gateway-service (dev)' },
  href: '/deliver?section=apps&app=adhar-gateway-service-dev',
  at: '2026-10-22T16:00:00Z',
})

function setup(cfg: SupportTicketConfig = DEFAULT_SUPPORT_CONFIG) {
  const store = new MemStore()
  const plane = new FakePlane()
  let now = Date.parse('2026-10-22T16:00:00Z')
  const logs: string[] = []
  let collectFails = false
  const deps: TicketDeps = {
    store,
    plane,
    catalog: new PlaneCatalog(plane, () => now),
    config: cfg,
    collect: () => (collectFails ? Promise.resolve({ ...evidence(), logs: { status: 'error', note: 'Loki down' } }) : Promise.resolve(evidence())),
    now: () => now,
    log: (m) => logs.push(m),
  }
  let n = 0
  const send = async (doc: NotificationDoc, opts: { created?: boolean; manual?: boolean } = {}): Promise<Outcome> => {
    const id = `n-${++n}`
    await store.put(NOTIFICATION_KIND, id, doc)
    return processDecision(deps, { notificationId: id, doc, decision: classify(doc, opts.manual ? 'manual' : 'platform-watcher', cfg), created: opts.created ?? true, manual: opts.manual })
  }
  return {
    store,
    plane,
    logs,
    send,
    advance: (min: number) => (now += min * 60_000),
    failCollect: () => (collectFails = true),
    record: async () => (await store.get<IncidentRecord>(INCIDENT_KIND, await incidentDocId('argocd:adhar-system/adhar-gateway-service-dev')))?.data,
    notification: async (id: string) => (await store.get<NotificationDoc>(NOTIFICATION_KIND, id))?.data,
  }
}

Deno.test('first failure: the default project is created ONCE, the ticket carries labels/priority, the notification links it', async () => {
  const t = setup()
  const r = await t.send(argoDoc('Degraded'))
  assertEquals(r.outcome, 'created')
  assertEquals(t.plane.projects.map(({ id, name, identifier }) => ({ id, name, identifier })), [{ id: 'p-1', name: 'Platform Support', identifier: 'SUP' }])
  const issue = t.plane.issues[0]
  assertEquals(issue.name, '[incident] gateway-service (dev) is degraded')
  assertEquals(issue.priority, 'high')
  assertEquals(t.plane.labels.map((l) => l.name), ['incident', 'source:argocd', 'env:dev', 'app:gateway-service'])
  assertStringIncludes(issue.description_html, 'Application run failed')
  assertEquals(t.plane.attachments.length, 1)
  const n = await t.notification('n-1')
  assertEquals(n?.ticket, { key: 'SUP-1', url: 'https://plane.example/adhar/projects/p-1/issues/i-1', state: 'open' })

  // A second, different incident reuses the project (and labels) — nothing is created twice.
  await t.send({ ...argoDoc('Degraded'), key: 'argocd:adhar-system/adhar-qua-service-dev:Degraded/Synced', title: 'qua-service (dev) is degraded' })
  assertEquals(t.plane.calls.filter((c) => c.startsWith('createProject')).length, 1)
  assertEquals(t.plane.issues.length, 2)
})

Deno.test('an Adhar project with a matching Plane project files there instead of the default', async () => {
  const t = setup()
  t.plane.projects.push({ id: 'p-adhar', name: 'Adhar', identifier: 'ADHAR' })
  await t.send(argoDoc('Degraded'))
  assertEquals(t.plane.issues[0].project, 'p-adhar')
  assertEquals(t.plane.calls.filter((c) => c.startsWith('createProject')).length, 0)
  // An explicit mapping wins over the name match.
  const m = setup(mergeSupportConfig({ projectMap: { adhar: 'p-team' } }))
  m.plane.projects.push({ id: 'p-adhar', name: 'Adhar', identifier: 'ADHAR' }, { id: 'p-team', name: 'Team', identifier: 'TEAM' })
  await m.send(argoDoc('Degraded'))
  assertEquals(m.plane.issues[0].project, 'p-team')
})

Deno.test('recurrence while open: comments (once per cooldown), never a second ticket; a de-duplicated notification is silent', async () => {
  const t = setup()
  await t.send(argoDoc('Degraded'))
  // Within the 30-minute cooldown: counted, not commented.
  t.advance(10)
  assertEquals((await t.send(argoDoc('Degraded'))).outcome, 'suppressed')
  assertEquals(t.plane.comments.length, 0)
  // After it: one comment with fresh evidence.
  t.advance(25)
  const r = await t.send(argoDoc('Degraded'))
  assertEquals(r.outcome, 'commented')
  assertEquals(t.plane.comments.length, 1)
  assertStringIncludes(t.plane.comments[0].html, 'Recurred')
  assertStringIncludes(t.plane.comments[0].html, '3 occurrences')
  // emitNotification de-duplicated it: still happening, not news.
  t.advance(60)
  assertEquals((await t.send(argoDoc('Degraded'), { created: false })).outcome, 'suppressed')
  assertEquals(t.plane.comments.length, 1)
  assertEquals(t.plane.issues.length, 1)
  assertEquals((await t.record())?.occurrences, 3)
})

Deno.test('recovery: a resolution comment and the completed state; then a re-occurrence opens a NEW ticket linking the old', async () => {
  const t = setup()
  await t.send(argoDoc('Degraded'))
  const r = await t.send(argoDoc('Healthy'))
  assertEquals(r.outcome, 'resolved')
  assertEquals(t.plane.issues[0].state, 's-done')
  assertStringIncludes(t.plane.comments.at(-1)!.html, 'Recovered')
  assertEquals((await t.record())?.state, 'resolved')
  assertEquals(((await t.notification('n-2'))?.ticket as { state?: string } | undefined)?.state, 'resolved')

  // A second recovery is a no-op (nothing open).
  assertEquals((await t.send(argoDoc('Healthy'))).outcome, 'noop')

  t.advance(120)
  const again = await t.send(argoDoc('Degraded'))
  assertEquals(again.outcome, 'created')
  assertEquals(t.plane.issues.length, 2)
  assertStringIncludes(t.plane.issues[1].description_html, 'Recurrence of')
  assertStringIncludes(t.plane.issues[1].description_html, 'SUP-1')
  assertEquals(t.plane.relations, [['i-2', 'i-1']])
  assertEquals((await t.record())?.previous?.key, 'SUP-1')
})

Deno.test('autoResolve off: recovery comments but leaves the ticket open', async () => {
  const t = setup(mergeSupportConfig({ autoResolve: false }))
  await t.send(argoDoc('Degraded'))
  await t.send(argoDoc('Healthy'))
  assertEquals(t.plane.issues[0].state, undefined)
  assertEquals((await t.record())?.state, 'open')
  assertEquals(t.plane.comments.length, 1)
})

Deno.test('manual on an open incident returns the existing ticket without commenting', async () => {
  const t = setup()
  await t.send(argoDoc('Degraded'))
  const r = await t.send(argoDoc('Degraded'), { manual: true })
  assertEquals(r.outcome, 'exists')
  assertEquals(t.plane.issues.length, 1)
  assertEquals(t.plane.comments.length, 0)
})

Deno.test('evidence failing and the attachment failing still produce a ticket; the failure is logged', async () => {
  const t = setup()
  t.failCollect()
  t.plane.failAttach = true
  const r = await t.send(argoDoc('Degraded'))
  assertEquals(r.outcome, 'created')
  assertStringIncludes(t.plane.issues[0].description_html, 'Loki down')
  assert(t.logs.some((l) => l.includes('evidence attachment') && l.includes('upload refused')))
})

Deno.test('Plane refusing the create throws to the queue and records nothing (the next occurrence retries)', async () => {
  const t = setup()
  t.plane.failCreate = true
  await assertRejects(() => t.send(argoDoc('Degraded')), Error, 'Plane 503')
  assertEquals(await t.record(), undefined)
  t.plane.failCreate = false
  assertEquals((await t.send(argoDoc('Degraded'))).outcome, 'created')
})

Deno.test('a node joining resolves every open autoscaler scale-up incident', async () => {
  const t = setup()
  const scale: NotificationDoc = {
    kind: 'error',
    source: 'platform',
    severity: 'high',
    title: 'Cluster prod could not add a worker',
    key: 'autoscaler:prod:ScaleUpFailed:4',
    target: { type: 'adharplatform', id: 'prod', label: 'prod' },
    at: '2026-10-22T16:00:00Z',
  }
  assertEquals((await t.send(scale)).outcome, 'created')
  const joined: NotificationDoc = { kind: 'success', source: 'platform', title: 'Node w9 joined the cluster', key: 'node:w9:u9:joined', target: { type: 'node', id: 'w9', label: 'w9' }, at: '2026-10-22T16:05:00Z' }
  const r = await t.send(joined)
  assertEquals(r.outcome, 'resolved')
  assertEquals(t.plane.issues[0].state, 's-done')
})

Deno.test('an existing project with the default IDENTIFIER is reused even when it was renamed (no duplicate SUP project)', async () => {
  const t = setup()
  t.plane.projects.push({ id: 'p-sup', name: 'Support desk', identifier: 'SUP' })
  await t.send(argoDoc('Degraded'))
  assertEquals(t.plane.issues[0].project, 'p-sup')
  assertEquals(t.plane.calls.filter((c) => c.startsWith('createProject')).length, 0)
  assertEquals((await t.record())?.key, 'SUP-1')
})
