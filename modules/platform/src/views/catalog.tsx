import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Badge, Input, Select, Skeleton, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { client, LOCAL_CLUSTER } from '../data/client.ts'
import { age } from '../data/format.ts'
import { PLATFORM_KINDS } from './xr-kinds.tsx'
import { AUTO_CREATE_KEY, type XR } from './xr-list.tsx'

/**
 * Adhar Resources — a polished control surface for every Adhar Platform
 * abstraction. Each kind is a Crossplane composite; this dashboard pulls live
 * counts in parallel via TanStack Query, summarises Ready/Synced health, and
 * groups kinds by family so operators can navigate the catalog at a glance.
 *
 * Navigation deep-links into the same `?section=…` flow the rest of the
 * platform module uses (the federated remote does not share the host router, so
 * plain anchors — not <Link> — are the honest cross-section primitive here).
 * "View" opens a kind's list; "Create" deep-links to that list and hands off an
 * intent flag that <XrList/> reads on mount to open its provisioning wizard.
 */

type FamilyId = 'compute' | 'data' | 'connectivity' | 'governance'

const FAMILIES: Array<{
  id: FamilyId
  label: string
  description: string
  tone: string
}> = [
  {
    id: 'compute',
    label: 'Compute',
    description: 'Where the work runs — services, functions, jobs.',
    tone: 'from-brand-50 dark:from-brand-500/10 to-brand-100/60 dark:to-brand-500/15',
  },
  {
    id: 'data',
    label: 'Data',
    description: 'Stateful claims — databases, caches, buckets, topics, pipelines.',
    tone: 'from-emerald-50 dark:from-emerald-500/10 to-emerald-100/60 dark:to-emerald-500/15',
  },
  {
    id: 'connectivity',
    label: 'Connectivity',
    description: 'How the world reaches your services — routes, domains, contracts.',
    tone: 'from-sky-50 dark:from-sky-500/10 to-sky-100/60 dark:to-sky-500/15',
  },
  {
    id: 'governance',
    label: 'Governance',
    description: 'Guardrails — environments, quotas, access boundaries.',
    tone: 'from-amber-50 dark:from-amber-500/10 to-amber-100/60 dark:to-amber-500/15',
  },
]

