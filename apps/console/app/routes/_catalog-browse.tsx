import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from '@tanstack/react-router'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field as FormField,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  Textarea,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  type Entity,
  type EntityKind,
  type EntityOrigin,
  entityRef,
  findEntity,
  KIND_LABEL,
  type Lifecycle,
  LIFECYCLE_TONE,
  parseRef,
  useCatalog,
  useRegisterEntity,
} from '~/data/catalog.ts'
import { parseApiDefinition, type ParsedApi, type SourceStatus } from '~/data/catalog-live.ts'
import type { CatalogSearch } from './catalog.tsx'
import {
  deleteView,
  isStarred,
  pushRecentlyViewed,
  saveView,
  toggleStar,
  useRecentlyViewed,
  useSavedViews,
  useStars,
} from '~/data/catalog-prefs.ts'

/**
 * Service Catalog — homepage-style fresh layout.
 *
 *   ┌─ Header: title + search + actions ────────────────────────────────┐
 *   │ ─ Spotlight: 3 featured Systems ─                                 │
 *   │ ─ Browse by Domain ─                                              │
 *   │ ─ Teams overview ─                                                │
 *   │ ─ Browse all (filterable grid) ─                                  │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * The drawer remains the canonical detail view — every entity card / chip
 * opens it, preserving the dependency-graph navigation flow.
 */

type SearchState = CatalogSearch

type QuickFilter = 'all' | 'starred' | 'production' | 'recent' | 'attention' | 'mine'
type ViewMode = 'grid' | 'table' | 'compact'
type SortKey = 'name' | 'recent' | 'lifecycle'
type Tristate = null | true | false

interface FilterState {
  kinds: Set<EntityKind>
  lifecycles: Set<Lifecycle>
  owner: string
  system: string
  tags: Set<string>
  quick: QuickFilter
  hasOwner: Tristate
  hasDocs: Tristate
  hasRunbook: Tristate
}

function emptyFilter(initial: { kind?: EntityKind | undefined } = {}): FilterState {
  return {
    kinds: initial.kind ? new Set([initial.kind]) : new Set(),
    lifecycles: new Set(),
    owner: 'all',
    system: 'all',
    tags: new Set(),
    quick: 'all',
    hasOwner: null,
    hasDocs: null,
    hasRunbook: null,
  }
}

/* ─────────── URL <-> filter mapping (shareable / back-button-friendly) ─────────── */

const csv = (v: string | undefined): string[] =>
  v
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : []
const triFromStr = (v: 'yes' | 'no' | undefined): Tristate =>
  v === 'yes' ? true : v === 'no' ? false : null
const triToStr = (v: Tristate): 'yes' | 'no' | undefined =>
  v === true ? 'yes' : v === false ? 'no' : undefined

function filterFromSearch(search: SearchState): FilterState {
  return {
    kinds: new Set(csv(search.kind) as EntityKind[]),
    lifecycles: new Set(csv(search.lifecycle) as Lifecycle[]),
    owner: search.owner ?? 'all',
    system: search.system ?? 'all',
    tags: new Set(csv(search.tags)),
    quick: (search.quick as QuickFilter | undefined) ?? 'all',
    hasOwner: triFromStr(search.ho),
    hasDocs: triFromStr(search.hd),
    hasRunbook: triFromStr(search.hr),
  }
}

/** The subset of search params owned by the filter panel (view/sort/q untouched). */
function searchFromFilter(f: FilterState): Partial<SearchState> {
  return {
    kind: f.kinds.size ? Array.from(f.kinds).join(',') : undefined,
    lifecycle: f.lifecycles.size ? Array.from(f.lifecycles).join(',') : undefined,
    owner: f.owner !== 'all' ? f.owner : undefined,
    system: f.system !== 'all' ? f.system : undefined,
    tags: f.tags.size ? Array.from(f.tags).join(',') : undefined,
    quick: f.quick !== 'all' ? (f.quick as SearchState['quick']) : undefined,
    ho: triToStr(f.hasOwner),
    hd: triToStr(f.hasDocs),
    hr: triToStr(f.hasRunbook),
  }
}

/** All resettable search keys set to undefined — applied before a saved view. */
const EMPTY_FILTER_SEARCH: Partial<SearchState> = {
  kind: undefined,
  lifecycle: undefined,
  owner: undefined,
  system: undefined,
  tags: undefined,
  quick: undefined,
  ho: undefined,
  hd: undefined,
  hr: undefined,
  q: undefined,
  view: undefined,
  sort: undefined,
}

/** Serialise the current search into a plain string record for a saved view. */
function searchToRecord(s: SearchState): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === 'section') continue
    if (typeof v === 'string' && v) out[k] = v
  }
  return out
}

/* ─────────── "owned by me" resolution ─────────── */

function computeMyOwnerRefs(list: Entity[], user: { email?: string; name?: string }): Set<string> {
  const refs = new Set<string>()
  const email = user.email?.toLowerCase()
  const localPart = email?.split('@')[0]
  const name = user.name?.toLowerCase()
  for (const e of list) {
    if (e.kind !== 'User') continue
    const matches =
      (email && e.spec.email?.toLowerCase() === email) ||
      (localPart && e.metadata.name.toLowerCase() === localPart) ||
      (name && (e.metadata.title ?? '').toLowerCase() === name)
    if (matches) refs.add(entityRef(e))
  }
  // Any group I'm a member of counts as "mine" too.
  for (const g of list) {
    if (g.kind !== 'Group') continue
    if ((g.spec.members ?? []).some((m) => refs.has(m))) refs.add(entityRef(g))
  }
  return refs
}

function isOwnedByMe(e: Entity, mine: Set<string>): boolean {
  return Boolean(e.spec.owner && mine.has(e.spec.owner))
}

function activeFilterCount(f: FilterState): number {
  return (
    (f.kinds.size > 0 ? 1 : 0) +
    (f.lifecycles.size > 0 ? 1 : 0) +
    (f.owner !== 'all' ? 1 : 0) +
    (f.system !== 'all' ? 1 : 0) +
    (f.tags.size > 0 ? 1 : 0) +
    (f.quick !== 'all' ? 1 : 0) +
    (f.hasOwner !== null ? 1 : 0) +
    (f.hasDocs !== null ? 1 : 0) +
    (f.hasRunbook !== null ? 1 : 0)
  )
}

export function CatalogBrowse({ search }: { search: SearchState }) {
  const q = useCatalog()
  const list = q.data
  const stars = useStars()
  const recents = useRecentlyViewed()
  const savedViews = useSavedViews()
  const user = useOptionalSession()?.user ?? STUB_USER
  const navigate = useNavigate()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<Entity | null>(null)
  const [text, setText] = useState<string>(search.q ?? '')

  // Filter / view / sort are derived from the URL so the state is shareable and
  // survives back/forward navigation.
  const filter = useMemo(() => filterFromSearch(search), [search])
  const view: ViewMode = search.view ?? 'grid'
  const sort: SortKey = search.sort ?? 'name'
  const [registerOpen, setRegisterOpen] = useState(false)

  const patchSearch = useCallback(
    (patch: Partial<SearchState>, opts?: { replace?: boolean }) => {
      void navigate({
        to: '/catalog',
        // Unscoped `useNavigate` widens `prev` to the union of all route
        // searches; we only ever touch /catalog's keys, so cast the reducer.
        search: ((prev: SearchState) => ({ ...prev, ...patch })) as never,
        replace: opts?.replace ?? false,
      })
    },
    [navigate],
  )
  const setFilter = useCallback(
    (next: FilterState) => patchSearch(searchFromFilter(next)),
    [patchSearch],
  )
  const setView = useCallback(
    (v: ViewMode) => patchSearch({ view: v === 'grid' ? undefined : v }),
    [patchSearch],
  )
  const setSort = useCallback(
    (s: SortKey) => patchSearch({ sort: s === 'name' ? undefined : s }),
    [patchSearch],
  )

  // Keep the local search box responsive; debounce the push into the URL so a
  // keystroke doesn't create a history entry per character.
  const searchQRef = useRef(search.q)
  searchQRef.current = search.q
  useEffect(() => setText(search.q ?? ''), [search.q])
  useEffect(() => {
    const h = setTimeout(() => {
      const next = text.trim() || undefined
      if (next !== (searchQRef.current ?? undefined)) {
        void navigate({
          to: '/catalog',
          search: ((prev: SearchState) => ({ ...prev, q: next })) as never,
          replace: true,
        })
      }
    }, 300)
    return () => clearTimeout(h)
  }, [text, navigate])

  // `/` focuses the search input. Skip when typing in another field/editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return
      e.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  const openEntity = useCallback((e: Entity) => {
    pushRecentlyViewed(entityRef(e))
    setSelected(e)
  }, [])

  const myOwnerRefs = useMemo(() => computeMyOwnerRefs(list, user), [list, user])
  const mineCount = useMemo(
    () => (myOwnerRefs.size ? list.filter((e) => isOwnedByMe(e, myOwnerRefs)).length : 0),
    [list, myOwnerRefs],
  )

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const e of list) out[e.kind] = (out[e.kind] ?? 0) + 1
    return out
  }, [list])

  const coverage = useMemo(() => buildCoverage(list), [list])

  const recentEntities = useMemo(
    () =>
      recents
        .map((r) => findEntity(list, r))
        .filter((e): e is Entity => Boolean(e))
        .slice(0, 6),
    [recents, list],
  )

  const starredEntities = useMemo(
    () => stars.map((r) => findEntity(list, r)).filter((e): e is Entity => Boolean(e)),
    [stars, list],
  )

  const featuredSystems = useMemo(
    () =>
      list
        .filter((e) => e.kind === 'System')
        .map((sys) => buildSystemSummary(sys, list))
        .sort((a, b) => b.totals - a.totals)
        .slice(0, 3),
    [list],
  )

  const domains = useMemo(
    () =>
      list
        .filter((e) => e.kind === 'Domain')
        .map((dom) => ({
          domain: dom,
          systems: list.filter((e) => e.kind === 'System' && e.spec.domain === entityRef(dom)),
        })),
    [list],
  )

  const teams = useMemo(
    () =>
      list
        .filter((e) => e.kind === 'Group' && (e.spec.members?.length ?? 0) > 0)
        .map((g) => ({
          group: g,
          owns: list.filter((e) => e.spec.owner === entityRef(g)).length,
        }))
        .sort((a, b) => b.owns - a.owns),
    [list],
  )

  // Recency cutoff for "Recently updated" quick filter — last 14 days.
  const RECENT_MS = 14 * 86_400_000

  const filtered = useMemo(() => {
    const lower = text.trim().toLowerCase()
    const now = Date.now()
    const starSet = new Set(stars)
    const out = list.filter((e) => {
      if (filter.kinds.size > 0 && !filter.kinds.has(e.kind)) return false
      if (
        filter.lifecycles.size > 0 &&
        (!e.spec.lifecycle || !filter.lifecycles.has(e.spec.lifecycle))
      ) {
        return false
      }
      if (filter.owner !== 'all' && (e.spec.owner ?? '') !== filter.owner) return false
      if (filter.system !== 'all' && (e.spec.system ?? '') !== filter.system) return false
      if (filter.tags.size > 0) {
        const tagSet = new Set(e.metadata.tags ?? [])
        let any = false
        for (const t of filter.tags) {
          if (tagSet.has(t)) {
            any = true
            break
          }
        }
        if (!any) return false
      }
      if (filter.quick === 'starred' && !starSet.has(entityRef(e))) return false
      if (filter.quick === 'production' && e.spec.lifecycle !== 'production') return false
      if (filter.quick === 'recent') {
        const stamp = e.metadata.updatedAt ?? e.metadata.createdAt
        if (!stamp) return false
        const ms = new Date(stamp).getTime()
        if (Number.isNaN(ms) || now - ms > RECENT_MS) return false
      }
      if (filter.quick === 'attention' && !needsAttention(e)) return false
      if (filter.quick === 'mine' && !isOwnedByMe(e, myOwnerRefs)) return false
      if (filter.hasOwner !== null && Boolean(e.spec.owner) !== filter.hasOwner) return false
      const links = e.metadata.links ?? []
      if (filter.hasDocs !== null && links.some((l) => l.icon === 'docs') !== filter.hasDocs) {
        return false
      }
      if (
        filter.hasRunbook !== null &&
        links.some((l) => l.icon === 'runbook') !== filter.hasRunbook
      ) {
        return false
      }
      if (!lower) return true
      return (
        e.metadata.name.toLowerCase().includes(lower) ||
        (e.metadata.title ?? '').toLowerCase().includes(lower) ||
        (e.metadata.description ?? '').toLowerCase().includes(lower) ||
        (e.metadata.tags ?? []).some((t) => t.toLowerCase().includes(lower))
      )
    })
    return sortEntities(out, sort)
  }, [list, filter, text, stars, sort, myOwnerRefs])

  const filterCount = activeFilterCount(filter)
  const isFiltering = Boolean(text) || filterCount > 0

  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of list) {
      for (const t of e.metadata.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
  }, [list])

  const owners = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of list) {
      if (!e.spec.owner) continue
      counts.set(e.spec.owner, (counts.get(e.spec.owner) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count, label: parseRef(value).name }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [list])

  const systems = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of list) {
      if (!e.spec.system) continue
      counts.set(e.spec.system, (counts.get(e.spec.system) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count, label: parseRef(value).name }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [list])

  const attentionCount = useMemo(() => list.filter(needsAttention).length, [list])

  return (
    <div className="space-y-8">
      <CatalogHeader onRegister={() => setRegisterOpen(true)} />

      <SourceBanner sources={q.sources} offline={q.offline} live={q.live} loading={q.isLoading} />

      <CoveragePanel coverage={coverage} stars={stars.length} attention={attentionCount} />

      {!isFiltering && starredEntities.length > 0 ? (
        <StarredRow entities={starredEntities} onPick={openEntity} />
      ) : null}

      {!isFiltering && recentEntities.length > 0 ? (
        <RecentRow entities={recentEntities} onPick={openEntity} />
      ) : null}

      {!isFiltering && (
        <>
          <Spotlight systems={featuredSystems} onPick={openEntity} />
          <ByDomain domains={domains} catalog={list} onPick={openEntity} />
          <TeamsOverview teams={teams} onPick={openEntity} />
        </>
      )}

      <BrowseAll
        list={filtered}
        total={list.length}
        kindCounts={counts}
        owners={owners}
        systems={systems}
        allTags={allTags}
        starsCount={stars.length}
        attentionCount={attentionCount}
        mineCount={mineCount}
        filter={filter}
        onFilter={setFilter}
        onClearFilters={() => patchSearch(searchFromFilter(emptyFilter()))}
        view={view}
        onView={setView}
        sort={sort}
        onSort={setSort}
        stars={stars}
        onPick={openEntity}
        loading={q.isLoading}
        searching={isFiltering}
        filterCount={filterCount}
        text={text}
        onText={setText}
        onClearSearch={() => setText('')}
        searchInputRef={searchInputRef}
        savedViews={savedViews}
        onSaveView={(name) => saveView(name, searchToRecord(search))}
        onApplyView={(v) =>
          patchSearch({ ...EMPTY_FILTER_SEARCH, ...(v.search as Partial<SearchState>) })
        }
        onDeleteView={deleteView}
      />

      {selected ? (
        <EntityDrawer
          entity={selected}
          onClose={() => setSelected(null)}
          catalog={list}
          onPick={openEntity}
          stars={stars}
        />
      ) : null}

      <RegisterExistingModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onCreated={(e) => {
          setRegisterOpen(false)
          openEntity(e)
        }}
        owners={owners}
        systems={systems}
      />
    </div>
  )
}

