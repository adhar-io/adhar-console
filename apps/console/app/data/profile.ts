import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { applyTheme, DEFAULT_APP_LINKS, DEFAULT_THEME_ID, THEMES } from '@adhar-console/shell-ui'
import type { Session } from '@adhar-console/auth'

/**
 * Profile settings data layer — the client hooks behind /profile.
 *
 * Three real backends, no fabricated data anywhere:
 *
 *   1. `/api/prefs/profile` — the per-user preferences document (cookie-authed,
 *      Postgres-backed). Holds the editable identity fields (display name,
 *      title, bio, timezone, locale), appearance (theme preset, density,
 *      reduced motion) and the notification matrix. In the dev SPA (no server)
 *      the same document round-trips through localStorage, exactly like
 *      `overview-prefs.ts`. When the server has no DB the PUT reports
 *      `persisted: false` and the UI surfaces a "connect a database" note.
 *
 *   2. `/api/workspace/tokens` — personal access tokens. Same flow as the
 *      workspace module's client: create → show-once secret, list with
 *      prefix + last4 + lastUsed, revoke. A 503 means "no database" and is
 *      rendered as a connect-DB state — never stubbed rows.
 *
 *   3. `/api/auth/session` — read-only: the freshest client-safe session
 *      projection (expiry, active org). Identity itself (email, username,
 *      password, MFA) lives in Keycloak and is only linked to, never edited.
 */

/* ═══════════════════════════ prefs types ═══════════════════════════ */

/** A labelled external link (website, GitHub, LinkedIn…). */
export interface ProfileLink {
  label: string
  url: string
}

/** A user-defined key/value detail — the "add your own section" mechanism. */
export interface ProfileCustomField {
  label: string
  value: string
}

export interface ProfileIdentityPrefs {
  displayName: string
  title: string
  bio: string
  timezone: string
  locale: string
  /** Uploaded avatar as a `data:image/...` URL. Empty ⇒ generated initials. */
  avatarDataUrl: string
  pronouns: string
  phone: string
  location: string
  company: string
  department: string
  /** Labelled external links, add/remove in the UI. */
  links: ProfileLink[]
  /** User-defined key/value fields — fully custom sections. */
  customFields: ProfileCustomField[]
}

/** Max stored avatar payload (~90 KB of base64 ≈ a 256px JPEG). */
export const AVATAR_MAX_BYTES = 90_000
export const MAX_PROFILE_LINKS = 12
export const MAX_CUSTOM_FIELDS = 24

export type Density = 'comfortable' | 'compact'

export interface AppearancePrefs {
  themeId: string
  density: Density
  reducedMotion: boolean
}

