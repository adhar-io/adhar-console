import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  AppShell,
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  type Column,
  DataTable,
  EmptyState,
  type Facet,
  type FacetValues,
  FilterBar,
  PageHeader,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { PENDING_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'
import { type EntityKind, parseRef } from '~/data/catalog.ts'
import {
  CATEGORY_LABEL,
  CHECK_CATEGORIES,
  type Check,
  type CheckCategory,
  type Grade,
  PLATFORM_CATEGORIES,
  PLATFORM_CATEGORY_LABEL,
  type PlatformScorecardsState,
  type PlatformService,
  platformCategoryAverages,
  platformSignalLabel,
  averageTrend,
  rerunMessage,
  rerunScorecards,
  SCORE_SOURCE_LABEL,
  SCOREABLE_KINDS,
  type Scorecard,
  type ScoreSource,
  type ScorecardHistoryEntry,
  serviceTrend,
  useLiveScorecards,
  useScorecardHistory,
} from '~/data/scorecard.ts'

/**
 * Scorecards — per-service production-readiness scoring.
 *
 * Two scorers feed this page and the source of every number is stated on it:
 *
 *   • **platform scorer** (authoritative) — the `application/scorecards`
 *     package's in-cluster CronJob grades each service from signals only the
 *     cluster can see (Argo CD health/sync, probes + requests/limits, image not
 *     `:latest`, Kyverno pass rate, HTTPRoute exposure, backup coverage) and
 *     publishes `adhar-system/adhar-scorecards`. Read via `GET /api/scorecards`.
 *   • **catalog-derived** (fallback) — the console's own `scoreEntity` engine
 *     over the live catalog entity's real metadata, for services the scorer has
 *     not graded (or when the package is not installed).
 *
 * When the ConfigMap is absent the page says so and explains how to enable the
 * package; it never shows a platform grade it did not receive.
 */

export const Route = createFileRoute('/scorecards')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Scorecards · Adhar Console' }] }),
  component: ScorecardsPage,
})

function ScorecardsPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? PENDING_USER
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Scorecards' }]}
      notifications={notifications}
      contentWidth="full"
    >
      <ScorecardsDashboard />
    </AppShell>
  )
}

/* ─────────── dashboard ─────────── */

const GRADES: readonly Grade[] = ['A', 'B', 'C', 'D', 'F']

type GradeFilter = 'all' | Grade
type KindFilter = 'all' | EntityKind
type CategoryFilter = 'all' | CheckCategory
type SourceFilter = 'all' | ScoreSource
type SortKey = 'score-asc' | 'score-desc' | 'name' | 'owner'

/*
 * The filters as FilterBar facets — one row, applied state shown as chips,
 * instead of four `<select>`s whose current values were invisible once
 * collapsed. Every facet is single-select because each maps to one query.
 */
const FACETS: Facet[] = [
  { id: 'grade', label: 'Grade', kind: 'single', options: GRADES.map((g) => ({ value: g, label: `Grade ${g}` })) },
  { id: 'kind', label: 'Kind', kind: 'single', options: SCOREABLE_KINDS.map((k) => ({ value: k, label: k })) },
  {
    id: 'source',
    label: 'Scored by',
    kind: 'single',
    options: [
      { value: 'platform', label: 'Platform scorer' },
      { value: 'catalog', label: 'Catalog-derived' },
    ],
  },
  {
    id: 'category',
    label: 'Gaps in',
    kind: 'single',
    options: CHECK_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
  },
]

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'score-asc', label: 'Worst score first' },
  { value: 'score-desc', label: 'Best score first' },
  { value: 'name', label: 'Name A→Z' },
  { value: 'owner', label: 'Owner A→Z' },
]

