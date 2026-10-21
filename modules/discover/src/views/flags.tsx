import { useMemo, useState } from 'react'
import { Button, EmptyState, Modal, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  type Experiment,
  FLAG_KEY_RE,
  type FlagDraft,
  flagDraftToFilters,
  flagToDraft,
  flagUsageHogQL,
  type FilterOperator,
  parseFlag,
  type ParsedFlag,
  type PropertyFilter,
  type RawFlag,
  useExperiments,
  useFlags,
  useHogQL,
  usePropertyDefinitions,
  useSaveFlag,
  variantsValid,
} from '../data/posthog.ts'
import { patchParams, readParam } from '../data/discover-nav.ts'
import { Drawer, SectionLabel, StatTile } from './discover-ui.tsx'
import { Loading, NoData, seriesColor, VizStyle } from './viz.tsx'
import { FitTimeSeries, fmtNum, OpenInPostHog, PostHogState } from './posthog-ui.tsx'
import { LoadingCard } from './states.tsx'

/**
 * Feature flags — PostHog flags with their real release conditions.
 *
 * Each flag shows its rollout (from `filters.groups`), targeting conditions in
 * words, multivariate splits and linked experiments. Turning a flag on or off
 * always asks first. The drawer charts 14 days of `$feature_flag_called`
 * evaluations by response (HogQL); the editor creates and edits flags —
 * conditions, rollout and variants — through PostHog's API.
 */
