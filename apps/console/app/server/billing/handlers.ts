import { getServerAuthConfig, getValidSession } from '@adhar-console/auth/server'
import { originOk } from '../k8s/gateway.ts'
import {
  defaultSubscription,
  getBillingProvider,
  getPlan,
  nextMonthStart,
  PLAN_CATALOG,
  type PlanTier,
  type Subscription,
} from './provider.ts'
import {
  buildInvoice,
  renderInvoiceHtml,
  renderInvoiceText,
  type InvoiceDoc,
} from './invoices.ts'
import {
  costForWindow,
  meterUsage,
  openCostAllocation,
  periodWindow,
  type UsageReport,
} from './usage-meter.ts'

/**
 * Billing BFF — `/api/billing/*`. Tenant-scoped (org == active tenant),
 * persisted in the Postgres document store:
 *
 *   billing.subscription   singleton (id 'current')
 *   billing.invoice        one per period (id = YYYY-MM → idempotent generate)
 *   billing.budget         budgets AND cost centers (scope 'cost-center')
 *   billing.payment-method non-sensitive metadata only — PAN/CVC are rejected
 *
 * Usage is metered from REAL sources (Postgres members, kube-apiserver counts,
 * OpenCost allocation). Unavailable sources surface as `null` + a source flag,
 * never as invented numbers. `BillingProvider` (local | stripe) is the
 * processor seam; the API shape is identical either way.
 *
 * Endpoints:
 *   GET  plans
 *   GET  subscription            PUT subscription
 *   GET  usage?period=YYYY-MM
 *   GET  invoices                POST invoices/generate {period?}
 *   GET  invoices/:id            POST invoices/:id/pay
 *   GET  budgets                 POST budgets
 *   PATCH|DELETE budgets/:id
 *   GET  cost-centers            POST cost-centers
 *   PATCH|DELETE cost-centers/:id
 *   GET  allocation?dimension=namespace|controller|service|node|cluster
 *   GET  payment-methods         POST payment-methods
 *   PATCH|DELETE payment-methods/:id
 *   GET  provider                POST provider/checkout | provider/portal | provider/sync
 */

const db = () => import('@adhar-console/db')

const SUBSCRIPTION_KIND = 'billing.subscription'
const INVOICE_KIND = 'billing.invoice'
const BUDGET_KIND = 'billing.budget'
const PAYMENT_KIND = 'billing.payment-method'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

interface Auth {
  user: { id: string; name: string; email: string }
  tenant: string
  token: string | null
  refreshedCookie?: string
}