function ScorecardsDashboard() {
  const { scorecards, isLoading, offline, live, platform } = useLiveScorecards()
  // The scorer's rolling series. A single score answers "how are we doing"; only
  // a series answers "are we getting better", which is the question a readiness
  // programme is actually run to answer.
  const history = useScorecardHistory()
  const historyEntries = history.data?.entries ?? []
  const queryClient = useQueryClient()
  const [grade, setGrade] = useState<GradeFilter>('all')
  const [kind, setKind] = useState<KindFilter>('all')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [source, setSource] = useState<SourceFilter>('all')
  const [sort, setSort] = useState<SortKey>('score-asc')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Scorecard | null>(null)

  const distribution = useMemo(() => {
    const out: Record<Grade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 }
    for (const s of scorecards) out[s.grade]++
    return out
  }, [scorecards])

  const average = useMemo(
    () =>
      scorecards.length
        ? Math.round(scorecards.reduce((sum, s) => sum + s.score, 0) / scorecards.length)
        : 0,
    [scorecards],
  )

  const weakestCategory = useMemo(() => {
    let worst: { cat: CheckCategory; score: number } | null = null
    for (const cat of CHECK_CATEGORIES) {
      const applicable = scorecards.filter((s) => s.byCategory[cat].total > 0)
      if (!applicable.length) continue
      const avg = Math.round(
        applicable.reduce((sum, s) => sum + s.byCategory[cat].score, 0) / applicable.length,
      )
      if (!worst || avg < worst.score) worst = { cat, score: avg }
    }
    return worst
  }, [scorecards])

  // Fleet-wide average readiness per category (over entities where the category
  // applies) — the at-a-glance "where is the platform weakest" view.
  const categoryAverages = useMemo(
    () =>
      CHECK_CATEGORIES.map((cat) => {
        const applicable = scorecards.filter((s) => s.byCategory[cat].total > 0)
        const score = applicable.length
          ? Math.round(
              applicable.reduce((sum, s) => sum + s.byCategory[cat].score, 0) / applicable.length,
            )
          : null
        return { cat, score, count: applicable.length }
      }),
    [scorecards],
  )

  // Fleet averages from the PLATFORM scorer's own categories — a different,
  // in-cluster view than the catalog-derived categories above.
  const platformAverages = useMemo(() => platformCategoryAverages(scorecards), [scorecards])

  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase()
    const out = scorecards.filter((s) => {
      if (grade !== 'all' && s.grade !== grade) return false
      if (source !== 'all' && s.source !== source) return false
      if (kind !== 'all' && s.entity.kind !== kind) return false
      if (category !== 'all') {
        const bucket = s.byCategory[category]
        // "Filter by category" surfaces services with GAPS in that category.
        if (bucket.total === 0 || bucket.pass === bucket.total) return false
      }
      if (!lower) return true
      const e = s.entity
      return (
        e.metadata.name.toLowerCase().includes(lower) ||
        (e.metadata.title ?? '').toLowerCase().includes(lower) ||
        s.entityRef.toLowerCase().includes(lower) ||
        (e.spec.owner ? parseRef(e.spec.owner).name.toLowerCase().includes(lower) : false)
      )
    })
    return sortCards(out, sort)
  }, [scorecards, grade, kind, category, source, sort, query])

  const columns = useMemo<Column<Scorecard>[]>(
    () => [
      {
        key: 'service',
        header: 'Service',
        cell: (s) => (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-content">
              {s.entity.metadata.title ?? s.entity.metadata.name}
            </div>
            <div className="truncate font-mono text-[11px] text-content-subtle">{s.entityRef}</div>
          </div>
        ),
      },
      {
        key: 'kind',
        header: 'Kind',
        width: 130,
        cell: (s) => (
          <span className="text-[12px] text-content-muted">
            {s.entity.kind}
            {s.entity.spec.type ? (
              <span className="text-content-subtle"> · {s.entity.spec.type}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'owner',
        header: 'Owner',
        width: 140,
        cell: (s) =>
          s.entity.spec.owner ? (
            <span className="text-[12px] font-medium text-content">
              {parseRef(s.entity.spec.owner).name}
            </span>
          ) : s.platformOnly ? (
            // Scored by the platform, absent from the catalog — "no owner" would
            // be a claim we cannot make, so say what we actually know.
            <span className="text-[12px] text-content-subtle">not in catalog</span>
          ) : (
            <span className="text-[12px] text-amber-700 dark:text-amber-300">no owner</span>
          ),
      },
      {
        key: 'source',
        header: 'Scored by',
        width: 130,
        cell: (s) => <SourceBadge source={s.source} />,
      },
      {
        key: 'score',
        header: 'Score',
        numeric: true,
        width: 70,
        cell: (s) => <span className={scoreTextTone(s.score)}>{s.score}</span>,
      },
      {
        key: 'grade',
        header: 'Grade',
        align: 'center',
        width: 70,
        cell: (s) => <GradeBadge grade={s.grade} />,
      },
      {
        key: 'categories',
        header: 'Categories',
        width: 170,
        cell: (s) => <CategoryBars card={s} />,
      },
      {
        key: 'failing',
        header: 'Failing',
        numeric: true,
        width: 80,
        cell: (s) => {
          // No catalog entity → no derived checks were run. "0 failing" would
          // read as "everything passes"; the truth is "nothing was checked".
          if (!s.checks.length) {
            return <span className="text-content-subtle" title="No catalog checks apply">—</span>
          }
          const failing = s.checks.filter((c) => !c.pass).length
          return failing === 0 ? (
            <span className="text-emerald-700 dark:text-emerald-300">0</span>
          ) : (
            <span className="text-content-muted">{failing}</span>
          )
        },
      },
    ],
    [],
  )

  const filtering =
    grade !== 'all' || kind !== 'all' || category !== 'all' || source !== 'all' || query.trim() !== ''

  const facetValues = useMemo<FacetValues>(() => ({
    ...(grade !== 'all' ? { grade: [grade] } : {}),
    ...(kind !== 'all' ? { kind: [kind] } : {}),
    ...(source !== 'all' ? { source: [source] } : {}),
    ...(category !== 'all' ? { category: [category] } : {}),
  }), [grade, kind, source, category])
  const onFacetValues = (next: FacetValues) => {
    setGrade((next.grade?.[0] as Grade | undefined) ?? 'all')
    setKind((next.kind?.[0] as EntityKind | undefined) ?? 'all')
    setSource((next.source?.[0] as ScoreSource | undefined) ?? 'all')
    setCategory((next.category?.[0] as CheckCategory | undefined) ?? 'all')
  }

  return (
    <>
      <PageHeader
        title="Scorecards"
        badge={
          <span className="flex flex-wrap items-center gap-1.5">
            {platform.configured ? (
              <StatusBadge kind="healthy">platform scorer</StatusBadge>
            ) : platform.isLoading ? null : (
              <StatusBadge kind="paused">catalog-derived only</StatusBadge>
            )}
            {!isLoading && scorecards.length ? (
              <StatusBadge kind={live ? 'healthy' : offline ? 'paused' : 'info'}>
                {live ? 'live catalog' : offline ? 'sample data' : 'registered only'}
              </StatusBadge>
            ) : null}
          </span>
        }
        description={
          platform.configured
            ? "Production-readiness grading. Scores come from the platform's in-cluster scorer (Argo CD health/sync, probes + resources, image tags, Kyverno pass rate, exposure, backups); services it hasn't graded fall back to checks derived from the catalog entity's real metadata."
            : "Production-readiness grading for every service in the catalog — ownership, delivery, reliability, security, and observability checks derived from the entity's real metadata."
        }
      />

      <PlatformStrip
        platform={platform}
        averages={platformAverages}
        history={historyEntries}
        // One invalidation covers both queries: the history key is nested under
        // the same ['platform-scorecards'] prefix, so a finished run refreshes
        // the score and the trend together rather than leaving them disagreeing.
        onRefetch={() => void queryClient.invalidateQueries({ queryKey: ['platform-scorecards'] })}
      />

      {/*
        Three numbers and one picture. Eight equal tiles put "Services scored"
        and "Grade D: 0" at the same visual weight; the grades are one
        distribution, so they get one tile with a stacked bar and the five
        counts as filters under it.
      */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,2.3fr)]">
        <SummaryTile
          label="Services scored"
          value={String(scorecards.length)}
          sub={`${SCOREABLE_KINDS.join(' · ')}`}
        />
        <SummaryTile
          label="Average score"
          value={String(average)}
          sub={weakestCategory ? `Weakest: ${CATEGORY_LABEL[weakestCategory.cat]}` : '—'}
          tone={scoreTextTone(average)}
        />
        <SummaryTile
          label="Passing (A/B)"
          value={String(distribution.A + distribution.B)}
          sub={
            scorecards.length
              ? `${Math.round(((distribution.A + distribution.B) / scorecards.length) * 100)}% of fleet`
              : '—'
          }
        />
        <GradeDistribution
          distribution={distribution}
          total={scorecards.length}
          active={grade}
          onToggle={(g) => setGrade((cur) => (cur === g ? 'all' : g))}
        />
      </section>

      {scorecards.length ? (
        <section
          aria-label="Fleet readiness by category"
          className="mb-6 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm"
        >
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-content-subtle">
              Fleet readiness by category
            </h2>
            <span className="text-[11px] text-content-subtle">
              Average across services where the category applies · click one to see the services with gaps
            </span>
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
          {categoryAverages.map(({ cat, score, count }) => {
            const on = category === cat
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory((cur) => (cur === cat ? 'all' : cat))}
                aria-pressed={on}
                title={`Filter to services with gaps in ${CATEGORY_LABEL[cat]}`}
                className={cn(
                  'group flex flex-col gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                  on ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken',
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12px] font-medium text-content-muted group-hover:text-content">
                    {CATEGORY_LABEL[cat]}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-[13px] font-semibold tabular-nums',
                      score === null ? 'text-content-subtle' : scoreTextTone(score),
                    )}
                  >
                    {score === null ? '—' : score}
                  </span>
                </div>
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <span
                    className={cn('block h-full rounded-full transition-all', barTone(score ?? 0))}
                    style={{ width: `${score ?? 0}%` }}
                  />
                </span>
                <span className="text-[10px] text-content-subtle">
                  {count} {count === 1 ? 'service' : 'services'}
                </span>
              </button>
            )
          })}
          </div>
        </section>
      ) : null}

      <FilterBar<never, SortKey>
        className="mb-3"
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search service, ref, or owner…',
          label: 'Search scorecards',
        }}
        facets={FACETS}
        values={facetValues}
        onValuesChange={onFacetValues}
        sort={{ value: sort, onChange: setSort, options: SORTS }}
        loading={isLoading && !scorecards.length}
        summary={
          <span aria-live="polite">
            {filtered.length} {filtered.length === 1 ? 'service' : 'services'}
            {filtered.length !== scorecards.length ? ` of ${scorecards.length}` : ''}
          </span>
        }
      />

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(s) => s.entityRef}
        onRowClick={setSelected}
        loading={isLoading}
        dense
        empty={
          <EmptyState
            title={filtering ? 'No matching services' : 'Nothing to score yet'}
            description={
              filtering
                ? 'No scorecard matches the current filters — clear them to see the full fleet.'
                : platform.configured
                  ? 'The platform scorer has not graded any service yet, and no catalog entity is scoreable. Connect a cluster or register entities in the Service Catalog.'
                  : `Enable the "scorecards" package to get authoritative in-cluster grading (it publishes ${platform.namespace}/${platform.configMap}), or connect a cluster / register entities in the Service Catalog for catalog-derived scores.`
            }
          />
        }
      />

      {selected
        ? (
          <ScorecardDrawer
            card={selected}
            history={historyEntries}
            onClose={() => setSelected(null)}
          />
        )
        : null}
    </>
  )
}

