/**
 * Enterprise data fixtures — SSO, MFA, security policies, compliance,
 * invoices, payment methods, cost centers, budgets, cost allocation.
 *
 * Until the workspace BFF surfaces these endpoints, the views read from
 * these fixtures via TanStack Query so the UX is interactive and the swap
 * to real `wsClient.*` calls is one-line per hook.
 */

import { useQuery } from '@tanstack/react-query'

/* ─────────────────── Identity & Access ─────────────────── */

export type SsoProtocol = 'oidc' | 'saml'
export type SsoStatus = 'configured' | 'pending' | 'disabled'

export interface SsoConnection {
  id: string
  name: string
  protocol: SsoProtocol
  status: SsoStatus
  domain: string
  enforced: boolean
  metadataUrl: string
  acsUrl: string
  entityId: string
  jit: boolean
  /** Members provisioned via this connection (count). */
  memberCount: number
  lastUsedAt?: string
}

export const STUB_SSO: SsoConnection[] = [
  {
    id: 'sso-okta',
    name: 'Okta (corporate)',
    protocol: 'oidc',
    status: 'configured',
    domain: 'acme.com',
    enforced: true,
    metadataUrl: 'https://acme.okta.com/.well-known/openid-configuration',
    acsUrl: 'https://console.adhar.io/auth/sso/okta/callback',
    entityId: 'urn:adhar:console:acme',
    jit: true,
    memberCount: 142,
    lastUsedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 'sso-azure',
    name: 'Microsoft Entra (legacy)',
    protocol: 'saml',
    status: 'pending',
    domain: 'legacy.acme.com',
    enforced: false,
    metadataUrl: 'https://login.microsoftonline.com/.../federationmetadata',
    acsUrl: 'https://console.adhar.io/auth/sso/saml/callback',
    entityId: 'urn:adhar:console:acme:saml',
    jit: false,
    memberCount: 0,
  },
]

export type ScimStatus = 'active' | 'paused' | 'error'

export interface ScimConnection {
  id: string
  provider: 'okta' | 'entra' | 'jumpcloud' | 'google'
  status: ScimStatus
  endpoint: string
  tokenLastRotatedAt: string
  syncedAt?: string
  syncedUsers: number
  syncedGroups: number
}

export const STUB_SCIM: ScimConnection[] = [
  {
    id: 'scim-okta',
    provider: 'okta',
    status: 'active',
    endpoint: 'https://api.adhar.io/scim/v2/acme',
    tokenLastRotatedAt: new Date(Date.now() - 14 * 24 * 3600_000).toISOString(),
    syncedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
    syncedUsers: 142,
    syncedGroups: 18,
  },
]

export interface MfaPolicy {
  enforced: boolean
  /** Minimum strength required. */
  minimumFactor: 'totp' | 'webauthn'
  /** Roles required to enroll regardless of org-level enforcement. */
  enforcedRoles: string[]
  rememberDeviceDays: number
  /** Recovery codes per user. */
  recoveryCodeCount: number
  /** Members not yet enrolled — count for the dashboard tile. */
  unenrolledMembers: number
}

export const STUB_MFA: MfaPolicy = {
  enforced: true,
  minimumFactor: 'totp',
  enforcedRoles: ['owner', 'admin', 'security', 'billing'],
  rememberDeviceDays: 7,
  recoveryCodeCount: 10,
  unenrolledMembers: 3,
}

export interface SessionPolicy {
  /** Idle timeout in minutes. */
  idleMinutes: number
  /** Absolute maximum session lifetime in hours. */
  absoluteHours: number
  /** Reauthenticate for risky actions (delete, transfer, payment). */
  stepUpForRisky: boolean
  /** Require re-auth for billing changes. */
  stepUpForBilling: boolean
  /** Single concurrent session enforced. */
  singleConcurrent: boolean
}

export const STUB_SESSION: SessionPolicy = {
  idleMinutes: 30,
  absoluteHours: 12,
  stepUpForRisky: true,
  stepUpForBilling: true,
  singleConcurrent: false,
}

export interface IpAllowEntry {
  id: string
  cidr: string
  label: string
  scope: 'console' | 'api' | 'both'
  addedBy: string
  addedAt: string
}