async function resolveAuth(req: Request): Promise<Auth | null> {
  const cfg = getServerAuthConfig()
  if (!cfg) return null
  const result = await getValidSession(req, cfg)
  if (!result) return null
  const s = result.session
  return {
    user: { id: s.user.id, name: s.user.name, email: s.user.email },
    tenant: s.activeTenant || s.user.tenants[0] || 'default',
    token: s.accessToken ?? null,
    refreshedCookie: result.refreshedCookie,
  }
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function bad(error: string, status = 400): Response {
  return Response.json({ error }, { status })
}

const storeUnavailable = () =>
  Response.json({ error: 'store_unavailable', detail: 'database not configured' }, { status: 503 })

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

type Conn = NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof db>>['getMigratedDb']>>>

async function getConn(): Promise<Conn | null> {
  const { getMigratedDb } = await db()
  return await getMigratedDb()
}

async function meter(auth: Auth, period?: string): Promise<UsageReport> {
  const conn = await getConn()
  const { listDocuments } = await db()
  return meterUsage({
    tenant: auth.tenant,
    period,
    token: auth.token,
    db: conn ? { conn, listDocuments: (c, t, k) => listDocuments(c as Conn, t, k) } : null,
  })
}

/* ─────────────────── entry ─────────────────── */

export async function handleBilling(req: Request, subpath: string): Promise<Response> {
  const auth = await resolveAuth(req)
  if (!auth) return bad('unauthenticated', 401)

  const method = req.method.toUpperCase()
  const mutating = method !== 'GET' && method !== 'HEAD'
  if (mutating && !originOk(req)) return bad('origin_not_allowed', 403)

  const url = new URL(req.url)
  const seg = subpath.replace(/\/+$/, '').split('/').filter(Boolean)

  let res: Response
  try {
    res = await route(req, method, seg, url, auth)
  } catch (e) {
    console.error(`[billing] ${method} /${subpath} failed:`, e instanceof Error ? e.message : e)
    res = bad('internal_error', 500)
  }
  return withCookie(res, auth.refreshedCookie)
}

function route(
  req: Request,
  method: string,
  seg: string[],
  url: URL,
  auth: Auth,
): Promise<Response> | Response {
  const [head, id, action] = seg

  switch (head) {
    case 'plans':
      if (method === 'GET') return Response.json({ plans: PLAN_CATALOG })
      break
    case 'subscription':
      if (seg.length === 1 && method === 'GET') return getSubscription(auth)
      if (seg.length === 1 && method === 'PUT') return putSubscription(req, auth)
      break
    case 'usage':
      if (seg.length === 1 && method === 'GET') {
        return getUsage(auth, url.searchParams.get('period') ?? undefined)
      }
      break
    case 'invoices':
      if (seg.length === 1 && method === 'GET') return listInvoices(auth)
      if (seg.length === 2 && id === 'generate' && method === 'POST') {
        return generateInvoice(req, auth)
      }
      if (seg.length === 2 && method === 'GET' && ID_RE.test(id)) return getInvoice(auth, id)
      if (seg.length === 3 && action === 'pay' && method === 'POST' && ID_RE.test(id)) {
        return payInvoice(auth, id)
      }
      break
    case 'budgets':
      return budgetRoutes(req, method, seg, auth, 'budget')
    case 'cost-centers':
      return budgetRoutes(req, method, seg, auth, 'cost-center')
    case 'allocation':
      if (seg.length === 1 && method === 'GET') {
        return getAllocation(
          auth,
          url.searchParams.get('dimension') ?? 'namespace',
          url.searchParams.get('period') ?? undefined,
        )
      }
      break
    case 'payment-methods':
      if (seg.length === 1 && method === 'GET') return listPaymentMethods(auth)
      if (seg.length === 1 && method === 'POST') return addPaymentMethod(req, auth)
      if (seg.length === 2 && ID_RE.test(id)) {
        if (method === 'PATCH') return patchPaymentMethod(req, auth, id)
        if (method === 'DELETE') return deletePaymentMethod(auth, id)
      }
      break
    case 'provider':
      if (seg.length === 1 && method === 'GET') {
        const p = getBillingProvider()
        return Response.json({ id: p.id, configured: p.configured })
      }
      if (seg.length === 2 && method === 'POST') return providerAction(req, auth, id)
      break
  }
  return bad('not_found', 404)
}

/* ─────────────────── subscription ─────────────────── */

function normalizeSubscription(data: Record<string, unknown>): Subscription {
  const fallback = defaultSubscription()
  const tier = getPlan(String(data.tier)) ? (data.tier as PlanTier) : fallback.tier
  const cycle = data.billingCycle === 'annual' ? 'annual' : 'monthly'
  const status = ['active', 'trialing', 'past_due', 'canceled'].includes(String(data.status))
    ? (data.status as Subscription['status'])
    : 'active'
  const seats = Number(data.seatsPurchased)
  return {
    tier,
    seatsPurchased: Number.isFinite(seats) && seats >= 1 ? Math.floor(seats) : fallback.seatsPurchased,
    billingCycle: cycle,
    status,
    startedAt: typeof data.startedAt === 'string' ? data.startedAt : fallback.startedAt,
    renewsAt: typeof data.renewsAt === 'string' ? data.renewsAt : fallback.renewsAt,
    provider: data.provider === 'stripe' ? 'stripe' : 'local',
  }
}

async function loadSubscription(
  conn: Conn,
  tenant: string,
): Promise<{ sub: Subscription; persisted: boolean }> {
  const { getDocument } = await db()
  const doc = await getDocument(conn, tenant, SUBSCRIPTION_KIND, 'current')
  if (!doc) return { sub: defaultSubscription(), persisted: false }
  return { sub: normalizeSubscription(doc.data), persisted: true }
}

async function getSubscription(auth: Auth): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const { listDocuments } = await db()
  const { sub, persisted } = await loadSubscription(conn, auth.tenant)
  const plan = getPlan(sub.tier)!
  const members = await listDocuments(conn, auth.tenant, 'workspace.member')
  const seatsUsed = Math.max(members.length, 1)
  const methods = await listDocuments(conn, auth.tenant, PAYMENT_KIND)
  const def = methods.find((m) => (m.data as { isDefault?: boolean }).isDefault)
  return Response.json({
    item: sub,
    plan,
    persisted,
    seatsUsed,
    priceMonthly: Math.round(sub.seatsPurchased * plan.pricePerSeatMonthly * 100) / 100,
    currency: plan.currency,
    paymentMethod: def ? String((def.data as { label?: unknown }).label ?? '') : null,
  })
}

