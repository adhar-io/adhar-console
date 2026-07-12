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
  Tabs,
  TempoIcon,
  type StatusKind,
  type TabDef,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  CATEGORY_LABEL,
  chartByIdMap,
  suggestReleaseName,
  useCatalog,
  useInstallChart,
  useReleases,
  useRepositories,
  useUninstallChart,
  useUpgradeChart,
  type ChartCategory,
  type HelmRelease,
  type MarketplaceChart,
} from '../data/marketplace.ts'
import { useNamespaces } from '../data/hooks.ts'
import { age } from '../data/format.ts'
import { ListShell, matchesSearch } from './list-shell.tsx'

type Sub = 'catalog' | 'installed' | 'repositories'

const CATEGORIES: { value: ChartCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  ...(Object.entries(CATEGORY_LABEL) as Array<[ChartCategory, string]>).map(([value, label]) => ({
    value,
    label,
  })),
]

export function MarketplaceView() {
  const releases = useReleases()
  const installedCount = (releases.data ?? []).length
  const tabs: readonly TabDef<Sub>[] = useMemo(
    () => [
      { id: 'catalog', label: 'Catalog' },
      { id: 'installed', label: `Installed${installedCount ? ` (${installedCount})` : ''}` },
      { id: 'repositories', label: 'Repositories' },
    ],
    [installedCount],
  )

  return (
    <Tabs<Sub> tabs={tabs} defaultValue="catalog" ariaLabel="Marketplace section">
      {(active) => (
        <>
          {active === 'catalog' && <CatalogPanel />}
          {active === 'installed' && <InstalledPanel />}
          {active === 'repositories' && <RepositoriesPanel />}
        </>
      )}
    </Tabs>
  )
}

/* ─────────────────────────── Catalog ─────────────────────────── */

function CatalogPanel() {
  const catalog = useCatalog()
  const releases = useReleases()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<ChartCategory | 'all'>('all')
  const [selected, setSelected] = useState<MarketplaceChart | null>(null)

  const all = catalog.data ?? []
  const featured = all.filter((c) => c.featured)
  const categoryCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const c of all) m[c.category] = (m[c.category] ?? 0) + 1
    return m
  }, [all])

  const visible = useMemo(() => {
    return all
      .filter((c) => category === 'all' || c.category === category)
      .filter((c) => {
        if (!search) return true
        return (
          matchesSearch(c.name, search) ||
          matchesSearch(c.title, search) ||
          matchesSearch(c.description, search) ||
          matchesSearch(c.publisher, search) ||
          c.tags.some((t) => matchesSearch(t, search))
        )
      })
  }, [all, category, search])

  const installedByChart = useMemo(() => {
    const m = new Map<string, HelmRelease[]>()
    for (const r of releases.data ?? []) {
      if (!m.has(r.chartId)) m.set(r.chartId, [])
      m.get(r.chartId)!.push(r)
    }
    return m
  }, [releases.data])

  return (
    <div className="space-y-5">
      {featured.length && !search && category === 'all' ? (
        <FeaturedStrip charts={featured.slice(0, 4)} onPick={setSelected} />
      ) : null}

      <ListShell
        title="Catalog"
        total={all.length}
        visible={visible.length}
        loading={catalog.isLoading}
        isFetching={catalog.isFetching}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search charts, publishers, tags…"
        caption={`${Object.keys(categoryCounts).length} categories`}
        filters={
          <CategoryFilter
            value={category}
            onChange={setCategory}
            counts={categoryCounts}
            total={all.length}
          />
        }
      >
        {visible.length === 0 ? (
          <EmptyState
            title="No matching charts"
            description={
              search
                ? `Nothing matches "${search}". Try fewer keywords or another category.`
                : 'Pick another category to see more charts.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((c) => (
              <ChartCard
                key={c.id}
                chart={c}
                installedCount={installedByChart.get(c.id)?.length ?? 0}
                onClick={() => setSelected(c)}
              />
            ))}
          </div>
        )}
      </ListShell>

      {selected ? (
        <ChartDetail
          chart={selected}
          installed={installedByChart.get(selected.id) ?? []}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}

function FeaturedStrip({
  charts,
  onPick,
}: {
  charts: MarketplaceChart[]
  onPick(c: MarketplaceChart): void
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-edge-default bg-linear-to-br from-brand-50/70 via-white to-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-600/90 text-white shadow-sm">
              <IconStar />
            </span>
            <h3 className="text-sm font-semibold text-content">Staff picks</h3>
          </div>
          <div className="mt-0.5 text-[11px] text-content-muted">
            Production-ready, verified Helm charts maintained by Adhar.
          </div>
        </div>
        <span className="text-[11px] font-medium text-content-subtle">
          {charts.length} featured
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {charts.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c)}
            className="group flex items-center gap-3 rounded-xl border border-edge-default bg-white p-3 text-left transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
          >
            <ChartIcon chart={c} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="truncate text-[13px] font-semibold text-content">
                  {c.title ?? c.name}
                </div>
                {c.verified ? <VerifiedDot /> : null}
              </div>
              <div className="truncate text-[11px] text-content-muted">{c.publisher}</div>
              <div className="mt-1 line-clamp-1 text-[11px] text-content-subtle">
                {c.description}
              </div>
            </div>
            <span className="text-content-subtle group-hover:text-brand-700">
              <IconArrow />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function CategoryFilter({
  value,
  onChange,
  counts,
  total,
}: {
  value: ChartCategory | 'all'
  onChange(v: ChartCategory | 'all'): void
  counts: Record<string, number>
  total: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-0.5">
      {CATEGORIES.map((c) => {
        const on = value === c.value
        const n = c.value === 'all' ? total : counts[c.value] ?? 0
        if (c.value !== 'all' && n === 0) return null
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(c.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              on
                ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200'
                : 'text-content-muted hover:bg-surface-sunken hover:text-content',
            )}
          >
            <span>{c.label}</span>
            <span className="font-mono tabular-nums opacity-70">{n}</span>
          </button>
        )
      })}
    </div>
  )
}

