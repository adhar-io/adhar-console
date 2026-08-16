import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CURRENT_ORG_SLUG } from './client.ts'

/**
 * Billing data layer — real `/api/billing/*` BFF calls (Postgres-persisted,
 * usage metered from live sources). Replaces the `enterprise.ts` stubs for the
 * billing views. There is NO fixture fallback here:
 *
 *   - 503 `store_unavailable` → the view shows a "connect a database" state
 *     (`isStoreUnavailable`).
 *   - OpenCost not configured → `cost` fields are `null` with
 *     `costSource: 'unavailable'` and the view says "cost data not connected".
 *     A dollar figure in the UI is always a metered number.
 */

/* ─────────────────── fetch wrapper ─────────────────── */

export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'BillingError'
  }
}

export function isStoreUnavailable(e: unknown): boolean {
  return e instanceof BillingError && (e.code === 'store_unavailable' || e.status === 503)
}

async function billingFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/billing/${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    let code: string | undefined
    try {
      code = ((await res.json()) as { error?: string }).error
    } catch {
      /* non-JSON error body */
    }
    throw new BillingError(
      code === 'store_unavailable'
        ? 'The console database is not available.'
        : `Billing request failed (${res.status}${code ? `: ${code}` : ''})`,
      res.status,
      code,
    )
  }
  return (await res.json()) as T
}

/* ─────────────────── types (mirror the BFF) ─────────────────── */

export type PlanTier = 'free' | 'team' | 'business' | 'enterprise'

export interface PlanLimits {
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
  pricePerSeatMonthly: number
  currency: 'USD'
  contactSales?: boolean
  supportTier: 'community' | 'email' | 'priority' | 'dedicated'
  limits: PlanLimits
  includedNamespaces: number | null
  namespaceOverageMonthly: number
  includes: string[]
}

export interface Subscription {
  tier: PlanTier
  seatsPurchased: number
  billingCycle: 'monthly' | 'annual'
  status: 'active' | 'trialing' | 'past_due' | 'canceled'
  startedAt: string
  renewsAt: string
  provider: 'local' | 'stripe'
}

export interface SubscriptionSummary {
  item: Subscription
  plan: PlanDef
  persisted: boolean
  seatsUsed: number
  priceMonthly: number
  currency: string
  paymentMethod: string | null
}

export interface NamespaceUsage {
  namespace: string
  cost: number | null
  cpuCoreHours: number | null
  memGbHours: number | null
  pods: number | null
}

export interface UsageReport {
  period: string
  windowStart: string
  windowEnd: string
  seats: number | null
  seatsSource: 'workspace.member' | 'unavailable'
  namespaces: number | null
  pods: number | null
  nodes: number | null
  clusterSource: 'kubernetes' | 'unavailable'
  clusterScope: 'tenant-label' | 'tenant-prefix' | 'cluster' | null
  cpuCoreHours: number | null
  memGbHours: number | null
  cost: number | null
  costSource: 'opencost' | 'unavailable'
  breakdownByNamespace: NamespaceUsage[]
}

export interface InvoiceLine {
  label: string
  quantity: number
  unit: string
  unitAmount: number
  amount: number
}

export type InvoiceStatus = 'open' | 'paid' | 'void'

export interface Invoice {
  id: string
  number: string
  period: string
  periodStart: string
  periodEnd: string
  currency: 'USD'
  lineItems: InvoiceLine[]
  subtotal: number
  taxRate: number
  tax: number
  total: number
  status: InvoiceStatus
  issuedAt: string
  dueAt: string
  paidAt?: string
  notes: string[]
}

export type BudgetScope = 'organization' | 'namespace' | 'cost-center'

export interface Budget {
  id: string
  name: string
  scope: BudgetScope
  scopeRef?: string
  namespaces?: string[]
  amountMonthly: number
  alertThresholdPct: number
  ownerEmail?: string
  code?: string
  /** Metered — null when cost data is not connected. */
  currentSpend: number | null
  /** Linear projection of the metered spend to month end. */
  forecastSpend: number | null
  overBudget: boolean | null
  trailingMonthSpend: number | null
  costSource: 'opencost' | 'unavailable'
  createdAt: string
  updatedAt: string
}