function sortCards(cards: Scorecard[], by: SortKey): Scorecard[] {
  const name = (s: Scorecard) => s.entity.metadata.title ?? s.entity.metadata.name
  const owner = (s: Scorecard) => (s.entity.spec.owner ? parseRef(s.entity.spec.owner).name : '~')
  const out = [...cards]
  if (by === 'score-asc') out.sort((a, b) => a.score - b.score || name(a).localeCompare(name(b)))
  else if (by === 'score-desc') {
    out.sort((a, b) => b.score - a.score || name(a).localeCompare(name(b)))
  } else if (by === 'name') out.sort((a, b) => name(a).localeCompare(name(b)))
  else out.sort((a, b) => owner(a).localeCompare(owner(b)) || a.score - b.score)
  return out
}

/* ─────────── tones ─────────── */

const GRADE_TONE: Record<Grade, string> = {
  A: 'bg-emerald-50 text-emerald-700 ring-emerald-600/25 dark:bg-emerald-500/10 dark:text-emerald-300',
  B: 'bg-sky-50 text-sky-700 ring-sky-600/25 dark:bg-sky-500/10 dark:text-sky-300',
  C: 'bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-300',
  D: 'bg-orange-50 text-orange-800 ring-orange-600/25 dark:bg-orange-500/10 dark:text-orange-300',
  F: 'bg-rose-50 text-rose-700 ring-rose-600/25 dark:bg-rose-500/10 dark:text-rose-300',
}

