import { useMemo, useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { metabase } from '@adhar-console/api-clients'
import { useCollections, useQuestions } from '../data/bi.ts'
import { CardRender } from './bi-dashboards.tsx'

const DISPLAY_TONE: Record<metabase.ChartType, string> = {
  scalar: 'bg-brand-50 text-brand-700',
  line: 'bg-emerald-50 text-emerald-700',
  area: 'bg-emerald-50 text-emerald-700',
  bar: 'bg-amber-50 text-amber-700',
  pie: 'bg-violet-50 text-violet-700',
  table: 'bg-slate-100 text-slate-700',
  progress: 'bg-sky-50 text-sky-700',
  gauge: 'bg-rose-50 text-rose-700',
}

/**
 * Saved questions / cards. Filterable by collection + display type, with
 * search, and a per-card live chart preview.
 */
export function Questions() {
  const collections = useCollections()
  const questions = useQuestions()
  const [collId, setCollId] = useState<number | 'all'>('all')
  const [display, setDisplay] = useState<'all' | metabase.ChartType>('all')
  const [search, setSearch] = useState('')

  if (questions.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading questions…
      </div>
    )
  }

  const all = questions.data ?? []
  const list = useMemo(() => {
    const f = search.trim().toLowerCase()
    return all
      .filter((q) => collId === 'all' || q.collection_id === collId)
      .filter((q) => display === 'all' || q.display === display)
      .filter((q) => !f || q.name.toLowerCase().includes(f) || (q.description ?? '').toLowerCase().includes(f))
      .sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0))
  }, [all, collId, display, search])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <CollectionTabs
          value={collId}
          onChange={setCollId}
          collections={collections.data ?? []}
          counts={countByCollection(all)}
        />
        <DisplayFilter value={display} onChange={setDisplay} />
        <div className="ml-auto">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search questions…"
            className="block h-9 w-44 rounded-lg border border-edge-default bg-white px-3 py-1 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
          />
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState title="No questions" description="Try a different filter or save a new question in Metabase." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((q) => (
            <QuestionCard key={q.id} q={q} collections={collections.data ?? []} />
          ))}
        </div>
      )}
    </div>
  )
}

function CollectionTabs({
  value,
  onChange,
  collections,
  counts,
}: {
  value: number | 'all'
  onChange(v: number | 'all'): void
  collections: metabase.Collection[]
  counts: Record<string, number>
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
      <button
        type="button"
        onClick={() => onChange('all')}
        className={
          value === 'all'
            ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
            : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
        }
      >
        All
        <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-60">
          {Object.values(counts).reduce((a, b) => a + b, 0)}
        </span>
      </button>
      {collections.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange(c.id)}
          className={
            value === c.id
              ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
              : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
          }
        >
          {c.name}
          <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-60">
            {counts[c.id] ?? 0}
          </span>
        </button>
      ))}
    </div>
  )
}

function DisplayFilter({
  value,
  onChange,
}: {
  value: 'all' | metabase.ChartType
  onChange(v: 'all' | metabase.ChartType): void
}) {
  const items: ('all' | metabase.ChartType)[] = ['all', 'scalar', 'line', 'area', 'bar', 'pie', 'table', 'progress', 'gauge']
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
      {items.map((i) => {
        const on = value === i
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChange(i)}
            className={
              on
                ? 'rounded-md bg-brand-50 px-2 py-1 text-[11px] font-semibold text-brand-700'
                : 'rounded-md px-2 py-1 text-[11px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {i}
          </button>
        )
      })}
    </div>
  )
}

function QuestionCard({
  q,
  collections,
}: {
  q: metabase.Question
  collections: metabase.Collection[]
}) {
  const coll = collections.find((c) => c.id === q.collection_id)
  return (
    <Card>
      <CardHeader className="py-3!">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {coll ? (
                <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-muted">
                  {coll.name}
                </span>
              ) : null}
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${DISPLAY_TONE[q.display]}`}
              >
                {q.display}
              </span>
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-content">{q.name}</div>
            {q.description ? (
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
                {q.description}
              </div>
            ) : null}
          </div>
          {q.view_count ? <StatusBadge kind="info">{q.view_count} views</StatusBadge> : null}
        </div>
      </CardHeader>
      <CardBody className="p-3!">
        <CardRender card={q} />
      </CardBody>
      <div className="border-t border-edge-subtle px-3 py-2 text-[10px] font-mono text-content-subtle">
        updated {q.updated_at ? formatRelative(q.updated_at) : '—'}
      </div>
    </Card>
  )
}

function countByCollection(list: metabase.Question[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const q of list) {
    if (q.collection_id != null) out[q.collection_id] = (out[q.collection_id] ?? 0) + 1
  }
  return out
}