export interface BudgetInput {
  name: string
  scope?: 'organization' | 'namespace'
  scopeRef?: string
  namespaces?: string[]
  amountMonthly: number
  alertThresholdPct: number
  ownerEmail?: string
  code?: string
}

export type AllocationDimension = 'namespace' | 'controller' | 'service' | 'node' | 'cluster'

export interface AllocationRow {
  key: string
  label: string
  amount: number
  cpuCoreHours: number
  memGbHours: number
  /** Real MoM delta (previous equal window); null when no prior data. */
  delta: number | null
}

export interface AllocationResult {
  period: string
  dimension: AllocationDimension
  costSource: 'opencost' | 'unavailable'
  rows: AllocationRow[]
}

export type PaymentMethodKind = 'card' | 'invoice' | 'ach'

export interface PaymentMethod {
  id: string
  kind: PaymentMethodKind
  label: string
  brand?: string
  last4?: string
  expiresOn?: string
  holder?: string
  email?: string
  isDefault: boolean
  addedBy: string | null
  addedAt: string
}

export interface PaymentMethodInput {
  kind: PaymentMethodKind
  label: string
  brand?: string
  last4?: string
  expiresOn?: string
  holder?: string
  email?: string
  isDefault?: boolean
}

export interface ProviderInfo {
  id: 'local' | 'stripe'
  configured: boolean
}

/* ─────────────────── query keys ─────────────────── */

const KEY = (...parts: (string | undefined)[]) =>
  ['billing', CURRENT_ORG_SLUG, ...parts.filter(Boolean)] as const

/* ─────────────────── plans & subscription ─────────────────── */

export function usePlans() {
  return useQuery({
    queryKey: KEY('plans'),
    queryFn: () => billingFetch<{ plans: PlanDef[] }>('plans').then((r) => r.plans),
    staleTime: 5 * 60_000,
  })
}

export function useSubscription() {
  return useQuery({
    queryKey: KEY('subscription'),
    queryFn: () => billingFetch<SubscriptionSummary>('subscription'),
    retry: (count, err) => !isStoreUnavailable(err) && count < 2,
  })
}

export function useUpdateSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<Pick<Subscription, 'tier' | 'seatsPurchased' | 'billingCycle' | 'status'>>) =>
      billingFetch<{ item: Subscription }>('subscription', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEY('subscription') })
      qc.invalidateQueries({ queryKey: KEY('usage') })
    },
  })
}

/* ─────────────────── usage ─────────────────── */

export function useUsage(period?: string) {
  return useQuery({
    queryKey: KEY('usage', period),
    queryFn: () =>
      billingFetch<UsageReport>(`usage${period ? `?period=${encodeURIComponent(period)}` : ''}`),
    staleTime: 60_000,
  })
}

/* ─────────────────── invoices ─────────────────── */

export function useBillingInvoices() {
  return useQuery({
    queryKey: KEY('invoices'),
    queryFn: () => billingFetch<{ items: Invoice[] }>('invoices').then((r) => r.items),
    retry: (count, err) => !isStoreUnavailable(err) && count < 2,
  })
}

export function useGenerateInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (period?: string) =>
      billingFetch<{ item: Invoice; alreadyExisted: boolean }>('invoices/generate', {
        method: 'POST',
        body: JSON.stringify(period ? { period } : {}),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY('invoices') }),
  })
}

export function usePayInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      billingFetch<{ item: Invoice }>(`invoices/${encodeURIComponent(id)}/pay`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY('invoices') }),
  })
}

/**
 * Download the server-rendered HTML invoice as a `data:` URL — self-contained,
 * printable to PDF from the browser; no PDF library involved.
 */
