import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore } from '@adhar-console/shell-ui'

/**
 * WORKSPACE-CONFIGURATION data layer — real, tenant-scoped persistence for
 * the org-wide preference surfaces: branding & locale, resource defaults,
 * notification routing, and feature previews.
 *
 * Every document lives in the console's Postgres document store
 * (`docStore` → `/api/store/<kind>`), exactly like the security vertical in
 * `security.ts`. There is NO stub fallback: a missing database surfaces as a
 * `DocStoreError` (503) that the views render as a "connect a database"
 * state — never fake data.
 *
 * Kinds (all singletons, id 'current'):
 *   workspace.general              — branding, contact, timezone/locale
 *   workspace.defaults             — what new resources inherit
 *   workspace.notification-routing — per-category event → channel routes
 *   workspace.feature-flags        — org-level opt-ins for preview features
 *
 * Honesty rules baked in:
 *   - Defaults are shown before a tenant ever saves, and labeled as such.
 *   - The notification "test" is a real browser fetch of the webhook URL;
 *     when CORS hides the status we say exactly that.
 *   - Feature toggles record the org's opt-in; modules read the flag —
 *     nothing here pretends a capability shipped that didn't.
 */

/* ─────────────────── kinds / keys ─────────────────── */

const GENERAL_KIND = 'workspace.general'
const DEFAULTS_KIND = 'workspace.defaults'
const ROUTING_KIND = 'workspace.notification-routing'
const FLAGS_KIND = 'workspace.feature-flags'

/** Singleton document id shared by all four kinds. */
const SINGLETON_ID = 'current'

const KEY = {
  general: ['ws-prefs', 'general'] as const,
  defaults: ['ws-prefs', 'defaults'] as const,
  routing: ['ws-prefs', 'notification-routing'] as const,
  flags: ['ws-prefs', 'feature-flags'] as const,
}

/** Shared shape for singleton reads: merged doc + saved/updated metadata. */
export interface SingletonState<T> {
  doc: T
  /** False until the tenant has saved at least once — defaults are labeled. */
  saved: boolean
  updatedAt?: string
  updatedBy?: string | null
}

/* ═══════════════════ General: branding, contact, locale ═══════════════════ */

export interface GeneralSettingsDoc {
  branding: {
    /** Externally hosted logo/avatar URL — previewed live, never proxied. */
    logoUrl: string
    /** Hex accent used for the org avatar in invites and emails. */
    brandColor: string
  }
  contact: {
    supportEmail: string
    homepageUrl: string
  }
  locale: {
    /** IANA timezone id used for org-level schedules and reports. */
    timezone: string
    /** BCP-47 locale for dates/numbers in exports and emails. */
    locale: string
  }
}

export const DEFAULT_GENERAL: GeneralSettingsDoc = {
  branding: { logoUrl: '', brandColor: '#7c3aed' },
  contact: { supportEmail: '', homepageUrl: '' },
  locale: { timezone: 'UTC', locale: 'en-US' },
}

/**
 * IANA timezones straight from the browser's ICU data — a real list, not a
 * hand-typed one. Older engines without `supportedValuesOf` get a small
 * usable fallback.
 */
export const TIMEZONES: string[] = (() => {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    const values = intl.supportedValuesOf?.('timeZone')
    if (values && values.length) return values
  } catch {
    /* fall through */
  }
  return [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Berlin',
    'Asia/Kolkata',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
  ]
})()

export const LOCALES: { value: string; label: string }[] = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'es-ES', label: 'Español' },
  { value: 'pt-BR', label: 'Português (BR)' },
  { value: 'hi-IN', label: 'हिन्दी' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'zh-CN', label: '中文（简体）' },
]

function mergeGeneral(data: Partial<GeneralSettingsDoc> | undefined): GeneralSettingsDoc {
  const d = DEFAULT_GENERAL
  return {
    branding: { ...d.branding, ...data?.branding },
    contact: { ...d.contact, ...data?.contact },
    locale: { ...d.locale, ...data?.locale },
  }
}

export function useGeneralSettings() {
  return useQuery<SingletonState<GeneralSettingsDoc>>({
    queryKey: KEY.general,
    queryFn: async () => {
      const doc = await docStore.get<Partial<GeneralSettingsDoc>>(GENERAL_KIND, SINGLETON_ID)
      return {
        doc: mergeGeneral(doc?.data),
        saved: Boolean(doc),
        updatedAt: doc?.updatedAt,
        updatedBy: doc?.updatedBy,
      }
    },
  })
}

