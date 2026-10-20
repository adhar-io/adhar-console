/**
 * Spend — the pure model behind the cost explorer. OpenCost allocation
 * responses go in; month-to-date, forecast, idle, efficiency, movers, budget
 * status and rightsizing come out. No React, no fetch (`cost.ts` does that);
 * unit-tested in `cost-model_test.ts`.
 */

/* ─────────── OpenCost wire shapes ─────────── */

export interface OcAllocation {
  name?: string
  start?: string
  end?: string
  window?: { start?: string; end?: string }
  properties?: {
    namespace?: string
    controller?: string
    controllerKind?: string
    labels?: Record<string, string>
  }
  cpuCost?: number
  gpuCost?: number
  ramCost?: number
  pvCost?: number
  networkCost?: number
  loadBalancerCost?: number
  sharedCost?: number
  externalCost?: number
  totalCost?: number
  cpuCoreHours?: number
  ramByteHours?: number
  cpuCoreRequestAverage?: number
  cpuCoreUsageAverage?: number
  ramByteRequestAverage?: number
  ramByteUsageAverage?: number
  cpuEfficiency?: number
  ramEfficiency?: number
  totalEfficiency?: number
}

export interface OcResponse {
  code?: number
  message?: string
  data?: Array<Record<string, OcAllocation> | null>
}

export const IDLE_KEY = '__idle__'

export function isPseudo(key: string): boolean {
  return key.startsWith('__') && key.endsWith('__')
}

export interface Components {
  cpu: number
  ram: number
  gpu: number
  storage: number
  network: number
  other: number
}

export function componentsOf(a: OcAllocation): Components {
  return {
    cpu: a.cpuCost ?? 0,
    ram: a.ramCost ?? 0,
    gpu: a.gpuCost ?? 0,
    storage: a.pvCost ?? 0,
    network: (a.networkCost ?? 0) + (a.loadBalancerCost ?? 0),
    other: (a.sharedCost ?? 0) + (a.externalCost ?? 0),
  }
}

export function totalOf(a: OcAllocation): number {
  if (typeof a.totalCost === 'number' && Number.isFinite(a.totalCost)) return a.totalCost
  const c = componentsOf(a)
  return c.cpu + c.ram + c.gpu + c.storage + c.network + c.other
}

/* ─────────── rows ─────────── */

export interface CostRow {
  key: string
  namespace?: string
  kind?: string
  total: number
  components: Components
  cpuReq: number
  cpuUsed: number
  ramReq: number
  ramUsed: number
  /** 0..1 cost-weighted usage ÷ request, null when nothing was requested. */
  efficiency: number | null
}

const ZERO: Components = { cpu: 0, ram: 0, gpu: 0, storage: 0, network: 0, other: 0 }

function addC(a: Components, b: Components): Components {
  return {
    cpu: a.cpu + b.cpu,
    ram: a.ram + b.ram,
    gpu: a.gpu + b.gpu,
    storage: a.storage + b.storage,
    network: a.network + b.network,
    other: a.other + b.other,
  }
}

/**
 * Cost-weighted efficiency: the share of CPU and RAM spend that bought
 * resources actually used. Same definition as OpenCost's `totalEfficiency`.
 */
export function efficiencyOf(r: Pick<CostRow, 'cpuReq' | 'cpuUsed' | 'ramReq' | 'ramUsed' | 'components'>): number | null {
  const cpuE = r.cpuReq > 0 ? Math.min(r.cpuUsed / r.cpuReq, 1.5) : null
  const ramE = r.ramReq > 0 ? Math.min(r.ramUsed / r.ramReq, 1.5) : null
  const wc = cpuE == null ? 0 : r.components.cpu
  const wr = ramE == null ? 0 : r.components.ram
  if (wc + wr <= 0) {
    if (cpuE != null && ramE != null) return (cpuE + ramE) / 2
    return cpuE ?? ramE
  }
  return ((cpuE ?? 0) * wc + (ramE ?? 0) * wr) / (wc + wr)
}