async function putSubscription(req: Request, auth: Auth): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const body = await readJson(req)
  if (!body) return bad('invalid_json')

  const { sub: current } = await loadSubscription(conn, auth.tenant)
  const next: Record<string, unknown> = { ...current }
  if (body.tier !== undefined) {
    const plan = getPlan(String(body.tier))
    if (!plan) return bad('unknown_tier')
    next.tier = plan.id
  }
  if (body.seatsPurchased !== undefined) {
    const seats = Number(body.seatsPurchased)
    if (!Number.isInteger(seats) || seats < 1) return bad('invalid_seats')
    const plan = getPlan(String(next.tier))!
    if (plan.limits.seats !== null && seats > plan.limits.seats) {
      return bad('seats_exceed_plan_limit')
    }
    next.seatsPurchased = seats
  }
  if (body.billingCycle !== undefined) {
    if (body.billingCycle !== 'monthly' && body.billingCycle !== 'annual') return bad('invalid_cycle')
    next.billingCycle = body.billingCycle
  }
  if (body.status !== undefined) {
    if (!['active', 'trialing', 'past_due', 'canceled'].includes(String(body.status))) {
      return bad('invalid_status')
    }
    next.status = body.status
  }
  // Clamp seats when downgrading tiers.
  const plan = getPlan(String(next.tier))!
  if (plan.limits.seats !== null && Number(next.seatsPurchased) > plan.limits.seats) {
    next.seatsPurchased = plan.limits.seats
  }
  next.renewsAt = typeof body.renewsAt === 'string' ? body.renewsAt : nextMonthStart()
  next.provider = getBillingProvider().id

  const { putDocument, touchUser } = await db()
  await touchUser(conn, auth.user)
  const doc = await putDocument(
    conn,
    auth.tenant,
    SUBSCRIPTION_KIND,
    'current',
    normalizeSubscription(next) as unknown as Record<string, unknown>,
    auth.user.id,
  )
  return Response.json({ item: normalizeSubscription(doc.data), persisted: true })
}

/* ─────────────────── usage ─────────────────── */

async function getUsage(auth: Auth, period?: string): Promise<Response> {
  if (period !== undefined && !PERIOD_RE.test(period)) return bad('invalid_period')
  const report = await meter(auth, period)
  return Response.json(report)
}

/* ─────────────────── invoices ─────────────────── */

function invoiceFromDoc(doc: { id: string; data: Record<string, unknown> }): InvoiceDoc & { id: string } {
  return { id: doc.id, ...(doc.data as unknown as InvoiceDoc) }
}

async function listInvoices(auth: Auth): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const { listDocuments } = await db()
  const docs = await listDocuments(conn, auth.tenant, INVOICE_KIND)
  const items = docs.map(invoiceFromDoc).sort((a, b) => (a.period < b.period ? 1 : -1))
  return Response.json({ items })
}

async function getInvoice(auth: Auth, id: string): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const { getDocument } = await db()
  const doc = await getDocument(conn, auth.tenant, INVOICE_KIND, id)
  if (!doc) return bad('not_found', 404)
  const item = invoiceFromDoc(doc)
  return Response.json({
    item,
    html: renderInvoiceHtml(item, auth.tenant),
    text: renderInvoiceText(item, auth.tenant),
  })
}

async function generateInvoice(req: Request, auth: Auth): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const body = (await readJson(req)) ?? {}
  const requested = typeof body.period === 'string' ? body.period : undefined
  if (requested !== undefined && !PERIOD_RE.test(requested)) return bad('invalid_period')
  const { period } = periodWindow(requested)

  const { getDocument, putDocument, touchUser } = await db()
  // Idempotent per period: the doc id IS the period.
  const existing = await getDocument(conn, auth.tenant, INVOICE_KIND, period)
  if (existing) {
    return Response.json({ item: invoiceFromDoc(existing), alreadyExisted: true })
  }

  const { sub } = await loadSubscription(conn, auth.tenant)
  const plan = getPlan(sub.tier)!
  const usage = await meter(auth, period)
  const invoice = buildInvoice({ tenant: auth.tenant, period, sub, plan, usage })

  await touchUser(conn, auth.user)
  const doc = await putDocument(
    conn,
    auth.tenant,
    INVOICE_KIND,
    period,
    invoice as unknown as Record<string, unknown>,
    auth.user.id,
  )
  return Response.json({ item: invoiceFromDoc(doc), alreadyExisted: false }, { status: 201 })
}

