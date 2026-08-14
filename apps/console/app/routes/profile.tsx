import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AppShell, DataTable, EmptyState, PageHeader, StatusBadge } from '@adhar-console/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar-console/utils'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'

export const Route = createFileRoute('/profile')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Your profile · Adhar Console' }] }),
  component: ProfilePage,
})

interface Session {
  id: string
  device: string
  ip: string
  location: string
  createdAt: string
  lastSeen: string
  current: boolean
}

const SESSIONS: Session[] = [
  {
    id: 'sess-1',
    device: 'Chrome 130 · macOS',
    ip: '10.0.3.14',
    location: 'Bengaluru, IN',
    createdAt: '2026-04-19T04:55:00Z',
    lastSeen: '2026-04-19T06:14:00Z',
    current: true,
  },
  {
    id: 'sess-2',
    device: 'Adhar CLI v0.1.0',
    ip: '10.0.3.14',
    location: 'Bengaluru, IN',
    createdAt: '2026-04-18T10:12:00Z',
    lastSeen: '2026-04-18T22:05:00Z',
    current: false,
  },
]

interface Pat {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt?: string
  expiresAt?: string
}

const PATS: Pat[] = [
  {
    id: 'pat-laptop',
    name: 'laptop',
    prefix: 'adhar_pat_usr_',
    scopes: ['projects:read', 'deployments:read'],
    lastUsedAt: '2026-04-19T06:12:00Z',
    expiresAt: '2026-08-19T00:00:00Z',
  },
]

function ProfilePage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  const [section, setSection] = useState<'profile' | 'pats' | 'sessions' | 'notifications'>(
    'profile',
  )
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Profile' }]}
      notifications={notifications}
    >
      <PageHeader
        title="Your profile"
        description="Personal settings, access tokens, sessions, and notification preferences."
      />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[200px_1fr]">
        <aside className="space-y-0.5">
          {(
            [
              ['profile', 'Profile'],
              ['pats', 'Access tokens'],
              ['sessions', 'Sessions'],
              ['notifications', 'Notifications'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm ${
                section === id
                  ? 'bg-slate-100 font-medium text-content'
                  : 'text-content-muted hover:bg-surface-sunken hover:text-content'
              }`}
            >
              {label}
            </button>
          ))}
        </aside>
        <div className="min-w-0">
          {section === 'profile' && (
            <div className="space-y-3 rounded-lg border border-edge-default bg-surface-raised p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-content-muted">
                  {user.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="font-medium">{user.name}</div>
                  <div className="text-xs text-content-subtle">{user.email}</div>
                </div>
              </div>
              <div className="text-xs text-content-subtle">
                Roles:{' '}
                {user.roles.map((r) => (
                  <span
                    key={r}
                    className="ml-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-content-muted"
                  >
                    {r}
                  </span>
                ))}
              </div>
              <div className="text-xs text-content-subtle">
                Org memberships: {user.tenants.join(', ')}
              </div>
              <p className="text-xs text-content-subtle">
                Profile edits are driven by Keycloak. Click below to update name, email, password,
                or MFA.
              </p>
              <a
                href="#"
                className="inline-flex rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-xs text-content-muted hover:bg-surface-sunken"
              >
                Open Keycloak account console ↗
              </a>
            </div>
          )}
          {section === 'pats' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-content">Personal access tokens</h2>
                <button
                  type="button"
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-surface-raised hover:bg-slate-800"
                >
                  New token
                </button>
              </div>
              <DataTable
                columns={[
                  { key: 'name', header: 'Name', cell: (t) => <span className="font-medium">{t.name}</span> },
                  {
                    key: 'prefix',
                    header: 'Prefix',
                    cell: (t) => <code className="text-xs">{t.prefix}•••</code>,
                  },
                  {
                    key: 'scopes',
                    header: 'Scopes',
                    cell: (t) => (
                      <div className="flex flex-wrap gap-1">
                        {t.scopes.map((s) => (
                          <span
                            key={s}
                            className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-content-muted"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    ),
                  },
                  {
                    key: 'last',
                    header: 'Last used',
                    cell: (t) => (t.lastUsedAt ? formatRelative(t.lastUsedAt) : '—'),
                  },
                  {
                    key: 'expires',
                    header: 'Expires',
                    cell: (t) => (t.expiresAt ? formatRelative(t.expiresAt) : 'never'),
                  },
                ]}
                rows={PATS}
                rowKey={(t) => t.id}
                empty={<EmptyState title="No personal tokens" />}
              />
            </div>
          )}
          {section === 'sessions' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-content">Active sessions</h2>
              <DataTable
                columns={[
                  {
                    key: 'device',
                    header: 'Device',
                    cell: (s) => (
                      <div>
                        <div className="font-medium">{s.device}</div>
                        <div className="text-xs text-content-subtle">
                          {s.ip} · {s.location}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'started',
                    header: 'Started',
                    cell: (s) => formatAbsolute(s.createdAt),
                  },
                  { key: 'seen', header: 'Last seen', cell: (s) => formatRelative(s.lastSeen) },
                  {
                    key: 'current',
                    header: '',
                    cell: (s) =>
                      s.current ? (
                        <StatusBadge kind="healthy">this session</StatusBadge>
                      ) : (
                        <button
                          type="button"
                          className="rounded-md border border-rose-200 dark:border-rose-500/25 bg-surface-raised px-2.5 py-1 text-xs text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                        >
                          Sign out
                        </button>
                      ),
                  },
                ]}
                rows={SESSIONS}
                rowKey={(s) => s.id}
              />
            </div>
          )}
          {section === 'notifications' && (
            <div className="space-y-3 rounded-lg border border-edge-default bg-surface-raised p-4 shadow-sm">
              <h2 className="text-lg font-semibold text-content">Notification preferences</h2>
              {(
                [
                  ['Deployments', 'Notifications when deploys touch a project you follow.'],
                  ['PR reviews', 'When you are requested for review in Gitea.'],
                  ['Incidents', 'Platform-level incidents and status page updates.'],
                  ['Billing', 'Plan renewals, quota breaches, invoice issues.'],
                ] as const
              ).map(([title, desc]) => (
                <label key={title} className="flex items-start gap-3">
                  <input type="checkbox" defaultChecked className="mt-1" />
                  <div>
                    <div className="text-sm font-medium text-content">{title}</div>
                    <div className="text-xs text-content-subtle">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