/* ─────────── coverage / signals ─────────── */

interface Coverage {
  total: number
  withOwner: number
  withSystem: number
  withDocs: number
  withRunbook: number
  byLifecycle: Record<string, number>
}

function buildCoverage(list: Entity[]): Coverage {
  const out: Coverage = {
    total: list.length,
    withOwner: 0,
    withSystem: 0,
    withDocs: 0,
    withRunbook: 0,
    byLifecycle: {},
  }
  for (const e of list) {
    if (e.spec.owner) out.withOwner++
    if (e.spec.system) out.withSystem++
    const links = e.metadata.links ?? []
    if (links.some((l) => l.icon === 'docs')) out.withDocs++
    if (links.some((l) => l.icon === 'runbook')) out.withRunbook++
    const lc = e.spec.lifecycle ?? 'unknown'
    out.byLifecycle[lc] = (out.byLifecycle[lc] ?? 0) + 1
  }
  return out
}

function needsAttention(e: Entity): boolean {
  // Only entities that should have a tech owner — skip Groups/Users/Domains.
  if (e.kind === 'User' || e.kind === 'Group' || e.kind === 'Domain') return false
  if (!e.spec.owner) return true
  if (!e.spec.lifecycle) return true
  if (e.spec.lifecycle === 'deprecated') return true
  // Production entities without a runbook are an attention target.
  if (e.spec.lifecycle === 'production' && e.kind === 'Component') {
    const links = e.metadata.links ?? []
    if (!links.some((l) => l.icon === 'runbook')) return true
  }
  return false
}

/* ─────────── header ─────────── */

function CatalogHeader({ onRegister }: { onRegister(): void }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
          Adhar Platform
        </div>
        <h1 className="mt-1 text-[28px] font-semibold tracking-tight text-content">
          Service Catalog
        </h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-content-muted">
          Every service, API, resource, and team the organisation depends on — registered, owned,
          and traceable. Click any entity to see its dependencies, owners, runbooks, and live links.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRegister}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-[13px] font-medium text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
        >
          <span className="text-content-subtle">
            <IconRegister />
          </span>
          Register existing
        </button>
        <Link
          to="/catalog"
          search={{ section: 'create' } as never}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-600 px-3 text-[13px] font-semibold text-white shadow-sm transition-colors visited:text-white hover:bg-brand-700 hover:text-white"
        >
          <span className="text-white">
            <IconPlus />
          </span>
          <span className="text-white">Create new</span>
        </Link>
      </div>
    </header>
  )
}

/* ─────────── coverage panel ─────────── */

function CoveragePanel({
  coverage,
  stars,
  attention,
}: {
  coverage: Coverage
  stars: number
  attention: number
}) {
  const total = Math.max(1, coverage.total)
  const tiles = [
    {
      label: 'Production tier',
      value: `${coverage.byLifecycle.production ?? 0}`,
      sub: `${coverage.total} total entities`,
      pct: ((coverage.byLifecycle.production ?? 0) / total) * 100,
      tone: 'emerald' as const,
      icon: <IconShield />,
    },
    {
      label: 'Ownership',
      value: `${pct(coverage.withOwner, total)}%`,
      sub: `${coverage.withOwner}/${coverage.total} have an owner`,
      pct: (coverage.withOwner / total) * 100,
      tone: 'brand' as const,
      icon: <IconUsers />,
    },
    {
      label: 'Documentation',
      value: `${pct(coverage.withDocs, total)}%`,
      sub: `${coverage.withDocs}/${coverage.total} link a docs site`,
      pct: (coverage.withDocs / total) * 100,
      tone: 'sky' as const,
      icon: <IconBookOpen size={14} />,
    },
    {
      label: 'Needs attention',
      value: String(attention),
      sub: attention > 0 ? `Missing owner, runbook, or lifecycle` : 'All key signals present',
      pct: 100 - (attention / total) * 100,
      tone: attention > 0 ? ('amber' as const) : ('emerald' as const),
      icon: <IconAlert />,
    },
  ]
  return (
    <section className="space-y-3">
      <SectionHeader
        eyebrow="Health"
        title="Catalog coverage"
        right={
          stars > 0 ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-amber-500">
                <IconStarFilled />
              </span>
              {stars} starred
            </span>
          ) : null
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <CoverageTile key={t.label} {...t} />
        ))}
      </div>
    </section>
  )
}

function CoverageTile({
  label,
  value,
  sub,
  pct,
  tone,
  icon,
}: {
  label: string
  value: string
  sub: string
  pct: number
  tone: 'brand' | 'emerald' | 'sky' | 'amber'
  icon: React.ReactNode
}) {
  const tones: Record<typeof tone, { bg: string; text: string; bar: string }> = {
    brand: { bg: 'bg-brand-50', text: 'text-brand-700', bar: 'bg-brand-500' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', bar: 'bg-emerald-500' },
    sky: { bg: 'bg-sky-50', text: 'text-sky-700', bar: 'bg-sky-500' },
    amber: { bg: 'bg-amber-50', text: 'text-amber-800', bar: 'bg-amber-500' },
  }
  const T = tones[tone]
  return (
    <div className="overflow-hidden rounded-2xl border border-edge-default bg-white shadow-sm">
      <div className="flex items-start justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            {label}
          </div>
          <div className="mt-1 font-mono text-[20px] font-semibold tabular-nums leading-none text-content">
            {value}
          </div>
          <div className="mt-1 truncate text-[11px] text-content-muted">{sub}</div>
        </div>
        <span
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-edge-subtle',
            T.bg,
            T.text,
          )}
        >
          {icon}
        </span>
      </div>
      <div className="h-1 w-full bg-surface-sunken">
        <div
          className={cn('h-full transition-[width]', T.bar)}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  )
}

function pct(part: number, total: number): number {
  return Math.round((part / total) * 100)
}

/* ─────────── source banner (live k8s / gitea health) ─────────── */

function SourceBanner({
  sources,
  offline,
  live,
  loading,
}: {
  sources: SourceStatus[]
  offline: boolean
  live: boolean
  loading: boolean
}) {
  if (offline) {
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-800"
      >
        <span className="mt-0.5 shrink-0">
          <IconAlert />
        </span>
        <div>
          <span className="font-semibold">Showing the bundled sample catalog.</span> No live cluster
          or registered entities are reachable — the data below is illustrative, not from your
          environment.
        </div>
      </div>
    )
  }
  if (loading && sources.every((s) => s.state === 'loading')) return null
  const notable = sources.some((s) => s.state === 'error' || s.state === 'empty')
  if (!notable && !live) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge-default bg-white px-4 py-2 text-[11px] shadow-sm">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        Live sources
      </span>
      {sources.map((s) => (
        <SourceChip key={s.id} status={s} />
      ))}
    </div>
  )
}

function SourceChip({ status }: { status: SourceStatus }) {
  const dot =
    status.state === 'ok'
      ? 'bg-emerald-500'
      : status.state === 'error'
        ? 'bg-rose-500'
        : status.state === 'loading'
          ? 'bg-slate-400'
          : 'bg-amber-500'
  const detail =
    status.state === 'ok'
      ? `${status.count} ${status.count === 1 ? 'entity' : 'entities'}`
      : status.state === 'empty'
        ? 'no entities'
        : status.state === 'loading'
          ? 'checking…'
          : (status.error ?? 'unavailable')
  return (
    <span
      title={detail}
      className="inline-flex items-center gap-1.5 rounded-full border border-edge-default bg-surface-sunken/60 px-2 py-0.5 text-content-muted"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span className="font-medium text-content">{status.label}</span>
      <span className="text-content-subtle">· {detail}</span>
    </span>
  )
}

/* ─────────── starred + recent rows ─────────── */

function PinRow({
  label,
  icon,
  iconTone,
  count,
  entities,
  onPick,
}: {
  label: string
  icon: React.ReactNode
  iconTone: string
  count?: string
  entities: Entity[]
  onPick(e: Entity): void
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="inline-flex items-baseline gap-2">
          <span className={iconTone}>{icon}</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
            {label}
          </span>
        </div>
        {count ? <span className="text-[11px] text-content-muted">{count}</span> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {entities.map((e) => (
          <PinChip key={entityRef(e)} entity={e} onPick={onPick} />
        ))}
      </div>
    </section>
  )
}

function StarredRow({ entities, onPick }: { entities: Entity[]; onPick(e: Entity): void }) {
  return (
    <PinRow
      label="Starred"
      icon={<IconStarFilled />}
      iconTone="text-amber-500"
      count={`${entities.length} ${entities.length === 1 ? 'entity' : 'entities'}`}
      entities={entities}
      onPick={onPick}
    />
  )
}

function RecentRow({ entities, onPick }: { entities: Entity[]; onPick(e: Entity): void }) {
  return (
    <PinRow
      label="Recently viewed"
      icon={<IconClock />}
      iconTone="text-content-subtle"
      entities={entities}
      onPick={onPick}
    />
  )
}

function PinChip({ entity, onPick }: { entity: Entity; onPick(e: Entity): void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(entity)}
      className="group inline-flex items-center gap-2 rounded-full border border-edge-default bg-white py-1 pl-1 pr-3 text-left text-[12px] shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-brand-300/70 hover:shadow-md"
    >
      <KindGlyph kind={entity.kind} type={entity.spec.type} />
      <span className="truncate font-medium text-content">
        {entity.metadata.title ?? entity.metadata.name}
      </span>
    </button>
  )
}