function rowOf(key: string, a: OcAllocation): CostRow {
  const r: CostRow = {
    key,
    namespace: a.properties?.namespace,
    kind: a.properties?.controllerKind,
    total: totalOf(a),
    components: componentsOf(a),
    cpuReq: a.cpuCoreRequestAverage ?? 0,
    cpuUsed: a.cpuCoreUsageAverage ?? 0,
    ramReq: a.ramByteRequestAverage ?? 0,
    ramUsed: a.ramByteUsageAverage ?? 0,
    efficiency: null,
  }
  r.efficiency = efficiencyOf(r)
  return r
}

/** An accumulated allocation map → rows (pseudo keys excluded) + the idle cost. */
export function rowsOf(resp: OcResponse): { rows: CostRow[]; idle: number; allocated: number } {
  const m = resp.data?.[0] ?? {}
  let idle = 0
  const rows: CostRow[] = []
  for (const [k, a] of Object.entries(m)) {
    if (!a) continue
    if (k === IDLE_KEY) {
      idle += totalOf(a)
      continue
    }
    if (isPseudo(k)) continue
    rows.push(rowOf(k, a))
  }
  rows.sort((x, y) => y.total - x.total)
  return { rows, idle, allocated: rows.reduce((s, r) => s + r.total, 0) }
}

/**
 * Group rows under another key (namespace → project / team / env). A row
 * whose `keysOf` returns several keys is split evenly between them, so a
 * team rollup never counts the same dollar twice.
 */
export function regroup(rows: CostRow[], keysOf: (r: CostRow) => string[]): CostRow[] {
  const out = new Map<string, CostRow>()
  for (const r of rows) {
    const keys = keysOf(r)
    const share = 1 / Math.max(1, keys.length)
    for (const k of keys.length ? keys : ['Unassigned']) {
      const cur = out.get(k) ?? { key: k, total: 0, components: ZERO, cpuReq: 0, cpuUsed: 0, ramReq: 0, ramUsed: 0, efficiency: null }
      cur.total += r.total * share
      cur.components = addC(cur.components, scaleC(r.components, share))
      cur.cpuReq += r.cpuReq * share
      cur.cpuUsed += r.cpuUsed * share
      cur.ramReq += r.ramReq * share
      cur.ramUsed += r.ramUsed * share
      out.set(k, cur)
    }
  }
  return [...out.values()].map((r) => ({ ...r, efficiency: efficiencyOf(r) })).sort((a, b) => b.total - a.total)
}

function scaleC(c: Components, f: number): Components {
  return { cpu: c.cpu * f, ram: c.ram * f, gpu: c.gpu * f, storage: c.storage * f, network: c.network * f, other: c.other * f }
}

/* ─────────── daily series ─────────── */

export interface DayCost {
  /** UTC midnight of the day (ms). */
  day: number
  total: number
  idle: number
  byKey: Record<string, number>
}

function stepStart(m: Record<string, OcAllocation>): number | null {
  for (const a of Object.values(m)) {
    const s = a?.window?.start ?? a?.start
    if (s) {
      const t = Date.parse(s)
      if (Number.isFinite(t)) return t
    }
  }
  return null
}

/** A `step=1d, accumulate=false` response → one row per day (empty steps skipped). */
export function dailyOf(resp: OcResponse): DayCost[] {
  const out: DayCost[] = []
  for (const m of resp.data ?? []) {
    if (!m) continue
    const start = stepStart(m)
    if (start == null) continue
    const day = Math.floor(start / 86_400_000) * 86_400_000
    let total = 0
    let idle = 0
    const byKey: Record<string, number> = {}
    for (const [k, a] of Object.entries(m)) {
      if (!a) continue
      const v = totalOf(a)
      if (k === IDLE_KEY) idle += v
      else if (!isPseudo(k)) {
        byKey[k] = (byKey[k] ?? 0) + v
        total += v
      }
    }
    out.push({ day, total: total + idle, idle, byKey })
  }
  return out.sort((a, b) => a.day - b.day)
}

