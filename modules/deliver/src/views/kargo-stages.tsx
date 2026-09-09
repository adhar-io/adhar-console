import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  Spinner,
  StatusBadge,
  useToast,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar-console/utils'
import type { kargo } from '@adhar-console/api-clients'
import {
  useAbortPromotion,
  useApproveFreight,
  useFreight,
  usePromote,
  usePromotions,
  useRefreshStage,
  useRefreshWarehouse,
  useStages,
  useWarehouses,
} from '../data/delivery.ts'

const PHASE_KIND: Record<string, StatusKind> = {
  Steady: 'healthy',
  Promoting: 'progressing',
  Verifying: 'progressing',
  Pending: 'info',
  Failed: 'failed',
  Erroring: 'failed',
  NotApplicable: 'unknown',
  Unknown: 'unknown',
}
const HEALTH_KIND: Record<string, StatusKind> = {
  Healthy: 'healthy',
  Unhealthy: 'degraded',
  Progressing: 'progressing',
  Unknown: 'unknown',
}
const PROMO_KIND: Record<string, StatusKind> = {
  Succeeded: 'healthy',
  Running: 'progressing',
  Pending: 'info',
  Failed: 'failed',
  Errored: 'failed',
  Aborted: 'paused',
  Unknown: 'unknown',
}
const HEALTH_HEX: Record<string, string> = {
  Healthy: 'var(--color-emerald-500)',
  Progressing: 'var(--color-indigo-500)',
  Unhealthy: 'var(--color-rose-500)',
  Unknown: 'var(--color-slate-400)',
}

/**
 * Kargo promotion pipeline — everything the `kargo` CLI and dashboard expose
 * for a project, on one page, all read from and written to the Kargo CRDs
 * through the console's Kubernetes gateway (the signed-in user's RBAC applies):
 *
 *  - a stats strip (stages by phase, verification, freight, running / failed
 *    promotions) whose tiles filter the pipeline;
 *  - the pipeline laid out by dependency depth (warehouse-fed stages first,
 *    then each downstream tier), with health rail, phase, current freight and
 *    its artifacts, verification result, last promotion outcome, and issues;
 *  - warehouses with their subscriptions, discovery interval, last freight and
 *    a "Discover now" action;
 *  - the freight inventory with search, warehouse filter, where each bundle is
 *    live / verified / approved, and manual approval for a stage;
 *  - promotion history with abort for running promotions.
 */
