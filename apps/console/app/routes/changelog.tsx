import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AppShell, PageHeader, useAppConfig } from '@adhar/shell-ui'
import {
  FEATURE_HIGHLIGHTS,
  type FeatureHighlight,
  RELEASE_NOTES,
  type ReleaseChange,
} from '@adhar/platform-info'
import { cn } from '@adhar/utils'
import { PENDING_USER, useOptionalSession } from '@adhar/auth'
import { getLayoutData } from '~/server/session.ts'

/**
 * What's New.
 *
 * Everything here is real: the running version comes from the server
 * (`/api/config`), the release timeline is generated from git tags and commit
 * subjects at release time (scripts/release-notes.mjs), and the capability
 * cards link to where each one lives. There is no hand-maintained changelog to
 * drift and no roadmap with invented dates.
 */
export const Route = createFileRoute('/changelog')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: "What's new · Adhar Console" }] }),
  component: ChangelogPage,
})

type Filter = 'all' | ReleaseChange['type']

const TYPE_LABEL: Record<ReleaseChange['type'], string> = {
  feature: 'New',
  improvement: 'Improved',
  fix: 'Fixed',
  docs: 'Docs',
  change: 'Changed',
}
const TYPE_TONE: Record<ReleaseChange['type'], string> = {
  feature: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
  improvement: 'bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20',
  fix: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
  docs: 'bg-surface-sunken text-content-muted ring-edge-default',
  change: 'bg-surface-sunken text-content-muted ring-edge-default',
}
const TYPE_ORDER: ReleaseChange['type'][] = ['feature', 'improvement', 'fix', 'change', 'docs']
const PAGE = 8

function daysAgo(date: string): number {
  return Math.floor((Date.now() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000)
}

function ChangelogPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? PENDING_USER
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: "What's new" }]}
      notifications={notifications}
    >
      <PageHeader title="What's new" />
      <Summary />
      <FeatureGrid />
      <ReleaseTimeline />
    </AppShell>
  )
}

/* ─────────── summary ─────────── */

function Summary() {
  const config = useAppConfig()
  const running = config.data?.version
  const latest = RELEASE_NOTES[0]
  const last30 = RELEASE_NOTES.filter((r) => daysAgo(r.date) <= 30)
  const count = (t: ReleaseChange['type']) => last30.reduce((n, r) => n + r.changes.filter((c) => c.type === t).length, 0)
  const behind = running && latest && running !== 'dev' && running !== latest.version
  return (
    <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Running here"
        value={running ? (running === 'dev' ? 'dev build' : `v${running}`) : '…'}
        hint={behind ? `v${latest.version} is available` : running === 'dev' ? 'a local development build' : 'the latest release'}
        tone={behind ? 'amber' : undefined}
      />
      <Tile label="Latest release" value={latest ? `v${latest.version}` : '—'} hint={latest ? `${latest.date} · ${daysAgo(latest.date) === 0 ? 'today' : `${daysAgo(latest.date)}d ago`}` : ''} />
      <Tile label="Releases · 30 days" value={String(last30.length)} hint={`${count('feature')} new · ${count('improvement')} improved`} />
      <Tile label="Fixes · 30 days" value={String(count('fix'))} hint="from the release notes below" />
    </section>
  )
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'amber' }) {
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised px-4 py-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{label}</div>
      <div className={cn('mt-1 font-mono text-[22px] font-semibold tabular-nums leading-none', tone === 'amber' ? 'text-amber-700 dark:text-amber-300' : 'text-content')}>{value}</div>
      {hint ? <div className="mt-1.5 truncate text-[11px] text-content-muted">{hint}</div> : null}
    </div>
  )
}

/* ─────────── capabilities ─────────── */

function FeatureGrid() {
  return (
    <section className="mb-10">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content-subtle">What the console does today</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_HIGHLIGHTS.map((f) => <FeatureCard key={f.title} feature={f} />)}
      </div>
    </section>
  )
}

function FeatureCard({ feature }: { feature: FeatureHighlight }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
          <FeatureIcon icon={feature.icon} />
        </span>
        <div className="flex items-center gap-1.5">
          {feature.isNew ? (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20">
              Updated
            </span>
          ) : null}
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-subtle">{feature.category}</span>
        </div>
      </div>
      <h3 className="mt-3 text-[15px] font-semibold text-content">{feature.title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-content-muted">{feature.description}</p>
      {feature.href ? <span className="mt-3 inline-block text-[12px] font-medium text-brand-700 group-hover:underline dark:text-brand-300">Open →</span> : null}
    </>
  )
  const cls = 'group block rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-colors'
  return feature.href ? (
    <a href={feature.href} className={cn(cls, 'hover:border-brand-300 dark:hover:border-brand-500/40')}>{body}</a>
  ) : (
    <article className={cls}>{body}</article>
  )
}

/* ─────────── release timeline ─────────── */

