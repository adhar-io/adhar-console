import { getRequestUser, unauthorized } from '../request-user.ts'
import { getKeycloakAdmin, groupForRole, groupForTeam } from './keycloak-admin.ts'
import {
  isExpired,
  KIND,
  mintInviteToken,
  mintTokenSecret,
  ORG_DOC_ID,
  ORG_ROLES,
  openStore,
  sha256Hex,
  slugify,
  writeAudit,
  type ApprovalDoc,
  type InvitationDoc,
  type MemberDoc,
  type OrgDoc,
  type OrgRole,
  type ProjectDoc,
  type Store,
  type StoredDoc,
  type TeamDoc,
  type TokenDoc,
  type AuditDoc,
} from './store.ts'

/**
 * Workspace / Organization management BFF — `/api/workspace/*`.
 *
 * Tenant-scoped, Postgres-backed (generic document store) org / member / team /
 * invitation / project / api-token / approval / audit management. Team and org-
 * role membership is reflected into Keycloak realm groups (`ws-team-<slug>`,
 * `ws-role-<role>`) for real cluster RBAC when an admin credential is
 * available; Keycloak failures degrade to `keycloakSynced: false` and NEVER
 * fail the request. Every mutation appends a `workspace.audit` document.
 *
 * Returns 503 (`store_unavailable`) when no database is configured — the UI
 * surfaces that as a "connect a database" state instead of faking data.
 */

interface Ctx {
  req: Request
  store: Store
  tenant: string
  user: { id: string; email: string; name: string }
  /** The caller's own membership document. */
  self: MemberDoc
}

const MANAGE_ROLES: OrgRole[] = ['owner', 'admin']

const json = (body: unknown, status = 200) => Response.json(body, { status })
const badRequest = (error: string) => json({ error }, 400)
const forbidden = (error = 'forbidden') => json({ error }, 403)
const notFound = () => json({ error: 'not_found' }, 404)

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

export async function handleWorkspace(req: Request, subpath: string): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const attach = (res: Response) => withCookie(res, auth.refreshedCookie)

  const store = await openStore(auth.activeTenant)
  if (!store) {
    return attach(
      json({ error: 'store_unavailable', detail: 'database not configured' }, 503),
    )
  }

  try {
    await store.mod.touchUser(store.conn, auth.user)
    const self = await ensureCallerMembership(store, auth.user, req)
    const ctx: Ctx = { req, store, tenant: auth.activeTenant, user: auth.user, self }
    const seg = subpath.replace(/\/+$/, '').split('/').filter(Boolean)
    const method = req.method.toUpperCase()
    return attach(await route(ctx, method, seg))
  } catch (e) {
    console.error('[workspace] handler error:', e)
    return attach(json({ error: 'internal_error' }, 500))
  }
}

function route(ctx: Ctx, method: string, seg: string[]): Promise<Response> | Response {
  const [head, id, sub, subId] = seg
  switch (head) {
    case 'me':
      if (method === 'GET') return handleMe(ctx)
      break
    case 'org':
      if (seg.length === 1 && method === 'GET') return getOrg(ctx)
      if (seg.length === 1 && method === 'PUT') return updateOrg(ctx)
      if (seg.length === 1 && method === 'DELETE') return deleteOrg(ctx)
      if (id === 'transfer' && method === 'POST') return transferOwnership(ctx)
      break
    case 'members':
      if (!id && method === 'GET') return listMembers(ctx)
      if (id && !sub && method === 'PATCH') return patchMember(ctx, id)
      if (id && !sub && method === 'DELETE') return removeMember(ctx, id)
      break
    case 'invitations':
      if (!id && method === 'GET') return listInvitations(ctx)
      if (!id && method === 'POST') return createInvitation(ctx)
      if (id && !sub && method === 'DELETE') return revokeInvitation(ctx, id)
      if (id && sub === 'accept' && method === 'POST') return acceptInvitation(ctx, id)
      break
    case 'teams':
      if (!id && method === 'GET') return listTeams(ctx)
      if (!id && method === 'POST') return createTeam(ctx)
      if (id && !sub && method === 'PATCH') return patchTeam(ctx, id)
      if (id && !sub && method === 'DELETE') return deleteTeam(ctx, id)
      if (id && sub === 'members' && !subId && method === 'POST') return addTeamMember(ctx, id)
      if (id && sub === 'members' && subId && method === 'DELETE') {
        return removeTeamMember(ctx, id, subId)
      }
      break
    case 'projects':
      if (!id && method === 'GET') return listProjects(ctx)
      if (!id && method === 'POST') return createProject(ctx)
      if (id && method === 'PATCH') return patchProject(ctx, id)
      if (id && method === 'DELETE') return deleteProject(ctx, id)
      break
    case 'tokens':
      if (!id && method === 'GET') return listTokens(ctx)
      if (!id && method === 'POST') return createToken(ctx)
      if (id && method === 'DELETE') return revokeToken(ctx, id)
      break
    case 'audit':
      if (!id && method === 'GET') return listAudit(ctx)
      break
    case 'approvals':
      if (!id && method === 'GET') return listApprovals(ctx)
      if (!id && method === 'POST') return createApproval(ctx)
      if (id && sub === 'approve' && method === 'POST') return decideApproval(ctx, id, 'approved')
      if (id && sub === 'reject' && method === 'POST') return decideApproval(ctx, id, 'rejected')
      break
  }
  return notFound()
}

