import { createFileRoute } from '@tanstack/react-router'
import {
  AppShell,
  DataTable,
  PageHeader,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { BACKING_TOOLS, PLATFORM_VERSION } from '@adhar-console/platform-info'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'
import { overallHealth, useBackingHealth } from '~/data/backing-health.ts'

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

const HEALTH_LABEL: Record<string, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  'partial-outage': 'Partial outage',
  outage: 'Outage',
  unknown: 'Unknown',
}

function relTime(ms?: number): string {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return `${m}m ago`
}

function StatusPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  const live = useBackingHealth()
  const overall = overallHealth(live.byId)

  // Merge live cluster health onto each backing component.
  const rows = BACKING_TOOLS.map((t) => {
    const h = live.byId[t.id]
    return {
      ...t,
      liveHealth: h?.health ?? 'unknown',
      ready: h?.ready ?? 0,
      desired: h?.desired ?? 0,
      workloadCount: h?.workloads.length ?? 0,
    }
  })

  const overallLabel = live.isLoading
    ? 'Checking components…'
    : !live.live
      ? 'Cluster unreachable'
      : overall.down > 0
        ? `${overall.down} down · ${overall.degraded} degraded`
        : overall.degraded > 0
          ? `${overall.degraded} degraded · ${overall.healthy} healthy`
          : `${overall.healthy}/${overall.total} components healthy`
  const overallKind: StatusKind = live.isLoading || !live.live ? 'unknown' : overall.kind

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
        description="Every component of the Adhar platform — with real versions, source links, and live health derived from the cluster. No black boxes."
      />

      <section className="mb-8 rounded-lg border border-edge-default bg-surface-raised p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-content-subtle">Adhar Console</div>
            <div className="mt-1 text-2xl font-semibold text-content">
              v{PLATFORM_VERSION.console}
            </div>
            <div className="mt-1 text-xs text-content-subtle">
              API v{PLATFORM_VERSION.api} · commit{' '}
              <code>{PLATFORM_VERSION.commit}</code> · built {PLATFORM_VERSION.built}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <StatusBadge kind={overallKind} pulse={overallKind === 'degraded'}>
              {live.isLoading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size={12} /> {overallLabel}
                </span>
              ) : (
                overallLabel
              )}
            </StatusBadge>
            {live.live ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-content-subtle">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                Live · updated {relTime(live.updatedAt)}
              </span>
            ) : null}
          </div>
        </div>
        {live.live && (overall.degraded > 0 || overall.down > 0) ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {rows
              .filter((r) => r.liveHealth === 'degraded' || r.liveHealth === 'outage')
              .map((r) => (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-sunken px-2 py-1 text-[11px]"
                >
                  <StatusBadge kind={HEALTH_KIND[r.liveHealth]} className="px-1 py-0 text-[10px]">
                    {r.ready}/{r.desired}
                  </StatusBadge>
                  {r.name}
                </span>
              ))}
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content-subtle">
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
                    className="font-medium text-content hover:underline"
                  >
                    {t.name}
                  </a>
                  <div className="text-xs text-content-subtle">{t.purpose}</div>
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
                  className="text-xs text-content-muted hover:underline"
                >
                  {t.sourceRepo.replace(/^https?:\/\//, '')}
                </a>
              ),
            },
            {
              key: 'health',
              header: 'Live health',
              cell: (t) => (
                <div className="flex items-center gap-2">
                  <StatusBadge
                    kind={HEALTH_KIND[t.liveHealth] ?? 'unknown'}
                    pulse={t.liveHealth === 'degraded'}
                  >
                    {HEALTH_LABEL[t.liveHealth] ?? t.liveHealth}
                  </StatusBadge>
                  {t.workloadCount > 0 ? (
                    <span className="font-mono text-[11px] tabular-nums text-content-subtle">
                      {t.ready}/{t.desired} ready
                    </span>
                  ) : live.live ? (
                    <span className="text-[11px] text-content-subtle">not detected</span>
                  ) : null}
                </div>
              ),
            },
          ]}
          rows={rows}
          rowKey={(t) => t.id}
        />
      </section>

      <p className="mt-8 text-xs text-content-subtle">
        This page is served from the console itself — no third-party status vendor. Health is derived
        live from each component&apos;s Deployments/StatefulSets/DaemonSets in the cluster and
        refreshes automatically. Your admin can scope what is shown here per tenant.
      </p>
    </AppShell>
  )
}
