/**
 * State timeline + status history, Grafana semantics.
 *
 * State timeline: one lane per number field; each sample's state lasts until
 * the next sample. Gaps longer than the null-insert threshold (the query step,
 * or `custom.insertNulls` in ms; `false` turns it off) become nulls, and a
 * null ends the state unless `spanNulls` carries the previous state over it
 * (`true`, or a max gap in ms). `mergeValues` joins neighbours with the same
 * value. The last state runs to the end of the board range (or one step past
 * the last sample when the data stops early).
 *
 * Status history: one cell per sample per lane, no merging.
 */

import type { FieldDefaults, ThresholdStep } from './grafana-board.ts'
import type { DisplayValue, FieldValue } from './grafana-fields.ts'

export interface TimelineSegment {
  start: number
  end: number
  value: FieldValue
  text: string
  color?: string
  rawColor?: string
}

export interface LaneOptions {
  /** Board / panel range. */
  rangeStart: number
  rangeEnd: number
  mergeValues?: boolean
  spanNulls?: boolean | number
  /** Null-insert threshold in ms; `false` disables; undefined → `stepMs`. */
  insertNulls?: false | number
  stepMs?: number
  /** Value → text + colour (mappings, thresholds, unit). */
  display(v: FieldValue): DisplayValue
  /** Hard cap on segments per lane (rendering budget). */
  maxSegments?: number
}

function isNullish(v: FieldValue): boolean {
  return v == null || (typeof v === 'number' && Number.isNaN(v))
}

/**
 * Insert nulls where samples are further apart than `threshold`, and one
 * after the last sample when the range continues past it (Grafana's
 * `applyNullInsertThreshold` with the range end as pseudo-max).
 */
export function insertNulls(
  times: number[],
  values: FieldValue[],
  threshold: number | false | undefined,
  rangeEnd?: number,
): { times: number[]; values: FieldValue[] } {
  if (!threshold || threshold <= 0 || times.length === 0) return { times, values }
  const t: number[] = []
  const v: FieldValue[] = []
  for (let i = 0; i < times.length; i++) {
    if (i > 0 && times[i] - times[i - 1] > threshold) {
      t.push(times[i - 1] + threshold)
      v.push(null)
    }
    t.push(times[i])
    v.push(values[i])
  }
  const last = times[times.length - 1]
  if (rangeEnd != null && rangeEnd - last > threshold) {
    t.push(last + threshold)
    v.push(null)
  }
  return { times: t, values: v }
}

/** Sort samples by time (Prometheus already does; transforms may not). */
function sorted(times: FieldValue[], values: FieldValue[]): { times: number[]; values: FieldValue[] } {
  const idx = times.map((_, i) => i).filter((i) => typeof times[i] === 'number' && Number.isFinite(times[i] as number))
  let inOrder = true
  for (let i = 1; i < idx.length; i++) if ((times[idx[i]] as number) < (times[idx[i - 1]] as number)) inOrder = false
  if (!inOrder) idx.sort((a, b) => (times[a] as number) - (times[b] as number))
  return { times: idx.map((i) => times[i] as number), values: idx.map((i) => values[i] ?? null) }
}

/** One state-timeline lane. */
export function buildStateLane(rawTimes: FieldValue[], rawValues: FieldValue[], o: LaneOptions): TimelineSegment[] {
  const s = sorted(rawTimes, rawValues)
  if (!s.times.length) return []
  // An instant query is one sample: it stands for the whole range.
  if (s.times.length === 1 && !isNullish(s.values[0])) {
    const d = o.display(s.values[0])
    return [{ start: Math.min(s.times[0], o.rangeStart), end: o.rangeEnd, value: s.values[0], text: d.text, color: d.color, rawColor: d.rawColor }]
  }
  const threshold = o.insertNulls === false ? false : (o.insertNulls ?? o.stepMs)
  const { times, values } = insertNulls(s.times, s.values, threshold, o.rangeEnd)
  const span = o.spanNulls
  const out: TimelineSegment[] = []
  const max = o.maxSegments ?? 5000
  let cur: TimelineSegment | null = null
  let lastReal = -1
  for (let i = 0; i < times.length; i++) {
    const v = values[i]
    const t = times[i]
    if (isNullish(v)) {
      // Find the next real sample to measure the gap for numeric spanNulls.
      let next = i + 1
      while (next < times.length && isNullish(values[next])) next++
      const gap = next < times.length && lastReal >= 0 ? times[next] - times[lastReal] : Infinity
      const carry = span === true || (typeof span === 'number' && span > 0 && gap <= span)
      if (carry && cur) continue
      if (cur) {
        cur.end = t
        out.push(cur)
        cur = null
      }
      continue
    }
    lastReal = i
    const same = cur && o.mergeValues !== false && cur.value === v
    if (same) continue
    if (cur) {
      cur.end = t
      out.push(cur)
      if (out.length >= max) return out
    }
    const d = o.display(v)
    cur = { start: t, end: t, value: v, text: d.text, color: d.color, rawColor: d.rawColor }
  }
  if (cur) {
    cur.end = Math.max(cur.start, o.rangeEnd)
    out.push(cur)
  }
  return out.filter((x) => x.end > o.rangeStart && x.start < o.rangeEnd).map((x) => ({ ...x, start: Math.max(x.start, o.rangeStart), end: Math.min(x.end, o.rangeEnd) }))
}