/** Section-wise save: merges the patch over the stored doc. */
export function useSaveGeneralSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<GeneralSettingsDoc>) => {
      const existing = await docStore.get<Partial<GeneralSettingsDoc>>(GENERAL_KIND, SINGLETON_ID)
      const next = mergeGeneral({ ...existing?.data, ...patch })
      return docStore.put<GeneralSettingsDoc>(GENERAL_KIND, SINGLETON_ID, next)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.general }),
  })
}

/* ═══════════════════ Resource defaults ═══════════════════ */

export type DefaultCloud = 'aws' | 'gcp' | 'azure' | 'civo' | 'digitalocean' | 'on-prem'

export const DEFAULT_CLOUDS: { value: DefaultCloud; label: string }[] = [
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'Google Cloud' },
  { value: 'azure', label: 'Azure' },
  { value: 'civo', label: 'Civo' },
  { value: 'digitalocean', label: 'DigitalOcean' },
  { value: 'on-prem', label: 'On-prem' },
]

export interface DefaultLabel {
  key: string
  value: string
}

export interface DefaultsDoc {
  /** Prepended to generated namespaces: `<prefix><project-slug>`. */
  namespacePrefix: string
  /** Environment new projects start in. */
  defaultEnvironment: string
  defaultCloud: DefaultCloud
  /** Provider region id, e.g. us-east-1 / europe-west4. */
  defaultRegion: string
  resources: {
    cpuRequest: string
    cpuLimit: string
    memoryRequest: string
    memoryLimit: string
  }
  /** Labels stamped on every resource the platform creates. */
  labels: DefaultLabel[]
}

export const DEFAULT_DEFAULTS: DefaultsDoc = {
  namespacePrefix: 'app-',
  defaultEnvironment: 'dev',
  defaultCloud: 'aws',
  defaultRegion: '',
  resources: {
    cpuRequest: '100m',
    cpuLimit: '500m',
    memoryRequest: '128Mi',
    memoryLimit: '512Mi',
  },
  labels: [],
}

/** Kubernetes resource quantity — `250m`, `1`, `1.5`, `512Mi`, `2Gi`, … */
export function isValidQuantity(value: string): boolean {
  return /^\d+(\.\d+)?(m|k|Ki|Mi|Gi|Ti|M|G|T)?$/.test(value.trim())
}

/** Kubernetes label key (optional `prefix/` + name, alphanumeric ends). */
export function isValidLabelKey(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 253) return false
  const parts = v.split('/')
  if (parts.length > 2) return false
  const name = parts[parts.length - 1]
  if (name.length > 63) return false
  return /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(name)
}

/** Namespace prefix — DNS-label charset so `<prefix><slug>` stays valid. */
export function isValidNamespacePrefix(value: string): boolean {
  return value === '' || /^[a-z0-9]([a-z0-9-]*)?$/.test(value)
}

function mergeDefaults(data: Partial<DefaultsDoc> | undefined): DefaultsDoc {
  const d = DEFAULT_DEFAULTS
  return {
    namespacePrefix: data?.namespacePrefix ?? d.namespacePrefix,
    defaultEnvironment: data?.defaultEnvironment ?? d.defaultEnvironment,
    defaultCloud: data?.defaultCloud ?? d.defaultCloud,
    defaultRegion: data?.defaultRegion ?? d.defaultRegion,
    resources: { ...d.resources, ...data?.resources },
    labels: (data?.labels ?? d.labels).map((l) => ({ ...l })),
  }
}

export function useWorkspaceDefaults() {
  return useQuery<SingletonState<DefaultsDoc>>({
    queryKey: KEY.defaults,
    queryFn: async () => {
      const doc = await docStore.get<Partial<DefaultsDoc>>(DEFAULTS_KIND, SINGLETON_ID)
      return {
        doc: mergeDefaults(doc?.data),
        saved: Boolean(doc),
        updatedAt: doc?.updatedAt,
        updatedBy: doc?.updatedBy,
      }
    },
  })
}

export function useSaveWorkspaceDefaults() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (next: DefaultsDoc) =>
      docStore.put<DefaultsDoc>(DEFAULTS_KIND, SINGLETON_ID, next),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.defaults }),
  })
}

/* ═══════════════════ Notification routing ═══════════════════ */

