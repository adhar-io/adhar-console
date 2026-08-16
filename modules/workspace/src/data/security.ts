import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore, type StoredDoc } from '@adhar-console/shell-ui'

/**
 * ENTERPRISE-SECURITY data layer — real, tenant-scoped persistence.
 *
 * Every entity here lives in the console's Postgres document store
 * (`docStore` → `/api/store/<kind>`), exactly like custom roles and
 * webhooks in `client.ts`. There is NO stub fallback: when the database
 * is missing the `DocStoreError` propagates through the query so the
 * views render a "connect a database" state — never fake data.
 *
 * Kinds:
 *   workspace.sso-connection   — SSO provider configs (CRUD)
 *   workspace.security-policy  — singleton (id 'current'): password/session/MFA/…
 *   workspace.ip-allow         — CIDR allowlist entries (CRUD)
 *   workspace.compliance       — singleton (id 'current'): posture + evidence
 *   workspace.integration      — third-party integration configs (CRUD)
 *   workspace.theme            — singleton (id 'current'): tenant-shared theme
 *
 * Honesty rules baked in:
 *   - SSO connections are *saved configuration*; activation happens in
 *     Keycloak. `keycloakSynced` stays false until a real sync exists.
 *   - Integration/discovery "tests" are real browser fetches; when CORS
 *     hides the result we say so instead of inventing a status.
 *   - Secrets are masked before they are persisted — the plaintext token
 *     never reaches the document store.
 */

/* ─────────────────── kinds ─────────────────── */

const SSO_KIND = 'workspace.sso-connection'
const POLICY_KIND = 'workspace.security-policy'
const IP_KIND = 'workspace.ip-allow'
const COMPLIANCE_KIND = 'workspace.compliance'
const INTEGRATION_KIND = 'workspace.integration'
const THEME_KIND = 'workspace.theme'

/** Singleton document id used by policy / compliance / theme kinds. */
const SINGLETON_ID = 'current'

const KEY = {
  sso: ['ws-security', 'sso'] as const,
  policy: ['ws-security', 'policy'] as const,
  ip: ['ws-security', 'ip-allow'] as const,
  compliance: ['ws-security', 'compliance'] as const,
  integrations: ['ws-security', 'integrations'] as const,
  theme: ['ws-security', 'theme'] as const,
  session: ['ws-security', 'auth-session'] as const,
}

/* ═══════════════════ SSO connections ═══════════════════ */

export type SsoProtocol = 'oidc' | 'saml'

export interface SsoConnectionInput {
  name: string
  protocol: SsoProtocol
  /** Verified email domain the connection maps to. */
  domain: string
  /** OIDC issuer URL or SAML entity ID. */
  entityId: string
  /** OIDC discovery URL / SAML federation-metadata URL (optional). */
  metadataUrl?: string
  /** Operator intent: should this connection be active once applied? */
  enabled: boolean
  /** Force members of the domain through this IdP. */
  enforced: boolean
  /** Just-in-time provisioning on first sign-in. */
  jit: boolean
}

interface SsoConnectionData extends SsoConnectionInput {
  /**
   * True only once a real Keycloak identity-provider sync has confirmed the
   * broker exists. The console never sets this today — configs are honest
   * "saved, apply in Keycloak" records until such a sync ships.
   */
  keycloakSynced?: boolean
}

export interface SsoConnection extends SsoConnectionData {
  id: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

function toSso(doc: StoredDoc<SsoConnectionData>): SsoConnection {
  return {
    id: doc.id,
    ...doc.data,
    keycloakSynced: doc.data.keycloakSynced ?? false,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export function useSsoConnections() {
  return useQuery({
    queryKey: KEY.sso,
    queryFn: async () => (await docStore.list<SsoConnectionData>(SSO_KIND)).map(toSso),
  })
}

export function useSaveSsoConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id?: string; input: SsoConnectionInput }) => {
      if (v.id) {
        const existing = await docStore.get<SsoConnectionData>(SSO_KIND, v.id)
        if (!existing) throw new Error(`SSO connection ${v.id} not found`)
        // Any config edit invalidates a previous Keycloak sync claim.
        const doc = await docStore.put<SsoConnectionData>(SSO_KIND, v.id, {
          ...existing.data,
          ...v.input,
          keycloakSynced: false,
        })
        return toSso(doc)
      }
      const doc = await docStore.create<SsoConnectionData>(SSO_KIND, {
        ...v.input,
        keycloakSynced: false,
      })
      return toSso(doc)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.sso }),
  })
}

