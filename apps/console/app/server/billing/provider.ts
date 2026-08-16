import { env } from '@adhar-console/utils'

/**
 * Billing domain model + provider seam.
 *
 * The PLAN_CATALOG is the console's public price list (product configuration,
 * versioned with the code — not per-tenant data). Subscriptions, invoices,
 * budgets and payment-method metadata are persisted per tenant in the Postgres
 * document store (`billing.*` kinds).
 *
 * `BillingProvider` is the seam a real payment processor plugs into. The
 * console's API shape is identical regardless of the provider:
 *   - `LocalProvider` (default) — everything is served from Postgres; checkout
 *     and portal are the console's own billing pages, invoice generation is
 *     local. No external calls, no card data, ever.
 *   - `StripeProvider` — a fetch-based stub gated on `STRIPE_SECRET_KEY`.
 *     When the key is unset every call returns `not_configured` cleanly so the
 *     UI can say "connect Stripe" instead of failing. No Stripe SDK.
 */

/* ─────────────────── plan catalog ─────────────────── */

export type PlanTier = 'free' | 'team' | 'business' | 'enterprise'

export interface PlanLimits {
  /** Max purchasable seats. `null` = unlimited. */
  seats: number | null
  namespaces: number | null
  cpuCores: number | null
  memGb: number | null
  projects: number | null
  environments: number | null
  clusters: number | null
  storageGb: number | null
}

export interface PlanDef {
  id: PlanTier
  name: string
  summary: string
  /** USD per seat per month. 0 for free; enterprise is custom (contactSales). */
  pricePerSeatMonthly: number
  currency: 'USD'
  contactSales?: boolean
  supportTier: 'community' | 'email' | 'priority' | 'dedicated'
  limits: PlanLimits
  /** Namespaces included before overage billing kicks in (= limits.namespaces unless unlimited). */
  includedNamespaces: number | null
  /** USD per namespace-month above the included count. 0 ⇒ hard limit, no overage. */
  namespaceOverageMonthly: number
  includes: string[]
}

export const PLAN_CATALOG: PlanDef[] = [
  {
    id: 'free',
    name: 'Free',
    summary: 'Solo devs and side projects.',
    pricePerSeatMonthly: 0,
    currency: 'USD',
    supportTier: 'community',
    limits: {
      seats: 3,
      namespaces: 2,
      cpuCores: 4,
      memGb: 8,
      projects: 1,
      environments: 2,
      clusters: 1,
      storageGb: 5,
    },
    includedNamespaces: 2,
    namespaceOverageMonthly: 0,
    includes: ['1 project', '2 environments', 'Public status page', 'Community support'],
  },
  {
    id: 'team',
    name: 'Team',
    summary: 'Small teams standardizing on the Adhar stack.',
    pricePerSeatMonthly: 29,
    currency: 'USD',
    supportTier: 'email',
    limits: {
      seats: 25,
      namespaces: 10,
      cpuCores: 32,
      memGb: 64,
      projects: 10,
      environments: 30,
      clusters: 3,
      storageGb: 100,
    },
    includedNamespaces: 10,
    namespaceOverageMonthly: 12,
    includes: ['10 projects', '30 environments', 'SSO via Keycloak', 'Email support'],
  },
  {
    id: 'business',
    name: 'Business',
    summary: 'Multi-team orgs with compliance needs.',
    pricePerSeatMonthly: 79,
    currency: 'USD',
    supportTier: 'priority',
    limits: {
      seats: 250,
      namespaces: 50,
      cpuCores: 256,
      memGb: 512,
      projects: 50,
      environments: 200,
      clusters: 10,
      storageGb: 1000,
    },
    includedNamespaces: 50,
    namespaceOverageMonthly: 9,
    includes: [
      '50 projects',
      '200 environments',
      'Audit log (365d)',
      'SAML/OIDC federation',
      'Priority support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    summary: 'Large orgs, air-gapped, or custom SLAs.',
    pricePerSeatMonthly: 0,
    currency: 'USD',
    contactSales: true,
    supportTier: 'dedicated',
    limits: {
      seats: null,
      namespaces: null,
      cpuCores: null,
      memGb: null,
      projects: null,
      environments: null,
      clusters: null,
      storageGb: null,
    },
    includedNamespaces: null,
    namespaceOverageMonthly: 0,
    includes: [
      'Unlimited projects',
      'Unlimited environments',
      'Dedicated support + SLA',
      'On-prem / air-gapped install',
      'Source-available + commercial terms',
    ],
  },
]

export function getPlan(tier: string): PlanDef | undefined {
  return PLAN_CATALOG.find((p) => p.id === tier)
}

/* ─────────────────── subscription ─────────────────── */

export type BillingCycle = 'monthly' | 'annual'
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled'

export interface Subscription {
  tier: PlanTier
  seatsPurchased: number
  billingCycle: BillingCycle
  status: SubscriptionStatus
  startedAt: string
  renewsAt: string
  provider: 'local' | 'stripe'
}

/** First day of the next UTC month — the default renewal boundary. */
export function nextMonthStart(from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))
  return d.toISOString()
}

/** Tenants without a persisted subscription are on the free tier. */
export function defaultSubscription(): Subscription {
  return {
    tier: 'free',
    seatsPurchased: 3,
    billingCycle: 'monthly',
    status: 'active',
    startedAt: new Date().toISOString(),
    renewsAt: nextMonthStart(),
    provider: getBillingProvider().id,
  }
}