/** One status-history lane: a cell per sample. */
export function buildStatusCells(rawTimes: FieldValue[], rawValues: FieldValue[], o: LaneOptions): TimelineSegment[] {
  const s = sorted(rawTimes, rawValues)
  const n = s.times.length
  if (!n) return []
  const steps: number[] = []
  for (let i = 1; i < n; i++) steps.push(s.times[i] - s.times[i - 1])
  const typical = o.stepMs ?? (steps.length ? steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] : o.rangeEnd - o.rangeStart)
  const out: TimelineSegment[] = []
  const max = o.maxSegments ?? 2000
  const first = Math.max(0, n - max)
  for (let i = first; i < n; i++) {
    const v = s.values[i]
    if (isNullish(v)) continue
    const start = s.times[i]
    const end = i + 1 < n ? Math.min(s.times[i + 1], start + typical) : start + typical
    const d = o.display(v)
    out.push({ start, end, value: v, text: d.text, color: d.color, rawColor: d.rawColor })
  }
  return out
}

export interface LegendItem {
  label: string
  color?: string
}

/**
 * Grafana's timeline legend: with colour mode `thresholds` and more than one
 * step, one item per step (`< 80`, `80+`); otherwise each distinct displayed
 * state (text → colour) in order of appearance.
 */
export function timelineLegend(
  cfg: FieldDefaults,
  lanes: TimelineSegment[][],
  formatStep: (v: number) => string,
  colorOf: (c: string) => string | undefined,
): LegendItem[] {
  const steps: ThresholdStep[] = cfg.thresholds?.steps ?? []
  if ((cfg.color?.mode ?? 'thresholds') === 'thresholds' && steps.length > 1) {
    return steps.map((st, i) => {
      if (st.value == null && i < steps.length - 1 && steps[i + 1].value != null) {
        return { label: `< ${formatStep(steps[i + 1].value!)}`, color: colorOf(st.color) }
      }
      return { label: `${st.value == null ? '-∞' : formatStep(st.value)}+`, color: colorOf(st.color) }
    })
  }
  const seen = new Map<string, string | undefined>()
  for (const lane of lanes) for (const s of lane) if (s.color && s.text && !seen.has(s.text)) seen.set(s.text, s.color)
  return [...seen].map(([label, color]) => ({ label, color }))
}

/** Time ticks for an axis of `widthPx`, Grafana-like spacing (~80px). */
export function timeTicks(start: number, end: number, widthPx: number): number[] {
  const span = Math.max(1, end - start)
  const want = Math.max(2, Math.floor(widthPx / 90))
  const raw = span / want
  const steps = [
    1_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
    7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000, 604_800_000, 2_592_000_000,
  ]
  const step = steps.find((s) => s >= raw) ?? steps[steps.length - 1]
  // Align to local wall-clock boundaries (hours / days) like Grafana.
  const tz = new Date(start).getTimezoneOffset() * 60_000
  const first = Math.ceil((start - tz) / step) * step + tz
  const out: number[] = []
  for (let t = first; t <= end && out.length < 50; t += step) out.push(t)
  return out
}

/** Tick label format for a range (Grafana: HH:mm; MM/DD HH:mm when > 1 day). */
export function formatTick(t: number, span: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  if (span > 3 * 86_400_000) return `${p(d.getMonth() + 1)}/${p(d.getDate())}`
  if (span > 86_400_000) return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  if (span <= 5 * 60_000) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `12:00:05 → 12:04:00 (3m 55s)` for tooltips. */
export function formatSpan(start: number, end: number): string {
  const f = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const d = Math.max(0, Math.round((end - start) / 1000))
  const parts: string[] = []
  const days = Math.floor(d / 86400)
  const h = Math.floor((d % 86400) / 3600)
  const m = Math.floor((d % 3600) / 60)
  const sec = d % 60
  if (days) parts.push(`${days}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (sec || !parts.length) parts.push(`${sec}s`)
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString()
  const day = sameDay ? '' : `${new Date(start).toLocaleDateString([], { month: 'short', day: 'numeric' })} `
  return `${day}${f(start)} → ${f(end)} (${parts.slice(0, 2).join(' ')})`
}