async function payInvoice(auth: Auth, id: string): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const { getDocument, putDocument, touchUser } = await db()
  const doc = await getDocument(conn, auth.tenant, INVOICE_KIND, id)
  if (!doc) return bad('not_found', 404)
  const inv = doc.data as unknown as InvoiceDoc
  if (inv.status === 'paid') return Response.json({ item: invoiceFromDoc(doc) })
  const next = { ...inv, status: 'paid' as const, paidAt: new Date().toISOString() }
  await touchUser(conn, auth.user)
  const saved = await putDocument(
    conn,
    auth.tenant,
    INVOICE_KIND,
    id,
    next as unknown as Record<string, unknown>,
    auth.user.id,
  )
  return Response.json({ item: invoiceFromDoc(saved) })
}

/* ─────────────────── budgets & cost centers ─────────────────── */

type BudgetScope = 'organization' | 'namespace' | 'cost-center'

interface BudgetData {
  name: string
  scope: BudgetScope
  /** Namespace name for scope 'namespace'. */
  scopeRef?: string
  /** Namespace set for scope 'cost-center' (explicit, auditable allocation). */
  namespaces?: string[]
  amountMonthly: number
  /** 0–100. */
  alertThresholdPct: number
  ownerEmail?: string
  /** Cost-center extras. */
  code?: string
}

function parseBudgetBody(
  body: Record<string, unknown>,
  kind: 'budget' | 'cost-center',
  existing?: BudgetData,
): BudgetData | { error: string } {
  const name = typeof body.name === 'string' ? body.name.trim() : existing?.name
  if (!name) return { error: 'name_required' }
  const amount = body.amountMonthly !== undefined ? Number(body.amountMonthly) : existing?.amountMonthly
  if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
    return { error: 'invalid_amount' }
  }
  const threshold =
    body.alertThresholdPct !== undefined ? Number(body.alertThresholdPct) : existing?.alertThresholdPct ?? 80
  if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
    return { error: 'invalid_threshold' }
  }
  let scope: BudgetScope
  if (kind === 'cost-center') {
    scope = 'cost-center'
  } else {
    const s = body.scope !== undefined ? String(body.scope) : existing?.scope ?? 'organization'
    if (s !== 'organization' && s !== 'namespace') return { error: 'invalid_scope' }
    scope = s
  }
  const namespaces = Array.isArray(body.namespaces)
    ? body.namespaces.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : existing?.namespaces
  const scopeRef = typeof body.scopeRef === 'string' ? body.scopeRef : existing?.scopeRef
  if (scope === 'namespace' && !scopeRef) return { error: 'scope_ref_required' }
  return {
    name,
    scope,
    scopeRef,
    namespaces,
    amountMonthly: Math.round(amount * 100) / 100,
    alertThresholdPct: Math.round(threshold),
    ownerEmail: typeof body.ownerEmail === 'string' ? body.ownerEmail : existing?.ownerEmail,
    code: typeof body.code === 'string' ? body.code : existing?.code,
  }
}

function budgetSpend(data: BudgetData, usage: UsageReport): number | null {
  if (usage.costSource !== 'opencost') return null
  if (data.scope === 'organization') return usage.cost
  const wanted =
    data.scope === 'namespace'
      ? (row: string) => row === data.scopeRef
      : (row: string) => (data.namespaces ?? []).includes(row)
  const sum = usage.breakdownByNamespace
    .filter((r) => wanted(r.namespace))
    .reduce((s, r) => s + (r.cost ?? 0), 0)
  return Math.round(sum * 100) / 100
}