/* ─────────── month-to-date & forecast ─────────── */

export function monthStart(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

export function prevMonthStart(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)
}

export function daysInMonth(now: number): number {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

export interface Forecast {
  mtd: number
  /** Mean daily spend over the basis days. */
  runRate: number
  forecast: number
  low: number
  high: number
  basisDays: number
  /** Elapsed days in the month as a fraction (e.g. 19.5). */
  elapsedDays: number
}

/**
 * Month-end forecast: month-to-date plus the remaining (fractional) days at
 * the run-rate of the last ≤7 COMPLETE days; today is partial, so it counts
 * toward month-to-date but not toward the rate. The band uses the lowest and
 * highest of those days. Null with no complete day yet.
 */
export function forecastMonth(days: DayCost[], now: number): Forecast | null {
  const ms = monthStart(now)
  const today = Math.floor(now / 86_400_000) * 86_400_000
  const month = days.filter((d) => d.day >= ms && d.day <= today)
  const mtd = month.reduce((s, d) => s + d.total, 0)
  const complete = month.filter((d) => d.day < today).slice(-7)
  if (!complete.length) return null
  const vals = complete.map((d) => d.total)
  const runRate = vals.reduce((a, b) => a + b, 0) / vals.length
  const elapsedDays = (now - ms) / 86_400_000
  const remaining = Math.max(0, daysInMonth(now) - elapsedDays)
  return {
    mtd,
    runRate,
    forecast: mtd + runRate * remaining,
    low: mtd + Math.min(...vals) * remaining,
    high: mtd + Math.max(...vals) * remaining,
    basisDays: complete.length,
    elapsedDays,
  }
}

/** Spend over the first `elapsedDays` days of the previous month (like-for-like). */
export function prevSamePeriod(days: DayCost[], now: number): { total: number; full: number; covered: boolean } {
  const ps = prevMonthStart(now)
  const ms = monthStart(now)
  const prev = days.filter((d) => d.day >= ps && d.day < ms)
  const elapsed = (now - ms) / 86_400_000
  const cut = ps + Math.ceil(elapsed) * 86_400_000
  return {
    total: prev.filter((d) => d.day < cut).reduce((s, d) => s + d.total, 0),
    full: prev.reduce((s, d) => s + d.total, 0),
    // OpenCost only knows what it has seen; a month it was not running for is
    // not a $0 month.
    covered: prev.length > 0 && prev[0].day <= ps + 86_400_000,
  }
}

/* ─────────── ranges ─────────── */

export const SPEND_RANGES = [
  { id: 'mtd', label: 'Month to date' },
  { id: 'lastmonth', label: 'Last month' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
] as const

export type SpendRangeId = (typeof SPEND_RANGES)[number]['id']

export function spendWindow(
  id: string | undefined,
  now: number,
): { id: SpendRangeId; start: number; end: number; prevStart: number; prevEnd: number; label: string } {
  const r = SPEND_RANGES.find((x) => x.id === id) ?? SPEND_RANGES[0]
  const end = Math.floor(now / 3_600_000) * 3_600_000
  let start: number
  let stop = end
  if (r.id === 'mtd') start = monthStart(now)
  else if (r.id === 'lastmonth') {
    start = prevMonthStart(now)
    stop = monthStart(now)
  } else start = end - Number.parseInt(r.id) * 86_400_000
  // Previous period: the same length immediately before (month-aligned for MTD / last month).
  const prevStart = r.id === 'mtd'
    ? prevMonthStart(now)
    : r.id === 'lastmonth'
    ? Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() - 1, 1)
    : start - (stop - start)
  // Month to date compares like-for-like: the same elapsed span of last month.
  const prevEnd = r.id === 'mtd' ? Math.min(start, prevStart + (stop - start)) : start
  return { id: r.id, start, end: stop, prevStart, prevEnd, label: r.label }
}

/* ─────────── movers ─────────── */

export interface Mover {
  key: string
  current: number
  previous: number
  delta: number
  /** Fraction, null when the previous value was 0 (new spend). */
  pct: number | null
}

export function movers(current: CostRow[], previous: CostRow[], limit = 8, minDelta = 0.01): Mover[] {
  const prev = new Map(previous.map((r) => [r.key, r.total]))
  const keys = new Set([...current.map((r) => r.key), ...previous.map((r) => r.key)])
  const cur = new Map(current.map((r) => [r.key, r.total]))
  return [...keys]
    .map((key) => {
      const c = cur.get(key) ?? 0
      const p = prev.get(key) ?? 0
      return { key, current: c, previous: p, delta: c - p, pct: p > 0 ? (c - p) / p : null }
    })
    .filter((m) => Math.abs(m.delta) >= minDelta)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit)
}

