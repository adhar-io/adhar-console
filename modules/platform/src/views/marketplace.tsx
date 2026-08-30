import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AirbyteIcon,
  ArgoCDIcon,
  ArgoRolloutsIcon,
  ArgoWorkflowsIcon,
  Button,
  CrossplaneIcon,
  EmptyState,
  GiteaIcon,
  GrafanaIcon,
  HarborIcon,
  IcebergIcon,
  KargoIcon,
  KeycloakIcon,
  KubernetesIcon,
  KyvernoIcon,
  LokiIcon,
  MetabaseIcon,
  MinIOIcon,
  OTelIcon,
  PlaneIcon,
  PrometheusIcon,
  Spinner,
  StatusBadge,
  TempoIcon,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  APPSET_NAMESPACE,
  SOURCE_LABEL,
  appCategoryLabel,
  chartByIdMap,
  hasFullTrust,
  useMarketplaceApps,
  useToggleApp,
  type ArgoHealth,
  type ChartSource,
  type MarketplaceApp,
  type MarketplaceChart,
} from '../data/marketplace.ts'
import { age } from '../data/format.ts'
import { ListShell, StatusFilterPills, matchesSearch } from './list-shell.tsx'

/**
 * Adhar Marketplace — the list, categories and enabled state all come from the
 * real `helm-charts-*` ApplicationSet(s) read live from the cluster; the live
 * ArgoCD Application supplies health/sync. Enabling/disabling an app is a
 * GitOps change (a commit to the ApplicationSet YAML in Gitea via the BFF),
 * reconciled by ArgoCD. The curated catalogue only enriches matched apps.
 */
