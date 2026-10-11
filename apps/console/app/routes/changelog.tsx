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
  docs: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/20',
  change: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20',
}
const TYPE_DOT: Record<ReleaseChange['type'], string> = {
  feature: 'bg-emerald-500',
  improvement: 'bg-brand-500',
  fix: 'bg-amber-500',
  docs: 'bg-violet-500',
  change: 'bg-sky-500',
}

/** One colour family per capability, so the grid reads as a map, not a wall. */
const ICON_TONE: Record<string, { chip: string; wash: string; bar: string }> = {
  catalog: { chip: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', wash: 'from-violet-500/10', bar: 'from-violet-500 to-fuchsia-500' },
  pipeline: { chip: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300', wash: 'from-sky-500/10', bar: 'from-sky-500 to-cyan-500' },
  gitops: { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', wash: 'from-emerald-500/10', bar: 'from-emerald-500 to-teal-500' },
  logs: { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300', wash: 'from-amber-500/10', bar: 'from-amber-500 to-orange-500' },
  shell: { chip: 'bg-slate-200 text-slate-800 dark:bg-slate-500/20 dark:text-slate-200', wash: 'from-slate-500/10', bar: 'from-slate-500 to-slate-700' },
  resources: { chip: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300', wash: 'from-indigo-500/10', bar: 'from-indigo-500 to-brand-500' },
  observability: { chip: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300', wash: 'from-rose-500/10', bar: 'from-rose-500 to-pink-500' },
  security: { chip: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300', wash: 'from-teal-500/10', bar: 'from-teal-500 to-emerald-500' },
  editor: { chip: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300', wash: 'from-fuchsia-500/10', bar: 'from-fuchsia-500 to-pink-500' },
  scorecard: { chip: 'bg-lime-100 text-lime-800 dark:bg-lime-500/15 dark:text-lime-300', wash: 'from-lime-500/10', bar: 'from-lime-500 to-emerald-500' },
  assist: { chip: 'bg-gradient-to-br from-brand-500 to-accent-500 text-white', wash: 'from-accent-500/10', bar: 'from-brand-500 to-accent-500' },
  workspace: { chip: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300', wash: 'from-cyan-500/10', bar: 'from-cyan-500 to-sky-500' },
  marketplace: { chip: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300', wash: 'from-orange-500/10', bar: 'from-orange-500 to-amber-500' },
}
const toneFor = (icon: string) => ICON_TONE[icon] ?? ICON_TONE.resources
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
      <Spotlight />
      <Summary />
      <FeatureGrid />
      <ReleaseTimeline />
    </AppShell>
  )
}

/* ─────────── summary ─────────── */

function Spotlight() {
  const latest = RELEASE_NOTES[0]
  if (!latest) return null
  const age = daysAgo(latest.date)
  const counts = TYPE_ORDER.map((t) => [t, latest.changes.filter((c) => c.type === t).length] as const).filter(([, n]) => n > 0)
  const headline = [...latest.changes].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)).slice(0, 3)
  return (
    <section className="relative mb-6 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 via-indigo-600 to-accent-600 p-6 text-white shadow-lg sm:p-8">
      {/* soft light, a dotted grid and two glows — decoration only */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-25 [background-image:radial-gradient(rgba(255,255,255,0.35)_1px,transparent_1px)] [background-size:18px_18px]" />
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-fuchsia-400/40 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-24 left-1/3 h-56 w-56 rounded-full bg-sky-300/30 blur-3xl" />
      <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ring-1 ring-inset ring-white/25 backdrop-blur">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" /> Latest release
          </span>
          <h2 className="mt-3 font-mono text-[34px] font-bold leading-none tracking-tight sm:text-[40px]">v{latest.version}</h2>
          <p className="mt-2 text-[13px] text-white/80">
            Released {latest.date} · {age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`} · {latest.changes.length} change{latest.changes.length === 1 ? '' : 's'}
          </p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {counts.map(([t, n]) => (
              <span key={t} className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ring-white/20">
                <span className={cn('h-1.5 w-1.5 rounded-full', TYPE_DOT[t])} /> {n} {TYPE_LABEL[t].toLowerCase()}
              </span>
            ))}
          </div>
          <a href="#release-notes" className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-[12px] font-semibold text-brand-700 shadow-sm transition-transform hover:-translate-y-px">
            Read the release notes ↓
          </a>
        </div>
        {headline.length ? (
          <ul className="space-y-2">
            {headline.map((c, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl bg-white/10 px-4 py-3 ring-1 ring-inset ring-white/15 backdrop-blur-sm">
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-white/30', TYPE_DOT[c.type])} />
                <span className="min-w-0 text-[13px] leading-snug">
                  <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/70">{TYPE_LABEL[c.type]}{c.scope ? ` · ${c.scope}` : ''}</span>
                  <span className="text-white">{c.text}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  )
}

function Summary() {
  const config = useAppConfig()
  const running = config.data?.version
  const latest = RELEASE_NOTES[0]
  const last30 = RELEASE_NOTES.filter((r) => daysAgo(r.date) <= 30)
  const count = (t: ReleaseChange['type']) => last30.reduce((n, r) => n + r.changes.filter((c) => c.type === t).length, 0)
  const behind = running && latest && running !== 'dev' && running !== latest.version
  return (
    <section className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        icon="server"
        tone={behind ? 'amber' : 'emerald'}
        label="Running here"
        value={running ? (running === 'dev' ? 'dev build' : `v${running}`) : '…'}
        hint={behind ? `v${latest.version} is available` : running === 'dev' ? 'a local development build' : 'the latest release'}
      />
      <Tile icon="tag" tone="brand" label="Latest release" value={latest ? `v${latest.version}` : '—'} hint={latest ? `${latest.date} · ${daysAgo(latest.date) === 0 ? 'today' : `${daysAgo(latest.date)}d ago`}` : ''} />
      <Tile icon="spark" tone="violet" label="Releases · 30 days" value={String(last30.length)} hint={`${count('feature')} new · ${count('improvement')} improved`} />
      <Tile icon="wrench" tone="amber" label="Fixes · 30 days" value={String(count('fix'))} hint="from the release notes below" />
    </section>
  )
}

const TILE_TONE = {
  emerald: { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', bar: 'from-emerald-400 to-teal-500' },
  brand: { chip: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300', bar: 'from-brand-400 to-indigo-500' },
  violet: { chip: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', bar: 'from-violet-400 to-fuchsia-500' },
  amber: { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300', bar: 'from-amber-400 to-orange-500' },
} as const

function Tile({ label, value, hint, tone, icon }: { label: string; value: string; hint?: string; tone: keyof typeof TILE_TONE; icon: 'server' | 'tag' | 'spark' | 'wrench' }) {
  const t = TILE_TONE[tone]
  return (
    <div className="relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised px-4 py-3.5 shadow-sm">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r', t.bar)} />
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{label}</div>
        <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', t.chip)}><TileIcon icon={icon} /></span>
      </div>
      <div className={cn('mt-1 font-mono text-[22px] font-semibold tabular-nums leading-none', tone === 'amber' && label === 'Running here' ? 'text-amber-700 dark:text-amber-300' : 'text-content')}>{value}</div>
      {hint ? <div className="mt-1.5 truncate text-[11px] text-content-muted">{hint}</div> : null}
    </div>
  )
}

function TileIcon({ icon }: { icon: 'server' | 'tag' | 'spark' | 'wrench' }) {
  const p = (children: React.ReactNode) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
  )
  if (icon === 'server') return p(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>)
  if (icon === 'tag') return p(<><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><path d="M7.5 7.5h.01" /></>)
  if (icon === 'spark') return p(<path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4z" />)
  return p(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />)
}

/* ─────────── capabilities ─────────── */

function FeatureGrid() {
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-content">What the console does today</h2>
          <p className="mt-0.5 text-[13px] text-content-muted">{FEATURE_HIGHLIGHTS.length} capabilities, each a click away.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_HIGHLIGHTS.map((f) => <FeatureCard key={f.title} feature={f} />)}
      </div>
    </section>
  )
}

function FeatureCard({ feature }: { feature: FeatureHighlight }) {
  const t = toneFor(feature.icon)
  const body = (
    <>
      <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100', t.wash)} />
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r opacity-70', t.bar)} />
      <div className="relative flex items-start justify-between gap-3">
        <span className={cn('flex h-11 w-11 items-center justify-center rounded-xl shadow-sm transition-transform duration-300 group-hover:scale-105', t.chip)}>
          <FeatureIcon icon={feature.icon} />
        </span>
        <div className="flex items-center gap-1.5">
          {feature.isNew ? (
            <span className="rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
              Updated
            </span>
          ) : null}
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-subtle">{feature.category}</span>
        </div>
      </div>
      <h3 className="relative mt-3 text-[15px] font-semibold text-content">{feature.title}</h3>
      <p className="relative mt-1 text-[13px] leading-relaxed text-content-muted">{feature.description}</p>
      {feature.href ? (
        <span className="relative mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-brand-700 dark:text-brand-300">
          Open <span className="transition-transform group-hover:translate-x-0.5">→</span>
        </span>
      ) : null}
    </>
  )
  const cls = 'group relative block overflow-hidden rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-all duration-200'
  return feature.href ? (
    <a href={feature.href} className={cn(cls, 'hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md dark:hover:border-brand-500/40')}>{body}</a>
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
    <section id="release-notes" className="mb-6 scroll-mt-20">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-content">Release notes</h2>
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
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                  filter === f ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
                )}
              >
                {f !== 'all' ? <span className={cn('h-1.5 w-1.5 rounded-full', TYPE_DOT[f as ReleaseChange['type']])} /> : null}
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
          <span aria-hidden className="absolute bottom-2 left-[7px] top-2 w-0.5 rounded-full bg-gradient-to-b from-brand-500 via-accent-500/50 to-edge-default" />
          {releases.slice(0, shown).map((r) => {
            const isLatest = r.version === RELEASE_NOTES[0]?.version
            const isRunning = r.version === running
            return (
              <li key={r.version} className="relative">
                <span
                  aria-hidden
                  className={cn(
                    'absolute -left-[23px] top-4 h-4 w-4 rounded-full ring-4 ring-surface-canvas',
                    isLatest ? 'bg-gradient-to-br from-brand-500 to-accent-500 shadow-[0_0_0_6px_rgba(99,102,241,0.15)]' : r.changes.some((c) => c.type === 'feature') ? 'bg-emerald-500' : r.changes.some((c) => c.type === 'fix') ? 'bg-amber-500' : 'bg-edge-strong',
                  )}
                />
                <article className={cn('rounded-xl border bg-surface-raised p-4 shadow-sm transition-shadow hover:shadow-md', isLatest ? 'border-brand-200 dark:border-brand-500/30' : 'border-edge-default')}>
                  <header className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono text-[15px] font-semibold text-content">v{r.version}</h3>
                    {isLatest ? <Pill tone="brand">Latest</Pill> : null}
                    {isRunning ? <Pill tone="emerald">Running here</Pill> : null}
                    <span className="flex items-center gap-1">
                      {TYPE_ORDER.map((t) => {
                        const n = r.changes.filter((c) => c.type === t).length
                        return n ? (
                          <span key={t} title={`${n} ${TYPE_LABEL[t].toLowerCase()}`} className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold ring-1 ring-inset', TYPE_TONE[t])}>
                            {n}
                          </span>
                        ) : null
                      })}
                    </span>
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
