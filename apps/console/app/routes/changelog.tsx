import { createFileRoute } from '@tanstack/react-router'
import { AppShell, PageHeader } from '@adhar-console/shell-ui'
import { CHANGELOG, ROADMAP_HIGHLIGHTS } from '@adhar-console/platform-info'
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
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Changelog' }]}
      notifications={notifications}
    >
      <PageHeader
        title="Changelog"
        description="Every release of the console. Entries link directly to their PR in Gitea."
      />

      <section className="space-y-6">
        {CHANGELOG.map((entry) => (
          <article
            key={entry.version}
            className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
          >
            <header className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-slate-900">v{entry.version}</h2>
              <div className="text-xs text-slate-500">{entry.date}</div>
            </header>
            <ul className="mt-3 space-y-2 text-sm text-slate-700">
              {entry.highlights.map((h, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                  {h}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          What's next
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {ROADMAP_HIGHLIGHTS.map((r) => (
            <div
              key={r.title}
              className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="text-sm font-medium text-slate-900">{r.title}</div>
              <div className="mt-1 text-xs text-slate-500">
                Target: v{r.target} ·{' '}
                <span
                  className={
                    r.status === 'shipped'
                      ? 'text-emerald-600'
                      : r.status === 'in-progress'
                        ? 'text-indigo-600'
                        : 'text-slate-500'
                  }
                >
                  {r.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  )
}
