import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createFileRoute } from '@tanstack/react-router'
import {
  AppShell,
  Card,
  CardBody,
  CardHeader,
  type Column,
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  Select,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'
import { type EntityKind, parseRef } from '~/data/catalog.ts'
import {
  CATEGORY_LABEL,
  CHECK_CATEGORIES,
  type Check,
  type CheckCategory,
  type Grade,
  SCOREABLE_KINDS,
  type Scorecard,
  useScorecards,
} from '~/data/scorecard.ts'

/**
 * Scorecards — per-service production-readiness scoring.
 *
 * Everything here derives from the same live catalog entities the Service
 * Catalog renders (k8s workloads, Gitea repos, registered entities) through
 * the shared `scoreEntity` engine — one score, one grade, everywhere.
 */

export const Route = createFileRoute('/scorecards')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Scorecards · Adhar Console' }] }),
  component: ScorecardsPage,
})

function ScorecardsPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
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
type SortKey = 'score-asc' | 'score-desc' | 'name' | 'owner'

function ScorecardsDashboard() {
  const { scorecards, isLoading, offline, live } = useScorecards()
  const [grade, setGrade] = useState<GradeFilter>('all')
  const [kind, setKind] = useState<KindFilter>('all')
  const [category, setCategory] = useState<CategoryFilter>('all')
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

  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase()
    const out = scorecards.filter((s) => {
      if (grade !== 'all' && s.grade !== grade) return false
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
  }, [scorecards, grade, kind, category, sort, query])

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
          ) : (
            <span className="text-[12px] text-amber-700 dark:text-amber-300">no owner</span>
          ),
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

  const filtering = grade !== 'all' || kind !== 'all' || category !== 'all' || query.trim() !== ''

  return (
    <>
      <PageHeader
        title="Scorecards"
        badge={
          !isLoading && scorecards.length ? (
            <StatusBadge kind={live ? 'healthy' : offline ? 'paused' : 'info'}>
              {live ? 'live catalog' : offline ? 'sample data' : 'registered only'}
            </StatusBadge>
          ) : null
        }
        description="Production-readiness grading for every service in the catalog — ownership, delivery, reliability, security, and observability checks derived from the entity's real metadata."
      />

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
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
        {GRADES.map((g) => (
          <GradeTile
            key={g}
            grade={g}
            count={distribution[g]}
            active={grade === g}
            onToggle={() => setGrade((cur) => (cur === g ? 'all' : g))}
          />
        ))}
        <SummaryTile
          label="Passing (A/B)"
          value={String(distribution.A + distribution.B)}
          sub={
            scorecards.length
              ? `${Math.round(((distribution.A + distribution.B) / scorecards.length) * 100)}% of fleet`
              : '—'
          }
        />
      </section>

      {scorecards.length ? (
        <section
          aria-label="Fleet readiness by category"
          className="mb-6 grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5"
        >
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
              </button>
            )
          })}
        </section>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-64">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search service, ref, or owner…"
            aria-label="Search scorecards"
            className="h-9 py-0 text-[13px]"
          />
        </div>
        <Select
          aria-label="Filter by grade"
          value={grade}
          onChange={(e) => setGrade(e.target.value as GradeFilter)}
          className="h-9 w-auto py-0 text-[13px]"
          options={[
            { value: 'all', label: 'All grades' },
            ...GRADES.map((g) => ({ value: g, label: `Grade ${g}` })),
          ]}
        />
        <Select
          aria-label="Filter by kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as KindFilter)}
          className="h-9 w-auto py-0 text-[13px]"
          options={[
            { value: 'all', label: 'All kinds' },
            ...SCOREABLE_KINDS.map((k) => ({ value: k, label: k })),
          ]}
        />
        <Select
          aria-label="Filter by category gap"
          value={category}
          onChange={(e) => setCategory(e.target.value as CategoryFilter)}
          className="h-9 w-auto py-0 text-[13px]"
          options={[
            { value: 'all', label: 'All categories' },
            ...CHECK_CATEGORIES.map((c) => ({
              value: c,
              label: `Gaps in ${CATEGORY_LABEL[c]}`,
            })),
          ]}
        />
        <Select
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="h-9 w-auto py-0 text-[13px]"
          options={[
            { value: 'score-asc', label: 'Worst score first' },
            { value: 'score-desc', label: 'Best score first' },
            { value: 'name', label: 'Name A→Z' },
            { value: 'owner', label: 'Owner A→Z' },
          ]}
        />
        <span aria-live="polite" className="ml-auto text-[11px] tabular-nums text-content-muted">
          {filtered.length} {filtered.length === 1 ? 'service' : 'services'}
          {filtered.length !== scorecards.length ? ` of ${scorecards.length}` : ''}
        </span>
      </div>

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
                : 'Connect a cluster or register entities in the Service Catalog to generate scorecards.'
            }
          />
        }
      />

      {selected ? <ScorecardDrawer card={selected} onClose={() => setSelected(null)} /> : null}
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

function GradeTile({
  grade,
  count,
  active,
  onToggle,
}: {
  grade: Grade
  count: number
  active: boolean
  onToggle(): void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={active ? 'Clear grade filter' : `Show only grade ${grade}`}
      className={cn(
        'rounded-xl border bg-surface-raised px-3 py-2.5 text-left shadow-sm transition-colors',
        active
          ? 'border-brand-400 ring-1 ring-brand-400 dark:border-brand-500/60 dark:ring-brand-500/60'
          : 'border-edge-default hover:border-edge-strong',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <GradeBadge grade={grade} />
        <span className="font-mono text-[20px] font-semibold tabular-nums leading-none text-content">
          {count}
        </span>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-surface-sunken">
        <span className={cn('block h-full rounded-full', GRADE_BAR[grade])} style={{ width: count > 0 ? '100%' : '0%' }} />
      </div>
    </button>
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

function ScorecardDrawer({ card, onClose }: { card: Scorecard; onClose(): void }) {
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
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
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
                <StatusBadge kind={failing.length ? 'degraded' : 'healthy'}>
                  {failing.length
                    ? `${failing.length} ${failing.length === 1 ? 'check' : 'checks'} failing`
                    : 'all checks passing'}
                </StatusBadge>
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

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}