/** Linear projection of period spend to month end — derived, labeled as such. */
function projectSpend(spend: number | null, usage: UsageReport): number | null {
  if (spend === null) return null
  const start = new Date(usage.windowStart).getTime()
  const end = new Date(usage.windowEnd).getTime()
  const boundary = Date.UTC(
    new Date(usage.windowStart).getUTCFullYear(),
    new Date(usage.windowStart).getUTCMonth() + 1,
    1,
  )
  const fraction = Math.min(1, Math.max((end - start) / (boundary - start), 1 / 31))
  return Math.round((spend / fraction) * 100) / 100
}

async function budgetRoutes(
  req: Request,
  method: string,
  seg: string[],
  auth: Auth,
  kind: 'budget' | 'cost-center',
): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const { listDocuments, getDocument, putDocument, deleteDocument, touchUser } = await db()
  const isCostCenter = kind === 'cost-center'
  const matches = (d: BudgetData) =>
    isCostCenter ? d.scope === 'cost-center' : d.scope !== 'cost-center'

  if (seg.length === 1 && method === 'GET') {
    const docs = await listDocuments(conn, auth.tenant, BUDGET_KIND)
    const usage = await meter(auth)
    // Previous full month, for cost-center run-rate comparison.
    const prev = isCostCenter ? await previousMonthCosts(usage) : null
    const items = docs
      .map((doc) => ({ doc, data: doc.data as unknown as BudgetData }))
      .filter(({ data }) => matches(data))
      .map(({ doc, data }) => {
        const currentSpend = budgetSpend(data, usage)
        const forecastSpend = projectSpend(currentSpend, usage)
        return {
          id: doc.id,
          ...data,
          currentSpend,
          forecastSpend,
          overBudget:
            currentSpend === null || data.amountMonthly <= 0
              ? null
              : currentSpend > data.amountMonthly,
          trailingMonthSpend: prev ? prev(data) : null,
          costSource: usage.costSource,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        }
      })
    return Response.json({ items, costSource: usage.costSource, period: usage.period })
  }

  if (seg.length === 1 && method === 'POST') {
    const body = await readJson(req)
    if (!body) return bad('invalid_json')
    const parsed = parseBudgetBody(body, kind)
    if ('error' in parsed) return bad(parsed.error)
    await touchUser(conn, auth.user)
    const doc = await putDocument(
      conn,
      auth.tenant,
      BUDGET_KIND,
      crypto.randomUUID(),
      parsed as unknown as Record<string, unknown>,
      auth.user.id,
    )
    return Response.json({ item: { id: doc.id, ...parsed } }, { status: 201 })
  }

  const id = seg[1]
  if (seg.length === 2 && id && ID_RE.test(id)) {
    const doc = await getDocument(conn, auth.tenant, BUDGET_KIND, id)
    if (!doc || !matches(doc.data as unknown as BudgetData)) return bad('not_found', 404)
    if (method === 'PATCH') {
      const body = await readJson(req)
      if (!body) return bad('invalid_json')
      const parsed = parseBudgetBody(body, kind, doc.data as unknown as BudgetData)
      if ('error' in parsed) return bad(parsed.error)
      await touchUser(conn, auth.user)
      const saved = await putDocument(
        conn,
        auth.tenant,
        BUDGET_KIND,
        id,
        parsed as unknown as Record<string, unknown>,
        auth.user.id,
      )
      return Response.json({ item: { id: saved.id, ...parsed } })
    }
    if (method === 'DELETE') {
      const removed = await deleteDocument(conn, auth.tenant, BUDGET_KIND, id)
      return Response.json({ ok: removed })
    }
  }
  return bad('not_found', 404)
}

/** Cost lookup for the previous full month, scoped like budgetSpend. */
async function previousMonthCosts(
  usage: UsageReport,
): Promise<((data: BudgetData) => number | null) | null> {
  if (usage.costSource !== 'opencost') return null
  const start = new Date(usage.windowStart)
  const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1))
  const prevEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const alloc = await openCostAllocation(prevStart, prevEnd, 'namespace')
  if (!alloc) return null
  const byNs = new Map(alloc.map((a) => [a.key, a.cost]))
  const total = alloc.reduce((s, a) => s + a.cost, 0)
  return (data: BudgetData) => {
    let v: number
    if (data.scope === 'organization') v = total
    else if (data.scope === 'namespace') v = byNs.get(data.scopeRef ?? '') ?? 0
    else v = (data.namespaces ?? []).reduce((s, ns) => s + (byNs.get(ns) ?? 0), 0)
    return Math.round(v * 100) / 100
  }
}

/* ─────────────────── cost allocation ─────────────────── */