export function KargoStages() {
  const stages = useStages()
  const freight = useFreight()
  const warehouses = useWarehouses()
  const promotions = usePromotions()
  const promote = usePromote()
  const abort = useAbortPromotion()
  const approve = useApproveFreight()
  const refreshWarehouse = useRefreshWarehouse()
  const refreshStage = useRefreshStage()
  const toast = useToast()
  const [promoteFor, setPromoteFor] = useState<kargo.Stage | null>(null)
  const [approveFor, setApproveFor] = useState<kargo.Freight | null>(null)
  const [phaseF, setPhaseF] = useState<'all' | 'attention' | 'active' | 'steady'>('all')
  const [search, setSearch] = useState('')
  const [warehouseF, setWarehouseF] = useState('all')

  const stageList = useMemo(() => stages.data ?? [], [stages.data])
  const freightList = useMemo(() => freight.data ?? [], [freight.data])
  const warehouseList = useMemo(() => warehouses.data ?? [], [warehouses.data])
  const promotionList = useMemo(() => promotions.data ?? [], [promotions.data])

  const stats = useMemo(() => {
    const s = { steady: 0, active: 0, failed: 0, unhealthy: 0, verifying: 0, running: 0, failedPromos: 0 }
    for (const st of stageList) {
      if (st.phase === 'Steady') s.steady++
      if (st.phase === 'Promoting' || st.phase === 'Verifying' || st.phase === 'Pending') s.active++
      if (st.phase === 'Failed' || st.phase === 'Erroring') s.failed++
      if (st.health === 'Unhealthy') s.unhealthy++
      if (st.verification?.phase === 'Running' || st.verification?.phase === 'Pending') s.verifying++
    }
    for (const p of promotionList) {
      if (p.phase === 'Running' || p.phase === 'Pending') s.running++
      if (p.phase === 'Failed' || p.phase === 'Errored') s.failedPromos++
    }
    return s
  }, [stageList, promotionList])

  /** Stages arranged in dependency tiers: warehouse-fed first, then downstream. */
  const tiers = useMemo(() => {
    const byName = new Map(stageList.map((s) => [s.name, s]))
    const depth = new Map<string, number>()
    const visit = (name: string, seen: Set<string>): number => {
      if (depth.has(name)) return depth.get(name)!
      if (seen.has(name)) return 0
      seen.add(name)
      const s = byName.get(name)
      const up = (s?.upstream ?? []).filter((u) => byName.has(u))
      const d = up.length ? 1 + Math.max(...up.map((u) => visit(u, seen))) : 0
      depth.set(name, d)
      return d
    }
    for (const s of stageList) visit(s.name, new Set())
    const groups = new Map<number, kargo.Stage[]>()
    for (const s of stageList) {
      const d = depth.get(s.name) ?? 0
      ;(groups.get(d) ?? groups.set(d, []).get(d)!).push(s)
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([d, list]) => ({ depth: d, stages: list.sort((a, b) => a.name.localeCompare(b.name)) }))
  }, [stageList])

  const visibleStage = (s: kargo.Stage) => {
    if (phaseF === 'attention') return s.phase === 'Failed' || s.phase === 'Erroring' || s.health === 'Unhealthy' || (s.issues?.length ?? 0) > 0
    if (phaseF === 'active') return s.phase === 'Promoting' || s.phase === 'Verifying' || s.phase === 'Pending' || !!s.currentPromotion
    if (phaseF === 'steady') return s.phase === 'Steady'
    return true
  }

  const filteredFreight = useMemo(() => {
    const f = search.trim().toLowerCase()
    return freightList.filter((fr) => {
      if (warehouseF !== 'all' && fr.warehouse !== warehouseF) return false
      if (!f) return true
      return (
        fr.id.toLowerCase().includes(f) ||
        (fr.alias ?? '').toLowerCase().includes(f) ||
        fr.images.some((i) => `${i.repoURL}:${i.tag}`.toLowerCase().includes(f)) ||
        (fr.commits ?? []).some((c) => c.id.toLowerCase().includes(f) || (c.message ?? '').toLowerCase().includes(f)) ||
        (fr.charts ?? []).some((c) => `${c.name ?? ''}${c.version}`.toLowerCase().includes(f))
      )
    })
  }, [freightList, search, warehouseF])

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      toast.success(label)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label} failed`)
    }
  }

  if (stages.isLoading || freight.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading Kargo…
      </div>
    )
  }
  if (stages.isError) {
    return <EmptyState title="Couldn't reach Kargo" description={stages.error instanceof Error ? stages.error.message : 'The Kargo CRDs are not readable with your access.'} />
  }

  return (
    <div className="space-y-5">
      {/* ── stats strip (tiles filter the pipeline) ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        <StatTile label="Stages" value={stageList.length} active={phaseF === 'all'} onClick={() => setPhaseF('all')} />
        <StatTile label="Steady" value={stats.steady} tone="healthy" active={phaseF === 'steady'} onClick={() => setPhaseF(phaseF === 'steady' ? 'all' : 'steady')} />
        <StatTile label="Promoting / verifying" value={stats.active} tone={stats.active ? 'progressing' : undefined} active={phaseF === 'active'} onClick={() => setPhaseF(phaseF === 'active' ? 'all' : 'active')} />
        <StatTile label="Needs attention" value={stats.failed + stats.unhealthy} tone={stats.failed + stats.unhealthy ? 'failed' : undefined} active={phaseF === 'attention'} onClick={() => setPhaseF(phaseF === 'attention' ? 'all' : 'attention')} hint={stats.unhealthy ? `${stats.unhealthy} unhealthy` : undefined} />
        <StatTile label="Freight" value={freightList.length} hint={`${warehouseList.length} warehouse${warehouseList.length === 1 ? '' : 's'}`} />
        <StatTile label="Promotions running" value={stats.running} tone={stats.running ? 'progressing' : undefined} />
        <StatTile label="Promotions failed" value={stats.failedPromos} tone={stats.failedPromos ? 'failed' : undefined} hint="last 100" />
      </div>

      {/* ── pipeline ── */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-content">Promotion pipeline</h2>
          <span className="text-[11px] text-content-subtle">tiers follow upstream subscriptions · newest freight flows left → right</span>
        </div>
        {stageList.length === 0 ? (
          <EmptyState compact title="No stages yet" description="Create Kargo Stages in this project to build a promotion pipeline." />
        ) : (
          <div className="overflow-x-auto pb-2">
            <div className="flex items-start gap-3">
              {tiers.map((tier, i) => (
                <div key={tier.depth} className="flex items-start gap-3">
                  <div className="flex flex-col gap-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                      {tier.depth === 0 ? 'from warehouse' : `tier ${tier.depth}`}
                    </div>
                    {tier.stages.map((s) => (
                      <StageCard
                        key={s.name}
                        stage={s}
                        dimmed={!visibleStage(s)}
                        freightList={freightList}
                        promotions={promotionList}
                        onPromote={() => setPromoteFor(s)}
                        onRefresh={() => act(`Refresh requested for ${s.name}.`, () => refreshStage.mutateAsync({ stage: s.name }))}
                        onAbort={s.currentPromotion ? () => act(`Abort requested for ${s.currentPromotion}.`, () => abort.mutateAsync({ promotion: s.currentPromotion! })) : undefined}
                      />
                    ))}
                  </div>
                  {i < tiers.length - 1 ? <FlowArrow /> : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── warehouses ── */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-content">Warehouses</h2>
          <span className="text-[11px] text-content-subtle">{warehouseList.length} watching artifact sources</span>
        </div>
        {warehouses.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Loading warehouses…</div>
        ) : warehouseList.length === 0 ? (
          <EmptyState compact title="No warehouses" description="A Warehouse subscribes to images, git repos or charts and produces Freight." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {warehouseList.map((w) => (
              <Card key={w.name} className={cn(w.issues?.length && 'border-rose-200/70 dark:border-rose-500/30')}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-content">{w.name}</div>
                      <div className="text-[11px] text-content-subtle">
                        {w.interval ? `every ${w.interval}` : 'on demand'}
                        {w.lastDiscovered ? ` · discovered ${formatRelative(w.lastDiscovered)}` : ''}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => act(`Discovery requested for ${w.name}.`, () => refreshWarehouse.mutateAsync({ warehouse: w.name }))} loading={refreshWarehouse.isPending && refreshWarehouse.variables?.warehouse === w.name}>
                      Discover now
                    </Button>
                  </div>
                </CardHeader>
                <CardBody className="space-y-2 text-[12px]">
                  <ul className="space-y-1">
                    {w.subscriptions.map((s, i) => (
                      <li key={i} className="flex items-center gap-2 font-mono text-[11px]">
                        <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-content-muted">{s.kind}</span>
                        <span className="truncate text-content-muted" title={s.repoURL}>{s.repoURL.replace(/^https?:\/\//, '')}</span>
                        {s.selector ? <span className="shrink-0 text-content-subtle">{s.selector}</span> : null}
                      </li>
                    ))}
                  </ul>
                  <div className="text-[11px] text-content-subtle">
                    last freight{' '}
                    {w.lastFreight ? (
                      <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-content">{freightList.find((f) => f.id === w.lastFreight)?.alias ?? w.lastFreight.slice(0, 12)}</code>
                    ) : '—'}
                  </div>
                  {w.issues?.length ? <p className="text-[11px] text-rose-700 dark:text-rose-300">{w.issues.join(' · ')}</p> : null}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── freight inventory ── */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-content">Freight inventory</h2>
          <span className="text-[11px] text-content-subtle">{filteredFreight.length === freightList.length ? `${freightList.length} bundle${freightList.length === 1 ? '' : 's'}` : `${filteredFreight.length} of ${freightList.length}`}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search alias, id, image tag, commit…"
              aria-label="Search freight"
              className="h-8 w-64 rounded-lg border border-edge-default bg-surface-app px-2.5 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
            {warehouseList.length > 1 ? (
              <select value={warehouseF} onChange={(e) => setWarehouseF(e.target.value)} aria-label="Warehouse" className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content-muted focus:outline-none">
                <option value="all">Warehouse: all</option>
                {warehouseList.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
            ) : null}
          </div>
        </div>
        {filteredFreight.length === 0 ? (
          <EmptyState compact title={freightList.length === 0 ? 'No freight' : 'No matches'} />
        ) : (
          <Card>
            <CardBody className="p-0!">
              <ul className="divide-y divide-edge-subtle">
                {filteredFreight.map((f) => (
                  <FreightRow key={f.id} freight={f} stages={stageList} onApprove={() => setApproveFor(f)} />
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </section>

      {/* ── promotion history ── */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-content">Promotions</h2>
          <span className="text-[11px] text-content-subtle">newest first · last 100</span>
        </div>
        {promotions.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Loading promotions…</div>
        ) : promotionList.length === 0 ? (
          <EmptyState compact title="No promotions yet" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
            <table className="w-full text-[12px]">
              <thead className="bg-surface-sunken/50 text-[10px] uppercase tracking-wider text-content-subtle">
                <tr>
                  <th className="px-3 py-2 text-left">Stage</th>
                  <th className="px-3 py-2 text-left">Freight</th>
                  <th className="px-3 py-2 text-left">Phase</th>
                  <th className="px-3 py-2 text-left">Started</th>
                  <th className="px-3 py-2 text-left">Finished</th>
                  <th className="px-3 py-2 text-left">Message</th>
                  <th className="px-3 py-2 text-right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {promotionList.map((p) => {
                  const fr = freightList.find((f) => f.id === p.freight)
                  const running = p.phase === 'Running' || p.phase === 'Pending'
                  return (
                    <tr key={p.name} className="hover:bg-surface-sunken/40">
                      <td className="px-3 py-2 font-semibold text-content">{p.stage}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-content-muted" title={p.freight}>{fr?.alias ?? p.freight.slice(0, 12)}</td>
                      <td className="px-3 py-2"><StatusBadge kind={PROMO_KIND[p.phase] ?? 'unknown'}>{p.phase}</StatusBadge></td>
                      <td className="px-3 py-2 text-content-muted" title={formatAbsolute(p.created)}>{formatRelative(p.created)}</td>
                      <td className="px-3 py-2 text-content-muted" title={p.finished ? formatAbsolute(p.finished) : ''}>{p.finished ? formatRelative(p.finished) : running ? <span className="inline-flex items-center gap-1"><Spinner size={10} /> in progress</span> : '—'}</td>
                      <td className="max-w-md px-3 py-2"><div className="line-clamp-2 text-[11px] text-content-muted" title={p.message}>{p.message ?? '—'}</div></td>
                      <td className="px-3 py-2 text-right">
                        {running ? (
                          <Button size="sm" variant="secondary" onClick={() => act(`Abort requested for ${p.name}.`, () => abort.mutateAsync({ promotion: p.name }))} loading={abort.isPending && abort.variables?.promotion === p.name}>
                            Abort
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {promoteFor ? (
        <PromoteModal
          stage={promoteFor}
          freight={freightList}
          onClose={() => setPromoteFor(null)}
          onPromote={(freightId) => act(`Promotion of ${freightList.find((f) => f.id === freightId)?.alias ?? freightId} to ${promoteFor.name} requested.`, () => promote.mutateAsync({ stage: promoteFor.name, freight: freightId }))}
          loading={promote.isPending}
        />
      ) : null}

      {approveFor ? (
        <ApproveModal
          freight={approveFor}
          stages={stageList}
          onClose={() => setApproveFor(null)}
          onApprove={(stage) => act(`${approveFor.alias ?? approveFor.id} approved for ${stage}.`, () => approve.mutateAsync({ freight: approveFor.id, stage }))}
          loading={approve.isPending}
        />
      ) : null}
    </div>
  )
}

/* ─────────── pieces ─────────── */

function StatTile({ label, value, hint, tone, active = false, onClick }: { label: string; value: number | string; hint?: string; tone?: StatusKind; active?: boolean; onClick?(): void }) {
  const toneText: Record<string, string> = {
    healthy: 'text-emerald-600 dark:text-emerald-300',
    degraded: 'text-amber-600 dark:text-amber-300',
    failed: 'text-rose-600 dark:text-rose-300',
    progressing: 'text-indigo-600 dark:text-indigo-300',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
        active && onClick ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised',
        onClick ? 'hover:border-edge-strong' : 'cursor-default',
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <span className={cn('text-xl font-semibold leading-none tabular-nums tracking-tight', tone ? toneText[tone] : 'text-content')}>{value}</span>
      {hint ? <span className="truncate text-[10.5px] text-content-subtle">{hint}</span> : null}
    </button>
  )
}

function StageCard({
  stage: s,
  dimmed,
  freightList,
  promotions,
  onPromote,
  onRefresh,
  onAbort,
}: {
  stage: kargo.Stage
  dimmed: boolean
  freightList: kargo.Freight[]
  promotions: kargo.Promotion[]
  onPromote(): void
  onRefresh(): void
  onAbort?(): void
}) {
  const tone = PHASE_KIND[s.phase] ?? 'unknown'
  const current = freightList.find((f) => f.id === s.currentFreight)
  const lastPromo = promotions.find((p) => p.stage === s.name)
  const busy = s.phase === 'Promoting' || s.phase === 'Verifying' || !!s.currentPromotion
  return (
    <Card className={cn('relative w-[300px] shrink-0 overflow-hidden transition-opacity', dimmed && 'opacity-35')}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: HEALTH_HEX[s.health ?? 'Unknown'] }} />
      <CardHeader>
        <div className="flex items-start justify-between gap-2 pl-1">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-content">{s.name}</div>
            <div className="truncate text-[11px] text-content-subtle">
              {s.upstream?.length ? `← ${s.upstream.join(', ')}` : s.warehouse ? `← warehouse ${s.warehouse}` : 'no upstream'}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusBadge kind={tone}>{busy ? <span className="inline-flex items-center gap-1"><Spinner size={9} /> {s.phase}</span> : s.phase}</StatusBadge>
            {s.health ? <StatusBadge kind={HEALTH_KIND[s.health] ?? 'unknown'}>{s.health}</StatusBadge> : null}
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-3 pl-4 text-[12px]">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Current freight</div>
          {current ? (
            <div className="mt-1 space-y-1">
              <div className="flex items-center gap-1.5">
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">{current.alias ?? current.id.slice(0, 12)}</code>
                <span className="text-[10.5px] text-content-subtle" title={formatAbsolute(current.created)}>{formatRelative(current.created)}</span>
              </div>
              {current.images.map((img, i) => (
                <div key={i} className="truncate font-mono text-[11px] text-content-muted" title={`${img.repoURL}:${img.tag}`}>
                  {img.repoURL.replace(/^https?:\/\//, '').split('/').slice(-1)[0]}:<span className="text-content">{img.tag}</span>
                </div>
              ))}
              {(current.commits ?? []).slice(0, 1).map((c, i) => (
                <div key={i} className="truncate font-mono text-[11px] text-content-muted" title={c.message}>{c.id.slice(0, 8)}{c.message ? ` ${c.message}` : ''}</div>
              ))}
              {(current.charts ?? []).map((c, i) => (
                <div key={i} className="truncate font-mono text-[11px] text-content-muted">{c.name ?? 'chart'}@{c.version}</div>
              ))}
            </div>
          ) : (
            <span className="text-content-subtle">none yet</span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <div className="text-content-subtle">Last promoted</div>
          <div className="text-content" title={s.lastPromoted ? formatAbsolute(s.lastPromoted) : ''}>{s.lastPromoted ? formatRelative(s.lastPromoted) : '—'}</div>
          <div className="text-content-subtle">Last result</div>
          <div>{s.lastPromotionPhase ?? lastPromo?.phase ? <StatusBadge kind={PROMO_KIND[s.lastPromotionPhase ?? lastPromo!.phase] ?? 'unknown'}>{s.lastPromotionPhase ?? lastPromo!.phase}</StatusBadge> : <span className="text-content-subtle">—</span>}</div>
          <div className="text-content-subtle">Verification</div>
          <div>
            {s.verification ? (
              <span className="inline-flex items-center gap-1" title={s.verification.message}>
                <StatusBadge kind={s.verification.phase === 'Successful' ? 'healthy' : s.verification.phase === 'Failed' || s.verification.phase === 'Error' ? 'failed' : s.verification.phase === 'Running' || s.verification.phase === 'Pending' ? 'progressing' : 'unknown'}>{s.verification.phase}</StatusBadge>
                {s.verification.finishTime ?? s.verification.startTime ? <span className="text-content-subtle">{formatRelative(s.verification.finishTime ?? s.verification.startTime!)}</span> : null}
              </span>
            ) : (
              <span className="text-content-subtle">none</span>
            )}
          </div>
        </div>

        {s.issues?.length || s.message ? (
          <p className="line-clamp-3 text-[11px] text-rose-700 dark:text-rose-300" title={(s.issues ?? [s.message!]).join('\n')}>{(s.issues ?? [s.message!]).join(' · ')}</p>
        ) : null}

        <div className="flex items-center gap-1.5">
          {onAbort ? (
            <Button size="sm" variant="secondary" onClick={onAbort}>Abort</Button>
          ) : (
            <Button size="sm" onClick={onPromote} disabled={freightList.length === 0}>Promote…</Button>
          )}
          <Button size="sm" variant="ghost" onClick={onRefresh}>Refresh</Button>
        </div>
      </CardBody>
    </Card>
  )
}

function FlowArrow() {
  return (
    <div className="flex shrink-0 items-center self-center pt-6" aria-hidden>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-content-subtle)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
    </div>
  )
}

function FreightRow({ freight: f, stages, onApprove }: { freight: kargo.Freight; stages: kargo.Stage[]; onApprove(): void }) {
  const liveIn = stages.filter((s) => s.currentFreight === f.id).map((s) => s.name)
  const verified = f.verifiedIn ?? []
  const approved = f.approvedFor ?? []
  return (
    <li className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-sunken/40">
      <div className="w-36 shrink-0">
        <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">{f.alias ?? f.id.slice(0, 12)}</code>
        <div className="mt-1 truncate font-mono text-[10px] text-content-subtle" title={f.id}>{f.id.slice(0, 16)}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-content-subtle" title={formatAbsolute(f.created)}>
          {f.warehouse ? `${f.warehouse} · ` : ''}created {formatRelative(f.created)}
        </div>
        <div className="mt-1 space-y-0.5 font-mono text-[11px]">
          {f.images.map((img, i) => (
            <div key={i} className="truncate text-content-muted" title={`${img.repoURL}:${img.tag}${img.digest ? ` (${img.digest})` : ''}`}>
              {img.repoURL.replace(/^https?:\/\//, '')}:<span className="text-content">{img.tag}</span>
            </div>
          ))}
          {(f.commits ?? []).map((c, i) => (
            <div key={i} className="truncate text-content-muted" title={c.message}>
              {c.repoURL.replace(/^https?:\/\//, '')}@<span className="text-content">{c.id.slice(0, 8)}</span>{c.branch ? ` (${c.branch})` : ''}{c.message ? ` — ${c.message}` : ''}
            </div>
          ))}
          {(f.charts ?? []).map((c, i) => (
            <div key={i} className="truncate text-content-muted">{c.repoURL.replace(/^https?:\/\//, '')} {c.name ?? ''}@<span className="text-content">{c.version}</span></div>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="flex flex-wrap justify-end gap-1">
          {liveIn.map((n) => <StatusBadge key={`l-${n}`} kind="healthy">live · {n}</StatusBadge>)}
          {verified.filter((n) => !liveIn.includes(n)).map((n) => <StatusBadge key={`v-${n}`} kind="info">verified · {n}</StatusBadge>)}
          {approved.filter((n) => !verified.includes(n) && !liveIn.includes(n)).map((n) => <StatusBadge key={`a-${n}`} kind="paused">approved · {n}</StatusBadge>)}
        </div>
        <button type="button" onClick={onApprove} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">Approve for stage…</button>
      </div>
    </li>
  )
}

function PromoteModal({
  stage,
  freight,
  onClose,
  onPromote,
  loading,
}: {
  stage: kargo.Stage
  freight: kargo.Freight[]
  onClose(): void
  onPromote(freightId: string): void
  loading: boolean
}) {
  // Freight that is already verified in an upstream stage (or approved for
  // this one) is what Kargo would normally allow; show it first, but let the
  // operator pick anything — Kargo enforces its own rules on the Promotion.
  const eligible = (f: kargo.Freight) => (stage.upstream ?? []).some((u) => (f.verifiedIn ?? []).includes(u)) || (f.approvedFor ?? []).includes(stage.name) || !(stage.upstream?.length)
  const ordered = [...freight].sort((a, b) => Number(eligible(b)) - Number(eligible(a)))
  const [picked, setPicked] = useState<string>(ordered.find(eligible)?.id ?? ordered[0]?.id ?? '')
  if (typeof document === 'undefined') return null

  return (
    <Modal
      open
      onClose={onClose}
      title={`Promote ${stage.name}`}
      description={stage.upstream?.length ? `Freight verified in ${stage.upstream.join(' / ')} (or approved for ${stage.name}) is listed first.` : 'Pick the freight bundle to roll into this stage.'}
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onPromote(picked); onClose() }} loading={loading} disabled={!picked}>Promote</Button>
        </>
      }
    >
      <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
        {ordered.map((f) => {
          const on = picked === f.id
          const ok = eligible(f)
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setPicked(f.id)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border p-3 text-left',
                on ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/20 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised hover:border-edge-strong',
                !ok && 'opacity-70',
              )}
            >
              <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content ring-1 ring-edge-subtle">{f.alias ?? f.id.slice(0, 12)}</code>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-content-subtle">
                  created {formatRelative(f.created)}
                  {(f.verifiedIn ?? []).length ? ` · verified in ${f.verifiedIn!.join(', ')}` : ''}
                  {!ok ? ' · not yet verified upstream' : ''}
                </div>
                <div className="mt-1 space-y-0.5 font-mono text-[11px]">
                  {f.images.map((img, i) => (
                    <div key={i} className="truncate text-content-muted">
                      {img.repoURL.replace(/^https?:\/\//, '')}:<span className="text-content">{img.tag}</span>
                    </div>
                  ))}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

function ApproveModal({
  freight,
  stages,
  onClose,
  onApprove,
  loading,
}: {
  freight: kargo.Freight
  stages: kargo.Stage[]
  onClose(): void
  onApprove(stage: string): void
  loading: boolean
}) {
  const candidates = stages.filter((s) => !(freight.approvedFor ?? []).includes(s.name) && !(freight.verifiedIn ?? []).includes(s.name))
  const [picked, setPicked] = useState<string>(candidates[0]?.name ?? '')
  if (typeof document === 'undefined') return null
  return (
    <Modal
      open
      onClose={onClose}
      title={`Approve ${freight.alias ?? freight.id.slice(0, 12)}`}
      description="Manual approval lets this freight be promoted into a stage without having been verified upstream — the same as `kargo approve`."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onApprove(picked); onClose() }} loading={loading} disabled={!picked}>Approve</Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="text-[12px] text-content-muted">This freight is already verified or approved for every stage.</p>
      ) : (
        <div className="space-y-1.5">
          {candidates.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setPicked(s.name)}
              className={cn('flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-[12px]', picked === s.name ? 'border-brand-400 bg-brand-50 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised hover:border-edge-strong')}
            >
              <span className="font-semibold text-content">{s.name}</span>
              <StatusBadge kind={PHASE_KIND[s.phase] ?? 'unknown'}>{s.phase}</StatusBadge>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}

export default KargoStages