export async function downloadInvoice(id: string): Promise<void> {
  const { item, html } = await billingFetch<{ item: Invoice; html: string }>(
    `invoices/${encodeURIComponent(id)}`,
  )
  const a = document.createElement('a')
  a.href = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  a.download = `${item.number}.html`
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/* ─────────────────── budgets ─────────────────── */

export function useBillingBudgets() {
  return useQuery({
    queryKey: KEY('budgets'),
    queryFn: () => billingFetch<{ items: Budget[] }>('budgets').then((r) => r.items),
    retry: (count, err) => !isStoreUnavailable(err) && count < 2,
  })
}

export function useSaveBudget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id?: string; input: BudgetInput }) =>
      v.id
        ? billingFetch<{ item: Budget }>(`budgets/${encodeURIComponent(v.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(v.input),
          })
        : billingFetch<{ item: Budget }>('budgets', {
            method: 'POST',
            body: JSON.stringify(v.input),
          }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY('budgets') }),
  })
}

export function useDeleteBudget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      billingFetch<{ ok: boolean }>(`budgets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY('budgets') }),
  })
}

/* ─────────────────── cost centers (billing.budget, scope 'cost-center') ─────────────────── */

export function useBillingCostCenters() {
  return useQuery({
    queryKey: KEY('cost-centers'),
    queryFn: () => billingFetch<{ items: Budget[] }>('cost-centers').then((r) => r.items),
    retry: (count, err) => !isStoreUnavailable(err) && count < 2,
  })
}

export function useSaveCostCenter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id?: string; input: BudgetInput }) =>
      v.id
        ? billingFetch<{ item: Budget }>(`cost-centers/${encodeURIComponent(v.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(v.input),
          })
        : billingFetch<{ item: Budget }>('cost-centers', {
            method: 'POST',
            body: JSON.stringify(v.input),
          }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY('cost-centers') }),
  })
}

export function useDeleteCostCenter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      billingFetch<{ ok: boolean }>(`cost-centers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY('cost-centers') }),
  })
}

/* ─────────────────── cost allocation ─────────────────── */

export function useAllocation(dimension: AllocationDimension) {
  return useQuery({
    queryKey: KEY('allocation', dimension),
    queryFn: () => billingFetch<AllocationResult>(`allocation?dimension=${dimension}`),
    staleTime: 60_000,
  })
}

/* ─────────────────── payment methods ─────────────────── */

export function useBillingPaymentMethods() {
  return useQuery({
    queryKey: KEY('payment-methods'),
    queryFn: () => billingFetch<{ items: PaymentMethod[] }>('payment-methods').then((r) => r.items),
    retry: (count, err) => !isStoreUnavailable(err) && count < 2,
  })
}

export function useAddPaymentMethod() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: PaymentMethodInput) =>
      billingFetch<{ item: PaymentMethod }>('payment-methods', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY('payment-methods') }),
  })
}

export function useSetDefaultPaymentMethod() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      billingFetch<{ item: PaymentMethod }>(`payment-methods/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEY('payment-methods') })
      qc.invalidateQueries({ queryKey: KEY('subscription') })
    },
  })
}

export function useDeletePaymentMethod() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      billingFetch<{ ok: boolean }>(`payment-methods/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY('payment-methods') }),
  })
}

/* ─────────────────── provider ─────────────────── */

export function useBillingProvider() {
  return useQuery({
    queryKey: KEY('provider'),
    queryFn: () => billingFetch<ProviderInfo>('provider'),
    staleTime: 5 * 60_000,
  })
}

/* ─────────────────── currency helpers ─────────────────── */

export function fmtMoney(n: number, currency: string = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: n % 1 === 0 ? 0 : 2,
    }).format(n)
  } catch {
    return `${currency} ${n.toLocaleString()}`
  }
}

export function fmtMoneyShort(n: number, currency: string = 'USD'): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ${currency}`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k ${currency}`
  return `${n} ${currency}`
}