export function Flags() {
  const q = useFlags()
  const exps = useExperiments()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'on' | 'off'>('all')
  const [openKey, setOpenKey] = useState<string | null>(() => readParam('flag') ?? null)
  const [editing, setEditing] = useState<RawFlag | 'new' | null>(null)
  const [confirm, setConfirm] = useState<ParsedFlag | null>(null)
  const save = useSaveFlag()
  const toast = useToast()

  const parsed = useMemo(() => (q.data ?? []).map((f) => ({ raw: f, p: parseFlag(f) })), [q.data])
  const expById = useMemo(() => new Map((exps.data ?? []).map((e) => [String(e.id), e])), [exps.data])
  const expsFor = (p: ParsedFlag): Experiment[] => {
    const linked = p.experiments.map((id) => expById.get(id)).filter(Boolean) as Experiment[]
    for (const e of exps.data ?? []) if ((e.feature_flag_key ?? e.feature_flag?.key) === p.key && !linked.includes(e)) linked.push(e)
    return linked
  }
  const list = parsed
    .filter(({ p }) => status === 'all' || (status === 'on' ? p.active : !p.active))
    .filter(({ p }) => !query || `${p.key} ${p.name} ${p.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()))

  const open = (key: string | null) => {
    setOpenKey(key)
    patchParams({ flag: key ?? undefined })
  }

  if (q.isLoading) return <LoadingCard label="Loading feature flags…" />
  if (q.isError) return <PostHogState error={q.error} onRetry={() => q.refetch()} />

  const doToggle = (p: ParsedFlag) =>
    save.mutate(
      { id: p.id, body: { active: !p.active } },
      {
        onSuccess: () => {
          toast.success(`${p.key} is now ${p.active ? 'off' : 'on'}`)
          setConfirm(null)
        },
        onError: (e) => {
          toast.error(`PostHog did not change ${p.key}`, { description: (e as Error).message })
          setConfirm(null)
        },
      },
    )

  const selected = parsed.find(({ p }) => p.key === openKey) ?? null

  return (
    <div className="space-y-4">
      <VizStyle />
      <div className="flex flex-wrap items-center gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${parsed.length} flags by key, name, tag…`} className="h-8 w-72 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content" />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content">
          <option value="all">All flags</option>
          <option value="on">Enabled</option>
          <option value="off">Disabled</option>
        </select>
        <div className="ml-auto flex items-center gap-2">
          <OpenInPostHog path="/feature_flags" />
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>New flag</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Flags" value={fmtNum(parsed.length)} />
        <StatTile label="Enabled" value={fmtNum(parsed.filter(({ p }) => p.active).length)} />
        <StatTile label="Multivariate" value={fmtNum(parsed.filter(({ p }) => p.variants.length).length)} />
        <StatTile label="In experiments" value={exps.isError ? '—' : fmtNum(parsed.filter(({ p }) => expsFor(p).length).length)} hint={exps.isError ? 'experiments API unavailable' : undefined} />
      </div>

      {parsed.length === 0 ? (
        <EmptyState title="No feature flags yet" description="Flags gate features per user, cohort or percentage, and back A/B experiments." action={<Button size="sm" variant="primary" onClick={() => setEditing('new')}>Create a flag</Button>} />
      ) : list.length === 0 ? (
        <EmptyState compact title="No flag matches" />
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          {list.map(({ p }) => (
            <li key={p.id} className="flex items-start gap-3 px-4 py-3">
              <button type="button" onClick={() => open(p.key)} className="min-w-0 flex-1 text-left">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px] font-semibold text-content">{p.key}</code>
                  {p.name ? <span className="truncate text-[13px] text-content-muted">{p.name}</span> : null}
                  {p.tags.map((t) => <span key={t} className="rounded-full border border-edge-subtle px-1.5 text-[10px] text-content-subtle">{t}</span>)}
                </div>
                <FlagSummary p={p} exps={expsFor(p)} />
              </button>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Switch on={p.active} onClick={() => setConfirm(p)} label={`${p.active ? 'Disable' : 'Enable'} ${p.key}`} />
                <span className="text-[10px] text-content-subtle">{p.updatedAt ? formatRelative(p.updatedAt) : p.createdAt ? formatRelative(p.createdAt) : ''}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm ? `${confirm.active ? 'Disable' : 'Enable'} ${confirm.key}?` : ''}
        description={confirm ? (confirm.active ? 'Every user immediately gets the flag as false.' : `Users matching its conditions${confirm.rollout != null ? ` (${confirm.rollout}% rollout)` : ''} start getting it right away.`) : ''}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button size="sm" variant={confirm?.active ? 'danger' : 'primary'} loading={save.isPending} onClick={() => confirm && doToggle(confirm)}>
              {confirm?.active ? 'Disable flag' : 'Enable flag'}
            </Button>
          </div>
        }
      >
        <span />
      </Modal>

      {selected ? <FlagDrawer p={selected.p} exps={expsFor(selected.p)} onClose={() => open(null)} onEdit={() => setEditing(selected.raw)} onToggle={() => setConfirm(selected.p)} /> : null}
      {editing ? <FlagEditor flag={editing === 'new' ? null : editing} existingKeys={parsed.map(({ p }) => p.key)} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function Switch({ on, onClick, label }: { on: boolean; onClick(): void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} className="inline-flex items-center gap-1.5">
      <span className="text-[11px] font-medium text-content-muted">{on ? 'On' : 'Off'}</span>
      <span className={cn('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-brand-500' : 'bg-edge-strong')}>
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-4.5' : 'left-0.5')} />
      </span>
    </button>
  )
}

function RolloutBar({ pct }: { pct: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: seriesColor(0) }} />
      </span>
      <span className="font-mono text-[11px] tabular-nums text-content">{pct}%</span>
    </span>
  )
}

function FlagSummary({ p, exps }: { p: ParsedFlag; exps: Experiment[] }) {
  const targeted = p.conditions.filter((c) => c.properties.length)
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-content-muted">
      {p.fullyRolledOut ? <span>Everyone (100%)</span> : p.rollout != null ? <span className="inline-flex items-center gap-1.5">{targeted.length ? 'Everyone else' : 'Everyone'} <RolloutBar pct={p.rollout} /></span> : null}
      {targeted.length ? <span>{targeted.length} targeted condition{targeted.length === 1 ? '' : 's'}: <span className="font-mono text-[10px]">{targeted[0].properties.join(' & ')}</span>{targeted.length > 1 ? ' …' : ''}</span> : null}
      {p.variants.length ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          {p.variants.map((v, i) => (
            <span key={v.key} className="inline-flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px]">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: seriesColor(i) }} />
              {v.key} {v.rollout}%
            </span>
          ))}
        </span>
      ) : null}
      {exps.length ? <span>Experiment: {exps.map((e) => e.name).join(', ')}</span> : null}
      {p.conditions.length === 0 ? <span>No release conditions</span> : null}
    </div>
  )
}