export const STUB_IP_ALLOWLIST: IpAllowEntry[] = [
  {
    id: 'ip-1',
    cidr: '203.0.113.0/24',
    label: 'HQ office (San Francisco)',
    scope: 'both',
    addedBy: 'priya@acme.com',
    addedAt: new Date(Date.now() - 90 * 24 * 3600_000).toISOString(),
  },
  {
    id: 'ip-2',
    cidr: '198.51.100.0/24',
    label: 'EU office (Berlin)',
    scope: 'both',
    addedBy: 'mira@acme.com',
    addedAt: new Date(Date.now() - 60 * 24 * 3600_000).toISOString(),
  },
  {
    id: 'ip-3',
    cidr: '10.42.0.0/16',
    label: 'Production VPN (Tailscale tailnet)',
    scope: 'api',
    addedBy: 'priya@acme.com',
    addedAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
  },
]

/* ─────────────────── Security policies & compliance ─────────────────── */

export interface SecurityPolicy {
  passwordMinLength: number
  passwordRotationDays: number
  passwordHistory: number
  /** Block deploys signed by a non-allow-listed CI runner. */
  signedDeploysOnly: boolean
  /** Encrypt object storage with customer-managed keys. */
  cmkEnabled: boolean
  cmkProvider: 'aws-kms' | 'gcp-kms' | 'azure-kv' | 'vault'
  auditRetentionDays: number
  dataExportApprovalRequired: boolean
}

export const STUB_SECURITY: SecurityPolicy = {
  passwordMinLength: 14,
  passwordRotationDays: 90,
  passwordHistory: 6,
  signedDeploysOnly: true,
  cmkEnabled: true,
  cmkProvider: 'aws-kms',
  auditRetentionDays: 365,
  dataExportApprovalRequired: true,
}

export type ComplianceStatus = 'certified' | 'in-progress' | 'not-started'
export interface ComplianceFramework {
  id: string
  name: string
  status: ComplianceStatus
  controlsTotal: number
  controlsPassing: number
  certifiedAt?: string
  nextAuditAt?: string
  reportUrl?: string
}

export const STUB_COMPLIANCE: ComplianceFramework[] = [
  {
    id: 'soc2-typeii',
    name: 'SOC 2 Type II',
    status: 'certified',
    controlsTotal: 87,
    controlsPassing: 87,
    certifiedAt: '2026-01-15',
    nextAuditAt: '2026-12-15',
    reportUrl: 'https://trust.adhar.io/soc2',
  },
  {
    id: 'iso-27001',
    name: 'ISO 27001:2022',
    status: 'certified',
    controlsTotal: 114,
    controlsPassing: 114,
    certifiedAt: '2026-03-01',
    nextAuditAt: '2027-03-01',
    reportUrl: 'https://trust.adhar.io/iso27001',
  },
  {
    id: 'gdpr',
    name: 'GDPR',
    status: 'certified',
    controlsTotal: 42,
    controlsPassing: 42,
    certifiedAt: '2025-11-01',
  },
  {
    id: 'hipaa',
    name: 'HIPAA',
    status: 'in-progress',
    controlsTotal: 56,
    controlsPassing: 41,
    nextAuditAt: '2026-08-01',
  },
  {
    id: 'pci-dss',
    name: 'PCI DSS 4.0',
    status: 'not-started',
    controlsTotal: 64,
    controlsPassing: 0,
  },
]

export interface ApprovalPolicy {
  id: string
  scope:
    | 'production-deploy'
    | 'budget-increase'
    | 'role-grant-owner'
    | 'data-export'
    | 'destructive-rbac'
    | 'cluster-delete'
  description: string
  approversRequired: number
  approverRoles: string[]
  enabled: boolean
}

export const STUB_APPROVALS: ApprovalPolicy[] = [
  {
    id: 'ap-prod',
    scope: 'production-deploy',
    description: 'Promotion to a Kargo stage tagged "production".',
    approversRequired: 2,
    approverRoles: ['admin', 'security'],
    enabled: true,
  },
  {
    id: 'ap-budget',
    scope: 'budget-increase',
    description: 'Lifting a budget cap by more than 10%.',
    approversRequired: 1,
    approverRoles: ['finance', 'owner'],
    enabled: true,
  },
  {
    id: 'ap-owner',
    scope: 'role-grant-owner',
    description: 'Granting the Owner role to any member.',
    approversRequired: 2,
    approverRoles: ['owner'],
    enabled: true,
  },
  {
    id: 'ap-export',
    scope: 'data-export',
    description: 'Bulk exporting tenant data outside the home region.',
    approversRequired: 2,
    approverRoles: ['security', 'owner'],
    enabled: true,
  },
  {
    id: 'ap-rbac',
    scope: 'destructive-rbac',
    description: 'Removing the only Owner / disabling SSO enforcement.',
    approversRequired: 2,
    approverRoles: ['owner', 'security'],
    enabled: true,
  },
  {
    id: 'ap-cluster',
    scope: 'cluster-delete',
    description: 'Deleting a Kubernetes cluster registered in the platform.',
    approversRequired: 2,
    approverRoles: ['admin', 'owner'],
    enabled: false,
  },
]