function ChartCard({
  chart,
  installedCount,
  onClick,
}: {
  chart: MarketplaceChart
  installedCount: number
  onClick(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex h-full flex-col rounded-xl border border-edge-default bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <ChartIcon chart={chart} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[13px] font-semibold text-content">
              {chart.title ?? chart.name}
            </div>
            {chart.verified ? <VerifiedDot /> : null}
          </div>
          <div className="truncate text-[11px] text-content-muted">{chart.publisher}</div>
        </div>
        {installedCount > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {installedCount}
          </span>
        ) : null}
      </div>
      <p className="mt-3 line-clamp-3 flex-1 text-[12px] leading-relaxed text-content-muted">
        {chart.description}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-edge-subtle pt-3">
        <CategoryChip category={chart.category} tone={chart.tone} />
        <div className="flex items-center gap-2 text-[10px] text-content-subtle">
          <code className="font-mono tabular-nums">v{chart.version}</code>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-0.5">
            <IconStar />
            {formatPopularity(chart.popularity)}
          </span>
        </div>
      </div>
    </button>
  )
}

function CategoryChip({
  category,
  tone,
}: {
  category: ChartCategory
  tone: MarketplaceChart['tone']
}) {
  const cls = TONE_CHIP[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        cls,
      )}
    >
      {CATEGORY_LABEL[category]}
    </span>
  )
}

const TONE_CHIP: Record<MarketplaceChart['tone'], string> = {
  sky: 'bg-sky-50 text-sky-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  violet: 'bg-violet-50 text-violet-700',
  rose: 'bg-rose-50 text-rose-700',
  fuchsia: 'bg-fuchsia-50 text-fuchsia-700',
  brand: 'bg-brand-50 text-brand-700',
  slate: 'bg-slate-100 text-slate-700',
}