/* ─────────── budgets ─────────── */

export type BudgetScope = 'total' | 'project' | 'team' | 'namespace'

export interface Budget {
  id: string
  name: string
  scope: BudgetScope
  /** Project slug / team slug / namespace; ignored for `total`. */
  target: string
  monthlyUsd: number
  /** Warn at this % of the budget (default 80). */
  alertPct: number
  owner?: string
}

export type BudgetStatus = 'over' | 'forecast-over' | 'warning' | 'ok' | 'no-data'

export interface BudgetEval {
  status: BudgetStatus
  mtd: number | null
  forecast: number | null
  usedPct: number | null
  forecastPct: number | null
}

/**
 * Over: month-to-date already above budget. Forecast-over: on track to end the
 * month above it. Warning: month-to-date past the alert threshold.
 */
export function evaluateBudget(b: Pick<Budget, 'monthlyUsd' | 'alertPct'>, mtd: number | null, forecast: number | null): BudgetEval {
  if (mtd == null || !(b.monthlyUsd > 0)) return { status: 'no-data', mtd, forecast, usedPct: null, forecastPct: null }
  const usedPct = (mtd / b.monthlyUsd) * 100
  const forecastPct = forecast == null ? null : (forecast / b.monthlyUsd) * 100
  const status: BudgetStatus = usedPct > 100
    ? 'over'
    : forecastPct != null && forecastPct > 100
    ? 'forecast-over'
    : usedPct >= (b.alertPct || 80)
    ? 'warning'
    : 'ok'
  return { status, mtd, forecast, usedPct, forecastPct }
}

/** A scope's share of the cluster forecast: its MTD × (forecast ÷ MTD) of the whole. */
export function scaleForecast(scopeMtd: number, total: Forecast | null): number | null {
  if (!total || total.mtd <= 0) return null
  return scopeMtd * (total.forecast / total.mtd)
}

/* ─────────── rightsizing ─────────── */

export interface UsageRow {
  namespace: string
  container: string
  /** Average request per replica. */
  cpuReq: number
  /** p95 CPU cores per replica over the lookback. */
  cpuP95: number | null
  memReq: number
  /** Peak working-set bytes per replica over the lookback. */
  memMax: number | null
  replicas: number
}

export interface Rates {
  /** USD per core-hour. */
  cpu: number | null
  /** USD per GiB-hour. */
  ramGiB: number | null
}

export interface Recommendation extends UsageRow {
  cpuRec: number | null
  memRec: number | null
  /** USD / month at current blended rates across every replica; null without rates. */
  monthlySavings: number | null
  /** 'under' wins: a request below use is a reliability risk before it is a saving. */
  kind: 'over' | 'under'
  reason: string
}

const GiB = 1024 ** 3
const MiB = 1024 ** 2
const HOURS_PER_MONTH = 730

/** Blended $ per core-hour and per GiB-hour from accumulated allocations. */
export function blendedRates(rows: OcAllocation[]): Rates {
  let cpuCost = 0
  let coreH = 0
  let ramCost = 0
  let byteH = 0
  for (const a of rows) {
    cpuCost += a.cpuCost ?? 0
    coreH += a.cpuCoreHours ?? 0
    ramCost += a.ramCost ?? 0
    byteH += a.ramByteHours ?? 0
  }
  return { cpu: coreH > 0 ? cpuCost / coreH : null, ramGiB: byteH > 0 ? ramCost / (byteH / GiB) : null }
}