export function useDeleteSsoConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(SSO_KIND, id),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.sso }),
  })
}

/* ─────────────────── OIDC discovery test (real fetch) ─────────────────── */

export interface ReachabilityResult {
  ok: boolean
  url: string
  /** Human-readable outcome — never fabricated. */
  detail: string
  issuer?: string
}

/**
 * Really fetch an OIDC discovery document from the browser. Success reads
 * the issuer out of the JSON; failures distinguish HTTP errors from
 * network/CORS blocks (which we report as "could not verify", not "down").
 */
export async function testOidcDiscovery(url: string): Promise<ReachabilityResult> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      return { ok: false, url, detail: `Discovery endpoint answered HTTP ${res.status}` }
    }
    try {
      const body = (await res.json()) as { issuer?: string }
      if (body.issuer) {
        return { ok: true, url, issuer: body.issuer, detail: `Discovery OK — issuer ${body.issuer}` }
      }
      return { ok: false, url, detail: 'Reachable, but the response is not an OIDC discovery document' }
    } catch {
      return { ok: false, url, detail: 'Reachable, but the response is not JSON' }
    }
  } catch {
    return await opaqueProbe(url, 'Discovery URL')
  }
}

/**
 * Fallback probe when a plain fetch is blocked: a `no-cors` request that
 * resolves proves *something* answered at the origin, even though the
 * browser hides the status. We report exactly that — no invented "healthy".
 */
async function opaqueProbe(url: string, label: string): Promise<ReachabilityResult> {
  try {
    await fetch(url, { mode: 'no-cors' })
    return {
      ok: true,
      url,
      detail: `${label} responded, but CORS prevents this browser from reading the status`,
    }
  } catch {
    return { ok: false, url, detail: `${label} is unreachable from this browser` }
  }
}

/* ═══════════════════ Security policy (singleton) ═══════════════════ */

export type MfaMethod = 'totp' | 'webauthn' | 'recovery-code'

export interface SecurityPolicyDoc {
  password: {
    minLength: number
    rotationDays: number
    history: number
  }
  session: {
    idleMinutes: number
    absoluteHours: number
    stepUpForRisky: boolean
    stepUpForBilling: boolean
    singleConcurrent: boolean
  }
  mfa: {
    required: boolean
    minimumFactor: 'totp' | 'webauthn'
    allowedMethods: MfaMethod[]
    rememberDeviceDays: number
  }
  supplyChain: {
    signedDeploysOnly: boolean
    imageScanSeverity: 'off' | 'critical' | 'high' | 'medium' | 'low'
  }
  encryption: {
    cmkEnabled: boolean
    cmkProvider: 'aws-kms' | 'gcp-kms' | 'azure-kv' | 'vault'
  }
  governance: {
    auditRetentionDays: number
    dataExportApprovalRequired: boolean
  }
}

/** Starting values shown before the tenant has ever saved a policy. */
export const DEFAULT_SECURITY_POLICY: SecurityPolicyDoc = {
  password: { minLength: 14, rotationDays: 90, history: 6 },
  session: {
    idleMinutes: 30,
    absoluteHours: 12,
    stepUpForRisky: true,
    stepUpForBilling: true,
    singleConcurrent: false,
  },
  mfa: {
    required: false,
    minimumFactor: 'totp',
    allowedMethods: ['totp', 'webauthn'],
    rememberDeviceDays: 7,
  },
  supplyChain: { signedDeploysOnly: false, imageScanSeverity: 'high' },
  encryption: { cmkEnabled: false, cmkProvider: 'aws-kms' },
  governance: { auditRetentionDays: 365, dataExportApprovalRequired: true },
}

export interface SecurityPolicyState {
  policy: SecurityPolicyDoc
  /** False until the tenant has saved at least once — defaults are labeled. */
  saved: boolean
  updatedAt?: string
  updatedBy?: string | null
}

function mergePolicy(data: Partial<SecurityPolicyDoc> | undefined): SecurityPolicyDoc {
  const d = DEFAULT_SECURITY_POLICY
  return {
    password: { ...d.password, ...data?.password },
    session: { ...d.session, ...data?.session },
    mfa: { ...d.mfa, ...data?.mfa },
    supplyChain: { ...d.supplyChain, ...data?.supplyChain },
    encryption: { ...d.encryption, ...data?.encryption },
    governance: { ...d.governance, ...data?.governance },
  }
}