/* ─────────── spotlight systems ─────────── */

interface SystemSummary {
  system: Entity
  components: Entity[]
  apis: Entity[]
  resources: Entity[]
  totals: number
}

function buildSystemSummary(sys: Entity, list: Entity[]): SystemSummary {
  const ref = entityRef(sys)
  const inSystem = list.filter((e) => e.spec.system === ref)
  return {
    system: sys,
    components: inSystem.filter((e) => e.kind === 'Component'),
    apis: inSystem.filter((e) => e.kind === 'API'),
    resources: inSystem.filter((e) => e.kind === 'Resource'),
    totals: inSystem.length,
  }
}

function Spotlight({ systems, onPick }: { systems: SystemSummary[]; onPick(e: Entity): void }) {
  if (!systems.length) return null
  return (
    <section className="space-y-3">
      <SectionHeader eyebrow="Spotlight" title="Most active systems" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {systems.map((s) => (
          <SystemCard key={entityRef(s.system)} summary={s} onPick={onPick} />
        ))}
      </div>
    </section>
  )
}

function SystemCard({ summary, onPick }: { summary: SystemSummary; onPick(e: Entity): void }) {
  const { system, components, apis, resources } = summary
  const ownerName = system.spec.owner ? parseRef(system.spec.owner).name : null
  return (
    <button
      type="button"
      onClick={() => onPick(system)}
      className="group relative flex h-full flex-col items-stretch overflow-hidden rounded-2xl border border-edge-default bg-white text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-300/70 hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500"
    >
      <div className="relative bg-linear-to-br from-violet-50/60 to-white px-5 py-5">
        <div className="flex items-start justify-between gap-2">
          <KindGlyph kind="System" size="lg" />
          {ownerName ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium text-content-muted ring-1 ring-edge-subtle">
              <IconUsers />
              {ownerName}
            </span>
          ) : null}
        </div>
        <h3 className="mt-3 text-[16px] font-semibold tracking-tight text-content">
          {system.metadata.title ?? system.metadata.name}
        </h3>
        {system.metadata.description ? (
          <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-content-muted">
            {system.metadata.description}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-3 divide-x divide-edge-subtle border-t border-edge-subtle bg-white text-center">
        <SystemStat label="Components" value={components.length} kind="Component" />
        <SystemStat label="APIs" value={apis.length} kind="API" />
        <SystemStat label="Resources" value={resources.length} kind="Resource" />
      </div>
    </button>
  )
}

function SystemStat({ label, value, kind }: { label: string; value: number; kind: EntityKind }) {
  return (
    <div className="flex items-center justify-center gap-2 px-3 py-3">
      <KindGlyph kind={kind} />
      <div className="text-left">
        <div className="font-mono text-base font-semibold tabular-nums leading-none text-content">
          {value}
        </div>
        <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          {label}
        </div>
      </div>
    </div>
  )
}

/* ─────────── by domain ─────────── */

function ByDomain({
  domains,
  catalog,
  onPick,
}: {
  domains: Array<{ domain: Entity; systems: Entity[] }>
  catalog: Entity[]
  onPick(e: Entity): void
}) {
  if (!domains.length) return null
  return (
    <section className="space-y-3">
      <SectionHeader eyebrow="Browse" title="By Domain" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {domains.map((d) => (
          <DomainCard
            key={entityRef(d.domain)}
            domain={d.domain}
            systems={d.systems}
            catalog={catalog}
            onPick={onPick}
          />
        ))}
      </div>
    </section>
  )
}

function DomainCard({
  domain,
  systems,
  catalog,
  onPick,
}: {
  domain: Entity
  systems: Entity[]
  catalog: Entity[]
  onPick(e: Entity): void
}) {
  const ownerName = domain.spec.owner ? parseRef(domain.spec.owner).name : null
  return (
    <article className="group flex h-full flex-col rounded-2xl border border-edge-default bg-white shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-edge-subtle px-5 py-4">
        <button
          type="button"
          onClick={() => onPick(domain)}
          className="flex min-w-0 items-start gap-3 text-left hover:text-brand-700"
        >
          <KindGlyph kind="Domain" size="lg" />
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-content group-hover:text-brand-700">
              {domain.metadata.title ?? domain.metadata.name}
            </h3>
            {domain.metadata.description ? (
              <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-content-muted">
                {domain.metadata.description}
              </p>
            ) : null}
          </div>
        </button>
        {ownerName ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-muted">
            <IconUsers />
            {ownerName}
          </span>
        ) : null}
      </header>
      <ul className="divide-y divide-edge-subtle">
        {systems.map((s) => (
          <li key={entityRef(s)}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition hover:bg-surface-sunken/50"
            >
              <div className="flex min-w-0 items-center gap-3">
                <KindGlyph kind="System" />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-content">
                    {s.metadata.title ?? s.metadata.name}
                  </div>
                  {s.metadata.description ? (
                    <div className="truncate text-[11px] text-content-muted">
                      {s.metadata.description}
                    </div>
                  ) : null}
                </div>
              </div>
              <SystemMiniStats system={s} catalog={catalog} />
            </button>
          </li>
        ))}
        {systems.length === 0 ? (
          <li className="px-5 py-3 text-[12px] italic text-content-subtle">
            No systems registered in this domain yet.
          </li>
        ) : null}
      </ul>
    </article>
  )
}

function SystemMiniStats({ system, catalog }: { system: Entity; catalog: Entity[] }) {
  const ref = entityRef(system)
  const inSystem = catalog.filter((e) => e.spec.system === ref)
  const c = inSystem.filter((e) => e.kind === 'Component').length
  const a = inSystem.filter((e) => e.kind === 'API').length
  const r = inSystem.filter((e) => e.kind === 'Resource').length
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-content-muted">
      <MiniPill label="C" value={c} />
      <MiniPill label="A" value={a} />
      <MiniPill label="R" value={r} />
    </div>
  )
}

function MiniPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono tabular-nums">
      <span className="text-content-subtle">{label}</span>
      <span className="text-content">{value}</span>
    </span>
  )
}

/* ─────────── teams overview ─────────── */

function TeamsOverview({
  teams,
  onPick,
}: {
  teams: Array<{ group: Entity; owns: number }>
  onPick(e: Entity): void
}) {
  if (!teams.length) return null
  return (
    <section className="space-y-3">
      <SectionHeader eyebrow="Ownership" title="Teams" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
        {teams.map((t) => (
          <TeamCard key={entityRef(t.group)} group={t.group} owns={t.owns} onPick={onPick} />
        ))}
      </div>
    </section>
  )
}

function TeamCard({
  group,
  owns,
  onPick,
}: {
  group: Entity
  owns: number
  onPick(e: Entity): void
}) {
  const memberCount = group.spec.members?.length ?? 0
  return (
    <button
      type="button"
      onClick={() => onPick(group)}
      className="group flex flex-col items-stretch gap-3 rounded-2xl border border-edge-default bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-300/70 hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500"
    >
      <div className="flex items-start justify-between gap-2">
        <KindGlyph kind="Group" size="lg" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-content-subtle opacity-0 transition-opacity group-hover:text-brand-700 group-hover:opacity-100">
          open →
        </span>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold leading-tight text-content">
          {group.metadata.title ?? group.metadata.name}
        </div>
        {group.metadata.description ? (
          <div className="mt-0.5 line-clamp-2 text-[11px] text-content-muted">
            {group.metadata.description}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3 border-t border-edge-subtle pt-2 text-[11px]">
        <span className="inline-flex items-center gap-1 text-content-muted">
          <IconUsers />
          <span className="font-mono tabular-nums">{memberCount}</span>
          <span className="text-content-subtle">members</span>
        </span>
        <span className="inline-flex items-center gap-1 text-content-muted">
          <span className="font-mono tabular-nums">{owns}</span>
          <span className="text-content-subtle">owned</span>
        </span>
      </div>
    </button>
  )
}

/* ─────────── browse all ─────────── */

/** Cap the initial render of very long lists; the rest is behind "Show more". */
const PAGE_SIZE = 60

function BrowseAll({
  list,
  total,
  kindCounts,
  owners,
  systems,
  allTags,
  starsCount,
  attentionCount,
  mineCount,
  filter,
  onFilter,
  onClearFilters,
  view,
  onView,
  sort,
  onSort,
  stars,
  onPick,
  loading,
  searching,
  filterCount,
  text,
  onText,
  onClearSearch,
  searchInputRef,
  savedViews,
  onSaveView,
  onApplyView,
  onDeleteView,
}: {
  list: Entity[]
  total: number
  kindCounts: Record<string, number>
  owners: Array<{ value: string; label: string; count: number }>
  systems: Array<{ value: string; label: string; count: number }>
  allTags: Array<{ value: string; count: number }>
  starsCount: number
  attentionCount: number
  mineCount: number
  filter: FilterState
  onFilter(next: FilterState): void
  onClearFilters(): void
  view: ViewMode
  onView(v: ViewMode): void
  sort: SortKey
  onSort(s: SortKey): void
  stars: readonly string[]
  onPick(e: Entity): void
  loading: boolean
  searching: boolean
  filterCount: number
  text: string
  onText(v: string): void
  onClearSearch(): void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  savedViews: SavedViewLike[]
  onSaveView(name: string): void
  onApplyView(v: SavedViewLike): void
  onDeleteView(name: string): void
}) {
  const [visible, setVisible] = useState(PAGE_SIZE)
  // Reset paging whenever the result set changes (filter / search / view).
  useEffect(() => setVisible(PAGE_SIZE), [list, view])

  const shown = list.slice(0, visible)
  const resultLabel = `${list.length} ${list.length === 1 ? 'result' : 'results'}${
    list.length !== total ? ` of ${total}` : ''
  }`

  return (
    <section className="space-y-3">
      <SectionHeader
        eyebrow={searching ? 'Search' : 'Browse'}
        title={searching ? 'Search results' : 'All entities'}
        right={
          <div className="flex items-center gap-2">
            <span aria-live="polite" className="tabular-nums">
              {resultLabel}
            </span>
            <SavedViewsMenu
              views={savedViews}
              onSave={onSaveView}
              onApply={onApplyView}
              onDelete={onDeleteView}
            />
            <ExportMenu list={list} />
          </div>
        }
      />

      <Toolbar
        filter={filter}
        onFilter={onFilter}
        kindCounts={kindCounts}
        owners={owners}
        systems={systems}
        allTags={allTags}
        starsCount={starsCount}
        attentionCount={attentionCount}
        mineCount={mineCount}
        view={view}
        onView={onView}
        sort={sort}
        onSort={onSort}
        filterCount={filterCount}
        text={text}
        onText={onText}
        onClearSearch={onClearSearch}
        searchInputRef={searchInputRef}
        loading={loading}
      />

      {loading ? (
        <div className="rounded-xl border border-edge-default bg-white p-10 text-center text-sm text-content-muted shadow-sm">
          <Spinner /> Loading catalog…
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title={searching ? 'No matching entities' : 'Nothing in the catalog yet'}
          description={
            searching
              ? 'No entity matches the current search and filters.'
              : 'Register an existing service or connect a cluster to populate the catalog.'
          }
          action={
            filterCount > 0 || text ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onClearFilters()
                  onClearSearch()
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : view === 'grid' ? (
        <div
          role="grid"
          aria-label="Catalog entities"
          onKeyDown={handleGridKeyNav}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
        >
          {shown.map((e) => (
            <EntityCard
              key={entityRef(e)}
              entity={e}
              starred={stars.includes(entityRef(e))}
              onClick={() => onPick(e)}
            />
          ))}
        </div>
      ) : view === 'compact' ? (
        <ul
          role="listbox"
          aria-label="Catalog entities"
          onKeyDown={handleGridKeyNav}
          className="overflow-hidden rounded-xl border border-edge-default bg-white shadow-sm"
        >
          {shown.map((e, i) => (
            <CompactRow
              key={entityRef(e)}
              entity={e}
              starred={stars.includes(entityRef(e))}
              onClick={() => onPick(e)}
              first={i === 0}
            />
          ))}
        </ul>
      ) : (
        <TableView rows={shown} stars={stars} onPick={onPick} />
      )}

      {!loading && visible < list.length ? (
        <div className="flex justify-center pt-1">
          <Button variant="secondary" size="sm" onClick={() => setVisible((v) => v + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, list.length - visible)} more · {list.length - visible} hidden
          </Button>
        </div>
      ) : null}
    </section>
  )
}

/* Minimal shape shared with catalog-prefs' SavedView to avoid a hard coupling. */
interface SavedViewLike {
  name: string
  search: Record<string, string>
}

/**
 * Keyboard grid navigation: arrow keys move focus between cards; Enter/Space
 * (handled on the card itself) opens the entity. Columns are estimated from the
 * live layout so Up/Down jump a row regardless of breakpoint.
 */
function handleGridKeyNav(e: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
  const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-entity-card]'))
  if (cards.length === 0) return
  const active = (
    typeof document !== 'undefined' ? document.activeElement : null
  ) as HTMLElement | null
  const idx = active ? cards.indexOf(active) : -1
  if (idx === -1) {
    e.preventDefault()
    cards[0].focus()
    return
  }
  let next = idx
  if (e.key === 'ArrowRight') next = idx + 1
  else if (e.key === 'ArrowLeft') next = idx - 1
  else {
    const cols = estimateColumns(cards)
    next = e.key === 'ArrowDown' ? idx + cols : idx - cols
  }
  if (next >= 0 && next < cards.length) {
    e.preventDefault()
    cards[next].focus()
  }
}

function estimateColumns(cards: HTMLElement[]): number {
  if (cards.length < 2) return 1
  const top = cards[0].offsetTop
  let cols = 1
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].offsetTop === top) cols++
    else break
  }
  return Math.max(1, cols)
}

