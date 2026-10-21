import { type ReactNode, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Button, EmptyState, Modal, PrometheusIcon, Spinner, TimeSeriesChart, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { useTelemetrySources } from '../data/observability.ts'
import {
  alertRulesYaml,
  BURN_POLICY,
  BURN_WINDOWS,
  evaluate,
  windowsQuery,
  errorBudget,
  errorRatioExpr,
  policyFactor,
  type SliKind,
  slugify,
  type SloDefinition,
  type SloEval,
  type SloStatus,
  validateSlo,
} from '../data/slo.ts'
import {
  testSlo,
  useDeleteSlo,
  useLeBuckets,
  useSaveSlo,
  useSliSeries,
  useSloBurnDown,
  useSloDefs,
  useSlothSlos,
} from '../data/slo-api.ts'
import { promInstant, sampleNum } from '../data/backends.ts'
import { readParam } from '../data/discover-nav.ts'
import { LoadingCard, SourceError } from './states.tsx'
import {
  copyText,
  Drawer,
  IconBad,
  IconCopy,
  IconNoData,
  IconOk,
  IconPlus,
  IconWarn,
  InlineHint,
  Panel,
  Segmented,
  StatTile,
} from './discover-ui.tsx'

/**
 * SLOs — define objectives once, evaluate them live against Prometheus.
 *
 * Definitions (availability ratio, latency threshold, or custom good/total
 * PromQL) are stored in the console document store (`discover.slo`). For each
 * one we compute — from real samples, never estimates — the SLI over the
 * window, the error budget left, burn rates over 5m…3d, the status under the
 * multi-window multi-burn-rate policy, a budget burn-down across the window,
 * and a ready-to-apply PrometheusRule with recording + alerting rules.
 * Sloth-generated SLOs already in Prometheus are listed read-only.
 */

const STATUS: Record<SloStatus, { label: string; cls: string; icon: () => ReactNode; rank: number }> = {
  breached: { label: 'Budget exhausted', cls: 'text-rose-700 dark:text-rose-300', icon: IconBad, rank: 0 },
  burning: { label: 'Burning fast', cls: 'text-rose-700 dark:text-rose-300', icon: IconBad, rank: 1 },
  'at-risk': { label: 'At risk', cls: 'text-amber-700 dark:text-amber-300', icon: IconWarn, rank: 2 },
  healthy: { label: 'Healthy', cls: 'text-emerald-700 dark:text-emerald-300', icon: IconOk, rank: 3 },
  'no-data': { label: 'No data', cls: 'text-content-muted', icon: IconNoData, rank: 4 },
}

function StatusTag({ status }: { status: SloStatus }) {
  const s = STATUS[status]
  const I = s.icon
  return <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] font-medium', s.cls)}><I /> {s.label}</span>
}

const pct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}%`)
const burnFmt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v < 10 ? v.toFixed(2) : v.toFixed(1)}×`)