const ALLOC_DIMENSIONS = new Set(['namespace', 'controller', 'service', 'node', 'cluster'])

async function getAllocation(auth: Auth, dimension: string, period?: string): Promise<Response> {
  if (!ALLOC_DIMENSIONS.has(dimension)) return bad('invalid_dimension')
  if (period !== undefined && !PERIOD_RE.test(period)) return bad('invalid_period')
  const { period: label, start, end } = periodWindow(period)
  const current = await openCostAllocation(start, end, dimension)
  if (!current) {
    return Response.json({ period: label, dimension, costSource: 'unavailable', rows: [] })
  }
  // Previous window of the same length ending at the current start → real MoM delta.
  const prevStart = new Date(start.getTime() - (end.getTime() - start.getTime()))
  const previous = await openCostAllocation(prevStart, start, dimension)
  const prevBy = previous ? new Map(previous.map((a) => [a.key, a.cost])) : null

  // Scope namespace rows to the tenant when the cluster is labeled/prefixed.
  let rows = current
  if (dimension === 'namespace') {
    const usage = await meter(auth, period)
    if (usage.clusterScope === 'tenant-label' || usage.clusterScope === 'tenant-prefix') {
      const names = new Set(usage.breakdownByNamespace.map((b) => b.namespace))
      rows = rows.filter((r) => names.has(r.key))
    }
  }

  const out = rows
    .filter((r) => r.key !== '__idle__' || r.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .map((r) => {
      const prev = prevBy?.get(r.key)
      return {
        key: r.key,
        label: r.key === '__idle__' ? 'idle capacity' : r.key,
        amount: Math.round(r.cost * 100) / 100,
        cpuCoreHours: Math.round(r.cpuCoreHours * 10) / 10,
        memGbHours: Math.round(r.memGbHours * 10) / 10,
        delta: prev !== undefined && prev > 0 ? Math.round(((r.cost - prev) / prev) * 1000) / 1000 : null,
      }
    })
  return Response.json({ period: label, dimension, costSource: 'opencost', rows: out })
}

/* ─────────────────── payment methods ─────────────────── */

const SENSITIVE_KEY_RE = /(number|pan\b|cvc|cvv|cvn|security.?code|track.?data)/i

/** True when a value anywhere in the body looks like a PAN/CVC. */
function containsCardData(value: unknown, key = ''): boolean {
  if (typeof value === 'string') {
    const digits = value.replace(/[\s-]/g, '')
    if (/^\d{12,19}$/.test(digits)) return true
    if (SENSITIVE_KEY_RE.test(key) && /\d/.test(digits)) return true
    return false
  }
  if (Array.isArray(value)) return value.some((v) => containsCardData(v))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([k, v]) => (SENSITIVE_KEY_RE.test(k) && v != null && v !== '') || containsCardData(v, k),
    )
  }
  return false
}

interface PaymentMethodData {
  kind: 'card' | 'invoice' | 'ach'
  label: string
  brand?: string
  /** Last 4 digits only — the metadata a processor shares back. */
  last4?: string
  /** `YYYY-MM`. */
  expiresOn?: string
  holder?: string
  /** Billing contact for `invoice` kind. */
  email?: string
  isDefault: boolean
}

async function listPaymentMethods(auth: Auth): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const { listDocuments } = await db()
  const docs = await listDocuments(conn, auth.tenant, PAYMENT_KIND)
  const items = docs.map((d) => ({
    id: d.id,
    ...(d.data as unknown as PaymentMethodData),
    addedBy: d.createdBy,
    addedAt: d.createdAt,
  }))
  return Response.json({ items })
}