const GRADE_BAR: Record<Grade, string> = {
  A: 'bg-emerald-500',
  B: 'bg-sky-500',
  C: 'bg-amber-500',
  D: 'bg-orange-500',
  F: 'bg-rose-500',
}

function GradeBadge({ grade, size = 'sm' }: { grade: Grade; size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-label={`Grade ${grade}`}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-mono font-bold ring-1 ring-inset',
        size === 'lg' ? 'h-9 w-9 text-[16px]' : 'h-6 w-6 text-[12px]',
        GRADE_TONE[grade],
      )}
    >
      {grade}
    </span>
  )
}

function scoreTextTone(score: number): string {
  if (score >= 80) return 'text-emerald-700 dark:text-emerald-300'
  if (score >= 50) return 'text-amber-800 dark:text-amber-300'
  return 'text-rose-700 dark:text-rose-300'
}

function barTone(score: number): string {
  if (score >= 80) return 'bg-emerald-500'
  if (score >= 50) return 'bg-amber-500'
  return 'bg-rose-500'
}

/* ─────────── summary tiles ─────────── */

function SummaryTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: string
}) {
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {label}
      </div>
      <div className={cn('mt-1 font-mono text-[20px] font-semibold tabular-nums leading-none', tone ?? 'text-content')}>
        {value}
      </div>
      {sub ? <div className="mt-1 truncate text-[10px] text-content-muted">{sub}</div> : null}
    </div>
  )
}

/**
 * The grade distribution as one picture: a stacked bar in grade order, and
 * the five counts under it, each a filter. Replaces five separate tiles that
 * each showed a number with no sense of proportion.
 */