function ReleaseTimeline() {
  const config = useAppConfig()
  const running = config.data?.version
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const needle = q.trim().toLowerCase()

  const releases = useMemo(
    () =>
      RELEASE_NOTES.map((r) => ({
        ...r,
        changes: r.changes.filter(
          (c) =>
            (filter === 'all' || c.type === filter) &&
            (!needle || c.text.toLowerCase().includes(needle) || (c.scope ?? '').toLowerCase().includes(needle)),
        ),
      })).filter((r) => r.changes.length > 0 || (filter === 'all' && !needle)),
    [filter, needle],
  )
  const total = RELEASE_NOTES.reduce((n, r) => n + r.changes.length, 0)

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">Release notes</h2>
          <p className="mt-0.5 text-[12px] text-content-muted">
            The last {RELEASE_NOTES.length} releases, {total} changes, generated from the git history at release time.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setShown(PAGE)
            }}
            placeholder="Search changes…"
            aria-label="Search release notes"
            className="h-8 w-56 rounded-lg border border-edge-default bg-surface-raised px-3 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
          <div role="radiogroup" aria-label="Change type" className="inline-flex rounded-lg border border-edge-default bg-surface-sunken p-0.5">
            {(['all', 'feature', 'improvement', 'fix'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                onClick={() => {
                  setFilter(f)
                  setShown(PAGE)
                }}
                className={cn(
                  'h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                  filter === f ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
                )}
              >
                {f === 'all' ? 'All' : TYPE_LABEL[f as ReleaseChange['type']]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {releases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge-default p-8 text-center text-[13px] text-content-muted">Nothing matches.</div>
      ) : (
        <ol className="relative space-y-4 pl-6">
          <span aria-hidden className="absolute bottom-2 left-[7px] top-2 w-px bg-edge-default" />
          {releases.slice(0, shown).map((r) => {
            const isLatest = r.version === RELEASE_NOTES[0]?.version
            const isRunning = r.version === running
            return (
              <li key={r.version} className="relative">
                <span
                  aria-hidden
                  className={cn('absolute -left-[22px] top-4 h-3.5 w-3.5 rounded-full ring-4 ring-surface-app', isLatest ? 'bg-brand-500' : 'bg-edge-strong')}
                />
                <article className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
                  <header className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono text-[15px] font-semibold text-content">v{r.version}</h3>
                    {isLatest ? <Pill tone="brand">Latest</Pill> : null}
                    {isRunning ? <Pill tone="emerald">Running here</Pill> : null}
                    <span className="ml-auto text-[11px] text-content-subtle">
                      {r.date} · {r.changes.length} change{r.changes.length === 1 ? '' : 's'}
                    </span>
                  </header>
                  {r.changes.length ? (
                    <ul className="mt-3 space-y-1.5">
                      {[...r.changes]
                        .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
                        .map((c, j) => (
                          <li key={j} className="flex items-start gap-2 text-[13px] text-content-muted">
                            <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ring-1 ring-inset', TYPE_TONE[c.type])}>
                              {TYPE_LABEL[c.type]}
                            </span>
                            <span className="min-w-0">
                              {c.scope ? <span className="mr-1.5 font-mono text-[11px] text-content-subtle">{c.scope}</span> : null}
                              <span className="text-content">{c.text}</span>
                            </span>
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[12px] text-content-subtle">Maintenance release — no user-facing changes.</p>
                  )}
                </article>
              </li>
            )
          })}
        </ol>
      )}
      {releases.length > shown ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => setShown((n) => n + PAGE)}
            className="rounded-lg border border-edge-default bg-surface-raised px-4 py-2 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong"
          >
            Show older releases ({releases.length - shown} more)
          </button>
        </div>
      ) : null}
    </section>
  )
}

function Pill({ tone, children }: { tone: 'brand' | 'emerald'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset',
        tone === 'brand'
          ? 'bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20'
          : 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
      )}
    >
      {children}
    </span>
  )
}

/* ─────────── icons ─────────── */

function FeatureIcon({ icon }: { icon: FeatureHighlight['icon'] }) {
  const p = (children: React.ReactNode) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
  switch (icon) {
    case 'catalog':
      return p(<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />)
    case 'pipeline':
      return p(<><circle cx="5" cy="6" r="2" /><circle cx="12" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><path d="M7 6h3M14 6h3M5 8v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M12 14v6" /></>)
    case 'gitops':
      return p(<><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></>)
    case 'logs':
      return p(<><path d="M4 4h16v16H4z" /><path d="M8 9h8M8 13h8M8 17h5" /></>)
    case 'shell':
      return p(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>)
    case 'resources':
      return p(<path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />)
    case 'observability':
      return p(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />)
    case 'security':
      return p(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>)
    case 'editor':
      return p(<><path d="m18 2 4 4-14 14H4v-4z" /><path d="m14 6 4 4" /></>)
    case 'scorecard':
      return p(<><path d="M3 3v18h18" /><path d="m7 14 3-3 3 3 5-6" /></>)
    case 'assist':
      return p(<path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4z" />)
    case 'workspace':
      return p(<><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 4a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" /></>)
    case 'marketplace':
      return p(<><path d="M3 9l1.5-5h15L21 9" /><path d="M4 9v11h16V9M9 20v-6h6v6" /></>)
    default:
      return p(<circle cx="12" cy="12" r="9" />)
  }
}
