import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  AppShell,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  ModeToggle,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  THEMES,
} from '@adhar-console/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar-console/utils'
import { STUB_USER, useOptionalSession, type Session, type User } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'
import {
  applyAppearance,
  browserTimezone,
  DEFAULT_PREFS,
  isDbUnavailable,
  isServerUnavailable,
  isUnauthenticated,
  keycloakAccountUrl,
  listTimezones,
  LOCALE_OPTIONS,
  NOTIFICATION_CATEGORIES,
  TOKEN_SCOPE_OPTIONS,
  useAuthSessionInfo,
  useCreatePersonalToken,
  useKeycloakUrl,
  usePersonalTokens,
  useProfilePrefs,
  useRevokePersonalToken,
  useSaveProfilePrefs,
  type AppearancePrefs,
  type Density,
  type MintedToken,
  type NotificationCategory,
  type NotificationMatrix,
  type PersonalToken,
  type ProfileIdentityPrefs,
  type ProfilePrefs,
} from '~/data/profile.ts'

export const Route = createFileRoute('/profile')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Your profile · Adhar Console' }] }),
  component: ProfilePage,
})

type SectionId = 'profile' | 'appearance' | 'notifications' | 'tokens' | 'security'

const SECTION_TABS = [
  { id: 'profile', label: 'Profile', description: 'Identity & details' },
  { id: 'appearance', label: 'Appearance', description: 'Theme, mode, density' },
  { id: 'notifications', label: 'Notifications', description: 'Channels & categories' },
  { id: 'tokens', label: 'Access tokens', description: 'Personal API tokens' },
  { id: 'security', label: 'Security & sessions', description: 'Session, MFA, sign-out' },
] as const satisfies ReadonlyArray<{ id: SectionId; label: string; description: string }>

function ProfilePage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const session = useOptionalSession()
  const user = session?.user ?? STUB_USER
  const [section, setSection] = useState<SectionId>('profile')

  const prefsQ = useProfilePrefs()
  const prefs = prefsQ.data ?? DEFAULT_PREFS

  // Re-apply the persisted appearance whenever the prefs document hydrates or
  // changes, so theme / density / reduced-motion follow the durable record.
  useEffect(() => {
    if (prefsQ.data) applyAppearance(prefsQ.data.appearance)
  }, [prefsQ.data])

  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Profile' }]}
      notifications={notifications}
      contentWidth="full"
    >
      <PageHeader
        title="Your profile"
        description="Personal settings, appearance, access tokens, sessions, and notification preferences."
      />
      <Tabs
        tabs={SECTION_TABS}
        value={section}
        onChange={setSection}
        orientation="vertical"
        ariaLabel="Profile settings"
      >
        {(active) => (
          <>
            {active === 'profile' && (
              <ProfileSection user={user} prefs={prefs} loading={prefsQ.isLoading} />
            )}
            {active === 'appearance' && (
              <AppearanceSection prefs={prefs} loading={prefsQ.isLoading} />
            )}
            {active === 'notifications' && (
              <NotificationsSection prefs={prefs} loading={prefsQ.isLoading} email={user.email} />
            )}
            {active === 'tokens' && <TokensSection />}
            {active === 'security' && (
              <SecuritySection session={session} user={user} activeTenant={activeTenant.name} />
            )}
          </>
        )}
      </Tabs>
    </AppShell>
  )
}

/* ═══════════════════════ shared bits ═══════════════════════ */

/** Amber note shown when the server accepted a prefs write without a DB. */
function NotPersistedNote({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      Saved for this session only — the console server has no database configured. Connect a
      database (set <code className="font-mono">DATABASE_URL</code>) to persist preferences across
      devices and reloads.
    </p>
  )
}

function SectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-content">{title}</h2>
      {description ? <p className="mt-0.5 text-sm text-content-muted">{description}</p> : null}
    </div>
  )
}