/* ─────────────────── membership bootstrap ─────────────────── */

/**
 * Guarantee the caller has a `workspace.member` document. The very first user
 * of a tenant becomes `owner`; later arrivals (already tenant members via
 * Keycloak) are enrolled as `member`. Also freshens `lastActiveAt` (throttled).
 */
async function ensureCallerMembership(
  store: Store,
  user: { id: string; email: string; name: string },
  req: Request,
): Promise<MemberDoc> {
  const existing = await store.get<MemberDoc>(KIND.member, user.id)
  if (existing) {
    const last = existing.data.lastActiveAt ? new Date(existing.data.lastActiveAt).getTime() : 0
    if (Date.now() - last > 10 * 60_000) {
      const data = { ...existing.data, lastActiveAt: new Date().toISOString() }
      await store.put(KIND.member, user.id, data, user.id)
      return data
    }
    return existing.data
  }
  const members = await store.list<MemberDoc>(KIND.member)
  const role: OrgRole = members.length === 0 ? 'owner' : 'member'
  const doc: MemberDoc = {
    email: user.email,
    name: user.name,
    role,
    teams: [],
    joinedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  }
  await store.put(KIND.member, user.id, doc, user.id)
  await writeAudit(
    store,
    { id: user.id, name: user.name },
    role === 'owner' ? 'member.bootstrap_owner' : 'member.auto_enroll',
    { type: 'member', id: user.id, label: user.email },
    req,
    { role },
  )
  return doc
}

function requireManage(ctx: Ctx): Response | null {
  if (!MANAGE_ROLES.includes(ctx.self.role)) return forbidden('requires_admin_or_owner')
  return null
}

function requireOwner(ctx: Ctx): Response | null {
  if (ctx.self.role !== 'owner') return forbidden('requires_owner')
  return null
}

/* ─────────────────── me ─────────────────── */

async function handleMe(ctx: Ctx): Promise<Response> {
  const org = await loadOrg(ctx)
  return json({
    userId: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    role: ctx.self.role,
    teams: ctx.self.teams,
    org: toOrg(org),
    keycloakConfigured: getKeycloakAdmin() !== null,
  })
}

/* ─────────────────── organization ─────────────────── */

async function loadOrg(ctx: Ctx): Promise<StoredDoc<OrgDoc>> {
  const existing = await ctx.store.get<OrgDoc>(KIND.org, ORG_DOC_ID)
  if (existing) return existing
  // Bootstrap the org document from the tenant on first read.
  const doc: OrgDoc = {
    slug: ctx.tenant,
    name: ctx.tenant.charAt(0).toUpperCase() + ctx.tenant.slice(1),
    region: 'in-cluster',
    plan: 'team',
    createdAt: new Date().toISOString(),
    ssoEnforced: false,
  }
  return await ctx.store.put(KIND.org, ORG_DOC_ID, doc, ctx.user.id)
}

function toOrg(doc: StoredDoc<OrgDoc>) {
  return { id: `org-${doc.data.slug}`, ...doc.data }
}

async function getOrg(ctx: Ctx): Promise<Response> {
  return json({ item: toOrg(await loadOrg(ctx)) })
}