const TONE_TILE: Record<MarketplaceChart['tone'], string> = {
  sky: 'bg-linear-to-br from-sky-100 to-sky-50 text-sky-700',
  emerald: 'bg-linear-to-br from-emerald-100 to-emerald-50 text-emerald-700',
  amber: 'bg-linear-to-br from-amber-100 to-amber-50 text-amber-700',
  violet: 'bg-linear-to-br from-violet-100 to-violet-50 text-violet-700',
  rose: 'bg-linear-to-br from-rose-100 to-rose-50 text-rose-700',
  fuchsia: 'bg-linear-to-br from-fuchsia-100 to-fuchsia-50 text-fuchsia-700',
  brand: 'bg-linear-to-br from-brand-100 to-brand-50 text-brand-700',
  slate: 'bg-linear-to-br from-slate-200 to-slate-100 text-slate-700',
}

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

export function ChartIcon({ chart, size = 40 }: { chart: MarketplaceChart; size?: number }) {
  const Component = chart.iconId ? ICON_BY_ID[chart.iconId] : undefined
  if (Component) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-edge-subtle"
        style={{ width: size + 8, height: size + 8 }}
      >
        <Component size={size} />
      </span>
    )
  }
  const initials = (chart.title ?? chart.name)
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
        TONE_TILE[chart.tone],
      )}
      style={{ width: size + 8, height: size + 8, fontSize: Math.max(12, size * 0.4) }}
    >
      {initials || chart.name[0].toUpperCase()}
    </span>
  )
}

