import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AppShell, PageHeader, useAppConfig, useDocsUrl } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { PENDING_USER, useOptionalSession } from '@adhar/auth'
import { getLayoutData } from '~/server/session.ts'

/**
 * Help.
 *
 * Kept to things that are true of this console: every link goes to a page
 * that exists, every shortcut is one the code actually binds, and the
 * troubleshooting entries are the failure modes the console's own
 * diagnostics endpoint reports. When one of those changes, change it here.
 */
export const Route = createFileRoute('/help')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Help · Adhar Console' }] }),
  component: HelpPage,
})

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? '⌘' : 'Ctrl'

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
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? PENDING_USER
  const config = useAppConfig()
  const docs = useDocsUrl()
  const version = config.data?.version
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Help' }]}
      notifications={notifications}
    >
      <PageHeader title="Help" />

      <Section title="Get started">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {START.map((c) => (
            <a key={c.title} href={c.href} className="group rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-colors hover:border-brand-300 dark:hover:border-brand-500/40">
              <div className="text-sm font-semibold text-content">{c.title}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-content-muted">{c.body}</p>
              <div className="mt-3 text-[12px] font-medium text-brand-700 group-hover:underline dark:text-brand-300">{c.cta} →</div>
            </a>
          ))}
        </div>
      </Section>

      <Section title="Where things live">
        <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
          <ul className="divide-y divide-edge-subtle">
            {AREAS.map((a) => (
              <li key={a.name}>
                <a href={a.href} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-sunken/50">
                  <span className="w-24 shrink-0 text-sm font-semibold text-content">{a.name}</span>
                  <span className="min-w-0 flex-1 text-[13px] text-content-muted">{a.what}</span>
                  <span className="text-content-subtle" aria-hidden>→</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Keyboard shortcuts">
          <div className="space-y-3">
            {SHORTCUTS.map((g) => (
              <div key={g.group} className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
                <div className="border-b border-edge-subtle px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-content-subtle">{g.group}</div>
                <table className="w-full text-[13px]">
                  <tbody className="divide-y divide-edge-subtle">
                    {g.rows.map(([k, v]) => (
                      <tr key={k}>
                        <td className="w-32 whitespace-nowrap px-4 py-2 align-top">
                          <kbd className="rounded border border-edge-default bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content">{k}</kbd>
                        </td>
                        <td className="px-4 py-2 text-content-muted">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Troubleshooting">
          <div className="space-y-2">
            {TROUBLE.map((t) => <Faq key={t.q} q={t.q} a={t.a} />)}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to="/status" className="rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong">
              Platform status
            </Link>
            <a href="/api/diagnostics" target="_blank" rel="noreferrer" className="rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong">
              Connectivity diagnostics ↗
            </a>
          </div>
        </Section>
      </div>

      <Section title="Documentation and support">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <External title="Documentation" body="Guides, concepts and the platform reference." href={docs} />
          <External title="Report a console issue" body="Bugs and feature requests for this console." href="https://github.com/adhar-io/adhar-console/issues" />
          <External title="Report a platform issue" body="The Adhar CLI, controller and the stack it installs." href="https://github.com/adhar-io/adhar/issues" />
        </div>
        <p className="mt-4 text-[12px] text-content-subtle">
          Adhar Console {version ? (version === 'dev' ? '(development build)' : `v${version}`) : ''} ·{' '}
          <Link to="/changelog" className="text-brand-700 hover:underline dark:text-brand-300">What&apos;s new</Link>
        </p>
      </Section>
    </AppShell>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content-subtle">{title}</h2>
      {children}
    </section>
  )
}

function Faq({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[13px] font-medium text-content">
        {q}
        <span className={cn('text-content-subtle transition-transform', open && 'rotate-90')} aria-hidden>›</span>
      </button>
      {open ? <p className="border-t border-edge-subtle px-4 py-3 text-[13px] leading-relaxed text-content-muted">{a}</p> : null}
    </div>
  )
}

function External({ title, body, href }: { title: string; body: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="group rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-colors hover:border-brand-300 dark:hover:border-brand-500/40">
      <div className="text-sm font-semibold text-content">{title} ↗</div>
      <p className="mt-1 text-[13px] text-content-muted">{body}</p>
      <div className="mt-2 truncate font-mono text-[11px] text-content-subtle">{href.replace(/^https?:\/\//, '')}</div>
    </a>
  )
}