/* ─────────── saved views + export menus ─────────── */

function SavedViewsMenu({
  views,
  onSave,
  onApply,
  onDelete,
}: {
  views: SavedViewLike[]
  onSave(name: string): void
  onApply(v: SavedViewLike): void
  onDelete(name: string): void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    globalThis.addEventListener('mousedown', away)
    return () => globalThis.removeEventListener('mousedown', away)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-edge-default bg-white px-2 text-[11px] font-medium text-content-muted shadow-sm hover:border-edge-strong hover:text-content"
      >
        Views
        {views.length ? (
          <span className="rounded-full bg-surface-sunken px-1 text-[10px] tabular-nums">
            {views.length}
          </span>
        ) : null}
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="pop-in absolute right-0 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-xl border border-edge-default bg-white shadow-xl"
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {views.length === 0 ? (
              <div className="px-3 py-2 text-[11px] italic text-content-subtle">
                No saved views yet.
              </div>
            ) : (
              views.map((v) => (
                <div
                  key={v.name}
                  className="group flex items-center justify-between gap-2 px-2 py-1 text-[12px] hover:bg-surface-sunken/60"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onApply(v)
                      setOpen(false)
                    }}
                    className="flex-1 truncate text-left text-content hover:text-brand-700"
                  >
                    {v.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(v.name)}
                    aria-label={`Delete view ${v.name}`}
                    className="opacity-0 transition group-hover:opacity-100 hover:text-rose-600"
                  >
                    <IconClose />
                  </button>
                </div>
              ))
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              const name =
                typeof globalThis.prompt === 'function' ? globalThis.prompt('Name this view') : null
              if (name && name.trim()) onSave(name.trim())
              setOpen(false)
            }}
            className="flex w-full items-center gap-1.5 border-t border-edge-subtle px-3 py-2 text-left text-[12px] font-medium text-brand-700 hover:bg-brand-50"
          >
            <IconPlus />
            Save current view
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ExportMenu({ list }: { list: Entity[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    globalThis.addEventListener('mousedown', away)
    return () => globalThis.removeEventListener('mousedown', away)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={list.length === 0}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-edge-default bg-white px-2 text-[11px] font-medium text-content-muted shadow-sm hover:border-edge-strong hover:text-content disabled:opacity-50"
      >
        Export
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="pop-in absolute right-0 top-full z-30 mt-1.5 w-40 overflow-hidden rounded-xl border border-edge-default bg-white py-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              downloadFile(
                'catalog.json',
                JSON.stringify(stripOrigin(list), null, 2),
                'application/json',
              )
              setOpen(false)
            }}
            className="block w-full px-3 py-1.5 text-left text-[12px] text-content hover:bg-surface-sunken/60"
          >
            Download JSON
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              downloadFile('catalog.yaml', toYaml(stripOrigin(list)), 'text/yaml')
              setOpen(false)
            }}
            className="block w-full px-3 py-1.5 text-left text-[12px] text-content hover:bg-surface-sunken/60"
          >
            Download YAML
          </button>
        </div>
      ) : null}
    </div>
  )
}

function stripOrigin(list: Entity[]): Array<Omit<Entity, 'origin'>> {
  return list.map(({ origin: _origin, ...rest }) => rest)
}

function downloadFile(name: string, content: string, mime: string) {
  if (typeof document === 'undefined') return
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Tiny YAML serialiser — enough for the Backstage entity shape we emit. */
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return ' []\n'
    return (
      '\n' +
      value
        .map((item) => {
          if (item !== null && typeof item === 'object') {
            const body = toYaml(item, indent + 1).replace(/^\n/, '')
            return `${pad}-\n${body}`
          }
          return `${pad}- ${yamlScalar(item)}\n`
        })
        .join('')
    )
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    )
    if (entries.length === 0) return ' {}\n'
    return (
      (indent === 0 ? '' : '\n') +
      entries
        .map(([k, v]) => {
          if (v !== null && typeof v === 'object') {
            return `${pad}${k}:${toYaml(v, indent + 1)}`
          }
          return `${pad}${k}: ${yamlScalar(v)}\n`
        })
        .join('')
    )
  }
  return `${pad}${yamlScalar(value)}\n`
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  return /^[\w./@-]+$/.test(s) ? s : JSON.stringify(s)
}

/* ─────────── toolbar (single search + filter + view + sort row) ─────────── */

function Toolbar({
  filter,
  onFilter,
  kindCounts,
  owners,
  systems,
  allTags,
  starsCount,
  attentionCount,
  mineCount,
  view,
  onView,
  sort,
  onSort,
  filterCount,
  text,
  onText,
  onClearSearch,
  searchInputRef,
  loading,
}: {
  filter: FilterState
  onFilter(next: FilterState): void
  kindCounts: Record<string, number>
  owners: Array<{ value: string; label: string; count: number }>
  systems: Array<{ value: string; label: string; count: number }>
  allTags: Array<{ value: string; count: number }>
  starsCount: number
  attentionCount: number
  mineCount: number
  view: ViewMode
  onView(v: ViewMode): void
  sort: SortKey
  onSort(s: SortKey): void
  filterCount: number
  text: string
  onText(v: string): void
  onClearSearch(): void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  loading: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)

  // Close on outside click + Esc.
  useEffect(() => {
    if (!open) return
    const onClickAway = (e: MouseEvent) => {
      const a = anchorRef.current
      if (a && !a.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.addEventListener('mousedown', onClickAway)
    globalThis.addEventListener('keydown', onEsc)
    return () => {
      globalThis.removeEventListener('mousedown', onClickAway)
      globalThis.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="relative h-9 min-w-72 flex-1">
          <input
            ref={searchInputRef}
            value={text}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && text) {
                e.stopPropagation()
                onText('')
              }
            }}
            placeholder="Search services, APIs, resources, teams…"
            aria-label="Search catalog"
            className="h-full w-full rounded-lg border border-edge-default bg-white pl-9 pr-10 text-sm text-content placeholder:text-content-subtle transition-shadow focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle">
            <IconSearchLg />
          </span>
          <span className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center">
            {text ? (
              <button
                type="button"
                onClick={onClearSearch}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"
                aria-label="Clear search"
                title="Clear (Esc)"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            ) : (
              <kbd className="pointer-events-none rounded border border-edge-default bg-surface-sunken px-1 py-0.5 font-mono text-[10px] text-content-muted">
                /
              </kbd>
            )}
          </span>
        </div>

        <div className="relative" ref={anchorRef}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[12px] font-medium transition-colors',
              filterCount > 0
                ? 'border-brand-700 bg-brand-600 text-white shadow-sm hover:bg-brand-700'
                : 'border-edge-default bg-white text-content hover:border-edge-strong hover:bg-surface-sunken',
            )}
          >
            <IconFilter />
            <span>Filters</span>
            {filterCount > 0 ? (
              <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                {filterCount}
              </span>
            ) : null}
            <span className="text-[10px] opacity-70">▾</span>
          </button>
          {open ? (
            <FilterPopover
              filter={filter}
              onFilter={onFilter}
              kindCounts={kindCounts}
              owners={owners}
              systems={systems}
              allTags={allTags}
              starsCount={starsCount}
              attentionCount={attentionCount}
              mineCount={mineCount}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </div>

        <ViewSwitch value={view} onChange={onView} />
        <SortMenu value={sort} onChange={onSort} />

        {loading ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-content-subtle"
            aria-live="polite"
          >
            <Spinner size={11} />
            <span>Loading…</span>
          </span>
        ) : null}
      </div>
      <ActiveFilterChips filter={filter} onFilter={onFilter} />
    </div>
  )
}

function ViewSwitch({ value, onChange }: { value: ViewMode; onChange(v: ViewMode): void }) {
  return (
    <div
      role="group"
      aria-label="View mode"
      className="inline-flex h-9 items-center rounded-lg border border-edge-default bg-white p-0.5 shadow-sm"
    >
      <ViewBtn active={value === 'grid'} onClick={() => onChange('grid')} title="Grid view">
        <IconGrid />
      </ViewBtn>
      <ViewBtn
        active={value === 'compact'}
        onClick={() => onChange('compact')}
        title="Compact list"
      >
        <IconList />
      </ViewBtn>
      <ViewBtn active={value === 'table'} onClick={() => onChange('table')} title="Table view">
        <IconTable />
      </ViewBtn>
    </div>
  )
}

function ViewBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick(): void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md transition',
        active
          ? 'bg-surface-sunken text-content'
          : 'text-content-subtle hover:bg-surface-sunken hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function SortMenu({ value, onChange }: { value: SortKey; onChange(v: SortKey): void }) {
  return (
    <label className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge-default bg-white px-3 text-[12px] shadow-sm">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        Sort
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="rounded border-0 bg-transparent px-1 py-0 text-[12px] text-content focus:outline-none"
      >
        <option value="name">Name</option>
        <option value="recent">Recently updated</option>
        <option value="lifecycle">Lifecycle</option>
      </select>
    </label>
  )
}

/* ─────────── filter popover ─────────── */

const ALL_KINDS: EntityKind[] = [
  'Component',
  'API',
  'Resource',
  'System',
  'Domain',
  'Group',
  'User',
]
const ALL_LIFECYCLES: Lifecycle[] = ['production', 'staging', 'experimental', 'deprecated']