async function addPaymentMethod(req: Request, auth: Auth): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const body = await readJson(req)
  if (!body) return bad('invalid_json')
  // Hard rule: this layer stores processor METADATA only. Anything resembling a
  // full card number or verification code is rejected outright, never stored.
  if (containsCardData(body)) return bad('sensitive_card_data_rejected')

  const kind = ['card', 'invoice', 'ach'].includes(String(body.kind))
    ? (body.kind as PaymentMethodData['kind'])
    : null
  if (!kind) return bad('invalid_kind')
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label) return bad('label_required')
  const last4 = typeof body.last4 === 'string' ? body.last4 : undefined
  if (last4 !== undefined && !/^\d{4}$/.test(last4)) return bad('invalid_last4')
  const expiresOn = typeof body.expiresOn === 'string' ? body.expiresOn : undefined
  if (expiresOn !== undefined && !PERIOD_RE.test(expiresOn)) return bad('invalid_expiry')

  const { listDocuments, putDocument, touchUser } = await db()
  const existing = await listDocuments(conn, auth.tenant, PAYMENT_KIND)
  const data: PaymentMethodData = {
    kind,
    label,
    brand: typeof body.brand === 'string' ? body.brand : undefined,
    last4,
    expiresOn,
    holder: typeof body.holder === 'string' ? body.holder : undefined,
    email: typeof body.email === 'string' ? body.email : undefined,
    isDefault: existing.length === 0 || body.isDefault === true,
  }
  await touchUser(conn, auth.user)
  if (data.isDefault) await clearDefaultFlags(conn, auth, existing)
  const doc = await putDocument(
    conn,
    auth.tenant,
    PAYMENT_KIND,
    crypto.randomUUID(),
    data as unknown as Record<string, unknown>,
    auth.user.id,
  )
  return Response.json(
    { item: { id: doc.id, ...data, addedBy: doc.createdBy, addedAt: doc.createdAt } },
    { status: 201 },
  )
}

async function clearDefaultFlags(
  conn: Conn,
  auth: Auth,
  docs: { id: string; data: Record<string, unknown> }[],
): Promise<void> {
  const { putDocument } = await db()
  for (const d of docs) {
    if ((d.data as { isDefault?: boolean }).isDefault) {
      await putDocument(conn, auth.tenant, PAYMENT_KIND, d.id, { ...d.data, isDefault: false }, auth.user.id)
    }
  }
}

async function patchPaymentMethod(req: Request, auth: Auth, id: string): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const body = await readJson(req)
  if (!body) return bad('invalid_json')
  if (containsCardData(body)) return bad('sensitive_card_data_rejected')
  const { listDocuments, getDocument, putDocument, touchUser } = await db()
  const doc = await getDocument(conn, auth.tenant, PAYMENT_KIND, id)
  if (!doc) return bad('not_found', 404)
  const data = doc.data as unknown as PaymentMethodData
  const next: PaymentMethodData = {
    ...data,
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : data.label,
    isDefault: body.isDefault === true ? true : data.isDefault,
  }
  await touchUser(conn, auth.user)
  if (body.isDefault === true) {
    const all = await listDocuments(conn, auth.tenant, PAYMENT_KIND)
    await clearDefaultFlags(conn, auth, all.filter((d) => d.id !== id))
  }
  const saved = await putDocument(
    conn,
    auth.tenant,
    PAYMENT_KIND,
    id,
    next as unknown as Record<string, unknown>,
    auth.user.id,
  )
  return Response.json({ item: { id: saved.id, ...next, addedBy: saved.createdBy, addedAt: saved.createdAt } })
}

async function deletePaymentMethod(auth: Auth, id: string): Promise<Response> {
  const conn = await getConn()
  if (!conn) return storeUnavailable()
  const { deleteDocument } = await db()
  const removed = await deleteDocument(conn, auth.tenant, PAYMENT_KIND, id)
  return Response.json({ ok: removed }, { status: removed ? 200 : 404 })
}

/* ─────────────────── provider actions ─────────────────── */

async function providerAction(req: Request, auth: Auth, action: string): Promise<Response> {
  const provider = getBillingProvider()
  const body = (await readJson(req)) ?? {}
  const returnUrl =
    typeof body.returnUrl === 'string' ? body.returnUrl : new URL(req.url).origin + '/workspace'

  if (action === 'checkout') {
    const plan = getPlan(String(body.tier))
    if (!plan) return bad('unknown_tier')
    const seats = Number.isInteger(Number(body.seats)) && Number(body.seats) >= 1 ? Number(body.seats) : 1
    const result = await provider.createCheckout({
      tenant: auth.tenant,
      tier: plan.id,
      seats,
      returnUrl,
    })
    return Response.json({ provider: provider.id, ...result })
  }
  if (action === 'portal') {
    const result = await provider.openPortal({ tenant: auth.tenant, returnUrl })
    return Response.json({ provider: provider.id, ...result })
  }
  if (action === 'sync') {
    const result = await provider.syncInvoices({ tenant: auth.tenant })
    return Response.json({ provider: provider.id, ...result })
  }
  return bad('not_found', 404)
}