/**
 * Requests far above observed use (≥2× with real headroom to give back), and
 * requests below it (throttling / OOM risk). Recommended = p95 CPU × 1.2
 * (min 10m, 10m steps) and peak memory × 1.2 (min 32Mi, 16Mi steps).
 */
export function rightsize(rows: UsageRow[], rates: Rates): Recommendation[] {
  const out: Recommendation[] = []
  for (const r of rows) {
    const cpuRec = r.cpuP95 == null ? null : Math.max(0.01, Math.ceil((r.cpuP95 * 1.2) / 0.01) * 0.01)
    const memRec = r.memMax == null ? null : Math.max(32 * MiB, Math.ceil((r.memMax * 1.2) / (16 * MiB)) * 16 * MiB)
    const cpuOver = cpuRec != null && r.cpuReq > 0 && r.cpuReq >= 2 * cpuRec && r.cpuReq - cpuRec >= 0.05
    const memOver = memRec != null && r.memReq > 0 && r.memReq >= 2 * memRec && r.memReq - memRec >= 64 * MiB
    const cpuUnder = r.cpuP95 != null && r.cpuReq > 0 && r.cpuP95 > r.cpuReq * 1.1
    const memUnder = r.memMax != null && r.memReq > 0 && r.memMax > r.memReq * 1.05
    if (!cpuOver && !memOver && !cpuUnder && !memUnder) continue
    const freeCores = cpuOver ? r.cpuReq - cpuRec! : 0
    const freeGiB = memOver ? (r.memReq - memRec!) / GiB : 0
    const monthlySavings = (cpuOver || memOver) && (rates.cpu != null || rates.ramGiB != null)
      ? ((freeCores * (rates.cpu ?? 0)) + (freeGiB * (rates.ramGiB ?? 0))) * HOURS_PER_MONTH * Math.max(1, r.replicas)
      : null
    const reasons: string[] = []
    if (cpuOver) reasons.push(`CPU request ${(r.cpuReq / Math.max(r.cpuP95 ?? 0, 0.001)).toFixed(0)}× p95 use`)
    if (memOver) reasons.push(`memory request ${(r.memReq / Math.max(r.memMax ?? 1, 1)).toFixed(0)}× peak use`)
    if (cpuUnder) reasons.push('CPU p95 above request (throttling risk)')
    if (memUnder) reasons.push('memory peak above request (OOM / eviction risk)')
    out.push({ ...r, cpuRec, memRec, monthlySavings, kind: cpuUnder || memUnder ? 'under' : 'over', reason: reasons.join(' · ') })
  }
  return out.sort((a, b) => (b.monthlySavings ?? -1) - (a.monthlySavings ?? -1) || a.namespace.localeCompare(b.namespace))
}

/* ─────────── formatting ─────────── */

export function formatUsd(v: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const sign = v < 0 ? '−' : ''
  const a = Math.abs(v)
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`
  if (a >= 10_000) return `${sign}$${(a / 1_000).toFixed(1)}K`
  if (a >= 100 || !opts.precise) return `${sign}$${Math.round(a).toLocaleString('en-US')}`
  return `${sign}$${a.toFixed(2)}`
}

export function formatDeltaPct(f: number | null | undefined): string {
  if (f == null || !Number.isFinite(f)) return 'new'
  const sign = f > 0 ? '+' : f < 0 ? '−' : ''
  return `${sign}${Math.abs(f * 100).toFixed(Math.abs(f) < 0.1 ? 1 : 0)}%`
}

export function formatCores(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return '—'
  return c < 1 ? `${Math.round(c * 1000)}m` : `${c.toFixed(2).replace(/\.?0+$/, '')}`
}

export function formatBytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b)) return '—'
  if (b >= GiB) return `${(b / GiB).toFixed(1).replace(/\.0$/, '')}Gi`
  return `${Math.round(b / MiB)}Mi`
}