export function PlatformCatalog() {
  const queries = useQueries({
    queries: PLATFORM_KINDS.map((k) => ({
      queryKey: ['platform', 'catalog', k.id],
      queryFn: () => client.listGeneric(LOCAL_CLUSTER, k.config.gvr) as Promise<XR[]>,
      staleTime: 30_000,
      retry: false,
    })),
  })

  const tiles = useMemo(
    () =>
      PLATFORM_KINDS.map((k, i): Tile => {
        const q = queries[i]
        const items = ((q.data as XR[] | undefined) ?? []) as XR[]
        const ready = items.filter((x) => isCondition(x, 'Ready')).length
        const synced = items.filter((x) => isCondition(x, 'Synced')).length
        const degraded = items.filter(
          (x) => !x.metadata.deletionTimestamp && !isCondition(x, 'Ready'),
        ).length
        const newest = items
          .map((x) => x.metadata.creationTimestamp)
          .filter(Boolean)
          .sort()
          .slice(-1)[0]
        const error = q.isError ? (q.error as { status?: number; message?: string }) : undefined
        return {
          id: k.id,
          family: k.family,
          config: k.config,
          items,
          ready,
          synced,
          degraded,
          newest,
          loading: q.isLoading,
          error,
        }
      }),
    [queries],
  )

  // ── search + filter state ──
  const [search, setSearch] = useState('')
  const [family, setFamily] = useState<'all' | FamilyId>('all')
  const [withResourcesOnly, setWithResourcesOnly] = useState(false)

  const query = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      tiles.filter((t) => {
        if (family !== 'all' && t.family !== family) return false
        if (withResourcesOnly && t.items.length === 0) return false
        if (!query) return true
        const hay = [
          t.config.singular,
          t.config.plural,
          t.config.description,
          t.config.gvr.group,
          t.config.gvr.resource,
          t.family,
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(query)
      }),
    [tiles, family, withResourcesOnly, query],
  )

  const anyLoading = queries.some((q) => q.isLoading)

  // Totals span the whole catalog — the summary band is a fixed pulse, not a
  // reflection of the current filter.
  const total = tiles.reduce((acc, t) => acc + t.items.length, 0)
  const totalReady = tiles.reduce((acc, t) => acc + t.ready, 0)
  const totalSynced = tiles.reduce((acc, t) => acc + t.synced, 0)
  const totalDegraded = tiles.reduce((acc, t) => acc + t.degraded, 0)
  const errorKinds = tiles.filter((t) => t.error && t.error.status !== 404).length

  const visibleFamilies = FAMILIES.filter((f) => filtered.some((t) => t.family === f.id))

  return (
    <div className="space-y-6">
      <Hero
        total={total}
        ready={totalReady}
        synced={totalSynced}
        degraded={totalDegraded}
        kinds={tiles.length}
        errorKinds={errorKinds}
        loading={anyLoading}
      />

      <Toolbar
        search={search}
        onSearch={setSearch}
        family={family}
        onFamily={setFamily}
        withResourcesOnly={withResourcesOnly}
        onWithResourcesOnly={setWithResourcesOnly}
        shown={filtered.length}
        totalKinds={tiles.length}
      />

      {visibleFamilies.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-edge-default bg-surface-raised px-6 py-12 text-center">
          <p className="text-sm font-medium text-content">No kinds match your filters</p>
          <p className="mt-1 text-[12px] text-content-muted">
            Try a different search term{withResourcesOnly ? ', clear the “with resources” toggle,' : ''}{' '}
            or reset the family filter.
          </p>
        </div>
      ) : (
        visibleFamilies.map((f) => {
          const inFamily = filtered.filter((t) => t.family === f.id)
          const count = inFamily.reduce((a, t) => a + t.items.length, 0)
          return (
            <section key={f.id} className="space-y-3">
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-content-subtle">
                    {f.label}
                  </h3>
                  <p className="text-sm text-content-muted">{f.description}</p>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-content-subtle">
                  {anyLoading ? '—' : count} resource{count === 1 ? '' : 's'} across {inFamily.length}{' '}
                  kind{inFamily.length === 1 ? '' : 's'}
                </span>
              </header>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {inFamily.map((t) => (
                  <KindCard key={t.id} tile={t} familyTone={f.tone} />
                ))}
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}

/* ───── hero / summary band ───── */

function Hero({
  total,
  ready,
  synced,
  degraded,
  kinds,
  errorKinds,
  loading,
}: {
  total: number
  ready: number
  synced: number
  degraded: number
  kinds: number
  errorKinds: number
  loading: boolean
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-edge-default bg-linear-to-br from-brand-50/70 dark:from-brand-500/10 via-surface-raised to-surface-raised p-5 shadow-sm">
      {/* subtle brand glow — tokens only */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-brand-400/10 blur-3xl"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-raised shadow-sm ring-1 ring-edge-subtle">
            <span className="text-brand-700 dark:text-brand-300">
              <IconSparkles />
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-content">Adhar Resources</h2>
              {loading ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-content-muted">
                  <Spinner size={11} /> reconciling
                </span>
              ) : errorKinds > 0 ? (
                <StatusBadge kind="degraded">
                  {errorKinds} kind{errorKinds === 1 ? '' : 's'} with errors
                </StatusBadge>
              ) : degraded > 0 ? (
                <StatusBadge kind="degraded">
                  {degraded} not ready
                </StatusBadge>
              ) : (
                <StatusBadge kind="healthy">all kinds reporting</StatusBadge>
              )}
            </div>
            <p className="mt-0.5 max-w-xl text-[12px] leading-relaxed text-content-muted">
              Every Adhar abstraction is a Crossplane composite — golden defaults plus the same
              GitOps lifecycle, RBAC, and observability wiring as any other resource in the cluster.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Kinds" value={String(kinds)} hint="installed" loading={false} />
          <StatTile label="Resources" value={String(total)} hint="composed" loading={loading} />
          <StatTile
            label="Ready"
            value={`${ready}/${total}`}
            hint="conditions"
            tone={total > 0 && ready === total ? 'healthy' : ready < total ? 'degraded' : 'idle'}
            loading={loading}
          />
          <StatTile
            label="Synced"
            value={`${synced}/${total}`}
            hint="reconciler"
            tone={total > 0 && synced === total ? 'healthy' : synced < total ? 'degraded' : 'idle'}
            loading={loading}
          />
          <StatTile
            label="Degraded"
            value={String(degraded)}
            hint="not ready"
            tone={degraded > 0 ? 'degraded' : 'idle'}
            loading={loading}
          />
        </div>
      </div>
    </div>
  )
}

function StatTile({
  label,
  value,
  hint,
  tone = 'idle',
  loading,
}: {
  label: string
  value: string
  hint: string
  tone?: HealthTone
  loading: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {label}
      </div>
      {loading ? (
        <Skeleton width={44} height={20} className="mt-1" />
      ) : (
        <div className={cn('mt-0.5 truncate font-mono text-lg font-semibold tabular-nums', toneText(tone))}>
          {value}
        </div>
      )}
      <div className="text-[10px] text-content-subtle">{hint}</div>
    </div>
  )
}

/* ───── search + filter toolbar ───── */

function Toolbar({
  search,
  onSearch,
  family,
  onFamily,
  withResourcesOnly,
  onWithResourcesOnly,
  shown,
  totalKinds,
}: {
  search: string
  onSearch: (v: string) => void
  family: 'all' | FamilyId
  onFamily: (v: 'all' | FamilyId) => void
  withResourcesOnly: boolean
  onWithResourcesOnly: (v: boolean) => void
  shown: number
  totalKinds: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-edge-default bg-surface-raised p-3 shadow-sm">
      <div className="min-w-[16rem] flex-1">
        <label htmlFor="catalog-search" className="sr-only">
          Search Adhar Resources
        </label>
        <Input
          id="catalog-search"
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search kinds — name, description, group…"
          leading={<IconSearch />}
          aria-label="Search Adhar Resources"
        />
      </div>
      <div className="w-full sm:w-48">
        <label htmlFor="catalog-family" className="sr-only">
          Filter by family
        </label>
        <Select
          id="catalog-family"
          value={family}
          onChange={(e) => onFamily(e.target.value as 'all' | FamilyId)}
          aria-label="Filter by family"
        >
          <option value="all">All families</option>
          {FAMILIES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>
      <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[12px] font-medium text-content-muted">
        <input
          type="checkbox"
          checked={withResourcesOnly}
          onChange={(e) => onWithResourcesOnly(e.target.checked)}
          className="h-4 w-4 rounded border-edge-default accent-brand-600"
        />
        Only kinds with resources
      </label>
      <span className="ml-auto text-[11px] font-mono tabular-nums text-content-subtle">
        {shown}/{totalKinds} kinds
      </span>
    </div>
  )
}

/* ───── kind card ───── */

interface Tile {
  id: typeof PLATFORM_KINDS[number]['id']
  family: FamilyId
  config: typeof PLATFORM_KINDS[number]['config']
  items: XR[]
  ready: number
  synced: number
  degraded: number
  newest: string | undefined
  loading: boolean
  error?: { status?: number; message?: string }
}

function KindCard({ tile, familyTone }: { tile: Tile; familyTone: string }) {
  const { id, config, items, ready, synced, loading, error } = tile
  const total = items.length
  const notInstalled = error?.status === 404
  const failed = Boolean(error) && !notInstalled
  const href = `?section=${id}`

  const openCreate = () => {
    // Hand off an intent flag; <XrList/> reads it on mount and opens the wizard.
    // Wrapped in try/catch — storage can be unavailable (private mode, etc.).
    try {
      sessionStorage.setItem(AUTO_CREATE_KEY, config.gvr.resource)
    } catch {
      /* deep-link to the section still works without the auto-open */
    }
  }

  return (
    <article
      className={cn(
        'group relative flex flex-col rounded-2xl border border-edge-default bg-surface-raised p-4 shadow-sm',
        'transition-[transform,box-shadow,border-color] duration-150 ease-smooth',
        'hover:-translate-y-0.5 hover:border-brand-200 dark:hover:border-brand-500/25 hover:shadow-md',
        'focus-within:ring-2 focus-within:ring-brand-500/40',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={cn(
            'inline-flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-br shadow-sm ring-1 ring-edge-subtle text-content',
            familyTone,
          )}
        >
          <KindGlyph id={id} />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-content-subtle transition-colors group-hover:text-brand-700 dark:group-hover:text-brand-300">
          {config.gvr.namespaced ? 'namespaced' : 'cluster'}
        </span>
      </div>

      <div className="mt-2 min-w-0">
        <h4 className="truncate text-sm font-semibold text-content">
          {/* Stretched link — makes the whole card open the kind's list, while
              staying a real, focusable, keyboard-activatable anchor. */}
          <a
            href={href}
            className="outline-none after:absolute after:inset-0 after:rounded-2xl"
            aria-label={`View ${config.plural}`}
          >
            {config.plural}
          </a>
        </h4>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-content-muted">
          {config.description}
        </p>
      </div>

      <div className="mt-3">
        {loading ? (
          <div className="grid grid-cols-3 gap-2">
            <Skeleton height={44} rounded="lg" />
            <Skeleton height={44} rounded="lg" />
            <Skeleton height={44} rounded="lg" />
          </div>
        ) : notInstalled ? (
          <div className="rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-900 dark:text-amber-200">
            <span className="font-semibold">Not installed</span> — this XRD isn’t registered on the
            cluster yet.
          </div>
        ) : failed ? (
          <div className="rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-800 dark:text-rose-300">
            <span className="font-semibold">Couldn’t load</span> — {error?.message ?? 'request failed'}
          </div>
        ) : total === 0 ? (
          <div className="flex items-center justify-between rounded-lg border border-dashed border-edge-default bg-surface-sunken px-2.5 py-2.5">
            <span className="text-[12px] text-content-muted">None yet</span>
            <Badge tone="slate">0</Badge>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-center">
            <Counter label="Total" value={total} />
            <Counter
              label="Ready"
              value={`${ready}/${total}`}
              tone={ready === total ? 'healthy' : 'degraded'}
            />
            <Counter
              label="Synced"
              value={`${synced}/${total}`}
              tone={synced === total ? 'healthy' : 'degraded'}
            />
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-content-subtle">
        <code className="truncate font-mono" title={`${config.gvr.group}/${config.gvr.version}`}>
          {config.gvr.group}/{config.gvr.version}
        </code>
        {!loading && !notInstalled && !failed && tile.newest ? (
          <span className="shrink-0" title="Most recent claim">
            {age(tile.newest)}
          </span>
        ) : null}
      </div>

      {/* quick actions — relative/z-10 so they sit above the stretched link */}
      <div className="relative z-10 mt-3 flex items-center gap-2 border-t border-edge-subtle pt-3">
        <a
          href={href}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-brand-600 px-3 text-xs font-medium text-white shadow-sm ring-1 ring-inset ring-white/10 outline-none transition-colors hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          View
        </a>
        {notInstalled ? (
          <span
            className="inline-flex h-8 items-center justify-center rounded-md border border-edge-default px-3 text-xs font-medium text-content-subtle"
            title="Install the XRD to provision this kind"
          >
            Create
          </span>
        ) : (
          <a
            href={href}
            onClick={openCreate}
            className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-edge-default bg-surface-raised px-3 text-xs font-medium text-content shadow-sm outline-none transition-colors hover:border-edge-strong hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-500/20"
            aria-label={`Create ${config.singular}`}
          >
            <IconPlus /> Create
          </a>
        )}
      </div>
    </article>
  )
}

function Counter({
  label,
  value,
  tone = 'idle',
}: {
  label: string
  value: number | string
  tone?: HealthTone
}) {
  return (
    <div className="rounded-lg border border-edge-default bg-surface-sunken px-2 py-1.5">
      <div className={cn('font-mono text-base font-semibold tabular-nums', toneText(tone))}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-content-subtle">{label}</div>
    </div>
  )
}

/* ───── helpers ───── */

type HealthTone = 'healthy' | 'degraded' | 'idle'

function toneText(tone: HealthTone): string {
  return tone === 'healthy'
    ? 'text-emerald-700 dark:text-emerald-300'
    : tone === 'degraded'
      ? 'text-rose-700 dark:text-rose-300'
      : 'text-content'
}

function isCondition(xr: XR, type: 'Ready' | 'Synced'): boolean {
  return (xr.status?.conditions ?? []).some((c) => c.type === type && c.status === 'True')
}

/* ───── glyphs ───── */

function KindGlyph({ id }: { id: typeof PLATFORM_KINDS[number]['id'] }) {
  switch (id) {
    case 'applications':
      return <IconAppBox />
    case 'functions':
      return <IconBolt />
    case 'workflows':
      return <IconRoute />
    case 'pipelines':
      return <IconGitBranch />
    case 'databases':
      return <IconDatabase />
    case 'caches':
      return <IconZap />
    case 'buckets':
      return <IconArchive />
    case 'topics':
      return <IconRadio />
    case 'queues':
      return <IconLayers />
    case 'data-pipelines':
      return <IconWaves />
    case 'routes':
      return <IconCompass />
    case 'domains':
      return <IconGlobe />
    case 'load-balancers':
      return <IconScale />
    case 'api-contracts':
      return <IconFileCode />
    case 'environments':
      return <IconShield />
    case 'certificates':
      return <IconCertificate />
    case 'secret-stores':
      return <IconKey />
  }
}

const SVG = (props: { children: React.ReactNode }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {props.children}
  </svg>
)
const IconAppBox = () => <SVG>{<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M4 9h16" /><path d="M9 4v5" /></>}</SVG>
const IconBolt = () => <SVG>{<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />}</SVG>
const IconZap = () => <SVG>{<><polyline points="4 14 10 14 8 21 20 10 14 10 16 3 4 14" /></>}</SVG>
const IconRoute = () => <SVG>{<><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 17V9a4 4 0 0 1 4-4h6" /></>}</SVG>
const IconGitBranch = () => <SVG>{<><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>}</SVG>
const IconDatabase = () => <SVG>{<><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></>}</SVG>
const IconArchive = () => <SVG>{<><path d="M21 8v13H3V8" /><rect x="1" y="3" width="22" height="5" rx="1" /><path d="M10 12h4" /></>}</SVG>
const IconRadio = () => <SVG>{<><circle cx="12" cy="12" r="2" /><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" /></>}</SVG>
const IconLayers = () => <SVG>{<><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>}</SVG>
const IconWaves = () => <SVG>{<><path d="M2 6c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" /><path d="M2 12c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" /><path d="M2 18c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" /></>}</SVG>
const IconCompass = () => <SVG>{<><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></>}</SVG>
const IconGlobe = () => <SVG>{<><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" /></>}</SVG>
const IconScale = () => <SVG>{<><path d="M12 3v18" /><path d="M5 8h14" /><path d="M5 8l-3 6a3 3 0 0 0 6 0z" /><path d="M19 8l-3 6a3 3 0 0 0 6 0z" /><path d="M8 21h8" /></>}</SVG>
const IconFileCode = () => <SVG>{<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="m9 13-2 2 2 2" /><path d="m13 13 2 2-2 2" /></>}</SVG>
const IconShield = () => <SVG>{<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}</SVG>
const IconCertificate = () => <SVG>{<><circle cx="12" cy="8" r="6" /><path d="M8.5 13.5 7 22l5-3 5 3-1.5-8.5" /></>}</SVG>
const IconKey = () => <SVG>{<><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.5 12.5 8-8" /><path d="m16 6 3 3" /><path d="m19 3 2 2" /></>}</SVG>
const IconSparkles = () => <SVG>{<><path d="M12 2v6" /><path d="M12 16v6" /><path d="m4.93 4.93 4.24 4.24" /><path d="m14.83 14.83 4.24 4.24" /><path d="M2 12h6" /><path d="M16 12h6" /><path d="m4.93 19.07 4.24-4.24" /><path d="m14.83 9.17 4.24-4.24" /></>}</SVG>
const IconSearch = () => <SVG>{<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>}</SVG>
const IconPlus = () => <SVG>{<><path d="M12 5v14" /><path d="M5 12h14" /></>}</SVG>