/* ─────────────────── Billing & finance ─────────────────── */

export type PaymentMethodKind = 'card' | 'invoice' | 'ach'
export interface PaymentMethod {
  id: string
  kind: PaymentMethodKind
  label: string
  /** Last 4 digits or invoice contact email. */
  identifier: string
  brand?: string
  expiresOn?: string
  isDefault: boolean
  addedBy: string
  addedAt: string
}

export const STUB_PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: 'pm-1',
    kind: 'card',
    label: 'Corporate Visa',
    identifier: '•••• 4242',
    brand: 'Visa',
    expiresOn: '2027-04',
    isDefault: true,
    addedBy: 'finance@acme.com',
    addedAt: new Date(Date.now() - 220 * 24 * 3600_000).toISOString(),
  },
  {
    id: 'pm-2',
    kind: 'invoice',
    label: 'Net-30 invoice',
    identifier: 'ap@acme.com',
    isDefault: false,
    addedBy: 'finance@acme.com',
    addedAt: new Date(Date.now() - 90 * 24 * 3600_000).toISOString(),
  },
  {
    id: 'pm-3',
    kind: 'ach',
    label: 'ACH (Mercury)',
    identifier: '•••• 8821',
    isDefault: false,
    addedBy: 'finance@acme.com',
    addedAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
  },
]

export type InvoiceStatus = 'paid' | 'open' | 'overdue' | 'void'
export interface Invoice {
  id: string
  number: string
  periodStart: string
  periodEnd: string
  amount: number
  currency: 'USD' | 'EUR' | 'GBP'
  status: InvoiceStatus
  dueAt: string
  paidAt?: string
  pdfUrl: string
  /** Per-line summary, used in the detail row. */
  lines: { label: string; quantity: number; unit: string; amount: number }[]
}

const INVOICE_LINE = (label: string, quantity: number, unit: string, amount: number) => ({
  label,
  quantity,
  unit,
  amount,
})

function months(n: number) {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - n)
  return d.toISOString().slice(0, 10)
}

export const STUB_INVOICES: Invoice[] = [
  {
    id: 'inv-2024-12',
    number: 'INV-2024-12-001',
    periodStart: months(0),
    periodEnd: new Date().toISOString().slice(0, 10),
    amount: 12480,
    currency: 'USD',
    status: 'open',
    dueAt: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(),
    pdfUrl: 'https://billing.adhar.io/invoices/INV-2024-12-001.pdf',
    lines: [
      INVOICE_LINE('Business plan — seats', 142, 'seat-month', 11218),
      INVOICE_LINE('Log retention overage', 312, 'GB', 936),
      INVOICE_LINE('Premium support', 1, 'mo', 326),
    ],
  },
  {
    id: 'inv-2024-11',
    number: 'INV-2024-11-001',
    periodStart: months(1),
    periodEnd: months(0),
    amount: 11842,
    currency: 'USD',
    status: 'paid',
    dueAt: months(0),
    paidAt: months(0),
    pdfUrl: 'https://billing.adhar.io/invoices/INV-2024-11-001.pdf',
    lines: [
      INVOICE_LINE('Business plan — seats', 138, 'seat-month', 10902),
      INVOICE_LINE('Log retention overage', 280, 'GB', 840),
      INVOICE_LINE('Premium support', 1, 'mo', 100),
    ],
  },
  {
    id: 'inv-2024-10',
    number: 'INV-2024-10-001',
    periodStart: months(2),
    periodEnd: months(1),
    amount: 11264,
    currency: 'USD',
    status: 'paid',
    dueAt: months(1),
    paidAt: months(1),
    pdfUrl: 'https://billing.adhar.io/invoices/INV-2024-10-001.pdf',
    lines: [
      INVOICE_LINE('Business plan — seats', 132, 'seat-month', 10428),
      INVOICE_LINE('Log retention overage', 264, 'GB', 792),
      INVOICE_LINE('Premium support', 1, 'mo', 44),
    ],
  },
  {
    id: 'inv-2024-09',
    number: 'INV-2024-09-001',
    periodStart: months(3),
    periodEnd: months(2),
    amount: 10800,
    currency: 'USD',
    status: 'overdue',
    dueAt: months(1),
    pdfUrl: 'https://billing.adhar.io/invoices/INV-2024-09-001.pdf',
    lines: [
      INVOICE_LINE('Business plan — seats', 128, 'seat-month', 10112),
      INVOICE_LINE('Log retention overage', 230, 'GB', 690),
    ],
  },
]