function FilterPopover({
  filter,
  onFilter,
  kindCounts,
  owners,
  systems,
  allTags,
  starsCount,
  attentionCount,
  mineCount,
  onClose,
}: {
  filter: FilterState
  onFilter(next: FilterState): void
  kindCounts: Record<string, number>
  owners: Array<{ value: string; label: string; count: number }>
  systems: Array<{ value: string; label: string; count: number }>
  allTags: Array<{ value: string; count: number }>
  starsCount: number
  attentionCount: number
  mineCount: number
  onClose(): void
}) {
  const toggleKind = (k: EntityKind) => {
    const next = new Set(filter.kinds)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    onFilter({ ...filter, kinds: next })
  }
  const toggleLifecycle = (l: Lifecycle) => {
    const next = new Set(filter.lifecycles)
    if (next.has(l)) next.delete(l)
    else next.add(l)
    onFilter({ ...filter, lifecycles: next })
  }
  const toggleTag = (t: string) => {
    const next = new Set(filter.tags)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    onFilter({ ...filter, tags: next })
  }
  const setQuick = (q: QuickFilter) =>
    onFilter({ ...filter, quick: filter.quick === q ? 'all' : q })
  const setOwner = (v: string) => onFilter({ ...filter, owner: v })
  const setSystem = (v: string) => onFilter({ ...filter, system: v })
  const setHas = (key: 'hasOwner' | 'hasDocs' | 'hasRunbook', v: Tristate) =>
    onFilter({ ...filter, [key]: v })
  const clearAll = () => onFilter(emptyFilter())

  return (
    <div
      role="dialog"
      aria-label="Filters"
      className="pop-in absolute left-0 top-full z-30 mt-2 w-[24rem] overflow-hidden rounded-2xl border border-edge-default bg-white shadow-xl"
    >
      <header className="flex items-center justify-between border-b border-edge-subtle bg-surface-sunken/40 px-4 py-2.5">
        <div className="flex items-center gap-2 text-[12px]">
          <IconFilter />
          <span className="font-semibold text-content">Filters</span>
          <button
            type="button"
            onClick={clearAll}
            className="ml-2 text-[11px] text-content-subtle underline-offset-2 hover:text-content hover:underline"
          >
            Clear all
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
        >
          <IconClose />
        </button>
      </header>

      <div className="max-h-[28rem] overflow-y-auto px-4 py-3">
        <FilterSection title="Quick views">
          <div className="flex flex-wrap gap-1.5">
            <QuickPill
              active={filter.quick === 'mine'}
              disabled={mineCount === 0}
              onClick={() => setQuick('mine')}
              icon={<IconUsers />}
              label="Owned by me"
              count={mineCount}
            />
            <QuickPill
              active={filter.quick === 'starred'}
              disabled={starsCount === 0}
              onClick={() => setQuick('starred')}
              icon={<IconStar />}
              label="Starred"
              count={starsCount}
            />
            <QuickPill
              active={filter.quick === 'production'}
              onClick={() => setQuick('production')}
              icon={<IconShield />}
              label="Production"
            />
            <QuickPill
              active={filter.quick === 'recent'}
              onClick={() => setQuick('recent')}
              icon={<IconClock />}
              label="Recently updated"
            />
            <QuickPill
              active={filter.quick === 'attention'}
              disabled={attentionCount === 0}
              onClick={() => setQuick('attention')}
              icon={<IconAlert />}
              label="Needs attention"
              count={attentionCount}
              tone="amber"
            />
          </div>
        </FilterSection>

        <FilterSection title="Kind">
          <div className="grid grid-cols-2 gap-1">
            {ALL_KINDS.map((k) => {
              const c = kindCounts[k] ?? 0
              return (
                <CheckRow
                  key={k}
                  checked={filter.kinds.has(k)}
                  onChange={() => toggleKind(k)}
                  label={KIND_LABEL[k]}
                  count={c}
                  glyph={<KindGlyph kind={k} />}
                />
              )
            })}
          </div>
        </FilterSection>

        <FilterSection title="Lifecycle">
          <div className="flex flex-wrap gap-1.5">
            {ALL_LIFECYCLES.map((l) => (
              <LifecyclePill
                key={l}
                active={filter.lifecycles.has(l)}
                onClick={() => toggleLifecycle(l)}
                label={l}
                tone={LIFECYCLE_TONE[l]}
              />
            ))}
          </div>
        </FilterSection>

        <FilterSection title="Owner">
          <select
            value={filter.owner}
            onChange={(e) => setOwner(e.target.value)}
            className="w-full rounded-md border border-edge-default bg-white px-2 py-1.5 text-[12px]"
          >
            <option value="all">Any owner</option>
            {owners.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </FilterSection>

        <FilterSection title="System">
          <select
            value={filter.system}
            onChange={(e) => setSystem(e.target.value)}
            className="w-full rounded-md border border-edge-default bg-white px-2 py-1.5 text-[12px]"
          >
            <option value="all">Any system</option>
            {systems.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label} ({s.count})
              </option>
            ))}
          </select>
        </FilterSection>

        {allTags.length > 0 ? (
          <FilterSection title={`Tags · ${allTags.length}`}>
            <div className="flex flex-wrap gap-1">
              {allTags.slice(0, 24).map((t) => (
                <TagPill
                  key={t.value}
                  active={filter.tags.has(t.value)}
                  onClick={() => toggleTag(t.value)}
                  label={t.value}
                  count={t.count}
                />
              ))}
            </div>
          </FilterSection>
        ) : null}

        <FilterSection title="Required signals">
          <div className="space-y-1">
            <TristateRow
              label="Has owner"
              value={filter.hasOwner}
              onChange={(v) => setHas('hasOwner', v)}
            />
            <TristateRow
              label="Has docs link"
              value={filter.hasDocs}
              onChange={(v) => setHas('hasDocs', v)}
            />
            <TristateRow
              label="Has runbook"
              value={filter.hasRunbook}
              onChange={(v) => setHas('hasRunbook', v)}
            />
          </div>
        </FilterSection>
      </div>
    </div>
  )
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-edge-subtle py-3 first:pt-0 last:border-b-0 last:pb-0">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {title}
      </div>
      {children}
    </div>
  )
}

function CheckRow({
  checked,
  onChange,
  label,
  count,
  glyph,
}: {
  checked: boolean
  onChange(): void
  label: string
  count: number
  glyph: React.ReactNode
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12px] transition',
        checked ? 'bg-brand-50 text-brand-700' : 'text-content-muted hover:bg-surface-sunken',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 accent-brand-600"
      />
      {glyph}
      <span className="flex-1 truncate">{label}</span>
      <span className="rounded bg-surface-sunken px-1 text-[10px] tabular-nums text-content-subtle">
        {count}
      </span>
    </label>
  )
}

function QuickPill({
  active,
  disabled,
  onClick,
  icon,
  label,
  count,
  tone,
}: {
  active: boolean
  disabled?: boolean
  onClick(): void
  icon: React.ReactNode
  label: string
  count?: number
  tone?: 'amber'
}) {
  const isAmber = tone === 'amber' && active
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        isAmber
          ? 'border-amber-400 bg-amber-50 text-amber-800 shadow-sm'
          : active
            ? 'border-content bg-content text-white shadow-sm'
            : 'border-edge-default bg-white text-content-muted hover:border-content hover:text-content',
      )}
    >
      {icon}
      <span>{label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span
          className={cn(
            'rounded-full px-1.5 text-[10px] tabular-nums',
            isAmber
              ? 'bg-amber-100 text-amber-800'
              : active
                ? 'bg-white/20 text-white'
                : 'bg-surface-sunken text-content-subtle',
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  )
}

function LifecyclePill({
  active,
  onClick,
  label,
  tone,
}: {
  active: boolean
  onClick(): void
  label: string
  tone: 'healthy' | 'progressing' | 'info' | 'degraded'
}) {
  const cls = active
    ? tone === 'healthy'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
      : tone === 'progressing'
        ? 'border-brand-300 bg-brand-50 text-brand-700'
        : tone === 'info'
          ? 'border-sky-300 bg-sky-50 text-sky-700'
          : 'border-amber-300 bg-amber-50 text-amber-800'
    : 'border-edge-default bg-white text-content-muted hover:border-content hover:text-content'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize transition',
        cls,
      )}
    >
      {label}
    </button>
  )
}

function TagPill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick(): void
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition',
        active
          ? 'bg-brand-100 text-brand-700 ring-1 ring-brand-300'
          : 'bg-surface-sunken text-content-muted hover:text-content',
      )}
    >
      {label}
      <span className="opacity-70">{count}</span>
    </button>
  )
}

function TristateRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: Tristate
  onChange(v: Tristate): void
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[12px]">
      <span className="text-content">{label}</span>
      <div className="inline-flex rounded-md border border-edge-default bg-white p-0.5">
        <TristateBtn active={value === null} onClick={() => onChange(null)}>
          Any
        </TristateBtn>
        <TristateBtn active={value === true} onClick={() => onChange(true)} tone="emerald">
          Yes
        </TristateBtn>
        <TristateBtn active={value === false} onClick={() => onChange(false)} tone="amber">
          No
        </TristateBtn>
      </div>
    </div>
  )
}

function TristateBtn({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean
  onClick(): void
  tone?: 'emerald' | 'amber'
  children: React.ReactNode
}) {
  const cls = active
    ? tone === 'emerald'
      ? 'bg-emerald-100 text-emerald-700'
      : tone === 'amber'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-surface-sunken text-content'
    : 'text-content-subtle hover:bg-surface-sunken hover:text-content'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center rounded px-2 text-[10px] font-medium transition',
        cls,
      )}
    >
      {children}
    </button>
  )
}

/* ─────────── active filter chips (under the toolbar) ─────────── */

function ActiveFilterChips({
  filter,
  onFilter,
}: {
  filter: FilterState
  onFilter(next: FilterState): void
}) {
  const chips: Array<{ key: string; label: string; clear: () => void }> = []

  filter.kinds.forEach((k) => {
    chips.push({
      key: `kind:${k}`,
      label: `Kind: ${k}`,
      clear: () => {
        const next = new Set(filter.kinds)
        next.delete(k)
        onFilter({ ...filter, kinds: next })
      },
    })
  })
  filter.lifecycles.forEach((l) => {
    chips.push({
      key: `life:${l}`,
      label: `Lifecycle: ${l}`,
      clear: () => {
        const next = new Set(filter.lifecycles)
        next.delete(l)
        onFilter({ ...filter, lifecycles: next })
      },
    })
  })
  if (filter.owner !== 'all') {
    chips.push({
      key: 'owner',
      label: `Owner: ${parseRef(filter.owner).name}`,
      clear: () => onFilter({ ...filter, owner: 'all' }),
    })
  }
  if (filter.system !== 'all') {
    chips.push({
      key: 'system',
      label: `System: ${parseRef(filter.system).name}`,
      clear: () => onFilter({ ...filter, system: 'all' }),
    })
  }
  filter.tags.forEach((t) => {
    chips.push({
      key: `tag:${t}`,
      label: `Tag: ${t}`,
      clear: () => {
        const next = new Set(filter.tags)
        next.delete(t)
        onFilter({ ...filter, tags: next })
      },
    })
  })
  if (filter.quick !== 'all') {
    chips.push({
      key: 'quick',
      label: `Quick: ${filter.quick}`,
      clear: () => onFilter({ ...filter, quick: 'all' }),
    })
  }
  if (filter.hasOwner !== null) {
    chips.push({
      key: 'hasOwner',
      label: filter.hasOwner ? 'Has owner' : 'Missing owner',
      clear: () => onFilter({ ...filter, hasOwner: null }),
    })
  }
  if (filter.hasDocs !== null) {
    chips.push({
      key: 'hasDocs',
      label: filter.hasDocs ? 'Has docs' : 'Missing docs',
      clear: () => onFilter({ ...filter, hasDocs: null }),
    })
  }
  if (filter.hasRunbook !== null) {
    chips.push({
      key: 'hasRunbook',
      label: filter.hasRunbook ? 'Has runbook' : 'Missing runbook',
      clear: () => onFilter({ ...filter, hasRunbook: null }),
    })
  }

  if (chips.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-edge-subtle bg-surface-sunken/40 px-3 py-2 text-[11px]">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        Active
      </span>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={c.clear}
          className="inline-flex items-center gap-1 rounded-full border border-edge-default bg-white px-2 py-0.5 font-medium text-content-muted shadow-sm transition hover:border-brand-200 hover:text-brand-700"
        >
          {c.label}
          <span className="text-content-subtle">×</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => onFilter(emptyFilter())}
        className="ml-1 rounded-full px-2 py-0.5 text-content-muted underline-offset-2 hover:text-content hover:underline"
      >
        clear all
      </button>
    </div>
  )
}

/* ─────────── compact + table views ─────────── */