function GradeDistribution({
  distribution,
  total,
  active,
  onToggle,
}: {
  distribution: Record<Grade, number>
  total: number
  active: GradeFilter
  onToggle(g: Grade): void
}) {
  return (
    <div className="col-span-2 rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5 shadow-sm sm:col-span-3 lg:col-span-1">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          Grade distribution
        </div>
        {active !== 'all' ? (
          <button
            type="button"
            onClick={() => onToggle(active)}
            className="text-[10px] font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            Clear grade filter
          </button>
        ) : null}
      </div>
      <div
        className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={GRADES.map((g) => `${g}: ${distribution[g]}`).join(', ')}
      >
        {total > 0
          ? GRADES.map((g) =>
              distribution[g] > 0 ? (
                <span
                  key={g}
                  className={cn('h-full transition-[width] duration-300', GRADE_BAR[g])}
                  style={{ width: `${(distribution[g] / total) * 100}%` }}
                />
              ) : null,
            )
          : null}
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1">
        {GRADES.map((g) => {
          const on = active === g
          return (
            <button
              key={g}
              type="button"
              onClick={() => onToggle(g)}
              aria-pressed={on}
              title={on ? 'Clear grade filter' : `Show only grade ${g}`}
              className={cn(
                'flex items-center justify-between gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors',
                on ? 'bg-brand-50 ring-1 ring-brand-400 dark:bg-brand-500/10 dark:ring-brand-500/60' : 'hover:bg-surface-sunken',
              )}
            >
              <GradeBadge grade={g} />
              <span
                className={cn(
                  'font-mono text-[13px] font-semibold tabular-nums',
                  distribution[g] ? 'text-content' : 'text-content-subtle',
                )}
              >
                {distribution[g]}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ─────────── category mini-bars ─────────── */

function CategoryBars({ card }: { card: Scorecard }) {
  return (
    <div className="flex items-center gap-1">
      {CHECK_CATEGORIES.map((cat) => {
        const b = card.byCategory[cat]
        const na = b.total === 0
        return (
          <span
            key={cat}
            title={
              na
                ? `${CATEGORY_LABEL[cat]}: not applicable`
                : `${CATEGORY_LABEL[cat]}: ${b.score}% (${b.pass}/${b.total} checks)`
            }
            className="h-4 w-6 overflow-hidden rounded-sm bg-surface-sunken ring-1 ring-inset ring-edge-subtle"
          >
            {na ? null : (
              <span
                className={cn('block w-full', barTone(b.score))}
                style={{ height: '100%', opacity: Math.max(0.25, b.score / 100) }}
              />
            )}
          </span>
        )
      })}
    </div>
  )
}

/* ─────────── drawer: full check breakdown ─────────── */

function ScorecardDrawer({
  card,
  history,
  onClose,
}: {
  card: Scorecard
  history: ScorecardHistoryEntry[]
  onClose(): void
}) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const failing = card.checks.filter((c) => !c.pass)
  const topFixes = [...failing].sort((a, b) => b.weight - a.weight).slice(0, 3)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const previouslyFocused =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    closeBtnRef.current?.focus()
    return () => previouslyFocused?.focus?.()
  }, [])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <GradeBadge grade={card.grade} size="lg" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-content">
                {card.entity.metadata.title ?? card.entity.metadata.name}
              </h2>
              <div className="mt-0.5 font-mono text-[11px] text-content-muted">{card.entityRef}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
                <span className={cn('font-mono font-semibold tabular-nums', scoreTextTone(card.score))}>
                  {card.score}/100
                </span>
                <SourceBadge source={card.source} />
                {card.checks.length ? (
                  <StatusBadge kind={failing.length ? 'degraded' : 'healthy'}>
                    {failing.length
                      ? `${failing.length} ${failing.length === 1 ? 'check' : 'checks'} failing`
                      : 'all checks passing'}
                  </StatusBadge>
                ) : null}
                {card.entity.spec.owner ? (
                  <span>owner: {parseRef(card.entity.spec.owner).name}</span>
                ) : null}
              </div>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {card.platform ? <PlatformPanel service={card.platform} card={card} /> : null}
          {card.platform ? <ScoreHistoryCard service={card.platform.name} history={history} /> : null}

          {topFixes.length ? (
            <Card>
              <CardHeader>
                <h3 className="text-sm font-semibold text-content">How to improve</h3>
              </CardHeader>
              <CardBody className="space-y-2.5">
                {topFixes.map((c) => (
                  <div key={c.id} className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30">
                      <IconAlert />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-content">
                        {c.label}
                        <span className="ml-1.5 font-mono text-[10px] text-content-subtle">
                          +{c.weight} pts
                        </span>
                      </div>
                      {c.hint ? (
                        <div className="mt-0.5 text-[11px] leading-relaxed text-content-muted">
                          {c.hint}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </CardBody>
            </Card>
          ) : null}

          {CHECK_CATEGORIES.map((cat) => {
            const bucket = card.byCategory[cat]
            if (bucket.total === 0) return null
            const checks = card.checks.filter((c) => c.category === cat)
            return (
              <Card key={cat}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-content">{CATEGORY_LABEL[cat]}</h3>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] tabular-nums text-content-muted">
                        {bucket.pass}/{bucket.total}
                      </span>
                      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken">
                        <span
                          className={cn('block h-full rounded-full', barTone(bucket.score))}
                          style={{ width: `${bucket.score}%` }}
                        />
                      </span>
                      <span
                        className={cn('font-mono text-[11px] font-semibold tabular-nums', scoreTextTone(bucket.score))}
                      >
                        {bucket.score}%
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardBody className="divide-y divide-edge-subtle">
                  {checks.map((c) => (
                    <CheckRow key={c.id} check={c} />
                  ))}
                </CardBody>
              </Card>
            )
          })}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function CheckRow({ check }: { check: Check }) {
  return (
    <div className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
      <span
        className={cn(
          'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1',
          check.pass
            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30'
            : 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
        )}
      >
        {check.pass ? <IconCheck /> : <IconX />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-medium text-content">{check.label}</span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-content-subtle">
            weight {check.weight}
          </span>
        </div>
        {check.detail ? (
          <div className="mt-0.5 break-all text-[11px] text-content-muted">{check.detail}</div>
        ) : null}
        {!check.pass && check.hint ? (
          <div className="mt-1 rounded-md bg-surface-sunken px-2 py-1 text-[11px] leading-relaxed text-content-muted">
            <span className="font-semibold text-content">Fix:</span> {check.hint}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ─────────── platform scorer surface ─────────── */

function SourceBadge({ source }: { source: ScoreSource }) {
  const platform = source === 'platform'
  return (
    <span
      title={
        platform
          ? 'Graded by the platform scorer (in-cluster signals: Argo CD health/sync, probes, resources, image tags, Kyverno, exposure, backups)'
          : "Derived by the console from the catalog entity's own metadata — the platform scorer has not graded this service"
      }
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
        platform
          ? 'bg-brand-50 text-brand-700 ring-brand-600/20 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/30'
          : 'bg-surface-sunken text-content-muted ring-edge-subtle',
      )}
    >
      {SCORE_SOURCE_LABEL[source]}
    </span>
  )
}

/** "3 minutes ago" for the scorer's last run — absolute value stays in `title`. */
function formatWhen(iso: string | undefined): { label: string; title: string } | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return { label: iso, title: iso }
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000))
  const label =
    mins < 1 ? 'just now'
    : mins < 60 ? `${mins} min ago`
    : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago`
    : `${Math.round(mins / (60 * 24))} d ago`
  return { label, title: new Date(t).toLocaleString() }
}

/**
 * The platform scorer's own header strip: its per-category fleet averages and
 * weights, when it last ran, and — when its ConfigMap is absent — exactly how
 * to turn it on. No numbers are shown unless the scorer published them.
 */
function PlatformStrip({
  platform,
  averages,
  history,
  onRefetch,
}: {
  platform: PlatformScorecardsState
  averages: Array<{ cat: (typeof PLATFORM_CATEGORIES)[number]; score: number | null; count: number }>
  history: ScorecardHistoryEntry[]
  onRefetch(): void
}) {
  if (platform.isLoading && !platform.configured) return null

  if (!platform.configured) {
    return (
      <section className="mb-6 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
        <div className="flex items-start gap-3">
          {/* Information, not a warning: the page still works, it is just
              scoring from a different source. */}
          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 ring-1 ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/30">
            <IconAlert />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-content">
              Platform scorer not available — showing catalog-derived scores
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-content-muted">
              Enable the <span className="font-mono text-content">scorecards</span> package
              (Marketplace → Application) to grade services from real in-cluster signals — Argo CD
              health and sync, readiness/liveness probes, resource requests and limits, container
              images that are not <span className="font-mono">:latest</span>, Kyverno policy-report
              pass rate, HTTPRoute exposure and backup coverage. Its CronJob publishes{' '}
              <span className="font-mono text-content">
                {platform.namespace}/{platform.configMap}
              </span>{' '}
              every 30 minutes; the console reads it the moment it appears.
            </p>
            {platform.error && platform.error !== 'not_installed' ? (
              <p className="mt-1.5 rounded-md bg-surface-sunken px-2 py-1 font-mono text-[10px] text-content-muted">
                {platform.error}
                {platform.detail ? `: ${platform.detail}` : ''}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    )
  }

  const when = formatWhen(platform.lastRun)
  const trend = averageTrend(history)
  const weightTotal = platform.weights
    ? PLATFORM_CATEGORIES.reduce((sum, c) => sum + (platform.weights?.[c] ?? 0), 0)
    : 0

  return (
    <section
      aria-label="Platform scorer"
      className="mb-6 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-[13px] font-semibold text-content">Platform scorer</h2>
          <span className="text-[11px] text-content-muted">
            {platform.serviceCount} {platform.serviceCount === 1 ? 'service' : 'services'} graded
            {platform.matched ? ` · ${platform.matched} matched to the catalog` : ''}
            {typeof platform.averageScore === 'number' ? ' · avg ' : ''}
          </span>
          {typeof platform.averageScore === 'number' ? (
            <span className={cn('font-mono text-[12px] font-semibold tabular-nums', scoreTextTone(platform.averageScore))}>
              {platform.averageScore}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <TrendChip trend={trend} runs={history.length} label="platform average" />
          <span className="text-[11px] text-content-subtle" title={when?.title}>
            {when ? `last run ${when.label}` : 'last run unknown'}
            {platform.gradeThresholds
              ? ` · A ≥ ${platform.gradeThresholds.A} · B ≥ ${platform.gradeThresholds.B} · C ≥ ${platform.gradeThresholds.C} · D ≥ ${platform.gradeThresholds.D}`
              : ''}
          </span>
          <RerunButton onDone={onRefetch} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {averages.map(({ cat, score, count }) => {
          const weight = platform.weights?.[cat]
          return (
            <div key={cat} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[12px] font-medium text-content-muted">
                  {PLATFORM_CATEGORY_LABEL[cat]}
                  {weight !== undefined && weightTotal > 0 ? (
                    <span className="ml-1 font-mono text-[10px] text-content-subtle">
                      {Math.round((weight / weightTotal) * 100)}%
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    'font-mono text-[13px] font-semibold tabular-nums',
                    score === null ? 'text-content-subtle' : scoreTextTone(score),
                  )}
                  title={count ? `${count} scored ${count === 1 ? 'service' : 'services'}` : 'no data'}
                >
                  {score === null ? '—' : score}
                </span>
              </div>
              <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                <span
                  className={cn('block h-full rounded-full transition-all', barTone(score ?? 0))}
                  style={{ width: `${score ?? 0}%` }}
                />
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Run the scorer now.
 *
 * The scorer's schedule is every 30 minutes, which is right for a background
 * grade and wrong for the moment someone has just fixed a probe and wants to see
 * the score move. Without this the only options were to wait or to go and create
 * a Job by hand.
 *
 * The button reports what actually happened rather than optimistically claiming
 * success: a run already in flight, a namespace the user cannot create Jobs in
 * and a missing package are three different answers and each is actionable.
 */
function RerunButton({ onDone }: { onDone(): void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // The job takes about a minute; poll a few times so the new score arrives
  // without the user reloading. Cleared on unmount so a navigation mid-run does
  // not keep firing invalidations at a page that is gone.
  const timers = useRef<number[]>([])
  useEffect(() => () => {
    for (const t of timers.current) clearTimeout(t)
  }, [])

  const run = async () => {
    setBusy(true)
    setMsg(null)
    const res = await rerunScorecards()
    setBusy(false)
    setMsg({ ok: res.started, text: rerunMessage(res) })
    if (res.started) {
      for (const delay of [20_000, 45_000, 75_000]) {
        timers.current.push(setTimeout(onDone, delay) as unknown as number)
      }
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2.5 py-1.5',
          'text-[11px] font-medium text-content-muted shadow-sm transition-colors',
          'hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
        title="Create a Job from the scorer CronJob and grade every service now"
      >
        <IconRefresh spinning={busy} />
        {busy ? 'Starting…' : 'Re-evaluate'}
      </button>
      {msg ? (
        <span
          role="status"
          className={cn(
            'text-[11px]',
            msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300',
          )}
        >
          {msg.text}
        </span>
      ) : null}
    </div>
  )
}

/**
 * A score and where it is heading.
 *
 * The delta is the point, not the sparkline: "72" tells nobody whether the last
 * fortnight of work helped. `runs` is shown because a two-run series is not a
 * trend and the reader deserves to know which they are looking at.
 */
function TrendChip({
  trend,
  runs,
  label,
  compact = false,
}: {
  trend: { points: number[]; delta?: number; last?: number }
  runs: number
  label: string
  compact?: boolean
}) {
  if (trend.points.length < 2) return null
  const delta = trend.delta ?? 0
  const rising = delta > 0
  const flat = delta === 0
  return (
    <span
      className="inline-flex items-center gap-2"
      title={`${label}: ${trend.points.length} of ${runs} retained runs · ${
        flat ? 'no change' : `${rising ? '+' : ''}${delta} points`
      }`}
    >
      <span className={cn('inline-block', compact ? 'h-4 w-12' : 'h-5 w-20')}>
        <AreaChart
          points={trend.points}
          color={flat ? 'var(--color-content-subtle)' : rising ? 'var(--color-emerald-500)' : 'var(--color-rose-500)'}
          height={compact ? 16 : 20}
          showAxis={false}
        />
      </span>
      <span
        className={cn(
          'font-mono text-[11px] font-semibold tabular-nums',
          flat
            ? 'text-content-subtle'
            : rising
            ? 'text-emerald-700 dark:text-emerald-300'
            : 'text-rose-700 dark:text-rose-300',
        )}
      >
        {flat ? '±0' : `${rising ? '+' : ''}${delta}`}
      </span>
    </span>
  )
}

function IconRefresh({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden
      className={cn('shrink-0', spinning && 'animate-spin motion-reduce:animate-none')}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  )
}

/**
 * What this service's score has done over the retained window.
 *
 * A grade on its own invites an argument about whether it is fair. A grade next
 * to its own history turns the conversation into "this went from D to B when we
 * added probes", which is the only version of the conversation that changes
 * anything.
 *
 * Runs are listed newest first with the score at each, because the common
 * question is "when did this drop?" and that is answered by reading downward
 * until the number changes.
 */
function ScoreHistoryCard({
  service,
  history,
}: {
  service: string
  history: ScorecardHistoryEntry[]
}) {
  const trend = serviceTrend(history, service)
  // With one retained run there is no history to show, and an empty card that
  // explains itself is better than a chart of a single point.
  if (trend.points.length < 2) {
    return (
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-content">Score history</h3>
        </CardHeader>
        <CardBody>
          <p className="text-[11px] leading-relaxed text-content-muted">
            {history.length === 0
              ? (
                <>
                  No history yet. The scorer appends each run to{' '}
                  <span className="font-mono text-content">adhar-scorecards-history</span>; a trend
                  appears after its second run.
                </>
              )
              : 'Only one run has scored this service so far — a trend needs two.'}
          </p>
        </CardBody>
      </Card>
    )
  }

  const rows = history
    .filter((e) => e.services[service])
    .slice()
    .reverse()

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-content">Score history</h3>
          <div className="flex items-center gap-3">
            <TrendChip trend={trend} runs={history.length} label={service} />
            <span className="text-[11px] text-content-subtle">
              {rows.length} {rows.length === 1 ? 'run' : 'runs'} retained
            </span>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="h-16 w-full">
          <AreaChart points={trend.points} color="var(--color-brand-500)" height={64} showAxis={false} />
        </div>
        <ol className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
          {rows.map((e, i) => {
            const rec = e.services[service]
            const prev = rows[i + 1]?.services[service]
            const delta = prev ? rec.score - prev.score : undefined
            const when = formatWhen(e.at)
            return (
              <li key={e.at} className="flex items-center gap-3 bg-surface-raised px-3 py-1.5">
                <span className="w-28 shrink-0 text-[11px] text-content-muted" title={when?.title}>
                  {when?.label ?? e.at}
                </span>
                <GradeBadge grade={rec.grade} />
                <span className={cn('w-8 font-mono text-[12px] font-semibold tabular-nums', scoreTextTone(rec.score))}>
                  {rec.score}
                </span>
                <span
                  className={cn(
                    'font-mono text-[11px] tabular-nums',
                    delta === undefined
                      ? 'text-content-subtle'
                      : delta > 0
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : delta < 0
                      ? 'text-rose-700 dark:text-rose-300'
                      : 'text-content-subtle',
                  )}
                  title={delta === undefined ? 'earliest retained run' : 'change from the previous run'}
                >
                  {delta === undefined ? '—' : delta === 0 ? '±0' : `${delta > 0 ? '+' : ''}${delta}`}
                </span>
                <span className="ml-auto block h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken">
                  <span className={cn('block h-full rounded-full', barTone(rec.score))} style={{ width: `${rec.score}%` }} />
                </span>
              </li>
            )
          })}
        </ol>
      </CardBody>
    </Card>
  )
}

/** The scorer's per-service breakdown: categories, then its signal ledger. */
function PlatformPanel({ service, card }: { service: PlatformService; card: Scorecard }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-content">Platform scorer</h3>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
            <span className="font-mono">
              {service.namespace ? `${service.namespace}/` : ''}
              {service.name}
            </span>
            <StatusBadge kind={service.health === 'Healthy' ? 'healthy' : 'degraded'}>
              {service.health}
            </StatusBadge>
            <StatusBadge kind={service.sync === 'Synced' ? 'healthy' : 'info'}>
              {service.sync}
            </StatusBadge>
            {service.stateful ? (
              <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px]">stateful</span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4">
          {PLATFORM_CATEGORIES.map((cat) => {
            const v = service.categories[cat] ?? 0
            return (
              <div key={cat} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[11px] text-content-muted">
                    {PLATFORM_CATEGORY_LABEL[cat]}
                  </span>
                  <span className={cn('font-mono text-[12px] font-semibold tabular-nums', scoreTextTone(v))}>
                    {v}
                  </span>
                </div>
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <span className={cn('block h-full rounded-full', barTone(v))} style={{ width: `${v}%` }} />
                </span>
              </div>
            )
          })}
        </div>

        {service.signals.length ? (
          <div className="divide-y divide-edge-subtle">
            {service.signals.map((sig) => {
              const pct = Math.round(sig.score * 100)
              const passed = sig.applicable && pct >= 100
              return (
                <div key={sig.name} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1',
                      !sig.applicable
                        ? 'bg-surface-sunken text-content-subtle ring-edge-subtle'
                        : passed
                          ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30'
                          : 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
                    )}
                  >
                    {!sig.applicable ? <IconDash /> : passed ? <IconCheck /> : <IconX />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium text-content">
                        {platformSignalLabel(sig.name)}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-content-subtle">
                        {PLATFORM_CATEGORY_LABEL[sig.category]}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-content-muted">
                      {!sig.applicable
                        ? 'Not applicable — dropped from this category, never counted as a failure'
                        : pct >= 100
                          ? 'Pass'
                          : `${pct}%`}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-[11px] text-content-muted">
            The scorer published a grade for this service but no signal breakdown.
          </p>
        )}

        {card.platformOnly ? (
          <p className="rounded-md bg-surface-sunken px-2 py-1 text-[11px] leading-relaxed text-content-muted">
            This service is graded by the platform but is not in the Service Catalog, so no
            ownership / delivery / documentation checks were run. Register it in the catalog (or
            annotate its workload with{' '}
            <span className="font-mono text-content">adhar.io/scorecard: {service.name}</span>) to
            see both scores side by side.
          </p>
        ) : typeof card.derivedScore === 'number' ? (
          <p className="text-[11px] text-content-muted">
            Catalog-derived score for the same service:{' '}
            <span className={cn('font-mono font-semibold tabular-nums', scoreTextTone(card.derivedScore))}>
              {card.derivedScore}
            </span>{' '}
            ({card.derivedGrade}) — a different question (is it owned and documented?), kept
            separate rather than blended.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}

/* ─────────── icons ─────────── */

function IconCheck() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconX() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function IconAlert() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2 15 14H1L8 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.5v3.25M8 11.75v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function IconDash() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 8h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}
