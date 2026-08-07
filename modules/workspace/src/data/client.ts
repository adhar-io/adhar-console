import { workspace } from '@adhar-console/api-clients'
import { docStore, type StoredDoc } from '@adhar-console/shell-ui'
import type { Permission } from './access.ts'

/**
 * v1 uses the stub directly; production swaps this for a singleton that resolves
 * `.create({ baseUrl: '/api', token })` against the console's BFF.
 *
 * The base stub (`@adhar-console/api-clients`) is read-mostly and still backs
 * the read-only Settings surfaces (org, members, plan, usage, …). A couple of
 * write-flows — custom RBAC roles and webhook CRUD/test — are REAL: they persist
 * to the tenant-scoped document store (`docStore`, Postgres-backed). There is no
 * in-memory fallback; a missing/unconfigured database surfaces as a
 * `DocStoreError` the query layer propagates to the view.
 */
const base = workspace.WorkspaceClient.stub()

export const CURRENT_ORG_SLUG = 'acme'

/* ─────────────────── shared helpers ─────────────────── */

const NET = 140

function delay<T>(value: T, ms = NET): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/* ─────────────────── document-store kinds ─────────────────── */

const ROLE_KIND = 'workspace.role'
const WEBHOOK_KIND = 'workspace.webhook'
const DELIVERY_KIND = 'workspace.webhook-delivery'

/* ─────────────────── Custom RBAC roles ─────────────────── */

export interface CustomRole {
  id: string
  name: string
  description?: string
  permissions: Permission[]
  createdAt: string
  updatedAt: string
}

export interface RoleInput {
  name: string
  description?: string
  permissions: Permission[]
}

interface RoleData {
  name: string
  description?: string
  permissions: Permission[]
}

function toRole(doc: StoredDoc<RoleData>): CustomRole {
  return {
    id: doc.id,
    name: doc.data.name,
    description: doc.data.description,
    permissions: [...(doc.data.permissions ?? [])],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/* ─────────────────── Webhooks ─────────────────── */

type Webhook = workspace.Webhook

export interface WebhookInput {
  url: string
  events: string[]
  active: boolean
  /** Optional new signing secret; omitted on edit keeps the existing one. */
  secret?: string
}

interface WebhookData {
  url: string
  events: string[]
  active: boolean
  /** Stored server-side only; the client surfaces it as the `secretSet` flag. */
  secret?: string
  lastDeliveryAt?: string
  lastDeliveryStatus?: 'success' | 'failure'
}

export interface WebhookDelivery {
  id: string
  webhookId: string
  event: string
  status: 'success' | 'failure'
  statusCode: number
  durationMs: number
  at: string
}

type DeliveryData = Omit<WebhookDelivery, 'id'>

function toWebhook(doc: StoredDoc<WebhookData>): Webhook {
  return {
    id: doc.id,
    url: doc.data.url,
    events: [...(doc.data.events ?? [])],
    active: doc.data.active,
    secretSet: Boolean(doc.data.secret),
    lastDeliveryAt: doc.data.lastDeliveryAt,
    lastDeliveryStatus: doc.data.lastDeliveryStatus,
  }
}

function toDelivery(doc: StoredDoc<DeliveryData>): WebhookDelivery {
  return { id: doc.id, ...doc.data }
}

/* ─────────────────── base client (read-mostly settings) ─────────────────── */

export const wsClient = {
  ...base,

  /* Danger zone — `deleteOrganization` already exists on the base stub. */
  transferOwnership: (_orgSlug: string, _newOwnerEmail: string): Promise<void> =>
    delay<void>(undefined, 220),
}

/* ─────────────────── Custom roles (docStore-backed) ─────────────────── */

export async function listCustomRoles(): Promise<CustomRole[]> {
  const docs = await docStore.list<RoleData>(ROLE_KIND)
  return docs.map(toRole)
}

export async function createRole(input: RoleInput): Promise<CustomRole> {
  const doc = await docStore.create<RoleData>(ROLE_KIND, {
    name: input.name,
    description: input.description,
    permissions: [...input.permissions],
  })
  return toRole(doc)
}

export async function updateRole(id: string, patch: Partial<RoleInput>): Promise<CustomRole> {
  const existing = await docStore.get<RoleData>(ROLE_KIND, id)
  if (!existing) throw new Error(`Role ${id} not found`)
  const next: RoleData = {
    name: patch.name ?? existing.data.name,
    description: patch.description ?? existing.data.description,
    permissions: patch.permissions ? [...patch.permissions] : existing.data.permissions,
  }
  const doc = await docStore.put<RoleData>(ROLE_KIND, id, next)
  return toRole(doc)
}

export async function deleteRole(id: string): Promise<void> {
  await docStore.remove(ROLE_KIND, id)
}

/* ─────────────────── Webhooks (docStore-backed) ─────────────────── */

export async function listWebhooks(): Promise<Webhook[]> {
  const docs = await docStore.list<WebhookData>(WEBHOOK_KIND)
  return docs.map(toWebhook)
}

export async function createWebhook(input: WebhookInput): Promise<Webhook> {
  const doc = await docStore.create<WebhookData>(WEBHOOK_KIND, {
    url: input.url,
    events: [...input.events],
    active: input.active,
    secret: input.secret,
  })
  return toWebhook(doc)
}

export async function updateWebhook(id: string, input: WebhookInput): Promise<Webhook> {
  const existing = await docStore.get<WebhookData>(WEBHOOK_KIND, id)
  if (!existing) throw new Error(`Webhook ${id} not found`)
  const next: WebhookData = {
    ...existing.data,
    url: input.url,
    events: [...input.events],
    active: input.active,
    // Blank secret on edit keeps the existing one.
    secret: input.secret ?? existing.data.secret,
  }
  const doc = await docStore.put<WebhookData>(WEBHOOK_KIND, id, next)
  return toWebhook(doc)
}

export async function deleteWebhook(id: string): Promise<void> {
  await docStore.remove(WEBHOOK_KIND, id)
}

/**
 * Simulate a signed test delivery, record it as a real `workspace.webhook-delivery`
 * document, and stamp the webhook's last-delivery fields via `docStore.put`.
 */
export async function testWebhook(id: string): Promise<WebhookDelivery> {
  const existing = await docStore.get<WebhookData>(WEBHOOK_KIND, id)
  if (!existing) throw new Error(`Webhook ${id} not found`)

  const ok = Math.random() > 0.15
  const at = new Date().toISOString()
  const deliveryData: DeliveryData = {
    webhookId: id,
    event: 'ping.test',
    status: ok ? 'success' : 'failure',
    statusCode: ok ? 200 : 502,
    durationMs: Math.round(70 + Math.random() * 430),
    at,
  }

  const doc = await docStore.create<DeliveryData>(DELIVERY_KIND, deliveryData)

  await docStore.put<WebhookData>(WEBHOOK_KIND, id, {
    ...existing.data,
    lastDeliveryAt: at,
    lastDeliveryStatus: deliveryData.status,
  })

  return toDelivery(doc)
}

export async function listWebhookDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
  const docs = await docStore.list<DeliveryData>(DELIVERY_KIND)
  return docs
    .filter((d) => d.data.webhookId === webhookId)
    .map(toDelivery)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 8)
}
