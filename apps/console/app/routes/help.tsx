import { useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AppShell, PageHeader, useAppConfig, useDocsUrl } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { PENDING_USER, useOptionalSession } from '@adhar/auth'
import { getLayoutData } from '~/server/session.ts'
import { ArchitecturePatterns, usePatternsMatching } from '~/components/help-patterns.tsx'

/**
 * Help.
 *
 * Kept to things that are true of this console: every link goes to a page
 * that exists, every shortcut is one the code actually binds, and the
 * troubleshooting entries are the failure modes the console's own
 * diagnostics endpoint reports. When one of those changes, change it here.
 */
export const Route = createFileRoute('/help')({
  // `?pattern=<slug>` opens an architecture pattern; anything else is dropped.
  validateSearch: (s: Record<string, unknown>): { pattern?: string } =>
    typeof s.pattern === 'string' && /^[a-z0-9-]+$/.test(s.pattern) ? { pattern: s.pattern } : {},
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Help · Adhar Console' }] }),
  component: HelpPage,
})

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? '⌘' : 'Ctrl'

type Tone = 'brand' | 'violet' | 'sky' | 'emerald' | 'amber' | 'rose' | 'teal' | 'indigo' | 'fuchsia' | 'slate'

const TONE: Record<Tone, { chip: string; bar: string; wash: string; text: string }> = {
  brand: { chip: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300', bar: 'from-brand-500 to-indigo-500', wash: 'from-brand-500/10', text: 'text-brand-700 dark:text-brand-300' },
  violet: { chip: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', bar: 'from-violet-500 to-fuchsia-500', wash: 'from-violet-500/10', text: 'text-violet-700 dark:text-violet-300' },
  sky: { chip: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300', bar: 'from-sky-500 to-cyan-500', wash: 'from-sky-500/10', text: 'text-sky-700 dark:text-sky-300' },
  emerald: { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', bar: 'from-emerald-500 to-teal-500', wash: 'from-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-300' },
  amber: { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300', bar: 'from-amber-500 to-orange-500', wash: 'from-amber-500/10', text: 'text-amber-800 dark:text-amber-300' },
  rose: { chip: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300', bar: 'from-rose-500 to-pink-500', wash: 'from-rose-500/10', text: 'text-rose-700 dark:text-rose-300' },
  teal: { chip: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300', bar: 'from-teal-500 to-emerald-500', wash: 'from-teal-500/10', text: 'text-teal-700 dark:text-teal-300' },
  indigo: { chip: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300', bar: 'from-indigo-500 to-brand-500', wash: 'from-indigo-500/10', text: 'text-indigo-700 dark:text-indigo-300' },
  fuchsia: { chip: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300', bar: 'from-fuchsia-500 to-pink-500', wash: 'from-fuchsia-500/10', text: 'text-fuchsia-700 dark:text-fuchsia-300' },
  slate: { chip: 'bg-slate-200 text-slate-800 dark:bg-slate-500/20 dark:text-slate-200', bar: 'from-slate-500 to-slate-700', wash: 'from-slate-500/10', text: 'text-content' },
}

const START_STYLE: Record<string, { tone: Tone; icon: IconName }> = {
  'Ask Adhar Assist': { tone: 'violet', icon: 'spark' },
  'Find a service': { tone: 'sky', icon: 'grid' },
  'Ship a change': { tone: 'emerald', icon: 'rocket' },
  'Watch production': { tone: 'amber', icon: 'pulse' },
  'Set up your workspace': { tone: 'indigo', icon: 'users' },
  'New here?': { tone: 'rose', icon: 'flag' },
}

const AREA_STYLE: Record<string, { tone: Tone; icon: IconName }> = {
  Define: { tone: 'violet', icon: 'target' },
  Design: { tone: 'fuchsia', icon: 'pen' },
  Develop: { tone: 'sky', icon: 'code' },
  Deliver: { tone: 'emerald', icon: 'rocket' },
  Discover: { tone: 'amber', icon: 'pulse' },
  Decide: { tone: 'teal', icon: 'chart' },
  Platform: { tone: 'indigo', icon: 'layers' },
  Workspace: { tone: 'slate', icon: 'users' },
}

const START = [
  { title: 'Ask Adhar Assist', body: `Press ${MOD} K anywhere and ask in plain language — "why is checkout failing?", "what changed in prod today?". It answers from live cluster, Git and telemetry data.`, href: '/ai', cta: 'Open Assist' },
  { title: 'Find a service', body: 'The Service Catalog lists every component with its owner, docs, deployments across environments and live metrics.', href: '/catalog', cta: 'Open the catalog' },
  { title: 'Ship a change', body: 'Pipelines, Argo CD applications, Kargo promotions and rollouts live under Deliver.', href: '/deliver?section=apps', cta: 'Open Deliver' },
  { title: 'Watch production', body: 'Metrics, logs, traces, alerts and SLOs from the LGTM stack are under Discover.', href: '/discover?section=dashboard', cta: 'Open Discover' },
  { title: 'Set up your workspace', body: 'Organizations, teams, projects, members, roles, SSO and tokens are managed in Settings.', href: '/settings?section=organization', cta: 'Open Settings' },
  { title: 'New here?', body: 'The onboarding flow creates your organization, connects a cluster and walks through the first service.', href: '/onboarding', cta: 'Start onboarding' },
]

const AREAS = [
  { name: 'Define', what: 'Projects, cycles, modules and issues (Plane).', href: '/define?section=dashboard' },
  { name: 'Design', what: 'Component catalog, ADRs, personas and the visual builder.', href: '/design' },
  { name: 'Develop', what: 'Repositories, pull requests, pipelines, cloud IDEs and environments.', href: '/develop' },
  { name: 'Deliver', what: 'Argo CD apps, environments, Kargo stages, releases, image scans and policy.', href: '/deliver?section=apps' },
  { name: 'Discover', what: 'Metrics, logs, traces, service map, alerts, SLOs and product analytics.', href: '/discover?section=dashboard' },
  { name: 'Decide', what: 'Pulses, KPIs and production-readiness scorecards.', href: '/decide' },
  { name: 'Platform', what: 'Cluster workloads, logs, Cloud Shell, Adhar Resources, Marketplace and CI/CD.', href: '/platform?section=catalog' },
  { name: 'Workspace', what: 'Tenancy, access, security policies, audit log, usage and billing.', href: '/settings?section=organization' },
]

const SHORTCUTS: Array<{ group: string; rows: Array<[string, string]> }> = [
  {
    group: 'Everywhere',
    rows: [
      [`${MOD} K`, 'Open or close the command palette and Adhar Assist'],
      [`${MOD} B`, 'Collapse or expand the sidebar'],
      ['/', 'Focus search on the Catalog, Marketplace, Logs, Repositories and Audit log pages'],
      ['Esc', 'Close the open drawer, dialog or menu'],
    ],
  },
  {
    group: 'Service Catalog drawer',
    rows: [['← →', 'Previous or next entity without closing the drawer']],
  },
  {
    group: 'Adhar Assist',
    rows: [
      [`${MOD} /`, 'Focus the message box'],
      [`${MOD} ⇧ O`, 'Start a new thread'],
      [`${MOD} [`, 'Show or hide the thread list'],
      [`${MOD} ]`, 'Show or hide the inspector'],
      [`${MOD} ⇧ F`, 'Full screen'],
    ],
  },
  {
    group: 'Cloud Shell',
    rows: [
      ['Alt 1…9', 'Switch to session N'],
      ['Alt T', 'New session'],
      ['Alt W', 'Close the active session'],
      ['Alt B', 'Broadcast input to every session'],
    ],
  },
  {
    group: 'Forms and editors',
    rows: [[`${MOD} Enter`, 'Submit a new issue, or run the query in the SQL editor']],
  },
]

const TROUBLE = [
  {
    q: 'Sign-in keeps sending me back to the login page',
    a: 'The session cookie is being dropped. The console keeps tokens server-side in Postgres; if DATABASE_URL is not set the tokens are inlined and the cookie exceeds the browser limit. The diagnostics report shows the session store in use.',
  },
  {
    q: 'Cluster pages say 401 Unauthorized',
    a: "The API server rejected the token. Its OIDC issuer and client ID must match Keycloak's issuer and the token audience; on managed clusters without OIDC the console falls back to its service account with impersonation.",
  },
  {
    q: 'Cluster pages say 403 Forbidden',
    a: 'You are signed in but your Keycloak groups have no RBAC bindings for that resource. Ask an admin to grant the role, then reload.',
  },
  {
    q: 'Metrics panels show "No series"',
    a: 'Prometheus has no samples for that workload. Check that kube-state-metrics and cAdvisor scraping are running, and that the workload name matches its Deployment, StatefulSet or DaemonSet.',
  },
  {
    q: 'A page shows "Couldn\'t reach …"',
    a: 'A backing tool (Gitea, Argo CD, Harbor, Grafana…) is down or unreachable from the console. Platform status shows which component is unhealthy right now.',
  },
]

function HelpPage() {
  const { tenants, activeTenant } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? PENDING_USER
  const config = useAppConfig()
  const docs = useDocsUrl()
  const version = config.data?.version
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const has = (...parts: string[]) => !needle || parts.some((p) => p.toLowerCase().includes(needle))

  const start = START.filter((c) => has(c.title, c.body))
  const areas = AREAS.filter((a) => has(a.name, a.what))
  const shortcuts = useMemo(
    () => SHORTCUTS.map((g) => ({ ...g, rows: g.rows.filter(([k, v]) => has(g.group, k, v)) })).filter((g) => g.rows.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needle],
  )
  const trouble = TROUBLE.filter((t) => has(t.q, t.a))
  const patterns = usePatternsMatching(needle)
  const { pattern } = Route.useSearch()
  const navigate = Route.useNavigate()
  const openPattern = (slug: string | undefined) => navigate({ search: slug ? { pattern: slug } : {}, replace: true, resetScroll: false })
  const nothing = needle && !start.length && !areas.length && !shortcuts.length && !trouble.length && !patterns.length

  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Help' }]}
    >
      <PageHeader title="Help" />

      {/* Hero: one question, one search box that filters everything below. */}
      <section className="relative mb-8 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 via-indigo-600 to-accent-600 px-6 py-8 text-white shadow-lg sm:px-10 sm:py-10">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-25 [background-image:radial-gradient(rgba(255,255,255,0.35)_1px,transparent_1px)] [background-size:18px_18px]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-24 h-64 w-64 rounded-full bg-sky-300/30 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-24 right-0 h-72 w-72 rounded-full bg-fuchsia-400/40 blur-3xl" />
        <div className="relative max-w-2xl">
          <h2 className="text-[26px] font-bold leading-tight tracking-tight sm:text-[30px]">How can we help?</h2>
          <p className="mt-1.5 text-[14px] text-white/80">
            Search guides, architecture patterns, shortcuts and fixes — or press <kbd className="rounded-md bg-white/20 px-1.5 py-0.5 font-mono text-[12px] ring-1 ring-inset ring-white/30">{MOD} K</kbd> and ask Adhar Assist.
          </p>
          <div className="relative mt-5">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-content-subtle"><Glyph name="search" /></span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search help — try “logs”, “401”, “canary” or “sharding”…"
              aria-label="Search help"
              className="h-12 w-full rounded-xl border-0 bg-white pl-11 pr-4 text-[14px] text-slate-900 shadow-xl ring-1 ring-white/40 placeholder:text-slate-400 focus:outline-none focus:ring-4 focus:ring-white/40"
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[12px]">
            <Link to="/status" className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 font-medium ring-1 ring-inset ring-white/25 hover:bg-white/25">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white/70" /> Platform status
            </Link>
            <Link to="/changelog" className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 font-medium ring-1 ring-inset ring-white/25 hover:bg-white/25">
              What&apos;s new{version ? ` · ${version === 'dev' ? 'dev' : `v${version}`}` : ''}
            </Link>
            <a href={docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 font-medium ring-1 ring-inset ring-white/25 hover:bg-white/25">
              Documentation ↗
            </a>
          </div>
        </div>
      </section>

      {nothing ? (
        <div className="mb-8 rounded-xl border border-dashed border-edge-strong bg-surface-raised px-6 py-10 text-center">
          <div className="text-[15px] font-semibold text-content">Nothing matches “{q}”</div>
          <p className="mt-1 text-[13px] text-content-muted">Try another word, ask Adhar Assist with {MOD} K, or search the documentation.</p>
        </div>
      ) : null}

      {start.length ? (
        <Section title="Get started" subtitle="The six things people come to the console for.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {start.map((c) => {
              const st = START_STYLE[c.title] ?? { tone: 'brand' as Tone, icon: 'spark' as IconName }
              const t = TONE[st.tone]
              return (
                <a key={c.title} href={c.href} className="group relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
                  <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r', t.bar)} />
                  <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100', t.wash)} />
                  <span className={cn('relative flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-105', t.chip)}><Glyph name={st.icon} /></span>
                  <div className="relative mt-3 text-[15px] font-semibold text-content">{c.title}</div>
                  <p className="relative mt-1 text-[13px] leading-relaxed text-content-muted">{c.body}</p>
                  <div className={cn('relative mt-3 inline-flex items-center gap-1 text-[12px] font-semibold', t.text)}>
                    {c.cta} <span className="transition-transform group-hover:translate-x-0.5">→</span>
                  </div>
                </a>
              )
            })}
          </div>
        </Section>
      ) : null}

      {areas.length ? (
        <Section title="Where things live" subtitle="The SDLC phases, the platform, and your workspace.">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {areas.map((a) => {
              const st = AREA_STYLE[a.name] ?? { tone: 'slate' as Tone, icon: 'layers' as IconName }
              const t = TONE[st.tone]
              return (
                <a key={a.name} href={a.href} className="group flex items-start gap-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md">
                  <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', t.chip)}><Glyph name={st.icon} /></span>
                  <span className="min-w-0">
                    <span className={cn('block text-[14px] font-semibold', t.text)}>{a.name}</span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-content-muted">{a.what}</span>
                  </span>
                </a>
              )
            })}
          </div>
        </Section>
      ) : null}

      {patterns.length || pattern ? (
        <Section title="Architecture patterns" subtitle="Byte-sized guides to the patterns Adhar is built on — scale, resilience, delivery, data, security, tenancy and operations — and how to use them here.">
          <ArchitecturePatterns needle={needle} openSlug={pattern} onOpen={openPattern} />
        </Section>
      ) : null}

      {shortcuts.length || trouble.length ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          {shortcuts.length ? (
            <Section title="Keyboard shortcuts" subtitle="Everything below is bound in the console today.">
              <div className="space-y-3">
                {shortcuts.map((g, gi) => {
                  const t = TONE[(['brand', 'sky', 'violet', 'emerald', 'amber'] as Tone[])[gi % 5]]
                  return (
                    <div key={g.group} className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
                      <div className="flex items-center gap-2 border-b border-edge-subtle px-4 py-2">
                        <span className={cn('flex h-5 w-5 items-center justify-center rounded-md', t.chip)}><Glyph name="keyboard" small /></span>
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-content-subtle">{g.group}</span>
                      </div>
                      <table data-wrap className="w-full text-[13px]">
                        <tbody className="divide-y divide-edge-subtle">
                          {g.rows.map(([k, v]) => (
                            <tr key={k}>
                              <td className="w-px whitespace-nowrap py-2 pl-4 pr-2 align-top sm:w-36 sm:px-4">
                                <span className="inline-flex gap-1">
                                  {k.split(' ').map((part, i) => (
                                    <kbd key={i} className="min-w-6 rounded-md border border-edge-default border-b-[3px] bg-surface-sunken px-1.5 py-0.5 text-center font-mono text-[11px] text-content">{part}</kbd>
                                  ))}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-content-muted">{v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                })}
              </div>
            </Section>
          ) : <div />}

          {trouble.length ? (
            <Section title="Troubleshooting" subtitle="The failure modes the console's own diagnostics report.">
              <div className="space-y-2">
                {trouble.map((t, i) => <Faq key={`${t.q}|${Boolean(needle)}`} q={t.q} a={t.a} tone={(['rose', 'amber', 'violet', 'sky', 'teal'] as Tone[])[i % 5]} defaultOpen={Boolean(needle)} />)}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to="/status" className="inline-flex items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-content-subtle" /> Platform status
                </Link>
                <a href="/api/diagnostics" target="_blank" rel="noreferrer" className="rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong">
                  Connectivity diagnostics ↗
                </a>
              </div>
            </Section>
          ) : null}
        </div>
      ) : null}

      <Section title="Documentation and support">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <External title="Documentation" body="Guides, concepts and the platform reference." href={docs} tone="brand" icon="book" />
          <External title="Report a console issue" body="Bugs and feature requests for this console." href="https://github.com/adhar-io/adhar-console/issues" tone="violet" icon="bug" />
          <External title="Report a platform issue" body="The Adhar CLI, controller and the stack it installs." href="https://github.com/adhar-io/adhar/issues" tone="emerald" icon="layers" />
        </div>
        <p className="mt-4 text-[12px] text-content-subtle">
          Adhar Console {version ? (version === 'dev' ? '(development build)' : `v${version}`) : ''} ·{' '}
          <Link to="/changelog" className="text-brand-700 hover:underline dark:text-brand-300">What&apos;s new</Link>
        </p>
      </Section>
    </AppShell>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold tracking-tight text-content">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[13px] text-content-muted">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Faq({ q, a, tone, defaultOpen = false }: { q: string; a: string; tone: Tone; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const t = TONE[tone]
  return (
    <div className={cn('overflow-hidden rounded-xl border bg-surface-raised shadow-sm transition-colors', open ? 'border-edge-strong' : 'border-edge-default')}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left text-[13px] font-medium text-content">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', t.chip)}><Glyph name="alert" small /></span>
        <span className="min-w-0 flex-1">{q}</span>
        <span className={cn('text-content-subtle transition-transform', open && 'rotate-90')} aria-hidden>›</span>
      </button>
      {open ? <p className="border-t border-edge-subtle px-4 py-3 pl-14 text-[13px] leading-relaxed text-content-muted">{a}</p> : null}
    </div>
  )
}

function External({ title, body, href, tone, icon }: { title: string; body: string; href: string; tone: Tone; icon: IconName }) {
  const t = TONE[tone]
  return (
    <a href={href} target="_blank" rel="noreferrer" className="group relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r', t.bar)} />
      <div className="flex items-center gap-3">
        <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg', t.chip)}><Glyph name={icon} /></span>
        <div className="text-sm font-semibold text-content">{title} ↗</div>
      </div>
      <p className="mt-2 text-[13px] text-content-muted">{body}</p>
      <div className="mt-2 truncate font-mono text-[11px] text-content-subtle">{href.replace(/^https?:\/\//, '')}</div>
    </a>
  )
}

type IconName = 'spark' | 'grid' | 'rocket' | 'pulse' | 'users' | 'flag' | 'target' | 'pen' | 'code' | 'chart' | 'layers' | 'search' | 'keyboard' | 'alert' | 'book' | 'bug'

function Glyph({ name, small = false }: { name: IconName; small?: boolean }) {
  const size = small ? 12 : 18
  const p = (children: React.ReactNode) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
  )
  switch (name) {
    case 'spark': return p(<path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4z" />)
    case 'grid': return p(<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />)
    case 'rocket': return p(<><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1z" /><path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z" /><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" /></>)
    case 'pulse': return p(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />)
    case 'users': return p(<><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 4a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" /></>)
    case 'flag': return p(<><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></>)
    case 'target': return p(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>)
    case 'pen': return p(<><path d="m18 2 4 4-14 14H4v-4z" /><path d="m14 6 4 4" /></>)
    case 'code': return p(<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />)
    case 'chart': return p(<><path d="M3 3v18h18" /><path d="m7 14 3-3 3 3 5-6" /></>)
    case 'layers': return p(<path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />)
    case 'search': return p(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>)
    case 'keyboard': return p(<><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>)
    case 'alert': return p(<><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>)
    case 'book': return p(<><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></>)
    case 'bug': return p(<><rect x="8" y="6" width="8" height="14" rx="4" /><path d="M19 7l-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M20 13h-4M4 13h4M10 4l1 2M14 4l-1 2" /></>)
  }
}