/* ─────────────────── provider seam ─────────────────── */

export interface ProviderResult {
  status: 'ok' | 'not_configured' | 'error'
  /** Where to send the browser (checkout page / customer portal). */
  url?: string
  /** Human-readable reason for not_configured / error. */
  detail?: string
  /** Invoices reconciled by syncInvoices. */
  synced?: number
}

export interface BillingProvider {
  readonly id: 'local' | 'stripe'
  readonly configured: boolean
  createCheckout(input: {
    tenant: string
    tier: PlanTier
    seats: number
    returnUrl: string
  }): Promise<ProviderResult>
  openPortal(input: { tenant: string; returnUrl: string }): Promise<ProviderResult>
  syncInvoices(input: { tenant: string }): Promise<ProviderResult>
}

/**
 * Default provider: the console IS the biller. Subscription changes are applied
 * directly against Postgres (PUT /api/billing/subscription), invoices are
 * generated locally from the subscription + metered usage, and the "portal" is
 * the console's own billing section — so checkout/portal simply round-trip the
 * caller back to the app.
 */
class LocalProvider implements BillingProvider {
  readonly id = 'local' as const
  readonly configured = true

  createCheckout(input: { returnUrl: string }): Promise<ProviderResult> {
    // No external processor: the subscription PUT that accompanies this call is
    // the source of truth. Send the browser straight back.
    return Promise.resolve({ status: 'ok', url: input.returnUrl })
  }

  openPortal(input: { returnUrl: string }): Promise<ProviderResult> {
    return Promise.resolve({ status: 'ok', url: input.returnUrl })
  }

  syncInvoices(): Promise<ProviderResult> {
    // Invoices are generated locally (POST /api/billing/invoices/generate);
    // there is no external ledger to reconcile.
    return Promise.resolve({ status: 'ok', synced: 0 })
  }
}

const STRIPE_API = 'https://api.stripe.com/v1'

/**
 * Fetch-based Stripe stub (no SDK). Gated on `STRIPE_SECRET_KEY`: when unset,
 * every method returns `not_configured` so callers degrade cleanly. When set,
 * it speaks the real Stripe REST API with form-encoded bodies.
 */
class StripeProvider implements BillingProvider {
  readonly id = 'stripe' as const

  get configured(): boolean {
    return Boolean(env('STRIPE_SECRET_KEY'))
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const key = env('STRIPE_SECRET_KEY')
    if (!key) throw new Error('not_configured')
    const res = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: res.ok, status: res.status, body }
  }

  private notConfigured(): ProviderResult {
    return { status: 'not_configured', detail: 'STRIPE_SECRET_KEY is not set' }
  }

  async createCheckout(input: {
    tenant: string
    tier: PlanTier
    seats: number
    returnUrl: string
  }): Promise<ProviderResult> {
    if (!this.configured) return this.notConfigured()
    const priceId = env(`STRIPE_PRICE_${input.tier.toUpperCase()}`)
    if (!priceId) {
      return {
        status: 'not_configured',
        detail: `STRIPE_PRICE_${input.tier.toUpperCase()} is not set`,
      }
    }
    try {
      const { ok, status, body } = await this.call('POST', '/checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': String(input.seats),
        client_reference_id: input.tenant,
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
      })
      if (!ok) return { status: 'error', detail: `stripe ${status}` }
      return { status: 'ok', url: String(body.url ?? '') }
    } catch (e) {
      return { status: 'error', detail: e instanceof Error ? e.message : 'stripe unreachable' }
    }
  }

  async openPortal(input: { tenant: string; returnUrl: string }): Promise<ProviderResult> {
    if (!this.configured) return this.notConfigured()
    const customer = env(`STRIPE_CUSTOMER_${input.tenant.toUpperCase()}`)
    if (!customer) {
      return { status: 'not_configured', detail: 'no Stripe customer mapped for this tenant' }
    }
    try {
      const { ok, status, body } = await this.call('POST', '/billing_portal/sessions', {
        customer,
        return_url: input.returnUrl,
      })
      if (!ok) return { status: 'error', detail: `stripe ${status}` }
      return { status: 'ok', url: String(body.url ?? '') }
    } catch (e) {
      return { status: 'error', detail: e instanceof Error ? e.message : 'stripe unreachable' }
    }
  }

  async syncInvoices(input: { tenant: string }): Promise<ProviderResult> {
    if (!this.configured) return this.notConfigured()
    const customer = env(`STRIPE_CUSTOMER_${input.tenant.toUpperCase()}`)
    if (!customer) {
      return { status: 'not_configured', detail: 'no Stripe customer mapped for this tenant' }
    }
    try {
      const { ok, status, body } = await this.call(
        'GET',
        `/invoices?customer=${encodeURIComponent(customer)}&limit=100`,
      )
      if (!ok) return { status: 'error', detail: `stripe ${status}` }
      const data = Array.isArray(body.data) ? body.data : []
      // Full reconciliation into `billing.invoice` docs lands with the real
      // processor integration; the seam reports what it found.
      return { status: 'ok', synced: data.length }
    } catch (e) {
      return { status: 'error', detail: e instanceof Error ? e.message : 'stripe unreachable' }
    }
  }
}

const local = new LocalProvider()
const stripe = new StripeProvider()

/** Stripe when `STRIPE_SECRET_KEY` is configured, else the local biller. */
export function getBillingProvider(): BillingProvider {
  return stripe.configured ? stripe : local
}