export const NOTIFICATION_CATEGORIES = [
  {
    id: 'deploys',
    label: 'Deployments',
    description: 'Promotions, rollbacks, and sync failures from the delivery pipeline.',
  },
  {
    id: 'policy-violations',
    label: 'Policy violations',
    description: 'Kyverno / approval-gate denials and drift from saved policies.',
  },
  {
    id: 'security',
    label: 'Security',
    description: 'New SSO connections, role grants, break-glass sign-ins, allowlist edits.',
  },
  {
    id: 'billing',
    label: 'Billing',
    description: 'Invoices issued, payment failures, plan changes.',
  },
  {
    id: 'cost-alerts',
    label: 'Cost alerts',
    description: 'Budget thresholds crossed and spend anomaly warnings.',
  },
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['id']

export type NotificationChannel = 'in-app' | 'email' | 'webhook'

export const NOTIFICATION_CHANNELS: { value: NotificationChannel; label: string }[] = [
  { value: 'in-app', label: 'In-app' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Slack / webhook URL' },
]

export interface NotificationRoute {
  channel: NotificationChannel
  /** Email address or webhook URL; empty for in-app. */
  target: string
  enabled: boolean
  lastTestAt?: string
  lastTestOk?: boolean
  lastTestDetail?: string
}

export type NotificationRoutes = Record<NotificationCategory, NotificationRoute>

export interface NotificationRoutingDoc {
  routes: NotificationRoutes
}

const DEFAULT_ROUTE: NotificationRoute = { channel: 'in-app', target: '', enabled: true }

export function defaultRoutes(): NotificationRoutes {
  return Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((c) => [c.id, { ...DEFAULT_ROUTE }]),
  ) as NotificationRoutes
}

function mergeRouting(data: Partial<NotificationRoutingDoc> | undefined): NotificationRoutingDoc {
  const base = defaultRoutes()
  for (const c of NOTIFICATION_CATEGORIES) {
    const stored = data?.routes?.[c.id]
    if (stored) base[c.id] = { ...base[c.id], ...stored }
  }
  return { routes: base }
}

export function useNotificationRouting() {
  return useQuery<SingletonState<NotificationRoutingDoc>>({
    queryKey: KEY.routing,
    queryFn: async () => {
      const doc = await docStore.get<Partial<NotificationRoutingDoc>>(ROUTING_KIND, SINGLETON_ID)
      return {
        doc: mergeRouting(doc?.data),
        saved: Boolean(doc),
        updatedAt: doc?.updatedAt,
        updatedBy: doc?.updatedBy,
      }
    },
  })
}

export function useSaveNotificationRouting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (next: NotificationRoutes) => {
      // Preserve recorded test outcomes for routes whose target didn't change.
      const existing = await docStore.get<Partial<NotificationRoutingDoc>>(ROUTING_KIND, SINGLETON_ID)
      const merged = { ...next }
      for (const c of NOTIFICATION_CATEGORIES) {
        const prev = existing?.data.routes?.[c.id]
        if (prev && prev.target === next[c.id].target && prev.channel === next[c.id].channel) {
          merged[c.id] = {
            ...next[c.id],
            lastTestAt: prev.lastTestAt,
            lastTestOk: prev.lastTestOk,
            lastTestDetail: prev.lastTestDetail,
          }
        }
      }
      return docStore.put<NotificationRoutingDoc>(ROUTING_KIND, SINGLETON_ID, { routes: merged })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.routing }),
  })
}

export interface RouteTestResult {
  ok: boolean
  url: string
  /** Human-readable outcome — never fabricated. */
  detail: string
}

/**
 * Really fetch the webhook URL from the browser. A CORS-blocked plain fetch
 * falls back to a `no-cors` probe: resolving proves *something* answered at
 * the origin even though the status is hidden — and we report exactly that.
 */
export async function probeWebhookUrl(url: string): Promise<RouteTestResult> {
  try {
    const res = await fetch(url, { headers: { accept: '*/*' } })
    return { ok: res.ok, url, detail: `Endpoint answered HTTP ${res.status}` }
  } catch {
    try {
      await fetch(url, { mode: 'no-cors' })
      return {
        ok: true,
        url,
        detail: 'Endpoint responded, but CORS prevents this browser from reading the status',
      }
    } catch {
      return { ok: false, url, detail: 'Endpoint is unreachable from this browser' }
    }
  }
}

/**
 * Test a saved webhook route: probe its URL for real and stamp the observed
 * outcome onto the routing document so "last test" survives reloads and is
 * shared across the tenant. Requires the table to be saved first — we never
 * record results against configuration that only exists in a browser tab.
 */
