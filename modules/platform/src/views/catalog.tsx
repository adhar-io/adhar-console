import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import {
  AdharSymbol,
  Badge,
  CiliumIcon,
  Input,
  KafkaIcon,
  MinIOIcon,
  RabbitMQIcon,
  Select,
  Skeleton,
  Spinner,
  StatusBadge,
  useOverlayDismiss,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { client, useActiveCluster } from '../data/client.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { age } from '../data/format.ts'
import { useXrds, type XrdInfo } from '../data/xrds.ts'
import { isManaged, useManagedKinds } from '../data/managed-kinds.ts'
import {
  configFromXrd,
  curationFor,
  type FamilyId,
  type GlyphId,
} from './xr-kinds.tsx'
import { ClaimFormModal, XrList, type XR } from './xr-list.tsx'
import { K8sRolePill } from '../components/role-gate.tsx'

/**
 * Adhar Resources — the live catalog of everything this platform can hold.
 *
 * Two sources, both discovered from the cluster rather than hardcoded:
 *
 *   1. **Crossplane composites** (XRDs) — the abstractions a team can *claim*.
 *      Schema-driven: "Create" generates the provisioning form from the live
 *      XRD, so it can never drift from the cluster.
 *   2. **Operator-managed resources** — the databases, caches, brokers, object
 *      stores and certificates that real workloads actually run on, each read
 *      from its own operator's API (CloudNativePG, Strimzi, the Redis operator,
 *      MinIO, cert-manager…). Only kinds whose CRD is installed appear.
 *
 * The second source matters: with no composite claimed anywhere, this page was
 * empty while the cluster was full of exactly the resources an operator came
 * here to find. Managed kinds are read-only here — creating one belongs to its
 * operator — so their cards offer Browse (list + topology + health) but no
 * claim form.
 */

const FAMILIES: Array<{ id: FamilyId; label: string; description: string; tone: string }> = [
  {
    id: 'compute',
    label: 'Compute',
    description: 'Where the work runs — applications, services, pipelines, GitOps.',
    tone: 'from-brand-50 dark:from-brand-500/10 to-brand-100/60 dark:to-brand-500/15',
  },
  {
    id: 'data',
    label: 'Data',
    description: 'Stateful claims — databases, storage, messaging, secrets, backups.',
    tone: 'from-emerald-50 dark:from-emerald-500/10 to-emerald-100/60 dark:to-emerald-500/15',
  },
  {
    id: 'connectivity',
    label: 'Connectivity',
    description: 'How things reach each other — networks and ingress.',
    tone: 'from-sky-50 dark:from-sky-500/10 to-sky-100/60 dark:to-sky-500/15',
  },
  {
    id: 'observability',
    label: 'Observability',
    description: 'Insight — health, metrics, logs, traces, cost.',
    tone: 'from-violet-50 dark:from-violet-500/10 to-violet-100/60 dark:to-violet-500/15',
  },
  {
    id: 'governance',
    label: 'Governance',
    description: 'Guardrails — environments, projects, clusters, policy, auth.',
    tone: 'from-amber-50 dark:from-amber-500/10 to-amber-100/60 dark:to-amber-500/15',
  },
]

interface Tile {
  info: XrdInfo
  family: FamilyId
  icon: GlyphId
  description: string
  items: XR[]
  ready: number
  synced: number
  /** True only when at least one object of this kind publishes `Synced`. */
  syncedApplicable: boolean
  /** Objects that assert they are NOT up. The only count worth alarming on. */
  notReady: number
  /** Objects whose operator publishes no readiness at all — visible, not alarming. */
  unreported: number
  newest: string | undefined
  loading: boolean
  error?: { status?: number; message?: string }
}

export function PlatformCatalog() {
  const { cluster } = useActiveCluster()
  const xrdsQ = useXrds()
  const managedQ = useManagedKinds()
  const kinds = useMemo(
    () => [...(xrdsQ.data ?? []), ...(managedQ.data ?? [])],
    [xrdsQ.data, managedQ.data],
  )

  const queries = useQueries({
    queries: kinds.map((k) => ({
      queryKey: ['platform', 'catalog', k.plural, cluster],
      queryFn: () => client.listGeneric(cluster, k.gvr) as Promise<XR[]>,
      staleTime: 30_000,
      retry: false,
    })),
  })

  const tiles = useMemo(
    () =>
      kinds.map((info, i): Tile => {
        const q = queries[i]
        const items = ((q?.data as XR[] | undefined) ?? []) as XR[]
        const states = items.map(readinessOf)
        const ready = states.filter((r) => r === 'ready').length
        const notReady = states.filter((r) => r === 'notReady').length
        const unreported = states.filter((r) => r === 'unreported').length
        const { applicable: syncedApplicable, synced } = syncedStats(items)
        const newest = items
          .map((x) => x.metadata.creationTimestamp)
          .filter(Boolean)
          .sort()
          .slice(-1)[0]
        const cur = curationFor(info.kind)
        const managed = isManaged(info)
        const error = q?.isError ? (q.error as { status?: number; message?: string }) : undefined
        return {
          info,
          family: managed ? info.managedFamily : cur.family,
          icon: managed ? info.managedIcon : cur.icon,
          description: managed
            ? info.managedDescription
            : cur.description ?? `${info.kind} — provisioned via Crossplane.`,
          items,
          ready,
          synced,
          syncedApplicable,
          notReady,
          unreported,
          newest,
          loading: Boolean(q?.isLoading),
          error,
        }
      }),
    [kinds, queries],
  )

  const [search, setSearch] = useState('')
  const [family, setFamily] = useState<'all' | FamilyId>('all')
  const [withResourcesOnly, setWithResourcesOnly] = useState(false)
  const [createInfo, setCreateInfo] = useState<XrdInfo | null>(null)
  const [browseInfo, setBrowseInfo] = useState<XrdInfo | null>(null)
  const canProvision = useHasK8sPermission('crds.write')
  const qc = useQueryClient()

  const query = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      tiles.filter((t) => {
        if (family !== 'all' && t.family !== family) return false
        if (withResourcesOnly && t.items.length === 0) return false
        if (!query) return true
        const hay = [
          t.info.kind,
          t.info.humanSingular,
          t.info.humanPlural,
          t.description,
          t.info.group,
          t.info.plural,
          t.family,
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(query)
      }),
    [tiles, family, withResourcesOnly, query],
  )

  const anyLoading = xrdsQ.isLoading || queries.some((q) => q.isLoading)

  const total = tiles.reduce((acc, t) => acc + t.items.length, 0)
  const totalReady = tiles.reduce((acc, t) => acc + t.ready, 0)
  const totalNotReady = tiles.reduce((acc, t) => acc + t.notReady, 0)
  const totalUnreported = tiles.reduce((acc, t) => acc + t.unreported, 0)
  const errorKinds = tiles.filter((t) => t.error && t.error.status !== 404).length

  const visibleFamilies = FAMILIES.filter((f) => filtered.some((t) => t.family === f.id))

  // XRD discovery failed outright (not merely empty) — be honest.
  if (xrdsQ.isError) {
    return (
      <div className="rounded-2xl border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-12 text-center">
        <p className="text-sm font-medium text-content">Couldn’t discover Adhar Resources</p>
        <p className="mt-1 text-[12px] text-content-muted">
          {(xrdsQ.error as Error).message}. The Crossplane apiextensions API must be reachable to
          list CompositeResourceDefinitions.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Hero
        total={total}
        ready={totalReady}
        notReady={totalNotReady}
        unreported={totalUnreported}
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

      {xrdsQ.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} height={190} rounded="lg" />
          ))}
        </div>
      ) : tiles.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-edge-default bg-surface-raised px-6 py-12 text-center">
          <p className="text-sm font-medium text-content">No Adhar Resources installed</p>
          <p className="mt-1 text-[12px] text-content-muted">
            No <code className="font-mono">CompositeResourceDefinitions</code> are registered on this
            cluster yet. Install the Adhar Platform Crossplane stack to populate the catalog.
          </p>
        </div>
      ) : visibleFamilies.length === 0 ? (
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
                  <KindCard
                    key={t.info.kind}
                    tile={t}
                    familyTone={f.tone}
                    canProvision={canProvision && !isManaged(t.info)}
                    onCreate={() => setCreateInfo(t.info)}
                    onBrowse={() => setBrowseInfo(t.info)}
                  />
                ))}
              </div>
            </section>
          )
        })
      )}

      {createInfo ? (
        <ClaimFormModal
          config={configFromXrd(createInfo)}
          mode="create"
          onClose={() => setCreateInfo(null)}
          onApplied={() => {
            qc.invalidateQueries({ queryKey: ['platform', 'catalog', createInfo.plural, cluster] })
            setCreateInfo(null)
          }}
        />
      ) : null}

      {browseInfo ? (
        <BrowseModal info={browseInfo} onClose={() => setBrowseInfo(null)} />
      ) : null}
    </div>
  )
}