async function updateOrg(ctx: Ctx): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const current = await loadOrg(ctx)
  const patch: Partial<OrgDoc> = {}
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
  if (typeof body.description === 'string') patch.description = body.description
  if (typeof body.domain === 'string') patch.domain = body.domain.trim() || undefined
  if (typeof body.logoUrl === 'string') patch.logoUrl = body.logoUrl.trim() || undefined
  if (typeof body.ssoEnforced === 'boolean') patch.ssoEnforced = body.ssoEnforced
  if (typeof body.defaultProjectId === 'string') patch.defaultProjectId = body.defaultProjectId
  if (Object.keys(patch).length === 0) return badRequest('nothing_to_update')
  const next = { ...current.data, ...patch }
  const saved = await ctx.store.put(KIND.org, ORG_DOC_ID, next, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'org.update',
    { type: 'organization', id: next.slug, label: next.name },
    ctx.req,
    { fields: Object.keys(patch) },
  )
  return json({ item: toOrg(saved) })
}

async function transferOwnership(ctx: Ctx): Promise<Response> {
  const denied = requireOwner(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const targetId = typeof body?.userId === 'string' ? body.userId : ''
  if (!targetId) return badRequest('missing_userId')
  if (targetId === ctx.user.id) return badRequest('already_owner')
  const target = await ctx.store.get<MemberDoc>(KIND.member, targetId)
  if (!target) return notFound()

  await ctx.store.put(
    KIND.member,
    targetId,
    { ...target.data, role: 'owner' as OrgRole },
    ctx.user.id,
  )
  await ctx.store.put(
    KIND.member,
    ctx.user.id,
    { ...ctx.self, role: 'admin' as OrgRole },
    ctx.user.id,
  )

  const kc = getKeycloakAdmin()
  let keycloakSynced = false
  if (kc) {
    const results = await Promise.all([
      kc.addUserToGroup(targetId, groupForRole('owner')),
      kc.removeUserFromGroup(targetId, groupForRole(target.data.role)),
      kc.addUserToGroup(ctx.user.id, groupForRole('admin')),
      kc.removeUserFromGroup(ctx.user.id, groupForRole('owner')),
    ])
    keycloakSynced = results.every(Boolean)
  }

  await writeAudit(
    ctx.store,
    ctx.user,
    'org.transfer_ownership',
    { type: 'member', id: targetId, label: target.data.email },
    ctx.req,
    { previousOwner: ctx.user.email, keycloakSynced },
  )
  return json({ ok: true, keycloakSynced })
}

async function deleteOrg(ctx: Ctx): Promise<Response> {
  const denied = requireOwner(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const confirm = typeof body?.confirm === 'string' ? body.confirm.trim() : ''
  const org = await loadOrg(ctx)
  if (confirm !== org.data.name) return badRequest('confirmation_mismatch')

  const kc = getKeycloakAdmin()
  const teams = await ctx.store.list<TeamDoc>(KIND.team)
  for (const kind of [
    KIND.member,
    KIND.invitation,
    KIND.team,
    KIND.project,
    KIND.token,
    KIND.approval,
  ]) {
    const docs = await ctx.store.list<Record<string, unknown>>(kind)
    for (const d of docs) await ctx.store.remove(kind, d.id)
  }
  await ctx.store.remove(KIND.org, ORG_DOC_ID)
  if (kc) {
    for (const t of teams) await kc.deleteGroup(groupForTeam(t.data.slug))
  }

  await writeAudit(
    ctx.store,
    ctx.user,
    'org.delete',
    { type: 'organization', id: org.data.slug, label: org.data.name },
    ctx.req,
  )
  return json({ ok: true })
}

/* ─────────────────── members ─────────────────── */

function toMember(doc: StoredDoc<MemberDoc>) {
  return {
    userId: doc.id,
    email: doc.data.email,
    name: doc.data.name,
    avatarUrl: doc.data.avatarUrl,
    role: doc.data.role,
    teams: doc.data.teams ?? [],
    joinedAt: doc.data.joinedAt,
    lastActiveAt: doc.data.lastActiveAt,
    ssoProvider: doc.data.ssoProvider,
  }
}

async function listMembers(ctx: Ctx): Promise<Response> {
  const docs = await ctx.store.list<MemberDoc>(KIND.member)
  return json({ items: docs.map(toMember) })
}

async function countOwners(store: Store): Promise<number> {
  const docs = await store.list<MemberDoc>(KIND.member)
  return docs.filter((d) => d.data.role === 'owner').length
}

async function patchMember(ctx: Ctx, userId: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const role = body?.role as OrgRole | undefined
  if (!role || !ORG_ROLES.includes(role)) return badRequest('invalid_role')
  const target = await ctx.store.get<MemberDoc>(KIND.member, userId)
  if (!target) return notFound()
  if (role === 'owner' && ctx.self.role !== 'owner') return forbidden('requires_owner')
  if (target.data.role === 'owner' && role !== 'owner' && (await countOwners(ctx.store)) <= 1) {
    return badRequest('cannot_demote_last_owner')
  }

  const previous = target.data.role
  const saved = await ctx.store.put(KIND.member, userId, { ...target.data, role }, ctx.user.id)

  const kc = getKeycloakAdmin()
  let keycloakSynced = false
  if (kc) {
    const results = await Promise.all([
      kc.addUserToGroup(userId, groupForRole(role)),
      previous !== role
        ? kc.removeUserFromGroup(userId, groupForRole(previous))
        : Promise.resolve(true),
    ])
    keycloakSynced = results.every(Boolean)
  }

  await writeAudit(
    ctx.store,
    ctx.user,
    'member.update_role',
    { type: 'member', id: userId, label: target.data.email },
    ctx.req,
    { from: previous, to: role, keycloakSynced },
  )
  return json({ item: toMember(saved), keycloakSynced })
}

async function removeMember(ctx: Ctx, userId: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const target = await ctx.store.get<MemberDoc>(KIND.member, userId)
  if (!target) return notFound()
  if (target.data.role === 'owner' && (await countOwners(ctx.store)) <= 1) {
    return badRequest('cannot_remove_last_owner')
  }
  if (userId === ctx.user.id) return badRequest('cannot_remove_self')

  await ctx.store.remove(KIND.member, userId)

  const kc = getKeycloakAdmin()
  let keycloakSynced = false
  if (kc) {
    const ops = [kc.removeUserFromGroup(userId, groupForRole(target.data.role))]
    for (const teamSlug of target.data.teams ?? []) {
      ops.push(kc.removeUserFromGroup(userId, groupForTeam(teamSlug)))
    }
    keycloakSynced = (await Promise.all(ops)).every(Boolean)
  }

  await writeAudit(
    ctx.store,
    ctx.user,
    'member.remove',
    { type: 'member', id: userId, label: target.data.email },
    ctx.req,
    { keycloakSynced },
  )
  return json({ ok: true, keycloakSynced })
}

/* ─────────────────── invitations ─────────────────── */

function toInvitation(doc: StoredDoc<InvitationDoc>) {
  const status = doc.data.status === 'pending' && isExpired(doc.data.expiresAt)
    ? 'expired'
    : doc.data.status
  return {
    id: doc.id,
    email: doc.data.email,
    role: doc.data.role,
    teams: doc.data.teams ?? [],
    invitedBy: doc.data.invitedBy,
    invitedAt: doc.data.invitedAt,
    expiresAt: doc.data.expiresAt,
    status,
  }
}

async function listInvitations(ctx: Ctx): Promise<Response> {
  const docs = await ctx.store.list<InvitationDoc>(KIND.invitation)
  return json({ items: docs.map(toInvitation) })
}

async function createInvitation(ctx: Ctx): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const role = (body?.role ?? 'member') as OrgRole
  const teams = Array.isArray(body?.teams) ? (body.teams as string[]).filter((t) => typeof t === 'string') : []
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest('invalid_email')
  if (!ORG_ROLES.includes(role)) return badRequest('invalid_role')
  if (role === 'owner' && ctx.self.role !== 'owner') return forbidden('requires_owner')

  const token = mintInviteToken()
  const doc: InvitationDoc = {
    email,
    role,
    teams,
    invitedBy: ctx.user.email,
    invitedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    status: 'pending',
    tokenHash: await sha256Hex(token),
  }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.invitation, id, doc, ctx.user.id)

  await writeAudit(
    ctx.store,
    ctx.user,
    'invitation.create',
    { type: 'invitation', id, label: email },
    ctx.req,
    { role },
  )
  // The plaintext invite token is returned exactly once (embed in the link you
  // send out-of-band); only its hash is stored.
  return json({ item: toInvitation(saved), token, acceptPath: `/workspace/invitations/${id}?token=${token}` }, 201)
}