export function useTestNotificationRoute() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (category: NotificationCategory): Promise<RouteTestResult> => {
      const existing = await docStore.get<NotificationRoutingDoc>(ROUTING_KIND, SINGLETON_ID)
      if (!existing) throw new Error('Save the routing table before testing.')
      const route = existing.data.routes?.[category]
      if (!route || route.channel !== 'webhook' || !route.target) {
        throw new Error('This route has no webhook URL to test.')
      }
      const result = await probeWebhookUrl(route.target)
      await docStore.put<NotificationRoutingDoc>(ROUTING_KIND, SINGLETON_ID, {
        routes: {
          ...existing.data.routes,
          [category]: {
            ...route,
            lastTestAt: new Date().toISOString(),
            lastTestOk: result.ok,
            lastTestDetail: result.detail,
          },
        },
      })
      return result
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.routing }),
  })
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim())
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/* ═══════════════════ Feature previews ═══════════════════ */

export type FeatureStage = 'beta' | 'experimental'

export interface FeatureFlagDef {
  id: string
  name: string
  description: string
  stage: FeatureStage
  /** Opt-in state before the tenant records a choice. */
  defaultEnabled: boolean
}

/**
 * The catalog is fixed in code (each id maps to a capability console modules
 * check); only the per-org enabled state is persisted and merged over it.
 */
export const FEATURE_FLAGS: FeatureFlagDef[] = [
  {
    id: 'ai-assistant',
    name: 'AI assistant',
    description: 'Conversational helper in the console shell for queries, runbooks, and drafts.',
    stage: 'beta',
    defaultEnabled: false,
  },
  {
    id: 'multi-cluster',
    name: 'Multi-cluster management',
    description: 'Register and operate more than one Kubernetes cluster from this console.',
    stage: 'beta',
    defaultEnabled: false,
  },
  {
    id: 'self-service-provisioning',
    name: 'Self-service provisioning',
    description: 'Members provision databases, queues, and buckets from the catalog without an admin ticket.',
    stage: 'beta',
    defaultEnabled: false,
  },
  {
    id: 'cost-insights',
    name: 'Cost insights',
    description: 'Per-deployment cost estimates and anomaly hints surfaced across the console.',
    stage: 'beta',
    defaultEnabled: false,
  },
  {
    id: 'preview-environments',
    name: 'Preview environments',
    description: 'Ephemeral per-pull-request environments torn down on merge.',
    stage: 'experimental',
    defaultEnabled: false,
  },
]

export interface FeatureFlagsDoc {
  /** flag id → org opt-in. Only ids present in the catalog are honored. */
  flags: Record<string, boolean>
}

export interface FeatureFlagState extends FeatureFlagDef {
  enabled: boolean
}

export interface FeatureFlagsState {
  flags: FeatureFlagState[]
  saved: boolean
  updatedAt?: string
  updatedBy?: string | null
}

export function useFeatureFlags() {
  return useQuery<FeatureFlagsState>({
    queryKey: KEY.flags,
    queryFn: async () => {
      const doc = await docStore.get<FeatureFlagsDoc>(FLAGS_KIND, SINGLETON_ID)
      const stored = doc?.data.flags ?? {}
      return {
        flags: FEATURE_FLAGS.map((f) => ({ ...f, enabled: stored[f.id] ?? f.defaultEnabled })),
        saved: Boolean(doc),
        updatedAt: doc?.updatedAt,
        updatedBy: doc?.updatedBy,
      }
    },
  })
}

/** Persist a single toggle (merged over the stored map, catalog-validated). */
export function useSaveFeatureFlag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; enabled: boolean }) => {
      if (!FEATURE_FLAGS.some((f) => f.id === v.id)) {
        throw new Error(`Unknown feature flag: ${v.id}`)
      }
      const existing = await docStore.get<FeatureFlagsDoc>(FLAGS_KIND, SINGLETON_ID)
      const flags = { ...(existing?.data.flags ?? {}), [v.id]: v.enabled }
      return docStore.put<FeatureFlagsDoc>(FLAGS_KIND, SINGLETON_ID, { flags })
    },
    // Optimistic: a toggle should feel instant; rolled back on error.
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEY.flags })
      const prev = qc.getQueryData<FeatureFlagsState>(KEY.flags)
      if (prev) {
        qc.setQueryData<FeatureFlagsState>(KEY.flags, {
          ...prev,
          saved: true,
          flags: prev.flags.map((f) => (f.id === v.id ? { ...f, enabled: v.enabled } : f)),
        })
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(KEY.flags, ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY.flags }),
  })
}
