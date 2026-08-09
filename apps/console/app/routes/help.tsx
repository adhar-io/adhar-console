import { createFileRoute, Link } from '@tanstack/react-router'
import { AppShell, PageHeader } from '@adhar-console/shell-ui'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'

export const Route = createFileRoute('/help')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Help & docs · Adhar Console' }] }),
  component: HelpPage,
})

const CARDS = [
  {
    title: 'Getting started',
    description: '5-minute orientation to the 6D model and the Platform view.',
    href: '/onboarding',
    linkLabel: 'Open the onboarding wizard',
  },
  {
    title: 'Architecture',
    description: 'Module Federation, BFF, tenancy, deployment topology.',
    href: '/help',
    linkLabel: 'Read ARCHITECTURE.md ↗',
    external: true,
  },
  {
    title: 'Platform status',
    description: 'Live health of every backing OSS component + versions.',
    href: '/status',
    linkLabel: 'Open status page',
  },
  {
    title: 'Changelog',
    description: "What's new, what's coming next.",
    href: '/changelog',
    linkLabel: 'View changelog',
  },
  {
    title: 'Keyboard shortcuts',
    description: 'Command palette ⌘K. Navigation j/k/h/l.',
    href: '/help',
    linkLabel: 'Full list',
  },
  {
    title: 'File an issue',
    description: 'Bug reports and feature requests go to the Gitea repo.',
    href: 'https://gitea.adhar.local/adhar/console/issues',
    linkLabel: 'Open Gitea issues ↗',
    external: true,
  },
]

function HelpPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Help' }]}
      notifications={notifications}
    >
      <PageHeader
        title="Help & docs"
        description="Everything you need to run the console, plus links to every OSS component's upstream docs."
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) =>
          c.external ? (
            <a
              key={c.title}
              href={c.href}
              target="_blank"
              rel="noreferrer"
              className="group rounded-lg border border-edge-default bg-surface-raised p-5 shadow-sm transition hover:border-slate-300 hover:shadow"
            >
              <div className="text-sm font-semibold text-content">{c.title}</div>
              <p className="mt-1 text-sm text-content-subtle">{c.description}</p>
              <div className="mt-4 text-xs font-medium text-content-muted group-hover:underline">
                {c.linkLabel}
              </div>
            </a>
          ) : (
            <Link
              key={c.title}
              to={c.href}
              className="group rounded-lg border border-edge-default bg-surface-raised p-5 shadow-sm transition hover:border-slate-300 hover:shadow"
            >
              <div className="text-sm font-semibold text-content">{c.title}</div>
              <p className="mt-1 text-sm text-content-subtle">{c.description}</p>
              <div className="mt-4 text-xs font-medium text-content-muted group-hover:underline">
                {c.linkLabel}
              </div>
            </Link>
          ),
        )}
      </div>
    </AppShell>
  )
}