export const NOTIFICATION_CATEGORIES = [
  'deploys',
  'policy',
  'security',
  'mentions',
  'billing',
] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export const NOTIFICATION_CHANNELS = ['inApp', 'email'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type NotificationMatrix = Record<
  NotificationCategory,
  Record<NotificationChannel, boolean>
>

export interface ProfilePrefs {
  identity: ProfileIdentityPrefs
  appearance: AppearancePrefs
  notifications: NotificationMatrix
  /** ISO timestamp; bumped on every persist. */
  updatedAt?: string
}

export const DEFAULT_NOTIFICATIONS: NotificationMatrix = {
  deploys: { inApp: true, email: false },
  policy: { inApp: true, email: false },
  security: { inApp: true, email: true },
  mentions: { inApp: true, email: false },
  billing: { inApp: true, email: true },
}

export const EMPTY_IDENTITY: ProfileIdentityPrefs = {
  displayName: '',
  title: '',
  bio: '',
  timezone: '',
  locale: '',
  avatarDataUrl: '',
  pronouns: '',
  phone: '',
  location: '',
  company: '',
  department: '',
  links: [],
  customFields: [],
}

export const DEFAULT_PREFS: ProfilePrefs = {
  identity: EMPTY_IDENTITY,
  appearance: { themeId: DEFAULT_THEME_ID, density: 'comfortable', reducedMotion: false },
  notifications: DEFAULT_NOTIFICATIONS,
}

const VALID_THEME_IDS = new Set(THEMES.map((t) => t.id))

function sanitize(input: unknown): ProfilePrefs {
  const raw = (input ?? {}) as Partial<ProfilePrefs>
  const id = (raw.identity ?? {}) as Partial<ProfileIdentityPrefs>
  const ap = (raw.appearance ?? {}) as Partial<AppearancePrefs>
  const nm = (raw.notifications ?? {}) as Partial<NotificationMatrix>
  const str = (v: unknown, max = 512) => (typeof v === 'string' ? v.slice(0, max) : '')
  const notifications = {} as NotificationMatrix
  for (const cat of NOTIFICATION_CATEGORIES) {
    const row = nm[cat]
    notifications[cat] = {
      inApp: typeof row?.inApp === 'boolean' ? row.inApp : DEFAULT_NOTIFICATIONS[cat].inApp,
      email: typeof row?.email === 'boolean' ? row.email : DEFAULT_NOTIFICATIONS[cat].email,
    }
  }
  // Keep only a bounded `data:image/...` avatar; reject anything else (URLs,
  // scripts, oversized payloads) so the prefs document stays safe + small.
  const avatar = (() => {
    const v = id.avatarDataUrl
    if (typeof v !== 'string' || !v.startsWith('data:image/')) return ''
    return v.length <= AVATAR_MAX_BYTES ? v : ''
  })()
  const links = Array.isArray(id.links)
    ? id.links
        .slice(0, MAX_PROFILE_LINKS)
        .map((l) => ({ label: str((l as ProfileLink)?.label, 60), url: str((l as ProfileLink)?.url, 300) }))
        .filter((l) => l.label !== '' || l.url !== '')
    : []
  const customFields = Array.isArray(id.customFields)
    ? id.customFields
        .slice(0, MAX_CUSTOM_FIELDS)
        .map((f) => ({ label: str((f as ProfileCustomField)?.label, 60), value: str((f as ProfileCustomField)?.value, 500) }))
        .filter((f) => f.label !== '' || f.value !== '')
    : []
  return {
    identity: {
      displayName: str(id.displayName, 120),
      title: str(id.title, 120),
      bio: str(id.bio, 2000),
      timezone: str(id.timezone, 80),
      locale: str(id.locale, 32),
      avatarDataUrl: avatar,
      pronouns: str(id.pronouns, 40),
      phone: str(id.phone, 40),
      location: str(id.location, 120),
      company: str(id.company, 120),
      department: str(id.department, 120),
      links,
      customFields,
    },
    appearance: {
      themeId: VALID_THEME_IDS.has(ap.themeId ?? '') ? (ap.themeId as string) : DEFAULT_THEME_ID,
      density: ap.density === 'compact' ? 'compact' : 'comfortable',
      reducedMotion: ap.reducedMotion === true,
    },
    notifications,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  }
}

/* ═══════════════════════ avatar image processing ═══════════════════════ */

export class AvatarError extends Error {}

/**
 * Read an image File, downscale it to a square `size`px thumbnail on a canvas,
 * and return a compressed `data:image/...` URL small enough to live in the
 * prefs document. Compresses progressively until it fits `AVATAR_MAX_BYTES`.
 * Runs entirely client-side — no upload endpoint required.
 */
export async function fileToAvatarDataUrl(file: File, size = 256): Promise<string> {
  if (!file.type.startsWith('image/')) throw new AvatarError('Please choose an image file.')
  if (file.size > 12_000_000) throw new AvatarError('Image is too large (max 12 MB).')
  const bitmap = await loadBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new AvatarError('Could not process the image in this browser.')
  // Cover-crop to a centered square, then draw at target size.
  const src = Math.min(bitmap.width, bitmap.height)
  const sx = (bitmap.width - src) / 2
  const sy = (bitmap.height - src) / 2
  ctx.drawImage(bitmap, sx, sy, src, src, 0, 0, size, size)
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality)
    if (url.length <= AVATAR_MAX_BYTES) return url
  }
  throw new AvatarError('Could not compress the image small enough — try a simpler picture.')
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      /* fall through to <img> decoding (e.g. some SVG/HEIC cases) */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return img
  } catch {
    throw new AvatarError('That image could not be read.')
  } finally {
    URL.revokeObjectURL(url)
  }
}