function KeycloakLink({ label = 'Open Keycloak account console' }: { label?: string }) {
  const kc = useKeycloakUrl()
  const href = keycloakAccountUrl(kc.data)
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300"
    >
      {label} ↗
    </a>
  )
}

/* ═══════════════════════ 1 · Profile ═══════════════════════ */

function nameHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

function avatarGradient(name: string): string {
  const h = nameHash(name || 'adhar')
  const h1 = h % 360
  const h2 = (h1 + 60 + ((h >> 8) % 120)) % 360
  return `linear-gradient(135deg, oklch(0.62 0.16 ${h1}), oklch(0.45 0.17 ${h2}))`
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function GeneratedAvatar({ name, size = 56 }: { name: string; size?: number }) {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-1 ring-inset ring-white/20"
      style={{
        width: size,
        height: size,
        background: avatarGradient(name),
        fontSize: size / 2.8,
      }}
    >
      {initialsOf(name)}
    </div>
  )
}

function ProfileSection({
  user,
  prefs,
  loading,
}: {
  user: User
  prefs: ProfilePrefs
  loading: boolean
}) {
  const save = useSaveProfilePrefs()
  const [draft, setDraft] = useState<ProfileIdentityPrefs | null>(null)
  const identity = draft ?? prefs.identity
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(prefs.identity)

  const [browserTz, setBrowserTz] = useState('')
  useEffect(() => setBrowserTz(browserTimezone()), [])
  const timezones = useMemo(() => listTimezones(), [])

  const displayName = prefs.identity.displayName || user.name
  const patch = (p: Partial<ProfileIdentityPrefs>) => setDraft({ ...identity, ...p })

  const submit = () => {
    if (draft === null) return
    save.mutate({ ...prefs, identity: draft }, { onSuccess: () => setDraft(null) })
  }

  if (loading) return <SectionSkeleton />

  return (
    <div className="max-w-3xl space-y-6">
      {/* Identity from Keycloak — read-only */}
      <Card as="section">
        <CardHeader className="flex items-center justify-between">
          <SectionTitle title="Identity" />
          <KeycloakLink />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center gap-4">
            <GeneratedAvatar name={displayName} />
            <div className="min-w-0">
              <div className="truncate text-base font-medium text-content">{displayName}</div>
              <div className="truncate text-xs text-content-subtle">{user.email}</div>
              <div className="mt-1 text-[11px] text-content-subtle">
                Avatar is generated from your name — no image upload yet.
              </div>
            </div>
          </div>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-content-subtle">Email</dt>
              <dd className="text-content">{user.email}</dd>
            </div>
            <div>
              <dt className="text-xs text-content-subtle">User ID</dt>
              <dd className="truncate font-mono text-xs text-content-muted">{user.id}</dd>
            </div>
            <div>
              <dt className="text-xs text-content-subtle">Roles</dt>
              <dd className="mt-0.5 flex flex-wrap gap-1">
                {user.roles.map((r) => (
                  <span
                    key={r}
                    className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted"
                  >
                    {r}
                  </span>
                ))}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-content-subtle">Org memberships</dt>
              <dd className="text-content">{user.tenants.join(', ')}</dd>
            </div>
          </dl>
          <p className="text-xs text-content-subtle">
            Email, username, and org membership come from Keycloak SSO and are read-only here —
            change them in the Keycloak account console.
          </p>
        </CardBody>
      </Card>

      {/* Editable details → /api/prefs/profile */}
      <Card as="section">
        <CardHeader>
          <SectionTitle
            title="Details"
            description="Shown across the console. Stored in your per-user preferences."
          />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Display name" hint={`Defaults to “${user.name}”`}>
              <Input
                value={identity.displayName}
                placeholder={user.name}
                maxLength={120}
                onChange={(e) => patch({ displayName: e.target.value })}
              />
            </Field>
            <Field label="Title / role">
              <Input
                value={identity.title}
                placeholder="e.g. Platform engineer"
                maxLength={120}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Bio" hint="A short line about what you work on">
            <Textarea
              value={identity.bio}
              rows={3}
              maxLength={2000}
              placeholder="What do you build, own, or operate?"
              onChange={(e) => patch({ bio: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Timezone" hint={browserTz ? `Browser: ${browserTz}` : undefined}>
              <Select
                value={identity.timezone}
                onChange={(e) => patch({ timezone: e.target.value })}
              >
                <option value="">Not set (use browser)</option>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Locale">
              <Select value={identity.locale} onChange={(e) => patch({ locale: e.target.value })}>
                <option value="">Not set (use browser)</option>
                {LOCALE_OPTIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <NotPersistedNote show={save.data?.persisted === false} />
          <div className="flex items-center gap-3">
            <Button variant="primary" size="sm" disabled={!dirty} loading={save.isPending} onClick={submit}>
              Save changes
            </Button>
            {dirty ? (
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Discard
              </Button>
            ) : null}
            {!dirty && save.isSuccess ? (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">Saved</span>
            ) : null}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function SectionSkeleton() {
  return (
    <div className="max-w-3xl space-y-4">
      <Skeleton height={120} className="w-full" rounded="lg" />
      <Skeleton height={280} className="w-full" rounded="lg" />
    </div>
  )
}

/* ═══════════════════════ 2 · Appearance ═══════════════════════ */

function AppearanceSection({ prefs, loading }: { prefs: ProfilePrefs; loading: boolean }) {
  const save = useSaveProfilePrefs()
  const appearance = prefs.appearance

  const set = (p: Partial<AppearancePrefs>) => {
    const next: AppearancePrefs = { ...appearance, ...p }
    applyAppearance(next)
    save.mutate({ ...prefs, appearance: next })
  }

  if (loading) return <SectionSkeleton />

  return (
    <div className="max-w-3xl space-y-6">
      <Card as="section">
        <CardHeader>
          <SectionTitle
            title="Color mode"
            description="Light, dark, or follow the OS. Stored per browser and applied instantly."
          />
        </CardHeader>
        <CardBody>
          <ModeToggle variant="segmented" />
        </CardBody>
      </Card>

      <Card as="section">
        <CardHeader>
          <SectionTitle
            title="Theme preset"
            description="Brand and accent ramps for the whole console. Applied live and saved to your preferences."
          />
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {THEMES.map((t) => {
              const active = t.id === appearance.themeId
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => set({ themeId: t.id })}
                  className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                    active
                      ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500/40 dark:bg-brand-500/10'
                      : 'border-edge-default bg-surface-raised hover:border-edge-strong hover:bg-surface-sunken'
                  }`}
                >
                  <span className="mt-0.5 flex shrink-0 -space-x-1">
                    {t.swatches.map((c, i) => (
                      <span
                        key={i}
                        className="h-5 w-5 rounded-full ring-2 ring-surface-raised"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium text-content">
                      {t.name}
                      {active ? (
                        <span className="text-[11px] font-normal text-brand-700 dark:text-brand-300">
                          active
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-content-subtle">
                      {t.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </CardBody>
      </Card>

      <Card as="section">
        <CardHeader>
          <SectionTitle title="Ergonomics" description="Density and motion, applied app-wide." />
        </CardHeader>
        <CardBody className="space-y-5">
          <div>
            <div className="mb-1.5 text-sm font-medium text-content">Density</div>
            <div
              role="radiogroup"
              aria-label="Density"
              className="inline-flex items-center rounded-lg border border-edge-default bg-surface-raised p-0.5 text-xs font-medium shadow-sm"
            >
              {(
                [
                  ['comfortable', 'Comfortable'],
                  ['compact', 'Compact'],
                ] as const
              ).map(([id, label]) => {
                const active = appearance.density === id
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => set({ density: id as Density })}
                    className={`rounded-md px-3 py-1.5 transition-colors ${
                      active
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'text-content-muted hover:bg-surface-sunken hover:text-content'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <p className="mt-1 text-xs text-content-subtle">
              Compact shrinks the base type scale so tables and lists fit more rows.
            </p>
          </div>
          <Checkbox
            label="Reduce motion"
            description="Minimize animations and transitions across the console."
            checked={appearance.reducedMotion}
            onChange={(e) => set({ reducedMotion: e.target.checked })}
          />
          <NotPersistedNote show={save.data?.persisted === false} />
        </CardBody>
      </Card>
    </div>
  )
}

/* ═══════════════════════ 3 · Notifications ═══════════════════════ */

const CATEGORY_META: Record<NotificationCategory, { title: string; description: string }> = {
  deploys: {
    title: 'Deployments',
    description: 'Deploys, rollouts, and promotions touching projects you follow.',
  },
  policy: {
    title: 'Policy & compliance',
    description: 'Kyverno violations and compliance drift in your projects.',
  },
  security: {
    title: 'Security',
    description: 'CVE findings, secret leaks, and sign-in events for your account.',
  },
  mentions: {
    title: 'Mentions & reviews',
    description: 'When someone mentions you or requests your review.',
  },
  billing: {
    title: 'Billing',
    description: 'Plan renewals, quota breaches, and invoice issues.',
  },
}

function NotificationsSection({
  prefs,
  loading,
  email,
}: {
  prefs: ProfilePrefs
  loading: boolean
  email: string
}) {
  const save = useSaveProfilePrefs()
  const matrix = prefs.notifications

  const toggle = (cat: NotificationCategory, channel: 'inApp' | 'email', value: boolean) => {
    const next: NotificationMatrix = {
      ...matrix,
      [cat]: { ...matrix[cat], [channel]: value },
    }
    save.mutate({ ...prefs, notifications: next })
  }

  if (loading) return <SectionSkeleton />

  return (
    <div className="max-w-3xl space-y-4">
      <Card as="section">
        <CardHeader className="flex items-center justify-between">
          <SectionTitle
            title="Notification preferences"
            description={`In-app lands in the console tray; email goes to ${email}.`}
          />
          {save.isPending ? (
            <span className="text-xs text-content-subtle">Saving…</span>
          ) : null}
        </CardHeader>
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge-subtle text-xs text-content-subtle">
                <th className="px-5 py-2.5 text-left font-medium">Category</th>
                <th className="w-24 px-3 py-2.5 text-center font-medium">In-app</th>
                <th className="w-24 px-3 py-2.5 text-center font-medium">Email</th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_CATEGORIES.map((cat) => {
                const meta = CATEGORY_META[cat]
                const row = matrix[cat]
                return (
                  <tr key={cat} className="border-b border-edge-subtle last:border-b-0">
                    <td className="px-5 py-3">
                      <div className="font-medium text-content">{meta.title}</div>
                      <div className="text-xs text-content-subtle">{meta.description}</div>
                    </td>
                    {(['inApp', 'email'] as const).map((channel) => (
                      <td key={channel} className="px-3 py-3 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${meta.title} — ${channel === 'inApp' ? 'in-app' : 'email'}`}
                          className="h-4 w-4 rounded border-edge-default"
                          checked={row[channel]}
                          onChange={(e) => toggle(cat, channel, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </CardBody>
      </Card>
      <NotPersistedNote show={save.data?.persisted === false} />
    </div>
  )
}

/* ═══════════════════════ 4 · Access tokens ═══════════════════════ */

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiry' },
] as const

function TokensSection() {
  const q = usePersonalTokens()
  const revoke = useRevokePersonalToken()
  const [createOpen, setCreateOpen] = useState(false)
  const [minted, setMinted] = useState<MintedToken | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<PersonalToken | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle
          title="Personal access tokens"
          description="For CLIs and scripts acting as you. Only a SHA-256 hash is stored — the secret is shown once."
        />
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          New token
        </Button>
      </div>

      {q.isError ? (
        <TokenErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          {revoke.isError ? (
            <p className="text-xs text-rose-700 dark:text-rose-400">
              {(revoke.error as Error)?.message}
            </p>
          ) : null}
          <DataTable
            loading={q.isLoading}
            rows={q.data ?? []}
            rowKey={(t) => t.id}
            empty={
              <EmptyState
                title="No personal tokens"
                description="Create one to call the Adhar API from a CLI or script as yourself."
                action={
                  <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                    New token
                  </Button>
                }
              />
            }
            columns={[
              {
                key: 'name',
                header: 'Name',
                cell: (t) => <span className="font-medium text-content">{t.name}</span>,
              },
              {
                key: 'token',
                header: 'Token',
                cell: (t) => (
                  <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
                    {t.prefix}…{t.last4 ?? ''}
                  </code>
                ),
              },
              {
                key: 'scopes',
                header: 'Scopes',
                cell: (t) => (
                  <div className="flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <code
                        key={s}
                        className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
                      >
                        {s}
                      </code>
                    ))}
                  </div>
                ),
              },
              {
                key: 'lastUsed',
                header: 'Last used',
                cell: (t) => (t.lastUsedAt ? formatRelative(t.lastUsedAt) : 'never'),
              },
              {
                key: 'expires',
                header: 'Expires',
                cell: (t) => (t.expiresAt ? formatRelative(t.expiresAt) : 'never'),
              },
              {
                key: 'created',
                header: 'Created',
                cell: (t) => formatRelative(t.createdAt),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                cell: (t) => (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10"
                    onClick={() => setPendingRevoke(t)}
                  >
                    Revoke
                  </Button>
                ),
              },
            ]}
          />
        </>
      )}

      <CreateTokenModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onMinted={(r) => {
          setCreateOpen(false)
          setMinted(r)
        }}
      />
      <ShowOnceModal minted={minted} onClose={() => setMinted(null)} />
      <Modal
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        title="Revoke token"
        description="Anything using this token will start failing immediately."
        footer={
          <>
            <Button size="sm" onClick={() => setPendingRevoke(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={revoke.isPending}
              onClick={() => {
                if (!pendingRevoke) return
                revoke.mutate(pendingRevoke.id, { onSuccess: () => setPendingRevoke(null) })
              }}
            >
              Revoke
            </Button>
          </>
        }
      >
        {pendingRevoke ? (
          <p className="text-sm text-content">
            Revoke <span className="font-medium">{pendingRevoke.name}</span> (
            <code className="font-mono text-[12px]">
              {pendingRevoke.prefix}…{pendingRevoke.last4 ?? ''}
            </code>
            )?
          </p>
        ) : null}
      </Modal>
    </div>
  )
}

function CreateTokenModal({
  open,
  onClose,
  onMinted,
}: {
  open: boolean
  onClose(): void
  onMinted(r: MintedToken): void
}) {
  const create = useCreatePersonalToken()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<string>>(new Set(['projects:read']))
  const [expiry, setExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]['value']>('90')

  const toggleScope = (s: string) =>
    setScopes((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })

  const submit = () => {
    const expiresAt =
      expiry === 'never'
        ? undefined
        : new Date(Date.now() + Number(expiry) * 86400_000).toISOString()
    create.mutate(
      { name: name.trim(), scopes: [...scopes], expiresAt },
      {
        onSuccess: (r) => {
          setName('')
          setScopes(new Set(['projects:read']))
          setExpiry('90')
          create.reset()
          onMinted(r)
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      title="New personal access token"
      description="The secret is minted server-side and stored only as a SHA-256 hash."
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!name.trim() || scopes.size === 0}
            loading={create.isPending}
            onClick={submit}
          >
            Create token
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input
            value={name}
            placeholder="e.g. laptop-cli"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-content">Scopes</span>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {TOKEN_SCOPE_OPTIONS.map((s) => {
              const on = scopes.has(s)
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleScope(s)}
                  className={
                    on
                      ? 'flex items-center justify-between rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1.5 text-left font-mono text-[11px] text-brand-900 dark:border-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
                      : 'flex items-center justify-between rounded-lg border border-edge-default bg-surface-raised px-2.5 py-1.5 text-left font-mono text-[11px] text-content-muted hover:bg-surface-sunken'
                  }
                >
                  {s}
                  {on ? <span aria-hidden>✓</span> : null}
                </button>
              )
            })}
          </div>
        </div>
        <Field label="Expiry">
          <Select
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as (typeof EXPIRY_OPTIONS)[number]['value'])}
            options={[...EXPIRY_OPTIONS]}
          />
        </Field>
        {create.isError ? (
          <p className="text-xs text-rose-700 dark:text-rose-400">
            {(create.error as Error)?.message ?? 'Could not create the token.'}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

function ShowOnceModal({
  minted,
  onClose,
}: {
  minted: MintedToken | null
  onClose(): void
}) {
  return (
    <Modal
      open={minted !== null}
      onClose={onClose}
      branded
      title="Copy your new token"
      description="This is the only time the secret is shown. It is stored server-side as a hash only."
      footer={
        <Button size="sm" variant="primary" onClick={onClose}>
          I've copied it
        </Button>
      }
    >
      {minted ? (
        <div className="space-y-3">
          <div className="text-xs text-content-muted">
            {minted.item.name} · scopes: {minted.item.scopes.join(', ')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 font-mono text-[12px] text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              {minted.token}
            </code>
            <Button size="sm" onClick={() => navigator.clipboard?.writeText(minted.token)}>
              Copy
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

/** DB-unavailable / no-server / fetch-error state — no fake rows, ever. */
function TokenErrorState({ error, retry }: { error: unknown; retry(): void }) {
  if (isDbUnavailable(error)) {
    return (
      <EmptyState
        title="Connect a database"
        description="Personal access tokens persist to Postgres. Set DATABASE_URL for the console server to enable them — no stubbed data is shown."
      />
    )
  }
  if (isServerUnavailable(error)) {
    return (
      <EmptyState
        title="Console server required"
        description={(error as Error).message}
      />
    )
  }
  if (isUnauthenticated(error)) {
    return (
      <EmptyState
        title="Sign in required"
        description="Personal access tokens are tied to your Keycloak SSO session. Sign in through the server login to create and manage them."
      />
    )
  }
  return (
    <EmptyState
      title="Couldn't load tokens"
      description={(error as Error)?.message ?? 'Unexpected error.'}
      action={
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      }
    />
  )
}

/* ═══════════════════════ 5 · Security & sessions ═══════════════════════ */

function describeUserAgent(ua: string): string {
  if (!ua) return 'This browser'
  let browser = 'Browser'
  const edge = ua.match(/Edg\/(\d+)/)
  const firefox = ua.match(/Firefox\/(\d+)/)
  const chrome = ua.match(/Chrome\/(\d+)/)
  const safari = ua.match(/Version\/(\d+).*Safari/)
  if (edge) browser = `Edge ${edge[1]}`
  else if (firefox) browser = `Firefox ${firefox[1]}`
  else if (chrome) browser = `Chrome ${chrome[1]}`
  else if (safari) browser = `Safari ${safari[1]}`
  let os = ''
  if (/Mac OS X/.test(ua)) os = 'macOS'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/iPhone|iPad/.test(ua)) os = 'iOS'
  else if (/Linux/.test(ua)) os = 'Linux'
  return os ? `${browser} · ${os}` : browser
}

function SecuritySection({
  session,
  user,
  activeTenant,
}: {
  session: Session | null
  user: User
  activeTenant: string
}) {
  const info = useAuthSessionInfo()
  const [ua, setUa] = useState('')
  useEffect(() => {
    if (typeof navigator !== 'undefined') setUa(navigator.userAgent)
  }, [])

  // Prefer the freshest server projection; fall back to the in-memory session.
  const live = info.data?.session ?? session
  // Real SSO session = the server confirms an authenticated cookie session.
  const ssoSession = info.data?.authenticated === true
  // In-memory session without a server-side one ⇒ the dev demo session.
  const isDemo = !ssoSession && session !== null
  const [confirmSignout, setConfirmSignout] = useState(false)

  return (
    <div className="max-w-3xl space-y-6">
      <Card as="section">
        <CardHeader className="flex items-center justify-between">
          <SectionTitle title="Current session" />
          {live ? <StatusBadge kind="healthy">this session</StatusBadge> : null}
        </CardHeader>
        <CardBody className="space-y-4">
          {live ? (
            <>
              <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-content-subtle">Device</dt>
                  <dd className="text-content">{describeUserAgent(ua)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-content-subtle">Signed in as</dt>
                  <dd className="text-content">{live.user.email}</dd>
                </div>
                <div>
                  <dt className="text-xs text-content-subtle">Active organization</dt>
                  <dd className="text-content">{live.activeTenant || activeTenant}</dd>
                </div>
                <div>
                  <dt className="text-xs text-content-subtle">Access token expires</dt>
                  <dd className="text-content" title={formatAbsolute(live.expiresAt)}>
                    {formatRelative(live.expiresAt)}
                    <span className="ml-1 text-xs text-content-subtle">
                      ({formatAbsolute(live.expiresAt)})
                    </span>
                  </dd>
                </div>
              </dl>
              {isDemo ? (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  Dev demo session — no Keycloak-backed cookie session behind this tab. In
                  production this shows your real SSO session.
                </p>
              ) : null}
              <p className="text-xs text-content-subtle">
                Only this browser's session is shown. Console sessions are stateless HttpOnly
                cookies — there is no server-side session registry to enumerate other devices.
                The full device list lives in Keycloak (Account console → Device activity).
              </p>
            </>
          ) : (
            <EmptyState
              compact
              title="No active session"
              description="You are browsing anonymously — sign in to see session details."
            />
          )}
        </CardBody>
      </Card>

      <Card as="section">
        <CardHeader>
          <SectionTitle
            title="Sign out everywhere"
            description="Ends this console session and your Keycloak SSO session, so SSO-connected tools sign out on their next check."
          />
        </CardHeader>
        <CardBody className="space-y-3">
          <Button
            variant="danger"
            size="sm"
            disabled={!ssoSession}
            onClick={() => setConfirmSignout(true)}
          >
            Sign out everywhere
          </Button>
          {!ssoSession ? (
            <p className="text-xs text-content-subtle">
              Requires a Keycloak SSO session — there is no server-side session to end for the
              dev demo login.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card as="section">
        <CardHeader>
          <SectionTitle title="Identity security" description="Managed in Keycloak" />
        </CardHeader>
        <CardBody className="space-y-4 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-medium text-content">Multi-factor authentication</div>
              <p className="mt-0.5 max-w-md text-xs text-content-subtle">
                The console can't read your MFA enrollment — OTP and passkeys (WebAuthn) are
                configured in the Keycloak account console under Signing in.
              </p>
            </div>
            <KeycloakLink label="Manage MFA in Keycloak" />
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3 border-t border-edge-subtle pt-4">
            <div>
              <div className="font-medium text-content">Password & identity</div>
              <p className="mt-0.5 max-w-md text-xs text-content-subtle">
                Password, email, and username for {user.email} are owned by Keycloak SSO and
                cannot be changed here.
              </p>
            </div>
            <KeycloakLink label="Manage in Keycloak" />
          </div>
        </CardBody>
      </Card>

      <Modal
        open={confirmSignout}
        onClose={() => setConfirmSignout(false)}
        title="Sign out everywhere?"
        description="This clears your console session cookie and ends your Keycloak SSO session."
        footer={
          <>
            <Button size="sm" onClick={() => setConfirmSignout(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => globalThis.location.assign('/api/auth/logout')}
            >
              Sign out
            </Button>
          </>
        }
      >
        <p className="text-sm text-content">
          You will be returned to the login page. Tools connected via SSO will sign out on their
          next session check.
        </p>
      </Modal>
    </div>
  )
}