async function revokeInvitation(ctx: Ctx, id: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const doc = await ctx.store.get<InvitationDoc>(KIND.invitation, id)
  if (!doc) return notFound()
  const saved = await ctx.store.put(
    KIND.invitation,
    id,
    { ...doc.data, status: 'revoked' as const },
    ctx.user.id,
  )
  await writeAudit(
    ctx.store,
    ctx.user,
    'invitation.revoke',
    { type: 'invitation', id, label: doc.data.email },
    ctx.req,
  )
  return json({ item: toInvitation(saved) })
}

async function acceptInvitation(ctx: Ctx, id: string): Promise<Response> {
  const doc = await ctx.store.get<InvitationDoc>(KIND.invitation, id)
  if (!doc) return notFound()
  const body = await readBody(ctx.req)
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!token || (await sha256Hex(token)) !== doc.data.tokenHash) {
    return forbidden('invalid_invite_token')
  }
  if (doc.data.status !== 'pending') return badRequest(`invitation_${doc.data.status}`)
  if (isExpired(doc.data.expiresAt)) return badRequest('invitation_expired')

  // Enroll (or upgrade) the caller with the invited role and teams.
  const existing = await ctx.store.get<MemberDoc>(KIND.member, ctx.user.id)
  const member: MemberDoc = {
    email: ctx.user.email,
    name: ctx.user.name,
    role: doc.data.role,
    teams: Array.from(new Set([...(existing?.data.teams ?? []), ...(doc.data.teams ?? [])])),
    joinedAt: existing?.data.joinedAt ?? new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  }
  const saved = await ctx.store.put(KIND.member, ctx.user.id, member, ctx.user.id)
  await ctx.store.put(
    KIND.invitation,
    id,
    { ...doc.data, status: 'accepted' as const, acceptedBy: ctx.user.id },
    ctx.user.id,
  )

  const kc = getKeycloakAdmin()
  let keycloakSynced = false
  if (kc) {
    const ops = [kc.addUserToGroup(ctx.user.id, groupForRole(member.role))]
    for (const teamSlug of member.teams) {
      ops.push(kc.addUserToGroup(ctx.user.id, groupForTeam(teamSlug)))
    }
    keycloakSynced = (await Promise.all(ops)).every(Boolean)
  }

  await writeAudit(
    ctx.store,
    ctx.user,
    'invitation.accept',
    { type: 'invitation', id, label: doc.data.email },
    ctx.req,
    { role: doc.data.role, keycloakSynced },
  )
  return json({ item: toMember(saved), keycloakSynced })
}