export function MarketplaceView() {
  const { apps, appsetNames, isLoading, isFetching, isError, error, argoNotInstalled, dataUpdatedAt, refetch } =
    useMarketplaceApps()

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'enabled' | 'disabled' | 'all'>('all')
  const [category, setCategory] = useState<string>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const categoryCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const a of apps) m[a.category] = (m[a.category] ?? 0) + 1
    return m
  }, [apps])

  const enabledCount = useMemo(() => apps.filter((a) => a.enabled).length, [apps])

  const visible = useMemo(
    () =>
      apps
        .filter((a) => (status === 'all' ? true : status === 'enabled' ? a.enabled : !a.enabled))
        .filter((a) => category === 'all' || a.category === category)
        .filter((a) => {
          if (!search) return true
          return (
            matchesSearch(a.name, search) ||
            matchesSearch(a.category, search) ||
            matchesSearch(a.appset, search) ||
            matchesSearch(a.chart?.title, search) ||
            matchesSearch(a.chart?.description, search) ||
            (a.chart?.tags ?? []).some((t) => matchesSearch(t, search))
          )
        }),
    [apps, status, category, search],
  )

  const grouped = useMemo(() => {
    const m = new Map<string, MarketplaceApp[]>()
    for (const a of visible) {
      const list = m.get(a.category)
      if (list) list.push(a)
      else m.set(a.category, [a])
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [visible])

  const selected = selectedId ? apps.find((a) => a.id === selectedId) ?? null : null

  // Honest empty/error states — never fabricate a catalogue.
  if (argoNotInstalled) {
    return (
      <EmptyState
        title="ArgoCD ApplicationSets not installed"
        description={
          <>
            The <code className="font-mono">applicationsets.argoproj.io</code> API isn't registered on
            this cluster. Install ArgoCD and the Adhar platform stack to populate the marketplace.
          </>
        }
      />
    )
  }
  if (isError) {
    return (
      <EmptyState
        title="Couldn't load the marketplace"
        description={error?.message ?? 'The ApplicationSet list is unavailable right now.'}
      />
    )
  }
  if (!isLoading && apps.length === 0) {
    return (
      <EmptyState
        title="No Adhar ApplicationSet found"
        description={
          <>
            No <code className="font-mono">helm-charts-*</code> ApplicationSet is present in{' '}
            <code className="font-mono">{APPSET_NAMESPACE}</code>
            {appsetNames.length ? (
              <> (found: {appsetNames.map((n) => <code key={n} className="font-mono">{n}</code>)})</>
            ) : null}
            . Enable the Adhar platform stack (the <code className="font-mono">AdharPlatform</code>{' '}
            controller applies it) to drive the marketplace.
          </>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <ListShell
        title="Marketplace"
        total={apps.length}
        visible={visible.length}
        loading={isLoading}
        isFetching={isFetching}
        lastUpdatedAt={dataUpdatedAt}
        onRefresh={refetch}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search apps, categories, tags…"
        caption={`${enabledCount} enabled · GitOps via ${appsetNames.join(', ') || 'ApplicationSet'}`}
        filters={
          <div className="flex flex-col gap-1.5">
            <StatusFilterPills<'enabled' | 'disabled'>
              value={status}
              onChange={setStatus}
              pills={[
                { value: 'enabled', label: 'Enabled', count: enabledCount, tone: 'emerald' },
                { value: 'disabled', label: 'Disabled', count: apps.length - enabledCount, tone: 'slate' },
              ]}
            />
            <CategoryFilter value={category} onChange={setCategory} counts={categoryCounts} total={apps.length} />
          </div>
        }
      >
        {visible.length === 0 ? (
          <EmptyState
            title="No matching apps"
            description={
              search
                ? `Nothing matches "${search}". Try fewer keywords or another category.`
                : 'Adjust the status or category filter to see more apps.'
            }
          />
        ) : (
          <div className="space-y-5">
            {grouped.map(([cat, items]) => (
              <section key={cat} className="space-y-2">
                <header className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-content-subtle">
                    {appCategoryLabel(cat)}
                  </h3>
                  <span className="font-mono text-[11px] tabular-nums text-content-subtle">
                    {items.filter((a) => a.enabled).length}/{items.length} enabled
                  </span>
                </header>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {items.map((a) => (
                    <AppCard key={a.id} app={a} onClick={() => setSelectedId(a.id)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </ListShell>

      {selected ? <AppDrawer app={selected} onClose={() => setSelectedId(null)} /> : null}
    </div>
  )
}

/* ─────────────────────────── category filter ─────────────────────────── */

function CategoryFilter({
  value,
  onChange,
  counts,
  total,
}: {
  value: string
  onChange(v: string): void
  counts: Record<string, number>
  total: number
}) {
  const cats = Object.keys(counts).sort()
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-0.5">
      <FilterButton on={value === 'all'} label="All" count={total} onClick={() => onChange('all')} />
      {cats.map((c) => (
        <FilterButton
          key={c}
          on={value === c}
          label={appCategoryLabel(c)}
          count={counts[c]}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}

function FilterButton({
  on,
  label,
  count,
  onClick,
}: {
  on: boolean
  label: string
  count: number
  onClick(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
        on
          ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200 dark:ring-brand-500/25'
          : 'text-content-muted hover:bg-surface-sunken hover:text-content',
      )}
    >
      <span>{label}</span>
      <span className="font-mono tabular-nums opacity-70">{count}</span>
    </button>
  )
}

/* ─────────────────────────── app card ─────────────────────────── */

function AppCard({ app, onClick }: { app: MarketplaceApp; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex h-full flex-col rounded-xl border bg-surface-raised p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
        app.enabled
          ? 'border-emerald-200 dark:border-emerald-500/25 hover:border-emerald-300'
          : 'border-edge-default hover:border-brand-300',
      )}
    >
      <div className="flex items-start gap-3">
        <AppIcon app={app} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[13px] font-semibold text-content">
              {app.chart?.title ?? app.name}
            </div>
            {app.chart?.verified ? <VerifiedDot /> : null}
          </div>
          <code className="truncate text-[11px] text-content-muted">{app.name}</code>
        </div>
        <EnabledPill enabled={app.enabled} />
      </div>

      {app.chart?.description ? (
        <p className="mt-3 line-clamp-2 flex-1 text-[12px] leading-relaxed text-content-muted">
          {app.chart.description}
        </p>
      ) : (
        <p className="mt-3 line-clamp-2 flex-1 font-mono text-[11px] leading-relaxed text-content-subtle">
          {app.manifestPath ?? app.namespace ?? '—'}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-edge-subtle pt-3">
        <div className="flex items-center gap-1.5">
          {app.live ? <HealthBadge health={app.live.health} /> : (
            <span className="text-[10px] text-content-subtle">not deployed</span>
          )}
          {app.plane ? <PlaneChip plane={app.plane} /> : null}
        </div>
        <span className="truncate font-mono text-[10px] text-content-subtle">{app.namespace ?? ''}</span>
      </div>
    </button>
  )
}

function EnabledPill({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-200 dark:ring-emerald-500/25">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Enabled
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold text-content-subtle ring-1 ring-edge-subtle">
      Disabled
    </span>
  )
}

function PlaneChip({ plane }: { plane: string }) {
  return (
    <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
      {plane}
    </span>
  )
}

/* ─────────────────────────── detail drawer ─────────────────────────── */

function AppDrawer({ app, onClose }: { app: MarketplaceApp; onClose(): void }) {
  const toggle = useToggleApp()
  const chart = app.chart

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !toggle.isPending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, toggle.isPending])

  const result = toggle.data
  const err = toggle.error as Error | undefined

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={() => !toggle.isPending && onClose()}
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <AppIcon app={app} size={52} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-xl font-semibold text-content">
                    {chart?.title ?? app.name}
                  </h2>
                  <EnabledPill enabled={app.enabled} />
                  {chart ? <SourceChip source={chart.source} /> : null}
                </div>
                <div className="mt-0.5 text-[12px] text-content-muted">
                  <code className="font-mono">{app.name}</code> ·{' '}
                  {appCategoryLabel(app.category)}
                  {chart?.publisher?.name ? <> · by {chart.publisher.name}</> : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-content-subtle">
                  {app.live ? <HealthBadge health={app.live.health} /> : null}
                  {app.live ? <SyncBadge sync={app.live.sync} /> : null}
                  {app.plane ? <PlaneChip plane={app.plane} /> : null}
                </div>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => !toggle.isPending && onClose()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* ── GitOps toggle ── */}
          <section className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-content">
                  {app.enabled ? 'Enabled' : 'Disabled'} via GitOps
                </h3>
                <p className="mt-0.5 text-[12px] leading-relaxed text-content-muted">
                  {app.enabled ? 'Disabling' : 'Enabling'} commits{' '}
                  <code className="font-mono">enabled: &quot;{app.enabled ? 'false' : 'true'}&quot;</code> to the{' '}
                  <code className="font-mono">{app.appset}</code> ApplicationSet in Gitea. ArgoCD then
                  reconciles the change — exactly like editing the file directly.
                </p>
              </div>
              <Button
                variant={app.enabled ? 'secondary' : 'primary'}
                size="sm"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ app, enabled: !app.enabled })}
              >
                {toggle.isPending ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner size={12} /> Committing…
                  </span>
                ) : app.enabled ? (
                  'Disable'
                ) : (
                  'Enable'
                )}
              </Button>
            </div>

            {toggle.isPending ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-brand-50 dark:bg-brand-500/10 px-3 py-2 text-[12px] text-brand-800 dark:text-brand-300">
                <Spinner size={12} /> Syncing via GitOps — committing to Gitea; ArgoCD will reconcile shortly.
              </div>
            ) : null}
            {result?.ok && !toggle.isPending ? (
              <div className="mt-3 rounded-lg border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/70 dark:bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-800 dark:text-emerald-300">
                {result.note ?? 'Change committed. ArgoCD will reconcile shortly.'}
                {result.commitUrl ? (
                  <>
                    {' '}
                    <a href={result.commitUrl} target="_blank" rel="noreferrer" className="underline">
                      view commit ↗
                    </a>
                  </>
                ) : null}
              </div>
            ) : null}
            {err ? (
              <div className="mt-3 rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-3 py-2 text-[12px] text-rose-800 dark:text-rose-300">
                <div className="font-semibold">Toggle failed</div>
                <div className="mt-0.5 wrap-break-word font-mono text-[11px]">{err.message}</div>
              </div>
            ) : null}
          </section>

          {/* ── GitOps source ── */}
          <DetailCard title="GitOps source">
            <KV label="ApplicationSet" value={<code className="font-mono">{app.appset}</code>} />
            <KV label="Category" value={appCategoryLabel(app.category)} />
            {app.namespace ? <KV label="Namespace" value={<code className="font-mono">{app.namespace}</code>} /> : null}
            {app.plane ? <KV label="Plane" value={<code className="font-mono">{app.plane}</code>} /> : null}
            {app.manifestPath ? (
              <KV label="Manifest path" value={<code className="font-mono break-all">{app.manifestPath}</code>} />
            ) : null}
          </DetailCard>

          {/* ── live ArgoCD status ── */}
          <DetailCard title="Live status">
            {app.live ? (
              <>
                <KV label="Health" value={<HealthBadge health={app.live.health} />} />
                <KV label="Sync" value={<SyncBadge sync={app.live.sync} />} />
                {app.live.operationPhase ? (
                  <KV label="Operation" value={<code className="font-mono">{app.live.operationPhase}</code>} />
                ) : null}
                {app.live.repoURL ? (
                  <KV label="Repo" value={<code className="font-mono break-all">{app.live.repoURL}</code>} />
                ) : null}
                {app.live.createdAt ? <KV label="Created" value={age(app.live.createdAt)} /> : null}
                {app.live.message ? (
                  <p className="mt-2 border-t border-edge-subtle pt-2 text-[12px] text-content-muted">
                    {app.live.message}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-[12px] text-content-muted">
                {app.enabled
                  ? 'No ArgoCD Application reporting yet — it appears once ArgoCD generates and syncs it.'
                  : 'Not deployed — this app is disabled in the ApplicationSet, so ArgoCD has not generated an Application for it.'}
              </p>
            )}
          </DetailCard>

          {/* ── curated enrichment (optional) ── */}
          {chart ? (
            <>
              {chart.longDescription || chart.description ? (
                <section>
                  <p className="text-sm leading-relaxed text-content">
                    {chart.longDescription ?? chart.description}
                  </p>
                  {chart.tags.length ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {chart.tags.map((t) => (
                        <span key={t} className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                          #{t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
              <ProvenanceCard chart={chart} />
              <CompatibilityCard chart={chart} />
              {chart.docsUrl ? (
                <DetailCard title="Docs">
                  <a href={chart.docsUrl} target="_blank" rel="noreferrer" className="text-brand-700 dark:text-brand-300 hover:underline break-all">
                    {chart.docsUrl}
                  </a>
                </DetailCard>
              ) : null}
            </>
          ) : (
            <p className="text-[12px] text-content-subtle">
              No curated catalogue entry matched <code className="font-mono">{app.name}</code> — showing
              the ApplicationSet + live cluster data only.
            </p>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ─────────────────────────── status badges ─────────────────────────── */

const HEALTH_KIND: Record<ArgoHealth, StatusKind> = {
  Healthy: 'healthy',
  Progressing: 'progressing',
  Degraded: 'failed',
  Suspended: 'paused',
  Missing: 'unknown',
  Unknown: 'unknown',
  '': 'unknown',
}

function HealthBadge({ health }: { health: ArgoHealth }) {
  return <StatusBadge kind={HEALTH_KIND[health] ?? 'unknown'}>{health || 'Unknown'}</StatusBadge>
}

function SyncBadge({ sync }: { sync: string }) {
  const kind: StatusKind = sync === 'Synced' ? 'healthy' : sync === 'OutOfSync' ? 'degraded' : 'unknown'
  return <StatusBadge kind={kind}>{sync || 'Unknown'}</StatusBadge>
}

/* ─────────────────────────── icons + enrichment atoms ─────────────────────────── */

const ICON_BY_ID: Record<string, (props: { size?: number }) => ReactNode> = {
  argocd: ArgoCDIcon,
  argoworkflows: ArgoWorkflowsIcon,
  argorollouts: ArgoRolloutsIcon,
  kargo: KargoIcon,
  kyverno: KyvernoIcon,
  keycloak: KeycloakIcon,
  harbor: HarborIcon,
  crossplane: CrossplaneIcon,
  plane: PlaneIcon,
  grafana: GrafanaIcon,
  prometheus: PrometheusIcon,
  loki: LokiIcon,
  tempo: TempoIcon,
  minio: MinIOIcon,
  airbyte: AirbyteIcon,
  metabase: MetabaseIcon,
  iceberg: IcebergIcon,
  kubernetes: KubernetesIcon,
  otel: OTelIcon,
  gitea: GiteaIcon,
}

const TONES = [
  'bg-linear-to-br from-sky-100 dark:from-sky-500/15 to-sky-50 dark:to-sky-500/10 text-sky-700 dark:text-sky-300',
  'bg-linear-to-br from-emerald-100 dark:from-emerald-500/15 to-emerald-50 dark:to-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  'bg-linear-to-br from-amber-100 dark:from-amber-500/15 to-amber-50 dark:to-amber-500/10 text-amber-700 dark:text-amber-300',
  'bg-linear-to-br from-violet-100 dark:from-violet-500/15 to-violet-50 dark:to-violet-500/10 text-violet-700 dark:text-violet-300',
  'bg-linear-to-br from-rose-100 dark:from-rose-500/15 to-rose-50 dark:to-rose-500/10 text-rose-700 dark:text-rose-300',
  'bg-linear-to-br from-fuchsia-100 dark:from-fuchsia-500/15 to-fuchsia-50 dark:to-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300',
  'bg-linear-to-br from-brand-100 dark:from-brand-500/15 to-brand-50 dark:to-brand-500/10 text-brand-700 dark:text-brand-300',
]

function toneFor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return TONES[h % TONES.length]
}

function AppIcon({ app, size = 40 }: { app: MarketplaceApp; size?: number }) {
  const Component = app.chart?.iconId ? ICON_BY_ID[app.chart.iconId] : undefined
  if (Component) {
    return (
      <span
        className="relative flex shrink-0 items-center justify-center rounded-xl bg-surface-raised shadow-sm ring-1 ring-edge-subtle"
        style={{ width: size + 8, height: size + 8 }}
      >
        <Component size={size} />
        {app.chart && hasFullTrust(app.chart) ? <TrustShield /> : null}
      </span>
    )
  }
  const initials = (app.chart?.title ?? app.name)
    .split(/[-_\s.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase()
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl font-semibold shadow-sm ring-1 ring-edge-subtle',
        toneFor(app.category || app.name),
      )}
      style={{ width: size + 8, height: size + 8, fontSize: Math.max(12, size * 0.4) }}
    >
      {initials || app.name[0]?.toUpperCase() || '?'}
    </span>
  )
}

function TrustShield() {
  return (
    <span
      title="Signed and vulnerability-scanned"
      className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm ring-2 ring-surface-raised"
    >
      <IconShield size={9} />
    </span>
  )
}

const SOURCE_CHIP: Record<ChartSource, string> = {
  core: 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 ring-brand-200 dark:ring-brand-500/25',
  partner: 'bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-500/25',
  community: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/25',
}

function SourceChip({ source }: { source: ChartSource }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1',
        SOURCE_CHIP[source],
      )}
    >
      {SOURCE_LABEL[source]}
    </span>
  )
}

type PillTone = 'emerald' | 'amber' | 'rose' | 'sky' | 'brand' | 'slate'

const PILL_TONE: Record<PillTone, string> = {
  emerald: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-500/25',
  amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/25',
  rose: 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/25',
  sky: 'bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-500/25',
  brand: 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 ring-brand-200 dark:ring-brand-500/25',
  slate: 'bg-surface-sunken text-content-muted ring-edge-subtle',
}

function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1', PILL_TONE[tone])}>
      {children}
    </span>
  )
}

function VerifiedDot() {
  return (
    <span title="Verified publisher" className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{title}</h3>
      <div>{children}</div>
    </section>
  )
}

function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm first:pt-0 last:pb-0">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-content-subtle">{label}</span>
      <span className="min-w-0 text-right text-[13px] text-content">{value}</span>
    </div>
  )
}

const GRADE_TONE: Record<'A' | 'B' | 'C' | 'D' | 'F', PillTone> = {
  A: 'emerald',
  B: 'emerald',
  C: 'amber',
  D: 'amber',
  F: 'rose',
}

function CautionNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
      <span className="mt-0.5 shrink-0">
        <IconWarn />
      </span>
      <span>{children}</span>
    </div>
  )
}

function CveCount({ count, kind }: { count?: number; kind: 'critical' | 'high' }) {
  if (count === undefined) return <span className="text-content-subtle">unknown</span>
  const cls =
    count === 0
      ? 'text-emerald-700 dark:text-emerald-300'
      : kind === 'critical'
        ? 'text-rose-700 dark:text-rose-300'
        : 'text-amber-700 dark:text-amber-300'
  return <span className={cn('font-mono font-semibold tabular-nums', cls)}>{count}</span>
}

function ProvenanceCard({ chart }: { chart: MarketplaceChart }) {
  const p = chart.provenance
  const caution = !p.signed || !p.scanned
  return (
    <DetailCard title="Provenance">
      <div className="flex flex-wrap gap-1.5">
        {p.signed ? (
          <Pill tone="emerald">
            <IconShield size={11} /> Signed · {p.signature ?? 'unknown'}
          </Pill>
        ) : (
          <Pill tone="amber">
            <IconWarn size={11} /> Unsigned
          </Pill>
        )}
        {p.scanned ? (
          <Pill tone={p.grade ? GRADE_TONE[p.grade] : 'sky'}>Scan grade {p.grade ?? '—'}</Pill>
        ) : (
          <Pill tone="amber">
            <IconWarn size={11} /> Not scanned
          </Pill>
        )}
        {p.scanned ? (p.sbom ? <Pill tone="sky">SBOM attached</Pill> : <Pill tone="slate">No SBOM</Pill>) : null}
        {chart.publisher.verifiedPublisher ? (
          <Pill tone="sky">
            <VerifiedDot /> Verified publisher
          </Pill>
        ) : null}
      </div>
      {p.signed || p.scanned ? (
        <div className="mt-3 border-t border-edge-subtle pt-2">
          {p.signed ? (
            <>
              <KV label="Signature" value={<code className="font-mono">{p.signature ?? 'unknown'}</code>} />
              {p.signer ? <KV label="Signer" value={p.signer} /> : null}
            </>
          ) : null}
          {p.scanned ? (
            <>
              <KV label="Scanner" value={<code className="font-mono">{p.scanner ?? 'unknown'}</code>} />
              <KV label="Critical CVEs" value={<CveCount count={p.criticalCves} kind="critical" />} />
              <KV label="High CVEs" value={<CveCount count={p.highCves} kind="high" />} />
              {p.scannedAt ? <KV label="Last scanned" value={<span title={p.scannedAt}>{age(p.scannedAt)} ago</span>} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
      {caution ? (
        <div className="mt-3">
          <CautionNote>
            {!p.signed && !p.scanned
              ? 'This package is neither signed nor vulnerability-scanned. Its integrity and CVE exposure are unknown.'
              : !p.signed
                ? 'This package is not signed — its integrity cannot be verified against the publisher.'
                : 'This package has not been vulnerability-scanned — its CVE exposure is unknown.'}
          </CautionNote>
        </div>
      ) : null}
    </DetailCard>
  )
}

function ChipList({ items, mono }: { items: string[]; mono?: boolean }) {
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {items.map((it) => (
        <span key={it} className={cn('rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted', mono && 'font-mono')}>
          {it}
        </span>
      ))}
    </span>
  )
}

function CompatibilityCard({ chart }: { chart: MarketplaceChart }) {
  const c = chart.compatibility
  const byId = useMemo(() => chartByIdMap(), [])
  const kubeRange =
    c.minKubeVersion && c.maxKubeVersion
      ? `${c.minKubeVersion} – ${c.maxKubeVersion}`
      : c.minKubeVersion
        ? `≥ ${c.minKubeVersion}`
        : c.maxKubeVersion
          ? `≤ ${c.maxKubeVersion}`
          : null
  const empty =
    !kubeRange &&
    !c.requiredCrds?.length &&
    !c.requiredCapabilities?.length &&
    !c.dependsOn?.length &&
    !c.testedOn?.length
  return (
    <DetailCard title="Compatibility">
      {empty ? (
        <CautionNote>
          The publisher has not declared a compatibility contract. Verify cluster requirements manually.
        </CautionNote>
      ) : (
        <>
          <KV
            label="Kubernetes"
            value={kubeRange ? <code className="font-mono">{kubeRange}</code> : <span className="text-content-subtle">not declared</span>}
          />
          {c.requiredCrds?.length ? <KV label="Required CRDs" value={<ChipList items={c.requiredCrds} mono />} /> : null}
          {c.requiredCapabilities?.length ? <KV label="Capabilities" value={<ChipList items={c.requiredCapabilities} mono />} /> : null}
          {c.dependsOn?.length ? (
            <KV label="Depends on" value={<ChipList items={c.dependsOn.map((id) => byId.get(id)?.title ?? byId.get(id)?.name ?? id)} />} />
          ) : null}
          {c.testedOn?.length ? (
            <KV
              label="Tested on"
              value={
                <span className="flex flex-wrap justify-end gap-1">
                  {c.testedOn.map((v) => (
                    <Pill key={v} tone="brand">
                      {v}
                    </Pill>
                  ))}
                </span>
              }
            />
          ) : null}
        </>
      )}
    </DetailCard>
  )
}

/* ─────────────────────────── icons ─────────────────────────── */

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function IconShield({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function IconWarn({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}