function VerifiedDot() {
  return (
    <span
      title="Verified publisher"
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}

function formatPopularity(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

/* ─────────────────────────── Detail drawer ─────────────────────────── */

function ChartDetail({
  chart,
  installed,
  onClose,
}: {
  chart: MarketplaceChart
  installed: HelmRelease[]
  onClose(): void
}) {
  const [showInstall, setShowInstall] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showInstall) setShowInstall(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showInstall, onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-white px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <ChartIcon chart={chart} size={56} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-xl font-semibold text-content">
                    {chart.title ?? chart.name}
                  </h2>
                  {chart.verified ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-sky-200">
                      <VerifiedDot /> Verified
                    </span>
                  ) : null}
                  {installed.length > 0 ? (
                    <StatusBadge kind="healthy">{installed.length} installed</StatusBadge>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[12px] text-content-muted">
                  by{' '}
                  <span className="font-medium text-content">{chart.publisher}</span> · published in{' '}
                  <code className="font-mono">{chart.repository}</code>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-content-subtle">
                  <span>
                    chart <code className="font-mono text-content">v{chart.version}</code>
                  </span>
                  <span>
                    app <code className="font-mono text-content">{chart.appVersion}</code>
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <IconStar />
                    {formatPopularity(chart.popularity)}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => setShowInstall(true)}>
                <IconDownload /> Install
              </Button>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
              >
                <IconClose />
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <section>
            <p className="text-sm leading-relaxed text-content">
              {chart.longDescription ?? chart.description}
            </p>
            {chart.tags.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {chart.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          <DetailCard title="Repository">
            <KV label="Name" value={<code className="font-mono">{chart.repository}</code>} />
            <KV label="URL" value={<code className="font-mono break-all">{chart.repoUrl}</code>} />
            <KV label="Default namespace" value={<code className="font-mono">{chart.defaultNamespace}</code>} />
            {chart.docsUrl ? (
              <KV
                label="Docs"
                value={
                  <a
                    href={chart.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand-700 hover:underline"
                  >
                    {chart.docsUrl}
                  </a>
                }
              />
            ) : null}
          </DetailCard>

          {installed.length ? (
            <DetailCard title="Installed releases">
              <ul className="divide-y divide-edge-subtle">
                {installed.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <ReleaseStatusBadge status={r.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-content">
                        {r.releaseName}
                      </div>
                      <code className="text-[11px] text-content-muted">
                        {r.namespace} · v{r.version} · revision {r.revision}
                      </code>
                    </div>
                    <span className="text-[11px] text-content-subtle">{age(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </DetailCard>
          ) : null}

          <DetailCard title="Helm CLI">
            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
              <code>
                {[
                  `helm repo add ${chart.repository} ${chart.repoUrl}`,
                  `helm repo update ${chart.repository}`,
                  `helm install ${chart.name} ${chart.repository}/${chart.name} \\`,
                  `  --namespace ${chart.defaultNamespace} --create-namespace \\`,
                  `  --version ${chart.version}`,
                ].join('\n')}
              </code>
            </pre>
          </DetailCard>
        </div>

        {showInstall ? (
          <InstallDialog chart={chart} onClose={() => setShowInstall(false)} />
        ) : null}
      </aside>
    </div>,
    document.body,
  )
}

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-edge-default bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {title}
      </h3>
      <div>{children}</div>
    </section>
  )
}

function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm first:pt-0 last:pb-0">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-content-subtle">
        {label}
      </span>
      <span className="min-w-0 text-right text-[13px] text-content">{value}</span>
    </div>
  )
}

/* ─────────────────────────── Install dialog ─────────────────────────── */

function InstallDialog({
  chart,
  onClose,
  initialRelease,
  initialNamespace,
  initialValues,
  mode = 'install',
  releaseId,
}: {
  chart: MarketplaceChart
  onClose(): void
  initialRelease?: string
  initialNamespace?: string
  initialValues?: Record<string, unknown>
  mode?: 'install' | 'upgrade'
  releaseId?: string
}) {
  const releases = useReleases()
  const namespaces = useNamespaces()
  const install = useInstallChart()
  const upgrade = useUpgradeChart()

  const existing = releases.data ?? []
  const defaultRelease = useMemo(
    () => initialRelease ?? suggestReleaseName(chart, existing),
    [chart, existing, initialRelease],
  )

  const [releaseName, setReleaseName] = useState(defaultRelease)
  const [namespace, setNamespace] = useState(initialNamespace ?? chart.defaultNamespace)
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (initialValues) return { ...initialValues }
    const init: Record<string, unknown> = {}
    for (const f of chart.fields) {
      if (f.default !== undefined) init[f.key] = f.default
    }
    return init
  })

  const isUpgrade = mode === 'upgrade'
  const isPending = install.isPending || upgrade.isPending
  const error = (install.error ?? upgrade.error) as Error | undefined

  const nsOptions = useMemo(() => {
    const fromCluster = (namespaces.data ?? []).map((n) => n.metadata.name)
    const set = new Set<string>(fromCluster)
    set.add(chart.defaultNamespace)
    if (namespace) set.add(namespace)
    return [...set].sort()
  }, [namespaces.data, chart.defaultNamespace, namespace])

  function submit() {
    if (isUpgrade && releaseId) {
      upgrade.mutate(
        { id: releaseId, values, version: chart.version },
        { onSuccess: onClose },
      )
    } else {
      install.mutate(
        { chart, releaseName, namespace, values },
        { onSuccess: onClose },
      )
    }
  }

  const releaseValid = /^[a-z0-9]([a-z0-9-]{0,52}[a-z0-9])?$/.test(releaseName)
  const namespaceValid = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)
  const collision =
    !isUpgrade && existing.some((r) => r.namespace === namespace && r.releaseName === releaseName)

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]"
        onClick={() => !isPending && onClose()}
      />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-edge-default bg-white shadow-2xl ring-1 ring-black/5">
        <header className="flex items-start gap-3 border-b border-edge-subtle bg-linear-to-br from-brand-50/60 via-white to-white px-5 py-4">
          <ChartIcon chart={chart} size={36} />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
              {isUpgrade ? 'Upgrade release' : 'Install chart'}
            </div>
            <h3 className="truncate text-base font-semibold text-content">
              {chart.title ?? chart.name}{' '}
              <span className="font-mono text-[12px] font-normal text-content-muted">
                v{chart.version}
              </span>
            </h3>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => !isPending && onClose()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!releaseValid || !namespaceValid || collision) return
            submit()
          }}
        >
          <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FieldShell label="Release name" hint="Lowercase, alphanumeric + hyphens">
                <input
                  type="text"
                  value={releaseName}
                  onChange={(e) => setReleaseName(e.target.value)}
                  disabled={isUpgrade}
                  className={cn(
                    'h-9 w-full rounded-lg border bg-white px-2.5 font-mono text-[13px] text-content',
                    'focus:outline-none focus:ring-2 focus:ring-brand-400/20',
                    !releaseValid
                      ? 'border-rose-300 focus:border-rose-400'
                      : 'border-edge-default focus:border-brand-400',
                    isUpgrade && 'cursor-not-allowed bg-surface-sunken',
                  )}
                />
              </FieldShell>
              <FieldShell label="Namespace" hint="Will be created if missing">
                <input
                  list="ns-options"
                  type="text"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  disabled={isUpgrade}
                  className={cn(
                    'h-9 w-full rounded-lg border bg-white px-2.5 font-mono text-[13px] text-content',
                    'focus:outline-none focus:ring-2 focus:ring-brand-400/20',
                    !namespaceValid
                      ? 'border-rose-300 focus:border-rose-400'
                      : 'border-edge-default focus:border-brand-400',
                    isUpgrade && 'cursor-not-allowed bg-surface-sunken',
                  )}
                />
                <datalist id="ns-options">
                  {nsOptions.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </FieldShell>
            </div>

            {collision ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">
                A release named <code className="font-mono">{releaseName}</code> already exists in
                namespace <code className="font-mono">{namespace}</code>.
              </div>
            ) : null}

            {chart.fields.length ? (
              <div className="rounded-xl border border-edge-default bg-surface-sunken/40 p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
                  Values overrides
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {chart.fields.map((f) => (
                    <FieldRenderer
                      key={f.key}
                      field={f}
                      value={values[f.key]}
                      onChange={(v) =>
                        setValues((prev) => {
                          const next = { ...prev }
                          if (v === undefined || v === '') delete next[f.key]
                          else next[f.key] = v
                          return next
                        })
                      }
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">
                {error.message}
              </div>
            ) : null}

            {isPending ? (
              <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-[12px] text-brand-800">
                <Spinner size={12} /> {isUpgrade ? 'Upgrading…' : 'Installing…'}
              </div>
            ) : null}
          </div>

          <footer className="flex items-center justify-between gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-5 py-3">
            <span className="text-[11px] text-content-subtle">
              <code className="font-mono">{chart.repository}/{chart.name}</code>
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={isPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={!releaseValid || !namespaceValid || collision || isPending}
              >
                {isUpgrade ? 'Upgrade release' : 'Install'}
              </Button>
            </div>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  )
}

function FieldShell({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[10px] text-content-subtle">{hint}</span> : null}
    </label>
  )
}

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: import('../data/marketplace.ts').ChartValueField
  value: unknown
  onChange(v: unknown): void
}) {
  if (field.type === 'boolean') {
    return (
      <label className="flex items-start gap-2.5 rounded-lg border border-edge-default bg-white p-2.5">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-edge-default text-brand-600 focus:ring-brand-400/40"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-content">{field.label}</span>
          <code className="block font-mono text-[10px] text-content-subtle">{field.key}</code>
        </span>
      </label>
    )
  }
  if (field.type === 'select') {
    return (
      <FieldShell label={field.label} hint={field.key}>
        <select
          value={String(value ?? field.default ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-lg border border-edge-default bg-white px-2.5 text-[13px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        >
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </FieldShell>
    )
  }
  if (field.type === 'number') {
    return (
      <FieldShell label={field.label} hint={field.key}>
        <input
          type="number"
          value={value === undefined ? '' : String(value)}
          placeholder={field.placeholder}
          onChange={(e) =>
            onChange(e.target.value === '' ? undefined : Number(e.target.value))
          }
          className="h-9 w-full rounded-lg border border-edge-default bg-white px-2.5 font-mono text-[13px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
      </FieldShell>
    )
  }
  return (
    <FieldShell label={field.label} hint={field.key}>
      <input
        type="text"
        value={value === undefined ? '' : String(value)}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-lg border border-edge-default bg-white px-2.5 font-mono text-[13px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
      />
    </FieldShell>
  )
}

/* ─────────────────────────── Installed ─────────────────────────── */

function InstalledPanel() {
  const releases = useReleases()
  const charts = useCatalog()
  const uninstall = useUninstallChart()
  const map = useMemo(() => chartByIdMap(), [])
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<HelmRelease | null>(null)
  const [confirm, setConfirm] = useState<HelmRelease | null>(null)

  const all = releases.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (r) =>
          matchesSearch(r.releaseName, search) ||
          matchesSearch(r.namespace, search) ||
          matchesSearch(r.chart, search),
      ),
    [all, search],
  )

  return (
    <ListShell
      title="Installed"
      total={all.length}
      visible={rows.length}
      loading={releases.isLoading || charts.isLoading}
      isFetching={releases.isFetching}
      onRefresh={() => releases.refetch()}
      lastUpdatedAt={releases.dataUpdatedAt}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search releases…"
    >
      {all.length === 0 ? (
        <EmptyState
          title="No releases yet"
          description="Pick a chart from the Catalog tab and install it in one click."
        />
      ) : rows.length === 0 ? (
        <EmptyState title="No matching releases" description="Adjust your search." />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const chart = map.get(r.chartId)
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-edge-default bg-white p-3 shadow-sm transition-colors hover:border-brand-300"
              >
                {chart ? <ChartIcon chart={chart} size={36} /> : <FallbackTile />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-content">
                      {r.releaseName}
                    </span>
                    <ReleaseStatusBadge status={r.status} />
                    <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                      ns: {r.namespace}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-content-muted">
                    <span>
                      <span className="text-content-subtle">chart </span>
                      <code className="font-mono text-content">
                        {r.chart} v{r.version}
                      </code>
                    </span>
                    <span>
                      <span className="text-content-subtle">app </span>
                      <code className="font-mono text-content">{r.appVersion}</code>
                    </span>
                    <span>
                      <span className="text-content-subtle">revision </span>
                      <code className="font-mono text-content">{r.revision}</code>
                    </span>
                    <span>{age(r.createdAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setActive(r)}
                  >
                    Details
                  </Button>
                  {chart ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setActive({ ...r, status: 'upgrading' })}
                      title="Edit values + bump revision"
                    >
                      <IconUpgrade /> Upgrade
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirm(r)}
                    className="text-rose-700 hover:text-rose-800"
                  >
                    <IconTrash />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {active ? (
        <ReleaseSheet
          release={active}
          chart={map.get(active.chartId)}
          onClose={() => setActive(null)}
        />
      ) : null}

      {confirm ? (
        <UninstallConfirm
          release={confirm}
          isPending={uninstall.isPending}
          onClose={() => setConfirm(null)}
          onConfirm={() => uninstall.mutate(confirm.id, { onSuccess: () => setConfirm(null) })}
        />
      ) : null}
    </ListShell>
  )
}

function FallbackTile() {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-content-subtle ring-1 ring-edge-subtle">
      <IconBox />
    </span>
  )
}

function ReleaseSheet({
  release,
  chart,
  onClose,
}: {
  release: HelmRelease
  chart?: MarketplaceChart
  onClose(): void
}) {
  const [showUpgrade, setShowUpgrade] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showUpgrade) setShowUpgrade(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showUpgrade, onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="flex min-w-0 items-start gap-3">
            {chart ? <ChartIcon chart={chart} size={44} /> : <FallbackTile />}
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
                Helm release · {release.namespace}
              </div>
              <h2 className="mt-0.5 truncate text-lg font-semibold text-content">
                {release.releaseName}
              </h2>
              <div className="mt-1 text-[11px] text-content-muted">
                {release.chart} v{release.version} · revision {release.revision}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ReleaseStatusBadge status={release.status} />
            {chart ? (
              <Button variant="secondary" size="sm" onClick={() => setShowUpgrade(true)}>
                <IconUpgrade /> Upgrade
              </Button>
            ) : null}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <DetailCard title="Resources">
            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
              <code>
                {[
                  `kubectl get all -n ${release.namespace} -l app.kubernetes.io/instance=${release.releaseName}`,
                  `kubectl logs -n ${release.namespace} -l app.kubernetes.io/instance=${release.releaseName} -f`,
                  `helm status ${release.releaseName} -n ${release.namespace}`,
                ].join('\n')}
              </code>
            </pre>
          </DetailCard>

          <DetailCard title="Notes">
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-content-muted">
              {release.notes ?? '(no notes)'}
            </pre>
          </DetailCard>

          <DetailCard title="Values">
            <pre className="max-h-96 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
              <code>{JSON.stringify(release.values, null, 2)}</code>
            </pre>
          </DetailCard>
        </div>

        {showUpgrade && chart ? (
          <InstallDialog
            chart={chart}
            onClose={() => setShowUpgrade(false)}
            initialRelease={release.releaseName}
            initialNamespace={release.namespace}
            initialValues={release.values}
            mode="upgrade"
            releaseId={release.id}
          />
        ) : null}
      </aside>
    </div>,
    document.body,
  )
}

function UninstallConfirm({
  release,
  isPending,
  onClose,
  onConfirm,
}: {
  release: HelmRelease
  isPending: boolean
  onClose(): void
  onConfirm(): void
}) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Cancel"
        className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]"
        onClick={() => !isPending && onClose()}
      />
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-edge-default bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-rose-200 bg-rose-50/70 px-5 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-100 text-rose-700">
            <IconTrash />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-rose-900">Uninstall release?</h3>
            <p className="mt-0.5 text-[12px] text-content-muted">
              <code className="font-mono">{release.namespace}/{release.releaseName}</code>{' '}
              and every Kubernetes resource it owns will be deleted. The Helm history is removed.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Uninstalling…' : 'Uninstall'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const STATUS_KIND: Record<HelmRelease['status'], StatusKind> = {
  installing: 'progressing',
  deployed: 'healthy',
  upgrading: 'progressing',
  uninstalling: 'paused',
  failed: 'failed',
}

function ReleaseStatusBadge({ status }: { status: HelmRelease['status'] }) {
  return <StatusBadge kind={STATUS_KIND[status]}>{status}</StatusBadge>
}

/* ─────────────────────────── Repositories ─────────────────────────── */

function RepositoriesPanel() {
  const repos = useRepositories()
  const [search, setSearch] = useState('')
  const all = repos.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (r) =>
          matchesSearch(r.name, search) ||
          matchesSearch(r.url, search) ||
          matchesSearch(r.description, search),
      ),
    [all, search],
  )

  return (
    <ListShell
      title="Repositories"
      total={all.length}
      visible={rows.length}
      loading={repos.isLoading}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search repos…"
      caption="enabled chart sources"
    >
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {rows.map((r) => (
          <li
            key={r.name}
            className="flex flex-col gap-2 rounded-xl border border-edge-default bg-white p-4 shadow-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                  <IconBookmark />
                </span>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-content">{r.name}</span>
                    {r.verified ? <VerifiedDot /> : null}
                  </div>
                  <code className="font-mono text-[10px] text-content-subtle">
                    {r.chartCount} charts
                  </code>
                </div>
              </div>
              <span className="text-[10px] font-medium text-emerald-700">enabled</span>
            </div>
            <p className="text-[12px] text-content-muted">{r.description}</p>
            <code className="break-all font-mono text-[11px] text-content-subtle">{r.url}</code>
          </li>
        ))}
      </ul>
    </ListShell>
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

function IconStar() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2 14.4 8.4 21 9.3l-4.8 4.6 1.2 6.7L12 17.3 6.6 20.6l1.2-6.7L3 9.3l6.6-.9L12 2Z" />
    </svg>
  )
}

function IconArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function IconDownload() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="-ml-0.5 mr-1">
      <path d="M12 3v12" />
      <path d="m6 11 6 6 6-6" />
      <path d="M5 21h14" />
    </svg>
  )
}

function IconUpgrade() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mr-1">
      <path d="M12 21V9" />
      <path d="m6 15 6-6 6 6" />
      <path d="M5 3h14" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  )
}

function IconBookmark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function IconBox() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  )
}