/* ─────────────────── teams ─────────────────── */

async function teamCounters(store: Store) {
  const [members, projects] = await Promise.all([
    store.list<MemberDoc>(KIND.member),
    store.list<ProjectDoc>(KIND.project),
  ])
  return { members, projects }
}

function toTeam(
  doc: StoredDoc<TeamDoc>,
  members: StoredDoc<MemberDoc>[],
  projects: StoredDoc<ProjectDoc>[],
) {
  const slug = doc.data.slug
  return {
    id: doc.id,
    slug,
    name: doc.data.name,
    description: doc.data.description,
    memberCount: members.filter((m) => (m.data.teams ?? []).includes(slug)).length,
    projectCount: projects.filter((p) => (p.data.teams ?? []).includes(slug)).length,
    createdAt: doc.data.createdAt,
    keycloakGroup: doc.data.keycloakGroup,
    keycloakSynced: doc.data.keycloakSynced === true,
  }
}

async function listTeams(ctx: Ctx): Promise<Response> {
  const [docs, { members, projects }] = await Promise.all([
    ctx.store.list<TeamDoc>(KIND.team),
    teamCounters(ctx.store),
  ])
  return json({ items: docs.map((d) => toTeam(d, members, projects)) })
}

async function createTeam(ctx: Ctx): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('missing_name')
  const slug = slugify(typeof body?.slug === 'string' && body.slug.trim() ? body.slug : name)
  const description = typeof body?.description === 'string' ? body.description.trim() || undefined : undefined

  const existing = await ctx.store.list<TeamDoc>(KIND.team)
  if (existing.some((t) => t.data.slug === slug)) return badRequest('slug_taken')

  const kc = getKeycloakAdmin()
  const groupName = groupForTeam(slug)
  const group = kc ? await kc.ensureGroup(groupName) : null
  const keycloakSynced = group !== null

  const doc: TeamDoc = {
    slug,
    name,
    description,
    createdAt: new Date().toISOString(),
    keycloakGroup: groupName,
    keycloakSynced,
  }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.team, id, doc, ctx.user.id)
  const { members, projects } = await teamCounters(ctx.store)

  await writeAudit(
    ctx.store,
    ctx.user,
    'team.create',
    { type: 'team', id, label: name },
    ctx.req,
    { slug, keycloakSynced },
  )
  return json({ item: toTeam(saved, members, projects), keycloakSynced }, 201)
}

