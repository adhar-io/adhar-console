import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  buildFunnelsQuery,
  type DateRangeId,
  type FunnelBreakdown,
  funnelMath,
  type FunnelSpec,
  funnelSpecFromInsight,
  formatSeconds,
  parseFunnel,
  type SavedInsight,
  useDeleteInsight,
  usePHQuery,
  useSavedInsights,
  useSaveInsight,
  worstStep,
} from '../data/posthog.ts'
import { patchParams, readParam } from '../data/discover-nav.ts'
import { StatTile } from './discover-ui.tsx'
import { Loading, NoData, seriesColor, VizStyle, Widget } from './viz.tsx'
import { BreakdownPicker, EventPicker, FilterBar, fmtNum, fmtPct, OpenInPostHog, PostHogState, RangePicker } from './posthog-ui.tsx'

/**
 * Funnels — build, run and save PostHog funnels.
 *
 * Saved funnels are PostHog insights (`FunnelsQuery`); picking one loads its
 * steps into the editor. Every edit re-runs the FunnelsQuery live, so the
 * ladder always shows what PostHog computes: conversion from the first step
 * and from the previous one, people lost, and average / median time to
 * convert. "Save" writes the insight back to PostHog (new or update).
 */

const EMPTY: FunnelSpec = { steps: [{ event: '$pageview' }, { event: '' }], range: '-30d', windowDays: 14, order: 'ordered' }