export interface CostCenter {
  id: string
  code: string
  name: string
  ownerEmail: string
  /** Hard cap (USD/mo). */
  monthlyBudget: number
  monthToDateSpend: number
  trailingMonthSpend: number
  tagSelector: string
}

export const STUB_COST_CENTERS: CostCenter[] = [
  {
    id: 'cc-r-and-d',
    code: 'CC-100',
    name: 'R&D Engineering',
    ownerEmail: 'priya@acme.com',
    monthlyBudget: 12000,
    monthToDateSpend: 8412,
    trailingMonthSpend: 11920,
    tagSelector: 'team in (platform, infra, web)',
  },
  {
    id: 'cc-data',
    code: 'CC-200',
    name: 'Data & Analytics',
    ownerEmail: 'mira@acme.com',
    monthlyBudget: 6500,
    monthToDateSpend: 4980,
    trailingMonthSpend: 6210,
    tagSelector: 'team=data',
  },
  {
    id: 'cc-customer',
    code: 'CC-300',
    name: 'Customer Operations',
    ownerEmail: 'jordan@acme.com',
    monthlyBudget: 3200,
    monthToDateSpend: 1430,
    trailingMonthSpend: 2980,
    tagSelector: 'team=cx',
  },
  {
    id: 'cc-corp',
    code: 'CC-900',
    name: 'Corporate IT',
    ownerEmail: 'sam@acme.com',
    monthlyBudget: 1800,
    monthToDateSpend: 1620,
    trailingMonthSpend: 1740,
    tagSelector: 'team=it',
  },
]

export interface Budget {
  id: string
  scope: 'organization' | 'cost-center' | 'project' | 'environment'
  scopeRef?: string
  name: string
  amount: number
  currency: 'USD' | 'EUR'
  /** 0..1 — alert thresholds. */
  alertThresholds: number[]
  forecastSpend: number
  currentSpend: number
  hardLimit: boolean
  ownerEmail: string
}

export const STUB_BUDGETS: Budget[] = [
  {
    id: 'b-org',
    scope: 'organization',
    name: 'Acme · Monthly',
    amount: 28000,
    currency: 'USD',
    alertThresholds: [0.6, 0.8, 0.95],
    forecastSpend: 26580,
    currentSpend: 16442,
    hardLimit: false,
    ownerEmail: 'finance@acme.com',
  },
  {
    id: 'b-prod',
    scope: 'environment',
    scopeRef: 'production',
    name: 'production · Monthly',
    amount: 14000,
    currency: 'USD',
    alertThresholds: [0.7, 0.9, 1.0],
    forecastSpend: 13110,
    currentSpend: 8120,
    hardLimit: true,
    ownerEmail: 'priya@acme.com',
  },
  {
    id: 'b-data',
    scope: 'cost-center',
    scopeRef: 'cc-data',
    name: 'CC-200 Data · Monthly',
    amount: 6500,
    currency: 'USD',
    alertThresholds: [0.7, 0.9, 1.0],
    forecastSpend: 6020,
    currentSpend: 4980,
    hardLimit: false,
    ownerEmail: 'mira@acme.com',
  },
]

export type AllocationDimension = 'project' | 'environment' | 'team' | 'cluster' | 'service'
export interface AllocationRow {
  key: string
  label: string
  amount: number
  delta: number
}