/* ═══════════════════════ persistence backend ═══════════════════════ */

const PREFS_SCOPE = 'profile'
const STORAGE_KEY = 'adhar.preferences.profile'

/** Vite replaces `import.meta.env.PROD` at build time; guard for safety. */
function isProdBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    return false
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function readStore(): ProfilePrefs | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function writeStore(prefs: ProfilePrefs): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* storage quota — ignore */
  }
}

/** GET /api/prefs/profile (prod) · localStorage (dev SPA). */
async function fetchProfilePrefs(): Promise<ProfilePrefs> {
  if (isProdBuild()) {
    try {
      const res = await fetch(`/api/prefs/${PREFS_SCOPE}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as { data?: unknown }
        return json.data ? sanitize(json.data) : DEFAULT_PREFS
      }
    } catch {
      /* network/offline — fall back to defaults */
    }
    return DEFAULT_PREFS
  }
  await delay(60)
  return readStore() ?? DEFAULT_PREFS
}

export interface SavePrefsResult {
  prefs: ProfilePrefs
  /**
   * False when the server accepted the write but had no database to store it
   * in (`persisted: false` from /api/prefs) — the UI shows a connect-DB note.
   */
  persisted: boolean
}

/** PUT /api/prefs/profile (prod) · localStorage (dev SPA). */
async function persistProfilePrefs(next: ProfilePrefs): Promise<SavePrefsResult> {
  const stamped = sanitize({ ...next, updatedAt: new Date().toISOString() })
  if (isProdBuild()) {
    try {
      const res = await fetch(`/api/prefs/${PREFS_SCOPE}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: stamped }),
      })
      if (res.ok) {
        const json = (await res.json()) as { persisted?: boolean }
        return { prefs: stamped, persisted: json.persisted !== false }
      }
      return { prefs: stamped, persisted: false }
    } catch {
      return { prefs: stamped, persisted: false }
    }
  }
  await delay(100)
  writeStore(stamped)
  return { prefs: stamped, persisted: true }
}

/* ═════════════════════════ prefs hooks ═════════════════════════ */

const PREFS_KEY = ['profile', 'prefs'] as const

export function useProfilePrefs() {
  return useQuery<ProfilePrefs>({
    queryKey: PREFS_KEY,
    queryFn: fetchProfilePrefs,
    staleTime: 60_000,
  })
}

/** Optimistic save of the whole prefs document (callers merge their slice). */
export function useSaveProfilePrefs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: persistProfilePrefs,
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: PREFS_KEY })
      const prev = qc.getQueryData<ProfilePrefs>(PREFS_KEY)
      qc.setQueryData<ProfilePrefs>(PREFS_KEY, sanitize(next))
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(PREFS_KEY, ctx.prev)
    },
    onSuccess: (result) => {
      qc.setQueryData<ProfilePrefs>(PREFS_KEY, result.prefs)
    },
  })
}

/* ═══════════════════ appearance application ═══════════════════ */

/**
 * Density + reduced-motion are applied as data attributes on <html> with a
 * tiny injected stylesheet, so they take effect app-wide immediately. The
 * theme preset goes through shell-ui's `applyTheme` (which also mirrors to
 * localStorage so `bootTheme` restores it on reload). Density/motion keep
 * their own localStorage mirror and are re-applied on module load, so a
 * reload keeps the chosen ergonomics without waiting for prefs to hydrate.
 */
const APPEARANCE_MIRROR_KEY = 'adhar.profile.appearance'
const APPEARANCE_STYLE_ID = 'adhar-profile-appearance'

const APPEARANCE_CSS = `
:root[data-density='compact'] { font-size: 14px; }
:root[data-reduced-motion='true'] *,
:root[data-reduced-motion='true'] *::before,
:root[data-reduced-motion='true'] *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
  scroll-behavior: auto !important;
}
`

function ensureAppearanceCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(APPEARANCE_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = APPEARANCE_STYLE_ID
  style.textContent = APPEARANCE_CSS
  document.head.appendChild(style)
}

function applyDensityAndMotion(density: Density, reducedMotion: boolean): void {
  if (typeof document === 'undefined') return
  ensureAppearanceCss()
  const root = document.documentElement
  root.dataset.density = density
  root.dataset.reducedMotion = reducedMotion ? 'true' : 'false'
  try {
    localStorage.setItem(APPEARANCE_MIRROR_KEY, JSON.stringify({ density, reducedMotion }))
  } catch {
    /* best-effort mirror */
  }
}

/** Apply the full appearance slice (theme preset + density + motion) live. */
export function applyAppearance(a: AppearancePrefs): void {
  if (typeof document === 'undefined') return
  applyTheme(a.themeId)
  applyDensityAndMotion(a.density, a.reducedMotion)
}

/** Restore mirrored density/motion (theme + color mode boot via `bootTheme`). */
export function bootProfileAppearance(): void {
  if (typeof document === 'undefined' || typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(APPEARANCE_MIRROR_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { density?: unknown; reducedMotion?: unknown }
    applyDensityAndMotion(
      parsed.density === 'compact' ? 'compact' : 'comfortable',
      parsed.reducedMotion === true,
    )
  } catch {
    /* corrupt mirror — ignore */
  }
}

// Re-apply on module load so density/motion survive a reload as soon as this
// chunk is evaluated (theme + color mode are restored earlier by bootTheme).
if (typeof document !== 'undefined') bootProfileAppearance()

/* ═══════════════ personal access tokens (/api/workspace/tokens) ═══════════════ */

export class ProfileApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ProfileApiError'
  }
}

/** True when the error means "no database configured" (connect-DB state). */
export function isDbUnavailable(e: unknown): boolean {
  return e instanceof ProfileApiError && e.status === 503
}

/** True when there is no console server at all (pure SPA dev). */
export function isServerUnavailable(e: unknown): boolean {
  return e instanceof ProfileApiError && e.status === 0
}

/** True when the BFF rejected the call for lack of a signed-in cookie session. */
export function isUnauthenticated(e: unknown): boolean {
  return e instanceof ProfileApiError && e.status === 401
}

async function tokensFetch<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {}
  let res: Response
  try {
    res = await fetch(`/api/workspace/${path}`, {
      credentials: 'same-origin',
      ...rest,
      headers: {
        accept: 'application/json',
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    })
  } catch {
    throw new ProfileApiError('The console server is not reachable.', 0)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (res.ok && !ct.includes('application/json')) {
    // Dev SPA: no BFF behind /api — the dev server answered with HTML.
    throw new ProfileApiError(
      'Personal access tokens need the console server (BFF). Run the server build to manage them.',
      0,
    )
  }
  if (!res.ok) {
    if (!ct.includes('application/json')) {
      // No BFF answered at all (e.g. a plain static host in front of the SPA).
      throw new ProfileApiError(
        'Personal access tokens need the console server (BFF). Run the server build to manage them.',
        0,
      )
    }
    let code: string | undefined
    try {
      code = ((await res.json()) as { error?: string }).error
    } catch {
      /* non-JSON error body */
    }
    throw new ProfileApiError(
      res.status === 503
        ? 'The console database is not configured.'
        : res.status === 401
          ? 'Sign in with Keycloak SSO to manage personal access tokens.'
          : `Token request failed (${res.status}${code ? `: ${code}` : ''})`,
      res.status,
      code,
    )
  }
  return (await res.json()) as T
}

export interface PersonalToken {
  id: string
  name: string
  prefix: string
  last4?: string
  scopes: string[]
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  createdBy?: string
}

export const TOKEN_SCOPE_OPTIONS = [
  'projects:read',
  'projects:write',
  'deployments:read',
  'deployments:write',
  'audit:read',
  'members:read',
] as const

const TOKENS_KEY = ['profile', 'tokens'] as const

export function usePersonalTokens() {
  return useQuery({
    queryKey: TOKENS_KEY,
    queryFn: async () => (await tokensFetch<{ items: PersonalToken[] }>('tokens')).items,
    retry: (count, err) =>
      !isDbUnavailable(err) && !isServerUnavailable(err) && !isUnauthenticated(err) && count < 2,
  })
}

export interface MintedToken {
  /** Plaintext secret — shown once; only a SHA-256 hash is stored. */
  token: string
  item: PersonalToken
}

export function useCreatePersonalToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; scopes: string[]; expiresAt?: string }) =>
      tokensFetch<MintedToken>('tokens', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}