export function useSecurityPolicy() {
  return useQuery<SecurityPolicyState>({
    queryKey: KEY.policy,
    queryFn: async () => {
      const doc = await docStore.get<Partial<SecurityPolicyDoc>>(POLICY_KIND, SINGLETON_ID)
      return {
        policy: mergePolicy(doc?.data),
        saved: Boolean(doc),
        updatedAt: doc?.updatedAt,
        updatedBy: doc?.updatedBy,
      }
    },
  })
}

/**
 * Section-wise save: merges the patch over the stored doc so the MFA/session
 * view and the security-policies view never clobber each other's sections.
 */
export function useSaveSecurityPolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<SecurityPolicyDoc>) => {
      const existing = await docStore.get<Partial<SecurityPolicyDoc>>(POLICY_KIND, SINGLETON_ID)
      const next = mergePolicy({ ...existing?.data, ...patch })
      return docStore.put<SecurityPolicyDoc>(POLICY_KIND, SINGLETON_ID, next)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.policy }),
  })
}

/* ═══════════════════ IP allowlist ═══════════════════ */

export type IpScope = 'console' | 'api' | 'both'

export interface IpAllowInput {
  cidr: string
  label: string
  scope: IpScope
}

export interface IpAllowEntry extends IpAllowInput {
  id: string
  addedBy: string | null
  addedAt: string
}

function toIpEntry(doc: StoredDoc<IpAllowInput>): IpAllowEntry {
  return { id: doc.id, ...doc.data, addedBy: doc.createdBy, addedAt: doc.createdAt }
}

/**
 * Strict IPv4 CIDR (`a.b.c.d/0-32`, bare address treated as /32) plus a
 * pragmatic IPv6 form (`hex groups with optional ::`, prefix 0-128).
 */
export function isValidCidr(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  const [addr, prefix, extra] = v.split('/')
  if (extra !== undefined) return false

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (v4) {
    if (v4.slice(1).some((o) => Number(o) > 255 || (o.length > 1 && o.startsWith('0')))) return false
    if (prefix === undefined) return true
    return /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32
  }

  // IPv6 — allow at most one '::', hex groups of 1-4 chars.
  if (addr.includes(':')) {
    if ((addr.match(/::/g) ?? []).length > 1) return false
    const groups = addr.split(/:{1,2}/).filter(Boolean)
    if (groups.length > 8) return false
    if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false
    if (!addr.includes('::') && groups.length !== 8) return false
    if (prefix === undefined) return true
    return /^\d{1,3}$/.test(prefix) && Number(prefix) <= 128
  }

  return false
}

export function useIpAllowlist() {
  return useQuery({
    queryKey: KEY.ip,
    queryFn: async () => (await docStore.list<IpAllowInput>(IP_KIND)).map(toIpEntry),
  })
}

export function useSaveIpEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id?: string; input: IpAllowInput }) => {
      if (!isValidCidr(v.input.cidr)) throw new Error(`"${v.input.cidr}" is not a valid CIDR`)
      const data: IpAllowInput = {
        cidr: v.input.cidr.trim(),
        label: v.input.label.trim(),
        scope: v.input.scope,
      }
      const doc = v.id
        ? await docStore.put<IpAllowInput>(IP_KIND, v.id, data)
        : await docStore.create<IpAllowInput>(IP_KIND, data)
      return toIpEntry(doc)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.ip }),
  })
}

export function useDeleteIpEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(IP_KIND, id),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.ip }),
  })
}

/* ═══════════════════ Compliance (singleton) ═══════════════════ */

export type CompliancePosture = 'not-started' | 'in-progress' | 'certified'

export interface EvidenceItem {
  id: string
  label: string
  done: boolean
}

export interface ComplianceFrameworkConfig {
  id: string
  name: string
  /** Self-attested posture recorded by the tenant — labeled as such in the UI. */
  posture: CompliancePosture
  certifiedAt?: string
  nextAuditAt?: string
  /** Link to the externally hosted audit report, if any. */
  reportUrl?: string
  evidence: EvidenceItem[]
}

export interface ComplianceDoc {
  frameworks: ComplianceFrameworkConfig[]
}

export interface ComplianceState {
  doc: ComplianceDoc
  saved: boolean
  updatedAt?: string
}

