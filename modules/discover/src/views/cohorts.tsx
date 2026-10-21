import { useMemo, useState } from 'react'
import { Button, EmptyState, Modal, Spinner, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  buildCohortFilters,
  buildTrendsQuery,
  type CohortRule,
  describeCohort,
  type FilterOperator,
  parseTrends,
  type RawCohort,
  useCohortPersons,
  usePHCohorts,
  usePHQuery,
  usePropertyDefinitions,
  useSaveCohort,
} from '../data/posthog.ts'
import { goDiscover } from '../data/discover-nav.ts'
import { Drawer, SectionLabel } from './discover-ui.tsx'
import { Loading, NoData, seriesColor, VizStyle } from './viz.tsx'
import { FitTimeSeries, EventPicker, fmtNum, OpenInPostHog, PostHogState } from './posthog-ui.tsx'
import { LoadingCard } from './states.tsx'

/**
 * Cohorts — PostHog cohorts with their real rules and sizes.
 *
 * Lists every cohort (dynamic and static) with the rule set rendered in plain
 * words, opens a drawer with active-members-per-day (a TrendsQuery filtered to
 * the cohort) and a member preview, creates/edits behavioural + property
 * cohorts through PostHog's cohort API, and hands a cohort to Analytics as a
 * page-wide filter.
 */