export function useRevokePersonalToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => tokensFetch<{ ok: boolean }>(`tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}

/* ═══════════════ current session (read-only, /api/auth/session) ═══════════════ */

export interface AuthSessionInfo {
  authenticated: boolean
  configured: boolean
  session?: Session
}

async function fetchAuthSession(): Promise<AuthSessionInfo | null> {
  try {
    const res = await fetch('/api/auth/session', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    const ct = res.headers.get('content-type') ?? ''
    if (!res.ok || !ct.includes('application/json')) return null
    return (await res.json()) as AuthSessionInfo
  } catch {
    return null
  }
}

/**
 * Freshest client-safe session projection. Returns null when there is no
 * console server (dev SPA) — callers fall back to the in-memory session from
 * `useOptionalSession()` and label it honestly.
 */
export function useAuthSessionInfo() {
  return useQuery({
    queryKey: ['profile', 'auth-session'],
    queryFn: fetchAuthSession,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  })
}

/* ═══════════════ Keycloak account console link (derived) ═══════════════ */

const KEYCLOAK_FALLBACK_URL =
  DEFAULT_APP_LINKS.find((a) => a.id === 'keycloak')?.url ?? ''

async function fetchKeycloakUrl(): Promise<string> {
  try {
    const res = await fetch('/api/config', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    const ct = res.headers.get('content-type') ?? ''
    if (res.ok && ct.includes('application/json')) {
      const json = (await res.json()) as {
        tools?: Record<string, { configured: boolean; url: string }>
      }
      const tools = json.tools ?? {}
      // Keycloak is itself in the tool registry — use its URL when configured.
      if (tools.keycloak?.url) return tools.keycloak.url
      // Otherwise the same derivation as the app launcher: infer the cluster
      // base domain from any configured tool URL and point at keycloak.<base>.
      for (const t of Object.values(tools)) {
        if (!t.url) continue
        try {
          const u = new URL(t.url)
          const base = u.host.split('.').slice(1).join('.')
          if (base) return `${u.protocol}//keycloak.${base}`
        } catch {
          /* skip malformed */
        }
      }
    }
  } catch {
    /* no server — fall through to the static default */
  }
  return KEYCLOAK_FALLBACK_URL
}

/**
 * Best-effort Keycloak base URL for "manage identity in Keycloak" links.
 * The account console lives at `<base>/realms/<realm>/account/`; the console's
 * default realm is `adhar` (see packages/auth/src/config.ts).
 */
export function useKeycloakUrl() {
  return useQuery({
    queryKey: ['profile', 'keycloak-url'],
    queryFn: fetchKeycloakUrl,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function keycloakAccountUrl(base: string | undefined): string | null {
  if (!base) return null
  return `${base.replace(/\/$/, '')}/realms/adhar/account/`
}

/* ═══════════════ timezone / locale option lists (real, from Intl) ═══════════════ */

const FALLBACK_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
]

/** Full IANA list from the runtime when available; a curated fallback otherwise. */
export function listTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?(key: string): string[] }
  try {
    if (typeof intl.supportedValuesOf === 'function') {
      return intl.supportedValuesOf('timeZone')
    }
  } catch {
    /* unsupported key */
  }
  return FALLBACK_TIMEZONES
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  } catch {
    return 'UTC'
  }
}

export const LOCALE_OPTIONS = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'es-ES', label: 'Español' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'zh-CN', label: '中文（简体）' },
] as const