function CompactRow({
  entity,
  starred,
  onClick,
  first,
}: {
  entity: Entity
  starred: boolean
  onClick(): void
  first?: boolean
}) {
  const ref = entityRef(entity)
  return (
    <li
      role="option"
      aria-selected={false}
      tabIndex={0}
      data-entity-card
      aria-label={`${entity.metadata.title ?? entity.metadata.name} — ${entity.kind}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        'group flex cursor-pointer items-center gap-3 px-4 py-2.5 transition hover:bg-surface-sunken/60 focus-visible:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
        !first && 'border-t border-edge-subtle',
      )}
    >
      <KindGlyph kind={entity.kind} type={entity.spec.type} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-content">
            {entity.metadata.title ?? entity.metadata.name}
          </span>
          <span className="font-mono text-[10px] text-content-subtle">
            {entity.kind.toLowerCase()}:{entity.metadata.name}
          </span>
          <OriginTag origin={entity.origin} />
        </div>
        {entity.metadata.description ? (
          <div className="mt-0.5 truncate text-[11px] text-content-muted">
            {entity.metadata.description}
          </div>
        ) : null}
      </div>
      <div className="hidden flex-shrink-0 items-center gap-3 text-[11px] text-content-muted md:flex">
        {entity.spec.owner ? (
          <span className="inline-flex items-center gap-1">
            <IconUsers />
            {parseRef(entity.spec.owner).name}
          </span>
        ) : null}
        {entity.spec.lifecycle ? (
          <StatusBadge kind={LIFECYCLE_TONE[entity.spec.lifecycle]}>
            {entity.spec.lifecycle}
          </StatusBadge>
        ) : null}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggleStar(ref)
        }}
        aria-label={starred ? 'Unstar' : 'Star'}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-full transition',
          starred
            ? 'bg-amber-50 text-amber-500 ring-1 ring-amber-200'
            : 'text-content-subtle opacity-0 hover:bg-surface-sunken hover:text-amber-500 group-hover:opacity-100',
        )}
      >
        {starred ? <IconStarFilled /> : <IconStar />}
      </button>
    </li>
  )
}

function TableView({
  rows,
  stars,
  onPick,
}: {
  rows: Entity[]
  stars: readonly string[]
  onPick(e: Entity): void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-sunken/40 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            <tr>
              <th className="w-8 px-2 py-2"></th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Lifecycle</th>
              <th className="px-3 py-2 text-left">Owner</th>
              <th className="px-3 py-2 text-left">System</th>
              <th className="px-3 py-2 text-left">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {rows.map((e) => {
              const ref = entityRef(e)
              const starred = stars.includes(ref)
              return (
                <tr
                  key={ref}
                  onClick={() => onPick(e)}
                  className="cursor-pointer transition hover:bg-surface-sunken/40"
                >
                  <td className="px-2 py-2.5">
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        toggleStar(ref)
                      }}
                      aria-label={starred ? 'Unstar' : 'Star'}
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded transition',
                        starred ? 'text-amber-500' : 'text-content-subtle hover:text-amber-500',
                      )}
                    >
                      {starred ? <IconStarFilled /> : <IconStar />}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <KindGlyph kind={e.kind} type={e.spec.type} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-content">
                          {e.metadata.title ?? e.metadata.name}
                        </div>
                        <div className="truncate font-mono text-[10px] text-content-subtle">
                          {e.metadata.name}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-content-muted">{e.kind}</td>
                  <td className="px-3 py-2.5">
                    {e.spec.type ? (
                      <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted">
                        {e.spec.type}
                      </code>
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {e.spec.lifecycle ? (
                      <StatusBadge kind={LIFECYCLE_TONE[e.spec.lifecycle]}>
                        {e.spec.lifecycle}
                      </StatusBadge>
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-content-muted">
                    {e.spec.owner ? (
                      parseRef(e.spec.owner).name
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-content-muted">
                    {e.spec.system ? (
                      parseRef(e.spec.system).name
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-content-muted">
                    {relativeTime(e.metadata.updatedAt ?? e.metadata.createdAt) || '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────── sort helper ─────────── */

function sortEntities(rows: Entity[], by: SortKey): Entity[] {
  const out = rows.slice()
  if (by === 'name') {
    out.sort((a, b) =>
      (a.metadata.title ?? a.metadata.name).localeCompare(b.metadata.title ?? b.metadata.name),
    )
  } else if (by === 'recent') {
    out.sort((a, b) =>
      (b.metadata.updatedAt ?? b.metadata.createdAt ?? '').localeCompare(
        a.metadata.updatedAt ?? a.metadata.createdAt ?? '',
      ),
    )
  } else if (by === 'lifecycle') {
    const order: Record<string, number> = {
      production: 0,
      staging: 1,
      experimental: 2,
      deprecated: 3,
      '': 4,
    }
    out.sort((a, b) => (order[a.spec.lifecycle ?? ''] ?? 4) - (order[b.spec.lifecycle ?? ''] ?? 4))
  }
  return out
}

/* ─────────── entity card ─────────── */

function EntityCard({
  entity,
  starred,
  onClick,
}: {
  entity: Entity
  starred: boolean
  onClick(): void
}) {
  const ref = entityRef(entity)
  const links = entity.metadata.links ?? []
  const attention = needsAttention(entity)
  const ageLabel = relativeTime(entity.metadata.updatedAt ?? entity.metadata.createdAt)
  const score = entityScore(entity)
  return (
    <div
      role="button"
      tabIndex={0}
      data-entity-card
      aria-label={`${entity.metadata.title ?? entity.metadata.name} — ${entity.kind}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="group relative flex h-full flex-col items-stretch overflow-hidden rounded-xl border border-edge-default bg-white text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-300/70 hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggleStar(ref)
        }}
        aria-label={starred ? 'Unstar' : 'Star'}
        title={starred ? 'Remove from starred' : 'Add to starred'}
        className={cn(
          'absolute right-2.5 top-2.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full transition',
          starred
            ? 'bg-amber-50 text-amber-500 shadow-sm ring-1 ring-amber-200'
            : 'text-content-subtle opacity-0 hover:bg-surface-sunken hover:text-amber-500 group-hover:opacity-100',
        )}
      >
        {starred ? <IconStarFilled /> : <IconStar />}
      </button>
      <div className="flex items-start gap-3 p-4 pr-12">
        <KindGlyph kind={entity.kind} type={entity.spec.type} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="flex min-w-0 items-center gap-1.5 truncate text-[14px] font-semibold leading-tight text-content">
              {attention ? (
                <span
                  aria-label="Needs attention"
                  title="Needs attention — see meta row below"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                />
              ) : null}
              <span className="truncate">{entity.metadata.title ?? entity.metadata.name}</span>
            </h3>
            {entity.spec.lifecycle ? (
              <StatusBadge kind={LIFECYCLE_TONE[entity.spec.lifecycle]}>
                {entity.spec.lifecycle}
              </StatusBadge>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] text-content-subtle">
              {entity.kind.toLowerCase()}:{entity.metadata.name}
            </span>
            <OriginTag origin={entity.origin} />
          </div>
        </div>
      </div>
      {entity.metadata.description ? (
        <p className="-mt-1 line-clamp-2 px-4 text-[12px] leading-relaxed text-content-muted">
          {entity.metadata.description}
        </p>
      ) : null}
      {(entity.metadata.tags ?? []).length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1 px-4">
          {(entity.metadata.tags ?? []).slice(0, 4).map((t) => (
            <span
              key={t}
              className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3 px-4 pb-3 text-[11px] text-content-muted">
        {entity.spec.owner ? (
          <span className="inline-flex items-center gap-1">
            <IconUsers />
            <span className="font-medium text-content">{parseRef(entity.spec.owner).name}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-700">
            <IconAlert />
            no owner
          </span>
        )}
        {entity.spec.system ? (
          <span className="inline-flex items-center gap-1">
            <IconBox />
            <span className="font-medium text-content">{parseRef(entity.spec.system).name}</span>
          </span>
        ) : null}
        {ageLabel ? (
          <span className="inline-flex items-center gap-1">
            <IconClock />
            {ageLabel}
          </span>
        ) : null}
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-edge-subtle bg-surface-sunken/40 px-3 py-2 text-[11px]">
        <QuickLinks links={links} />
        <div className="flex shrink-0 items-center gap-2">
          <ScoreBadge score={score} />
          <span className="font-mono text-[10px] uppercase tracking-wider text-content-subtle opacity-0 transition-opacity group-hover:text-brand-700 group-hover:opacity-100">
            open →
          </span>
        </div>
      </div>
    </div>
  )
}

function QuickLinks({ links }: { links: Entity['metadata']['links'] }) {
  if (!links || !links.length) {
    return <span className="text-content-subtle">no links</span>
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {links.slice(0, 4).map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-1 text-[10px] font-medium text-content-muted ring-1 ring-edge-default hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-200"
          title={l.title}
        >
          <LinkGlyph icon={l.icon} />
          <span className="hidden sm:inline">{l.title}</span>
        </a>
      ))}
    </div>
  )
}

/* ─────────── scorecard + origin ─────────── */

interface EntityScore {
  ok: number
  total: number
  pct: number
}

/** Derive an entity health score from its applicable signals (0–100). */
function entityScore(e: Entity): EntityScore {
  const applicable = computeSignals(e).filter((s) => s.state !== 'na')
  const ok = applicable.filter((s) => s.state === 'ok').length
  const total = applicable.length
  return { ok, total, pct: total ? Math.round((ok / total) * 100) : 100 }
}

function scoreTone(pct: number): { dot: string; text: string; ring: string } {
  if (pct >= 80) {
    return { dot: 'bg-emerald-500', text: 'text-emerald-700', ring: 'ring-emerald-200' }
  }
  if (pct >= 50) return { dot: 'bg-amber-500', text: 'text-amber-800', ring: 'ring-amber-200' }
  return { dot: 'bg-rose-500', text: 'text-rose-700', ring: 'ring-rose-200' }
}

function ScoreBadge({ score }: { score: EntityScore }) {
  const t = scoreTone(score.pct)
  return (
    <span
      title={`Scorecard: ${score.ok}/${score.total} health checks passing`}
      aria-label={`Health score ${score.pct} percent`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ring-1',
        t.text,
        t.ring,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', t.dot)} />
      {score.pct}
    </span>
  )
}

const ORIGIN_LABEL: Record<EntityOrigin, string> = {
  live: 'Live',
  registered: 'Registered',
  seed: 'Sample',
}

function OriginTag({ origin }: { origin?: EntityOrigin }) {
  if (!origin || origin === 'seed') return null
  const cls =
    origin === 'live'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : 'bg-brand-50 text-brand-700 ring-brand-200'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1',
        cls,
      )}
    >
      {ORIGIN_LABEL[origin]}
    </span>
  )
}

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 14) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 8) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  const y = Math.floor(d / 365)
  return `${y}y ago`
}

/* ─────────── shared section header ─────────── */

function SectionHeader({
  eyebrow,
  title,
  right,
}: {
  eyebrow: string
  title: string
  right?: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
          {eyebrow}
        </div>
        {right ? <div className="text-[11px] text-content-muted">{right}</div> : null}
      </div>
      <h2 className="mt-1 text-[18px] font-semibold tracking-tight text-content">{title}</h2>
    </div>
  )
}

/* ─────────── entity drawer ─────────── */