export function Slos() {
  const defs = useSloDefs()
  const [editing, setEditing] = useState<SloDefinition | 'new' | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SloDefinition | null>(null)
  const del = useDeleteSlo()
  const toast = useToast()
  // Deep-link context: ?section=slos&service=<svc>
  const [serviceFilter, setServiceFilter] = useState<string | undefined>(() => readParam('service'))
  const list = useMemo(() => (defs.data ?? []).filter((d) => !serviceFilter || d.service === serviceFilter), [defs.data, serviceFilter])

  const evals = useQueries({
    queries: list.map((d) => ({
      queryKey: ['slo', 'eval', JSON.stringify([d.sli, d.objective, d.windowDays])],
      queryFn: async (): Promise<SloEval> => {
        const res = await promInstant(windowsQuery(d))
        const ratios: Record<string, number | null> = {}
        for (const w of [...BURN_WINDOWS, `${d.windowDays}d`]) ratios[w] = null
        for (const s of res) if (s.metric.w) ratios[s.metric.w] = sampleNum(s.value[1])
        return evaluate(d, ratios)
      },
      refetchInterval: 60_000,
      retry: false,
    })),
  })

  const rows = list.map((d, i) => ({ def: d, q: evals[i] }))
  rows.sort((a, b) => (STATUS[a.q?.data?.status ?? 'no-data'].rank - STATUS[b.q?.data?.status ?? 'no-data'].rank) || a.def.name.localeCompare(b.def.name))
  const counts = { healthy: 0, risk: 0, bad: 0, none: 0 }
  for (const r of rows) {
    const s = r.q?.data?.status
    if (s === 'healthy') counts.healthy++
    else if (s === 'at-risk') counts.risk++
    else if (s === 'breached' || s === 'burning') counts.bad++
    else counts.none++
  }
  const open = list.find((d) => d.id === openId) ?? null
  const openEval = rows.find((r) => r.def.id === openId)?.q?.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[12px] text-content-muted">Objectives evaluated live against Prometheus · multi-window burn-rate status</p>
        {serviceFilter ? (
          <button type="button" onClick={() => setServiceFilter(undefined)} title="Show all services" className="inline-flex h-7 items-center gap-1 rounded-md border border-brand-300 bg-brand-50 px-2 font-mono text-[11px] text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300">
            service={serviceFilter} <span aria-hidden>×</span>
          </button>
        ) : null}
        <div className="ml-auto">
          <Button size="sm" variant="primary" leading={<IconPlus />} onClick={() => setEditing('new')}>New SLO</Button>
        </div>
      </div>

      {defs.isLoading ? <LoadingCard label="Loading SLO definitions…" /> : defs.isError ? (
        <SourceError tool="Console database" error={defs.error} onRetry={() => defs.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<PrometheusIcon size={20} />}
          title="No SLOs defined yet"
          description="Define an availability (good/total requests) or latency (requests under a threshold) objective for a service. It's evaluated from Prometheus immediately and gets suggested burn-rate alerts."
          action={<Button size="sm" variant="primary" onClick={() => setEditing('new')}>Create an SLO</Button>}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Healthy" value={counts.healthy} tone={counts.healthy ? 'ok' : undefined} icon={counts.healthy ? <IconOk /> : undefined} hint={`of ${list.length} SLOs`} />
            <StatTile label="At risk" value={counts.risk} tone={counts.risk ? 'warn' : undefined} icon={counts.risk ? <IconWarn /> : undefined} hint="slow burn or < 25% budget left" />
            <StatTile label="Burning / exhausted" value={counts.bad} tone={counts.bad ? 'bad' : undefined} icon={counts.bad ? <IconBad /> : undefined} hint="fast burn or budget spent" />
            <StatTile label="No data" value={counts.none} hint="no events in the window yet" />
          </div>
          <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-200 text-left text-[12px]">
                <thead className="bg-surface-sunken/50 text-[10px] uppercase tracking-wider text-content-subtle">
                  <tr>
                    <th className="px-3 py-2">SLO</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Objective</th>
                    <th className="px-3 py-2 text-right">SLI</th>
                    <th className="w-44 px-3 py-2">Budget left</th>
                    <th className="px-3 py-2 text-right">Burn 1h</th>
                    <th className="px-3 py-2 text-right">6h</th>
                    <th className="px-3 py-2 text-right">1d</th>
                    <th className="px-3 py-2 text-right">3d</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {rows.map(({ def: d, q }) => {
                    const e = q?.data
                    return (
                      <tr key={d.id} className="cursor-pointer hover:bg-surface-sunken/40" onClick={() => setOpenId(d.id)}>
                        <td className="max-w-80 px-3 py-2">
                          <div className="truncate font-medium text-content">{d.name}</div>
                          <div className="truncate text-[11px] text-content-subtle">{d.service} · {d.sli.kind}</div>
                        </td>
                        <td className="px-3 py-2">
                          {q?.isLoading ? <Spinner size={12} /> : q?.isError ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-rose-700 dark:text-rose-300" title={(q.error as Error)?.message}><IconWarn /> query failed</span>
                          ) : e ? <StatusTag status={e.status} /> : null}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-content-muted">{d.objective}% · {d.windowDays}d</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-content">{pct(e?.sli, 3)}</td>
                        <td className="px-3 py-2"><BudgetBar remaining={e?.remaining ?? null} /></td>
                        {(['1h', '6h', '1d', '3d'] as const).map((w) => (
                          <td key={w} className={cn('px-3 py-2 text-right font-mono tabular-nums', (e?.burn[w] ?? 0) >= 6 ? 'font-semibold text-rose-700 dark:text-rose-300' : (e?.burn[w] ?? 0) >= 1 ? 'text-amber-700 dark:text-amber-300' : 'text-content-muted')}>
                            {burnFmt(e?.burn[w])}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <SlothList />

      {open ? (
        <SloDrawer
          def={open}
          ev={openEval}
          onClose={() => setOpenId(null)}
          onEdit={() => { setEditing(open); setOpenId(null) }}
          onDelete={() => setDeleting(open)}
        />
      ) : null}
      {editing ? <SloEditor initial={editing === 'new' ? null : editing} existing={list} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setOpenId(id) }} /> : null}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="The definition is removed from the console. Any PrometheusRule you applied from it stays in the cluster until you delete it there."
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              size="sm"
              variant="danger"
              loading={del.isPending}
              onClick={() => deleting && del.mutate(deleting.id, {
                onSuccess: () => {
                  toast.success('SLO deleted')
                  setDeleting(null)
                  setOpenId(null)
                },
                onError: (e) => toast.error('Could not delete SLO', { description: (e as Error).message }),
              })}
            >
              Delete
            </Button>
          </div>
        }
      >
        <span />
      </Modal>
    </div>
  )
}

function BudgetBar({ remaining }: { remaining: number | null }) {
  if (remaining == null) return <span className="font-mono text-[11px] text-content-subtle">—</span>
  const p = Math.max(0, Math.min(1, remaining))
  const color = remaining <= 0 ? 'bg-rose-500' : remaining < 0.25 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${p * 100}%` }} />
      </div>
      <span className="w-14 text-right font-mono text-[11px] tabular-nums text-content">{(remaining * 100).toFixed(0)}%</span>
    </div>
  )
}

/* ─────────────────────── detail ─────────────────────── */

function SloDrawer({ def, ev, onClose, onEdit, onDelete }: { def: SloDefinition; ev?: SloEval; onClose(): void; onEdit(): void; onDelete(): void }) {
  const toast = useToast()
  const bd = useSloBurnDown(def)
  const [sliRange, setSliRange] = useState(7 * 86400e3)
  const sli = useSliSeries(def, sliRange)
  const yaml = useMemo(() => alertRulesYaml(def), [def])
  const fmtDay = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
  const fmtTime = (t: number) => (sliRange > 2 * 86400e3 ? fmtDay(t) : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  const budget = errorBudget(def.objective)
  const ideal: Array<[number, number]> = bd.data ? [[bd.data.start, 100], [bd.data.end, 0]] : []
  return (
    <Drawer
      widthId="discover.slo"
      open
      onClose={onClose}
      width="max-w-5xl"
      title={def.name}
      badges={ev ? <StatusTag status={ev.status} /> : null}
      subtitle={`${def.service} · ${def.objective}% over ${def.windowDays} days · ${def.sli.kind}${def.description ? ` · ${def.description}` : ''}`}
      actions={<><Button size="sm" variant="ghost" onClick={onDelete}>Delete</Button><Button size="sm" onClick={onEdit}>Edit</Button></>}
    >
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label={`SLI · ${def.windowDays}d`} value={pct(ev?.sli, 3)} hint={`objective ${def.objective}%`} />
          <StatTile
            label="Budget left"
            value={ev?.remaining == null ? '—' : `${(ev.remaining * 100).toFixed(1)}%`}
            tone={ev?.remaining == null ? undefined : ev.remaining <= 0 ? 'bad' : ev.remaining < 0.25 ? 'warn' : 'ok'}
            hint={`budget = ${(budget * 100).toPrecision(3)}% of events`}
          />
          <StatTile label="Burn rate · 1h" value={burnFmt(ev?.burn['1h'])} hint="1× spends the budget exactly over the window" />
          <StatTile label="Burn rate · 6h" value={burnFmt(ev?.burn['6h'])} hint={ev?.firing.length ? `${ev.firing.length} policy window${ev.firing.length === 1 ? '' : 's'} breached` : 'no policy window breached'} />
        </div>

        <Panel
          title={`Error budget burn-down · last ${def.windowDays} days`}
        >
          {bd.isError ? <SourceError compact tool="Prometheus" error={bd.error} onRetry={() => bd.refetch()} /> : (
            <>
              <TimeSeriesChart
                height={180}
                series={[
                  // Clamped at 0 for the axis; overspend is reported in the Budget left tile.
                  { name: 'Budget remaining', points: (bd.data?.points ?? []).map(([t, v]) => [t, Math.max(0, v)] as [number, number]), color: 'var(--color-brand-500)' },
                  { name: 'Linear spend', points: ideal, color: 'var(--color-content-subtle)', dashed: true },
                ]}
                thresholds={[{ value: 0, label: 'exhausted', color: 'var(--color-rose-500)' }]}
                formatY={(v) => `${v.toFixed(0)}%`}
                formatTime={fmtDay}
                emptyLabel={bd.isLoading ? 'Computing burn-down…' : 'No events in the window'}
              />
              {bd.data?.firstData && bd.data.firstData > bd.data.start + 86400e3 ? (
                <p className="mt-1 text-[11px] text-content-subtle">Data starts {new Date(bd.data.firstData).toLocaleDateString()} — Prometheus retention or the metric is newer than the {def.windowDays}-day window, so the SLI covers less than the full window.</p>
              ) : null}
            </>
          )}
        </Panel>

        <Panel
          title="Error ratio · 1h rolling (SLI = 100% − this)"
          right={<Segmented size="xs" value={String(sliRange)} onChange={(v) => setSliRange(Number(v))} options={[{ id: String(86400e3), label: '24h' }, { id: String(7 * 86400e3), label: '7d' }, { id: String(def.windowDays * 86400e3), label: `${def.windowDays}d` }]} />}
        >
          {sli.isError ? <SourceError compact tool="Prometheus" error={sli.error} onRetry={() => sli.refetch()} /> : (
            <TimeSeriesChart
              height={160}
              series={[{ name: 'Error ratio', points: sli.data ?? [] }]}
              thresholds={[{ value: 100 - def.objective, label: `budget ${(100 - def.objective).toPrecision(2)}%`, color: 'var(--color-amber-500)' }]}
              formatY={(v) => `${v < 1 ? v.toFixed(3) : v.toFixed(1)}%`}
              formatTime={fmtTime}
              emptyLabel={sli.isLoading ? 'Loading…' : 'No events'}
            />
          )}
        </Panel>

        <Panel title="Burn rates · multi-window policy">
          <div className="overflow-x-auto">
            <table className="w-full min-w-140 text-left text-[12px]">
              <thead className="text-[10px] uppercase tracking-wider text-content-subtle">
                <tr><th className="py-1.5 pr-3">Severity</th><th className="py-1.5 pr-3">Long window</th><th className="py-1.5 pr-3">Short window</th><th className="py-1.5 pr-3 text-right">Threshold</th><th className="py-1.5 pr-3">Spends</th><th className="py-1.5">State</th></tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {BURN_POLICY.map((p) => {
                  const f = policyFactor(p.factor, def.windowDays)
                  const firing = ev?.firing.includes(p)
                  return (
                    <tr key={`${p.long}-${p.short}`}>
                      <td className="py-1.5 pr-3 capitalize text-content">{p.severity === 'critical' ? 'page' : 'ticket'}</td>
                      <td className="py-1.5 pr-3 font-mono text-content-muted">{p.long} · {burnFmt(ev?.burn[p.long])}</td>
                      <td className="py-1.5 pr-3 font-mono text-content-muted">{p.short} · {burnFmt(ev?.burn[p.short])}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-content-muted">&gt; {f}×</td>
                      <td className="py-1.5 pr-3 text-[11px] text-content-subtle">{p.budget}</td>
                      <td className="py-1.5">
                        {firing ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-700 dark:text-rose-300"><IconBad /> would fire</span> : <span className="inline-flex items-center gap-1 text-[11px] text-content-muted"><IconOk /> quiet</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="Generated PromQL · error ratio"
          right={<button type="button" className="inline-flex items-center gap-1 text-[11px] text-content-muted hover:text-content" onClick={() => { copyText(errorRatioExpr(def, '5m')); toast.success('PromQL copied') }}><IconCopy /> Copy</button>}
        >
          <pre className="whitespace-pre-wrap break-all rounded-md bg-code p-3 font-mono text-[11px] leading-relaxed text-code-fg">{errorRatioExpr(def, '$window')}</pre>
        </Panel>

        <Panel
          title="Suggested alerting · PrometheusRule"
          right={
            <div className="flex items-center gap-3">
              <button type="button" className="inline-flex items-center gap-1 text-[11px] text-content-muted hover:text-content" onClick={() => { copyText(yaml); toast.success('PrometheusRule copied') }}><IconCopy /> Copy</button>
              <button
                type="button"
                className="text-[11px] text-content-muted hover:text-content"
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }))
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `slo-${slugify(def.id)}.yaml`
                  a.click()
                  URL.revokeObjectURL(url)
                }}
              >
                Download
              </button>
            </div>
          }
        >
          <InlineHint>
            Seven recording rules (error ratio over 5m…3d) plus two page and two ticket alerts, using the SRE-workbook multi-window multi-burn-rate thresholds scaled to a {def.windowDays}-day window. Apply with <code className="font-mono">kubectl apply -f</code> or commit it to your GitOps repo; the <code className="font-mono">release: prometheus</code> label lets the operator pick it up.
          </InlineHint>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre rounded-md bg-code p-3 font-mono text-[11px] leading-relaxed text-code-fg">{yaml}</pre>
        </Panel>
      </div>
    </Drawer>
  )
}

/* ─────────────────────── editor ─────────────────────── */

interface Preset {
  label: string
  kind: SliKind
  metric: string
  selector: string
  errorSelector?: string
  threshold?: string
}

const PRESETS: Record<string, Preset[]> = {
  hubble_http_requests_total: [
    { label: 'Hubble · availability', kind: 'availability', metric: 'hubble_http_requests_total', selector: 'namespace="adhar-system"', errorSelector: 'status=~"5.."' },
    { label: 'Hubble · latency', kind: 'latency', metric: 'hubble_http_request_duration_seconds', selector: 'namespace="adhar-system"', threshold: '0.5' },
  ],
  nginx_ingress_controller_requests: [
    { label: 'NGINX ingress · availability', kind: 'availability', metric: 'nginx_ingress_controller_requests', selector: 'service="my-service"', errorSelector: 'status=~"5.."' },
    { label: 'NGINX ingress · latency', kind: 'latency', metric: 'nginx_ingress_controller_request_duration_seconds', selector: 'service="my-service"', threshold: '0.5' },
  ],
  http_requests_total: [
    { label: 'App http_requests_total · availability', kind: 'availability', metric: 'http_requests_total', selector: 'service="my-service"', errorSelector: 'code=~"5.."' },
    { label: 'App histogram · latency', kind: 'latency', metric: 'http_request_duration_seconds', selector: 'service="my-service"', threshold: '0.3' },
  ],
  http_server_requests_seconds_count: [
    { label: 'Spring · availability', kind: 'availability', metric: 'http_server_requests_seconds_count', selector: 'job="my-app"', errorSelector: 'status=~"5.."' },
  ],
}

function blank(): SloDefinition {
  return {
    id: '',
    name: '',
    service: '',
    objective: 99.9,
    windowDays: 30,
    sli: { kind: 'availability', metric: 'http_requests_total', selector: '', errorSelector: 'code=~"5.."' },
  }
}

function SloEditor({ initial, existing, onClose, onSaved }: { initial: SloDefinition | null; existing: SloDefinition[]; onClose(): void; onSaved(id: string): void }) {
  const toast = useToast()
  const save = useSaveSlo()
  const sources = useTelemetrySources()
  const [d, setD] = useState<SloDefinition>(() => initial ? structuredClone(initial) : blank())
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'done' | 'error'; msg?: string }>({ state: 'idle' })
  const set = (patch: Partial<SloDefinition>) => setD((cur) => ({ ...cur, ...patch }))
  const setSli = (patch: Record<string, string>) => setD((cur) => ({ ...cur, sli: { ...cur.sli, ...patch } as SloDefinition['sli'] }))
  const problems = validateSlo(d)
  const id = initial?.id ?? slugify(`${d.service}-${d.name}`)
  const clash = !initial && existing.some((x) => x.id === id)
  if (clash) problems.push('An SLO with this service and name already exists.')
  const le = useLeBuckets(d.sli.kind === 'latency' ? d.sli.metric : '', d.sli.kind === 'latency' ? d.sli.selector : '', d.sli.kind === 'latency')
  const presets = (sources.data ?? []).flatMap((s) => PRESETS[s.metric] ?? [])
  const inputCls = 'w-full rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none'

  const changeKind = (kind: SliKind) => {
    if (kind === d.sli.kind) return
    if (kind === 'availability') setD((c) => ({ ...c, sli: { kind, metric: 'http_requests_total', selector: '', errorSelector: 'code=~"5.."' } }))
    else if (kind === 'latency') setD((c) => ({ ...c, sli: { kind, metric: 'http_request_duration_seconds', selector: '', threshold: '0.3' } }))
    else setD((c) => ({ ...c, sli: { kind, errorQuery: 'sum(rate(http_requests_total{code=~"5.."}[$window]))', totalQuery: 'sum(rate(http_requests_total[$window]))' } }))
    setTest({ state: 'idle' })
  }

  const runTest = async () => {
    setTest({ state: 'running' })
    try {
      const r = await testSlo({ ...d, id })
      if (r.totalRate == null || r.totalRate === 0) {
        setTest({ state: 'error', msg: 'No events: the total query returns no samples (or zero rate) right now. Check the metric name and selector.' })
      } else {
        setTest({ state: 'done', msg: `${r.totalRate.toFixed(r.totalRate < 10 ? 3 : 1)} events/s now · error ratio over 1h ${r.errorRatio1h == null ? 'n/a' : `${(r.errorRatio1h * 100).toFixed(3)}%`} → SLI ${r.errorRatio1h == null ? 'n/a' : `${((1 - r.errorRatio1h) * 100).toFixed(3)}%`}` })
      }
    } catch (e) {
      setTest({ state: 'error', msg: (e as Error).message })
    }
  }

  const submit = () => {
    if (problems.length) return
    const now = new Date().toISOString()
    const def: SloDefinition = { ...d, id, createdAt: initial?.createdAt ?? now, updatedAt: now }
    save.mutate(def, {
      onSuccess: () => {
        toast.success(initial ? 'SLO updated' : 'SLO created', { description: `${def.name} · ${def.objective}% over ${def.windowDays}d` })
        onSaved(id)
      },
      onError: (e) => toast.error('Could not save SLO', { description: (e as Error).message }),
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      title={initial ? `Edit ${initial.name}` : 'New SLO'}
      description="The indicator is turned into PromQL and evaluated against Prometheus; the definition is saved to the console."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={runTest} loading={test.state === 'running'} disabled={validateSlo(d).some((p) => !/Name|Service/.test(p))}>Test query</Button>
          <Button size="sm" variant="primary" onClick={submit} disabled={problems.length > 0} loading={save.isPending}>{initial ? 'Save' : 'Create SLO'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Checkout availability" className={inputCls} /></Field>
          <Field label="Service"><input value={d.service} onChange={(e) => set({ service: e.target.value })} placeholder="checkout" disabled={!!initial} className={inputCls} /></Field>
        </div>
        <Field label="Description (optional)"><input value={d.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="Requests served without a 5xx" className={inputCls} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Objective">
            <div className="flex flex-wrap items-center gap-1">
              {[99, 99.5, 99.9, 99.95, 99.99].map((o) => (
                <button key={o} type="button" onClick={() => set({ objective: o })} className={cn('h-8 rounded-md border px-2.5 font-mono text-[11px]', d.objective === o ? 'border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default text-content-muted hover:text-content')}>{o}%</button>
              ))}
              <input type="number" step="0.01" min="1" max="99.999" value={d.objective} onChange={(e) => set({ objective: Number(e.target.value) })} aria-label="Custom objective" className={cn(inputCls, 'w-24 font-mono')} />
            </div>
          </Field>
          <Field label="Window">
            <Segmented value={String(d.windowDays)} onChange={(v) => set({ windowDays: Number(v) })} options={[{ id: '7', label: '7 days' }, { id: '28', label: '28 days' }, { id: '30', label: '30 days' }]} />
          </Field>
        </div>

        <div className="space-y-2 rounded-lg border border-edge-subtle p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-content">Indicator</span>
            <Segmented size="xs" value={d.sli.kind} onChange={changeKind} options={[{ id: 'availability', label: 'Availability' }, { id: 'latency', label: 'Latency' }, { id: 'custom', label: 'Custom PromQL' }]} />
            {presets.length ? (
              <select
                aria-label="Start from a detected metric"
                value=""
                onChange={(e) => {
                  const p = presets[Number(e.target.value)]
                  if (!p) return
                  if (p.kind === 'availability') setD((c) => ({ ...c, sli: { kind: 'availability', metric: p.metric, selector: p.selector, errorSelector: p.errorSelector ?? '' } }))
                  else setD((c) => ({ ...c, sli: { kind: 'latency', metric: p.metric, selector: p.selector, threshold: p.threshold ?? '0.3' } }))
                }}
                className="ml-auto h-7 rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] text-content-muted"
              >
                <option value="">Start from a detected metric…</option>
                {presets.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
              </select>
            ) : null}
          </div>
          {d.sli.kind === 'availability' ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Request counter"><input value={d.sli.metric} onChange={(e) => setSli({ metric: e.target.value })} className={cn(inputCls, 'font-mono')} /></Field>
              <Field label="Selector"><input value={d.sli.selector} onChange={(e) => setSli({ selector: e.target.value })} placeholder='namespace="shop"' className={cn(inputCls, 'font-mono')} /></Field>
              <Field label="Error events"><input value={d.sli.errorSelector} onChange={(e) => setSli({ errorSelector: e.target.value })} placeholder='code=~"5.."' className={cn(inputCls, 'font-mono')} /></Field>
            </div>
          ) : d.sli.kind === 'latency' ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Histogram (base name)"><input value={d.sli.metric} onChange={(e) => setSli({ metric: e.target.value })} className={cn(inputCls, 'font-mono')} /></Field>
              <Field label="Selector"><input value={d.sli.selector} onChange={(e) => setSli({ selector: e.target.value })} placeholder='job="api"' className={cn(inputCls, 'font-mono')} /></Field>
              <Field label="Good if ≤ (le bucket, seconds)">
                {le.data?.length ? (
                  <select value={d.sli.threshold} onChange={(e) => setSli({ threshold: e.target.value })} className={cn(inputCls, 'font-mono')}>
                    {!le.data.includes(d.sli.threshold) ? <option value={d.sli.threshold}>{d.sli.threshold} (not a bucket)</option> : null}
                    {le.data.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                ) : (
                  <input value={d.sli.threshold} onChange={(e) => setSli({ threshold: e.target.value })} className={cn(inputCls, 'font-mono')} />
                )}
              </Field>
            </div>
          ) : (
            <div className="grid gap-2">
              <Field label="Bad events ($window = range)"><textarea rows={2} value={d.sli.errorQuery} onChange={(e) => setSli({ errorQuery: e.target.value })} className={cn(inputCls, 'font-mono')} /></Field>
              <Field label="All events ($window = range)"><textarea rows={2} value={d.sli.totalQuery} onChange={(e) => setSli({ totalQuery: e.target.value })} className={cn(inputCls, 'font-mono')} /></Field>
            </div>
          )}
          <pre className="whitespace-pre-wrap break-all rounded-md bg-surface-sunken px-2.5 py-2 font-mono text-[10px] text-content-muted">{errorRatioExpr({ ...d, id }, '5m')}</pre>
          {d.sli.kind === 'latency' && le.data && !le.data.length ? <p className="text-[11px] text-content-subtle">No <code className="font-mono">{d.sli.metric}_bucket</code> series match this selector.</p> : null}
          {test.state === 'done' ? <p className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300"><IconOk /> {test.msg}</p> : null}
          {test.state === 'error' ? <p className="inline-flex items-start gap-1 text-[11px] text-rose-700 dark:text-rose-300"><IconWarn /> {test.msg}</p> : null}
        </div>
        {problems.length && (d.name || d.service) ? <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-content-muted">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] font-medium text-content-muted">{label}</span>
      {children}
    </label>
  )
}

/* ─────────────────────── Sloth ─────────────────────── */

function SlothList() {
  const q = useSlothSlos()
  if (!q.data?.length) return null
  return (
    <Panel title={`Detected in Prometheus · Sloth · ${q.data.length}`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-140 text-left text-[12px]">
          <thead className="text-[10px] uppercase tracking-wider text-content-subtle">
            <tr><th className="py-1.5 pr-3">Service / SLO</th><th className="py-1.5 pr-3 text-right">Objective</th><th className="w-44 py-1.5 pr-3">Budget left</th><th className="py-1.5 text-right">Burn now</th></tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {q.data.map((s) => (
              <tr key={`${s.service}/${s.slo}`}>
                <td className="py-1.5 pr-3 font-mono text-content">{s.service} / {s.slo}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-content-muted">{s.objective == null ? '—' : `${(s.objective * 100).toPrecision(4)}%`}</td>
                <td className="py-1.5 pr-3"><BudgetBar remaining={s.remaining} /></td>
                <td className="py-1.5 text-right font-mono text-content-muted">{burnFmt(s.burn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-content-subtle">Read-only — these come from Sloth recording rules; edit them in their PrometheusServiceLevel sources.</p>
    </Panel>
  )
}