/** Starter checklists — tracking scaffolding, never pre-checked. */
export const FRAMEWORK_PRESETS: { id: string; name: string; evidence: string[] }[] = [
  {
    id: 'soc2',
    name: 'SOC 2 Type II',
    evidence: [
      'Access reviews completed this quarter',
      'Audit log retention ≥ 1 year confirmed',
      'Incident response runbook published',
      'Vendor risk register up to date',
    ],
  },
  {
    id: 'iso-27001',
    name: 'ISO 27001:2022',
    evidence: [
      'Statement of Applicability current',
      'Risk assessment reviewed',
      'Internal audit performed',
      'Management review recorded',
    ],
  },
  {
    id: 'gdpr',
    name: 'GDPR',
    evidence: [
      'Records of processing activities current',
      'DPA signed with all processors',
      'Data-subject request workflow tested',
    ],
  },
  {
    id: 'hipaa',
    name: 'HIPAA',
    evidence: [
      'BAAs executed with covered partners',
      'PHI data-flow inventory current',
      'Security risk analysis completed',
    ],
  },
  {
    id: 'pci-dss',
    name: 'PCI DSS 4.0',
    evidence: [
      'Cardholder-data environment scoped',
      'Quarterly ASV scan passed',
      'Key-rotation procedure documented',
    ],
  },
]

export function presetToFramework(preset: (typeof FRAMEWORK_PRESETS)[number]): ComplianceFrameworkConfig {
  return {
    id: preset.id,
    name: preset.name,
    posture: 'not-started',
    evidence: preset.evidence.map((label, i) => ({ id: `${preset.id}-${i}`, label, done: false })),
  }
}

export function useComplianceDoc() {
  return useQuery<ComplianceState>({
    queryKey: KEY.compliance,
    queryFn: async () => {
      const doc = await docStore.get<ComplianceDoc>(COMPLIANCE_KIND, SINGLETON_ID)
      return {
        doc: { frameworks: doc?.data.frameworks ?? [] },
        saved: Boolean(doc),
        updatedAt: doc?.updatedAt,
      }
    },
  })
}

export function useSaveCompliance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (next: ComplianceDoc) =>
      docStore.put<ComplianceDoc>(COMPLIANCE_KIND, SINGLETON_ID, next),
    // Optimistic: checklist toggles feel instant; rolled back on error.
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: KEY.compliance })
      const prev = qc.getQueryData<ComplianceState>(KEY.compliance)
      qc.setQueryData<ComplianceState>(KEY.compliance, {
        doc: next,
        saved: true,
        updatedAt: new Date().toISOString(),
      })
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(KEY.compliance, ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.compliance }),
  })
}

/* ═══════════════════ Integrations ═══════════════════ */

export type IntegrationType = 'slack' | 'pagerduty' | 'github' | 'datadog' | 'jira' | 'custom'

export const INTEGRATION_TYPES: { value: IntegrationType; label: string }[] = [
  { value: 'slack', label: 'Slack' },
  { value: 'pagerduty', label: 'PagerDuty' },
  { value: 'github', label: 'GitHub' },
  { value: 'datadog', label: 'Datadog' },
  { value: 'jira', label: 'Jira' },
  { value: 'custom', label: 'Custom (HTTP)' },
]

export interface IntegrationInput {
  type: IntegrationType
  name: string
  enabled: boolean
  /** Base / health URL used by the connectivity test. */
  baseUrl?: string
  /** New API token — masked before persisting; omit on edit to keep. */
  token?: string
  notes?: string
}

interface IntegrationData {
  type: IntegrationType
  name: string
  enabled: boolean
  baseUrl?: string
  /** Only the masked form is ever stored (`••••<last4>`). */
  tokenMasked?: string
  notes?: string
  lastTestAt?: string
  lastTestOk?: boolean
  lastTestDetail?: string
}

export interface Integration extends IntegrationData {
  id: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** Reduce a secret to a display-safe fingerprint before persistence. */
export function maskToken(token: string): string {
  const t = token.trim()
  if (!t) return ''
  return t.length <= 4 ? '••••' : `••••${t.slice(-4)}`
}

function toIntegration(doc: StoredDoc<IntegrationData>): Integration {
  return {
    id: doc.id,
    ...doc.data,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export function useIntegrations() {
  return useQuery({
    queryKey: KEY.integrations,
    queryFn: async () => (await docStore.list<IntegrationData>(INTEGRATION_KIND)).map(toIntegration),
  })
}

export function useSaveIntegration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id?: string; input: IntegrationInput }) => {
      const { token, ...rest } = v.input
      if (v.id) {
        const existing = await docStore.get<IntegrationData>(INTEGRATION_KIND, v.id)
        if (!existing) throw new Error(`Integration ${v.id} not found`)
        const doc = await docStore.put<IntegrationData>(INTEGRATION_KIND, v.id, {
          ...existing.data,
          ...rest,
          tokenMasked: token ? maskToken(token) : existing.data.tokenMasked,
        })
        return toIntegration(doc)
      }
      const doc = await docStore.create<IntegrationData>(INTEGRATION_KIND, {
        ...rest,
        tokenMasked: token ? maskToken(token) : undefined,
      })
      return toIntegration(doc)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.integrations }),
  })
}

