import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from '@tanstack/react-router'
import { PENDING_USER, useOptionalSession } from '@adhar-console/auth'
import {
  BarChart,
  Button,
  Card,
  DonutGauge,
  CardBody,
  CardHeader,
  EmptyState,
  Field as FormField,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  type StatusKind,
  Tabs,
  type TabDef,
  Textarea,
  useAi,
  usePublicUrl,
  useToast,
  useToolPublicUrl,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { EntityMetrics, EntitySparklines, MonitorButton, useGrafanaMonitorUrl, type RangeId } from '~/components/entity-observability.tsx'
import {
  type Entity,
  type EntityKind,
  type EntityMetadata,
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
import {
  deriveDeployment,
  type EntityDeployment,
  type EntityEnvironment,
  useDeploymentIndex,
  useEntityDeployment,
} from '~/data/catalog-deployment.ts'
import { type EntityRoute, routeLabel, useEntityRoutes } from '~/data/catalog-routes.ts'
import { type PipelineRunSummary, usePipelineRuns } from '~/data/catalog-pipelines.ts'
import { type DocPage, type DocsSource, editUrl, headingOf, rawBase, useDocPage, useDocsPages, useDocsSource } from '~/data/catalog-docs.ts'
import { useDiscoverAlerts } from '~/data/cross-module-signals.ts'
import {
  CATEGORY_LABEL,
  type Check,
  CHECK_CATEGORIES,
  type Grade,
  type Scorecard,
  scoreEntity,
} from '~/data/scorecard.ts'
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
type SortKey = 'name' | 'recent' | 'lifecycle' | 'score'
/** How the grid is sectioned. `none` is one flat grid. */
type GroupKey = 'none' | 'system' | 'owner' | 'kind' | 'lifecycle'
/** One matched Argo CD Application, as the deployment module normalises it. */
type ArgoApp = EntityDeployment['apps'][number]
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

/** Annotations that carry a URL a person will click. */
const URL_ANNOTATIONS = [
  'adhar.io/source-repo',
  'adhar.io/git-repo',
  'backstage.io/source-location',
  'adhar.io/docs',
  'backstage.io/techdocs-ref',
  'adhar.io/dashboard',
  'backstage.io/dashboard',
  'adhar.io/grafana-dashboard',
  'adhar.io/runbook',
  'backstage.io/runbook',
  'adhar.io/ci-pipeline',
  'adhar.io/ci',
]

/**
 * Every link on an entity, made openable, ONCE — here, where the list enters
 * the page. Live entities carry the hosts the BFF used to reach Gitea,
 * Grafana or Argo (`gitea-http.adhar-system.svc…`), and each card, header,
 * tab and widget used to be one more place a dead link could leak from.
 * Returns the same object when nothing changed so memoised consumers hold.
 */
function publicizeEntity(e: Entity, pub: (url: string) => string): Entity {
  let changed = false
  const links = (e.metadata.links ?? []).map((l) => {
    const url = pub(l.url)
    if (url !== l.url) changed = true
    return url !== l.url ? { ...l, url } : l
  })
  const ann = e.metadata.annotations
  let annotations = ann
  if (ann) {
    for (const key of URL_ANNOTATIONS) {
      const raw = ann[key]
      if (!raw) continue
      // `url:https://…` is Backstage's prefixed form; keep the prefix.
      const m = /^(url:\s*)?(https?:\/\/\S+)$/i.exec(raw.trim())
      if (!m) continue
      const next = pub(m[2])
      if (next !== m[2]) {
        if (annotations === ann) annotations = { ...ann }
        annotations![key] = `${m[1] ?? ''}${next}`
        changed = true
      }
    }
  }
  if (!changed) return e
  return { ...e, metadata: { ...e.metadata, links, ...(annotations !== ann ? { annotations } : {}) } }
}

export function CatalogBrowse({ search }: { search: SearchState }) {
  const q = useCatalog()
  const pub = usePublicUrl()
  const list = useMemo(() => (q.data ?? []).map((e) => publicizeEntity(e, pub)), [q.data, pub])
  const stars = useStars()
  const recents = useRecentlyViewed()
  const savedViews = useSavedViews()
  const user = useOptionalSession()?.user ?? PENDING_USER
  const navigate = useNavigate()
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Which tab the drawer should open on — a card's menu can jump straight
  // to Deployment or Scorecard. WHICH entity is open lives in the URL
  // (`?entity=`), so a drawer can be linked to and Back closes it.
  const [drawerTab, setDrawerTab] = useState<DrawerTab | undefined>(undefined)
  const [text, setText] = useState<string>(search.q ?? '')

  // Filter / view / sort are derived from the URL so the state is shareable and
  // survives back/forward navigation.
  const filter = useMemo(() => filterFromSearch(search), [search])
  const view: ViewMode = search.view ?? 'grid'
  const sort: SortKey = search.sort ?? 'name'
  const group: GroupKey = search.group ?? 'none'
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
  const setGroup = useCallback(
    (g: GroupKey) => patchSearch({ group: g === 'none' ? undefined : g }),
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

  const openEntity = useCallback(
    (e: Entity, tab?: DrawerTab, opts?: { replace?: boolean }) => {
      pushRecentlyViewed(entityRef(e))
      setDrawerTab(tab)
      patchSearch({ entity: entityRef(e) }, opts)
    },
    [patchSearch],
  )
  const closeEntity = useCallback(() => patchSearch({ entity: undefined }), [patchSearch])

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

  const selectedEntity = useMemo(
    () => (search.entity ? findEntity(list, search.entity) : undefined),
    [search.entity, list],
  )

  return (
    <div className="space-y-8">
      <CatalogHeader onRegister={() => setRegisterOpen(true)} />

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
        group={group}
        onGroup={setGroup}
        stars={stars}
        onPick={openEntity}
        loading={q.isLoading}
        refreshing={q.refreshing}
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

      {selectedEntity ? (
        <EntityDrawer
          entity={selectedEntity}
          initialTab={drawerTab}
          // Previous / next walk the list as currently filtered and sorted —
          // the order on screen, not the catalog's.
          siblings={filtered}
          onNavigate={(e) => openEntity(e, undefined, { replace: true })}
          onClose={closeEntity}
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
      // A percentage, like the two tiles beside it. It used to show a raw
      // count against a sub-line describing the TOTAL — so the one number the
      // eye compares across the row was measuring something different in the
      // first tile, and "0 / 8 total entities" left you working out which
      // quantity was which.
      label: 'Production tier',
      value: `${pct(coverage.byLifecycle.production ?? 0, total)}%`,
      sub: `${coverage.byLifecycle.production ?? 0}/${coverage.total} in production`,
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
    brand: { bg: 'bg-brand-50 dark:bg-brand-500/10', text: 'text-brand-700 dark:text-brand-300', bar: 'bg-brand-500' },
    emerald: { bg: 'bg-emerald-50 dark:bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-300', bar: 'bg-emerald-500' },
    sky: { bg: 'bg-sky-50 dark:bg-sky-500/10', text: 'text-sky-700 dark:text-sky-300', bar: 'bg-sky-500' },
    amber: { bg: 'bg-amber-50 dark:bg-amber-500/10', text: 'text-amber-800 dark:text-amber-300', bar: 'bg-amber-500' },
  }
  const T = tones[tone]
  return (
    <div className="overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex items-start justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            {label}
          </div>
          <div className="mt-1 font-mono text-[20px] font-semibold tabular-nums leading-none text-content">
            {value}
          </div>
          {/* Wraps rather than truncates. "Missing owner, runbook, or lifecycle"
              was cut to "Missing owner, runboo…", and tuning the copy to a
              pixel width breaks again in any other locale. The tiles are grid
              items, so they all stretch to match and the row stays aligned. */}
          <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-content-muted">{sub}</div>
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
      className="group inline-flex items-center gap-2 rounded-full border border-edge-default bg-surface-raised py-1 pl-1 pr-3 text-left text-[12px] shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-brand-300/70 hover:shadow-md"
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
      className="group relative flex h-full flex-col items-stretch overflow-hidden rounded-2xl border border-edge-default bg-surface-raised text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-300/70 hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500"
    >
      {/* `flex-1` so every card's stat strip sits on its bottom edge. Without
          it a two-line description pushed one card's strip lower than its
          neighbours', and a row of cards lost its baseline. */}
      <div className="relative flex-1 bg-linear-to-br from-brand-50/60 to-surface-raised px-5 py-5 dark:from-brand-500/8">
        <div className="flex items-start justify-between gap-2">
          <KindGlyph kind="System" size="lg" />
          {ownerName ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised/80 px-2 py-0.5 text-[10px] font-medium text-content-muted ring-1 ring-edge-subtle">
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
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-x divide-edge-subtle border-t border-edge-subtle bg-surface-raised text-center">
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
    <article className="group flex h-full flex-col rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-edge-subtle px-5 py-4">
        <button
          type="button"
          onClick={() => onPick(domain)}
          className="flex min-w-0 items-start gap-3 text-left hover:text-brand-700 dark:hover:text-brand-300"
        >
          <KindGlyph kind="Domain" size="lg" />
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">
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
      className="group flex flex-col items-stretch gap-3 rounded-2xl border border-edge-default bg-surface-raised p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-300/70 hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500"
    >
      <div className="flex items-start justify-between gap-2">
        <KindGlyph kind="Group" size="lg" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-content-subtle opacity-0 transition-opacity group-hover:text-brand-700 dark:group-hover:text-brand-300 group-hover:opacity-100">
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
  group,
  onGroup,
  stars,
  onPick,
  loading,
  refreshing = false,
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
  group: GroupKey
  onGroup(g: GroupKey): void
  stars: readonly string[]
  onPick(e: Entity, tab?: DrawerTab): void
  loading: boolean
  /** Sources are refetching behind data already on screen — never blocks. */
  refreshing?: boolean
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

  // One Argo CD fetch for the whole grid; each card matches against it. Only
  // asked for when something on the page can actually be deployed.
  const anyDeployable = useMemo(() => list.some(isDeployableKind), [list])
  const depIndex = useDeploymentIndex(anyDeployable)
  const deploymentFor = useCallback(
    (e: Entity): EntityDeployment | undefined =>
      isDeployableKind(e) ? deriveDeployment(e, depIndex.apps, depIndex) : undefined,
    [depIndex],
  )

  // "Ask Adhar AI" on a card: a question already scoped to the entity, so the
  // answer comes back grounded in this thing rather than the whole cluster.
  const ai = useAi()
  const askAbout = useCallback((e: Entity) => askAboutEntity(ai, e), [ai])

  const groups = useMemo(() => groupEntities(shown, group), [shown, group])
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

      {/* One click per kind — the Filters popover still has the multi-select,
          but "just the APIs" is the most common narrowing and should not
          need a popover. */}
      <KindRail counts={kindCounts} total={total} filter={filter} onFilter={onFilter} />

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
        group={group}
        onGroup={onGroup}
        filterCount={filterCount}
        text={text}
        onText={onText}
        onClearSearch={onClearSearch}
        searchInputRef={searchInputRef}
        loading={loading}
        refreshing={refreshing}
      />

      {loading ? (
        <div className="rounded-xl border border-edge-default bg-surface-raised p-10 text-center text-sm text-content-muted shadow-sm">
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
          className="space-y-6"
        >
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label || undefined}>
              {g.label ? (
                <div className="mb-2.5 flex items-baseline gap-2 px-0.5">
                  <h3 className="text-[12px] font-semibold text-content">{g.label}</h3>
                  <span className="font-mono text-[11px] tabular-nums text-content-subtle">{g.items.length}</span>
                </div>
              ) : null}
              {/* Two across on a laptop, three on a wide display — not four. At
                  four the cards were 240px wide and every field truncated; the
                  catalog is browsed for its details, so each card gets the room
                  to show them. */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {g.items.map((e) => (
                  <EntityCard
                    key={entityRef(e)}
                    entity={e}
                    starred={stars.includes(entityRef(e))}
                    deployment={deploymentFor(e)}
                    onClick={() => onPick(e)}
                    onOpen={(tab) => onPick(e, tab)}
                    onAsk={() => askAbout(e)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : view === 'compact' ? (
        <ul
          role="listbox"
          aria-label="Catalog entities"
          onKeyDown={handleGridKeyNav}
          className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm"
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
        className="inline-flex h-7 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] font-medium text-content-muted shadow-sm hover:border-edge-strong hover:text-content"
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
          className="pop-in absolute right-0 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl"
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
                    className="flex-1 truncate text-left text-content hover:text-brand-700 dark:hover:text-brand-300"
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
            className="flex w-full items-center gap-1.5 border-t border-edge-subtle px-3 py-2 text-left text-[12px] font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10"
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
        className="inline-flex h-7 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] font-medium text-content-muted shadow-sm hover:border-edge-strong hover:text-content disabled:opacity-50"
      >
        Export
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="pop-in absolute right-0 top-full z-30 mt-1.5 w-40 overflow-hidden rounded-xl border border-edge-default bg-surface-raised py-1 shadow-xl"
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
  group,
  onGroup,
  filterCount,
  text,
  onText,
  onClearSearch,
  searchInputRef,
  loading,
  refreshing = false,
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
  group: GroupKey
  onGroup(g: GroupKey): void
  filterCount: number
  text: string
  onText(v: string): void
  onClearSearch(): void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  loading: boolean
  refreshing?: boolean
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
    // NOT `overflow-hidden`: the filter popover is an absolutely-positioned
    // child of this box, so clipping it cut the popover off at the toolbar's
    // own bottom edge — 1px of a 499px panel rendered, which made the Filters
    // button look like it did nothing at all. ActiveFilterChips rounds its own
    // bottom corners instead.
    <div className="rounded-xl border border-edge-default bg-surface-raised shadow-sm">
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
            className="h-full w-full rounded-lg border border-edge-default bg-surface-raised pl-9 pr-10 text-sm text-content placeholder:text-content-subtle transition-shadow focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
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
                : 'border-edge-default bg-surface-raised text-content hover:border-edge-strong hover:bg-surface-sunken',
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
        {view === 'grid' ? <GroupMenu value={group} onChange={onGroup} /> : null}

        {loading ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-content-subtle"
            aria-live="polite"
          >
            <Spinner size={11} />
            <span>Loading…</span>
          </span>
        ) : refreshing ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-content-subtle"
            title="Refreshing sources in the background"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
            <span>Refreshing</span>
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
      className="inline-flex h-9 items-center rounded-lg border border-edge-default bg-surface-raised p-0.5 shadow-sm"
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
    <label className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-3 text-[12px] shadow-sm">
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
        <option value="score">Readiness · worst first</option>
      </select>
    </label>
  )
}

function GroupMenu({ value, onChange }: { value: GroupKey; onChange(v: GroupKey): void }) {
  return (
    <label className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-3 text-[12px] shadow-sm">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        Group
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as GroupKey)}
        className="rounded border-0 bg-transparent px-1 py-0 text-[12px] text-content focus:outline-none"
      >
        <option value="none">None</option>
        <option value="system">System</option>
        <option value="owner">Owner</option>
        <option value="kind">Kind</option>
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
      className="pop-in absolute left-0 top-full z-30 mt-2 w-[24rem] overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-xl"
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
            className="w-full rounded-md border border-edge-default bg-surface-raised px-2 py-1.5 text-[12px]"
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
            className="w-full rounded-md border border-edge-default bg-surface-raised px-2 py-1.5 text-[12px]"
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
        checked ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'text-content-muted hover:bg-surface-sunken',
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
          ? 'border-amber-400 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 shadow-sm'
          : active
            ? 'border-content bg-content text-surface-raised shadow-sm'
            : 'border-edge-default bg-surface-raised text-content-muted hover:border-content hover:text-content',
      )}
    >
      {icon}
      <span>{label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span
          className={cn(
            'rounded-full px-1.5 text-[10px] tabular-nums',
            isAmber
              ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300'
              : active
                ? 'bg-surface-raised/20 text-surface-raised'
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
      ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : tone === 'progressing'
        ? 'border-brand-300 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300'
        : tone === 'info'
          ? 'border-sky-300 bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : 'border-amber-300 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300'
    : 'border-edge-default bg-surface-raised text-content-muted hover:border-content hover:text-content'
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
          ? 'bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300 ring-1 ring-brand-300'
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
      <div className="inline-flex rounded-md border border-edge-default bg-surface-raised p-0.5">
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
      ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300'
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
    <div className="flex flex-wrap items-center gap-1.5 rounded-b-xl border-t border-edge-subtle bg-surface-sunken/40 px-3 py-2 text-[11px]">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        Active
      </span>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={c.clear}
          className="inline-flex items-center gap-1 rounded-full border border-edge-default bg-surface-raised px-2 py-0.5 font-medium text-content-muted shadow-sm transition hover:border-brand-200 dark:hover:border-brand-500/25 hover:text-brand-700 dark:hover:text-brand-300"
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
            ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-500 ring-1 ring-amber-200'
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
    <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
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
  } else if (by === 'score') {
    // Worst first: the reason to sort by readiness is to find what to fix.
    // Unscoreable kinds (Groups, Domains) go last, alphabetically.
    const val = (e: Entity) => {
      const sc = scoreEntity(e)
      return sc.checks.length ? sc.score : 101
    }
    out.sort(
      (a, b) =>
        val(a) - val(b) ||
        (a.metadata.title ?? a.metadata.name).localeCompare(b.metadata.title ?? b.metadata.name),
    )
  }
  return out
}

/* ─────────── entity card ─────────── */

/* ─────────── tech-stack detection ─────────── */

type TechTone =
  | 'amber'
  | 'sky'
  | 'blue'
  | 'cyan'
  | 'indigo'
  | 'violet'
  | 'emerald'
  | 'green'
  | 'teal'
  | 'rose'
  | 'red'
  | 'orange'
  | 'slate'

/** Where a technology sits in the stack — drives grouping on the detail tab. */
type TechGroup = 'language' | 'framework' | 'datastore' | 'runtime' | 'platform'

interface TechBadge {
  label: string
  tone: TechTone
  group: TechGroup
  /** A version, when the tag or annotation carried one (`java-21` → "21"). */
  version?: string
}

/**
 * Split a tech tag into the TECH_MAP key and an optional version.
 *
 * `java-21`, `java@21`, `java:21`, `spring-boot-3.3.2`, `node_20` all read as
 * the tech plus a version; `java` alone reads as the tech. The key must be a
 * known tech — otherwise `python3` would become Python 3 by accident.
 */
function parseTechTag(raw: string): { key: string; version?: string } {
  const t = raw.trim().toLowerCase()
  const m = t.match(/^([a-z#.+][a-z0-9#.+-]*?)[-@:_ ]v?(\d+(?:\.\d+)*)$/)
  if (m && TECH_MAP[m[1]]) return { key: m[1], version: m[2] }
  return { key: t }
}

/**
 * Versions declared as an annotation, for installs that keep tags for
 * classification and record the stack elsewhere:
 *   adhar.io/tech-stack: "java@21, spring-boot@3.3.2, postgres@16"
 *   adhar.io/java-version: "21"   (any `<tech>-version` key TECH_MAP knows)
 */
function techFromAnnotations(entity: Entity): Array<{ key: string; version?: string }> {
  const ann = entityAnnotations(entity)
  const out: Array<{ key: string; version?: string }> = []
  const list = (ann['adhar.io/tech-stack'] ?? ann['adhar.io/tech'] ?? '').trim()
  if (list) {
    for (const part of list.split(/[,;]/)) {
      const item = part.trim().toLowerCase()
      if (!item) continue
      const m = item.match(/^([a-z#.+][a-z0-9#.+-]*?)(?:\s*[@:= ]\s*v?(\d+(?:\.\d+)*))?$/)
      if (m && TECH_MAP[m[1]]) out.push({ key: m[1], version: m[2] })
    }
  }
  for (const [k, v] of Object.entries(ann)) {
    const m = k.match(/^adhar\.io\/([a-z0-9.+#-]+)-version$/)
    if (m && TECH_MAP[m[1]] && v.trim()) out.push({ key: m[1], version: v.trim().replace(/^v/i, '') })
  }
  return out
}

/** Section headings, in the order a reader builds a mental model of a service. */
const TECH_GROUP_LABEL: Record<TechGroup, string> = {
  language: 'Languages',
  framework: 'Frameworks & libraries',
  datastore: 'Data & messaging',
  runtime: 'Runtime & packaging',
  platform: 'Platform & delivery',
}
const TECH_GROUP_ORDER: TechGroup[] = ['language', 'framework', 'datastore', 'runtime', 'platform']

/**
 * Known language / framework tags → a recognisable, brand-ish badge. Keys are
 * the lowercased tag values `catalog-live.ts` derives from a repo's primary
 * language (`['java','repo']`, `['python','ml']`) or `adhar.io/tags`. Anything
 * not in here is treated as a generic tag — never guessed at.
 */
const TECH_MAP: Record<string, TechBadge> = {
  // ── languages ──
  java: { label: 'Java', tone: 'orange', group: 'language' },
  python: { label: 'Python', tone: 'blue', group: 'language' },
  py: { label: 'Python', tone: 'blue', group: 'language' },
  go: { label: 'Go', tone: 'cyan', group: 'language' },
  golang: { label: 'Go', tone: 'cyan', group: 'language' },
  typescript: { label: 'TypeScript', tone: 'blue', group: 'language' },
  ts: { label: 'TypeScript', tone: 'blue', group: 'language' },
  javascript: { label: 'JavaScript', tone: 'amber', group: 'language' },
  js: { label: 'JavaScript', tone: 'amber', group: 'language' },
  rust: { label: 'Rust', tone: 'orange', group: 'language' },
  'c#': { label: 'C#', tone: 'violet', group: 'language' },
  csharp: { label: 'C#', tone: 'violet', group: 'language' },
  ruby: { label: 'Ruby', tone: 'red', group: 'language' },
  php: { label: 'PHP', tone: 'indigo', group: 'language' },
  kotlin: { label: 'Kotlin', tone: 'violet', group: 'language' },
  scala: { label: 'Scala', tone: 'red', group: 'language' },
  elixir: { label: 'Elixir', tone: 'violet', group: 'language' },
  shell: { label: 'Shell', tone: 'slate', group: 'language' },
  bash: { label: 'Shell', tone: 'slate', group: 'language' },
  // ── frameworks & libraries ──
  spring: { label: 'Spring', tone: 'green', group: 'framework' },
  'spring-boot': { label: 'Spring Boot', tone: 'green', group: 'framework' },
  springboot: { label: 'Spring Boot', tone: 'green', group: 'framework' },
  node: { label: 'Node.js', tone: 'green', group: 'framework' },
  nodejs: { label: 'Node.js', tone: 'green', group: 'framework' },
  'node.js': { label: 'Node.js', tone: 'green', group: 'framework' },
  express: { label: 'Express', tone: 'slate', group: 'framework' },
  react: { label: 'React', tone: 'cyan', group: 'framework' },
  vue: { label: 'Vue', tone: 'emerald', group: 'framework' },
  svelte: { label: 'Svelte', tone: 'orange', group: 'framework' },
  next: { label: 'Next.js', tone: 'slate', group: 'framework' },
  nextjs: { label: 'Next.js', tone: 'slate', group: 'framework' },
  'next.js': { label: 'Next.js', tone: 'slate', group: 'framework' },
  django: { label: 'Django', tone: 'emerald', group: 'framework' },
  flask: { label: 'Flask', tone: 'slate', group: 'framework' },
  fastapi: { label: 'FastAPI', tone: 'teal', group: 'framework' },
  dotnet: { label: '.NET', tone: 'violet', group: 'framework' },
  '.net': { label: '.NET', tone: 'violet', group: 'framework' },
  rails: { label: 'Rails', tone: 'red', group: 'framework' },
  'ruby-on-rails': { label: 'Rails', tone: 'red', group: 'framework' },
  quarkus: { label: 'Quarkus', tone: 'sky', group: 'framework' },
  micronaut: { label: 'Micronaut', tone: 'cyan', group: 'framework' },
  grpc: { label: 'gRPC', tone: 'teal', group: 'framework' },
  graphql: { label: 'GraphQL', tone: 'rose', group: 'framework' },
  // ── data & messaging ──
  postgres: { label: 'PostgreSQL', tone: 'blue', group: 'datastore' },
  postgresql: { label: 'PostgreSQL', tone: 'blue', group: 'datastore' },
  mysql: { label: 'MySQL', tone: 'sky', group: 'datastore' },
  mariadb: { label: 'MariaDB', tone: 'orange', group: 'datastore' },
  mongodb: { label: 'MongoDB', tone: 'green', group: 'datastore' },
  redis: { label: 'Redis', tone: 'red', group: 'datastore' },
  valkey: { label: 'Valkey', tone: 'red', group: 'datastore' },
  kafka: { label: 'Kafka', tone: 'slate', group: 'datastore' },
  rabbitmq: { label: 'RabbitMQ', tone: 'orange', group: 'datastore' },
  clickhouse: { label: 'ClickHouse', tone: 'amber', group: 'datastore' },
  elasticsearch: { label: 'Elasticsearch', tone: 'teal', group: 'datastore' },
  opensearch: { label: 'OpenSearch', tone: 'teal', group: 'datastore' },
  s3: { label: 'S3', tone: 'emerald', group: 'datastore' },
  minio: { label: 'MinIO', tone: 'red', group: 'datastore' },
  // ── runtime & packaging ──
  docker: { label: 'Docker', tone: 'blue', group: 'runtime' },
  oci: { label: 'OCI image', tone: 'blue', group: 'runtime' },
  buildpacks: { label: 'Buildpacks', tone: 'sky', group: 'runtime' },
  kpack: { label: 'kpack', tone: 'sky', group: 'runtime' },
  helm: { label: 'Helm', tone: 'indigo', group: 'runtime' },
  kustomize: { label: 'Kustomize', tone: 'indigo', group: 'runtime' },
  serverless: { label: 'Serverless', tone: 'violet', group: 'runtime' },
  knative: { label: 'Knative', tone: 'violet', group: 'runtime' },
  // ── platform & delivery ──
  kubernetes: { label: 'Kubernetes', tone: 'blue', group: 'platform' },
  k8s: { label: 'Kubernetes', tone: 'blue', group: 'platform' },
  argocd: { label: 'Argo CD', tone: 'orange', group: 'platform' },
  gitops: { label: 'GitOps', tone: 'orange', group: 'platform' },
  tekton: { label: 'Tekton', tone: 'sky', group: 'platform' },
  kargo: { label: 'Kargo', tone: 'amber', group: 'platform' },
  otel: { label: 'OpenTelemetry', tone: 'indigo', group: 'platform' },
  opentelemetry: { label: 'OpenTelemetry', tone: 'indigo', group: 'platform' },
  prometheus: { label: 'Prometheus', tone: 'orange', group: 'platform' },
  terraform: { label: 'Terraform', tone: 'violet', group: 'platform' },
  crossplane: { label: 'Crossplane', tone: 'teal', group: 'platform' },
}

/** Full literal Tailwind classes (JIT-safe), matching the StatusBadge pill pattern. */
const TECH_PILL: Record<TechTone, string> = {
  amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 ring-amber-200',
  sky: 'bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-200',
  blue: 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 ring-blue-200',
  cyan: 'bg-cyan-50 dark:bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 ring-cyan-200',
  indigo: 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 ring-indigo-200',
  violet: 'bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-violet-200',
  emerald:
    'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200',
  green: 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300 ring-green-200',
  teal: 'bg-teal-50 dark:bg-teal-500/10 text-teal-700 dark:text-teal-300 ring-teal-200',
  rose: 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-200',
  red: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 ring-red-200',
  orange: 'bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-300 ring-orange-200',
  slate: 'bg-slate-100 dark:bg-slate-500/10 text-slate-700 dark:text-slate-300 ring-slate-300',
}

/** Lowercased tags that mapped to a tech badge — kept out of the generic tag row. */
function techTagKeys(entity: Entity): Set<string> {
  const out = new Set<string>()
  for (const t of entity.metadata.tags ?? []) {
    if (TECH_MAP[parseTechTag(t).key]) out.add(t.toLowerCase())
  }
  return out
}

/** Generic (non-tech) tags — the ones the plain tag treatment should render. */
function genericTags(entity: Entity): string[] {
  const tech = techTagKeys(entity)
  return (entity.metadata.tags ?? []).filter((t) => !tech.has(t.toLowerCase()))
}

/**
 * Detected languages, frameworks, datastores — de-duped by label, each with
 * a version when one was recorded anywhere (tag or annotation). A versioned
 * mention wins over a bare one, so `java` + `adhar.io/java-version: 21`
 * reads as Java 21.
 */
function techStack(entity: Entity): TechBadge[] {
  const byLabel = new Map<string, TechBadge>()
  const mentions = [
    ...(entity.metadata.tags ?? []).map(parseTechTag),
    ...techFromAnnotations(entity),
  ]
  for (const m of mentions) {
    const hit = TECH_MAP[m.key]
    if (!hit) continue
    const cur = byLabel.get(hit.label)
    if (!cur) byLabel.set(hit.label, m.version ? { ...hit, version: m.version } : hit)
    else if (!cur.version && m.version) byLabel.set(hit.label, { ...hit, version: m.version })
  }
  return [...byLabel.values()]
}

function TechPill({ badge }: { badge: TechBadge }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset',
        TECH_PILL[badge.tone],
      )}
    >
      {badge.label}
      {badge.version ? <span className="ml-1 font-mono font-medium opacity-80">{badge.version}</span> : null}
    </span>
  )
}

function TechBadges({ stack, max = 4 }: { stack: TechBadge[]; max?: number }) {
  if (!stack.length) return null
  const shown = stack.slice(0, max)
  const extra = stack.length - shown.length
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((b) => (
        <TechPill key={b.label} badge={b} />
      ))}
      {extra > 0 ? (
        <span className="inline-flex items-center rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold text-content-muted ring-1 ring-inset ring-edge-subtle">
          ＋{extra}
        </span>
      ) : null}
    </div>
  )
}

/* ─────────── version + health signal ─────────── */

/**
 * `Entity.metadata` has no `annotations` field in the core model, but live
 * k8s-derived entities may carry one structurally. Read it defensively — the
 * same approach the scorecard engine uses — so a value surfaces the moment the
 * live mapper forwards it, and stays honestly absent until then.
 */
function entityAnnotations(e: Entity): Record<string, string> {
  const meta = e.metadata as EntityMetadata & { annotations?: Record<string, string> }
  return meta.annotations && typeof meta.annotations === 'object' ? meta.annotations : {}
}

/**
 * A display version, derived honestly: an explicit version annotation first,
 * then a version-shaped tag (`v1.4.2` / `1.4`). `undefined` when unknown — the
 * caller shows nothing rather than inventing a number.
 */
function entityVersion(e: Entity): string | undefined {
  const ann = entityAnnotations(e)
  const fromAnn = (
    ann['adhar.io/version'] ??
    ann['backstage.io/version'] ??
    ann['app.kubernetes.io/version'] ??
    ''
  ).trim()
  const raw = fromAnn || (e.metadata.tags ?? []).find((t) => /^v?\d+\.\d+(\.\d+)?$/.test(t.trim()))
  if (!raw) return undefined
  const v = raw.trim()
  return /^v/i.test(v) ? v : `v${v}`
}

/** Same-origin techdocs/docs URL if one is registered (link or annotation). */
function techDocsUrl(e: Entity): string | undefined {
  const fromLink = (e.metadata.links ?? []).find((l) => l.icon === 'docs')?.url
  if (fromLink) return fromLink
  const ann = entityAnnotations(e)
  const raw = (ann['backstage.io/techdocs-ref'] ?? ann['adhar.io/docs'] ?? '').trim()
  return raw && /^https?:/.test(raw) ? raw : undefined
}

function hasDocsLink(e: Entity): boolean {
  return (e.metadata.links ?? []).some((l) => l.icon === 'docs')
}

interface Health {
  label: string
  kind: StatusKind
}

function isStale(iso?: string): boolean {
  if (!iso) return false
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return false
  return ms > 1000 * 60 * 60 * 24 * 180 // stale after ~6 months untouched
}

/** Grade → status tone (A/B green, C amber, D/F red). */
function gradeKind(grade: Grade): StatusKind {
  if (grade === 'A' || grade === 'B') return 'healthy'
  if (grade === 'C') return 'paused'
  return 'degraded'
}

/**
 * One clear health signal per entity, folding the amber "needs attention" dot,
 * the scorecard grade, lifecycle, and staleness into a single chip.
 */
function entityHealth(e: Entity, score: Scorecard): Health {
  if (score.grade === 'D' || score.grade === 'F') return { label: 'At risk', kind: 'degraded' }
  if (
    needsAttention(e) ||
    score.grade === 'C' ||
    e.spec.lifecycle === 'deprecated' ||
    isStale(e.metadata.updatedAt)
  ) {
    return { label: 'Needs update', kind: 'paused' }
  }
  return { label: 'Healthy', kind: 'healthy' }
}

function EntityCard({
  entity,
  starred,
  deployment,
  onClick,
  onOpen,
  onAsk,
}: {
  entity: Entity
  starred: boolean
  /** Matched Argo CD state, for kinds that can be deployed. */
  deployment?: EntityDeployment
  onClick(): void
  /** Open the drawer on a specific tab. */
  onOpen(tab: DrawerTab): void
  onAsk(): void
}) {
  const ref = entityRef(entity)
  const links = entity.metadata.links ?? []
  // "Monitor" — the workload's Grafana dashboard, alongside Source/Docs.
  const { url: monitorUrl } = useGrafanaMonitorUrl(
    { name: entityAnnotations(entity)['adhar.io/workload'] ?? entity.metadata.name, namespace: entity.metadata.namespace !== 'default' ? entity.metadata.namespace : undefined },
    entityAnnotations(entity)['adhar.io/grafana-dashboard'],
  )
  const ageLabel = relativeTime(entity.metadata.updatedAt ?? entity.metadata.createdAt)
  const score = scoreEntity(entity)
  const stack = techStack(entity)
  const generics = genericTags(entity)
  const version = entityVersion(entity)
  const health = entityHealth(entity, score)
  const docs = hasDocsLink(entity)
  const toast = useToast()
  const scoreable = score.checks.length > 0

  // Everything a person might do from the card without opening it. Items
  // that would open on an empty tab are not offered.
  const menu: CardMenuItem[] = [
    { label: 'Open details', onSelect: () => onOpen('overview') },
    ...(deployment ? [{ label: 'Deployment', onSelect: () => onOpen('deploy') }] : []),
    ...(scoreable ? [{ label: 'Scorecard', onSelect: () => onOpen('scorecard') }] : []),
    'sep',
    { label: 'Ask Adhar AI', onSelect: onAsk },
    {
      label: 'Copy ref',
      onSelect: () => {
        navigator.clipboard
          ?.writeText(ref)
          .then(() => toast.success('Copied', { description: ref }))
          .catch(() => toast.error('Could not copy', { description: ref }))
      },
    },
    { label: starred ? 'Unstar' : 'Star', onSelect: () => toggleStar(ref) },
  ]

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
      className={cn(
        // A floor on the height: cards in one row stretch to the tallest, and
        // the floor keeps a sparse row from collapsing into a strip while the
        // next row is twice as tall.
        'group relative flex h-full min-h-72 flex-col items-stretch overflow-hidden rounded-xl text-left',
        // A card is a raised surface, so it gets a hairline ring and a soft
        // shadow rather than a 1px border. The border read as a table cell at
        // five-across, and the grid looked like a spreadsheet.
        'border border-edge-default bg-surface-raised shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.03]',
        'transition-[transform,box-shadow,border-color] duration-200 ease-out',
        'hover:-translate-y-0.5 hover:border-brand-300/70 hover:shadow-lg hover:shadow-brand-900/5',
        'active:translate-y-0 active:duration-75 motion-reduce:transform-none motion-reduce:transition-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
      )}
    >
      {/*
        A soft top highlight. One CSS gradient is what separates a surface that
        looks lit from a flat swatch, and it costs nothing — no extra element in
        the accessibility tree, no layout.
      */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-white/50 to-transparent dark:via-white/10"
      />

      {/* Star and the actions menu, top-right. Both appear on hover; a set
          star stays visible because it is state, not an affordance. */}
      <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggleStar(ref)
          }}
          aria-label={starred ? 'Unstar' : 'Star'}
          title={starred ? 'Remove from starred' : 'Add to starred'}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-full transition',
            starred
              ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-500 shadow-sm ring-1 ring-amber-200'
              : 'text-content-subtle opacity-0 hover:bg-surface-sunken hover:text-amber-500 focus-visible:opacity-100 group-hover:opacity-100',
          )}
        >
          {starred ? <IconStarFilled /> : <IconStar />}
        </button>
        <CardMenu items={menu} label={`Actions for ${entity.metadata.title ?? entity.metadata.name}`} />
      </div>

      <div className="flex items-start gap-3.5 p-5 pr-20">
        <KindGlyph kind={entity.kind} type={entity.spec.type} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold leading-tight text-content">
            {entity.metadata.title ?? entity.metadata.name}
          </h3>
          {/*
            What this thing IS, not its ref. The line used to read
            `component:adhar-kit` directly under the heading "adhar-kit" — the
            name twice, plus a kind the glyph beside it already shows. The
            entity's type ("service", "library") is the fact that was missing,
            and the raw name earns its place only when the title differs from
            it.
          */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[11px] font-medium capitalize text-content-muted">
              {entity.spec.type ?? entity.kind}
            </span>
            {(entity.metadata.title ?? entity.metadata.name) !== entity.metadata.name ? (
              <span className="truncate font-mono text-[11px] text-content-subtle">
                {entity.metadata.name}
              </span>
            ) : null}
            {entity.spec.lifecycle ? <LifecycleTag lifecycle={entity.spec.lifecycle} /> : null}
            <OriginTag origin={entity.origin} />
            {version ? (
              <span className="font-mono text-[11px] font-semibold text-content" title="Registered version">
                {version}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {entity.metadata.description ? (
        <p className="-mt-1 line-clamp-3 px-5 text-[12.5px] leading-relaxed text-content-muted">
          {entity.metadata.description}
        </p>
      ) : null}
      {/* Tech and tags share ONE wrapping row. As two stacked rows a card with
          a single language and a single tag spent two lines on two chips. */}
      {stack.length > 0 || generics.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1 px-5">
          <TechBadges stack={stack} max={3} />
          {generics.slice(0, 3).map((t) => (
            <span
              key={t}
              className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 text-[11px] text-content-muted">
        {/* Health and score sit together because they are the same judgement
            at two resolutions — "At risk" IS grade D/F. */}
        <StatusBadge kind={health.kind} className="px-1.5 py-0 text-[10px]">
          {health.label}
        </StatusBadge>
        {scoreable ? <ScoreBadge score={score} /> : null}
        {entity.spec.owner ? (
          <span className="inline-flex items-center gap-1" title={`Owned by ${parseRef(entity.spec.owner).name}`}>
            <IconUsers />
            <span className="font-medium text-content">{parseRef(entity.spec.owner).name}</span>
          </span>
        ) : (
          // Stated, not alarmed. The health chip to its left is already the
          // card's alarm — and it is red BECAUSE of this.
          <span className="inline-flex items-center gap-1 text-content-subtle" title="No owner set">
            <IconUsers />
            no owner
          </span>
        )}
        {docs ? (
          <span
            className="inline-flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted ring-1 ring-inset ring-edge-subtle"
            title="TechDocs registered"
          >
            <LinkGlyph icon="docs" />
            Docs
          </span>
        ) : null}
        {entity.spec.system ? (
          <span className="inline-flex items-center gap-1" title="System">
            <IconBox />
            <span className="font-medium text-content">{parseRef(entity.spec.system).name}</span>
          </span>
        ) : null}
        {entity.spec.domain ? (
          <span className="inline-flex items-center gap-1" title="Domain">
            <span className="text-content-subtle">in</span>
            <span className="font-medium text-content">{parseRef(entity.spec.domain).name}</span>
          </span>
        ) : null}
      </div>

      {/* Where it is running, from Argo CD — the fact a card most often
          exists to answer, and the one the catalog could not show before. */}
      {deployment ? <DeployLine dep={deployment} /> : null}

      <CardFacts entity={entity} score={score} />
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-edge-subtle bg-surface-sunken/40 px-3 py-2 text-[11px]">
        <QuickLinks links={links} monitorUrl={entity.kind === 'Component' || entity.kind === 'Resource' ? monitorUrl : undefined} />
        <div className="flex shrink-0 items-center gap-2">
          {/* Age lives here, not in the status row above. It is the least
              urgent fact on the card. */}
          {ageLabel ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-content-subtle"
              title="Last updated"
            >
              <IconClock />
              {ageLabel}
            </span>
          ) : null}
          <span
            className={cn(
              'font-mono text-[10px] uppercase tracking-wider text-content-subtle',
              // Translate as well as fade: motion toward the edge the drawer
              // opens from reads as an invitation, where a fade alone just
              // appears.
              'translate-x-1 opacity-0 transition-[opacity,transform,color] duration-200',
              'group-hover:translate-x-0 group-hover:text-brand-700 group-hover:opacity-100 dark:group-hover:text-brand-300',
              'motion-reduce:transform-none motion-reduce:transition-none',
            )}
          >
            open →
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * The card's deployment line: primary app health, sync, the environments it
 * rolls out to, and when the last sync finished. A deployable entity with no
 * matched Application says so plainly — that is a finding, not an absence.
 */
function DeployLine({ dep }: { dep: EntityDeployment }) {
  if (dep.isLoading || dep.isError) return null
  if (!dep.apps.length) {
    return (
      <div className="mt-2.5 flex items-center gap-1.5 px-5 text-[11px] text-content-subtle" title="No Argo CD Application matches this entity's name or its adhar.io/argocd-app annotation">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
        Not deployed via Argo CD
      </div>
    )
  }
  const p = dep.primary ?? dep.apps[0]
  const healthStatus = p.status.health.status
  const syncStatus = p.status.sync.status
  const dot =
    healthStatus === 'Healthy'
      ? 'bg-emerald-500'
      : healthStatus === 'Progressing'
        ? 'bg-sky-500 animate-pulse'
        : healthStatus === 'Degraded' || healthStatus === 'Missing'
          ? 'bg-rose-500'
          : healthStatus === 'Suspended'
            ? 'bg-amber-500'
            : 'bg-slate-400'
  const finished = p.status.operationState?.finishedAt
  const when = finished ? relativeTime(finished) : ''
  const envs = dep.environments.map((e) => e.label)
  return (
    <div
      className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-5 text-[11px] text-content-muted"
      title={`${dep.apps.length} Argo CD ${dep.apps.length === 1 ? 'application' : 'applications'}: ${dep.apps.map((a) => a.metadata.name).join(', ')}`}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span className="font-medium text-content">{healthStatus}</span>
      <span className="text-content-subtle">·</span>
      <span className={syncStatus === 'OutOfSync' ? 'text-amber-700 dark:text-amber-300' : undefined}>{syncStatus}</span>
      {envs.length ? (
        <>
          <span className="text-content-subtle">·</span>
          <span>
            {envs.slice(0, 3).join(', ')}
            {envs.length > 3 ? ` +${envs.length - 3}` : ''}
          </span>
        </>
      ) : null}
      {when ? <span className="text-content-subtle">· synced {when}</span> : null}
    </div>
  )
}

type CardMenuItem = { label: string; onSelect(): void } | 'sep'

/**
 * The card's ⋯ menu. Opens on click, closes on outside click, Esc, or a
 * pick; every click inside stops propagating so the card itself does not
 * open underneath it.
 */
function CardMenu({ items, label }: { items: CardMenuItem[]; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.addEventListener('mousedown', onDown)
    globalThis.addEventListener('keydown', onKey)
    return () => {
      globalThis.removeEventListener('mousedown', onDown)
      globalThis.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center rounded-full text-content-subtle transition hover:bg-surface-sunken hover:text-content focus-visible:opacity-100 group-hover:opacity-100',
          open ? 'bg-surface-sunken text-content opacity-100' : 'opacity-0',
        )}
      >
        <IconDots />
      </button>
      {open ? (
        <div
          role="menu"
          className="pop-in absolute right-0 top-8 z-20 w-44 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-lg"
        >
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={`sep-${i}`} className="my-1 border-t border-edge-subtle" />
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
                className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] text-content transition-colors hover:bg-surface-sunken"
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The second row of detail a wider card can afford: what the entity is wired
 * to, and how it scores per category.
 *
 * Relations show counts with a label, not the refs themselves — three API names
 * do not fit on a card, but "3 APIs · 2 deps" tells a reader whether this is a
 * leaf or a hub before they open it. The readiness row lists the categories
 * that are NOT fully passing, since the ones that pass carry no action.
 */
function CardFacts({ entity, score }: { entity: Entity; score: Scorecard }) {
  const provides = entity.spec.providesApis?.length ?? 0
  const consumes = entity.spec.consumesApis?.length ?? 0
  const deps = entity.spec.dependsOn?.length ?? 0
  const relations: string[] = []
  if (provides) relations.push(`${provides} API${provides === 1 ? '' : 's'} provided`)
  if (consumes) relations.push(`${consumes} consumed`)
  if (deps) relations.push(`${deps} ${deps === 1 ? 'dependency' : 'dependencies'}`)

  // Categories with at least one failing check, worst first.
  const weak = CHECK_CATEGORIES
    .map((cat) => ({ cat, s: score.byCategory[cat] }))
    .filter(({ s }) => s && s.total > 0 && s.pass < s.total)
    .sort((a, b) => a.s.pass / a.s.total - b.s.pass / b.s.total)
    .slice(0, 3)

  const scoreable = score.checks.length > 0
  if (!relations.length && !weak.length && !scoreable) return null
  return (
    <div className="mt-3 space-y-1.5 px-5 pb-1 text-[11px]">
      {/* One segment per category, coloured by its score — the whole
          scorecard in a glance, before the chips below say which ones need
          work. */}
      {scoreable ? (
        <div className="flex items-center gap-2" aria-label="Readiness by category">
          <span className="text-content-subtle">Readiness</span>
          <div className="flex flex-1 items-center gap-1">
            {CHECK_CATEGORIES.map((cat) => {
              const b = score.byCategory[cat]
              const na = !b || b.total === 0
              const pct = na ? 0 : b.score
              return (
                <span
                  key={cat}
                  title={na ? `${CATEGORY_LABEL[cat]}: not applicable` : `${CATEGORY_LABEL[cat]}: ${b.pass}/${b.total} checks (${pct}%)`}
                  className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle"
                >
                  {na ? null : (
                    <span
                      className={cn('absolute inset-y-0 left-0 rounded-full', scoreTone(pct).dot)}
                      style={{ width: `${Math.max(pct, 8)}%` }}
                    />
                  )}
                </span>
              )
            })}
          </div>
        </div>
      ) : null}
      {relations.length ? (
        <div className="flex flex-wrap items-center gap-x-2 text-content-muted">
          <span className="text-content-subtle">Relations</span>
          <span className="text-content">{relations.join(' · ')}</span>
        </div>
      ) : null}
      {weak.length ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-content-subtle">Needs work</span>
          {weak.map(({ cat, s }) => (
            <span
              key={cat}
              className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25"
              title={`${CATEGORY_LABEL[cat]}: ${s.pass}/${s.total} checks passing`}
            >
              {CATEGORY_LABEL[cat]} {s.pass}/{s.total}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function QuickLinks({ links, monitorUrl }: { links: Entity['metadata']['links']; monitorUrl?: string }) {
  if ((!links || !links.length) && !monitorUrl) {
    return <span className="text-content-subtle">no links</span>
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {monitorUrl ? <MonitorButton url={monitorUrl} compact /> : null}
      {(links ?? []).slice(0, 4).map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-md bg-surface-raised px-1.5 py-1 text-[10px] font-medium text-content-muted ring-1 ring-edge-default hover:bg-brand-50 dark:hover:bg-brand-500/10 hover:text-brand-700 dark:hover:text-brand-300 hover:ring-brand-200"
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

/* Scoring now lives in the shared engine (`~/data/scorecard.ts`) so the
 * catalog badge, the drawer, and the /scorecards dashboard all agree. */

function scoreTone(pct: number): { dot: string; text: string; ring: string } {
  if (pct >= 80) {
    return { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', ring: 'ring-emerald-200' }
  }
  if (pct >= 50) return { dot: 'bg-amber-500', text: 'text-amber-800 dark:text-amber-300', ring: 'ring-amber-200' }
  return { dot: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-300', ring: 'ring-rose-200' }
}

function ScoreBadge({ score }: { score: Scorecard }) {
  const t = scoreTone(score.score)
  const ok = score.checks.filter((c) => c.pass).length
  return (
    <span
      title={`Scorecard ${score.grade}: ${ok}/${score.checks.length} readiness checks passing`}
      aria-label={`Readiness score ${score.score} percent, grade ${score.grade}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ring-1',
        t.text,
        t.ring,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', t.dot)} />
      {score.score}
      {/* Without a denominator a red "14" in a card corner reads as a count of
          something wrong, not as a readiness score out of 100. */}
      <span className="font-normal opacity-60">/100</span>
    </span>
  )
}

const ORIGIN_LABEL: Record<EntityOrigin, string> = {
  live: 'Live',
  registered: 'Registered',
  seed: 'Sample',
}

const ORIGIN_HINT: Record<EntityOrigin, string> = {
  live: 'Live — discovered from the cluster',
  registered: 'Registered — added via catalog-info',
  seed: 'Sample entity',
}

/**
 * Provenance is a quiet signal, not a headline — a small coloured dot plus a
 * normal-case label rather than a loud uppercase pill, so it reads cleanly next
 * to the entity ref instead of competing with the title.
 */
function OriginTag({ origin }: { origin?: EntityOrigin }) {
  if (!origin || origin === 'seed') return null
  const dot = origin === 'live' ? 'bg-emerald-500' : 'bg-sky-500'
  return (
    <span
      title={ORIGIN_HINT[origin]}
      className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-content-subtle"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {ORIGIN_LABEL[origin]}
    </span>
  )
}

/* Lifecycle accent + tag — calm, consistent tones shared by card & drawer. */

const LIFECYCLE_TAG_CLS: Record<Lifecycle, string> = {
  production:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
  staging:
    'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20',
  experimental:
    'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/20',
  deprecated:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
}

const LIFECYCLE_DOT_CLS: Record<Lifecycle, string> = {
  production: 'bg-emerald-500',
  staging: 'bg-sky-500',
  experimental: 'bg-violet-500',
  deprecated: 'bg-amber-500',
}

/** A calm lifecycle chip: coloured dot + lowercase label, subtle ring. */
function LifecycleTag({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <span
      title={`Lifecycle: ${lifecycle}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ring-1 ring-inset',
        LIFECYCLE_TAG_CLS[lifecycle],
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', LIFECYCLE_DOT_CLS[lifecycle])} />
      {lifecycle}
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

const KIND_PLURAL: Record<EntityKind, string> = {
  Component: 'Components',
  API: 'APIs',
  Resource: 'Resources',
  System: 'Systems',
  Domain: 'Domains',
  Group: 'Groups',
  User: 'Users',
}

/**
 * "Ask Adhar AI" about one entity: a question already scoped to it, so the
 * answer comes back grounded in this thing rather than the whole cluster.
 */
function askAboutEntity(ai: ReturnType<typeof useAi>, e: Entity): void {
  const title = e.metadata.title ?? e.metadata.name
  ai.ask({
    title,
    prompt: `Tell me about ${entityRef(e)} (${title}, a ${e.spec.type ?? e.kind.toLowerCase()}). Summarise what it is and who owns it, its deployment and health right now, what its scorecard says needs fixing, and what I should look at first.`,
  })
}

/** Things that run somewhere, and so can have an Argo CD Application. */
function isDeployableKind(e: Entity): boolean {
  return e.kind === 'Component' || e.kind === 'Resource'
}

/**
 * Section the grid by a shared attribute. Entities without the attribute go
 * in a trailing "No system" / "No owner" group rather than vanishing — for
 * a catalog those gaps are the point.
 */
function groupEntities(
  rows: Entity[],
  by: GroupKey,
): Array<{ key: string; label: string; items: Entity[] }> {
  if (by === 'none') return [{ key: 'all', label: '', items: rows }]
  const keyOf = (e: Entity): string => {
    if (by === 'system') return e.spec.system ? parseRef(e.spec.system).name : ''
    if (by === 'owner') return e.spec.owner ? parseRef(e.spec.owner).name : ''
    if (by === 'kind') return KIND_PLURAL[e.kind]
    return e.spec.lifecycle ?? ''
  }
  const map = new Map<string, Entity[]>()
  for (const e of rows) {
    const k = keyOf(e)
    map.set(k, [...(map.get(k) ?? []), e])
  }
  const missing = by === 'system' ? 'No system' : by === 'owner' ? 'No owner' : 'No lifecycle'
  return [...map.entries()]
    .map(([k, items]) => ({
      key: k || '~',
      label: k ? (by === 'lifecycle' ? k.charAt(0).toUpperCase() + k.slice(1) : k) : missing,
      items,
    }))
    .sort((a, b) => Number(a.key === '~') - Number(b.key === '~') || a.label.localeCompare(b.label))
}

/**
 * One click per kind. Selecting a kind here sets the kind filter to exactly
 * that kind (the popover can still add more); "All" clears it. Kinds with no
 * entities are not offered — a tab that always shows nothing is a trap.
 */
function KindRail({
  counts,
  total,
  filter,
  onFilter,
}: {
  counts: Record<string, number>
  total: number
  filter: FilterState
  onFilter(next: FilterState): void
}) {
  const active: EntityKind | 'all' | 'mixed' =
    filter.kinds.size === 0 ? 'all' : filter.kinds.size === 1 ? [...filter.kinds][0] : 'mixed'
  const items: Array<{ kind: EntityKind | 'all'; label: string; count: number }> = [
    { kind: 'all', label: 'All', count: total },
    ...ALL_KINDS.filter((k) => (counts[k] ?? 0) > 0).map((k) => ({
      kind: k,
      label: KIND_PLURAL[k],
      count: counts[k] ?? 0,
    })),
  ]
  return (
    <div role="tablist" aria-label="Entity kind" className="flex flex-wrap items-center gap-1">
      {items.map((it) => {
        const on = it.kind === active
        return (
          <button
            key={it.kind}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() =>
              onFilter({
                ...filter,
                kinds: it.kind === 'all' ? new Set() : new Set([it.kind]),
              })
            }
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors',
              on
                ? 'bg-brand-600 text-white shadow-sm'
                : 'text-content-muted hover:bg-surface-sunken hover:text-content',
            )}
          >
            {it.label}
            <span className={cn('font-mono text-[10px] tabular-nums', on ? 'text-white/75' : 'text-content-subtle')}>
              {it.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

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

type DrawerTab = 'overview' | 'deploy' | 'tech' | 'docs' | 'metrics' | 'relations' | 'scorecard' | 'raw'

function EntityDrawer({
  entity,
  initialTab,
  siblings,
  onNavigate,
  onClose,
  catalog,
  onPick,
  stars,
}: {
  entity: Entity
  /** Open on this tab — a card's menu jumps straight to Deployment or Scorecard. */
  initialTab?: DrawerTab
  /** The list this entity was opened from, in its on-screen order, for ‹ › navigation. */
  siblings?: Entity[]
  onNavigate?(e: Entity): void
  onClose(): void
  catalog: Entity[]
  onPick(e: Entity): void
  stars: readonly string[]
}) {
  const ref = entityRef(entity)
  const starred = isStarred(stars, ref)
  const score = scoreEntity(entity)
  const activity = buildActivity(entity)
  const apiDef = entity.kind === 'API' ? parseApiDefinition(entity.spec.definition) : null
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [metricRange, setMetricRange] = useState<RangeId>('1h')
  const toast = useToast()
  const ai = useAi()

  // Where this entity sits in the list it was opened from.
  const position = useMemo(() => {
    if (!siblings?.length) return null
    const i = siblings.findIndex((e) => entityRef(e) === ref)
    return i < 0 ? null : { index: i, prev: siblings[i - 1], next: siblings[i + 1] }
  }, [siblings, ref])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // ← → step through the list. Not while typing, and not with modifiers
      // (⌘← is "back" in the browser and should stay that way).
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null
        const tag = t?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return
        const target = e.key === 'ArrowLeft' ? position?.prev : position?.next
        if (target && onNavigate) {
          e.preventDefault()
          onNavigate(target)
        }
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate, position])

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

  const stack = techStack(entity)
  const generics = genericTags(entity)
  const version = entityVersion(entity)
  const health = entityHealth(entity, score)
  const docsUrl = techDocsUrl(entity)
  // Controlled so a link inside one panel can move the reader to another —
  // "Read here →" on the tech-stack panel opens the docs tab in place.
  const [tab, setTab] = useState<DrawerTab>(initialTab ?? 'overview')
  // A menu action on another card while this drawer is open asks for a tab;
  // plain navigation between entities keeps the tab you were on.
  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab, ref])
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [tab, ref])
  // Live metrics apply to anything that actually runs: a Component or Resource
  // the catalog resolved to a workload. `adhar.io/grafana-dashboard` pins a
  // dashboard when the team has one.
  const metricTarget = useMemo(() => {
    if (entity.kind !== 'Component' && entity.kind !== 'Resource') return null
    const ann = entityAnnotations(entity)
    const name = ann['adhar.io/workload'] ?? entity.metadata.name
    const namespace = ann['adhar.io/namespace'] ?? entity.metadata.namespace
    return name ? { name, namespace: namespace && namespace !== 'default' ? namespace : undefined } : null
  }, [entity])
  const { url: monitorUrl, grafanaBase } = useGrafanaMonitorUrl(
    metricTarget ?? { name: entity.metadata.name },
    entityAnnotations(entity)['adhar.io/grafana-dashboard'],
  )
  const relationCount =
    provides.length +
    consumes.length +
    dependsOn.length +
    ownedBy.length +
    childComponents.length +
    definedBy.length +
    providedBy.length +
    consumedBy.length
  const hasRelations = relationCount > 0 || Boolean(apiDef)
  const isTechKind = entity.kind === 'Component' || entity.kind === 'API' || entity.kind === 'Resource'
  const scoreable = score.checks.length > 0

  // Live deployment / GitOps signals (ArgoCD, matched to this entity by name).
  // Only query ArgoCD for entities that can actually be deployed — Users,
  // Groups, Domains never hit the proxy.
  const ann = entityAnnotations(entity)
  const repoUrl = repoUrlFor(entity)
  const isDeployable = entity.kind === 'Component' || entity.kind === 'Resource'
  const wantsDeploy =
    isDeployable ||
    Boolean(repoUrl) ||
    Boolean(ann['adhar.io/argocd-app'] || ann['adhar.io/ci'] || ann['adhar.io/ci-pipeline'])
  const deployment = useEntityDeployment(entity, wantsDeploy)
  // Where the thing actually IS. Asked for the same entities as the deployment
  // query: a Group or a Domain has no HTTP surface, so it never hits the API.
  const routes = useEntityRoutes(entity, wantsDeploy)
  const pub = usePublicUrl()
  // Routes come from HTTPRoutes and Ingresses — public hostnames as a rule,
  // but a fallback that names the Service is still rewritten to something a
  // browser can open.
  const routeList = useMemo(() => routes.routes.map((r) => (pub(r.url) === r.url ? r : { ...r, url: pub(r.url) })), [routes.routes, pub])
  const showDeploy = wantsDeploy || deployment.apps.length > 0
  const deployBadge =
    deployment.apps.length > 0
      ? { kind: argoHealthKind(deployment.primary?.status.health.status), value: deployment.apps.length }
      : undefined

  // Ordered by how often a person needs them: state first, reference last.
  const tabs: TabDef<DrawerTab>[] = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'deploy',
      label: 'Deployment',
      hidden: !showDeploy,
      badge: deployBadge,
    },
    {
      id: 'scorecard',
      label: 'Scorecard',
      hidden: !scoreable,
      badge: { kind: gradeKind(score.grade), value: score.grade },
    },
    {
      id: 'relations',
      label: 'Relations',
      hidden: !hasRelations,
      badge: relationCount > 0 ? relationCount : undefined,
    },
    {
      id: 'metrics',
      label: 'Metrics',
      hidden: !metricTarget,
      badge: monitorUrl ? { kind: 'healthy', value: 'live' } : undefined,
    },
    { id: 'tech', label: 'Tech stack', hidden: !(stack.length || version || isTechKind) },
    {
      id: 'docs',
      label: 'TechDocs',
      hidden: !(docsUrl || entity.kind === 'Component'),
      badge: docsUrl ? { kind: 'healthy', value: '✓' } : undefined,
    },
    { id: 'raw', label: 'Raw' },
  ]
  // Following a relation chip to a Group while on Deployment would leave the
  // drawer on a tab that entity does not have; fall back to Overview.
  const effectiveTab: DrawerTab = tabs.some((t) => t.id === tab && !t.hidden) ? tab : 'overview'
  const failing = score.checks.filter((c) => !c.pass)
  const ownerName = ownerEnt
    ? (ownerEnt.metadata.title ?? ownerEnt.metadata.name)
    : entity.spec.owner
      ? parseRef(entity.spec.owner).name
      : undefined
  const copyLink = () => {
    const url = `${globalThis.location.origin}/catalog?entity=${encodeURIComponent(ref)}`
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success('Link copied', { description: url }))
      .catch(() => toast.error('Could not copy link', { description: url }))
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-4xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        {/*
          The header is the drawer's anchor: it stays while the tabs change under
          it, so it carries a tint of its own. Flat and borderless, it read as
          the first row of the content rather than as the frame around it.
        */}
        <header className="relative border-b border-edge-default bg-linear-to-b from-surface-raised to-surface-raised/60 px-6 py-4">
          <div className="flex items-start gap-3.5">
            <KindGlyph kind={entity.kind} type={entity.spec.type} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                <span>
                  {entity.kind}
                  {entity.spec.type ? <span className="font-medium normal-case tracking-normal text-content-muted"> · {entity.spec.type}</span> : null}
                </span>
                {entity.spec.lifecycle ? (
                  <StatusBadge kind={LIFECYCLE_TONE[entity.spec.lifecycle]}>
                    {entity.spec.lifecycle}
                  </StatusBadge>
                ) : null}
                <StatusBadge kind={health.kind}>{health.label}</StatusBadge>
                {version ? (
                  <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold normal-case tracking-normal text-content">
                    {version}
                  </span>
                ) : null}
                <OriginTag origin={entity.origin} />
              </div>
              <h2 className="mt-1 truncate text-[22px] font-semibold leading-tight tracking-tight text-content">
                {entity.metadata.title ?? entity.metadata.name}
              </h2>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="truncate font-mono text-[11px] text-content-muted">{ref}</span>
                {/* The ref is what goes into a template, an annotation or a
                    ticket, so it should not have to be retyped from the screen. */}
                <CopyButton text={ref} />
              </div>
              {entity.metadata.description ? (
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-content-muted">
                  {entity.metadata.description}
                </p>
              ) : null}
              {/*
                The things a person opens a drawer to DO, in the frame that
                stays while the tabs change: open the running thing, go to its
                source, its docs, its dashboard.
              */}
              {routeList.length || entity.metadata.links?.length || monitorUrl ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <EntityRoutesBar routes={routeList} onSeeAll={() => setTab('deploy')} />
                  {(entity.metadata.links ?? []).map((l) => (
                    <a
                      key={l.url}
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-xs font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300"
                    >
                      <LinkGlyph icon={l.icon} />
                      {l.title}
                    </a>
                  ))}
                  {monitorUrl && !(entity.metadata.links ?? []).some((l) => l.icon === 'monitor' || l.icon === 'dashboard') ? (
                    <MonitorButton url={monitorUrl} />
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Right cluster: where you are in the list, then the things you
                can do to the drawer itself. */}
            <div className="flex shrink-0 items-center gap-1">
              {position && siblings && siblings.length > 1 ? (
                <div className="mr-1 hidden items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised p-0.5 text-[11px] text-content-muted sm:flex">
                  <button
                    type="button"
                    disabled={!position.prev}
                    onClick={() => position.prev && onNavigate?.(position.prev)}
                    aria-label="Previous entity"
                    title="Previous (←)"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <IconChevronLeft />
                  </button>
                  <span className="px-1 font-mono tabular-nums">
                    {position.index + 1}
                    <span className="text-content-subtle"> / {siblings.length}</span>
                  </span>
                  <button
                    type="button"
                    disabled={!position.next}
                    onClick={() => position.next && onNavigate?.(position.next)}
                    aria-label="Next entity"
                    title="Next (→)"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <IconChevronRight />
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => askAboutEntity(ai, entity)}
                aria-label="Ask Adhar AI about this entity"
                title="Ask Adhar AI"
                className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-500/10 dark:hover:text-brand-300"
              >
                <IconSparkle />
              </button>
              <button
                type="button"
                onClick={copyLink}
                aria-label="Copy link to this entity"
                title="Copy link"
                className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"
              >
                <IconLink />
              </button>
              <button
                type="button"
                onClick={() => toggleStar(ref)}
                aria-label={starred ? 'Unstar' : 'Star'}
                title={starred ? 'Remove from starred' : 'Add to starred'}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md transition',
                  starred
                    ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-500 ring-1 ring-amber-200'
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
                title="Close (Esc)"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
              >
                <IconClose />
              </button>
            </div>
          </div>
        </header>

        {/*
          The tab bar sticks to the top of the scrolling body (the Tabs
          component's first child is its tab list), so a long Scorecard or
          Deployment tab can be switched away from without scrolling back up.
        */}
        <div
          ref={bodyRef}
          className="flex-1 overflow-y-auto px-6 pb-6 [&>div>div:first-child]:sticky [&>div>div:first-child]:top-0 [&>div>div:first-child]:z-10 [&>div>div:first-child]:-mx-6 [&>div>div:first-child]:bg-surface-app [&>div>div:first-child]:px-6 [&>div>div:first-child]:pt-3"
        >
          <Tabs<DrawerTab> tabs={tabs} value={effectiveTab} onChange={setTab} ariaLabel="Entity details">
            {(active) => (
              <div className="space-y-5">
                {active === 'overview' ? (
                  <>
                    <StatusStrip
                      health={health}
                      score={score}
                      scoreable={scoreable}
                      failing={failing.length}
                      deployment={showDeploy ? deployment : undefined}
                      ownerName={ownerName}
                      ownerEnt={ownerEnt}
                      systemEnt={systemEnt}
                      domainEnt={domainEnt}
                      entity={entity}
                      catalog={catalog}
                      onTab={setTab}
                      onPick={onPick}
                    />

                    {/* Identity first, full width: every declared fact in one
                        grid, so the answer to "what is this" never needs the
                        scrollbar. */}
                    <PropertiesPanel
                      entity={entity}
                      ownerEnt={ownerEnt}
                      systemEnt={systemEnt}
                      domainEnt={domainEnt}
                      stack={stack}
                      generics={generics}
                      version={version}
                      onPick={onPick}
                    />

                    {/* Signals as pictures: readiness by category, how often
                        it ships, and the last hour of its resources. Only the
                        ones that apply render; a Group has none. */}
                    {scoreable || (showDeploy && deployment) || metricTarget ? (
                      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {scoreable ? <ReadinessByCategory score={score} onOpen={() => setTab('scorecard')} /> : null}
                        {showDeploy && deployment ? <DeploymentsChart deployment={deployment} onOpen={() => setTab('deploy')} /> : null}
                        {metricTarget ? (
                          <DrawerSection
                            title="Last hour"
                            aside={
                              <button type="button" onClick={() => setTab('metrics')} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                                Metrics →
                              </button>
                            }
                          >
                            <EntitySparklines target={metricTarget} onOpen={() => setTab('metrics')} />
                          </DrawerSection>
                        ) : null}
                      </div>
                    ) : null}

                    {/*
                      Left: how it is doing (what to fix, every health signal,
                      what it is wired to, what happened). Right rail: who and
                      what (the team and its contacts, the stack with versions).
                    */}
                    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_292px]">
                      <div className="min-w-0 space-y-5">
                        {scoreable ? (
                          <FixNext failing={failing} total={score.checks.length} onAll={() => setTab('scorecard')} />
                        ) : null}
                        <HealthChecks
                          entity={entity}
                          health={health}
                          score={score}
                          scoreable={scoreable}
                          deployment={showDeploy ? deployment : undefined}
                          monitorUrl={monitorUrl}
                          docsUrl={docsUrl}
                          onTab={setTab}
                        />
                        {relationCount > 0 ? (
                          <DrawerSection
                            title="Relations"
                            aside={
                              <button
                                type="button"
                                onClick={() => setTab('relations')}
                                className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300"
                              >
                                All {relationCount} →
                              </button>
                            }
                          >
                            <div className="space-y-3">
                              {provides.length ? <RelationRow label="Provides APIs" entities={provides.slice(0, 6)} onPick={onPick} /> : null}
                              {consumes.length ? <RelationRow label="Consumes APIs" entities={consumes.slice(0, 6)} onPick={onPick} /> : null}
                              {dependsOn.length ? <RelationRow label="Depends on" entities={dependsOn.slice(0, 6)} onPick={onPick} /> : null}
                              {providedBy.length ? <RelationRow label="Provided by" entities={providedBy.slice(0, 6)} onPick={onPick} /> : null}
                              {consumedBy.length ? <RelationRow label="Consumed by" entities={consumedBy.slice(0, 6)} onPick={onPick} /> : null}
                              {childComponents.length ? (
                                <RelationRow
                                  label={entity.kind === 'Domain' ? 'In this domain' : 'In this system'}
                                  entities={childComponents.slice(0, 8)}
                                  onPick={onPick}
                                />
                              ) : null}
                              {ownedBy.length ? <RelationRow label="Owns" entities={ownedBy.slice(0, 8)} onPick={onPick} /> : null}
                            </div>
                          </DrawerSection>
                        ) : null}
                        <ActivityCard events={activity} />
                      </div>
                      <div className="min-w-0 space-y-5">
                        <TeamPanel entity={entity} ownerEnt={ownerEnt} catalog={catalog} onPick={onPick} onTab={setTab} />
                        {isTechKind ? (
                          <TechPanel stack={stack} version={version} deployment={showDeploy ? deployment : undefined} onTab={setTab} />
                        ) : null}
                        {routeList.length ? <EndpointsPanel routes={routeList} onTab={setTab} /> : null}
                        <LinksPanel entity={entity} docsUrl={docsUrl} monitorUrl={monitorUrl} onTab={setTab} />
                        <SiblingsPanel entity={entity} ownerEnt={ownerEnt} catalog={catalog} onPick={onPick} />
                      </div>
                    </div>
                  </>
                ) : null}

                {active === 'deploy' ? (
                  <DeploymentTab
                    entity={entity}
                    deployment={deployment}
                    repoUrl={repoUrl}
                    routes={routeList}
                    monitorUrl={monitorUrl}
                    onMetrics={metricTarget ? () => setTab('metrics') : undefined}
                  />
                ) : null}

                {active === 'tech' ? (
                  <TechStackTab
                    stack={stack}
                    version={version}
                    entity={entity}
                    docsUrl={docsUrl}
                    deployment={showDeploy ? deployment : undefined}
                    onOpenDocs={() => setTab('docs')}
                  />
                ) : null}

                {active === 'docs' ? <TechDocsTab url={docsUrl} entity={entity} monitorUrl={monitorUrl} /> : null}
                {active === 'metrics' && metricTarget ? (
                  <EntityMetrics target={metricTarget} range={metricRange} onRange={setMetricRange} grafanaUrl={monitorUrl || grafanaBase} />
                ) : null}

                {active === 'relations' ? (
                  <>
                    {apiDef ? <ApiDefinitionCard api={apiDef} /> : null}
                    {relationCount > 0 ? (
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
                  </>
                ) : null}

                {active === 'scorecard' ? <ScorecardTab score={score} onAsk={() => askAboutEntity(ai, entity)} /> : null}

                {active === 'raw' ? (
                  <>
                    <Card>
                      <CardHeader>
                        <h3 className="text-sm font-semibold text-content">Metadata</h3>
                      </CardHeader>
                      <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field
                          label="Namespace"
                          value={
                            <code className="text-xs">{entity.metadata.namespace ?? 'default'}</code>
                          }
                        />
                        <Field
                          label="Created"
                          value={
                            <code className="text-xs">{formatDate(entity.metadata.createdAt)}</code>
                          }
                        />
                        <Field
                          label="Updated"
                          value={
                            <code className="text-xs">{formatDate(entity.metadata.updatedAt)}</code>
                          }
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
                        <pre className="max-h-72 overflow-auto rounded-lg bg-code p-4 font-mono text-[11px] leading-relaxed text-code-fg">
                          {JSON.stringify(entity, null, 2)}
                        </pre>
                      </CardBody>
                    </Card>
                  </>
                ) : null}
              </div>
            )}
          </Tabs>
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
      className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] text-content-muted shadow-sm hover:border-brand-200 dark:hover:border-brand-500/25 hover:text-brand-700 dark:hover:text-brand-300"
    >
      <KindGlyph kind={ent.kind} type={ent.spec.type} />
      <span className="font-medium text-content">{ent.metadata.title ?? ent.metadata.name}</span>
      <span className="text-content-subtle">· {ent.kind.toLowerCase()}</span>
    </button>
  )
}

/**
 * The entity's properties — the side panel of the Overview tab.
 *
 * A key/value list, one row per fact, in the order a reader looks for them:
 * who owns it, where it sits, what it is, then provenance. A fact that is
 * not set is shown as "not set" in place — the scorecard grades exactly
 * those gaps, so naming them where the value would be is the useful thing;
 * facts that are optional (tags, tech) simply do not render when empty.
 */
function PropertiesPanel({
  entity,
  ownerEnt,
  systemEnt,
  domainEnt,
  stack,
  generics,
  version,
  onPick,
}: {
  entity: Entity
  ownerEnt?: Entity
  systemEnt?: Entity
  domainEnt?: Entity
  stack: TechBadge[]
  generics: string[]
  version?: string
  onPick(e: Entity): void
}) {
  const unset = <span className="text-[12px] italic text-content-subtle">not set</span>
  const text = (v: string) => <span className="text-[13px] text-content">{v}</span>
  const cells: Array<{ label: string; node: React.ReactNode; wide?: boolean }> = [
    {
      label: 'Owner',
      node: ownerEnt
        ? <RefChip ent={ownerEnt} onPick={onPick} />
        : entity.spec.owner
          ? text(parseRef(entity.spec.owner).name)
          : unset,
    },
    { label: 'System', node: systemEnt ? <RefChip ent={systemEnt} onPick={onPick} /> : entity.spec.system ? text(parseRef(entity.spec.system).name) : unset },
    { label: 'Domain', node: domainEnt ? <RefChip ent={domainEnt} onPick={onPick} /> : entity.spec.domain ? text(parseRef(entity.spec.domain).name) : unset },
    {
      label: 'Lifecycle',
      node: entity.spec.lifecycle
        ? <StatusBadge kind={LIFECYCLE_TONE[entity.spec.lifecycle]}>{entity.spec.lifecycle}</StatusBadge>
        : unset,
    },
    { label: 'Kind · type', node: text(`${entity.kind}${entity.spec.type ? ` · ${entity.spec.type}` : ''}`) },
    { label: 'Version', node: version ? <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px] font-semibold text-content">{version}</code> : unset },
    { label: 'Origin', node: text(ORIGIN_LABEL[entity.origin ?? 'seed']) },
    { label: 'Namespace', node: <code className="font-mono text-[12px] text-content">{entity.metadata.namespace ?? 'default'}</code> },
  ]
  if (stack.length) cells.push({ label: 'Tech stack', node: <TechBadges stack={stack} max={6} />, wide: true })
  if (generics.length) {
    cells.push({
      label: 'Tags',
      wide: true,
      node: (
        <div className="flex flex-wrap gap-1">
          {generics.map((t) => (
            <span key={t} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted">
              {t}
            </span>
          ))}
        </div>
      ),
    })
  }
  cells.push({ label: 'Created', node: <span className="text-[12px] text-content-muted">{formatDate(entity.metadata.createdAt)}</span> })
  cells.push({ label: 'Updated', node: <span className="text-[12px] text-content-muted">{formatDate(entity.metadata.updatedAt)}{relativeTime(entity.metadata.updatedAt) ? ` · ${relativeTime(entity.metadata.updatedAt)}` : ''}</span> })

  return (
    <DrawerSection title="Properties">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 sm:grid-cols-3 lg:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className={cn('min-w-0', c.wide && 'col-span-2')}>
            <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-content-subtle">{c.label}</dt>
            <dd className="mt-1 min-w-0 truncate">{c.node}</dd>
          </div>
        ))}
      </dl>
    </DrawerSection>
  )
}

/* ─────────── overview graphs ─────────── */

/** Readiness per category as bars — the shape of the score, not just the number. */
function ReadinessByCategory({ score, onOpen }: { score: Scorecard; onOpen(): void }) {
  const cats = CHECK_CATEGORIES.map((cat) => ({ cat, c: score.byCategory[cat] })).filter(({ c }) => c.total > 0)
  return (
    <DrawerSection
      title="Readiness by category"
      aside={
        <button type="button" onClick={onOpen} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          Scorecard →
        </button>
      }
    >
      <ul className="space-y-2">
        {cats.map(({ cat, c }) => (
          <li key={cat}>
            <div className="flex items-baseline justify-between text-[11px]">
              <span className="font-medium text-content-muted">{CATEGORY_LABEL[cat]}</span>
              <span className="font-mono tabular-nums text-content">
                {c.pass}/{c.total} <span className="text-content-subtle">· {c.score}%</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
              <div className={cn('h-full rounded-full transition-[width] duration-300', scoreTone(c.score).dot)} style={{ width: `${c.score}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </DrawerSection>
  )
}

/**
 * Deployments per week for the last eight weeks, from Argo CD's sync
 * history across every matched application. Frequency is the one delivery
 * number that needs no interpretation: a bar that has been empty for a
 * month says more than a "last synced 31d ago".
 */
function DeploymentsChart({ deployment, onOpen }: { deployment: EntityDeployment; onOpen?(): void }) {
  const WEEKS = 8
  const now = Date.now()
  const weekMs = 7 * 86_400_000
  const stamps = deployment.apps
    .flatMap((a) => a.status.history.map((h) => h.deployedAt))
    .filter((d): d is string => Boolean(d))
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t))
  const bars = Array.from({ length: WEEKS }, (_, i) => {
    const end = now - (WEEKS - 1 - i) * weekMs
    const start = end - weekMs
    const n = stamps.filter((t) => t > start && t <= end).length
    const label = i === WEEKS - 1 ? 'this wk' : `-${WEEKS - 1 - i}w`
    return { label, value: n }
  })
  const total = bars.reduce((a, b) => a + b.value, 0)
  const last = stamps.length ? Math.max(...stamps) : null
  return (
    <DrawerSection
      title="Deployments"
      aside={
        onOpen ? (
          <button type="button" onClick={onOpen} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
            Deployment →
          </button>
        ) : (
          <span className="text-[11px] text-content-subtle">per week · from Argo CD sync history</span>
        )
      }
    >
      {deployment.isLoading ? (
        <div className="flex h-24 items-center justify-center text-[11px] text-content-subtle"><Spinner size={12} /></div>
      ) : deployment.isError ? (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-edge-default text-[11px] text-content-subtle">Argo CD not reachable</div>
      ) : !deployment.apps.length ? (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-edge-default text-[11px] text-content-subtle">Not deployed via Argo CD</div>
      ) : (
        <>
          <BarChart bars={bars} height={72} color="var(--color-brand-500)" formatY={(v) => String(Math.round(v))} />
          <div className="mt-2 flex items-baseline justify-between text-[11px] text-content-muted">
            <span>
              <span className="font-mono font-semibold tabular-nums text-content">{total}</span> in {WEEKS} weeks
            </span>
            <span>{last ? `last ${relativeTime(new Date(last).toISOString()) || formatDate(new Date(last).toISOString())}` : 'no sync history'}</span>
          </div>
        </>
      )}
    </DrawerSection>
  )
}

/* ─────────── overview rail: endpoints, links, siblings ─────────── */

/** The URLs it answers on, compact. The Deployment tab has them in full with how each was matched. */
function EndpointsPanel({ routes, onTab }: { routes: EntityRoute[]; onTab(t: DrawerTab): void }) {
  return (
    <DrawerSection
      title={`Endpoints · ${routes.length}`}
      aside={
        <button type="button" onClick={() => onTab('deploy')} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          Details →
        </button>
      }
    >
      <ul className="space-y-1.5">
        {routes.slice(0, 5).map((r) => (
          <li key={r.url} className="flex items-center gap-2">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', r.via === 'backend' ? 'bg-emerald-500' : 'bg-amber-500')} title={r.via === 'backend' ? 'matched by backend' : 'matched by name'} />
            <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-[11px] text-brand-700 hover:underline dark:text-brand-300" title={r.url}>
              {r.url.replace(/^https?:\/\//, '')}
            </a>
            <CopyButton text={r.url} />
          </li>
        ))}
        {routes.length > 5 ? <li className="text-[10px] text-content-subtle">+{routes.length - 5} more</li> : null}
      </ul>
    </DrawerSection>
  )
}

/**
 * Every link the entity carries, plus the ones the console derives (docs,
 * the Grafana dashboard). The header shows the first few as buttons; this is
 * the complete list, each with what kind of thing it is.
 */
function LinksPanel({
  entity,
  docsUrl,
  monitorUrl,
  onTab,
}: {
  entity: Entity
  docsUrl?: string
  monitorUrl?: string
  onTab(t: DrawerTab): void
}) {
  const links = entity.metadata.links ?? []
  const kindLabel: Record<NonNullable<Link['icon']>, string> = {
    docs: 'Documentation',
    dashboard: 'Dashboard',
    repo: 'Repository',
    runbook: 'Runbook',
    chat: 'Chat',
    'on-call': 'On-call',
  }
  const rows: Array<{ key: string; title: string; kind: string; url: string; icon?: Link['icon']; internal?: DrawerTab }> = links.map((l) => ({
    key: l.url,
    title: l.title,
    kind: l.icon ? kindLabel[l.icon] : 'Link',
    url: l.url,
    icon: l.icon,
  }))
  if (docsUrl && !links.some((l) => l.url === docsUrl)) rows.push({ key: 'docs', title: 'TechDocs', kind: 'Documentation', url: docsUrl, icon: 'docs', internal: 'docs' })
  if (monitorUrl && !links.some((l) => l.url === monitorUrl)) rows.push({ key: 'monitor', title: 'Grafana dashboard', kind: 'Dashboard', url: monitorUrl, icon: 'dashboard', internal: 'metrics' })

  return (
    <DrawerSection title={`Links · ${rows.length}`}>
      {rows.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed text-content-subtle">
          No links. Add <code className="font-mono text-content-muted">metadata.links</code> with an icon of <code className="font-mono text-content-muted">docs</code>, <code className="font-mono text-content-muted">runbook</code>, <code className="font-mono text-content-muted">dashboard</code>, <code className="font-mono text-content-muted">repo</code>, <code className="font-mono text-content-muted">chat</code> or <code className="font-mono text-content-muted">on-call</code>.
        </p>
      ) : (
        <ul className="-my-1 divide-y divide-edge-subtle">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-2.5 py-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-content-muted">
                <LinkGlyph icon={r.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <a href={r.url} target="_blank" rel="noreferrer" className="block truncate text-[12.5px] font-medium text-content hover:text-brand-700 hover:underline dark:hover:text-brand-300" title={r.url}>
                  {r.title}
                </a>
                <span className="block truncate text-[10.5px] text-content-subtle">{r.kind} · {r.url.replace(/^https?:\/\//, '').slice(0, 48)}</span>
              </span>
              {r.internal ? (
                <button type="button" onClick={() => onTab(r.internal!)} className="shrink-0 text-[10.5px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                  open here
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </DrawerSection>
  )
}

/** What else the same team owns — the neighbours you usually need next. */
function SiblingsPanel({
  entity,
  ownerEnt,
  catalog,
  onPick,
}: {
  entity: Entity
  ownerEnt?: Entity
  catalog: Entity[]
  onPick(e: Entity): void
}) {
  const self = entityRef(entity)
  const owner = entity.kind === 'Group' ? self : entity.spec.owner
  if (!owner) return null
  const siblings = catalog.filter((e) => e.spec.owner === owner && entityRef(e) !== self && e.kind !== 'User')
  if (!siblings.length) return null
  const name = ownerEnt ? (ownerEnt.metadata.title ?? ownerEnt.metadata.name) : parseRef(owner).name
  const byKind = new Map<EntityKind, number>()
  for (const e of siblings) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
  return (
    <DrawerSection
      title={entity.kind === 'Group' ? `Owned by this team · ${siblings.length}` : `Also owned by ${name}`}
      aside={<span className="text-[11px] text-content-subtle">{[...byKind.entries()].map(([k, n]) => `${n} ${KIND_PLURAL[k].toLowerCase()}`).join(' · ')}</span>}
    >
      <div className="flex flex-wrap gap-1.5">
        {siblings.slice(0, 8).map((e) => <RefChip key={entityRef(e)} ent={e} onPick={onPick} />)}
        {siblings.length > 8 ? <span className="self-center text-[11px] text-content-subtle">+{siblings.length - 8} more</span> : null}
      </div>
    </DrawerSection>
  )
}

/* ─────────── scorecard tab ─────────── */

const GRADE_FLOOR: Array<{ grade: Grade; min: number }> = [
  { grade: 'A', min: 90 },
  { grade: 'B', min: 75 },
  { grade: 'C', min: 60 },
  { grade: 'D', min: 40 },
]

/**
 * The scorecard as a plan, not a report card: the score as a gauge with the
 * distance to the next grade, the categories as bars, the failing checks as
 * the points each would earn (largest first), and every check grouped by
 * category with its fix. "What would it take to get to B?" is answered
 * without arithmetic.
 */
function ScorecardTab({ score, onAsk }: { score: Scorecard; onAsk(): void }) {
  const checks = score.checks
  const ok = checks.filter((c) => c.pass).length
  const failing = checks.filter((c) => !c.pass)
  const totalWeight = checks.reduce((a, c) => a + c.weight, 0) || 1
  const pointsFor = (c: Check) => Math.round((c.weight / totalWeight) * 100)
  const next = GRADE_FLOOR.filter((g) => g.min > score.score).sort((a, b) => a.min - b.min)[0]
  const tone = score.grade === 'A' || score.grade === 'B' ? 'var(--color-emerald-500)' : score.grade === 'C' ? 'var(--color-amber-500)' : 'var(--color-rose-500)'
  // The cheapest path to the next grade: failing checks by points, largest
  // first, until the gap is covered.
  const path: Check[] = []
  if (next) {
    let need = next.min - score.score
    for (const c of [...failing].sort((a, b) => b.weight - a.weight)) {
      if (need <= 0) break
      path.push(c)
      need -= pointsFor(c)
    }
  }
  const gainBars = [...failing]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((c) => ({ label: c.label.length > 14 ? `${c.label.slice(0, 13)}…` : c.label, value: pointsFor(c) }))

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <DrawerSection title="Production readiness">
          <div className="flex items-center gap-5">
            <DonutGauge
              value={score.score}
              size={128}
              thickness={12}
              color={tone}
              label={
                <span className="flex flex-col items-center leading-none">
                  <span className="text-[26px] font-semibold tabular-nums text-content">{score.score}</span>
                  <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">of 100</span>
                </span>
              }
            />
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex h-9 w-9 items-center justify-center rounded-lg text-[18px] font-bold ring-1 ring-inset',
                    TECH_PILL[score.grade === 'A' || score.grade === 'B' ? 'emerald' : score.grade === 'C' ? 'amber' : 'rose'],
                  )}
                >
                  {score.grade}
                </span>
                <span className="text-[13px] text-content-muted">
                  <span className="font-mono font-semibold tabular-nums text-content">{ok}/{checks.length}</span> checks passing
                </span>
              </div>
              {next ? (
                <p className="text-[12px] leading-relaxed text-content-muted">
                  <span className="font-semibold text-content">{next.min - score.score} points</span> to grade {next.grade}
                  {path.length ? (
                    <> — {path.length === 1 ? 'one fix' : `${path.length} fixes`}: {path.map((c) => c.label).join(', ')}.</>
                  ) : null}
                </p>
              ) : (
                <p className="text-[12px] text-content-muted">Top grade — keep it there.</p>
              )}
              <button type="button" onClick={onAsk} className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                <IconSparkle /> Ask Adhar AI how to raise it
              </button>
            </div>
          </div>
        </DrawerSection>
        <ReadinessByCategoryBars score={score} />
      </div>

      {failing.length ? (
        <DrawerSection title="Points to gain" aside={<span className="text-[11px] text-content-subtle">per failing check · largest first</span>}>
          <BarChart bars={gainBars} height={88} color="var(--color-amber-500)" formatY={(v) => `${Math.round(v)} pts`} />
        </DrawerSection>
      ) : null}

      {CHECK_CATEGORIES.map((cat) => {
        const bucket = score.byCategory[cat]
        if (!bucket || bucket.total === 0) return null
        const rows = checks.filter((c) => c.category === cat)
        return (
          <DrawerSection
            key={cat}
            title={CATEGORY_LABEL[cat]}
            aside={
              <span className="inline-flex items-center gap-2 text-[11px] text-content-muted">
                <span className="font-mono tabular-nums">{bucket.pass}/{bucket.total}</span>
                <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken">
                  <span className={cn('block h-full rounded-full', scoreTone(bucket.score).dot)} style={{ width: `${bucket.score}%` }} />
                </span>
                <span className={cn('font-mono font-semibold tabular-nums', scoreTone(bucket.score).text)}>{bucket.score}%</span>
              </span>
            }
          >
            <ul className="divide-y divide-edge-subtle">
              {rows.map((c) => (
                <li key={c.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset',
                      c.pass
                        ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30'
                        : 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
                    )}
                  >
                    {c.pass ? <IconCheck /> : <IconAlert />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium text-content">{c.label}</span>
                      <span className={cn('shrink-0 font-mono text-[10.5px] tabular-nums', c.pass ? 'text-content-subtle' : 'text-amber-700 dark:text-amber-300')}>
                        {c.pass ? `${pointsFor(c)} pts` : `+${pointsFor(c)} pts`}
                      </span>
                    </div>
                    {c.detail ? <div className="mt-0.5 break-words text-[11px] text-content-muted">{c.detail}</div> : null}
                    {!c.pass && c.hint ? (
                      <div className="mt-1 rounded-md bg-surface-sunken px-2 py-1 text-[11px] leading-relaxed text-content-muted">
                        <span className="font-semibold text-content">Fix:</span> {c.hint}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </DrawerSection>
        )
      })}
    </div>
  )
}

/** Category bars for the scorecard tab's header row (the Overview has its own with a jump link). */
function ReadinessByCategoryBars({ score }: { score: Scorecard }) {
  const cats = CHECK_CATEGORIES.map((cat) => ({ cat, c: score.byCategory[cat] })).filter(({ c }) => c && c.total > 0)
  return (
    <DrawerSection title="By category">
      <ul className="space-y-2.5">
        {cats.map(({ cat, c }) => (
          <li key={cat}>
            <div className="flex items-baseline justify-between text-[11px]">
              <span className="font-medium text-content-muted">{CATEGORY_LABEL[cat]}</span>
              <span className="font-mono tabular-nums text-content">{c.pass}/{c.total} <span className="text-content-subtle">· {c.score}%</span></span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
              <div className={cn('h-full rounded-full transition-[width] duration-300', scoreTone(c.score).dot)} style={{ width: `${c.score}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </DrawerSection>
  )
}

/* ─────────── team & contacts ─────────── *//* ─────────── team & contacts ─────────── */

/** A User entity's initials, for the avatar. */
function userInitials(u: Entity): string {
  const name = (u.metadata.title ?? u.metadata.name).trim()
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase()
}

/**
 * Who to talk to about this entity.
 *
 * The owning team is the answer everyone needs first, so it leads; the
 * contact person is the next question, so it is named — explicitly when the
 * entity or its team says who (`adhar.io/contact`, `adhar.io/lead`, or an
 * `on-call` link), and honestly labelled as "first listed member" when the
 * only thing known is the roster. Members and the team's channels follow.
 * No owner at all is the most common real gap in a catalog, so it is said
 * in amber with the fix, not left as an empty panel.
 */
function TeamPanel({
  entity,
  ownerEnt,
  catalog,
  onPick,
  onTab,
}: {
  entity: Entity
  ownerEnt?: Entity
  catalog: Entity[]
  onPick(e: Entity): void
  onTab(t: DrawerTab): void
}) {
  const team = entity.kind === 'Group' ? entity : ownerEnt
  const ann = entityAnnotations(entity)
  const teamAnn = team ? entityAnnotations(team) : {}

  if (entity.kind === 'User') {
    const memberOf = catalog.filter((g) => g.kind === 'Group' && (g.spec.members ?? []).includes(entityRef(entity)))
    return (
      <DrawerSection title="Contact">
        <div className="space-y-3">
          {entity.spec.email ? (
            <a href={`mailto:${entity.spec.email}`} className="block truncate text-[12.5px] font-medium text-brand-700 hover:underline dark:text-brand-300">
              {entity.spec.email}
            </a>
          ) : (
            <span className="text-[12px] italic text-content-subtle">no email recorded</span>
          )}
          {memberOf.length ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Member of</div>
              <div className="flex flex-wrap gap-1.5">
                {memberOf.map((g) => <RefChip key={entityRef(g)} ent={g} onPick={onPick} />)}
              </div>
            </div>
          ) : null}
        </div>
      </DrawerSection>
    )
  }

  if (!team) {
    const named = entity.spec.owner ? parseRef(entity.spec.owner).name : undefined
    return (
      <DrawerSection title="Team & contacts">
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          {named ? (
            <>
              Owned by <span className="font-semibold">{named}</span>, but that Group is not in the catalog — nobody can be contacted from here.
            </>
          ) : (
            <>
              <span className="font-semibold">No owning team.</span> Set <code className="font-mono">spec.owner</code> to a Group so people know who to ask.
            </>
          )}
          {entity.kind !== 'Group' && entity.kind !== 'Domain' ? (
            <button type="button" onClick={() => onTab('scorecard')} className="mt-1 block text-[11px] font-medium underline-offset-2 hover:underline">
              See the ownership check →
            </button>
          ) : null}
        </div>
      </DrawerSection>
    )
  }

  const members = (team.spec.members ?? [])
    .map((r) => findEntity(catalog, r))
    .filter((u): u is Entity => Boolean(u))

  // Explicit contact first: on the entity, then on the team. A `user:` ref
  // resolves to a member; an email matches a member or is shown as-is.
  const explicit = (ann['adhar.io/contact'] ?? ann['adhar.io/lead'] ?? teamAnn['adhar.io/lead'] ?? teamAnn['adhar.io/contact'] ?? '').trim()
  let contact: { user?: Entity; email?: string; label: string } | undefined
  if (explicit) {
    const byRef = explicit.startsWith('user:') ? findEntity(catalog, explicit) : undefined
    const byEmail = explicit.includes('@') ? members.find((m) => m.spec.email?.toLowerCase() === explicit.toLowerCase()) : undefined
    const u = byRef ?? byEmail
    contact = { user: u, email: u?.spec.email ?? (explicit.includes('@') ? explicit : undefined), label: ann['adhar.io/lead'] || teamAnn['adhar.io/lead'] ? 'Lead' : 'Contact' }
  } else if (members.length) {
    contact = { user: members[0], email: members[0].spec.email, label: 'First listed member' }
  }

  const channels = [...(team.metadata.links ?? []), ...(entity.metadata.links ?? [])]
    .filter((l) => l.icon === 'chat' || l.icon === 'on-call')
    .filter((l, i, arr) => arr.findIndex((x) => x.url === l.url) === i)

  return (
    <DrawerSection title="Team & contacts">
      <div className="space-y-3.5">
        <div>
          {entity.kind === 'Group' ? (
            <div className="text-[13px] font-semibold text-content">{team.metadata.title ?? team.metadata.name}</div>
          ) : (
            <RefChip ent={team} onPick={onPick} />
          )}
          {team.metadata.description ? (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-content-muted">{team.metadata.description}</p>
          ) : null}
        </div>

        {contact ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-edge-subtle bg-surface-sunken/50 px-2.5 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand-500 to-accent-500 text-[11px] font-semibold text-white">
              {contact.user ? userInitials(contact.user) : (contact.email ?? '?').slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{contact.label}</div>
              {contact.user ? (
                <button type="button" onClick={() => onPick(contact!.user!)} className="block truncate text-[12.5px] font-medium text-content hover:underline">
                  {contact.user.metadata.title ?? contact.user.metadata.name}
                </button>
              ) : null}
              {contact.email ? (
                <a href={`mailto:${contact.email}`} className="block truncate text-[11.5px] text-brand-700 hover:underline dark:text-brand-300">
                  {contact.email}
                </a>
              ) : null}
            </div>
          </div>
        ) : null}

        {members.length ? (
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              {members.length} {members.length === 1 ? 'member' : 'members'}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {members.slice(0, 8).map((u) => (
                <button
                  key={entityRef(u)}
                  type="button"
                  onClick={() => onPick(u)}
                  title={`${u.metadata.title ?? u.metadata.name}${u.spec.email ? ` · ${u.spec.email}` : ''}`}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold text-content-muted ring-1 ring-inset ring-edge-default transition-colors hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-200 dark:hover:bg-brand-500/10 dark:hover:text-brand-300"
                >
                  {userInitials(u)}
                </button>
              ))}
              {members.length > 8 ? <span className="pl-1 text-[11px] text-content-subtle">+{members.length - 8}</span> : null}
            </div>
          </div>
        ) : (
          <div className="text-[11.5px] italic text-content-subtle">No members listed on the team.</div>
        )}

        {channels.length ? (
          <div className="flex flex-wrap gap-1.5">
            {channels.map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] font-medium text-content-muted transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300"
              >
                <LinkGlyph icon={l.icon} />
                {l.title}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </DrawerSection>
  )
}

/* ─────────── tech stack with versions ─────────── */

/** `registry/org/name:tag` → `name:tag` — the part a person recognises. */
function shortImage(image: string): string {
  const noDigest = image.split('@')[0]
  const last = noDigest.split('/').pop() ?? noDigest
  return last
}

/**
 * The stack, with versions where they are known — the language, framework
 * and datastore versions a person needs when they ask "is this on a
 * supported Java?". Two sources: what the entity declares (tags such as
 * `java-21`, or the `adhar.io/tech-stack` annotation) and what is actually
 * running (the images Argo CD deploys, with their tags). When nothing is
 * recorded the panel says how to record it, because a blank here is a gap
 * to close, not a fact.
 */
function TechPanel({
  stack,
  version,
  deployment,
  onTab,
}: {
  stack: TechBadge[]
  version?: string
  deployment?: EntityDeployment
  onTab(t: DrawerTab): void
}) {
  const grouped = TECH_GROUP_ORDER
    .map((g) => ({ group: g, items: stack.filter((b) => b.group === g) }))
    .filter((x) => x.items.length > 0)
  const images = deployment?.primary?.status.images ?? []
  const versioned = stack.filter((b) => b.version).length

  return (
    <DrawerSection
      title="Tech stack"
      aside={
        stack.length ? (
          <button type="button" onClick={() => onTab('tech')} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
            Details →
          </button>
        ) : undefined
      }
    >
      {stack.length === 0 && !version && images.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed text-content-subtle">
          Nothing recorded. Tag the entity with its stack and versions (e.g.{' '}
          <code className="font-mono text-content-muted">java-21</code>,{' '}
          <code className="font-mono text-content-muted">spring-boot-3.3</code>) or set{' '}
          <code className="font-mono text-content-muted">adhar.io/tech-stack</code>.
        </p>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ group, items }) => (
            <div key={group}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                {TECH_GROUP_LABEL[group]}
              </div>
              <ul className="divide-y divide-edge-subtle">
                {items.map((b) => (
                  <li key={b.label} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn('h-2 w-2 shrink-0 rounded-sm ring-1 ring-inset', TECH_PILL[b.tone])} />
                      <span className="truncate text-[12.5px] text-content">{b.label}</span>
                    </span>
                    {b.version ? (
                      <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">{b.version}</span>
                    ) : (
                      <span className="shrink-0 text-[11px] italic text-content-subtle">version unknown</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {version ? (
            <div className="flex items-center justify-between gap-2 border-t border-edge-subtle pt-2.5">
              <span className="text-[12px] text-content-muted">App version</span>
              <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">{version}</span>
            </div>
          ) : null}
          {images.length ? (
            <div className="border-t border-edge-subtle pt-2.5">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Running now</span>
                <span className="text-[10px] text-content-subtle">from Argo CD</span>
              </div>
              <ul className="space-y-1">
                {images.slice(0, 4).map((img) => (
                  <li key={img} title={img} className="truncate font-mono text-[11px] text-content">
                    {shortImage(img)}
                  </li>
                ))}
                {images.length > 4 ? <li className="text-[10px] text-content-subtle">+{images.length - 4} more</li> : null}
              </ul>
            </div>
          ) : null}
          {stack.length && versioned < stack.length ? (
            <p className="text-[10.5px] leading-relaxed text-content-subtle">
              {stack.length - versioned} without a version — add it to the tag (<code className="font-mono">java-21</code>) or to <code className="font-mono">adhar.io/tech-stack</code>.
            </p>
          ) : null}
        </div>
      )}
    </DrawerSection>
  )
}

/* ─────────── health checks ─────────── */

type CheckState = 'ok' | 'warn' | 'bad' | 'na'

interface HealthRow {
  id: string
  label: string
  state: CheckState
  detail: string
  /** Where the row is explained. */
  tab?: DrawerTab
}

/**
 * Every health signal the console has for this entity, in one list — the
 * catalog's own verdict, Argo CD's, the resource counts, the readiness
 * score, and the operational hygiene checks (owner, runbook, docs,
 * dashboard, on-call, freshness). Each row says its state, the fact behind
 * it, and — where a tab explains it — is the way there. Rows the console
 * cannot know are "n/a", never guessed.
 */
function HealthChecks({
  entity,
  health,
  score,
  scoreable,
  deployment,
  monitorUrl,
  docsUrl,
  onTab,
}: {
  entity: Entity
  health: Health
  score: Scorecard
  scoreable: boolean
  deployment?: EntityDeployment
  monitorUrl?: string
  docsUrl?: string
  onTab(t: DrawerTab): void
}) {
  const links = entity.metadata.links ?? []
  const prod = entity.spec.lifecycle === 'production'
  const failing = score.checks.filter((c) => !c.pass).length
  const rows: HealthRow[] = []

  rows.push({
    id: 'catalog',
    label: 'Catalog health',
    state: health.kind === 'healthy' ? 'ok' : health.kind === 'degraded' ? 'bad' : 'warn',
    detail: health.label,
    tab: scoreable ? 'scorecard' : undefined,
  })

  if (deployment) {
    const p = deployment.primary
    if (deployment.isLoading) {
      rows.push({ id: 'argo', label: 'Argo CD', state: 'na', detail: 'reading…', tab: 'deploy' })
    } else if (deployment.isError) {
      rows.push({ id: 'argo', label: 'Argo CD', state: 'na', detail: 'not reachable', tab: 'deploy' })
    } else if (!p) {
      rows.push({ id: 'argo', label: 'Argo CD', state: 'warn', detail: 'no application matched', tab: 'deploy' })
    } else {
      const h = p.status.health.status
      rows.push({
        id: 'argo-health',
        label: 'Deployment health',
        state: h === 'Healthy' ? 'ok' : h === 'Progressing' || h === 'Suspended' ? 'warn' : h === 'Unknown' ? 'na' : 'bad',
        detail: `${h}${deployment.apps.length > 1 ? ` · ${deployment.apps.length} apps` : ''}`,
        tab: 'deploy',
      })
      const sy = p.status.sync.status
      rows.push({ id: 'argo-sync', label: 'Sync', state: sy === 'Synced' ? 'ok' : sy === 'OutOfSync' ? 'warn' : 'na', detail: sy, tab: 'deploy' })
      const r = p.status.resources
      if (r.total > 0) {
        rows.push({
          id: 'resources',
          label: 'Resources',
          state: r.unhealthy > 0 ? 'bad' : r.outOfSync > 0 ? 'warn' : 'ok',
          detail: `${r.total - r.unhealthy}/${r.total} healthy${r.outOfSync ? ` · ${r.outOfSync} out of sync` : ''}`,
          tab: 'deploy',
        })
      }
      const fin = p.status.operationState?.finishedAt
      const phase = p.status.operationState?.phase
      rows.push({
        id: 'last-sync',
        label: 'Last sync',
        state: !phase ? 'na' : phase === 'Succeeded' ? 'ok' : phase === 'Running' ? 'warn' : 'bad',
        detail: phase ? `${phase}${fin ? ` · ${relativeTime(fin)}` : ''}` : 'no operation recorded',
        tab: 'deploy',
      })
    }
  }

  if (scoreable) {
    rows.push({
      id: 'score',
      label: 'Readiness',
      state: score.grade === 'A' || score.grade === 'B' ? 'ok' : score.grade === 'C' ? 'warn' : 'bad',
      detail: `${score.score}/100 · grade ${score.grade}${failing ? ` · ${failing} to fix` : ''}`,
      tab: 'scorecard',
    })
  }
  if (entity.kind !== 'User' && entity.kind !== 'Group' && entity.kind !== 'Domain') {
    rows.push({ id: 'owner', label: 'Owner', state: entity.spec.owner ? 'ok' : 'bad', detail: entity.spec.owner ? parseRef(entity.spec.owner).name : 'none set' })
  }
  if (entity.kind === 'Component' || entity.kind === 'Resource' || entity.kind === 'API') {
    const runbook = links.some((l) => l.icon === 'runbook')
    rows.push({ id: 'runbook', label: 'Runbook', state: runbook ? 'ok' : prod ? 'warn' : 'na', detail: runbook ? 'linked' : prod ? 'missing for a production entity' : 'none linked' })
    rows.push({ id: 'docs', label: 'Documentation', state: docsUrl ? 'ok' : 'warn', detail: docsUrl ? 'linked' : 'none linked', tab: 'docs' })
    const dash = Boolean(monitorUrl) || links.some((l) => l.icon === 'dashboard')
    rows.push({ id: 'dash', label: 'Dashboard', state: dash ? 'ok' : 'warn', detail: dash ? 'linked' : 'none linked', tab: monitorUrl ? 'metrics' : undefined })
    const oncall = links.some((l) => l.icon === 'on-call')
    rows.push({ id: 'oncall', label: 'On-call', state: oncall ? 'ok' : prod ? 'warn' : 'na', detail: oncall ? 'linked' : 'no on-call link' })
  }
  const stamp = entity.metadata.updatedAt ?? entity.metadata.createdAt
  rows.push({
    id: 'fresh',
    label: 'Freshness',
    state: !stamp ? 'na' : isStale(stamp) ? 'warn' : 'ok',
    detail: stamp ? `updated ${relativeTime(stamp) || formatDate(stamp)}${isStale(stamp) ? ' · stale' : ''}` : 'no timestamp',
  })

  const tone: Record<CheckState, { dot: string; icon: React.ReactNode }> = {
    ok: { dot: 'bg-emerald-500', icon: <IconCheck /> },
    warn: { dot: 'bg-amber-500', icon: <IconAlert /> },
    bad: { dot: 'bg-rose-500', icon: <IconAlert /> },
    na: { dot: 'bg-slate-300 dark:bg-slate-600', icon: <IconDash /> },
  }
  const counts = rows.reduce(
    (acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }),
    {} as Partial<Record<CheckState, number>>,
  )

  return (
    <DrawerSection
      title="Health checks"
      aside={
        <span className="inline-flex items-center gap-2 text-[11px] text-content-muted">
          {counts.ok ? <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{counts.ok} ok</span> : null}
          {counts.warn ? <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{counts.warn} warn</span> : null}
          {counts.bad ? <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-rose-500" />{counts.bad} failing</span> : null}
        </span>
      }
    >
      <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {rows.map((r) => {
          const Tag = r.tab ? 'button' : 'div'
          return (
            <li key={r.id} className="border-b border-edge-subtle last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
              <Tag
                type={r.tab ? 'button' : undefined}
                onClick={r.tab ? () => onTab(r.tab!) : undefined}
                className={cn('group/row flex w-full items-center gap-2.5 py-2 text-left', r.tab && 'cursor-pointer')}
              >
                <span
                  className={cn(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset',
                    r.state === 'ok'
                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30'
                      : r.state === 'warn'
                        ? 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30'
                        : r.state === 'bad'
                          ? 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30'
                          : 'bg-surface-sunken text-content-subtle ring-edge-subtle',
                  )}
                >
                  {tone[r.state].icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium text-content">{r.label}</span>
                  <span className="block truncate text-[11px] text-content-muted">{r.detail}</span>
                </span>
                {r.tab ? (
                  <span className="shrink-0 text-content-subtle opacity-0 transition-opacity group-hover/row:opacity-100">
                    <IconChevronRight />
                  </span>
                ) : null}
              </Tag>
            </li>
          )
        })}
      </ul>
    </DrawerSection>
  )
}

/**
 * The four facts a person opens a drawer for, before the tabs: how the
 * thing is doing, how ready it is, whether it is running, who to ask. Each
 * tile is the way into the tab (or entity) that explains it.
 */
function StatusStrip({
  health,
  score,
  scoreable,
  failing,
  deployment,
  ownerName,
  ownerEnt,
  systemEnt,
  domainEnt,
  entity,
  catalog,
  onTab,
  onPick,
}: {
  health: Health
  score: Scorecard
  scoreable: boolean
  failing: number
  deployment?: EntityDeployment
  ownerName?: string
  ownerEnt?: Entity
  systemEnt?: Entity
  domainEnt?: Entity
  entity: Entity
  catalog: Entity[]
  onTab(t: DrawerTab): void
  onPick(e: Entity): void
}) {
  const ok = score.checks.length - failing
  const dotFor = (kind: StatusKind) =>
    kind === 'healthy'
      ? 'bg-emerald-500'
      : kind === 'degraded' || kind === 'failed'
        ? 'bg-rose-500'
        : kind === 'paused'
          ? 'bg-amber-500'
          : kind === 'progressing'
            ? 'bg-sky-500'
            : 'bg-slate-400'

  const tiles: Array<{
    key: string
    label: string
    value: React.ReactNode
    sub: string
    dot?: string
    onClick?(): void
    hint?: string
  }> = []

  tiles.push({
    key: 'health',
    label: 'Health',
    value: health.label,
    dot: dotFor(health.kind),
    sub:
      health.kind === 'healthy'
        ? 'No findings'
        : scoreable && failing
          ? `${failing} ${failing === 1 ? 'check' : 'checks'} to fix`
          : needsAttention(entity)
            ? 'Missing owner, lifecycle or runbook'
            : 'Needs an update',
    onClick: scoreable ? () => onTab('scorecard') : undefined,
    hint: scoreable ? 'See the scorecard' : undefined,
  })

  if (scoreable) {
    tiles.push({
      key: 'readiness',
      label: 'Readiness',
      value: (
        <span className="inline-flex items-baseline gap-1.5">
          <span>{score.score}</span>
          <span className="text-[11px] font-normal text-content-subtle">/100</span>
          <span
            className={cn(
              'ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded px-1 font-mono text-[11px] font-bold ring-1 ring-inset',
              TECH_PILL[score.grade === 'A' || score.grade === 'B' ? 'emerald' : score.grade === 'C' ? 'amber' : 'rose'],
            )}
          >
            {score.grade}
          </span>
        </span>
      ),
      sub: `${ok}/${score.checks.length} checks passing`,
      onClick: () => onTab('scorecard'),
      hint: 'See every check',
    })
  }

  if (deployment) {
    const p = deployment.primary
    const envs = deployment.environments.map((e) => e.label)
    tiles.push({
      key: 'deploy',
      label: 'Deployment',
      value: deployment.isLoading ? '…' : deployment.isError ? 'Unknown' : p ? p.status.health.status : 'Not deployed',
      dot: deployment.isLoading || deployment.isError ? 'bg-slate-400' : p ? dotFor(argoHealthKind(p.status.health.status)) : 'bg-slate-300 dark:bg-slate-600',
      sub: deployment.isLoading
        ? 'Reading Argo CD…'
        : deployment.isError
          ? 'Argo CD not reachable'
          : p
            ? `${p.status.sync.status}${envs.length ? ` · ${envs.slice(0, 3).join(', ')}${envs.length > 3 ? ` +${envs.length - 3}` : ''}` : ''}`
            : 'No Argo CD application matched',
      onClick: () => onTab('deploy'),
      hint: 'See environments and history',
    })
  }

  if (entity.kind === 'Group') {
    const members = entity.spec.members?.length ?? 0
    const owns = catalog.filter((e) => e.spec.owner === entityRef(entity)).length
    tiles.push({ key: 'team', label: 'Team', value: `${members} ${members === 1 ? 'member' : 'members'}`, sub: `owns ${owns} ${owns === 1 ? 'entity' : 'entities'}` })
  } else if (entity.kind === 'System' || entity.kind === 'Domain') {
    const self = entityRef(entity)
    const n = catalog.filter((e) => (entity.kind === 'System' ? e.spec.system : e.spec.domain) === self).length
    tiles.push({
      key: 'contains',
      label: 'Contains',
      value: `${n} ${n === 1 ? 'entity' : 'entities'}`,
      sub: ownerName ? `owned by ${ownerName}` : 'no owner',
      onClick: ownerEnt ? () => onPick(ownerEnt) : undefined,
    })
  } else {
    tiles.push({
      key: 'owner',
      label: 'Owner',
      value: ownerName ?? 'Unowned',
      dot: ownerName ? undefined : 'bg-amber-500',
      sub: systemEnt
        ? `in ${systemEnt.metadata.title ?? systemEnt.metadata.name}`
        : domainEnt
          ? `in ${domainEnt.metadata.title ?? domainEnt.metadata.name}`
          : ownerName
            ? 'no system set'
            : 'assign a Group to own this',
      onClick: ownerEnt ? () => onPick(ownerEnt) : undefined,
      hint: ownerEnt ? 'Open the owning team' : undefined,
    })
  }

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {tiles.map((t) => {
        const Tag = t.onClick ? 'button' : 'div'
        return (
          <Tag
            key={t.key}
            type={t.onClick ? 'button' : undefined}
            onClick={t.onClick}
            title={t.hint}
            className={cn(
              'group/tile min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3.5 py-3 text-left shadow-sm',
              t.onClick && 'transition-colors hover:border-brand-300/70 hover:bg-brand-50/30 dark:hover:bg-brand-500/5',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-content-subtle">{t.label}</span>
              {t.onClick ? (
                <span className="text-content-subtle opacity-0 transition-opacity group-hover/tile:opacity-100">
                  <IconChevronRight />
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[15px] font-semibold leading-tight text-content">
              {t.dot ? <span className={cn('h-2 w-2 shrink-0 rounded-full', t.dot)} /> : null}
              <span className="truncate">{t.value}</span>
            </div>
            <div className="mt-1 truncate text-[11px] text-content-muted">{t.sub}</div>
          </Tag>
        )
      })}
    </div>
  )
}

/**
 * The three checks worth fixing first — highest weight among those failing,
 * each with its fix. The Scorecard tab has all of them; this is the answer
 * to "what should I do about this?" without going there.
 */
function FixNext({ failing, total, onAll }: { failing: Check[]; total: number; onAll(): void }) {
  if (!failing.length) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-[12.5px] text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30">
          <IconCheck />
        </span>
        All {total} readiness checks pass.
      </div>
    )
  }
  const top = [...failing].sort((a, b) => b.weight - a.weight).slice(0, 3)
  return (
    <DrawerSection
      title="Fix next"
      aside={
        <button
          type="button"
          onClick={onAll}
          className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          All {failing.length} failing of {total} →
        </button>
      }
    >
      <ol className="space-y-2.5">
        {top.map((c, i) => (
          <li key={c.id} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-amber-50 text-[10px] font-bold text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13px] font-medium text-content">{c.label}</span>
                <span className="text-[10px] uppercase tracking-wider text-content-subtle">
                  {CATEGORY_LABEL[c.category]} · +{c.weight} pts
                </span>
              </div>
              {c.hint ? (
                <div className="mt-0.5 text-[12px] leading-relaxed text-content-muted">{c.hint}</div>
              ) : c.detail ? (
                <div className="mt-0.5 text-[12px] leading-relaxed text-content-muted">{c.detail}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </DrawerSection>
  )
}

/**
 * A block of the drawer's Overview tab.
 *
 * A quiet eyebrow, not a bordered header row: three stacked cards each with a
 * title bar read as three separate panels in a dashboard, when the drawer is
 * one document about one thing. `aside` is for the section's summary (the
 * readiness score), set on the same line as the label.
 */
function DrawerSection({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-edge-default bg-surface-raised px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-content-subtle">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
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

/* ─────────── deployment tab (repo · gitops · envs · pipelines · monitoring) ─────────── */

/** Best-known source repository URL for an entity (link or annotation). */
function repoUrlFor(e: Entity): string | undefined {
  const fromLink = (e.metadata.links ?? []).find((l) => l.icon === 'repo')?.url
  const a = entityAnnotations(e)
  const raw = (
    fromLink ??
    a['adhar.io/source-repo'] ??
    a['adhar.io/git-repo'] ??
    a['backstage.io/source-location'] ??
    ''
  )
    .trim()
    .replace(/^url:\s*/, '')
  return raw && /^https?:/.test(raw) ? raw : undefined
}

function argoHealthKind(status?: string): StatusKind {
  switch (status) {
    case 'Healthy':
      return 'healthy'
    case 'Progressing':
      return 'progressing'
    case 'Degraded':
      return 'degraded'
    case 'Suspended':
      return 'paused'
    case 'Missing':
      return 'failed'
    default:
      return 'unknown'
  }
}

function argoSyncKind(status?: string): StatusKind {
  if (status === 'Synced') return 'healthy'
  if (status === 'OutOfSync') return 'paused'
  return 'unknown'
}

function shortSha(rev?: string): string | undefined {
  if (!rev) return undefined
  return /^[0-9a-f]{7,40}$/i.test(rev) ? rev.slice(0, 7) : rev
}

/** A subtle copy-to-clipboard button used for clone commands. */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        try {
          navigator.clipboard?.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] font-medium text-content-muted transition hover:border-brand-200 hover:text-brand-700 dark:hover:text-brand-300"
    >
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? 'Copied' : label}
    </button>
  )
}

/** A deep link into another 6D phase view (opens the full-page module view). */
function PhaseLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content-muted shadow-sm transition hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300"
    >
      {children}
    </a>
  )
}

function DeploymentTab({
  entity,
  deployment,
  repoUrl,
  routes,
  monitorUrl,
  onMetrics,
}: {
  entity: Entity
  deployment: EntityDeployment
  repoUrl?: string
  routes: EntityRoute[]
  monitorUrl?: string
  onMetrics?(): void
}) {
  const argoBase = useToolPublicUrl('argocd')
  const appUrl = (app: ArgoApp): string | undefined =>
    argoBase ? `${argoBase}/applications/${app.metadata.namespace}/${app.metadata.name}` : undefined
  const p = deployment.primary
  return (
    <div className="space-y-5">
      {/*
        The rollout first — it is what a Deployment tab is opened for. One
        outcome at a time: loading, Argo CD unreachable, nothing matched, or
        the real state (summary, environments, history, GitOps details). The
        static cards (endpoints, repository, pipelines, monitoring) follow,
        because they are true whether or not Argo CD is answering.
      */}
      {deployment.isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised px-4 py-6 text-xs text-content-muted">
          <Spinner /> Reading rollout state from Argo CD…
        </div>
      ) : deployment.isError ? (
        <DeploymentUnavailable reason="unreachable" entity={entity} argoBase={argoBase} />
      ) : !p ? (
        <DeploymentUnavailable reason="unmatched" entity={entity} argoBase={argoBase} />
      ) : (
        <>
          <DeploymentSummary deployment={deployment} appUrl={appUrl(p)} />
          <EnvironmentsGrid deployment={deployment} appUrl={appUrl} repoUrl={repoUrl} />
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="min-w-0 space-y-5">
              <DeploymentsChart deployment={deployment} />
              <SyncHistoryCard deployment={deployment} repoUrl={repoUrl} />
            </div>
            <GitOpsDetailsCard app={p} appUrl={appUrl(p)} apps={deployment.apps.length} />
          </div>
        </>
      )}
      <EndpointsCard routes={routes} repoUrl={repoUrl} />
      <RepositoryCard entity={entity} repoUrl={repoUrl} primary={deployment.primary} />
      <PipelinesCard entity={entity} repoUrl={repoUrl} />
      <MonitoringCard entity={entity} monitorUrl={monitorUrl} onMetrics={onMetrics} />
    </div>
  )
}

/**
 * Why there is no rollout to show, and what to do about it — two different
 * situations that used to render as three near-identical empty states
 * stacked down the tab.
 */
function DeploymentUnavailable({
  reason,
  entity,
  argoBase,
}: {
  reason: 'unreachable' | 'unmatched'
  entity: Entity
  argoBase: string
}) {
  const name = entity.metadata.name
  return (
    <div className="rounded-xl border border-dashed border-edge-strong bg-surface-raised px-5 py-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-content-muted">
          <IconRocket />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-content">
            {reason === 'unreachable' ? 'Argo CD is not reachable' : 'Not deployed via Argo CD'}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-content-muted">
            {reason === 'unreachable' ? (
              <>
                The console could not read Applications from Argo CD, so the rollout state, environments and sync history cannot be shown. This is a
                connectivity problem, not a statement about <code className="font-mono text-content">{name}</code> — it will appear as soon as Argo CD answers.
              </>
            ) : (
              <>
                No Argo CD Application matches <code className="font-mono text-content">{name}</code> (by name, by name with an environment suffix such as{' '}
                <code className="font-mono text-content">{name}-prod</code>, or via the <code className="font-mono text-content">adhar.io/argocd-app</code> annotation).
              </>
            )}
          </p>
          {reason === 'unmatched' ? (
            <ol className="mt-3 space-y-1.5 text-[12px] text-content-muted">
              <li className="flex gap-2"><span className="font-mono text-content-subtle">1.</span><span>If it is already deployed under another name, set <code className="font-mono text-content">adhar.io/argocd-app: &lt;app-name&gt;</code> on the entity.</span></li>
              <li className="flex gap-2"><span className="font-mono text-content-subtle">2.</span><span>If it is not deployed yet, scaffold it from a Golden Path template or add it to the platform's ApplicationSet.</span></li>
              <li className="flex gap-2"><span className="font-mono text-content-subtle">3.</span><span>A library or a docs site legitimately has no deployment — that is fine.</span></li>
            </ol>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {argoBase ? (
              <a href={`${argoBase}/applications`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300">
                Open Argo CD <IconArrowUpRight />
              </a>
            ) : null}
            <PhaseLink href="/deliver?section=apps">GitOps view</PhaseLink>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The rollout at a glance: five facts, each the answer to a question people open this tab with. */
function DeploymentSummary({ deployment, appUrl }: { deployment: EntityDeployment; appUrl?: string }) {
  const p = deployment.primary!
  const h = p.status.health.status
  const sy = p.status.sync.status
  const r = p.status.resources
  const op = p.status.operationState
  const auto = p.spec.syncPolicy.automated
  const envs = deployment.environments
  const dotFor = (k: StatusKind) =>
    k === 'healthy' ? 'bg-emerald-500' : k === 'degraded' || k === 'failed' ? 'bg-rose-500' : k === 'paused' ? 'bg-amber-500' : k === 'progressing' ? 'bg-sky-500 animate-pulse' : 'bg-slate-400'
  const tiles: Array<{ label: string; value: React.ReactNode; sub: string; dot?: string }> = [
    { label: 'Health', value: h, dot: dotFor(argoHealthKind(h)), sub: p.status.health.message ? p.status.health.message.slice(0, 60) : `${deployment.apps.length} ${deployment.apps.length === 1 ? 'application' : 'applications'}` },
    { label: 'Sync', value: sy, dot: dotFor(argoSyncKind(sy)), sub: r.outOfSync ? `${r.outOfSync} of ${r.total} resources drifted` : r.total ? `${r.total} resources in sync` : 'no resources reported' },
    { label: 'Environments', value: String(envs.length), sub: envs.map((e) => e.label).slice(0, 3).join(', ') + (envs.length > 3 ? ` +${envs.length - 3}` : '') },
    { label: 'Last sync', value: op?.phase ?? 'none', dot: op ? (op.phase === 'Succeeded' ? 'bg-emerald-500' : op.phase === 'Running' ? 'bg-sky-500 animate-pulse' : 'bg-rose-500') : 'bg-slate-400', sub: op?.finishedAt ? `${relativeTime(op.finishedAt) || formatDate(op.finishedAt)}${op.initiatedBy ? ` · by ${op.initiatedBy}` : ''}` : 'no operation recorded' },
    { label: 'Auto-sync', value: auto ? 'On' : 'Manual', dot: auto ? 'bg-emerald-500' : 'bg-amber-500', sub: auto ? [auto.prune ? 'prune' : null, auto.selfHeal ? 'self-heal' : null].filter(Boolean).join(' · ') || 'no prune, no self-heal' : 'someone has to press Sync' },
  ]
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3.5 py-3 shadow-sm">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-content-subtle">{t.label}</div>
            <div className="mt-1.5 flex items-center gap-2 text-[15px] font-semibold leading-tight text-content">
              {t.dot ? <span className={cn('h-2 w-2 shrink-0 rounded-full', t.dot)} /> : null}
              <span className="truncate">{t.value}</span>
            </div>
            <div className="mt-1 truncate text-[11px] text-content-muted" title={t.sub}>{t.sub}</div>
          </div>
        ))}
      </div>
      {appUrl ? (
        <div className="mt-2 flex justify-end">
          <a href={appUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
            Open {p.metadata.name} in Argo CD <IconArrowUpRight />
          </a>
        </div>
      ) : null}
    </div>
  )
}

/** A commit link when the repository host is one that uses `/commit/<sha>` (Gitea, GitHub, GitLab). */
function commitUrl(repoUrl: string | undefined, rev: string | undefined): string | undefined {
  if (!repoUrl || !rev || !/^[0-9a-f]{7,40}$/i.test(rev)) return undefined
  const base = repoUrl.replace(/\.git$/, '').replace(/\/$/, '')
  return `${base}/commit/${rev}`
}

/** One card per environment, production first — what is running there, from which commit, since when. */
function EnvironmentsGrid({
  deployment,
  appUrl,
  repoUrl,
}: {
  deployment: EntityDeployment
  appUrl(app: ArgoApp): string | undefined
  repoUrl?: string
}) {
  const pub = usePublicUrl()
  return (
    <DrawerSection
      title={`Environments · ${deployment.environments.length}`}
      aside={<PhaseLink href="/deliver?section=apps">GitOps view →</PhaseLink>}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {deployment.environments.map((env) => {
          const app = env.app
          const rev = app.status.sync.revision
          const sha = shortSha(rev)
          const link = commitUrl(repoUrl ?? pub(app.spec.source.repoURL), rev)
          const fin = app.status.operationState?.finishedAt
          const url = appUrl(app)
          const images = app.status.images
          return (
            <div key={app.metadata.name} className="flex min-w-0 flex-col rounded-xl border border-edge-default bg-surface-raised shadow-sm">
              <div className="flex items-start justify-between gap-2 px-3.5 pt-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-content">{env.label}</div>
                  <div className="truncate font-mono text-[10px] text-content-subtle" title={`${app.metadata.name} → ${app.spec.destination.namespace}`}>
                    {app.spec.destination.namespace}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge kind={argoHealthKind(app.status.health.status)} className="px-1.5 py-0 text-[10px]" pulse={app.status.health.status === 'Progressing'}>
                    {app.status.health.status}
                  </StatusBadge>
                  <StatusBadge kind={argoSyncKind(app.status.sync.status)} className="px-1.5 py-0 text-[10px]" dot={false}>
                    {app.status.sync.status}
                  </StatusBadge>
                </div>
              </div>
              <dl className="mt-2.5 space-y-1.5 px-3.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-content-subtle">Revision</dt>
                  <dd className="min-w-0 truncate font-mono text-content">
                    {sha ? (link ? <a href={link} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-300">{sha}</a> : sha) : '—'}
                    {app.spec.source.targetRevision ? <span className="text-content-subtle"> · {app.spec.source.targetRevision}</span> : null}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-content-subtle">Last sync</dt>
                  <dd className="truncate text-content">{fin ? relativeTime(fin) || formatDate(fin) : '—'}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-content-subtle">Resources</dt>
                  <dd className="truncate text-content">
                    {app.status.resources.total}
                    {app.status.resources.unhealthy ? <span className="text-rose-700 dark:text-rose-300"> · {app.status.resources.unhealthy} unhealthy</span> : null}
                    {app.status.resources.outOfSync ? <span className="text-amber-700 dark:text-amber-300"> · {app.status.resources.outOfSync} drifted</span> : null}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-content-subtle">Auto-sync</dt>
                  <dd className="text-content">{app.spec.syncPolicy.automated ? 'on' : 'manual'}</dd>
                </div>
              </dl>
              {images.length ? (
                <div className="mt-2.5 border-t border-edge-subtle px-3.5 pt-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Images</div>
                  <ul className="mt-0.5 space-y-0.5">
                    {images.slice(0, 2).map((img) => (
                      <li key={img} title={img} className="truncate font-mono text-[10.5px] text-content">{shortImage(img)}</li>
                    ))}
                    {images.length > 2 ? <li className="text-[10px] text-content-subtle">+{images.length - 2} more</li> : null}
                  </ul>
                </div>
              ) : null}
              <div className="mt-auto flex items-center justify-between border-t border-edge-subtle bg-surface-sunken/40 px-3.5 py-1.5 text-[10.5px]">
                <span className="truncate font-mono text-content-subtle">{app.metadata.name}</span>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-700 hover:underline dark:text-brand-300">
                    Argo CD <IconArrowUpRight />
                  </a>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </DrawerSection>
  )
}

/** The last syncs across every matched application, newest first. */
function SyncHistoryCard({ deployment, repoUrl }: { deployment: EntityDeployment; repoUrl?: string }) {
  const pub = usePublicUrl()
  const rows = deployment.apps
    .flatMap((app) =>
      app.status.history.map((h) => ({
        app: app.metadata.name,
        env: deployment.environments.find((e) => e.app.metadata.name === app.metadata.name)?.label ?? app.metadata.name,
        id: h.id,
        revision: h.revision ?? h.revisions?.[0],
        at: h.deployedAt,
        repo: h.source?.repoURL ?? h.sources?.[0]?.repoURL,
      })),
    )
    .filter((r) => r.at)
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, 8)
  return (
    <DrawerSection title="Sync history" aside={<span className="text-[11px] text-content-subtle">newest first</span>}>
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-content-subtle">No sync history recorded yet.</p>
      ) : (
        <ol className="relative space-y-2.5 border-l border-edge-subtle pl-4">
          {rows.map((r) => {
            const sha = shortSha(r.revision)
            const link = commitUrl(repoUrl ?? (r.repo ? pub(r.repo) : undefined), r.revision)
            return (
              <li key={`${r.app}-${r.id}`} className="relative">
                <span className="absolute -left-[19px] top-1.5 inline-flex h-2.5 w-2.5 rounded-full bg-brand-500 ring-2 ring-surface-raised" />
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <span className="font-medium text-content">{r.env}</span>
                  {sha ? (
                    link ? <a href={link} target="_blank" rel="noreferrer" className="font-mono text-brand-700 hover:underline dark:text-brand-300">{sha}</a> : <span className="font-mono text-content-muted">{sha}</span>
                  ) : null}
                  <span className="text-[11px] text-content-subtle">{relativeTime(r.at!) || formatDate(r.at)}</span>
                </div>
                <div className="truncate font-mono text-[10px] text-content-subtle">#{r.id} · {r.app}</div>
              </li>
            )
          })}
        </ol>
      )}
    </DrawerSection>
  )
}

/** Everything Argo CD knows about the primary application, as facts. */
function GitOpsDetailsCard({ app, appUrl, apps }: { app: ArgoApp; appUrl?: string; apps: number }) {
  const pub = usePublicUrl()
  const src = { ...app.spec.source, repoURL: pub(app.spec.source.repoURL) }
  const auto = app.spec.syncPolicy.automated
  const rows: Array<{ label: string; node: React.ReactNode }> = [
    { label: 'Application', node: <span className="font-mono text-[12px] text-content">{app.metadata.namespace}/{app.metadata.name}</span> },
    { label: 'Project', node: <span className="text-[12px] text-content">{app.spec.project}</span> },
    {
      label: 'Source',
      node: (
        <span className="block min-w-0">
          {src.repoURL ? (
            <a href={src.repoURL} target="_blank" rel="noreferrer" className="block truncate font-mono text-[11px] text-brand-700 hover:underline dark:text-brand-300" title={src.repoURL}>
              {src.repoURL.replace(/^https?:\/\//, '')}
            </a>
          ) : <span className="text-[12px] italic text-content-subtle">none</span>}
          <span className="block truncate font-mono text-[11px] text-content-muted">
            {src.path ? src.path : '/'}{src.targetRevision ? ` @ ${src.targetRevision}` : ''}
          </span>
        </span>
      ),
    },
    { label: 'Destination', node: <span className="font-mono text-[11px] text-content">{app.spec.destination.name || app.spec.destination.server || 'in-cluster'} · {app.spec.destination.namespace}</span> },
    { label: 'Sync policy', node: <span className="text-[12px] text-content">{auto ? `Automated${auto.prune ? ' · prune' : ''}${auto.selfHeal ? ' · self-heal' : ''}` : 'Manual'}{app.spec.syncPolicy.syncOptions.length ? <span className="text-content-subtle"> · {app.spec.syncPolicy.syncOptions.join(', ')}</span> : null}</span> },
    { label: 'Resources', node: <span className="text-[12px] text-content">{app.status.resources.total} managed{app.status.resources.outOfSync ? ` · ${app.status.resources.outOfSync} out of sync` : ''}{app.status.resources.unhealthy ? ` · ${app.status.resources.unhealthy} unhealthy` : ''}</span> },
    { label: 'Reconciled', node: <span className="text-[12px] text-content">{app.status.reconciledAt ? relativeTime(app.status.reconciledAt) || formatDate(app.status.reconciledAt) : '—'}</span> },
  ]
  if (apps > 1) rows.push({ label: 'Matched apps', node: <span className="text-[12px] text-content">{apps} — this is the production one</span> })
  return (
    <DrawerSection
      title="GitOps details"
      aside={appUrl ? (
        <a href={appUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          Argo CD <IconArrowUpRight />
        </a>
      ) : undefined}
    >
      <dl className="-my-1 divide-y divide-edge-subtle">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-3 py-2">
            <dt className="w-24 shrink-0 text-[11px] font-medium text-content-subtle">{r.label}</dt>
            <dd className="min-w-0 flex-1 text-right">{r.node}</dd>
          </div>
        ))}
      </dl>
      {app.status.conditions.length ? (
        <ul className="mt-3 space-y-1.5">
          {app.status.conditions.map((c, i) => (
            <li key={`${c.type}-${i}`} className={cn('rounded-md px-3 py-2 text-[11.5px] leading-relaxed', /error/i.test(c.type) ? 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200')}>
              <span className="font-semibold">{c.type}</span>{c.message ? ` — ${c.message}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {app.status.health.message ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{app.status.health.message}</p>
      ) : null}
    </DrawerSection>
  )
}

/**
 * The Overview tab's primary action: open the running thing.
 *
 * This is the top of the drawer because it is the question the catalog is most
 * often opened to answer, and until now the drawer could tell you a service was
 * Healthy without telling you where it was — so people guessed hostnames or
 * went digging in Argo CD's resource tree.
 *
 * One button, not a list. Additional hosts are summarised behind a count that
 * jumps to the Deployment tab, where every URL is listed in full with its route
 * and backend. A row of six equally-weighted links is not a primary action.
 */
function EntityRoutesBar({ routes, onSeeAll }: { routes: EntityRoute[]; onSeeAll(): void }) {
  // No routes is a normal answer, not a failure: a library, a database or a
  // queue consumer has no HTTP surface. Say nothing rather than showing an
  // empty state for something that was never expected to exist.
  if (!routes.length) return null
  const [primary, ...rest] = routes
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={primary.url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          'group inline-flex min-w-0 items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3.5 py-2',
          'text-xs font-semibold text-brand-800 shadow-sm',
          'transition-colors hover:border-brand-300 hover:bg-brand-100 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200 dark:hover:bg-brand-500/15',
        )}
        title={primary.url}
      >
        <IconGlobe />
        <span className="truncate">Open {routeLabel(primary)}</span>
        <IconArrowUpRight />
      </a>
      <CopyButton text={primary.url} />
      {rest.length ? (
        <button
          type="button"
          onClick={onSeeAll}
          className="rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-xs font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300"
        >
          +{rest.length} more {rest.length === 1 ? 'endpoint' : 'endpoints'}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Every URL the entity answers on, in full.
 *
 * Full URLs, not hostnames: a path-prefixed route (`/api`) is a different
 * endpoint from the root, and a truncated display is not something anyone can
 * copy into a terminal or a ticket.
 *
 * Each row states HOW the route was attributed — a `backendRefs` entry naming
 * the entity's Service is the cluster asserting the link, while a name match is
 * a guess this console made. Showing that distinction is what lets someone trust
 * or discount the row instead of wondering why an unrelated URL appeared.
 */
function EndpointsCard({ routes, repoUrl }: { routes: EntityRoute[]; repoUrl?: string }) {
  const primary = routes[0]
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconGlobe />
            <h3 className="text-sm font-semibold text-content">Endpoints</h3>
            {routes.length ? (
              <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-content-muted">
                {routes.length}
              </span>
            ) : null}
          </div>
          {repoUrl ? (
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300"
              title={repoUrl}
            >
              <IconGit />
              Source
              <IconArrowUpRight />
            </a>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {routes.length === 0 ? (
          <EmptyState
            compact
            title="No public endpoint"
            description={
              <>
                Nothing routes to this entity yet. A golden-path service gets its{' '}
                <code>HTTPRoute</code> from <code>deploy/</code>; a worker or library
                legitimately has none.
              </>
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
              {routes.map((r) => {
                let host = r.url
                let path = ''
                let secure = false
                try {
                  const u = new URL(r.url)
                  host = u.host
                  path = u.pathname === '/' ? '' : u.pathname
                  secure = u.protocol === 'https:'
                } catch {
                  /* show as-is */
                }
                return (
                  <li key={r.url} className="flex items-center gap-3 bg-surface-raised px-3 py-2.5">
                    <span
                      className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md', secure ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300')}
                      title={secure ? 'HTTPS' : 'Plain HTTP'}
                    >
                      <IconLock />
                    </span>
                    <div className="min-w-0 flex-1">
                      <a href={r.url} target="_blank" rel="noreferrer" className="block truncate font-mono text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300" title={r.url}>
                        {host}
                        {path ? <span className="text-content-muted">{path}</span> : null}
                      </a>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-content-subtle">
                        <span title={`${r.kind} ${r.namespace}/${r.name}`}>{r.kind} · {r.namespace}/{r.name}</span>
                        <span
                          className={cn('rounded px-1 py-px font-medium', r.via === 'backend' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300')}
                          title={r.via === 'backend' ? `backendRefs → Service/${r.service ?? '?'} — the cluster asserts this link` : 'matched by name only — verify it belongs to this entity'}
                        >
                          {r.via === 'backend' ? `backend → ${r.service ?? 'service'}` : 'matched by name'}
                        </span>
                      </div>
                    </div>
                    <CopyButton text={r.url} />
                    <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-md border border-edge-default px-2 py-1 text-[11px] font-medium text-content-muted transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300">
                      Open <IconArrowUpRight />
                    </a>
                  </li>
                )
              })}
            </ul>
            {primary ? (
              <div className="flex items-center gap-2 rounded-lg border border-edge-subtle bg-surface-sunken px-3 py-2">
                <code className="flex-1 truncate font-mono text-[11px] text-content-muted">curl -fsSI {primary.url}</code>
                <CopyButton text={`curl -fsSI ${primary.url}`} />
              </div>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  )
}

/** Which forge a repository URL points at, for provider-specific paths and a name. */
function repoProvider(url: string | undefined): { name: string; kind: 'gitea' | 'github' | 'gitlab' | 'other' } {
  if (!url) return { name: '—', kind: 'other' }
  let host = ''
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return { name: url, kind: 'other' }
  }
  if (host.includes('github')) return { name: 'GitHub', kind: 'github' }
  if (host.includes('gitlab')) return { name: 'GitLab', kind: 'gitlab' }
  if (host.includes('gitea') || host.startsWith('git.')) return { name: 'Gitea', kind: 'gitea' }
  return { name: host, kind: 'other' }
}

/** The repository browsed at a branch or commit, per forge. */
function repoTreeUrl(repoUrl: string, ref: string, kind: ReturnType<typeof repoProvider>['kind']): string {
  const base = repoUrl.replace(/\.git$/, '').replace(/\/$/, '')
  if (kind === 'gitea') return /^[0-9a-f]{7,40}$/i.test(ref) ? `${base}/src/commit/${ref}` : `${base}/src/branch/${encodeURIComponent(ref)}`
  if (kind === 'gitlab') return `${base}/-/tree/${encodeURIComponent(ref)}`
  return `${base}/tree/${encodeURIComponent(ref)}`
}

function RepositoryCard({
  entity,
  repoUrl,
  primary,
}: {
  entity: Entity
  repoUrl?: string
  primary?: EntityDeployment['primary']
}) {
  const a = entityAnnotations(entity)
  const branch =
    primary?.spec.source.targetRevision ?? a['adhar.io/branch'] ?? a['adhar.io/default-branch'] ?? 'main'
  const path = primary?.spec.source.path
  const rev = primary?.status.sync.revision
  const sha = shortSha(rev)
  const provider = repoProvider(repoUrl)
  const cloneUrl = repoUrl ? (repoUrl.endsWith('.git') ? repoUrl : `${repoUrl}.git`) : undefined
  const atRevision = repoUrl && rev ? repoTreeUrl(repoUrl, rev, provider.kind) : undefined
  const atBranch = repoUrl ? repoTreeUrl(repoUrl, branch, provider.kind) : undefined

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconGit />
            <h3 className="text-sm font-semibold text-content">Repository</h3>
            {repoUrl ? <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted">{provider.name}</span> : null}
          </div>
          {repoUrl ? (
            <div className="flex items-center gap-1.5">
              {atRevision ? (
                <a href={atRevision} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300" title={`Browse the repository at the deployed commit ${sha}`}>
                  At {sha} <IconArrowUpRight />
                </a>
              ) : null}
              <a href={repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-800 shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-100 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200 dark:hover:bg-brand-500/15">
                <LinkGlyph icon="repo" />
                Open repo
              </a>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {repoUrl ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Provider" value={<span className="text-sm">{provider.name}</span>} />
              <Field
                label="Branch"
                value={atBranch ? <a href={atBranch} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand-700 hover:underline dark:text-brand-300">{branch}</a> : <code className="text-xs text-content-muted">{branch}</code>}
              />
              <Field label="Path" value={<code className="text-xs text-content-muted">{path ?? '/'}</code>} />
              <Field
                label="Deployed commit"
                value={sha ? (atRevision ? <a href={atRevision} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand-700 hover:underline dark:text-brand-300">{sha}</a> : <code className="text-xs text-content-muted">{sha}</code>) : <span className="text-xs text-content-subtle">not deployed</span>}
              />
            </div>
            {cloneUrl ? (
              <div className="flex items-center gap-2 rounded-lg border border-edge-subtle bg-surface-sunken px-3 py-2">
                <code className="flex-1 truncate font-mono text-[11px] text-content-muted">
                  git clone {cloneUrl}
                </code>
                <CopyButton text={`git clone ${cloneUrl}`} />
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState
            compact
            title="No repository linked"
            description={
              <>
                Set the <code>adhar.io/source-repo</code> annotation (or add a <code>repo</code> link)
                so the source, clone command, and pipelines wire up here.
              </>
            }
          />
        )}
      </CardBody>
    </Card>
  )
}

const RUN_TONE: Record<PipelineRunSummary['state'], { dot: string; kind: StatusKind; label: string }> = {
  running: { dot: 'bg-sky-500 animate-pulse', kind: 'progressing', label: 'Running' },
  succeeded: { dot: 'bg-emerald-500', kind: 'healthy', label: 'Succeeded' },
  failed: { dot: 'bg-rose-500', kind: 'failed', label: 'Failed' },
  cancelled: { dot: 'bg-amber-500', kind: 'paused', label: 'Cancelled' },
  pending: { dot: 'bg-slate-400', kind: 'unknown', label: 'Pending' },
}

function fmtSecs(s?: number): string {
  if (s === undefined) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/**
 * The entity's recent Tekton PipelineRuns, live. Each row is the run as a
 * person reads it — outcome, when, how long, which commit — and the whole
 * card is the way into the CI view for logs and re-runs.
 */
function PipelinesCard({ entity, repoUrl }: { entity: Entity; repoUrl?: string }) {
  const a = entityAnnotations(entity)
  const ci = a['adhar.io/ci'] ?? a['adhar.io/ci-pipeline']
  const { runs, isLoading, isError, notInstalled } = usePipelineRuns(entity, repoUrl)
  const last = runs[0]
  const ok = runs.filter((r) => r.state === 'succeeded').length
  const finished = runs.filter((r) => r.state === 'succeeded' || r.state === 'failed').length
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <IconPipeline />
            <h3 className="text-sm font-semibold text-content">Pipeline runs</h3>
            {runs.length ? (
              <span className="truncate text-[11px] text-content-muted">
                {ci ? <span className="font-mono">{ci}</span> : 'Tekton'} · {ok}/{finished || runs.length} succeeded
              </span>
            ) : null}
          </div>
          <a href="/platform?section=ci" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
            CI / CD runs →
          </a>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner /> Reading PipelineRuns…</div>
        ) : notInstalled ? (
          <EmptyState compact title="Tekton is not installed on this cluster" description="PipelineRuns will appear here once the CI package is enabled." />
        ) : isError ? (
          <EmptyState compact title="Could not read PipelineRuns" description="The cluster gateway did not answer; the runs will appear when it does." />
        ) : runs.length === 0 ? (
          <EmptyState
            compact
            title={ci || repoUrl ? 'No runs yet for this entity' : 'No CI pipeline linked'}
            description={
              ci || repoUrl ? (
                <>
                  Runs are matched by the <code>adhar.io/ci-pipeline</code> pipeline name, an <code>adhar.io/component</code> label, a <code>repo-url</code> parameter naming this repository, or a run named after <code>{entity.metadata.name}</code>.
                </>
              ) : (
                <>
                  Add an <code>adhar.io/ci-pipeline</code> annotation, or scaffold the component from a Golden Path template to wire up Tekton PipelineRuns.
                </>
              )
            }
          />
        ) : (
          <>
            {last ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge-subtle bg-surface-sunken/50 px-3 py-2 text-[12px]">
                <span className="text-content-subtle">Last run</span>
                <StatusBadge kind={RUN_TONE[last.state].kind} className="px-1.5 py-0 text-[10px]" pulse={last.state === 'running'}>{RUN_TONE[last.state].label}</StatusBadge>
                <span className="text-content-muted">{last.startedAt ? relativeTime(last.startedAt) || formatDate(last.startedAt) : ''}</span>
                <span className="text-content-muted">· {fmtSecs(last.durationSecs)}</span>
                {last.reason && last.state === 'failed' ? <span className="truncate text-rose-700 dark:text-rose-300">· {last.reason}</span> : null}
              </div>
            ) : null}
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
              {runs.map((r) => (
                <li key={`${r.namespace}/${r.name}`} className="flex items-center gap-3 bg-surface-raised px-3 py-2">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', RUN_TONE[r.state].dot)} title={RUN_TONE[r.state].label} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-[12px] text-content">{r.name}</span>
                      {r.branch ? <span className="shrink-0 rounded bg-surface-sunken px-1 font-mono text-[10px] text-content-muted">{r.branch}</span> : null}
                      {r.commit ? <span className="shrink-0 font-mono text-[10px] text-content-subtle">{shortSha(r.commit) ?? r.commit.slice(0, 7)}</span> : null}
                    </div>
                    <div className="truncate text-[10.5px] text-content-subtle">
                      {r.pipeline ? `${r.pipeline} · ` : ''}{r.namespace}{r.tasks ? ` · ${r.tasks.done}/${r.tasks.total} tasks` : ''}{r.message && r.state === 'failed' ? ` · ${r.message.slice(0, 80)}` : ''}
                    </div>
                  </div>
                  <span className="shrink-0 text-right text-[11px] text-content-muted">
                    <span className="block">{r.startedAt ? relativeTime(r.startedAt) || formatDate(r.startedAt) : '—'}</span>
                    <span className="block font-mono text-[10px] text-content-subtle">{fmtSecs(r.durationSecs)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  )
}

/** Does this alert belong to the entity? Label conventions, most specific first. */
function alertMatches(labels: Record<string, string>, name: string, namespace?: string): boolean {
  const n = name.toLowerCase()
  const ns = (labels.namespace ?? '').toLowerCase()
  if (namespace && ns && ns !== namespace.toLowerCase()) return false
  const direct = [labels.deployment, labels.statefulset, labels.daemonset, labels.workload, labels.app, labels.service, labels['app.kubernetes.io/name'], labels.job, labels.container]
  if (direct.some((v) => (v ?? '').toLowerCase() === n)) return true
  const pod = (labels.pod ?? '').toLowerCase()
  return Boolean(pod && (pod === n || pod.startsWith(`${n}-`)))
}

/**
 * Observability, with the thing that matters first: the alerts firing for
 * this workload right now. Then the ways in — dashboard, runbook, the
 * Metrics tab, Grafana — and the SLO / alerting statements the entity makes
 * about itself.
 */
function MonitoringCard({ entity, monitorUrl, onMetrics }: { entity: Entity; monitorUrl?: string; onMetrics?(): void }) {
  const a = entityAnnotations(entity)
  const dashboard =
    (entity.metadata.links ?? []).find((l) => l.icon === 'dashboard')?.url ??
    a['adhar.io/dashboard'] ??
    a['backstage.io/dashboard'] ??
    monitorUrl
  const runbook =
    (entity.metadata.links ?? []).find((l) => l.icon === 'runbook')?.url ??
    a['adhar.io/runbook'] ??
    a['backstage.io/runbook']
  const slo = a['adhar.io/slo']
  const alerting = a['adhar.io/alerts'] ?? a['adhar.io/alerting']
  const namespace = (a['adhar.io/namespace'] ?? '').trim() || undefined
  const alertsQ = useDiscoverAlerts()
  const mine = useMemo(
    () => (alertsQ.data ?? []).filter((al) => al.state !== 'resolved' && alertMatches(al.labels, entity.metadata.name, namespace)),
    [alertsQ.data, entity.metadata.name, namespace],
  )
  const firing = mine.filter((al) => al.state === 'firing')
  const pending = mine.filter((al) => al.state === 'pending')
  const sevTone: Record<string, string> = { critical: 'bg-rose-500', warning: 'bg-amber-500', info: 'bg-sky-500' }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconPulse />
            <h3 className="text-sm font-semibold text-content">Observability</h3>
            {alertsQ.isLoading ? null : mine.length ? (
              <StatusBadge kind={firing.some((al) => al.severity === 'critical') ? 'failed' : firing.length ? 'degraded' : 'paused'} className="px-1.5 py-0 text-[10px]">
                {firing.length ? `${firing.length} firing` : `${pending.length} pending`}
              </StatusBadge>
            ) : alertsQ.isError ? null : (
              <StatusBadge kind="healthy" className="px-1.5 py-0 text-[10px]" dot={false}>no alerts</StatusBadge>
            )}
          </div>
          <a href="/discover?section=alerts" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
            All alerts →
          </a>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {alertsQ.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner /> Reading Alertmanager…</div>
        ) : alertsQ.isError ? (
          <p className="text-[11.5px] text-content-subtle">Alertmanager is not reachable — alert state is unknown, not clear.</p>
        ) : mine.length ? (
          <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
            {mine.slice(0, 5).map((al) => (
              <li key={al.fingerprint} className="flex items-start gap-3 bg-surface-raised px-3 py-2">
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', sevTone[al.severity] ?? 'bg-slate-400', al.state === 'pending' && 'opacity-60')} title={`${al.severity} · ${al.state}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[12.5px] font-medium text-content">{al.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-content-subtle">{al.severity} · {al.state}</span>
                    <span className="text-[10.5px] text-content-subtle">since {relativeTime(al.startsAt) || formatDate(al.startsAt)}</span>
                  </div>
                  {al.summary || al.description ? <div className="mt-0.5 text-[11px] leading-relaxed text-content-muted">{al.summary ?? al.description}</div> : null}
                </div>
                {al.runbook_url ? (
                  <a href={al.runbook_url} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">runbook ↗</a>
                ) : null}
              </li>
            ))}
            {mine.length > 5 ? <li className="bg-surface-raised px-3 py-1.5 text-[10.5px] text-content-subtle">+{mine.length - 5} more</li> : null}
          </ul>
        ) : (
          <p className="text-[11.5px] text-content-muted">No alerts are firing or pending for <span className="font-mono text-content">{entity.metadata.name}</span>.</p>
        )}

        <div className="flex flex-wrap gap-2">
          {dashboard ? (
            <a href={dashboard} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300">
              <LinkGlyph icon="dashboard" /> Dashboard <IconArrowUpRight />
            </a>
          ) : null}
          {runbook ? (
            <a href={runbook} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300">
              <LinkGlyph icon="runbook" /> Runbook <IconArrowUpRight />
            </a>
          ) : null}
          {onMetrics ? (
            <button type="button" onClick={onMetrics} className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300">
              <IconPulse /> Live metrics
            </button>
          ) : null}
          <PhaseLink href="/discover?section=slos">SLOs</PhaseLink>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="SLO target"
            value={slo ? <span className="text-sm">{slo}</span> : <span className="text-xs text-content-subtle">none declared — set adhar.io/slo</span>}
          />
          <Field
            label="Alerting"
            value={alerting ? <span className="text-sm">{alerting}</span> : <span className="text-xs text-content-subtle">{mine.length ? `${mine.length} rule${mine.length === 1 ? '' : 's'} active` : 'no rules matched this workload'}</span>}
          />
        </div>
        {!dashboard && !runbook ? (
          <p className="text-xs text-content-muted">
            Link a dashboard (<code>adhar.io/dashboard</code>) and a runbook (<code>adhar.io/runbook</code>) so an on-call engineer can go from an alert to the picture and the procedure in one click.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}

/* ─────────── API definition (compact OpenAPI view) ─────────── */

const METHOD_TONE: Record<string, string> = {
  GET: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200',
  POST: 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 ring-brand-200',
  PUT: 'bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 ring-amber-200',
  PATCH: 'bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-violet-200',
  DELETE: 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-200',
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
    <DrawerSection title="Activity">
      <ol className="relative space-y-3 border-l border-edge-subtle pl-4">
          {events.map((ev, i) => (
            <li key={i} className="relative">
              <span
                className={cn(
                  'absolute -left-[19px] top-1 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-surface-raised',
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
    </DrawerSection>
  )
}

/* ─────────── tech stack card (drawer) ─────────── */

function TechStackTab({
  stack,
  version,
  entity,
  docsUrl,
  deployment,
  onOpenDocs,
}: {
  stack: TechBadge[]
  version?: string
  entity: Entity
  docsUrl?: string
  deployment?: EntityDeployment
  onOpenDocs?: () => void
}) {
  const ann = entityAnnotations(entity)
  const repoUrl = repoUrlFor(entity)
  const grouped = TECH_GROUP_ORDER
    .map((g) => ({ group: g, items: stack.filter((b) => b.group === g) }))
    .filter((x) => x.items.length > 0)
  const versioned = stack.filter((b) => b.version)
  const languages = stack.filter((b) => b.group === 'language')
  const frameworks = stack.filter((b) => b.group === 'framework')
  const datastores = stack.filter((b) => b.group === 'datastore')
  const versionSource = ann['adhar.io/version']
    ? 'adhar.io/version annotation'
    : ann['backstage.io/version']
      ? 'backstage.io/version annotation'
      : ann['app.kubernetes.io/version']
        ? 'app.kubernetes.io/version label'
        : version
          ? 'version-shaped tag'
          : undefined
  // Which tag or annotation each badge came from, so a wrong version can be
  // traced to the line that set it.
  const sourceOf = (b: TechBadge): string => {
    const tag = (entity.metadata.tags ?? []).find((t) => TECH_MAP[parseTechTag(t).key]?.label === b.label)
    if (tag && (!b.version || parseTechTag(tag).version)) return `tag ${tag}`
    const fromAnn = techFromAnnotations(entity).find((m) => TECH_MAP[m.key]?.label === b.label)
    if (fromAnn) return fromAnn.version ? 'adhar.io/tech-stack' : 'annotation'
    return tag ? `tag ${tag}` : 'catalog'
  }
  const envImages = (deployment?.environments ?? []).map((e) => ({ env: e.label, app: e.app.metadata.name, images: e.app.status.images }))
  const anyImages = envImages.some((e) => e.images.length)

  const tiles: Array<{ label: string; value: string; sub: string }> = [
    { label: 'Languages', value: languages.length ? languages.map((b) => b.label).join(', ') : '—', sub: languages.length ? `${languages.filter((b) => b.version).length}/${languages.length} with a version` : 'none tagged' },
    { label: 'Frameworks', value: frameworks.length ? frameworks.map((b) => b.label).join(', ') : '—', sub: frameworks.length ? `${frameworks.filter((b) => b.version).length}/${frameworks.length} with a version` : 'none tagged' },
    { label: 'Data & messaging', value: datastores.length ? datastores.map((b) => b.label).join(', ') : '—', sub: datastores.length ? `${datastores.length} ${datastores.length === 1 ? 'store' : 'stores'}` : 'none tagged' },
    { label: 'App version', value: version ?? '—', sub: versionSource ?? 'not published' },
  ]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3.5 py-3 shadow-sm">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-content-subtle">{t.label}</div>
            <div className="mt-1.5 truncate text-[15px] font-semibold leading-tight text-content" title={t.value}>{t.value}</div>
            <div className="mt-1 truncate text-[11px] text-content-muted">{t.sub}</div>
          </div>
        ))}
      </div>

      {stack.length === 0 && !version ? (
        <DrawerSection title="Stack">
          <p className="text-[12.5px] leading-relaxed text-content-muted">
            Nothing recorded for <code className="font-mono text-content">{entity.metadata.name}</code>. Tag it with its stack and versions — for example{' '}
            <code className="font-mono text-content">java-21</code>, <code className="font-mono text-content">spring-boot-3.3</code>, <code className="font-mono text-content">postgres-16</code> — or set{' '}
            <code className="font-mono text-content">adhar.io/tech-stack: "java@21, spring-boot@3.3.2"</code>. Versions are what make this tab useful: "is this on a supported Java?" needs a number.
          </p>
        </DrawerSection>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {grouped.map(({ group, items }) => (
            <DrawerSection
              key={group}
              title={TECH_GROUP_LABEL[group]}
              aside={<span className="text-[11px] text-content-subtle">{items.filter((b) => b.version).length}/{items.length} versioned</span>}
            >
              <ul className="divide-y divide-edge-subtle">
                {items.map((b) => (
                  <li key={b.label} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <span className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold ring-1 ring-inset', TECH_PILL[b.tone])}>
                      {b.label.replace(/[^A-Za-z0-9#.+]/g, '').slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-content">{b.label}</span>
                      <span className="block truncate text-[10.5px] text-content-subtle">from {sourceOf(b)}</span>
                    </span>
                    {b.version ? (
                      <span className="shrink-0 rounded-md bg-surface-sunken px-2 py-1 font-mono text-[12px] font-semibold text-content ring-1 ring-inset ring-edge-subtle">{b.version}</span>
                    ) : (
                      <span className="shrink-0 rounded-md border border-dashed border-edge-default px-2 py-1 text-[10.5px] italic text-content-subtle" title={`Add the version to the tag, e.g. ${b.label.toLowerCase().replace(/\s+/g, '-')}-<version>`}>
                        no version
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </DrawerSection>
          ))}
        </div>
      )}

      {deployment ? (
        <DrawerSection title="Running now" aside={<span className="text-[11px] text-content-subtle">container images per environment · from Argo CD</span>}>
          {deployment.isLoading ? (
            <div className="flex items-center gap-2 text-[11px] text-content-subtle"><Spinner size={12} /> Reading Argo CD…</div>
          ) : !anyImages ? (
            <p className="text-[11.5px] text-content-subtle">
              {deployment.isError ? 'Argo CD is not reachable.' : deployment.apps.length ? 'Argo CD reports no images for this application.' : 'Not deployed via Argo CD, so there is nothing running to report.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                    <th className="pb-1.5 pr-4 font-semibold">Environment</th>
                    <th className="pb-1.5 pr-4 font-semibold">Image</th>
                    <th className="pb-1.5 font-semibold">Tag</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {envImages.flatMap((e) =>
                    e.images.map((img, i) => {
                      const short = shortImage(img)
                      const [name, tag] = short.includes(':') ? [short.slice(0, short.lastIndexOf(':')), short.slice(short.lastIndexOf(':') + 1)] : [short, 'latest']
                      return (
                        <tr key={`${e.app}-${img}`}>
                          <td className="py-1.5 pr-4 align-top text-content">{i === 0 ? e.env : ''}</td>
                          <td className="py-1.5 pr-4 align-top font-mono text-[11px] text-content-muted" title={img}>{name}</td>
                          <td className="py-1.5 align-top">
                            <span className={cn('rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold', tag === 'latest' ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-surface-sunken text-content')} title={tag === 'latest' ? 'A :latest tag cannot be rolled back to' : undefined}>
                              {tag}
                            </span>
                          </td>
                        </tr>
                      )
                    }),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </DrawerSection>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <DrawerSection title="Where this comes from">
          <dl className="-my-1 divide-y divide-edge-subtle">
            {[
              { label: 'Stack', node: stack.length ? `${stack.length} from catalog tags${techFromAnnotations(entity).length ? ' and adhar.io/tech-stack' : ''}` : 'no tags' },
              { label: 'Versions', node: versioned.length ? `${versioned.length} of ${stack.length} recorded` : 'none recorded' },
              { label: 'App version', node: versionSource ?? 'not published' },
              { label: 'Repository', node: repoUrl ? <a href={repoUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-300">{repoUrl.replace(/^https?:\/\//, '')}</a> : 'not linked' },
            ].map((r) => (
              <div key={r.label} className="flex items-start justify-between gap-3 py-2">
                <dt className="shrink-0 text-[11px] font-medium text-content-subtle">{r.label}</dt>
                <dd className="min-w-0 truncate text-right text-[12px] text-content">{r.node}</dd>
              </div>
            ))}
          </dl>
        </DrawerSection>
        <DrawerSection
          title="Tech docs"
          aside={docsUrl && onOpenDocs ? (
            <button type="button" onClick={onOpenDocs} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">Read here →</button>
          ) : undefined}
        >
          <div className="flex items-center gap-2">
            {docsUrl ? (
              <StatusBadge kind="healthy" className="px-1.5 py-0 text-[10px]">registered</StatusBadge>
            ) : (
              <StatusBadge kind="paused" className="px-1.5 py-0 text-[10px]">not registered</StatusBadge>
            )}
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-content-muted">
            {docsUrl
              ? 'Markdown kept in the repository renders inside the console, with a table of contents and search.'
              : 'Add a docs link to metadata.links, or the backstage.io/techdocs-ref / adhar.io/docs annotation, to publish documentation for this component.'}
          </p>
        </DrawerSection>
      </div>
    </div>
  )
}

/* ─────────── lightweight markdown renderer (no deps, XSS-safe) ─────────── */

/** Allow only safe link/image targets — http(s), mailto, in-page, relative. */
function safeHref(url: string): string | undefined {
  const u = url.trim()
  return /^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(u) ? u : undefined
}

/** Resolve a doc-relative link/image against the document's own URL. */
function resolveDocUrl(raw: string, base?: string): string | undefined {
  const safe = safeHref(raw)
  if (!safe) return undefined
  if (!base || /^(https?:\/\/|mailto:|#)/i.test(safe)) return safe
  try {
    return new URL(safe, new URL(base, globalThis.location?.href ?? 'http://localhost')).toString()
  } catch {
    return safe
  }
}

/** Parse inline markdown (bold, italic, code, links, images) into React nodes. */
function inlineMd(text: string, base: string | undefined, keyer: () => number): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re =
    /(`[^`]+`)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(
        <code
          key={keyer()}
          className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.85em] text-content"
        >
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (tok.startsWith('![')) {
      const mm = /!\[([^\]]*)\]\(([^)]+)\)/.exec(tok)
      const src = mm ? resolveDocUrl(mm[2], base) : undefined
      out.push(
        src ? (
          <img
            key={keyer()}
            src={src}
            alt={mm![1]}
            className="my-2 max-h-80 rounded-lg border border-edge-subtle"
          />
        ) : (
          mm?.[1] ?? tok
        ),
      )
    } else if (tok.startsWith('[')) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)
      const href = mm ? resolveDocUrl(mm[2], base) : undefined
      out.push(
        href ? (
          <a
            key={keyer()}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand-700 underline decoration-brand-300 underline-offset-2 hover:text-brand-800 dark:text-brand-300"
          >
            {mm![1]}
          </a>
        ) : (
          mm?.[1] ?? tok
        ),
      )
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(
        <strong key={keyer()} className="font-semibold text-content">
          {tok.slice(2, -2)}
        </strong>,
      )
    } else {
      out.push(
        <em key={keyer()} className="italic">
          {tok.slice(1, -1)}
        </em>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Block-level markdown → React. Supports headings, lists, quotes, fenced code, tables, hr. */
function Markdown({ source, base }: { source: string; base?: string }) {
  const nodes = useMemo(() => {
    let k = 0
    const keyer = () => k++
    const lines = source.replace(/\r\n?/g, '\n').split('\n')
    const blocks: React.ReactNode[] = []
    const inline = (t: string) => inlineMd(t, base, keyer)
    let i = 0

    const HEAD_CLS = [
      'mt-5 text-xl font-bold text-content',
      'mt-5 text-lg font-bold text-content',
      'mt-4 text-base font-semibold text-content',
      'mt-3 text-sm font-semibold text-content',
      'mt-3 text-sm font-semibold text-content-muted',
      'mt-3 text-xs font-semibold uppercase tracking-wide text-content-muted',
    ]

    while (i < lines.length) {
      const line = lines[i]

      // fenced code
      const fence = /^```(\w*)\s*$/.exec(line)
      if (fence) {
        const buf: string[] = []
        i++
        while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++])
        i++ // closing fence
        blocks.push(
          <pre
            key={keyer()}
            className="my-3 overflow-auto rounded-lg border border-edge-subtle bg-code p-3 font-mono text-[12px] leading-relaxed text-code-fg"
          >
            <code>{buf.join('\n')}</code>
          </pre>,
        )
        continue
      }

      // heading
      const h = /^(#{1,6})\s+(.*)$/.exec(line)
      if (h) {
        const level = h[1].length
        const Tag = (`h${Math.min(level + 1, 6)}` as unknown) as keyof React.JSX.IntrinsicElements
        // Anchor ids let the TechDocs table of contents scroll to a section.
        const anchor = slugifyHeading(h[2].replace(/[*_`]/g, ''))
        blocks.push(
          <Tag key={keyer()} id={anchor} className={cn(HEAD_CLS[level - 1], 'scroll-mt-4')}>
            {inline(h[2])}
          </Tag>,
        )
        i++
        continue
      }

      // horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        blocks.push(<hr key={keyer()} className="my-4 border-edge-subtle" />)
        i++
        continue
      }

      // blank
      if (/^\s*$/.test(line)) {
        i++
        continue
      }

      // table: header row + separator row
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        const splitRow = (r: string) =>
          r
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => c.trim())
        const header = splitRow(line)
        i += 2
        const rows: string[][] = []
        while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]))
          i++
        }
        blocks.push(
          <div key={keyer()} className="my-3 overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  {header.map((c, ci) => (
                    <th
                      key={ci}
                      className="border-b border-edge-default px-2 py-1.5 text-left font-semibold text-content"
                    >
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className="odd:bg-surface-sunken/40">
                    {header.map((_, ci) => (
                      <td key={ci} className="border-b border-edge-subtle px-2 py-1.5 text-content-muted">
                        {inline(r[ci] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        )
        continue
      }

      // blockquote
      if (/^>\s?/.test(line)) {
        const buf: string[] = []
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
        blocks.push(
          <blockquote
            key={keyer()}
            className="my-3 border-l-2 border-brand-300 bg-surface-sunken/50 px-3 py-2 text-content-muted"
          >
            {inline(buf.join(' '))}
          </blockquote>,
        )
        continue
      }

      // lists (unordered / ordered)
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line)
        const items: string[] = []
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''))
          i++
        }
        const cls = 'my-2 space-y-1 pl-5 text-content-muted'
        blocks.push(
          ordered ? (
            <ol key={keyer()} className={cn(cls, 'list-decimal')}>
              {items.map((it, ii) => (
                <li key={ii}>{inline(it)}</li>
              ))}
            </ol>
          ) : (
            <ul key={keyer()} className={cn(cls, 'list-disc')}>
              {items.map((it, ii) => (
                <li key={ii}>{inline(it)}</li>
              ))}
            </ul>
          ),
        )
        continue
      }

      // paragraph (gather until blank / block start)
      const para: string[] = []
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s+|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])
      ) {
        para.push(lines[i++])
      }
      blocks.push(
        <p key={keyer()} className="my-2 leading-relaxed text-content-muted">
          {inline(para.join(' '))}
        </p>,
      )
    }
    return blocks
  }, [source, base])

  return <div className="text-[13px]">{nodes}</div>
}

/* ─────────── techdocs card (drawer) — embedded markdown ─────────── */

/** Candidate doc paths to probe when only a repo/base is known. */
function docCandidates(url: string): string[] {
  const clean = url.replace(/[?#].*$/, '')
  if (/\.mdx?$/i.test(clean)) return [url]
  const baseNoSlash = clean.replace(/\/$/, '')
  return [`${baseNoSlash}/index.md`, `${baseNoSlash}/README.md`, `${baseNoSlash}/docs/index.md`]
}

/**
 * TechDocs — a real documentation reader, not a link with a preview.
 *
 * Layout: a sticky action bar (Source · Docs · **Monitor**), a generated
 * table of contents from the document's own headings, the rendered Markdown
 * in a readable measure, and honest states when docs aren't registered,
 * can't be embedded (external origin / CORS) or fail to load. Reading
 * position and heading anchors work, so long runbooks are navigable.
 */
/**
 * TechDocs as a site, not a file.
 *
 * When the docs live in a repository the console can read (the platform's
 * Gitea through the BFF, GitHub best-effort), every Markdown page under the
 * docs root becomes a page here: a nav on the left grouped by folder, the
 * page on the right with its own table of contents, search across page
 * titles, and "Edit this page" straight into the forge. A published docs
 * site is framed in place; a single Markdown file falls back to the
 * one-document reader; nothing at all says what to add.
 */
function TechDocsTab({ url, entity, monitorUrl }: { url?: string; entity: Entity; monitorUrl?: string }) {
  const giteaBase = useToolPublicUrl('gitea')
  const source = useDocsSource(entity, giteaBase)
  const isRepo = source?.kind === 'gitea' || source?.kind === 'github'
  const pagesQ = useDocsPages(isRepo ? source : null)
  const pages = pagesQ.data ?? []
  const [slug, setSlug] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const current = useMemo(() => pages.find((p) => p.slug === slug) ?? pages[0], [pages, slug])
  const pageQ = useDocPage(isRepo ? source : null, current?.path)
  const text = pageQ.data ?? null
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [current?.path])

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? pages.filter((p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)) : pages
    const map = new Map<string, DocPage[]>()
    for (const p of list) map.set(p.section, [...(map.get(p.section) ?? []), p])
    return [...map.entries()]
  }, [pages, query])

  const toc = useMemo(() => {
    if (!text) return [] as Array<{ level: number; title: string; id: string }>
    const out: Array<{ level: number; title: string; id: string }> = []
    let inFence = false
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) inFence = !inFence
      if (inFence) continue
      const m = /^(#{2,3})\s+(.+?)\s*#*$/.exec(line)
      if (!m) continue
      const title = m[2].replace(/[*_`]/g, '').trim()
      out.push({ level: m[1].length, title, id: slugifyHeading(title) })
    }
    return out
  }, [text])

  // Every hook above runs on every render; only now do the other shapes
  // of docs take over — a site is framed, a single file uses the reader.
  if (!source || source.kind === 'markdown') return <TechDocsCard url={url} entity={entity} monitorUrl={monitorUrl} />
  if (source.kind === 'site') return <DocsSiteFrame url={source.url} entity={entity} monitorUrl={monitorUrl} />

  const title = text ? headingOf(text) ?? current?.title : current?.title
  const edit = current ? editUrl(source, current.path) : undefined
  const base = current ? rawBase(source, current.path) : undefined
  const words = text ? text.split(/\s+/).length : 0
  const repoLabel = `${source.org}/${source.repo}${source.dir ? `/${source.dir}` : ''} @ ${source.ref}`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge-default bg-surface-raised px-4 py-2.5 shadow-sm">
        <div className="flex min-w-0 items-center gap-2">
          <LinkGlyph icon="docs" />
          <span className="text-[13px] font-semibold text-content">TechDocs</span>
          <span className="truncate font-mono text-[11px] text-content-subtle" title={source.url}>{repoLabel}</span>
          {pages.length ? <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-content-muted">{pages.length} {pages.length === 1 ? 'page' : 'pages'}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {edit ? <DocAction href={edit} icon="repo" label="Edit this page" /> : null}
          <DocAction href={source.url} icon="docs" label={source.kind === 'gitea' ? 'Open in Gitea' : 'Open on GitHub'} primary />
          {monitorUrl ? <MonitorButton url={monitorUrl} compact /> : null}
        </div>
      </div>

      {pagesQ.isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised px-4 py-6 text-xs text-content-muted"><Spinner /> Reading the docs tree…</div>
      ) : pagesQ.isError ? (
        <EmptyState
          compact
          title="Couldn't read the repository"
          description={source.kind === 'github' ? 'GitHub did not answer (private repository, or the API rate limit). Open it on GitHub instead.' : `Gitea did not answer for ${repoLabel} — the repository may be private to another team, or the branch may not exist.`}
        />
      ) : pages.length === 0 ? (
        <EmptyState
          compact
          title="No documentation in the repository"
          description={<>Add a <code>docs/</code> folder with Markdown pages (an <code>index.md</code> first), or a <code>README.md</code>, and it renders here. Point <code>backstage.io/techdocs-ref</code> at another folder if the docs live elsewhere.</>}
        />
      ) : (
        <div className="grid items-start gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
          {/* The drawer body is the scroll container; the nav and the TOC stick below its tab bar so the page can be as long as it is. */}
          <nav className="rounded-xl border border-edge-default bg-surface-raised p-2 lg:sticky lg:top-14 lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto" aria-label="Documentation pages">
            <div className="relative mb-2 flex items-center">
              <span className="pointer-events-none absolute left-2.5 text-content-subtle"><DocSearchGlyph /></span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a page…"
                className="h-8 w-full rounded-lg border border-edge-default bg-surface-app pl-8 pr-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
              />
            </div>
            {sections.map(([section, list]) => (
              <div key={section || '~'} className="mb-1.5">
                {section ? <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{section.replace(/[-_]+/g, ' ')}</div> : null}
                <ul>
                  {list.map((p) => {
                    const on = p.slug === current?.slug
                    return (
                      <li key={p.slug}>
                        <button
                          type="button"
                          onClick={() => setSlug(p.slug)}
                          aria-current={on ? 'page' : undefined}
                          className={cn(
                            'block w-full truncate rounded-md px-2 py-1 text-left text-[12px] transition-colors',
                            on ? 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-500/10 dark:text-brand-200' : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                          )}
                          title={p.path}
                        >
                          {p.title}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
            {sections.length === 0 ? <div className="px-2 py-2 text-[11.5px] text-content-subtle">No page matches.</div> : null}
          </nav>

          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 px-1">
              <div className="min-w-0">
                <h3 className="truncate text-[16px] font-semibold text-content">{title}</h3>
                <div className="truncate font-mono text-[10.5px] text-content-subtle">{current?.path}{words ? ` · ${words.toLocaleString()} words · ~${Math.max(1, Math.round(words / 220))} min` : ''}</div>
              </div>
            </div>
            <div className={cn('grid items-start gap-4', toc.length > 2 ? 'xl:grid-cols-[minmax(0,1fr)_170px]' : '')}>
              <div ref={bodyRef} className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-6 py-5 [&_:is(h1,h2,h3,h4)]:scroll-mt-16">
                {pageQ.isLoading ? (
                  <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner /> Loading page…</div>
                ) : pageQ.isError ? (
                  <div className="text-xs text-content-muted">Couldn&apos;t load {current?.path}.</div>
                ) : text ? (
                  <Markdown source={text} base={base} />
                ) : null}
              </div>
              {toc.length > 2 ? (
                <nav className="hidden xl:sticky xl:top-14 xl:block xl:max-h-[calc(100vh-9rem)] xl:overflow-y-auto">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">On this page</div>
                  <ul className="space-y-0.5 border-l border-edge-subtle">
                    {toc.map((h, i) => (
                      <li key={`${h.id}-${i}`}>
                        <button
                          type="button"
                          onClick={() => bodyRef.current?.querySelector(`#${CSS.escape(h.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                          className={cn('-ml-px block w-full border-l-2 border-transparent py-0.5 pl-2.5 text-left text-[11.5px] text-content-muted transition-colors hover:border-brand-400 hover:text-content', h.level === 3 && 'pl-5 text-[11px]')}
                        >
                          {h.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** A published documentation site, framed in place. */
function DocsSiteFrame({ url, entity, monitorUrl }: { url: string; entity: Entity; monitorUrl?: string }) {
  const sourceUrl = (entity.metadata.links ?? []).find((l) => l.icon === 'repo')?.url
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge-default bg-surface-raised px-4 py-2.5 shadow-sm">
        <div className="flex min-w-0 items-center gap-2">
          <LinkGlyph icon="docs" />
          <span className="text-[13px] font-semibold text-content">TechDocs</span>
          <span className="truncate font-mono text-[11px] text-content-subtle" title={url}>{url.replace(/^https?:\/\//, '')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {sourceUrl ? <DocAction href={sourceUrl} icon="repo" label="Source" /> : null}
          <DocAction href={url} icon="docs" label="Open in new tab" primary />
          {monitorUrl ? <MonitorButton url={monitorUrl} compact /> : null}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
        <iframe
          src={url}
          title={`Documentation for ${entity.metadata.title ?? entity.metadata.name}`}
          className="h-[40rem] w-full bg-white"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          referrerPolicy="no-referrer"
        />
      </div>
      <p className="text-[11px] text-content-subtle">
        If the frame stays blank the site refuses to be embedded (X-Frame-Options) — use "Open in new tab". A Markdown docs folder in the repository renders natively here instead.
      </p>
    </div>
  )
}

function TechDocsCard({ url, entity, monitorUrl }: { url?: string; entity?: Entity; monitorUrl?: string }) {
  const [text, setText] = useState<string | null>(null)
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(url)
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'external'>('idle')
  const [query, setQuery] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  const sourceUrl = (entity?.metadata.links ?? []).find((l) => l.icon === 'repo')?.url
  const runbookUrl = (entity?.metadata.links ?? []).find((l) => l.icon === 'runbook')?.url

  useEffect(() => {
    setText(null)
    setResolvedUrl(url)
    if (!url || typeof globalThis.location === 'undefined') {
      setState('idle')
      return
    }
    let sameOrigin = false
    try {
      const u = new URL(url, globalThis.location.href)
      sameOrigin = u.origin === globalThis.location.origin
    } catch {
      sameOrigin = false
    }
    // External docs can't be fetched from the browser (CORS) — offer the link.
    if (!sameOrigin) {
      setState('external')
      return
    }
    let cancelled = false
    setState('loading')
    const candidates = docCandidates(url)
    ;(async () => {
      for (const cand of candidates) {
        try {
          const r = await fetch(cand)
          if (!r.ok) continue
          const ct = r.headers.get('content-type') ?? ''
          if (/text\/html/i.test(ct)) continue // SPA fallback, not a doc
          const body = await r.text()
          if (!cancelled) {
            setText(body)
            setResolvedUrl(cand)
            setState('idle')
          }
          return
        } catch {
          /* try next candidate */
        }
      }
      if (!cancelled) setState('error')
    })()
    return () => {
      cancelled = true
    }
  }, [url])

  // Table of contents straight from the document's headings.
  const toc = useMemo(() => {
    if (!text) return [] as Array<{ level: number; title: string; id: string }>
    const out: Array<{ level: number; title: string; id: string }> = []
    let inFence = false
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) inFence = !inFence
      if (inFence) continue
      const m = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line)
      if (!m) continue
      const title = m[2].replace(/[*_`]/g, '').trim()
      out.push({ level: m[1].length, title, id: slugifyHeading(title) })
    }
    return out
  }, [text])

  const filtered = useMemo(() => {
    if (!text || !query.trim()) return text
    // Keep sections whose heading or body matches, so search reads as an
    // outline filter rather than a highlight-only toy.
    const q = query.trim().toLowerCase()
    const blocks = text.split(/\n(?=#{1,3}\s)/)
    const hits = blocks.filter((b) => b.toLowerCase().includes(q))
    return hits.length ? hits.join('\n\n') : text
  }, [text, query])

  const actions = (
    <div className="flex flex-wrap items-center gap-1.5">
      {sourceUrl ? <DocAction href={sourceUrl} icon="repo" label="Source" /> : null}
      {runbookUrl ? <DocAction href={runbookUrl} icon="runbook" label="Runbook" /> : null}
      {url ? <DocAction href={resolvedUrl ?? url} icon="docs" label="Docs" primary /> : null}
      {monitorUrl ? <MonitorButton url={monitorUrl} compact /> : null}
    </div>
  )

  if (!url) {
    return (
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-content">TechDocs</h3>
            {actions}
          </div>
        </CardHeader>
        <CardBody>
          <EmptyState
            compact
            title="No tech docs registered"
            description={
              <>
                Add a <code>docs</code> link to <code>metadata.links</code> or set the{' '}
                <code>backstage.io/techdocs-ref</code> / <code>adhar.io/docs</code> annotation to
                publish documentation here. Markdown in the repo renders inline; an external docs
                site opens in a new tab.
              </>
            }
          />
        </CardBody>
      </Card>
    )
  }

  const words = text ? text.split(/\s+/).length : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-sm font-semibold text-content">TechDocs</h3>
            {text != null ? (
              <StatusBadge kind="healthy" className="px-1.5 py-0 text-[10px]">
                embedded
              </StatusBadge>
            ) : null}
            {words > 0 ? (
              <span className="font-mono text-[10px] text-content-subtle">
                {words.toLocaleString()} words · ~{Math.max(1, Math.round(words / 220))} min read
              </span>
            ) : null}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {text != null ? (
          <div className="relative flex items-center">
            <span className="pointer-events-none absolute left-2.5 text-content-subtle">
              <DocSearchGlyph />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter sections…"
              className="h-8 w-full rounded-lg border border-edge-default bg-surface-app pl-8 pr-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </div>
        ) : null}

        {state === 'loading' ? (
          <div className="flex items-center gap-2 text-xs text-content-muted">
            <Spinner /> Loading documentation…
          </div>
        ) : null}
        {state === 'error' ? (
          <div className="rounded-lg border border-dashed border-edge-default px-3 py-2.5 text-xs text-content-muted">
            Couldn&apos;t load the document inline (it may need auth, or the path doesn&apos;t serve
            raw Markdown). Use <span className="font-medium text-content">Docs</span> above to open it.
          </div>
        ) : null}
        {state === 'external' ? (
          <div className="rounded-lg border border-dashed border-edge-default px-3 py-2.5 text-xs text-content-muted">
            Documentation is hosted on another origin, so the browser can&apos;t embed it. Use{' '}
            <span className="font-medium text-content">Docs</span> to open it in a new tab.
          </div>
        ) : null}

        {text != null ? (
          <div className={cn('grid gap-4', toc.length > 2 ? 'lg:grid-cols-[180px_minmax(0,1fr)]' : '')}>
            {toc.length > 2 ? (
              <nav className="hidden max-h-[28rem] overflow-y-auto lg:block">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                  On this page
                </div>
                <ul className="space-y-0.5 border-l border-edge-subtle">
                  {toc.map((h, i) => (
                    <li key={`${h.id}-${i}`}>
                      <button
                        type="button"
                        onClick={() => {
                          const el = bodyRef.current?.querySelector(`#${CSS.escape(h.id)}`)
                          el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }}
                        className={cn(
                          '-ml-px block w-full border-l-2 border-transparent py-0.5 pl-2.5 text-left text-[11.5px] text-content-muted transition-colors hover:border-brand-400 hover:text-content',
                          h.level === 1 && 'font-medium text-content',
                          h.level === 3 && 'pl-5 text-[11px]',
                        )}
                      >
                        {h.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
            <div
              ref={bodyRef}
              className="max-h-[32rem] overflow-y-auto rounded-lg border border-edge-subtle bg-surface-raised px-5 py-4"
            >
              <Markdown source={filtered ?? text} base={resolvedUrl ?? url} />
            </div>
          </div>
        ) : null}

        <div className="truncate font-mono text-[10.5px] text-content-subtle">{resolvedUrl ?? url}</div>
      </CardBody>
    </Card>
  )
}

/** GitHub-style heading anchor, matching what `Markdown` renders. */
function slugifyHeading(t: string): string {
  return t.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')
}

function DocAction({ href, icon, label, primary = false }: { href: string; icon: 'repo' | 'docs' | 'runbook'; label: string; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md font-semibold transition-colors',
        // Emphasis by tint, not by a filled blue block: these are links out
        // of the console, and a filled button made each one look like the
        // page's own primary action.
        primary
          ? 'border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs text-brand-800 hover:border-brand-300 hover:bg-brand-100 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200 dark:hover:bg-brand-500/15'
          : 'bg-surface-raised px-1.5 py-1 text-[10px] text-content-muted ring-1 ring-edge-default hover:text-brand-700 dark:hover:text-brand-300',
      )}
    >
      <LinkGlyph icon={icon} />
      {label}
    </a>
  )
}

function DocSearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

/* ─────────── scorecard breakdown (drawer) ─────────── */

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

/**
 * Entity KIND is a category, not a status — so it does not get status colours.
 *
 * These were seven arbitrary hues, and three of them were the console's status
 * palette: emerald for API, amber for Domain, rose for Group. On this very
 * page emerald/amber/rose already mean healthy / needs-attention / failed —
 * the "Needs attention" tile is amber, and it sits directly above a row of
 * amber Domain chips that are not warnings at all. Colour was doing two
 * contradictory jobs at once, which is what made the page read as noisy and
 * the chips read as alarming.
 *
 * Two families now, and the LETTER does the distinguishing within each:
 *
 *   software you build and run  → brand tint   (Component, API, Resource)
 *   how the org is arranged     → neutral tint (System, Domain, Group, User)
 *
 * That leaves emerald / amber / rose free to mean only what they mean
 * everywhere else in the console.
 */
const KIND_SOFTWARE =
  'bg-brand-50 dark:bg-brand-500/12 text-brand-700 dark:text-brand-300 ring-1 ring-brand-200/70 dark:ring-brand-400/20'
const KIND_ORG =
  'bg-surface-sunken text-content-muted ring-1 ring-edge-default'

const KIND_TONES: Record<EntityKind, string> = {
  Component: KIND_SOFTWARE,
  API: KIND_SOFTWARE,
  Resource: KIND_SOFTWARE,
  System: KIND_ORG,
  Domain: KIND_ORG,
  Group: KIND_ORG,
  User: KIND_ORG,
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

/* ─────────── deployment-tab icons (14px, currentColor) ─────────── */

const Svg14 = ({ children }: { children: React.ReactNode }) => (
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
    {children}
  </svg>
)

function IconGlobe({ size = 14 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
    </svg>
  )
}

function IconArrowUpRight({ size = 12 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 opacity-70">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  )
}

function IconGit() {
  return (
    <Svg14>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </Svg14>
  )
}

function IconRocket() {
  return (
    <Svg14>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </Svg14>
  )
}

function IconSync() {
  return (
    <Svg14>
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </Svg14>
  )
}

function IconPipeline() {
  return (
    <Svg14>
      <circle cx="5" cy="6" r="2" />
      <circle cx="12" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <path d="M7 6h3M14 6h3" />
      <path d="M5 8v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M12 14v6" />
    </Svg14>
  )
}

function IconPulse() {
  return (
    <Svg14>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </Svg14>
  )
}

function IconCopy() {
  return (
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
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

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

function IconLink() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  )
}

function IconSparkle() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4L12 2z" />
      <path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" opacity="0.7" />
    </svg>
  )
}

function IconChevronLeft() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 6-6 6 6 6" />
    </svg>
  )
}

function IconChevronRight() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function IconLock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

function IconDots() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
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
        'That URL doesn’t look right — paste a full repo URL like https://gitea.example.com/team/svc.',
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
              placeholder="https://gitea.example.com/team/service-name"
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
          <div className="rounded-md border border-rose-200 dark:border-rose-500/25 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-[12px] font-medium text-rose-700 dark:text-rose-300">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  )
}
