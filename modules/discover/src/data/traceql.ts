/**
 * Tempo / TraceQL helpers — pure, React-free, unit tested.
 *
 *   • `buildTraceQL`   — search form → TraceQL span-set filter.
 *   • `parseSearch`    — Tempo `/api/search` body → typed results.
 *   • `parseTrace`     — OTLP JSON (`/api/traces/<id>`, v1 or v2) → spans with
 *                        absolute times, resource attributes, kind and links.
 *   • `orderSpans`     — depth-first tree order for the waterfall.
 *   • `criticalPath`   — the chain of spans that determines end-to-end latency.
 *   • `serviceBreakdown` — self time per service.
 *   • `compareTraces`  — per-operation duration deltas between two traces.
 */

/* ─────────── TraceQL ─────────── */

export type TagOp = '=' | '!=' | '=~' | '!~' | '>' | '>=' | '<' | '<='
export interface TraceSearchForm {
  service?: string
  operation?: string
  status?: 'any' | 'error' | 'ok' | 'unset'
  kind?: 'any' | 'server' | 'client' | 'producer' | 'consumer' | 'internal'
  minDuration?: string
  maxDuration?: string
  tags: Array<{ scope: 'span' | 'resource' | 'any'; key: string; op: TagOp; value: string }>
}

export const EMPTY_FORM: TraceSearchForm = { status: 'any', kind: 'any', tags: [] }

const DURATION = /^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)$/
const NUMBER = /^-?\d+(\.\d+)?$/

function q(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Normalise "250" → "250ms"; leave valid durations alone; drop junk. */
export function normDuration(v: string | undefined): string | null {
  const s = (v ?? '').trim()
  if (!s) return null
  if (NUMBER.test(s)) return `${s}ms`
  return DURATION.test(s) ? s : null
}

function tagValue(key: string, op: TagOp, value: string): string {
  const v = value.trim()
  if (op === '=~' || op === '!~') return q(v)
  if (v === 'true' || v === 'false' || NUMBER.test(v) || DURATION.test(v)) {
    // http.status_code = 500 is an int in OTel; quoting it would never match.
    if (!/(^|\.)(id|name|version)$/.test(key)) return v
  }
  return q(v)
}

export function buildTraceQL(f: TraceSearchForm): string {
  const conds: string[] = []
  if (f.service) conds.push(`resource.service.name = ${q(f.service)}`)
  if (f.operation) conds.push(`name = ${q(f.operation)}`)
  if (f.status && f.status !== 'any') conds.push(`status = ${f.status}`)
  if (f.kind && f.kind !== 'any') conds.push(`kind = ${f.kind}`)
  const min = normDuration(f.minDuration)
  const max = normDuration(f.maxDuration)
  if (min) conds.push(`duration >= ${min}`)
  if (max) conds.push(`duration <= ${max}`)
  for (const t of f.tags) {
    const key = t.key.trim()
    if (!key || t.value.trim() === '') continue
    const scoped = t.scope === 'any' ? `.${key}` : `${t.scope}.${key}`
    conds.push(`${scoped} ${t.op} ${tagValue(key, t.op, t.value)}`)
  }
  return conds.length ? `{ ${conds.join(' && ')} }` : '{}'
}

/* ─────────── search results ─────────── */

export interface SearchSpan {
  spanID: string
  name?: string
  startMs: number
  durationMs: number
  attributes: Record<string, string>
}

export interface TraceHit {
  traceID: string
  rootServiceName: string
  rootTraceName: string
  /** epoch ms */
  startMs: number
  durationMs: number
  /** Matched spans (Tempo returns up to `spss` per span set). */
  spans: SearchSpan[]
  matched: number
  /** Known only when a matched span carries `status` — otherwise undefined. */
  error?: boolean
  services: string[]
}

interface OtlpAnyValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values?: OtlpAnyValue[] }
  kvlistValue?: { values?: OtlpKv[] }
}
interface OtlpKv {
  key: string
  value?: OtlpAnyValue
}

export function anyValue(v: OtlpAnyValue | undefined): string {
  if (!v) return ''
  if (v.stringValue !== undefined) return v.stringValue
  if (v.intValue !== undefined) return String(v.intValue)
  if (v.doubleValue !== undefined) return String(v.doubleValue)
  if (v.boolValue !== undefined) return String(v.boolValue)
  if (v.arrayValue) return `[${(v.arrayValue.values ?? []).map(anyValue).join(', ')}]`
  if (v.kvlistValue) return JSON.stringify(Object.fromEntries((v.kvlistValue.values ?? []).map((kv) => [kv.key, anyValue(kv.value)])))
  return ''
}

