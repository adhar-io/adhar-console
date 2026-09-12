import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@adhar-console/shell-ui'
import {
  CHANGELOG,
  FEATURE_HIGHLIGHTS,
  type FeatureHighlight,
  PLATFORM_VERSION,
  ROADMAP_HIGHLIGHTS,
} from '@adhar-console/platform-info'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'

export const Route = createFileRoute('/changelog')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: "What's new · Adhar Console" }] }),
  component: ChangelogPage,
})

function ChangelogPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: "What's new" }]}
      notifications={notifications}
    >
      <Hero />
      <FeatureGrid />
      <ReleaseTimeline />
      <Roadmap />
    </AppShell>
  )
}

/* ─────────── Hero ─────────── */

function Hero() {
  return (
    <section className="relative mb-10 overflow-hidden rounded-2xl border border-white/10 bg-code px-6 py-10 sm:px-10 sm:py-14">
      {/* animated gradient blobs */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-brand-500/30 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-28 right-0 h-80 w-80 rounded-full bg-fuchsia-500/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-1/3 top-0 h-56 w-56 rounded-full bg-indigo-500/20 blur-3xl"
      />
      {/* faint grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.14) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black, transparent)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black, transparent)',
        }}
      />
      <div className="relative">
        <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-medium text-slate-200 backdrop-blur">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          Adhar Platform · v{PLATFORM_VERSION.console}
        </span>
        <h1 className="mt-4 max-w-3xl bg-linear-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-3xl font-bold leading-tight tracking-tight text-transparent sm:text-4xl">
          What&apos;s new in Adhar
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300 sm:text-base">
          One console for the whole software lifecycle — catalog, delivery, observability, platform
          and security, built on best-in-class open source. Here are the capabilities shaping the
          platform right now.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {['Backstage-style catalog', 'GitOps delivery', 'Blue Ocean pipelines', 'OpenShift-grade logs'].map(
            (t) => (
              <span
                key={t}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-slate-200"
              >
                {t}
              </span>
            ),
          )}
        </div>
      </div>
    </section>
  )
}

/* ─────────── Feature highlights ─────────── */

function FeatureGrid() {
  return (
    <section className="mb-12">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content-subtle">
        Platform capabilities
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_HIGHLIGHTS.map((f) => (
          <FeatureCard key={f.title} feature={f} />
        ))}
      </div>
    </section>
  )
}

function FeatureCard({ feature }: { feature: FeatureHighlight }) {
  return (
    <article className="group relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-brand-300/60 hover:shadow-lg">
      {/* hover glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-500/0 blur-2xl transition-all duration-500 group-hover:bg-brand-500/15"
      />
      <div className="relative flex items-start justify-between gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-linear-to-br from-brand-500 to-indigo-500 text-white shadow-sm ring-1 ring-inset ring-white/20">
          <FeatureIcon icon={feature.icon} />
        </span>
        <div className="flex items-center gap-1.5">
          {feature.isNew ? (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20">
              New
            </span>
          ) : null}
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-subtle">
            {feature.category}
          </span>
        </div>
      </div>
      <h3 className="relative mt-4 text-[15px] font-semibold text-content">{feature.title}</h3>
      <p className="relative mt-1.5 text-[13px] leading-relaxed text-content-muted">
        {feature.description}
      </p>
    </article>
  )
}

/* ─────────── Release timeline ─────────── */

function ReleaseTimeline() {
  return (
    <section className="mb-12">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content-subtle">
        Release timeline
      </h2>
      <div className="relative space-y-6 pl-6">
        {/* the line */}
        <div
          aria-hidden
          className="absolute bottom-2 left-[7px] top-2 w-px bg-linear-to-b from-brand-400 via-edge-default to-transparent"
        />
        {CHANGELOG.map((entry, i) => (
          <article key={entry.version} className="relative">
            <span
              aria-hidden
              className={
                'absolute -left-[22px] top-1 h-3.5 w-3.5 rounded-full ring-4 ring-surface-app ' +
                (i === 0 ? 'bg-brand-500' : 'bg-slate-400')
              }
            />
            <div className="rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm">
              <header className="flex items-baseline justify-between gap-3">
                <h3 className="flex items-center gap-2 text-lg font-semibold text-content">
                  v{entry.version}
                  {i === 0 ? (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
                      Latest
                    </span>
                  ) : null}
                </h3>
                <span className="text-xs text-content-subtle">{entry.date}</span>
              </header>
              <ul className="mt-3 space-y-2 text-sm text-content-muted">
                {entry.highlights.map((h, j) => (
                  <li key={j} className="flex items-start gap-2.5">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                    {h}
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

/* ─────────── Roadmap ─────────── */

const ROADMAP_TONE: Record<string, string> = {
  shipped: 'text-emerald-600 dark:text-emerald-400',
  'in-progress': 'text-indigo-600 dark:text-indigo-400',
  planned: 'text-content-subtle',
}

function Roadmap() {
  return (
    <section className="mb-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content-subtle">
        What&apos;s next
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {ROADMAP_HIGHLIGHTS.map((r) => (
          <div
            key={r.title}
            className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm transition-colors hover:border-brand-200"
          >
            <div className="text-sm font-medium text-content">{r.title}</div>
            <div className="mt-1.5 flex items-center gap-2 text-xs">
              <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-content-subtle">
                v{r.target}
              </span>
              <span className={'font-medium capitalize ' + (ROADMAP_TONE[r.status] ?? '')}>
                {r.status.replace('-', ' ')}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ─────────── icons ─────────── */

function FeatureIcon({ icon }: { icon: FeatureHighlight['icon'] }) {
  const p = (children: React.ReactNode) => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
  switch (icon) {
    case 'catalog':
      return p(<><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></>)
    case 'pipeline':
      return p(<><circle cx="5" cy="6" r="2" /><circle cx="12" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><path d="M7 6h3M14 6h3M5 8v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M12 14v6" /></>)
    case 'gitops':
      return p(<><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></>)
    case 'logs':
      return p(<><path d="M4 4h16v16H4z" /><path d="M8 9h8M8 13h8M8 17h5" /></>)
    case 'shell':
      return p(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>)
    case 'resources':
      return p(<><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></>)
    case 'observability':
      return p(<><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></>)
    case 'security':
      return p(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>)
    case 'editor':
      return p(<><path d="m18 2 4 4-14 14H4v-4z" /><path d="m14 6 4 4" /></>)
    case 'scorecard':
      return p(<><path d="M3 3v18h18" /><path d="m7 14 3-3 3 3 5-6" /></>)
    default:
      return p(<circle cx="12" cy="12" r="9" />)
  }
}