function FlagDrawer({ p, exps, onClose, onEdit, onToggle }: { p: ParsedFlag; exps: Experiment[]; onClose(): void; onEdit(): void; onToggle(): void }) {
  const usage = useHogQL<{ day: string; response: string; evaluations: number; users: number }>(['flag-usage', p.key], flagUsageHogQL(p.key))
  const series = useMemo(() => {
    const by = new Map<string, Array<[number, number]>>()
    for (const r of usage.data ?? []) {
      const k = r.response === '' || r.response == null ? '(no value)' : r.response
      if (!by.has(k)) by.set(k, [])
      by.get(k)!.push([Date.parse(String(r.day).replace(' ', 'T')), Number(r.evaluations)])
    }
    return [...by.entries()].map(([name, points], i) => ({ name: `response ${name}`, points, color: seriesColor(i) }))
  }, [usage.data])
  const totalEvals = (usage.data ?? []).reduce((a, r) => a + Number(r.evaluations), 0)
  return (
    <Drawer
      widthId="discover.flag"
      open
      onClose={onClose}
      title={p.key}
      subtitle={`${p.name || 'No description'}${p.author ? ` · last changed by ${p.author}` : ''}`}
      badges={<Switch on={p.active} onClick={onToggle} label={`${p.active ? 'Disable' : 'Enable'} ${p.key}`} />}
      actions={
        <>
          <Button size="sm" onClick={onEdit}>Edit</Button>
          <OpenInPostHog path={`/feature_flags/${p.id}`} label="PostHog" />
        </>
      }
    >
      <div className="space-y-6 p-5">
        <section>
          <SectionLabel right={<span className="text-[11px] text-content-subtle">{fmtNum(totalEvals)} in 14 days</span>}>Evaluations</SectionLabel>
          {usage.isLoading ? <Loading height={160} /> : usage.isError ? <PostHogState compact error={usage.error} onRetry={() => usage.refetch()} /> : series.length === 0 ? (
            <NoData title="No evaluations in the last 14 days" hint="Counted from $feature_flag_called events, which PostHog SDKs send when code checks the flag." />
          ) : (
            <FitTimeSeries heightPx={160} series={series} formatTime={(t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })} />
          )}
        </section>
        <section>
          <SectionLabel>Release conditions</SectionLabel>
          {p.conditions.length === 0 ? <p className="text-[12px] text-content-muted">None — the flag is off for everyone.</p> : (
            <ol className="space-y-2">
              {p.conditions.map((c, i) => (
                <li key={i} className="rounded-lg border border-edge-default p-3 text-[12px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-content">Condition {i + 1}{c.variant ? ` → variant ${c.variant}` : ''}</span>
                    <RolloutBar pct={c.rollout} />
                  </div>
                  <div className="mt-1 text-content-muted">
                    {c.properties.length ? c.properties.map((x, j) => <code key={j} className="mr-1 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">{x}</code>) : 'All users'}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
        {p.variants.length ? (
          <section>
            <SectionLabel>Variants</SectionLabel>
            <div className="flex h-3 overflow-hidden rounded-full">
              {p.variants.map((v, i) => <span key={v.key} style={{ width: `${v.rollout}%`, backgroundColor: seriesColor(i) }} title={`${v.key} ${v.rollout}%`} />)}
            </div>
            <ul className="mt-2 space-y-1 text-[12px]">
              {p.variants.map((v, i) => (
                <li key={v.key} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: seriesColor(i) }} />
                  <code className="font-mono text-content">{v.key}</code>
                  <span className="text-content-muted">{v.name}</span>
                  <span className="ml-auto font-mono tabular-nums text-content">{v.rollout}%</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section>
          <SectionLabel>Experiments</SectionLabel>
          {exps.length === 0 ? <p className="text-[12px] text-content-muted">Not used by an experiment.</p> : (
            <ul className="space-y-1 text-[12px]">
              {exps.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="text-content">{e.name}</span>
                  <span className="text-content-subtle">{e.archived ? 'archived' : e.end_date ? `ended ${formatRelative(e.end_date)}` : e.start_date ? `running since ${formatRelative(e.start_date)}` : 'draft'}</span>
                  <span className="ml-auto"><OpenInPostHog path={`/experiments/${e.id}`} label="Open" /></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  )
}

const OPS: Array<[FilterOperator, string]> = [['exact', 'equals'], ['is_not', 'is not'], ['icontains', 'contains'], ['not_icontains', 'not contains'], ['is_set', 'is set'], ['is_not_set', 'is not set'], ['gt', '>'], ['lt', '<']]

function FlagEditor({ flag, existingKeys, onClose }: { flag: RawFlag | null; existingKeys: string[]; onClose(): void }) {
  const [d, setD] = useState<FlagDraft>(() => (flag ? flagToDraft(flag) : { key: '', name: '', active: false, conditions: [{ rollout: 0, properties: [] }], variants: [] }))
  const personProps = usePropertyDefinitions('person')
  const save = useSaveFlag()
  const toast = useToast()
  const keyErr = !flag && d.key && (!FLAG_KEY_RE.test(d.key) ? 'Letters, numbers, - and _ only' : existingKeys.includes(d.key) ? 'A flag with this key exists' : '')
  const variantErr = !variantsValid(d.variants) ? 'Variant splits must add up to 100%' : d.variants.some((v) => !v.key) ? 'Every variant needs a key' : ''
  const valid = d.key && !keyErr && !variantErr && d.conditions.length > 0
  const setCond = (i: number, patch: Partial<FlagDraft['conditions'][number]>) => setD((x) => ({ ...x, conditions: x.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))
  const setProp = (ci: number, pi: number, patch: Partial<PropertyFilter>) =>
    setCond(ci, { properties: d.conditions[ci].properties.map((p, j) => (j === pi ? { ...p, ...patch } : p)) })

  const submit = () =>
    save.mutate(
      { id: flag ? String(flag.id) : undefined, body: { key: d.key, name: d.name, active: d.active, filters: flagDraftToFilters(d) } },
      {
        onSuccess: () => {
          toast.success(flag ? `Saved ${d.key}` : `Created ${d.key}`)
          onClose()
        },
        onError: (e) => toast.error('PostHog did not save the flag', { description: (e as Error).message }),
      },
    )

  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      title={flag ? `Edit ${flag.key}` : 'New feature flag'}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {variantErr ? <span className="mr-auto text-xs text-rose-700 dark:text-rose-300">■ {variantErr}</span> : null}
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>{flag ? 'Save flag' : 'Create flag'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs text-content-muted">
            Key
            <input value={d.key} disabled={!!flag} onChange={(e) => setD({ ...d, key: e.target.value.trim() })} placeholder="new-checkout" className="mt-1 h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-sm text-content disabled:opacity-60" />
            {keyErr ? <span className="mt-0.5 block text-rose-700 dark:text-rose-300">{keyErr}</span> : null}
          </label>
          <label className="block text-xs text-content-muted">
            Description
            <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="What does this flag gate?" className="mt-1 h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-sm text-content" />
          </label>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-content">
          <input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} className="h-4 w-4" />
          Enabled
        </label>

        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Release conditions</div>
          {d.conditions.map((c, ci) => (
            <div key={ci} className="space-y-2 rounded-lg border border-edge-default p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-content">Condition {ci + 1}</span>
                <span className="text-content-muted">roll out to</span>
                <input type="range" min={0} max={100} value={c.rollout} onChange={(e) => setCond(ci, { rollout: Number(e.target.value) })} className="w-40" aria-label="Rollout percentage" />
                <input type="number" min={0} max={100} value={c.rollout} onChange={(e) => setCond(ci, { rollout: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} className="h-7 w-16 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content" />
                <span className="text-content-muted">% of {c.properties.length ? 'matching users' : 'all users'}</span>
                <button type="button" onClick={() => setD({ ...d, conditions: d.conditions.filter((_, j) => j !== ci) })} className={cn('ml-auto rounded px-1.5 text-content-subtle hover:bg-surface-sunken', d.conditions.length <= 1 && 'invisible')}>Remove</button>
              </div>
              {c.properties.map((p, pi) => (
                <div key={pi} className="flex flex-wrap items-center gap-1.5 pl-2">
                  <span className="text-[11px] text-content-subtle">{pi === 0 ? 'where' : 'and'}</span>
                  <input list="ph-flag-props" value={p.key} onChange={(e) => setProp(ci, pi, { key: e.target.value })} placeholder="person property" className="h-7 w-40 rounded-md border border-edge-default bg-surface-raised px-1.5 font-mono text-xs text-content" />
                  <select value={p.operator ?? 'exact'} onChange={(e) => setProp(ci, pi, { operator: e.target.value as FilterOperator })} className="h-7 rounded-md border border-edge-default bg-surface-raised px-1 text-xs text-content">
                    {OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
                  </select>
                  {p.operator === 'is_set' || p.operator === 'is_not_set' ? null : (
                    <input value={Array.isArray(p.value) ? p.value.join(',') : String(p.value ?? '')} onChange={(e) => setProp(ci, pi, { value: e.target.value })} placeholder="value" className="h-7 w-36 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content" />
                  )}
                  <button type="button" onClick={() => setCond(ci, { properties: c.properties.filter((_, j) => j !== pi) })} className="rounded px-1 text-content-subtle hover:bg-surface-sunken" aria-label="Remove property">×</button>
                </div>
              ))}
              <Button size="xs" variant="ghost" onClick={() => setCond(ci, { properties: [...c.properties, { key: '', operator: 'exact', value: '', type: 'person' }] })}>+ Match property</Button>
            </div>
          ))}
          <Button size="xs" onClick={() => setD({ ...d, conditions: [...d.conditions, { rollout: 100, properties: [] }] })}>+ Add condition</Button>
          <datalist id="ph-flag-props">{(personProps.data ?? []).map((p) => <option key={p} value={p} />)}</datalist>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Variants (A/B)</span>
            {d.variants.length ? <span className="font-mono text-[11px] text-content-muted">{d.variants.reduce((a, v) => a + (Number(v.rollout) || 0), 0)}% allocated</span> : <span className="text-[11px] text-content-subtle">boolean flag</span>}
          </div>
          {d.variants.map((v, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: seriesColor(i) }} />
              <input value={v.key} onChange={(e) => setD({ ...d, variants: d.variants.map((x, j) => (j === i ? { ...x, key: e.target.value.trim() } : x)) })} placeholder="variant key" className="h-7 w-32 rounded-md border border-edge-default bg-surface-raised px-1.5 font-mono text-xs text-content" />
              <input value={v.name ?? ''} onChange={(e) => setD({ ...d, variants: d.variants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="description" className="h-7 w-48 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content" />
              <input type="number" min={0} max={100} value={v.rollout} onChange={(e) => setD({ ...d, variants: d.variants.map((x, j) => (j === i ? { ...x, rollout: Number(e.target.value) || 0 } : x)) })} className="h-7 w-16 rounded-md border border-edge-default bg-surface-raised px-1.5 text-xs text-content" aria-label="Split %" />
              <span className="text-xs text-content-muted">%</span>
              <button type="button" onClick={() => setD({ ...d, variants: d.variants.filter((_, j) => j !== i) })} className="rounded px-1 text-content-subtle hover:bg-surface-sunken" aria-label="Remove variant">×</button>
            </div>
          ))}
          <Button
            size="xs"
            onClick={() => {
              const next = [...d.variants, { key: d.variants.length ? `test-${d.variants.length}` : 'control', rollout: 0 }]
              const even = Math.floor(100 / next.length)
              setD({ ...d, variants: next.map((v, i) => ({ ...v, rollout: i === next.length - 1 ? 100 - even * (next.length - 1) : even })) })
            }}
          >
            + Add variant
          </Button>
        </div>
      </div>
    </Modal>
  )
}
