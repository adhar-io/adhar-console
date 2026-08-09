import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Card, CardBody, CardHeader, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { client, LOCAL_CLUSTER } from '../data/client.ts'
import { PLATFORM_KINDS } from './xr-kinds.tsx'
import type { XR } from './xr-list.tsx'

/**
 * Backstage-style index for every Adhar Platform abstraction. Pulls live
 * counts in parallel via TanStack Query, summarises Ready/Synced status, and
 * groups kinds by family so operators can navigate the catalog at a glance.
 *
 * Selection deep-links into the same `?section=…` flow used by the rest of
 * the platform module — clicking a tile is identical to clicking the matching
 * sidebar entry.
 */
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
      PLATFORM_KINDS.map((k, i) => {
        const q = queries[i]
        const items = ((q.data as XR[] | undefined) ?? []) as XR[]
        const ready = items.filter((x) => isCondition(x, 'Ready')).length
        const synced = items.filter((x) => isCondition(x, 'Synced')).length
        const newest = items
          .map((x) => x.metadata.creationTimestamp)
          .filter(Boolean)
          .sort()
          .slice(-1)[0]
        const error = q.isError ? (q.error as { status?: number; message?: string }) : undefined
        return { id: k.id, family: k.family, config: k.config, items, ready, synced, newest, q, error }
      }),
    [queries],
  )

  const anyLoading = queries.some((q) => q.isLoading)
  const families: Array<{ id: 'compute' | 'data' | 'connectivity' | 'governance'; label: string; description: string; tone: string }> = [
    { id: 'compute', label: 'Compute', description: 'Where the work runs — services, functions, jobs.', tone: 'from-brand-50 dark:from-brand-500/10 to-brand-100/60 dark:to-brand-500/15' },
    { id: 'data', label: 'Data', description: 'Stateful claims — databases, caches, buckets, topics, pipelines.', tone: 'from-emerald-50 dark:from-emerald-500/10 to-emerald-100/60 dark:to-emerald-500/15' },
    { id: 'connectivity', label: 'Connectivity', description: 'How the world reaches your services — routes, domains, contracts.', tone: 'from-sky-50 dark:from-sky-500/10 to-sky-100/60 dark:to-sky-500/15' },
    { id: 'governance', label: 'Governance', description: 'Guardrails — environments, quotas, access boundaries.', tone: 'from-amber-50 dark:from-amber-500/10 to-amber-100/60 dark:to-amber-500/15' },
  ]

  const total = tiles.reduce((acc, t) => acc + t.items.length, 0)
  const totalReady = tiles.reduce((acc, t) => acc + t.ready, 0)
  const totalSynced = tiles.reduce((acc, t) => acc + t.synced, 0)
  const errors = tiles.filter((t) => t.error && t.error.status !== 404).length

  return (
    <div className="space-y-6">
      <Hero
        total={total}
        ready={totalReady}
        synced={totalSynced}
        kinds={tiles.length}
        errors={errors}
        loading={anyLoading}
      />
      {families.map((f) => {
        const inFamily = tiles.filter((t) => t.family === f.id)
        if (!inFamily.length) return null
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
                {inFamily.reduce((a, t) => a + t.items.length, 0)} resources across{' '}
                {inFamily.length} kinds
              </span>
            </header>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {inFamily.map((t) => (
                <KindTile key={t.id} tile={t} familyTone={f.tone} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Hero({
  total,
  ready,
  synced,
  kinds,
  errors,
  loading,
}: {
  total: number
  ready: number
  synced: number
  kinds: number
  errors: number
  loading: boolean
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-edge-default bg-linear-to-br from-brand-50/70 dark:from-brand-500/10 via-white to-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-raised shadow-sm ring-1 ring-edge-subtle">
            <span className="text-brand-700 dark:text-brand-300">
              <IconSparkles />
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-content">Adhar Platform catalog</h2>
              {loading ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-content-muted">
                  <Spinner size={11} /> reconciling
                </span>
              ) : (
                <StatusBadge kind={errors > 0 ? 'degraded' : 'healthy'}>
                  {errors > 0 ? `${errors} kinds with errors` : 'all kinds reporting'}
                </StatusBadge>
              )}
            </div>
            <p className="mt-0.5 max-w-xl text-[12px] text-content-muted">
              Every Adhar abstraction is a Crossplane composite — golden defaults plus the same
              GitOps lifecycle, RBAC, and observability wiring as any other resource in the cluster.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <SummaryStat label="Kinds" value={String(kinds)} hint="installed" />
          <SummaryStat label="Resources" value={String(total)} hint="composed" />
          <SummaryStat label="Ready" value={`${ready}/${total}`} hint="conditions" />
          <SummaryStat label="Synced" value={`${synced}/${total}`} hint="reconciler" />
        </div>
      </div>
    </div>
  )
}

function SummaryStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-base tabular-nums text-content">{value}</div>
      <div className="text-[10px] text-content-subtle">{hint}</div>
    </div>
  )
}

interface Tile {
  id: typeof PLATFORM_KINDS[number]['id']
  family: typeof PLATFORM_KINDS[number]['family']
  config: typeof PLATFORM_KINDS[number]['config']
  items: XR[]
  ready: number
  synced: number
  newest: string | undefined
  q: { isError: boolean; isLoading: boolean }
  error?: { status?: number; message?: string }
}

function KindTile({
  tile,
  familyTone,
}: {
  tile: Tile
  familyTone: string
}) {
  const { id, config, items, ready, synced, error } = tile
  const total = items.length
  const notInstalled = error?.status === 404
  const href = `?section=${id}`

  return (
    <a
      href={href}
      className={cn(
        'group block rounded-2xl border border-edge-default bg-surface-raised p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-200 dark:hover:border-brand-500/25 hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500',
      )}
    >
      <Card className="border-0 bg-transparent p-0 shadow-none">
        <CardHeader className="border-0 p-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={cn(
                'mb-2 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-br shadow-sm ring-1 ring-edge-subtle',
                familyTone,
              )}>
                <KindGlyph id={id} />
              </div>
              <h4 className="truncate text-sm font-semibold text-content">{config.plural}</h4>
              <p className="mt-0.5 line-clamp-2 text-[12px] text-content-muted">
                {config.description}
              </p>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-content-subtle group-hover:text-brand-700 dark:group-hover:text-brand-300">
              open →
            </span>
          </div>
        </CardHeader>
        <CardBody className="border-0 p-0 pt-3">
          {notInstalled ? (
            <div className="rounded-md border border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-900 dark:text-amber-200">
              XRD not installed on this cluster
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              <Counter label="Total" value={total} />
              <Counter label="Ready" value={`${ready}/${total}`} tone={ready === total && total > 0 ? 'healthy' : total === 0 ? 'idle' : 'degraded'} />
              <Counter label="Synced" value={`${synced}/${total}`} tone={synced === total && total > 0 ? 'healthy' : total === 0 ? 'idle' : 'degraded'} />
            </div>
          )}
          <div className="mt-3 flex items-center justify-between text-[11px] text-content-subtle">
            <code className="truncate font-mono">{config.gvr.group}/{config.gvr.version}</code>
            <span className="rounded-full border border-edge-default bg-surface-sunken px-2 py-0.5">
              {config.gvr.namespaced ? 'namespaced' : 'cluster'}
            </span>
          </div>
        </CardBody>
      </Card>
    </a>
  )
}

function Counter({
  label,
  value,
  tone = 'idle',
}: {
  label: string
  value: number | string
  tone?: 'healthy' | 'degraded' | 'idle'
}) {
  return (
    <div className="rounded-lg border border-edge-default bg-surface-sunken px-2 py-1.5">
      <div className={cn(
        'font-mono text-base font-semibold tabular-nums',
        tone === 'healthy' ? 'text-emerald-700 dark:text-emerald-300' : tone === 'degraded' ? 'text-rose-700 dark:text-rose-300' : 'text-content',
      )}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-content-subtle">{label}</div>
    </div>
  )
}

function isCondition(xr: XR, type: 'Ready' | 'Synced'): boolean {
  return (xr.status?.conditions ?? []).some((c) => c.type === type && c.status === 'True')
}

/* ───── glyphs ───── */

function KindGlyph({ id }: { id: typeof PLATFORM_KINDS[number]['id'] }) {
  switch (id) {
    case 'applications': return <IconAppBox />
    case 'functions': return <IconBolt />
    case 'workflows': return <IconRoute />
    case 'pipelines': return <IconGitBranch />
    case 'databases': return <IconDatabase />
    case 'caches': return <IconBolt />
    case 'buckets': return <IconArchive />
    case 'topics': return <IconRadio />
    case 'data-pipelines': return <IconWaves />
    case 'routes': return <IconCompass />
    case 'domains': return <IconGlobe />
    case 'api-contracts': return <IconFileCode />
    case 'environments': return <IconShield />
  }
}

const SVG = (props: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {props.children}
  </svg>
)
const IconAppBox = () => <SVG>{<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M4 9h16" /><path d="M9 4v5" /></>}</SVG>
const IconBolt = () => <SVG>{<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />}</SVG>
const IconRoute = () => <SVG>{<><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 17V9a4 4 0 0 1 4-4h6" /></>}</SVG>
const IconGitBranch = () => <SVG>{<><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>}</SVG>
const IconDatabase = () => <SVG>{<><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></>}</SVG>
const IconArchive = () => <SVG>{<><path d="M21 8v13H3V8" /><rect x="1" y="3" width="22" height="5" rx="1" /><path d="M10 12h4" /></>}</SVG>
const IconRadio = () => <SVG>{<><circle cx="12" cy="12" r="2" /><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" /></>}</SVG>
const IconWaves = () => <SVG>{<><path d="M2 6c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" /><path d="M2 12c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" /><path d="M2 18c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" /></>}</SVG>
const IconCompass = () => <SVG>{<><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></>}</SVG>
const IconGlobe = () => <SVG>{<><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" /></>}</SVG>
const IconFileCode = () => <SVG>{<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="m9 13-2 2 2 2" /><path d="m13 13 2 2-2 2" /></>}</SVG>
const IconShield = () => <SVG>{<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}</SVG>
const IconSparkles = () => <SVG>{<><path d="M12 2v6" /><path d="M12 16v6" /><path d="m4.93 4.93 4.24 4.24" /><path d="m14.83 14.83 4.24 4.24" /><path d="M2 12h6" /><path d="M16 12h6" /><path d="m4.93 19.07 4.24-4.24" /><path d="m14.83 9.17 4.24-4.24" /></>}</SVG>