export function attrs(list: OtlpKv[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of list ?? []) if (kv?.key) out[kv.key] = anyValue(kv.value)
  return out
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function parseSearch(body: unknown): TraceHit[] {
  const traces = (body as { traces?: unknown[] } | null)?.traces
  if (!Array.isArray(traces)) return []
  const out: TraceHit[] = []
  for (const raw of traces) {
    const t = raw as {
      traceID?: string
      rootServiceName?: string
      rootTraceName?: string
      startTimeUnixNano?: string
      durationMs?: number
      spanSet?: { spans?: unknown[]; matched?: number }
      spanSets?: Array<{ spans?: unknown[]; matched?: number }>
      serviceStats?: Record<string, unknown>
    }
    if (!t?.traceID) continue
    const sets = t.spanSets ?? (t.spanSet ? [t.spanSet] : [])
    const spans: SearchSpan[] = []
    let matched = 0
    for (const s of sets) {
      matched += num(s.matched)
      for (const sp of s.spans ?? []) {
        const x = sp as { spanID?: string; name?: string; startTimeUnixNano?: string; durationNanos?: string; attributes?: OtlpKv[] }
        spans.push({
          spanID: x.spanID ?? '',
          name: x.name,
          startMs: num(x.startTimeUnixNano) / 1e6,
          durationMs: num(x.durationNanos) / 1e6,
          attributes: attrs(x.attributes),
        })
      }
    }
    const statusVals = spans.map((s) => s.attributes.status).filter(Boolean)
    out.push({
      traceID: t.traceID,
      rootServiceName: t.rootServiceName ?? '',
      rootTraceName: t.rootTraceName ?? '',
      startMs: num(t.startTimeUnixNano) / 1e6,
      durationMs: num(t.durationMs),
      spans,
      matched,
      error: statusVals.length ? statusVals.includes('error') : undefined,
      services: t.serviceStats ? Object.keys(t.serviceStats) : [],
    })
  }
  return out
}

/** Tag values from `/api/v2/search/tag/<t>/values` ({tagValues:[{value}]}) or v1 ({tagValues:[str]}). */
export function parseTagValues(body: unknown): string[] {
  const vals = (body as { tagValues?: unknown[] } | null)?.tagValues
  if (!Array.isArray(vals)) return []
  return vals
    .map((v) => (typeof v === 'string' ? v : String((v as { value?: unknown })?.value ?? '')))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

/* ─────────── full trace ─────────── */

export type SpanKind = 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer'
const KINDS: SpanKind[] = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer']

export interface TraceSpan {
  spanID: string
  parentSpanID?: string
  traceID: string
  serviceName: string
  name: string
  kind: SpanKind
  /** epoch ms */
  startMs: number
  endMs: number
  durationMs: number
  status: 'ok' | 'error' | 'unset'
  statusMessage?: string
  attributes: Record<string, string>
  resource: Record<string, string>
  scope?: string
  events: Array<{ timeMs: number; name: string; attributes: Record<string, string> }>
  links: Array<{ traceID: string; spanID: string; attributes: Record<string, string> }>
}

function kindOf(k: unknown): SpanKind {
  if (typeof k === 'number') return KINDS[k] ?? 'unspecified'
  const s = String(k ?? '').toLowerCase().replace('span_kind_', '')
  return (KINDS as string[]).includes(s) ? (s as SpanKind) : 'unspecified'
}

function statusOf(code: unknown): TraceSpan['status'] {
  if (code === 2 || code === 'STATUS_CODE_ERROR' || code === 'error') return 'error'
  if (code === 1 || code === 'STATUS_CODE_OK' || code === 'ok') return 'ok'
  return 'unset'
}

/** OTLP ids arrive base64 (Tempo JSON) or hex; normalise to lower-case hex. */
export function normId(id: string | undefined): string {
  if (!id) return ''
  if (/^[0-9a-f]+$/i.test(id) && (id.length === 16 || id.length === 32)) return id.toLowerCase()
  try {
    const bin = atob(id)
    let hex = ''
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0')
    return hex
  } catch {
    return id
  }
}

export function parseTrace(body: unknown): TraceSpan[] {
  const b = body as { batches?: unknown[]; resourceSpans?: unknown[]; trace?: { resourceSpans?: unknown[]; batches?: unknown[] } } | null
  const batches = b?.batches ?? b?.resourceSpans ?? b?.trace?.resourceSpans ?? b?.trace?.batches ?? []
  const out: TraceSpan[] = []
  for (const batchRaw of batches) {
    const batch = batchRaw as {
      resource?: { attributes?: OtlpKv[] }
      scopeSpans?: unknown[]
      instrumentationLibrarySpans?: unknown[]
    }
    const resource = attrs(batch.resource?.attributes)
    const serviceName = resource['service.name'] ?? 'unknown'
    for (const scopeRaw of batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? []) {
      const scope = scopeRaw as { scope?: { name?: string }; instrumentationLibrary?: { name?: string }; spans?: unknown[] }
      for (const spRaw of scope.spans ?? []) {
        const sp = spRaw as {
          traceId?: string
          spanId?: string
          parentSpanId?: string
          name?: string
          kind?: unknown
          startTimeUnixNano?: string
          endTimeUnixNano?: string
          attributes?: OtlpKv[]
          status?: { code?: unknown; message?: string }
          events?: Array<{ timeUnixNano?: string; name?: string; attributes?: OtlpKv[] }>
          links?: Array<{ traceId?: string; spanId?: string; attributes?: OtlpKv[] }>
        }
        const startMs = num(sp.startTimeUnixNano) / 1e6
        const endMs = Math.max(startMs, num(sp.endTimeUnixNano ?? sp.startTimeUnixNano) / 1e6)
        out.push({
          spanID: normId(sp.spanId),
          parentSpanID: normId(sp.parentSpanId) || undefined,
          traceID: normId(sp.traceId),
          serviceName,
          name: sp.name ?? '',
          kind: kindOf(sp.kind),
          startMs,
          endMs,
          durationMs: endMs - startMs,
          status: statusOf(sp.status?.code),
          statusMessage: sp.status?.message || undefined,
          attributes: attrs(sp.attributes),
          resource,
          scope: scope.scope?.name ?? scope.instrumentationLibrary?.name,
          events: (sp.events ?? []).map((e) => ({
            timeMs: num(e.timeUnixNano) / 1e6,
            name: e.name ?? '',
            attributes: attrs(e.attributes),
          })),
          links: (sp.links ?? []).map((l) => ({ traceID: normId(l.traceId), spanID: normId(l.spanId), attributes: attrs(l.attributes) })),
        })
      }
    }
  }
  return out
}

/* ─────────── tree / critical path ─────────── */

export interface OrderedSpan {
  span: TraceSpan
  depth: number
  childCount: number
  /** Ancestors' span ids, root first (for collapsing). */
  ancestors: string[]
}

/** Depth-first order, children by start time; orphans (missing parent) become roots. */
export function orderSpans(spans: TraceSpan[]): OrderedSpan[] {
  const byId = new Map(spans.map((s) => [s.spanID, s]))
  const children = new Map<string, TraceSpan[]>()
  const roots: TraceSpan[] = []
  for (const s of spans) {
    if (s.parentSpanID && byId.has(s.parentSpanID) && s.parentSpanID !== s.spanID) {
      const list = children.get(s.parentSpanID) ?? []
      list.push(s)
      children.set(s.parentSpanID, list)
    } else roots.push(s)
  }
  const byStart = (a: TraceSpan, b: TraceSpan) => a.startMs - b.startMs || a.spanID.localeCompare(b.spanID)
  roots.sort(byStart)
  const out: OrderedSpan[] = []
  const seen = new Set<string>()
  const walk = (s: TraceSpan, depth: number, ancestors: string[]) => {
    if (seen.has(s.spanID)) return
    seen.add(s.spanID)
    const kids = (children.get(s.spanID) ?? []).sort(byStart)
    out.push({ span: s, depth, childCount: kids.length, ancestors })
    for (const k of kids) walk(k, depth + 1, [...ancestors, s.spanID])
  }
  for (const r of roots) walk(r, 0, [])
  return out
}

/**
 * Critical path: starting at the root, repeatedly follow the child that
 * finishes last *before* the current cursor, walking backwards in time — the
 * spans whose latency actually gates the trace's end. Time not covered by any
 * child is the parent's own (self) contribution.
 *
 * Returns the set of span ids on the path plus, per span, the milliseconds it
 * contributes to end-to-end latency.
 */
export function criticalPath(spans: TraceSpan[]): { ids: Set<string>; contribution: Map<string, number> } {
  const ids = new Set<string>()
  const contribution = new Map<string, number>()
  if (!spans.length) return { ids, contribution }
  const children = new Map<string, TraceSpan[]>()
  const byId = new Map(spans.map((s) => [s.spanID, s]))
  for (const s of spans) {
    if (s.parentSpanID && byId.has(s.parentSpanID)) {
      const l = children.get(s.parentSpanID) ?? []
      l.push(s)
      children.set(s.parentSpanID, l)
    }
  }
  const roots = spans.filter((s) => !s.parentSpanID || !byId.has(s.parentSpanID))
  const root = roots.reduce((a, b) => (b.durationMs > a.durationMs ? b : a), roots[0] ?? spans[0])

  const add = (id: string, ms: number) => {
    if (ms <= 0) return
    contribution.set(id, (contribution.get(id) ?? 0) + ms)
  }

  const visit = (span: TraceSpan, end: number, depth: number) => {
    ids.add(span.spanID)
    if (depth > 512) return
    let cursor = Math.min(end, span.endMs)
    const kids = (children.get(span.spanID) ?? []).slice().sort((a, b) => b.endMs - a.endMs)
    while (cursor > span.startMs) {
      // last-finishing child that ends at or before the cursor (and overlaps the span)
      const next = kids.find((k) => k.endMs <= cursor + 1e-6 && k.endMs > span.startMs && !ids.has(k.spanID))
      if (!next) {
        add(span.spanID, cursor - span.startMs)
        break
      }
      add(span.spanID, cursor - next.endMs)
      visit(next, cursor, depth + 1)
      cursor = Math.max(span.startMs, next.startMs)
    }
  }
  visit(root, root.endMs, 0)
  return { ids, contribution }
}

export interface ServiceShare {
  service: string
  spans: number
  errors: number
  /** Sum of span self time (duration minus time covered by children). */
  selfMs: number
  totalMs: number
}

/** Self time of a span = duration − union of its children's intervals (clipped to the span). */
export function selfTimes(spans: TraceSpan[]): Map<string, number> {
  const children = new Map<string, TraceSpan[]>()
  for (const s of spans) {
    if (!s.parentSpanID) continue
    const l = children.get(s.parentSpanID) ?? []
    l.push(s)
    children.set(s.parentSpanID, l)
  }
  const out = new Map<string, number>()
  for (const s of spans) {
    const iv = (children.get(s.spanID) ?? [])
      .map((c) => [Math.max(s.startMs, c.startMs), Math.min(s.endMs, c.endMs)] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0])
    let covered = 0
    let curA = -Infinity
    let curB = -Infinity
    for (const [a, b] of iv) {
      if (a > curB) {
        if (curB > curA) covered += curB - curA
        curA = a
        curB = b
      } else curB = Math.max(curB, b)
    }
    if (curB > curA) covered += curB - curA
    out.set(s.spanID, Math.max(0, s.durationMs - covered))
  }
  return out
}

export function serviceBreakdown(spans: TraceSpan[]): ServiceShare[] {
  const self = selfTimes(spans)
  const m = new Map<string, ServiceShare>()
  for (const s of spans) {
    const row = m.get(s.serviceName) ?? { service: s.serviceName, spans: 0, errors: 0, selfMs: 0, totalMs: 0 }
    row.spans++
    if (s.status === 'error') row.errors++
    row.selfMs += self.get(s.spanID) ?? 0
    row.totalMs += s.durationMs
    m.set(s.serviceName, row)
  }
  return [...m.values()].sort((a, b) => b.selfMs - a.selfMs)
}

export interface OpDelta {
  key: string
  service: string
  name: string
  aCount: number
  bCount: number
  aMs: number
  bMs: number
  deltaMs: number
}

/** Per (service, operation): total span time in A vs B, sorted by |delta|. */
export function compareTraces(a: TraceSpan[], b: TraceSpan[]): OpDelta[] {
  const m = new Map<string, OpDelta>()
  const add = (s: TraceSpan, side: 'a' | 'b') => {
    const key = `${s.serviceName}\u0000${s.name}`
    const row = m.get(key) ?? { key, service: s.serviceName, name: s.name, aCount: 0, bCount: 0, aMs: 0, bMs: 0, deltaMs: 0 }
    if (side === 'a') {
      row.aCount++
      row.aMs += s.durationMs
    } else {
      row.bCount++
      row.bMs += s.durationMs
    }
    m.set(key, row)
  }
  a.forEach((s) => add(s, 'a'))
  b.forEach((s) => add(s, 'b'))
  return [...m.values()]
    .map((r) => ({ ...r, deltaMs: r.bMs - r.aMs }))
    .sort((x, y) => Math.abs(y.deltaMs) - Math.abs(x.deltaMs))
}

/** Percentile (nearest-rank) of a list; NaN for empty. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}