export function useDeleteIntegration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(INTEGRATION_KIND, id),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.integrations }),
  })
}

/**
 * Real connectivity test: fetch the integration's URL from the browser and
 * record the observed outcome on the document (so "last test" survives
 * reloads and is shared across the tenant).
 */
export function useTestIntegration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (integration: Integration): Promise<ReachabilityResult> => {
      if (!integration.baseUrl) {
        throw new Error('No URL configured for this integration')
      }
      let result: ReachabilityResult
      try {
        const res = await fetch(integration.baseUrl, { headers: { accept: '*/*' } })
        result = {
          ok: res.ok,
          url: integration.baseUrl,
          detail: `Endpoint answered HTTP ${res.status}`,
        }
      } catch {
        result = await opaqueProbe(integration.baseUrl, 'Endpoint')
      }

      const existing = await docStore.get<IntegrationData>(INTEGRATION_KIND, integration.id)
      if (existing) {
        await docStore.put<IntegrationData>(INTEGRATION_KIND, integration.id, {
          ...existing.data,
          lastTestAt: new Date().toISOString(),
          lastTestOk: result.ok,
          lastTestDetail: result.detail,
        })
      }
      return result
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.integrations }),
  })
}

/* ═══════════════════ Workspace theme (singleton) ═══════════════════ */

export interface ThemeDoc {
  themeId: string
}

export interface WorkspaceThemeState {
  themeId: string | null
  updatedAt?: string
  updatedBy?: string | null
}

export function useWorkspaceTheme() {
  return useQuery<WorkspaceThemeState>({
    queryKey: KEY.theme,
    queryFn: async () => {
      const doc = await docStore.get<ThemeDoc>(THEME_KIND, SINGLETON_ID)
      return {
        themeId: doc?.data.themeId ?? null,
        updatedAt: doc?.updatedAt,
        updatedBy: doc?.updatedBy,
      }
    },
  })
}

export function useSaveWorkspaceTheme() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (themeId: string) => docStore.put<ThemeDoc>(THEME_KIND, SINGLETON_ID, { themeId }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.theme }),
  })
}

/* ═══════════════════ Current auth session (read-only, real) ═══════════════════ */

export interface CurrentSessionInfo {
  /** False when the console runs without the auth server (pure SPA dev). */
  available: boolean
  authenticated: boolean
  /** True when the server reports Keycloak is configured. */
  configured: boolean
  email?: string
  name?: string
  activeTenant?: string
  /** Epoch millis when the server-side session expires. */
  expiresAt?: number
}

/**
 * The only session the browser can truthfully report on is its own —
 * fetched live from `/api/auth/session`. Enumerating *other* sessions is a
 * Keycloak admin capability the console does not proxy yet, and the UI
 * says exactly that instead of inventing a device list.
 */
export function useCurrentSession() {
  return useQuery<CurrentSessionInfo>({
    queryKey: KEY.session,
    queryFn: async () => {
      try {
        const res = await fetch('/api/auth/session', {
          credentials: 'include',
          headers: { accept: 'application/json' },
        })
        const ct = res.headers.get('content-type') ?? ''
        if (!res.ok || !ct.includes('application/json')) {
          return { available: false, authenticated: false, configured: false }
        }
        const body = (await res.json()) as {
          authenticated?: boolean
          configured?: boolean
          session?: {
            user?: { email?: string; name?: string }
            expiresAt?: number
            activeTenant?: string
          }
        }
        return {
          available: true,
          authenticated: Boolean(body.authenticated),
          configured: Boolean(body.configured),
          email: body.session?.user?.email,
          name: body.session?.user?.name,
          activeTenant: body.session?.activeTenant,
          expiresAt: body.session?.expiresAt,
        }
      } catch {
        return { available: false, authenticated: false, configured: false }
      }
    },
    staleTime: 60_000,
  })
}