export const STUB_ALLOCATION: Record<AllocationDimension, AllocationRow[]> = {
  project: [
    { key: 'console', label: 'adhar-console', amount: 4280, delta: 0.08 },
    { key: 'payments', label: 'payments-api', amount: 3120, delta: 0.12 },
    { key: 'ingest', label: 'data-ingest', amount: 2480, delta: -0.04 },
    { key: 'ml', label: 'ml-feature-store', amount: 1680, delta: 0.31 },
    { key: 'docs', label: 'docs-site', amount: 240, delta: -0.18 },
  ],
  environment: [
    { key: 'production', label: 'production', amount: 8120, delta: 0.06 },
    { key: 'staging', label: 'staging', amount: 2410, delta: -0.05 },
    { key: 'preview', label: 'preview', amount: 980, delta: 0.18 },
    { key: 'dev', label: 'dev', amount: 412, delta: 0.0 },
  ],
  team: [
    { key: 'platform', label: 'platform', amount: 5680, delta: 0.04 },
    { key: 'data', label: 'data', amount: 4980, delta: 0.11 },
    { key: 'web', label: 'web', amount: 2360, delta: -0.02 },
    { key: 'cx', label: 'cx', amount: 1430, delta: -0.06 },
    { key: 'it', label: 'it', amount: 1620, delta: 0.07 },
  ],
  cluster: [
    { key: 'prod-eu-1', label: 'prod-eu-1', amount: 6020, delta: 0.07 },
    { key: 'prod-us-1', label: 'prod-us-1', amount: 5240, delta: 0.04 },
    { key: 'staging-eu-1', label: 'staging-eu-1', amount: 1980, delta: -0.08 },
    { key: 'devbox', label: 'devbox', amount: 612, delta: 0.0 },
  ],
  service: [
    { key: 'api', label: 'api', amount: 3640, delta: 0.05 },
    { key: 'worker', label: 'worker', amount: 2510, delta: 0.21 },
    { key: 'web', label: 'web', amount: 1860, delta: -0.03 },
    { key: 'ml', label: 'ml', amount: 1320, delta: 0.27 },
    { key: 'log-pipe', label: 'log-pipeline', amount: 980, delta: 0.06 },
  ],
}

/* ─────────────────── React Query hooks ─────────────────── */

const KEY = (name: string) => ['ws-enterprise', name] as const

const SLOW = 80

function delay<T>(value: T, ms = SLOW): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export function useSsoConnections() {
  return useQuery({ queryKey: KEY('sso'), queryFn: () => delay(STUB_SSO), staleTime: 60_000 })
}

export function useScimConnections() {
  return useQuery({ queryKey: KEY('scim'), queryFn: () => delay(STUB_SCIM), staleTime: 60_000 })
}

export function useMfaPolicy() {
  return useQuery({ queryKey: KEY('mfa'), queryFn: () => delay(STUB_MFA), staleTime: 60_000 })
}

export function useSessionPolicy() {
  return useQuery({ queryKey: KEY('session'), queryFn: () => delay(STUB_SESSION), staleTime: 60_000 })
}

export function useIpAllowlist() {
  return useQuery({ queryKey: KEY('ipallow'), queryFn: () => delay(STUB_IP_ALLOWLIST), staleTime: 60_000 })
}

export function useSecurityPolicy() {
  return useQuery({ queryKey: KEY('security'), queryFn: () => delay(STUB_SECURITY), staleTime: 60_000 })
}

export function useCompliance() {
  return useQuery({ queryKey: KEY('compliance'), queryFn: () => delay(STUB_COMPLIANCE), staleTime: 60_000 })
}

export function useApprovals() {
  return useQuery({ queryKey: KEY('approvals'), queryFn: () => delay(STUB_APPROVALS), staleTime: 60_000 })
}

export function usePaymentMethods() {
  return useQuery({ queryKey: KEY('payments'), queryFn: () => delay(STUB_PAYMENT_METHODS), staleTime: 60_000 })
}

export function useInvoices() {
  return useQuery({ queryKey: KEY('invoices'), queryFn: () => delay(STUB_INVOICES), staleTime: 60_000 })
}

export function useCostCenters() {
  return useQuery({ queryKey: KEY('cost-centers'), queryFn: () => delay(STUB_COST_CENTERS), staleTime: 60_000 })
}

export function useBudgets() {
  return useQuery({ queryKey: KEY('budgets'), queryFn: () => delay(STUB_BUDGETS), staleTime: 60_000 })
}

export function useAllocation(dim: AllocationDimension) {
  return useQuery({
    queryKey: KEY(`alloc:${dim}`),
    queryFn: () => delay(STUB_ALLOCATION[dim]),
    staleTime: 60_000,
  })
}

/* ─────────────────── small currency helpers ─────────────────── */

export function fmtMoney(n: number, currency: string = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toLocaleString()}`
  }
}

export function fmtMoneyShort(n: number, currency: string = 'USD'): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ${currency}`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k ${currency}`
  return `${n} ${currency}`
}