async function patchTeam(ctx: Ctx, id: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const doc = await ctx.store.get<TeamDoc>(KIND.team, id)
  if (!doc) return notFound()
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const next: TeamDoc = {
    ...doc.data,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : doc.data.name,
    description: typeof body.description === 'string'
      ? body.description.trim() || undefined
      : doc.data.description,
  }
  const saved = await ctx.store.put(KIND.team, id, next, ctx.user.id)
  const { members, projects } = await teamCounters(ctx.store)
  await writeAudit(
    ctx.store,
    ctx.user,
    'team.update',
    { type: 'team', id, label: next.name },
    ctx.req,
  )
  return json({ item: toTeam(saved, members, projects) })
}

async function deleteTeam(ctx: Ctx, id: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const doc = await ctx.store.get<TeamDoc>(KIND.team, id)
  if (!doc) return notFound()
  const slug = doc.data.slug

  await ctx.store.remove(KIND.team, id)
  // Strip the team from every member document.
  const members = await ctx.store.list<MemberDoc>(KIND.member)
  for (const m of members) {
    if ((m.data.teams ?? []).includes(slug)) {
      await ctx.store.put(
        KIND.member,
        m.id,
        { ...m.data, teams: m.data.teams.filter((t) => t !== slug) },
        ctx.user.id,
      )
    }
  }

  const kc = getKeycloakAdmin()
  const keycloakSynced = kc ? await kc.deleteGroup(groupForTeam(slug)) : false

  await writeAudit(
    ctx.store,
    ctx.user,
    'team.delete',
    { type: 'team', id, label: doc.data.name },
    ctx.req,
    { slug, keycloakSynced },
  )
  return json({ ok: true, keycloakSynced })
}

async function addTeamMember(ctx: Ctx, teamId: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  if (!userId) return badRequest('missing_userId')
  const [team, member] = await Promise.all([
    ctx.store.get<TeamDoc>(KIND.team, teamId),
    ctx.store.get<MemberDoc>(KIND.member, userId),
  ])
  if (!team || !member) return notFound()
  const slug = team.data.slug

  if (!(member.data.teams ?? []).includes(slug)) {
    await ctx.store.put(
      KIND.member,
      userId,
      { ...member.data, teams: [...(member.data.teams ?? []), slug] },
      ctx.user.id,
    )
  }

  const kc = getKeycloakAdmin()
  const keycloakSynced = kc ? await kc.addUserToGroup(userId, groupForTeam(slug)) : false
  if (team.data.keycloakSynced !== keycloakSynced && kc) {
    await ctx.store.put(KIND.team, teamId, { ...team.data, keycloakSynced }, ctx.user.id)
  }

  await writeAudit(
    ctx.store,
    ctx.user,
    'team.member_add',
    { type: 'team', id: teamId, label: team.data.name },
    ctx.req,
    { userId, member: member.data.email, keycloakSynced },
  )
  const { members, projects } = await teamCounters(ctx.store)
  const fresh = await ctx.store.get<TeamDoc>(KIND.team, teamId)
  return json({ item: toTeam(fresh ?? team, members, projects), keycloakSynced })
}

async function removeTeamMember(ctx: Ctx, teamId: string, userId: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const [team, member] = await Promise.all([
    ctx.store.get<TeamDoc>(KIND.team, teamId),
    ctx.store.get<MemberDoc>(KIND.member, userId),
  ])
  if (!team || !member) return notFound()
  const slug = team.data.slug

  if ((member.data.teams ?? []).includes(slug)) {
    await ctx.store.put(
      KIND.member,
      userId,
      { ...member.data, teams: member.data.teams.filter((t) => t !== slug) },
      ctx.user.id,
    )
  }

  const kc = getKeycloakAdmin()
  const keycloakSynced = kc ? await kc.removeUserFromGroup(userId, groupForTeam(slug)) : false

  await writeAudit(
    ctx.store,
    ctx.user,
    'team.member_remove',
    { type: 'team', id: teamId, label: team.data.name },
    ctx.req,
    { userId, member: member.data.email, keycloakSynced },
  )
  const { members, projects } = await teamCounters(ctx.store)
  return json({ item: toTeam(team, members, projects), keycloakSynced })
}

/* ─────────────────── projects ─────────────────── */

function toProject(doc: StoredDoc<ProjectDoc>) {
  return { id: doc.id, ...doc.data }
}