export function Funnels() {
  const saved = useSavedInsights('FunnelsQuery')
  const [activeId, setActiveId] = useState<number | null>(() => {
    const p = readParam('funnel')
    return p ? Number(p) : null
  })
  const [spec, setSpec] = useState<FunnelSpec>(EMPTY)
  const [name, setName] = useState('')
  const [dirty, setDirty] = useState(false)
  const active = saved.data?.find((i) => i.id === activeId) ?? null

  // Load a saved funnel into the editor; default to the first one.
  useEffect(() => {
    if (!saved.data) return
    const target = active ?? (activeId == null && !dirty ? saved.data[0] : null)
    if (!target) return
    const s = funnelSpecFromInsight(target)
    if (s) {
      setSpec({ ...EMPTY, ...s, steps: s.steps.length ? s.steps : EMPTY.steps })
      setName(target.name ?? target.derived_name ?? '')
      setActiveId(target.id)
      setDirty(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load on selection
  }, [saved.data, activeId])

  useEffect(() => patchParams({ funnel: activeId != null && activeId > 0 ? String(activeId) : undefined }), [activeId])

  const update = (p: Partial<FunnelSpec>) => {
    setSpec((s) => ({ ...s, ...p }))
    setDirty(true)
  }
  const validSteps = spec.steps.filter((s) => s.event)
  const query = validSteps.length >= 2 ? buildFunnelsQuery({ ...spec, steps: validSteps }) : null
  const result = usePHQuery(['funnel'], query, parseFunnel)

  if (saved.isError && !saved.data) return <PostHogState error={saved.error} onRetry={() => saved.refetch()} />

  return (
    <div className="space-y-4">
      <VizStyle />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <SavedList
          list={saved.data ?? []}
          loading={saved.isLoading}
          activeId={activeId}
          onPick={(id) => {
            setActiveId(id)
            setDirty(false)
          }}
          onNew={() => {
            setActiveId(null)
            setSpec(EMPTY)
            setName('')
            setDirty(true)
          }}
        />

        <div className="min-w-0 space-y-4">
          <Editor
            spec={spec}
            name={name}
            onName={(n) => {
              setName(n)
              setDirty(true)
            }}
            update={update}
            active={active}
            dirty={dirty}
            query={query}
            onSaved={(id) => {
              setActiveId(id)
              setDirty(false)
            }}
          />
          {!query ? (
            <NoData title="Add at least two steps" hint="Pick real events captured by PostHog for each step." height={160} />
          ) : result.isLoading ? <Loading height={240} /> : result.isError ? (
            <PostHogState error={result.error} onRetry={() => result.refetch()} compact />
          ) : <FunnelResult groups={result.data ?? []} fetching={result.isFetching} breakdown={spec.breakdown} windowDays={spec.windowDays} />}
        </div>
      </div>
    </div>
  )
}

function SavedList({ list, loading, activeId, onPick, onNew }: { list: SavedInsight[]; loading: boolean; activeId: number | null; onPick(id: number): void; onNew(): void }) {
  const [q, setQ] = useState('')
  const shown = list.filter((i) => !q || (i.name ?? i.derived_name ?? '').toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved funnels…" className="h-8 min-w-0 flex-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content" />
        <Button size="sm" variant="primary" onClick={onNew}>New</Button>
      </div>
      {loading ? <Loading height={80} /> : shown.length === 0 ? (
        <p className="px-1 text-[11px] text-content-subtle">{list.length ? 'No saved funnel matches.' : 'No saved funnels in PostHog yet — build one and save it.'}</p>
      ) : (
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
          {shown.map((i) => {
            const steps = funnelSpecFromInsight(i)?.steps.length ?? 0
            return (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => onPick(i.id)}
                  className={cn(
                    'block w-full rounded-md border px-3 py-2 text-left',
                    activeId === i.id ? 'border-brand-300 bg-brand-50 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-transparent hover:bg-surface-sunken',
                  )}
                >
                  <div className="truncate text-[13px] font-medium text-content">{i.name || i.derived_name || 'Untitled funnel'}</div>
                  <div className="text-[11px] text-content-subtle">
                    {steps} steps{i.last_modified_at ? ` · ${formatRelative(i.last_modified_at)}` : ''}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Editor({
  spec,
  name,
  onName,
  update,
  active,
  dirty,
  query,
  onSaved,
}: {
  spec: FunnelSpec
  name: string
  onName(n: string): void
  update(p: Partial<FunnelSpec>): void
  active: SavedInsight | null
  dirty: boolean
  query: Record<string, unknown> | null
  onSaved(id: number): void
}) {
  const save = useSaveInsight()
  const del = useDeleteInsight()
  const toast = useToast()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const setStep = (i: number, event: string | null) => update({ steps: spec.steps.map((s, j) => (j === i ? { ...s, event: event ?? '' } : s)) })
  const move = (i: number, d: -1 | 1) => {
    const next = [...spec.steps]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    update({ steps: next })
  }
  const doSave = (asNew: boolean) =>
    save.mutate(
      { id: asNew ? undefined : active?.id, name: name.trim() || spec.steps.filter((s) => s.event).map((s) => s.event).join(' → '), source: query! },
      {
        onSuccess: (res) => {
          toast.success(asNew || !active ? 'Funnel saved to PostHog' : 'Funnel updated in PostHog')
          onSaved(res.id)
        },
        onError: (e) => toast.error('PostHog did not save the funnel', { description: (e as Error).message }),
      },
    )

  return (
    <Widget
      title={
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Untitled funnel"
          aria-label="Funnel name"
          className="w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-sm font-semibold text-content hover:border-edge-default focus:border-brand-400 focus:outline-none"
        />
      }
      subtitle={active ? `Saved insight · ${dirty ? 'unsaved changes' : 'in sync with PostHog'}` : 'New funnel · not saved yet'}
      actions={
        <div className="flex items-center gap-1.5">
          {active ? <OpenInPostHog path={`/insights/${active.short_id}`} label="PostHog" /> : null}
          {active ? <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>Delete</Button> : null}
          {active ? <Button size="sm" disabled={!query} onClick={() => doSave(true)}>Save as new</Button> : null}
          <Button size="sm" variant="primary" disabled={!query || (!dirty && !!active)} loading={save.isPending} onClick={() => doSave(false)}>
            {active ? 'Save' : 'Save funnel'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <ol className="space-y-1.5">
          {spec.steps.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken font-mono text-[11px] font-semibold text-content">{i + 1}</span>
              <EventPicker value={s.event || null} onChange={(v) => setStep(i, v)} label={`Step ${i + 1} event`} />
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="h-7 w-7 rounded text-content-subtle hover:bg-surface-sunken disabled:opacity-30" aria-label="Move up">↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === spec.steps.length - 1} className="h-7 w-7 rounded text-content-subtle hover:bg-surface-sunken disabled:opacity-30" aria-label="Move down">↓</button>
              <button type="button" onClick={() => update({ steps: spec.steps.filter((_, j) => j !== i) })} disabled={spec.steps.length <= 2} className="h-7 w-7 rounded text-content-subtle hover:bg-surface-sunken disabled:opacity-30" aria-label="Remove step">×</button>
            </li>
          ))}
        </ol>
        <Button size="xs" onClick={() => update({ steps: [...spec.steps, { event: '' }] })} disabled={spec.steps.length >= 10}>+ Add step</Button>
        <div className="flex flex-wrap items-center gap-2 border-t border-edge-subtle pt-3">
          <RangePicker value={spec.range} onChange={(r: DateRangeId) => update({ range: r })} />
          <label className="inline-flex items-center gap-1.5 text-[12px] text-content-muted">
            Convert within
            <input type="number" min={1} max={90} value={spec.windowDays} onChange={(e) => update({ windowDays: Math.max(1, Math.min(90, Number(e.target.value) || 1)) })} className="h-8 w-16 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content" />
            days
          </label>
          <select aria-label="Step order" value={spec.order ?? 'ordered'} onChange={(e) => update({ order: e.target.value as FunnelSpec['order'] })} className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content">
            <option value="ordered">Sequential</option>
            <option value="strict">Strict order</option>
            <option value="unordered">Any order</option>
          </select>
          <BreakdownPicker value={spec.breakdown ?? ''} type={spec.breakdownType ?? 'event'} onChange={(v, t) => update({ breakdown: v || undefined, breakdownType: t })} />
        </div>
        <FilterBar filters={spec.filters ?? []} onChange={(f) => update({ filters: f })} />
      </div>
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this funnel?"
        description={`“${name || 'Untitled funnel'}” is removed from PostHog’s saved insights.`}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              size="sm"
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                del.mutate(active!.id, {
                  onSuccess: () => {
                    toast.success('Funnel deleted')
                    setConfirmDelete(false)
                    onSaved(-1)
                  },
                  onError: (e) => toast.error('PostHog did not delete the funnel', { description: (e as Error).message }),
                })}
            >
              Delete
            </Button>
          </div>
        }
      >
        <span />
      </Modal>
    </Widget>
  )
}

function FunnelResult({ groups, fetching, breakdown, windowDays }: { groups: FunnelBreakdown[]; fetching: boolean; breakdown?: string; windowDays: number }) {
  // Without a breakdown there is one group; with one, total the steps for the ladder.
  const total = useMemo(() => {
    if (groups.length <= 1) return groups[0]?.steps ?? []
    const base = groups[0].steps.map((s) => ({ ...s, count: 0, avgTime: null as number | null, medianTime: null as number | null }))
    for (const g of groups) g.steps.forEach((s, i) => { if (base[i]) base[i].count += s.count })
    return base
  }, [groups])
  const m = funnelMath(total)
  if (!total.length || total[0].count === 0) {
    return <NoData title="Nobody entered this funnel in the range" hint="Check the first step’s event, or widen the date range." height={160} />
  }
  const worst = worstStep(m.steps)
  const slowest = m.steps.reduce((a, s, i) => (s.avgTime != null && (a < 0 || s.avgTime > (m.steps[a].avgTime ?? 0)) ? i : a), -1)
  return (
    <div className={cn('space-y-4', fetching && 'opacity-70')}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Entered" value={fmtNum(m.steps[0].count)} hint={m.steps[0].name} />
        <StatTile label="Completed" value={fmtNum(m.steps[m.steps.length - 1].count)} hint={m.steps[m.steps.length - 1].name} />
        <StatTile label="Overall conversion" value={fmtPct(m.overall * 100)} hint={`within ${windowDays} days`} />
        <StatTile label="Slowest step" value={slowest > 0 ? formatSeconds(m.steps[slowest].avgTime!) : '—'} hint={slowest > 0 ? `avg into “${m.steps[slowest].name}”` : 'no timing yet'} />
      </div>

      <Widget title="Conversion by step" subtitle="Bar = share of people who entered; per step: from previous, people lost, time to convert">
        <ol className="space-y-3">
          {m.steps.map((s, i) => (
            <li key={`${s.name}-${i}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13px] text-content">
                  <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-surface-sunken font-mono text-[10px] font-bold text-content">{i + 1}</span>
                  {s.name}
                </span>
                <span className="font-mono text-[12px] tabular-nums text-content">
                  {fmtNum(s.count)} <span className="text-content-subtle">· {fmtPct(s.fromStart * 100)}</span>
                </span>
              </div>
              <div className="mt-1 h-6 overflow-hidden rounded-md bg-surface-sunken">
                <div className="h-full rounded-md" style={{ width: `${Math.max(1, s.fromStart * 100)}%`, backgroundColor: seriesColor(0) }} />
              </div>
              {i > 0 ? (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-content-muted">
                  <span>{fmtPct(s.fromPrevious * 100)} from previous step</span>
                  <span>{fmtNum(s.dropped)} dropped off</span>
                  {s.avgTime != null ? <span>avg {formatSeconds(s.avgTime)}</span> : null}
                  {s.medianTime != null ? <span>median {formatSeconds(s.medianTime)}</span> : null}
                  {i === worst && s.fromPrevious < 1 ? (
                    <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">▲ Biggest drop-off</span>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </Widget>

      {groups.length > 1 ? (
        <Widget title={`Breakdown by ${breakdown}`} subtitle="Conversion per value — share of each value’s entrants reaching each step">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-content-subtle">
                  <th className="pb-1.5 pr-3 font-medium">{breakdown}</th>
                  {groups[0].steps.map((s, i) => <th key={i} className="pb-1.5 pr-3 text-right font-medium">{i + 1}. {s.name}</th>)}
                  <th className="pb-1.5 text-right font-medium">Overall</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, gi) => {
                  const gm = funnelMath(g.steps)
                  return (
                    <tr key={g.value ?? gi} className="border-t border-edge-subtle/60">
                      <td className="py-1.5 pr-3 text-content">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: seriesColor(gi) }} />
                        {g.value ?? '(none)'}
                      </td>
                      {gm.steps.map((s, i) => (
                        <td key={i} className="py-1.5 pr-3 text-right font-mono tabular-nums text-content">
                          {fmtNum(s.count)} <span className="text-content-subtle">{i ? fmtPct(s.fromStart * 100, 0) : ''}</span>
                        </td>
                      ))}
                      <td className="py-1.5 text-right font-mono font-semibold tabular-nums text-content">{fmtPct(gm.overall * 100)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Widget>
      ) : null}
    </div>
  )
}