function EntityDrawer({
  entity,
  onClose,
  catalog,
  onPick,
  stars,
}: {
  entity: Entity
  onClose(): void
  catalog: Entity[]
  onPick(e: Entity): void
  stars: readonly string[]
}) {
  const ref = entityRef(entity)
  const starred = isStarred(stars, ref)
  const signals = computeSignals(entity)
  const score = entityScore(entity)
  const activity = buildActivity(entity)
  const apiDef = entity.kind === 'API' ? parseApiDefinition(entity.spec.definition) : null
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  // Focus management: move focus into the drawer on open, restore it to the
  // element that opened the drawer (the card) on close.
  useEffect(() => {
    const previouslyFocused =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    closeBtnRef.current?.focus()
    return () => previouslyFocused?.focus?.()
  }, [])

  const linked = (refs: string[] | undefined): Entity[] =>
    (refs ?? []).map((r) => findEntity(catalog, r)).filter((e): e is Entity => Boolean(e))

  const provides = linked(entity.spec.providesApis)
  const consumes = linked(entity.spec.consumesApis)
  const dependsOn = linked(entity.spec.dependsOn)
  const ownerEnt = entity.spec.owner ? findEntity(catalog, entity.spec.owner) : undefined
  const systemEnt = entity.spec.system ? findEntity(catalog, entity.spec.system) : undefined
  const domainEnt = entity.spec.domain ? findEntity(catalog, entity.spec.domain) : undefined
  const ownedBy = catalog.filter((e) => e.spec.owner === entityRef(entity))
  const childComponents =
    entity.kind === 'System'
      ? catalog.filter((e) => e.spec.system === entityRef(entity))
      : entity.kind === 'Domain'
        ? catalog.filter((e) => e.spec.domain === entityRef(entity))
        : []
  // Reverse edges for API entities so the dependency view is navigable both ways.
  const selfRef = entityRef(entity)
  const definedBy =
    entity.kind === 'API' && entity.spec.definition && !apiDef
      ? [findEntity(catalog, entity.spec.definition)].filter((e): e is Entity => Boolean(e))
      : []
  const providedBy =
    entity.kind === 'API'
      ? catalog.filter((e) => (e.spec.providesApis ?? []).includes(selfRef))
      : []
  const consumedBy =
    entity.kind === 'API'
      ? catalog.filter((e) => (e.spec.consumesApis ?? []).includes(selfRef))
      : []

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
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-content-subtle">
              <KindGlyph kind={entity.kind} type={entity.spec.type} />
              {entity.kind}
              {entity.spec.lifecycle ? (
                <StatusBadge kind={LIFECYCLE_TONE[entity.spec.lifecycle]}>
                  {entity.spec.lifecycle}
                </StatusBadge>
              ) : null}
            </div>
            <h2 className="mt-1 truncate text-xl font-semibold text-content">
              {entity.metadata.title ?? entity.metadata.name}
            </h2>
            <div className="mt-1 font-mono text-[11px] text-content-muted">{entityRef(entity)}</div>
            {entity.metadata.description ? (
              <p className="mt-2 max-w-xl text-sm text-content-muted">
                {entity.metadata.description}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => toggleStar(ref)}
              aria-label={starred ? 'Unstar' : 'Star'}
              title={starred ? 'Remove from starred' : 'Add to starred'}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-md transition',
                starred
                  ? 'bg-amber-50 text-amber-500 ring-1 ring-amber-200'
                  : 'text-content-subtle hover:bg-surface-sunken hover:text-amber-500',
              )}
            >
              {starred ? <IconStarFilled /> : <IconStar />}
            </button>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {entity.metadata.links?.length ? (
            <div className="flex flex-wrap gap-2">
              {entity.metadata.links.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-white px-3 py-1.5 text-xs font-medium text-content-muted shadow-sm hover:border-brand-200 hover:text-brand-700"
                >
                  <LinkGlyph icon={l.icon} />
                  {l.title}
                </a>
              ))}
            </div>
          ) : null}

          <SignalsCard signals={signals} score={score} />

          {apiDef ? <ApiDefinitionCard api={apiDef} /> : null}

          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-content">About</h3>
            </CardHeader>
            <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Owner"
                value={
                  ownerEnt ? <RefChip ent={ownerEnt} onPick={onPick} /> : (entity.spec.owner ?? '—')
                }
              />
              <Field
                label="System"
                value={systemEnt ? <RefChip ent={systemEnt} onPick={onPick} /> : '—'}
              />
              <Field
                label="Domain"
                value={domainEnt ? <RefChip ent={domainEnt} onPick={onPick} /> : '—'}
              />
              <Field
                label="Type"
                value={
                  entity.spec.type ? (
                    <code className="text-xs text-content-muted">{entity.spec.type}</code>
                  ) : (
                    '—'
                  )
                }
              />
              <Field
                label="Lifecycle"
                value={
                  entity.spec.lifecycle ? (
                    <StatusBadge kind={LIFECYCLE_TONE[entity.spec.lifecycle]}>
                      {entity.spec.lifecycle}
                    </StatusBadge>
                  ) : (
                    '—'
                  )
                }
              />
              <Field
                label="Tags"
                value={
                  (entity.metadata.tags ?? []).length === 0 ? (
                    <span className="text-content-subtle">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {entity.metadata.tags?.map((t) => (
                        <span
                          key={t}
                          className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )
                }
              />
            </CardBody>
          </Card>

          {provides.length > 0 ||
          consumes.length > 0 ||
          dependsOn.length > 0 ||
          ownedBy.length > 0 ||
          childComponents.length > 0 ||
          definedBy.length > 0 ||
          providedBy.length > 0 ||
          consumedBy.length > 0 ? (
            <Card>
              <CardHeader>
                <h3 className="text-sm font-semibold text-content">Relations</h3>
              </CardHeader>
              <CardBody className="space-y-3">
                {provides.length ? (
                  <RelationRow label="Provides APIs" entities={provides} onPick={onPick} />
                ) : null}
                {consumes.length ? (
                  <RelationRow label="Consumes APIs" entities={consumes} onPick={onPick} />
                ) : null}
                {definedBy.length ? (
                  <RelationRow label="Defined by" entities={definedBy} onPick={onPick} />
                ) : null}
                {providedBy.length ? (
                  <RelationRow label="Provided by" entities={providedBy} onPick={onPick} />
                ) : null}
                {consumedBy.length ? (
                  <RelationRow label="Consumed by" entities={consumedBy} onPick={onPick} />
                ) : null}
                {dependsOn.length ? (
                  <RelationRow label="Depends on" entities={dependsOn} onPick={onPick} />
                ) : null}
                {childComponents.length ? (
                  <RelationRow
                    label={entity.kind === 'Domain' ? 'In this domain' : 'In this system'}
                    entities={childComponents}
                    onPick={onPick}
                  />
                ) : null}
                {ownedBy.length ? (
                  <RelationRow label="Owns" entities={ownedBy} onPick={onPick} />
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <ActivityCard events={activity} />

          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-content">Metadata</h3>
            </CardHeader>
            <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Namespace"
                value={<code className="text-xs">{entity.metadata.namespace ?? 'default'}</code>}
              />
              <Field
                label="Created"
                value={<code className="text-xs">{formatDate(entity.metadata.createdAt)}</code>}
              />
              <Field
                label="Updated"
                value={<code className="text-xs">{formatDate(entity.metadata.updatedAt)}</code>}
              />
              <Field
                label="API version"
                value={<code className="text-xs">{entity.apiVersion}</code>}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-content">Raw entity</h3>
            </CardHeader>
            <CardBody>
              <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-100">
                {JSON.stringify(entity, null, 2)}
              </pre>
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function RelationRow({
  label,
  entities,
  onPick,
}: {
  label: string
  entities: Entity[]
  onPick(e: Entity): void
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {entities.map((e) => (
          <RefChip key={entityRef(e)} ent={e} onPick={onPick} />
        ))}
      </div>
    </div>
  )
}

function RefChip({ ent, onPick }: { ent: Entity; onPick(e: Entity): void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(ent)}
      className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-white px-2 py-1 text-[11px] text-content-muted shadow-sm hover:border-brand-200 hover:text-brand-700"
    >
      <KindGlyph kind={ent.kind} type={ent.spec.type} />
      <span className="font-medium text-content">{ent.metadata.title ?? ent.metadata.name}</span>
      <span className="text-content-subtle">· {ent.kind.toLowerCase()}</span>
    </button>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="mt-1 text-sm text-content">{value}</div>
    </div>
  )
}

function formatDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().split('T')[0]
}

/* ─────────── signals (drawer health card) ─────────── */

interface SignalRow {
  id: string
  label: string
  state: 'ok' | 'warn' | 'na'
  detail: string
}

function computeSignals(e: Entity): SignalRow[] {
  const links = e.metadata.links ?? []
  const has = (icon: NonNullable<Entity['metadata']['links']>[number]['icon']) =>
    links.some((l) => l.icon === icon)
  const ownerOk = Boolean(e.spec.owner)
  const lifecycleOk = Boolean(e.spec.lifecycle) && e.spec.lifecycle !== 'deprecated'
  const docsOk = has('docs')
  const repoOk = has('repo')
  const dashboardOk = has('dashboard') || has('runbook')
  const isComponent = e.kind === 'Component'

  return [
    {
      id: 'owner',
      label: 'Has owner',
      state: ownerOk ? 'ok' : 'warn',
      detail: ownerOk ? `Owned by ${parseRef(e.spec.owner!).name}` : 'No owner — assign a Group',
    },
    {
      id: 'lifecycle',
      label: 'Lifecycle declared',
      state: lifecycleOk ? 'ok' : e.spec.lifecycle === 'deprecated' ? 'warn' : 'warn',
      detail: e.spec.lifecycle ?? 'Set lifecycle (production / staging / experimental)',
    },
    {
      id: 'docs',
      label: 'Documentation',
      state: docsOk ? 'ok' : isComponent ? 'warn' : 'na',
      detail: docsOk ? 'Docs link registered' : 'Add a docs link to metadata.links',
    },
    {
      id: 'repo',
      label: 'Source repository',
      state: repoOk ? 'ok' : isComponent ? 'warn' : 'na',
      detail: repoOk ? 'Repo link registered' : 'Add a repo link to metadata.links',
    },
    {
      id: 'runbook',
      label: 'Runbook / dashboard',
      state: dashboardOk ? 'ok' : isComponent && e.spec.lifecycle === 'production' ? 'warn' : 'na',
      detail: dashboardOk
        ? 'Operations link registered'
        : 'Production components should link a runbook or dashboard',
    },
  ]
}

function SignalsCard({ signals, score }: { signals: SignalRow[]; score: EntityScore }) {
  const warn = signals.filter((s) => s.state === 'warn').length
  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-content">Scorecard</h3>
            <ScoreBadge score={score} />
          </div>
          <div className="flex items-center gap-1.5 text-[11px]">
            <StatusBadge kind={warn > 0 ? 'degraded' : 'healthy'}>
              {warn > 0 ? `${warn} attention` : 'all good'}
            </StatusBadge>
            <span className="font-mono tabular-nums text-content-muted">
              {score.ok}/{score.total}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardBody className="divide-y divide-edge-subtle">
        {signals.map((s) => (
          <div key={s.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
            <span
              className={cn(
                'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1',
                s.state === 'ok'
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : s.state === 'warn'
                    ? 'bg-amber-50 text-amber-700 ring-amber-200'
                    : 'bg-surface-sunken text-content-subtle ring-edge-subtle',
              )}
            >
              {s.state === 'ok' ? <IconCheck /> : s.state === 'warn' ? <IconAlert /> : <IconDash />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-content">{s.label}</div>
              <div className="mt-0.5 text-[11px] text-content-muted">{s.detail}</div>
            </div>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

/* ─────────── API definition (compact OpenAPI view) ─────────── */

const METHOD_TONE: Record<string, string> = {
  GET: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  POST: 'bg-brand-50 text-brand-700 ring-brand-200',
  PUT: 'bg-amber-50 text-amber-800 ring-amber-200',
  PATCH: 'bg-violet-50 text-violet-700 ring-violet-200',
  DELETE: 'bg-rose-50 text-rose-700 ring-rose-200',
}

function ApiDefinitionCard({ api }: { api: ParsedApi }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-content">API definition</h3>
          <span className="text-[11px] text-content-muted">
            {api.operations.length} {api.operations.length === 1 ? 'operation' : 'operations'}
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {api.servers.length ? (
          <div className="flex flex-wrap gap-1.5">
            {api.servers.map((s) => (
              <code
                key={s}
                className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted"
              >
                {s}
              </code>
            ))}
          </div>
        ) : null}
        {api.operations.length ? (
          <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
            {api.operations.slice(0, 40).map((op) => (
              <li key={`${op.method} ${op.path}`} className="flex items-center gap-2 px-2.5 py-1.5">
                <span
                  className={cn(
                    'inline-flex w-14 justify-center rounded px-1 py-0.5 text-center font-mono text-[10px] font-bold ring-1',
                    METHOD_TONE[op.method] ??
                      'bg-surface-sunken text-content-muted ring-edge-subtle',
                  )}
                >
                  {op.method}
                </span>
                <code className="truncate font-mono text-[12px] text-content">{op.path}</code>
                {op.summary ? (
                  <span className="ml-auto hidden truncate text-[11px] text-content-muted sm:inline">
                    {op.summary}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-content-muted">
            No operations declared in the definition.
          </p>
        )}
        {api.schemas.length ? (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              Schemas · {api.schemas.length}
            </div>
            <div className="flex flex-wrap gap-1">
              {api.schemas.slice(0, 40).map((s) => (
                <span
                  key={s}
                  className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

/* ─────────── activity (synthetic timeline) ─────────── */

interface Activity {
  at: string
  title: string
  detail?: string
  kind: 'created' | 'updated' | 'deployed' | 'incident' | 'review'
}

/**
 * Build a believable activity timeline from the entity's metadata. Real
 * events should come from the BFF (Argo CD, ArgoCD, GitHub, Pager) — for v1
 * we synthesise a plausible chronology so the section feels alive.
 */
function buildActivity(e: Entity): Activity[] {
  const out: Activity[] = []
  const created = e.metadata.createdAt
  const updated = e.metadata.updatedAt
  if (created) {
    out.push({
      at: created,
      title: 'Registered in catalog',
      detail: `Created as ${e.kind.toLowerCase()}:${e.metadata.name}`,
      kind: 'created',
    })
  }
  // Synthesise 2–3 deploy events between created and updated for components.
  if (e.kind === 'Component' && created && updated && created !== updated) {
    const start = new Date(created).getTime()
    const end = new Date(updated).getTime()
    if (end > start) {
      const span = end - start
      const versions = ['1.4.2', '1.4.3', '1.5.0']
      for (let i = 0; i < 3; i++) {
        const at = new Date(start + (span * (i + 1)) / 4).toISOString()
        out.push({
          at,
          title: `Deployed ${versions[i]}`,
          detail: i === 1 ? 'Auto-promoted from staging' : undefined,
          kind: 'deployed',
        })
      }
    }
  }
  if (e.spec.lifecycle === 'deprecated') {
    out.push({
      at: updated ?? new Date().toISOString(),
      title: 'Marked deprecated',
      detail: 'Schedule retirement and plan migration',
      kind: 'incident',
    })
  } else if (updated && updated !== created) {
    out.push({
      at: updated,
      title: 'Manifest updated',
      detail: 'Metadata or relations changed',
      kind: 'updated',
    })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6)
}

function ActivityCard({ events }: { events: Activity[] }) {
  if (!events.length) return null
  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold text-content">Activity</h3>
      </CardHeader>
      <CardBody>
        <ol className="relative space-y-3 border-l border-edge-subtle pl-4">
          {events.map((ev, i) => (
            <li key={i} className="relative">
              <span
                className={cn(
                  'absolute -left-[19px] top-1 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white',
                  ev.kind === 'created'
                    ? 'bg-brand-500'
                    : ev.kind === 'deployed'
                      ? 'bg-emerald-500'
                      : ev.kind === 'updated'
                        ? 'bg-sky-500'
                        : ev.kind === 'incident'
                          ? 'bg-rose-500'
                          : 'bg-violet-500',
                )}
              />
              <div className="text-[13px] font-medium text-content">{ev.title}</div>
              {ev.detail ? (
                <div className="mt-0.5 text-[11px] text-content-muted">{ev.detail}</div>
              ) : null}
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-content-subtle">
                {relativeTime(ev.at) || formatDate(ev.at)}
              </div>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  )
}

/* ─────────── icons / glyphs ─────────── */

function KindGlyph({
  kind,
  type,
  size = 'md',
}: {
  kind: EntityKind
  type?: string
  size?: 'md' | 'lg'
}) {
  const tone = KIND_TONES[kind]
  const letter = LETTER_FOR[kind][type ?? ''] ?? KIND_LABEL[kind][0]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-bold tracking-tight',
        tone,
        size === 'lg' ? 'h-10 w-10 text-[11px]' : 'h-6 w-6 text-[10px]',
      )}
    >
      {letter}
    </span>
  )
}

const KIND_TONES: Record<EntityKind, string> = {
  Component: 'bg-brand-100 text-brand-700 ring-1 ring-brand-200/60',
  API: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
  Resource: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200/60',
  System: 'bg-violet-100 text-violet-700 ring-1 ring-violet-200/60',
  Domain: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200/60',
  Group: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200/60',
  User: 'bg-slate-200 text-slate-700 ring-1 ring-slate-300/60',
}

const LETTER_FOR: Record<EntityKind, Record<string, string>> = {
  Component: {
    service: 'SV',
    website: 'WB',
    library: 'LB',
    'mobile-app': 'MB',
    documentation: 'DC',
  },
  API: { openapi: 'OA', asyncapi: 'AS', graphql: 'GQ', grpc: 'GR', trpc: 'TR' },
  Resource: {
    database: 'DB',
    cache: 'CA',
    queue: 'QQ',
    topic: 'TP',
    bucket: 'BK',
    cdn: 'CD',
    cluster: 'CL',
    's3-bucket': 'S3',
  },
  System: {},
  Domain: {},
  Group: {},
  User: {},
}

function LinkGlyph({
  icon,
}: {
  icon?: 'docs' | 'dashboard' | 'repo' | 'runbook' | 'chat' | 'on-call'
}) {
  switch (icon) {
    case 'docs':
      return (
        <Svg>
          <path d="M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4z" />
          <path d="M9 8h6" />
          <path d="M9 12h6" />
          <path d="M9 16h4" />
        </Svg>
      )
    case 'dashboard':
      return (
        <Svg>
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </Svg>
      )
    case 'repo':
      return (
        <Svg>
          <path d="M3 7v12a2 2 0 0 0 2 2h14V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2z" />
          <path d="M3 7h16" />
        </Svg>
      )
    case 'runbook':
      return (
        <Svg>
          <path d="M2 6h20v12H2z" />
          <path d="M6 10h12" />
          <path d="M6 14h8" />
        </Svg>
      )
    case 'chat':
      return (
        <Svg>
          <path d="M21 12a9 9 0 1 1-3.5-7.1L21 4l-1 4.5A9 9 0 0 1 21 12z" />
        </Svg>
      )
    case 'on-call':
      return (
        <Svg>
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
        </Svg>
      )
    default:
      return (
        <Svg>
          <path d="M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-1 1" />
          <path d="M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l1-1" />
        </Svg>
      )
  }
}

const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
)

function IconSearchLg() {
  return (
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
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function IconClose() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function IconRegister() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
      <path d="M5 21h14" />
    </svg>
  )
}

function IconUsers() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function IconBookOpen({ size = 14 }: { size?: number } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z" />
      <path d="M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z" />
    </svg>
  )
}

function IconStar() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function IconStarFilled() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function IconAlert() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

function IconBox() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73L13 2.27a2 2 0 0 0-2 0L4 6.27A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4.04a2 2 0 0 0 2 0l7-4.04A2 2 0 0 0 21 16z" />
      <path d="m3.27 6.96 8.73 5.05 8.73-5.05" />
      <path d="M12 22.08V12" />
    </svg>
  )
}

function IconShield() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function IconDash() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12h14" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function IconFilter() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  )
}

function IconGrid() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

function IconList() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  )
}

function IconTable() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M9 4v16" />
    </svg>
  )
}

/* ─────────── register-existing modal ─────────── */

const KIND_OPTIONS: { value: EntityKind; label: string }[] = [
  { value: 'Component', label: 'Component (service / library / website)' },
  { value: 'API', label: 'API' },
  { value: 'Resource', label: 'Resource (database, queue, bucket…)' },
  { value: 'System', label: 'System' },
  { value: 'Domain', label: 'Domain' },
]

const LIFECYCLE_OPTIONS: { value: Lifecycle; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'staging', label: 'Staging' },
  { value: 'experimental', label: 'Experimental' },
  { value: 'deprecated', label: 'Deprecated' },
]

/**
 * One-screen "register an existing service" form.
 *
 * Fast paths:
 *   - paste a repo URL → we extract a slug for `name`
 *   - everything else (kind, owner, lifecycle) ships with sensible defaults
 *
 * Required: just `name`. Owner defaults to the org's most common owner if
 * one is detectable; otherwise to `team:platform`. Kind defaults to
 * `Component` since most additions are services.
 */
function RegisterExistingModal({
  open,
  onClose,
  onCreated,
  owners,
  systems,
}: {
  open: boolean
  onClose(): void
  onCreated(e: Entity): void
  owners: { value: string; label: string }[]
  systems: { value: string; label: string }[]
}) {
  const register = useRegisterEntity()
  const [repoUrl, setRepoUrl] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<EntityKind>('Component')
  const [owner, setOwner] = useState('')
  const [description, setDescription] = useState('')
  const [system, setSystem] = useState('')
  const [lifecycle, setLifecycle] = useState<Lifecycle>('production')
  const [tags, setTags] = useState('')
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)

  const ownerOptions = useMemo(() => owners.filter((o) => o.value !== 'all'), [owners])
  const systemOptions = useMemo(() => systems.filter((s) => s.value !== 'all'), [systems])

  // Reset form whenever the dialog re-opens so an aborted draft doesn't
  // resurrect later. Owner default tracks the most common owner in the
  // catalog if one is available; otherwise a stable fallback.
  useEffect(() => {
    if (!open) return
    setRepoUrl('')
    setName('')
    setKind('Component')
    setOwner(ownerOptions[0]?.value ?? 'team:platform')
    setDescription('')
    setSystem('')
    setLifecycle('production')
    setTags('')
    setMore(false)
    setError(null)
    // Focus on the URL field for the fastest path.
    requestAnimationFrame(() => firstFieldRef.current?.focus())
  }, [open, ownerOptions])

  function detectFromUrl() {
    if (!repoUrl.trim()) return
    try {
      const u = new URL(repoUrl.trim())
      const segments = u.pathname.split('/').filter(Boolean)
      const slug = (segments[segments.length - 1] || '').replace(/\.git$/, '')
      if (slug) {
        setName((current) => current || slug.toLowerCase())
        if (!description) {
          setDescription(`Imported from ${u.hostname}/${segments.slice(0, 2).join('/')}.`)
        }
      }
    } catch {
      setError(
        'That URL doesn’t look right — paste a full repo URL like https://gitea.acme.io/team/svc.',
      )
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const trimmed = name.trim().toLowerCase()
    if (!trimmed) {
      setError('Name is required.')
      return
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
      setError('Name can only contain lowercase letters, numbers, and hyphens.')
      return
    }
    const links = repoUrl.trim()
      ? [{ url: repoUrl.trim(), title: 'Repository', icon: 'repo' as const }]
      : undefined
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind,
      metadata: {
        name: trimmed,
        namespace: 'default',
        title: trimmed,
        description: description.trim() || undefined,
        tags: tags
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        links,
      },
      spec: {
        type: kind === 'Component' ? 'service' : undefined,
        lifecycle,
        owner: owner || 'team:platform',
        system: system || undefined,
      },
    }
    register.mutate(entity, {
      onSuccess: (saved) => onCreated(saved),
      onError: (err) => setError(err instanceof Error ? err.message : 'Could not register entity.'),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      branded
      title="Register existing service"
      description="Already running somewhere? Drop the basics in here — we’ll add it to the catalog so it shows up next to everything else."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form="register-existing-form"
            loading={register.isPending}
          >
            Register
          </Button>
        </>
      }
    >
      <form id="register-existing-form" onSubmit={submit} className="space-y-5">
        {/* Quick path — paste a repo URL, auto-fill the name. */}
        <div className="rounded-xl border border-edge-default bg-surface-sunken/60 p-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
            Fast path
          </div>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <Input
              ref={firstFieldRef}
              type="url"
              placeholder="https://gitea.acme.io/team/service-name"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={detectFromUrl}
              disabled={!repoUrl.trim()}
            >
              Detect basics
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-content-muted">
            Paste a Git URL — we’ll pre-fill the name from the repo slug.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Name" required hint="lowercase, hyphens only">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="orders-svc"
              required
            />
          </FormField>

          <FormField label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as EntityKind)}>
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Owner">
            <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
              {ownerOptions.length === 0 ? (
                <option value="team:platform">team:platform</option>
              ) : (
                ownerOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))
              )}
            </Select>
          </FormField>

          <FormField label="Lifecycle">
            <Select value={lifecycle} onChange={(e) => setLifecycle(e.target.value as Lifecycle)}>
              {LIFECYCLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <FormField label="Description" hint="Optional. One sentence is plenty.">
          <Textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this service do?"
          />
        </FormField>

        <button
          type="button"
          onClick={() => setMore((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-content-muted hover:text-content"
        >
          <span className={cn('inline-block transition-transform', more ? 'rotate-90' : '')}>
            ▸
          </span>
          {more ? 'Hide' : 'Show'} more options
        </button>

        {more ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="System">
              <Select value={system} onChange={(e) => setSystem(e.target.value)}>
                <option value="">— None —</option>
                {systemOptions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField label="Tags" hint="Comma-separated">
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="payments, java, hot"
              />
            </FormField>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-medium text-rose-700">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  )
}