async function listProjects(ctx: Ctx): Promise<Response> {
  const docs = await ctx.store.list<ProjectDoc>(KIND.project)
  return json({ items: docs.map(toProject) })
}

async function createProject(ctx: Ctx): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('missing_name')
  const slug = slugify(typeof body?.slug === 'string' && body.slug.trim() ? body.slug : name)
  const existing = await ctx.store.list<ProjectDoc>(KIND.project)
  if (existing.some((p) => p.data.slug === slug)) return badRequest('slug_taken')

  const doc: ProjectDoc = {
    slug,
    name,
    description: typeof body?.description === 'string' ? body.description.trim() || undefined : undefined,
    tenantId: ctx.tenant,
    teams: Array.isArray(body?.teams) ? (body.teams as string[]).filter((t) => typeof t === 'string') : [],
    primaryRepo: typeof body?.primaryRepo === 'string' ? body.primaryRepo.trim() || undefined : undefined,
    giteaOrg: ctx.tenant,
    argoProject: `${ctx.tenant}-${slug}`,
    harborProject: ctx.tenant,
    environments: Array.isArray(body?.environments) && (body.environments as string[]).length
      ? (body.environments as string[]).filter((e) => typeof e === 'string')
      : ['dev', 'staging', 'prod'],
    createdAt: new Date().toISOString(),
  }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.project, id, doc, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'project.create',
    { type: 'project', id, label: name },
    ctx.req,
    { slug },
  )
  return json({ item: toProject(saved) }, 201)
}

async function patchProject(ctx: Ctx, id: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const doc = await ctx.store.get<ProjectDoc>(KIND.project, id)
  if (!doc) return notFound()
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const next: ProjectDoc = {
    ...doc.data,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : doc.data.name,
    description: typeof body.description === 'string'
      ? body.description.trim() || undefined
      : doc.data.description,
    primaryRepo: typeof body.primaryRepo === 'string'
      ? body.primaryRepo.trim() || undefined
      : doc.data.primaryRepo,
    teams: Array.isArray(body.teams)
      ? (body.teams as string[]).filter((t) => typeof t === 'string')
      : doc.data.teams,
    environments: Array.isArray(body.environments) && (body.environments as string[]).length
      ? (body.environments as string[]).filter((e) => typeof e === 'string')
      : doc.data.environments,
  }
  const saved = await ctx.store.put(KIND.project, id, next, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'project.update',
    { type: 'project', id, label: next.name },
    ctx.req,
  )
  return json({ item: toProject(saved) })
}

async function deleteProject(ctx: Ctx, id: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const doc = await ctx.store.get<ProjectDoc>(KIND.project, id)
  if (!doc) return notFound()
  await ctx.store.remove(KIND.project, id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'project.delete',
    { type: 'project', id, label: doc.data.name },
    ctx.req,
    { slug: doc.data.slug },
  )
  return json({ ok: true })
}

/* ─────────────────── API tokens ─────────────────── */

function toToken(doc: StoredDoc<TokenDoc>) {
  return {
    id: doc.id,
    name: doc.data.name,
    prefix: doc.data.prefix,
    last4: doc.data.last4,
    scopes: doc.data.scopes ?? [],
    ownerType: doc.data.ownerType,
    ownerId: doc.data.ownerId,
    createdAt: doc.data.createdAt,
    createdBy: doc.data.createdBy,
    lastUsedAt: doc.data.lastUsedAt,
    expiresAt: doc.data.expiresAt,
  }
}

async function listTokens(ctx: Ctx): Promise<Response> {
  const docs = await ctx.store.list<TokenDoc>(KIND.token)
  return json({ items: docs.map(toToken) })
}

async function createToken(ctx: Ctx): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('missing_name')
  const scopes = Array.isArray(body?.scopes)
    ? (body.scopes as string[]).filter((s) => typeof s === 'string' && s.length > 0)
    : []
  if (scopes.length === 0) return badRequest('missing_scopes')
  let expiresAt: string | undefined
  if (typeof body?.expiresAt === 'string' && body.expiresAt) {
    const parsed = new Date(body.expiresAt)
    if (Number.isNaN(parsed.getTime())) return badRequest('invalid_expiry')
    expiresAt = parsed.toISOString()
  }

  // Mint the secret; store only its hash + display hints. Shown exactly once.
  const secret = mintTokenSecret()
  const doc: TokenDoc = {
    name,
    prefix: secret.slice(0, 12),
    last4: secret.slice(-4),
    hash: await sha256Hex(secret),
    scopes,
    ownerType: 'org',
    ownerId: ctx.tenant,
    createdAt: new Date().toISOString(),
    createdBy: ctx.user.email,
    expiresAt,
  }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.token, id, doc, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'token.create',
    { type: 'api-token', id, label: name },
    ctx.req,
    { scopes, expiresAt },
  )
  return json({ token: secret, item: toToken(saved) }, 201)
}