/* ───── browse overlay — full list + drawer + topology for any kind ───── */

function BrowseModal({ info, onClose }: { info: XrdInfo; onClose(): void }) {
  if (typeof document === 'undefined') return null
  const cur = curationFor(info.kind)
  useOverlayDismiss(true, onClose)

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 bg-scrim/40 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="relative w-full max-w-6xl rounded-2xl border border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-center justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              {cur.label ?? info.humanPlural}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">
              {info.kind}
            </h2>
            <div className="mt-0.5 font-mono text-[11px] text-content-muted">
              {info.group}/{info.version}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>
        <div className="p-6">
          <XrList config={configFromXrd(info)} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ───── hero / summary band ───── */

function Hero({
  total,
  ready,
  notReady,
  unreported,
  kinds,
  errorKinds,
  loading,
}: {
  total: number
  ready: number
  notReady: number
  unreported: number
  kinds: number
  errorKinds: number
  loading: boolean
}) {
  // Only `notReady` is an alarm. `unreported` means an operator publishes no
  // readiness for its own CRs — worth showing, never worth colouring red.
  const stats: Array<{ label: string; value: string; hint: string; tone?: HealthTone }> = [
    { label: 'Kinds', value: String(kinds), hint: 'discovered' },
    { label: 'Resources', value: String(total), hint: 'live' },
    {
      label: 'Ready',
      value: `${ready}/${total}`,
      hint: 'reporting up',
      tone: total === 0 ? 'idle' : notReady > 0 ? 'degraded' : 'healthy',
    },
    {
      label: 'Attention',
      value: String(notReady),
      hint: notReady > 0 ? 'not ready' : 'none',
      tone: notReady > 0 ? 'degraded' : 'healthy',
    },
  ]
  if (unreported > 0) {
    stats.push({
      label: 'No status',
      value: String(unreported),
      hint: 'operator silent',
      tone: 'idle',
    })
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-edge-default bg-linear-to-br from-brand-50/70 dark:from-brand-500/10 via-surface-raised to-surface-raised p-4 shadow-sm sm:p-5">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-brand-400/10 blur-3xl"
      />
      {/* Stacks on a phone, sits side by side from `sm` up. */}
      <div className="relative flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-5">
        <div className="flex min-w-0 items-center gap-3">
          {/* The platform's own mark. These are Adhar's resource types, so the
              Adhar symbol is the honest identity for the page — it replaced a
              generic sparkles glyph. */}
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-surface-raised shadow-sm ring-1 ring-edge-subtle">
            <AdharSymbol size={28} />
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
              ) : notReady > 0 ? (
                <StatusBadge kind="degraded">{notReady} need attention</StatusBadge>
              ) : (
                <StatusBadge kind="healthy">all healthy</StatusBadge>
              )}
            </div>
            <p className="mt-0.5 max-w-xl text-[12px] leading-relaxed text-content-muted">
              Every kind here is discovered live from the cluster — Crossplane XRDs plus the
              operator CRDs actually installed. Readiness is read in each API group’s own
              vocabulary, so a Gateway is judged on <code className="font-mono">Programmed</code>,
              not on a condition it never publishes.
            </p>
          </div>
        </div>
        {/* 2 columns on a phone (the labels are short, the numbers are small),
            widening with the viewport. gap-x-6 at 368px content width left the
            numbers cramped, so the gap grows with the breakpoint too. */}
        <div className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-3 min-[420px]:grid-cols-3 sm:gap-x-6 lg:grid-cols-5">
          {stats.map((st) => (
            <StatTile
              key={st.label}
              label={st.label}
              value={st.value}
              hint={st.hint}
              tone={st.tone}
              loading={st.label === 'Kinds' ? false : loading}
            />
          ))}
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
      {/* `min-w-[16rem]` unconditionally was the page's only fixed floor: it
          forced the search onto its own row on every phone and overflowed below
          ~312px. Full width on a phone by intent, floored only once there is
          room for the rest of the toolbar beside it. */}
      <div className="w-full min-w-0 sm:w-auto sm:min-w-[16rem] sm:flex-1">
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
      <span className="ml-auto shrink-0 text-[11px] font-mono tabular-nums text-content-subtle">
        {shown}/{totalKinds} kinds
      </span>
    </div>
  )
}

