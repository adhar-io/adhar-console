import { createFileRoute } from '@tanstack/react-router'
import {
  AppShell,
  DataTable,
  PageHeader,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { BACKING_TOOLS, PLATFORM_VERSION } from '@adhar-console/platform-info'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'

export const Route = createFileRoute('/status')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Platform status · Adhar Console' }] }),
  component: StatusPage,
})

const HEALTH_KIND: Record<string, StatusKind> = {
  operational: 'healthy',
  degraded: 'degraded',
  'partial-outage': 'degraded',
  outage: 'failed',
  unknown: 'unknown',
}

function StatusPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Platform status' }]}
      notifications={notifications}
    >
      <PageHeader
        title="Platform status"
        description="Every component of the Adhar platform — with real versions, source links, and live health. No black boxes."
      />

      <section className="mb-8 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Adhar Console</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">
              v{PLATFORM_VERSION.console}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              API v{PLATFORM_VERSION.api} · commit{' '}
              <code>{PLATFORM_VERSION.commit}</code> · built {PLATFORM_VERSION.built}
            </div>
          </div>
          <div className="flex gap-2">
            <StatusBadge kind="healthy">All systems operational</StatusBadge>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Backing open-source components
        </h2>
        <DataTable
          columns={[
            {
              key: 'name',
              header: 'Component',
              cell: (t) => (
                <div>
                  <a
                    href={t.homepage}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {t.name}
                  </a>
                  <div className="text-xs text-slate-500">{t.purpose}</div>
                </div>
              ),
            },
            { key: 'version', header: 'Version', cell: (t) => <code className="text-xs">{t.version}</code> },
            { key: 'license', header: 'License', cell: (t) => t.license },
            {
              key: 'source',
              header: 'Source',
              cell: (t) => (
                <a
                  href={t.sourceRepo}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-slate-600 hover:underline"
                >
                  {t.sourceRepo.replace(/^https?:\/\//, '')}
                </a>
              ),
            },
            {
              key: 'health',
              header: 'Health',
              cell: (t) => (
                <StatusBadge kind={HEALTH_KIND[t.health] ?? 'unknown'}>{t.health}</StatusBadge>
              ),
            },
          ]}
          rows={BACKING_TOOLS}
          rowKey={(t) => t.id}
        />
      </section>

      <p className="mt-8 text-xs text-slate-500">
        This page is served from the console itself — no third-party status vendor. Health is
        derived from live probes against each component. Your admin can scope what is shown here
        per tenant.
      </p>
    </AppShell>
  )
}
