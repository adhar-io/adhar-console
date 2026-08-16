/**
 * Workspace persistence layer — tenant-scoped documents in Postgres via the
 * console's generic docStore (`documents` table, no schema migration needed).
 *
 * Each workspace domain is a document KIND:
 *   workspace.org         singleton per tenant (id = 'current')
 *   workspace.member      id = Keycloak user id (sub)
 *   workspace.invitation  id = uuid
 *   workspace.team        id = uuid (slug stored in data)
 *   workspace.project     id = uuid
 *   workspace.api-token   id = uuid (only a SHA-256 hash of the secret)
 *   workspace.approval    id = uuid (request/approve queue)
 *   workspace.audit       id = uuid (append-only, one per mutation)
 */

export const KIND = {
  org: 'workspace.org',
  member: 'workspace.member',
  invitation: 'workspace.invitation',
  team: 'workspace.team',
  project: 'workspace.project',
  token: 'workspace.api-token',
  approval: 'workspace.approval',
  audit: 'workspace.audit',
} as const

export const ORG_DOC_ID = 'current'

export type OrgRole = 'owner' | 'admin' | 'member' | 'billing' | 'viewer'
export const ORG_ROLES: OrgRole[] = ['owner', 'admin', 'member', 'billing', 'viewer']

/* ─────────────────── stored document shapes ─────────────────── */

export interface OrgDoc {
  slug: string
  name: string
  description?: string
  logoUrl?: string
  region: string
  plan: 'free' | 'team' | 'business' | 'enterprise'
  createdAt: string
  ssoEnforced: boolean
  domain?: string
  defaultProjectId?: string
  [k: string]: unknown
}

export interface MemberDoc {
  email: string
  name: string
  avatarUrl?: string
  role: OrgRole
  /** Team slugs the member belongs to. */
  teams: string[]
  joinedAt: string
  lastActiveAt?: string
  ssoProvider?: string
  [k: string]: unknown
}

export interface InvitationDoc {
  email: string
  role: OrgRole
  teams: string[]
  invitedBy: string
  invitedAt: string
  expiresAt: string
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  /** SHA-256 hex of the invite token; the plaintext is returned exactly once. */
  tokenHash: string
  acceptedBy?: string
  [k: string]: unknown
}

export interface TeamDoc {
  slug: string
  name: string
  description?: string
  createdAt: string
  /** Keycloak group name this team maps to (for cluster RBAC). */
  keycloakGroup?: string
  /** Whether the last Keycloak group sync attempt succeeded. */
  keycloakSynced: boolean
  [k: string]: unknown
}

export interface ProjectDoc {
  slug: string
  name: string
  description?: string
  tenantId: string
  teams: string[]
  primaryRepo?: string
  giteaOrg: string
  argoProject: string
  harborProject: string
  environments: string[]
  createdAt: string
  [k: string]: unknown
}

export interface TokenDoc {
  name: string
  /** First characters of the minted secret, e.g. `adhar_1a2b3c`. */
  prefix: string
  /** Last 4 characters of the minted secret (display aid). */
  last4: string
  /** SHA-256 hex of the full secret — the plaintext is never stored. */
  hash: string
  scopes: string[]
  ownerType: 'user' | 'org'
  ownerId: string
  createdAt: string
  createdBy: string
  expiresAt?: string
  lastUsedAt?: string
  [k: string]: unknown
}

export interface ApprovalDoc {
  scope: string
  summary: string
  status: 'pending' | 'approved' | 'rejected'
  requestedBy: { id: string; label: string }
  requestedAt: string
  decidedBy?: { id: string; label: string }
  decidedAt?: string
  note?: string
  [k: string]: unknown
}

export interface AuditDoc {
  actor: { type: 'user' | 'token' | 'system'; id: string; label: string }
  action: string
  target: { type: string; id: string; label: string }
  outcome: 'success' | 'failure'
  ip?: string
  userAgent?: string
  at: string
  metadata?: Record<string, unknown>
  [k: string]: unknown
}

/* ─────────────────── db access ─────────────────── */

type DbModule = typeof import('@adhar-console/db')
type Conn = NonNullable<Awaited<ReturnType<DbModule['getMigratedDb']>>>

export interface StoredDoc<T> {
  id: string
  data: T
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

/** Open handle bundling the connection with the repo functions. */
export interface Store {
  conn: Conn
  mod: DbModule
  tenant: string
  list<T>(kind: string): Promise<StoredDoc<T>[]>
  get<T>(kind: string, id: string): Promise<StoredDoc<T> | null>
  put<T extends Record<string, unknown>>(
    kind: string,
    id: string,
    data: T,
    userId: string,
  ): Promise<StoredDoc<T>>
  remove(kind: string, id: string): Promise<boolean>
}

/** Returns null when no database is configured — callers must respond 503. */
export async function openStore(tenant: string): Promise<Store | null> {
  const mod = await import('@adhar-console/db')
  const conn = await mod.getMigratedDb()
  if (!conn) return null
  return {
    conn,
    mod,
    tenant,
    list: async <T>(kind: string) =>
      (await mod.listDocuments(conn, tenant, kind)) as unknown as StoredDoc<T>[],
    get: async <T>(kind: string, id: string) =>
      (await mod.getDocument(conn, tenant, kind, id)) as unknown as StoredDoc<T> | null,
    put: async <T extends Record<string, unknown>>(
      kind: string,
      id: string,
      data: T,
      userId: string,
    ) => (await mod.putDocument(conn, tenant, kind, id, data, userId)) as unknown as StoredDoc<T>,
    remove: (kind: string, id: string) => mod.deleteDocument(conn, tenant, kind, id),
  }
}

/* ─────────────────── audit trail ─────────────────── */

/**
 * Append one audit event for a mutation. Failures to write the audit doc are
 * logged but never fail the underlying mutation.
 */
export async function writeAudit(
  store: Store,
  actor: { id: string; name: string },
  action: string,
  target: { type: string; id: string; label: string },
  req: Request,
  metadata?: Record<string, unknown>,
  outcome: 'success' | 'failure' = 'success',
): Promise<void> {
  const doc: AuditDoc = {
    actor: { type: 'user', id: actor.id, label: actor.name },
    action,
    target,
    outcome,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
    at: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  }
  try {
    await store.put(KIND.audit, crypto.randomUUID(), doc, actor.id)
  } catch (e) {
    console.warn('[workspace] failed to write audit event:', e)
  }
}

/* ─────────────────── secrets ─────────────────── */

const HEX = '0123456789abcdef'

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  let out = ''
  for (const b of buf) out += HEX[b >> 4] + HEX[b & 15]
  return out
}

/** Mint an API-token secret: `adhar_<40 hex chars>`. */
export function mintTokenSecret(): string {
  return `adhar_${randomHex(20)}`
}

/** Mint an invitation token (returned once in the invite link). */
export function mintInviteToken(): string {
  return randomHex(24)
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  let out = ''
  for (const b of new Uint8Array(digest)) out += HEX[b >> 4] + HEX[b & 15]
  return out
}

/* ─────────────────── misc helpers ─────────────────── */

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `item-${randomHex(3)}`
}

export function isExpired(iso: string): boolean {
  return new Date(iso).getTime() < Date.now()
}