/* ───── kind card ───── */

function KindCard({
  tile,
  familyTone,
  canProvision,
  onCreate,
  onBrowse,
}: {
  tile: Tile
  familyTone: string
  canProvision: boolean
  onCreate: () => void
  onBrowse: () => void
}) {
  const { info, items, ready, synced, syncedApplicable, notReady, unreported, loading, error, description } = tile
  const managed = isManaged(info)
  const total = items.length
  const notInstalled = error?.status === 404
  const failed = Boolean(error) && !notInstalled

  return (
    <article
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-raised p-4 shadow-sm',
        'transition-[transform,box-shadow,border-color] duration-150 ease-smooth',
        'hover:border-brand-200 dark:hover:border-brand-500/25 hover:shadow-md',
        // The lift is a pointer affordance. Unguarded, `hover:` sticks after a
        // tap on touch devices and the card stays raised until you tap
        // elsewhere — so it only applies where hover really exists.
        '[@media(hover:hover)]:hover:-translate-y-0.5',
      )}
    >
      {/* A hairline of the family's colour — enough to group the cards visually
          without another badge competing for space. */}
      <div
        aria-hidden
        className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-linear-to-r', familyTone)}
      />
      <div className="flex items-start justify-between gap-3">
        <div
          className={cn(
            'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br shadow-sm ring-1 ring-edge-subtle text-content',
            familyTone,
          )}
        >
          <BrandMark kind={info.kind} group={info.group} glyph={tile.icon} />
        </div>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-content-subtle">
          {info.namespaced ? 'namespaced' : 'cluster'}
        </span>
      </div>

      <div className="mt-2 min-w-0">
        <h4 className="truncate text-sm font-semibold text-content">
          <button
            type="button"
            onClick={onBrowse}
            className="outline-none after:absolute after:inset-0 after:rounded-2xl"
            aria-label={`Browse ${info.humanPlural}`}
          >
            {curationFor(info.kind).label ?? info.humanPlural}
          </button>
        </h4>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-content-muted">
          {description}
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
            <span className="font-semibold">Not installed</span> — this XRD isn’t registered yet.
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
          <>
            {/* Three across at every width. `grid-cols-1 sm:grid-cols-3` made
                each counter a full-width row on a phone, adding ~100px of
                height to every card for three two-digit numbers. */}
            <div className={cn('grid gap-2 text-center', syncedApplicable ? 'grid-cols-3' : 'grid-cols-2')}>
              <Counter label="Total" value={total} />
              <Counter
                label="Ready"
                value={`${ready}/${total}`}
                // Only a real notReady is a failure. A kind whose operator
                // publishes no status is not "0/1 degraded" — see readinessOf.
                tone={notReady > 0 ? 'degraded' : ready === total ? 'healthy' : 'idle'}
              />
              {syncedApplicable ? (
                <Counter
                  label="Synced"
                  value={`${synced}/${total}`}
                  tone={synced === total ? 'healthy' : 'degraded'}
                />
              ) : null}
            </div>
            {unreported > 0 ? (
              <p className="mt-2 text-[10.5px] leading-snug text-content-subtle">
                {unreported === total ? 'This operator' : `${unreported} of these`} publishes no
                readiness status — health is shown by its workload, not its CR.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-content-subtle">
        <code className="truncate font-mono" title={`${info.group}/${info.version}`}>
          {info.group}/{info.version}
        </code>
        {!loading && !notInstalled && !failed && tile.newest ? (
          <span className="shrink-0" title="Most recent claim">
            {age(tile.newest)}
          </span>
        ) : null}
      </div>

      {/* quick actions — relative/z-10 so they sit above the stretched button */}
      <div className="relative z-10 mt-3 flex items-center gap-2 border-t border-edge-subtle pt-3">
        <button
          type="button"
          onClick={onBrowse}
          className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-brand-600 px-3 text-xs font-medium text-white shadow-sm ring-1 ring-inset ring-white/10 outline-none transition-colors hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          Browse
        </button>
        {managed ? (
          // Operator-owned: creating one is the operator's concern, not a claim.
          <span
            className="inline-flex h-8 min-w-0 max-w-[9rem] shrink items-center justify-center overflow-hidden rounded-md border border-edge-default px-2.5 text-[10.5px] text-content-muted"
            title={`Managed by ${isManaged(info) ? info.provider : 'an operator'}`}
          >
            <span className="truncate">{isManaged(info) ? info.provider : 'operator-managed'}</span>
          </span>
        ) : canProvision ? (
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-edge-default bg-surface-raised px-3 text-xs font-medium text-content shadow-sm outline-none transition-colors hover:border-edge-strong hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-500/20"
            aria-label={`Create ${info.humanSingular}`}
          >
            <IconPlus /> Create
          </button>
        ) : (
          <span
            // shrink-0 + nowrap: this is the widest action variant, and inside a
            // 336px card on a phone the role pill next to a flex-1 "Browse" was
            // the one thing that could push the row past the card edge.
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-edge-default px-2.5 text-[11px] text-content-muted"
            title="Requires crds.write"
          >
            Create <K8sRolePill perm="crds.write" />
          </span>
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

/**
 * Readiness, per the vocabulary the object's own API group actually uses.
 *
 * This used to be `conditions.some(c => c.type === 'Ready' && c.status === 'True')`
 * and everything else was counted as degraded. On a perfectly healthy cluster
 * that reported **"4 not ready"**, and all four were lies (verified 2026-09-25):
 *
 *   • `Gateway` adhar-gateway / adhar-ai-gateway — Gateway API v1 has no `Ready`
 *     condition at all. It publishes `Accepted` and `Programmed`, both True,
 *     with 48 attached routes and an address assigned.
 *   • `KafkaNodePool` adhar-kafka-dual-role — Strimzi keeps readiness on the
 *     parent `Kafka`; the node pool ships `conditions: []` and a fully
 *     reconciled status (observedGeneration matches, broker roles assigned).
 *   • `Redis` redis — the Opstree operator never writes a status at all, so
 *     there is nothing to read. The pod was 2/2 Running the whole time.
 *
 * Reporting a healthy platform as broken is worse than reporting nothing: it
 * trains people to ignore the badge. So there are four outcomes, and only
 * `notReady` is a problem:
 *
 *   ready       — something the object itself asserts is up.
 *   notReady    — the object asserts it is NOT up. This is the only alarm.
 *   unreported  — the operator publishes no readiness at all. Not an alarm;
 *                 surfaced separately so it is visible but not alarming.
 *   deleting    — has a deletionTimestamp; counted in neither.
 */
export type Readiness = 'ready' | 'notReady' | 'unreported' | 'deleting'

/**
 * Condition types that assert "up", in precedence order. `Ready` first because
 * most operators use it; the rest cover the groups that deliberately do not.
 */
const READY_CONDITIONS = [
  'Ready', // Crossplane, CloudNativePG, cert-manager, Strimzi Kafka, most CRDs
  'Programmed', // Gateway API v1 — the listener/address are actually serving
  'Available', // Deployment-shaped status
  'Succeeded', // run-to-completion objects
  'Complete',
] as const

function conditionStatus(xr: XR, type: string): 'True' | 'False' | 'Unknown' | undefined {
  return (xr.status?.conditions ?? []).find((c) => c.type === type)?.status
}

export function readinessOf(xr: XR): Readiness {
  if (xr.metadata.deletionTimestamp) return 'deleting'

  for (const type of READY_CONDITIONS) {
    const st = conditionStatus(xr, type)
    if (st === 'True') return 'ready'
    // An explicit False is the object telling us it is broken — believe it.
    if (st === 'False') return 'notReady'
  }

  // No readiness vocabulary this object speaks. Fall back to the one universal
  // signal: has its controller caught up with the spec? `observedGeneration`
  // equal to `generation` means the operator has reconciled this exact revision
  // and raised no condition against it — which is how Strimzi's KafkaNodePool
  // reports a healthy pool.
  const observed = xr.status?.observedGeneration
  if (typeof observed === 'number' && typeof xr.metadata.generation === 'number') {
    return observed >= xr.metadata.generation ? 'ready' : 'notReady'
  }

  // Nothing to go on (the Opstree Redis case: `status` is absent entirely).
  return 'unreported'
}

/**
 * `Synced` is a Crossplane concept — it means the composition rendered and the
 * composed resources were applied. Operator-managed kinds never publish it, and
 * showing them a rose "Synced 0/N" invented a second phantom failure on every
 * non-Crossplane card. Only count it where at least one object speaks it.
 */
function syncedStats(items: XR[]): { applicable: boolean; synced: number } {
  const speaking = items.filter((x) => conditionStatus(x, 'Synced') !== undefined)
  return {
    applicable: speaking.length > 0,
    synced: speaking.filter((x) => conditionStatus(x, 'Synced') === 'True').length,
  }
}

/* ───── brand marks ───── */

/**
 * The real logo for a kind, when the platform ships one.
 *
 * Two rules, in order:
 *   1. Anything in an `adhar.io` group is one of the platform's OWN abstractions
 *      (CompositeCluster, CompositeDatabase, …) — it carries the Adhar symbol.
 *   2. An operator-managed kind carries its upstream project's official mark
 *      where `shell-ui/brand-icons` has one.
 * Everything else falls back to the line glyph, which is still better than a
 * wrong logo.
 */
function BrandMark({ kind, group, glyph }: { kind: string; group: string; glyph: GlyphId }) {
  if (group.endsWith('adhar.io')) return <AdharSymbol size={20} />

  // Strimzi covers Kafka, KafkaTopic, KafkaConnect and KafkaNodePool.
  if (kind.startsWith('Kafka')) return <KafkaIcon size={22} />
  if (kind === 'RabbitmqCluster') return <RabbitMQIcon size={22} />
  // The MinIO operator's CR is simply `Tenant`.
  if (kind === 'Tenant') return <MinIOIcon size={22} />
  // The platform's Gateways are served by Cilium's Gateway API implementation.
  if (kind === 'Gateway' || kind === 'GatewayClass') return <CiliumIcon size={22} />

  return <KindGlyph icon={glyph} />
}

/* ───── glyphs ───── */

function KindGlyph({ icon }: { icon: GlyphId }) {
  switch (icon) {
    case 'app':
      return <IconAppBox />
    case 'bolt':
      return <IconBolt />
    case 'route':
      return <IconRoute />
    case 'git':
      return <IconGitBranch />
    case 'database':
      return <IconDatabase />
    case 'zap':
      return <IconZap />
    case 'archive':
      return <IconArchive />
    case 'radio':
      return <IconRadio />
    case 'layers':
      return <IconLayers />
    case 'waves':
      return <IconWaves />
    case 'compass':
      return <IconCompass />
    case 'globe':
      return <IconGlobe />
    case 'scale':
      return <IconScale />
    case 'file':
      return <IconFileCode />
    case 'shield':
      return <IconShield />
    case 'certificate':
      return <IconCertificate />
    case 'key':
      return <IconKey />
    case 'gauge':
      return <IconGauge />
    case 'eye':
      return <IconEye />
    case 'coins':
      return <IconCoins />
    case 'network':
      return <IconNetwork />
    case 'cluster':
      return <IconCluster />
    default:
      return <IconFileCode />
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
const IconGauge = () => <SVG>{<><path d="M12 14 8 10" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /><circle cx="12" cy="14" r="1.5" /></>}</SVG>
const IconEye = () => <SVG>{<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>}</SVG>
const IconCoins = () => <SVG>{<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6a8 3 0 0 0 16 0V6" /><path d="M4 12v6a8 3 0 0 0 16 0v-6" /></>}</SVG>
const IconNetwork = () => <SVG>{<><rect x="9" y="2" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="16" y="16" width="6" height="6" rx="1" /><path d="M12 8v4" /><path d="M5 16v-1a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1" /></>}</SVG>
const IconCluster = () => <SVG>{<><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M12 7.5v4" /><path d="M12 11.5 6.5 16" /><path d="M12 11.5 17.5 16" /></>}</SVG>
const IconSearch = () => <SVG>{<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>}</SVG>
const IconPlus = () => <SVG>{<><path d="M12 5v14" /><path d="M5 12h14" /></>}</SVG>
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