export function Cohorts() {
  const q = usePHCohorts()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'dynamic' | 'static'>('all')
  const [open, setOpen] = useState<RawCohort | null>(null)
  const [editing, setEditing] = useState<RawCohort | 'new' | null>(null)

  const list = useMemo(
    () =>
      (q.data ?? [])
        .filter((c) => kind === 'all' || (kind === 'static' ? c.is_static : !c.is_static))
        .filter((c) => !query || `${c.name} ${c.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
    [q.data, kind, query],
  )

  if (q.isLoading) return <LoadingCard label="Loading cohorts…" />
  if (q.isError) return <PostHogState error={q.error} onRetry={() => q.refetch()} />
  const total = q.data?.length ?? 0

  return (
    <div className="space-y-4">
      <VizStyle />
      <div className="flex flex-wrap items-center gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${total} cohorts…`} className="h-8 w-64 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content" />
        <select aria-label="Cohort type" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content">
          <option value="all">All types</option>
          <option value="dynamic">Dynamic</option>
          <option value="static">Static</option>
        </select>
        <div className="ml-auto flex items-center gap-2">
          <OpenInPostHog path="/cohorts" />
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>New cohort</Button>
        </div>
      </div>

      {total === 0 ? (
        <EmptyState
          title="No cohorts in PostHog yet"
          description="A cohort is a saved group of people — by what they did (behavioural) or who they are (person properties)."
          action={<Button size="sm" variant="primary" onClick={() => setEditing('new')}>Create a cohort</Button>}
        />
      ) : list.length === 0 ? (
        <EmptyState compact title="No cohort matches" />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => <CohortCard key={c.id} c={c} onOpen={() => setOpen(c)} onEdit={() => setEditing(c)} />)}
        </div>
      )}

      {open ? <CohortDrawer c={(q.data ?? []).find((x) => x.id === open.id) ?? open} onClose={() => setOpen(null)} onEdit={() => setEditing(open)} /> : null}
      {editing ? <CohortEditor cohort={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function CohortCard({ c, onOpen, onEdit }: { c: RawCohort; onOpen(): void; onEdit(): void }) {
  const rules = describeCohort(c)
  return (
    <div className="flex flex-col rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-semibold text-content hover:underline">{c.name}</div>
          {c.description ? <p className="mt-0.5 line-clamp-2 text-[11px] text-content-muted">{c.description}</p> : null}
        </button>
        <span className="shrink-0 rounded-full border border-edge-default px-1.5 py-0.5 text-[10px] text-content-muted">{c.is_static ? 'static' : 'dynamic'}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        {c.is_calculating ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-content-muted"><Spinner size={12} /> calculating…</span>
        ) : (
          <>
            <span className="text-2xl font-semibold tabular-nums text-content">{c.count == null ? '—' : fmtNum(c.count)}</span>
            <span className="text-xs text-content-muted">people</span>
          </>
        )}
        {c.errors_calculating ? <span className="ml-auto text-[11px] font-medium text-rose-700 dark:text-rose-300">■ calculation errors</span> : null}
      </div>
      <RuleSummary rules={rules} max={3} />
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        <Button size="xs" onClick={() => goDiscover('analytics', { cohort: String(c.id) })}>Use as filter</Button>
        <Button size="xs" variant="ghost" onClick={onOpen}>Members</Button>
        {!c.is_static ? <Button size="xs" variant="ghost" onClick={onEdit}>Edit</Button> : null}
        <span className="ml-auto text-[10px] text-content-subtle">{c.created_at ? formatRelative(c.created_at) : ''}</span>
      </div>
    </div>
  )
}

function RuleSummary({ rules, max }: { rules: ReturnType<typeof describeCohort>; max?: number }) {
  if (!rules.groups.length) return <p className="mt-2 text-[11px] text-content-subtle">No rules (static list or uploaded CSV)</p>
  const groups = max ? rules.groups.slice(0, max) : rules.groups
  return (
    <div className="mt-2 space-y-1">
      {groups.map((g, i) => (
        <div key={i} className="text-[11px]">
          {i > 0 ? <div className="my-0.5 text-[9px] font-semibold uppercase tracking-wider text-content-subtle">{rules.joiner}</div> : null}
          <div className="flex flex-wrap gap-1">
            {g.map((line, j) => (
              <span key={j} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">{line}</span>
            ))}
          </div>
        </div>
      ))}
      {max && rules.groups.length > max ? <div className="text-[10px] text-content-subtle">+{rules.groups.length - max} more groups</div> : null}
    </div>
  )
}

function CohortDrawer({ c, onClose, onEdit }: { c: RawCohort; onClose(): void; onEdit(): void }) {
  const persons = useCohortPersons(c.id)
  const trend = usePHQuery(
    ['cohort-trend', c.id],
    buildTrendsQuery({ event: null, math: 'dau', range: '-30d', interval: 'day', filters: [{ type: 'cohort', key: 'id', value: String(c.id) }] }),
    parseTrends,
  )
  const s = trend.data?.[0]
  return (
    <Drawer
      widthId="discover.cohort"
      open
      onClose={onClose}
      title={c.name}
      subtitle={`${c.is_static ? 'Static' : 'Dynamic'} cohort · ${c.count == null ? 'size unknown' : `${fmtNum(c.count)} people`}${c.last_calculation ? ` · calculated ${formatRelative(c.last_calculation)}` : ''}`}
      actions={
        <>
          <Button size="sm" onClick={() => goDiscover('analytics', { cohort: String(c.id) })}>Use as filter</Button>
          {!c.is_static ? <Button size="sm" onClick={onEdit}>Edit</Button> : null}
          <OpenInPostHog path={`/cohorts/${c.id}`} label="PostHog" />
        </>
      }
    >
      <div className="space-y-6 p-5">
        {c.description ? <p className="text-sm text-content-muted">{c.description}</p> : null}
        <section>
          <SectionLabel>Rules</SectionLabel>
          <RuleSummary rules={describeCohort(c)} />
        </section>
        <section>
          <SectionLabel>Active members per day · 30 days</SectionLabel>
          {trend.isLoading ? <Loading height={160} /> : trend.isError ? <PostHogState compact error={trend.error} onRetry={() => trend.refetch()} /> : !s || s.count === 0 ? (
            <NoData title="No member activity in the last 30 days" />
          ) : (
            <FitTimeSeries
              heightPx={160}
              series={[{ name: 'Active members', points: s.times.map((t, i) => [t, s.data[i]] as [number, number]), color: seriesColor(0) }]}
              formatTime={(t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            />
          )}
          <p className="mt-1 text-[11px] text-content-subtle">Unique cohort members with any event per day (PostHog does not keep a history of cohort size).</p>
        </section>
        <section>
          <SectionLabel>Members preview</SectionLabel>
          {persons.isLoading ? <Loading height={80} /> : persons.isError ? <PostHogState compact error={persons.error} onRetry={() => persons.refetch()} /> : !persons.data?.length ? (
            <NoData title={c.is_calculating ? 'Cohort is still calculating' : 'No members'} />
          ) : (
            <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
              {persons.data.map((p) => {
                const email = p.properties?.email as string | undefined
                const label = p.name || email || p.distinct_ids?.[0] || p.id
                return (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-bold text-content-muted">{String(label).slice(0, 2).toUpperCase()}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-content">{label}</div>
                      <div className="truncate font-mono text-[10px] text-content-subtle">{p.distinct_ids?.[0]}</div>
                    </div>
                    {p.created_at ? <span className="text-[10px] text-content-subtle">since {formatRelative(p.created_at)}</span> : null}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  )
}

/** A cohort's rules can be edited here only when they are one flat group. */
function rulesFromCohort(c: RawCohort | null): { rules: CohortRule[]; joiner: 'AND' | 'OR'; editable: boolean } {
  const root = c?.filters?.properties
  if (!c || !root?.values?.length) return { rules: [{ kind: 'behavioral', key: '$pageview', verb: 'performed_event', days: 30 }], joiner: 'AND', editable: !c || !c.groups?.length }
  if (root.values.length !== 1) return { rules: [], joiner: 'AND', editable: false }
  const group = root.values[0] as { type?: 'AND' | 'OR'; values?: Array<Record<string, unknown>> }
  const rules: CohortRule[] = []
  for (const v of group.values ?? []) {
    if (v.type === 'behavioral' && ['performed_event', 'not_performed_event', 'performed_event_multiple'].includes(String(v.value))) {
      rules.push({ kind: 'behavioral', key: String(v.key), verb: v.value as CohortRule['verb'], days: Number(v.time_value ?? 30), times: Number(v.operator_value ?? 1) })
    } else if (v.type === 'person') {
      rules.push({ kind: 'person', key: String(v.key), operator: (v.operator as FilterOperator) ?? 'exact', value: v.value == null ? '' : String(v.value) })
    } else return { rules: [], joiner: 'AND', editable: false }
  }
  return { rules, joiner: group.type === 'OR' ? 'OR' : 'AND', editable: true }
}

function CohortEditor({ cohort, onClose }: { cohort: RawCohort | null; onClose(): void }) {
  const init = useMemo(() => rulesFromCohort(cohort), [cohort])
  const [name, setName] = useState(cohort?.name ?? '')
  const [description, setDescription] = useState(cohort?.description ?? '')
  const [rules, setRules] = useState<CohortRule[]>(init.rules)
  const [joiner, setJoiner] = useState<'AND' | 'OR'>(init.joiner)
  const personProps = usePropertyDefinitions('person')
  const save = useSaveCohort()
  const toast = useToast()
  const set = (i: number, p: Partial<CohortRule>) => setRules((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const valid = name.trim() && rules.length > 0 && rules.every((r) => r.key && (r.kind === 'behavioral' || r.operator === 'is_set' || r.operator === 'is_not_set' || r.value))

  const submit = () =>
    save.mutate(
      { id: cohort?.id, name: name.trim(), description, filters: buildCohortFilters(rules, joiner) },
      {
        onSuccess: () => {
          toast.success(cohort ? 'Cohort updated — PostHog is recalculating it' : 'Cohort created — PostHog is calculating it')
          onClose()
        },
        onError: (e) => toast.error('PostHog did not save the cohort', { description: (e as Error).message }),
      },
    )

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={cohort ? `Edit “${cohort.name}”` : 'New cohort'}
      description="People who match the rules below. PostHog recalculates dynamic cohorts on its own schedule."
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!valid || !init.editable} loading={save.isPending} onClick={submit}>{cohort ? 'Save changes' : 'Create cohort'}</Button>
        </div>
      }
    >
      {!init.editable ? (
        <div className="space-y-2 text-sm text-content-muted">
          <p>These rules use nested groups or rule types the console does not edit. Change them in PostHog so nothing is lost.</p>
          <OpenInPostHog path={`/cohorts/${cohort?.id}`} />
        </div>
      ) : (
        <div className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cohort name" className="h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-sm text-content" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-sm text-content" />
          <div className="flex items-center gap-2 text-xs text-content-muted">
            Match
            <select value={joiner} onChange={(e) => setJoiner(e.target.value as 'AND' | 'OR')} className="h-7 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content">
              <option value="AND">all rules</option>
              <option value="OR">any rule</option>
            </select>
          </div>
          <ul className="space-y-2">
            {rules.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-edge-default p-2">
                <select value={r.kind} onChange={(e) => set(i, e.target.value === 'person' ? { kind: 'person', key: '', operator: 'exact', value: '' } : { kind: 'behavioral', key: '$pageview', verb: 'performed_event', days: 30 })} className="h-8 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content">
                  <option value="behavioral">Did event</option>
                  <option value="person">Person property</option>
                </select>
                {r.kind === 'behavioral' ? (
                  <>
                    <select value={r.verb} onChange={(e) => set(i, { verb: e.target.value as CohortRule['verb'] })} className="h-8 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content">
                      <option value="performed_event">performed</option>
                      <option value="performed_event_multiple">performed at least</option>
                      <option value="not_performed_event">did not perform</option>
                    </select>
                    {r.verb === 'performed_event_multiple' ? (
                      <input type="number" min={1} value={r.times ?? 1} onChange={(e) => set(i, { times: Math.max(1, Number(e.target.value) || 1) })} className="h-8 w-16 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content" aria-label="Times" />
                    ) : null}
                    <EventPicker value={r.key || null} onChange={(v) => set(i, { key: v ?? '' })} />
                    <span className="text-xs text-content-muted">in the last</span>
                    <input type="number" min={1} max={365} value={r.days ?? 30} onChange={(e) => set(i, { days: Math.max(1, Number(e.target.value) || 30) })} className="h-8 w-16 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content" aria-label="Days" />
                    <span className="text-xs text-content-muted">days</span>
                  </>
                ) : (
                  <>
                    <input list="ph-person-props" value={r.key} onChange={(e) => set(i, { key: e.target.value })} placeholder="property (e.g. email)" className="h-8 w-44 rounded-md border border-edge-default bg-surface-raised px-1.5 font-mono text-xs text-content" />
                    <select value={r.operator ?? 'exact'} onChange={(e) => set(i, { operator: e.target.value as FilterOperator })} className="h-8 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content">
                      <option value="exact">equals</option>
                      <option value="is_not">is not</option>
                      <option value="icontains">contains</option>
                      <option value="not_icontains">does not contain</option>
                      <option value="is_set">is set</option>
                      <option value="is_not_set">is not set</option>
                    </select>
                    {r.operator === 'is_set' || r.operator === 'is_not_set' ? null : (
                      <input value={r.value ?? ''} onChange={(e) => set(i, { value: e.target.value })} placeholder="value" className="h-8 w-40 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content" />
                    )}
                  </>
                )}
                <button type="button" onClick={() => setRules((x) => x.filter((_, j) => j !== i))} className={cn('ml-auto h-7 w-7 rounded text-content-subtle hover:bg-surface-sunken', rules.length <= 1 && 'invisible')} aria-label="Remove rule">×</button>
              </li>
            ))}
          </ul>
          <datalist id="ph-person-props">{(personProps.data ?? []).map((p) => <option key={p} value={p} />)}</datalist>
          <Button size="xs" onClick={() => setRules((r) => [...r, { kind: 'person', key: '', operator: 'exact', value: '' }])}>+ Add rule</Button>
        </div>
      )}
    </Modal>
  )
}