async function revokeToken(ctx: Ctx, id: string): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const doc = await ctx.store.get<TokenDoc>(KIND.token, id)
  if (!doc) return notFound()
  await ctx.store.remove(KIND.token, id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'token.revoke',
    { type: 'api-token', id, label: doc.data.name },
    ctx.req,
  )
  return json({ ok: true })
}

/* ─────────────────── audit log ─────────────────── */

async function listAudit(ctx: Ctx): Promise<Response> {
  const url = new URL(ctx.req.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const outcome = url.searchParams.get('outcome')
  const action = (url.searchParams.get('action') ?? '').trim().toLowerCase()

  const docs = await ctx.store.list<AuditDoc>(KIND.audit)
  let events = docs.map((d) => ({ id: d.id, ...d.data }))
  if (outcome === 'success' || outcome === 'failure') {
    events = events.filter((e) => e.outcome === outcome)
  }
  if (action) events = events.filter((e) => e.action.toLowerCase().startsWith(action))
  if (q) {
    events = events.filter(
      (e) =>
        e.action.toLowerCase().includes(q) ||
        e.actor.label.toLowerCase().includes(q) ||
        e.target.label.toLowerCase().includes(q) ||
        (e.ip ?? '').includes(q),
    )
  }
  events.sort((a, b) => (a.at < b.at ? 1 : -1))
  const total = events.length
  return json({ items: events.slice(offset, offset + limit), total, limit, offset })
}

/* ─────────────────── approvals queue ─────────────────── */

const APPROVAL_SCOPES = [
  'production-deploy',
  'budget-increase',
  'role-grant-owner',
  'data-export',
  'destructive-rbac',
  'cluster-delete',
]

function toApproval(doc: StoredDoc<ApprovalDoc>) {
  return { id: doc.id, ...doc.data }
}

async function listApprovals(ctx: Ctx): Promise<Response> {
  const docs = await ctx.store.list<ApprovalDoc>(KIND.approval)
  const items = docs.map(toApproval).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
  return json({ items })
}

async function createApproval(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req)
  const scope = typeof body?.scope === 'string' ? body.scope : ''
  const summary = typeof body?.summary === 'string' ? body.summary.trim() : ''
  if (!APPROVAL_SCOPES.includes(scope)) return badRequest('invalid_scope')
  if (!summary) return badRequest('missing_summary')

  const doc: ApprovalDoc = {
    scope,
    summary,
    status: 'pending',
    requestedBy: { id: ctx.user.id, label: ctx.user.email },
    requestedAt: new Date().toISOString(),
  }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.approval, id, doc, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'approval.request',
    { type: 'approval', id, label: `${scope}: ${summary.slice(0, 60)}` },
    ctx.req,
    { scope },
  )
  return json({ item: toApproval(saved) }, 201)
}

async function decideApproval(
  ctx: Ctx,
  id: string,
  status: 'approved' | 'rejected',
): Promise<Response> {
  const denied = requireManage(ctx)
  if (denied) return denied
  const doc = await ctx.store.get<ApprovalDoc>(KIND.approval, id)
  if (!doc) return notFound()
  if (doc.data.status !== 'pending') return badRequest('already_decided')
  // Segregation of duty: the requester can never approve their own request.
  if (doc.data.requestedBy.id === ctx.user.id) return forbidden('cannot_decide_own_request')

  const body = await readBody(ctx.req)
  const note = typeof body?.note === 'string' ? body.note.trim() || undefined : undefined
  const next: ApprovalDoc = {
    ...doc.data,
    status,
    decidedBy: { id: ctx.user.id, label: ctx.user.email },
    decidedAt: new Date().toISOString(),
    note,
  }
  const saved = await ctx.store.put(KIND.approval, id, next, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    `approval.${status === 'approved' ? 'approve' : 'reject'}`,
    { type: 'approval', id, label: `${doc.data.scope}: ${doc.data.summary.slice(0, 60)}` },
    ctx.req,
    { requestedBy: doc.data.requestedBy.label },
  )
  return json({ item: toApproval(saved) })
}
