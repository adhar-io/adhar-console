import { DEFAULT_CONFIG, type PerfTestConfig } from './perf-format.ts'

/**
 * Quick test — a load test described as data and generated into a k6 script.
 *
 * The builder exists for the common case — "hit these endpoints with this
 * load and tell me if p95 stays under X" — without writing JavaScript. What
 * it produces is an ordinary test in the suite: a readable script that
 * declares its thresholds, plus `test.json`. From then on it is edited,
 * gated, scheduled and run like any hand-written test.
 *
 * Pure, so it is tested without React.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

export interface QuickRequest {
  name: string
  method: HttpMethod
  url: string
  headers: Array<[string, string]>
  body?: string
  /** Status the check expects (2xx when unset). */
  expectStatus?: number
}

export interface Stage {
  /** k6 duration, e.g. `30s`, `2m`, `1h`. */
  duration: string
  target: number
}

export type Profile = 'smoke' | 'load' | 'stress' | 'spike' | 'soak' | 'custom'

export interface QuickSpec {
  name: string
  title?: string
  description?: string
  requests: QuickRequest[]
  profile: Profile
  /** Peak virtual users for the generated profiles. */
  peakVus: number
  /** Used when `profile` is `custom`. */
  stages: Stage[]
  /** Pause between iterations, seconds. */
  thinkTimeS: number
  thresholds: {
    p95Ms?: number
    errorRatePct?: number
    checksPct?: number
  }
  namespace: string
  parallelism: number
}

export const PROFILES: Array<{ id: Profile; label: string; blurb: string }> = [
  { id: 'smoke', label: 'Smoke', blurb: 'A couple of users for a minute — does it work at all?' },
  { id: 'load', label: 'Load', blurb: 'Ramp to normal peak, hold, ramp down — the everyday SLO check.' },
  { id: 'stress', label: 'Stress', blurb: 'Climb past peak in steps to find where it breaks.' },
  { id: 'spike', label: 'Spike', blurb: 'A sudden burst to several times peak, then back.' },
  { id: 'soak', label: 'Soak', blurb: 'Normal load held for a long time — leaks and slow drift.' },
  { id: 'custom', label: 'Custom', blurb: 'Your own stages.' },
]

/** The stages each named profile expands to, scaled to `peak`. */
export function profileStages(profile: Profile, peak: number, custom: Stage[] = []): Stage[] {
  const p = Math.max(1, Math.round(peak))
  switch (profile) {
    case 'smoke':
      return [{ duration: '1m', target: Math.min(p, 2) }]
    case 'load':
      return [{ duration: '2m', target: p }, { duration: '5m', target: p }, { duration: '1m', target: 0 }]
    case 'stress':
      return [
        { duration: '2m', target: p },
        { duration: '3m', target: p },
        { duration: '2m', target: Math.round(p * 1.5) },
        { duration: '3m', target: Math.round(p * 1.5) },
        { duration: '2m', target: p * 2 },
        { duration: '3m', target: p * 2 },
        { duration: '2m', target: 0 },
      ]
    case 'spike':
      return [
        { duration: '1m', target: Math.max(1, Math.round(p / 5)) },
        { duration: '20s', target: p * 4 },
        { duration: '1m', target: p * 4 },
        { duration: '20s', target: Math.max(1, Math.round(p / 5)) },
        { duration: '1m', target: 0 },
      ]
    case 'soak':
      return [{ duration: '5m', target: p }, { duration: '2h', target: p }, { duration: '5m', target: 0 }]
    default:
      return custom.length ? custom : [{ duration: '1m', target: p }]
  }
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/

/** Seconds in a k6 duration string; NaN when it is not one. */
export function durationSeconds(d: string): number {
  const parts = d.trim().match(/\d+(?:\.\d+)?(?:ms|s|m|h)/g)
  if (!parts || parts.join('') !== d.trim()) return NaN
  let total = 0
  for (const part of parts) {
    const m = part.match(DURATION_RE)!
    const n = Number(m[1])
    total += m[2] === 'ms' ? n / 1000 : m[2] === 's' ? n : m[2] === 'm' ? n * 60 : n * 3600
  }
  return total
}

export function totalSeconds(stages: Stage[]): number {
  return stages.reduce((s, x) => s + (durationSeconds(x.duration) || 0), 0)
}

/** Problems that would make the script invalid, keyed for the form. */
export function specErrors(spec: QuickSpec, stages: Stage[]): string[] {
  const out: string[] = []
  if (!spec.requests.length) out.push('Add at least one request.')
  spec.requests.forEach((r, i) => {
    if (!/^https?:\/\/[^\s]+$/i.test(r.url.trim()) && !/^\$\{__ENV\.\w+\}/.test(r.url.trim())) out.push(`Request ${i + 1}: the URL must start with http:// or https://.`)
    if (r.body && ['POST', 'PUT', 'PATCH'].includes(r.method) && looksJson(r) && !isJson(r.body)) out.push(`Request ${i + 1}: the body is not valid JSON.`)
  })
  stages.forEach((s, i) => {
    if (!Number.isFinite(durationSeconds(s.duration)) || durationSeconds(s.duration) <= 0) out.push(`Stage ${i + 1}: "${s.duration}" is not a duration like 30s, 2m or 1h.`)
    if (!(s.target >= 0)) out.push(`Stage ${i + 1}: target must be 0 or more.`)
  })
  if (!stages.some((s) => s.target > 0)) out.push('At least one stage needs virtual users.')
  return out
}

function looksJson(r: QuickRequest): boolean {
  return r.headers.some(([k, v]) => k.toLowerCase() === 'content-type' && v.includes('json')) || /^\s*[{[]/.test(r.body ?? '')
}
function isJson(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

const q = (s: string) => JSON.stringify(s)

/** The k6 script for a spec. Readable on purpose: people will edit it next. */
export function generateScript(spec: QuickSpec): string {
  const stages = profileStages(spec.profile, spec.peakVus, spec.stages)
  const th: string[] = []
  if (spec.thresholds.p95Ms) th.push(`    http_req_duration: [${q(`p(95)<${spec.thresholds.p95Ms}`)}],`)
  if (spec.thresholds.errorRatePct != null) th.push(`    http_req_failed: [${q(`rate<${(spec.thresholds.errorRatePct / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`)}],`)
  if (spec.thresholds.checksPct != null) th.push(`    checks: [${q(`rate>${(spec.thresholds.checksPct / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`)}],`)

  const reqs = spec.requests.map((r, i) => {
    const params: string[] = []
    const headers = r.headers.filter(([k]) => k.trim())
    if (headers.length) params.push(`headers: { ${headers.map(([k, v]) => `${q(k.trim())}: ${q(v)}`).join(', ')} }`)
    params.push(`tags: { name: ${q(r.name || `${r.method} ${r.url}`)} }`)
    const p = `{ ${params.join(', ')} }`
    const hasBody = r.body && !['GET', 'HEAD'].includes(r.method)
    const call = r.method === 'GET'
      ? `http.get(${q(r.url)}, ${p})`
      : r.method === 'HEAD'
      ? `http.head(${q(r.url)}, ${p})`
      : r.method === 'DELETE'
      ? `http.del(${q(r.url)}, ${hasBody ? q(r.body!) : 'null'}, ${p})`
      : `http.${r.method.toLowerCase()}(${q(r.url)}, ${hasBody ? q(r.body!) : 'null'}, ${p})`
    const expect = r.expectStatus
      ? `(res) => res.status === ${r.expectStatus}`
      : '(res) => res.status >= 200 && res.status < 300'
    const label = r.expectStatus ? `${r.name || `request ${i + 1}`}: status ${r.expectStatus}` : `${r.name || `request ${i + 1}`}: 2xx`
    return `  {
    const res = ${call}
    check(res, { ${q(label)}: ${expect} })
  }`
  })

  return `import http from 'k6/http'
import { check, sleep } from 'k6'

// Generated by the Adhar Performance Center quick-test builder.
// ${spec.title || spec.name} — ${PROFILES.find((p) => p.id === spec.profile)?.label ?? 'custom'} profile,
// peaking at ${Math.max(...stages.map((s) => s.target))} virtual users over ${fmtTotal(totalSeconds(stages))}.
// It is an ordinary k6 script from here on: edit it freely.

export const options = {
  stages: [
${stages.map((s) => `    { duration: ${q(s.duration)}, target: ${s.target} },`).join('\n')}
  ],
  thresholds: {
${th.length ? th.join('\n') : '    // No thresholds: this run will measure but not judge.'}
  },
}

export default function () {
${reqs.join('\n')}
${spec.thinkTimeS > 0 ? `  sleep(${spec.thinkTimeS})` : ''}
}
`
}

/** `test.json` for a spec. */
export function quickConfig(spec: QuickSpec): PerfTestConfig {
  let service: string | undefined
  try {
    service = new URL(spec.requests[0]?.url ?? '').host || undefined
  } catch { /* templated URL */ }
  return {
    ...DEFAULT_CONFIG,
    title: spec.title || spec.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
    description: spec.description ?? `${PROFILES.find((p) => p.id === spec.profile)?.label} test of ${spec.requests.length} endpoint${spec.requests.length === 1 ? '' : 's'}.`,
    namespace: spec.namespace || 'default',
    parallelism: Math.max(1, spec.parallelism),
    thresholds: [
      ...(spec.thresholds.p95Ms ? [{ metric: 'http_req_duration', expression: `p(95)<${spec.thresholds.p95Ms}` }] : []),
      ...(spec.thresholds.errorRatePct != null ? [{ metric: 'http_req_failed', expression: `rate<${spec.thresholds.errorRatePct / 100}` }] : []),
      ...(spec.thresholds.checksPct != null ? [{ metric: 'checks', expression: `rate>${spec.thresholds.checksPct / 100}` }] : []),
    ],
    tags: ['quick-test', spec.profile],
    ...(service ? { target: { service } } : {}),
  }
}

export function fmtTotal(s: number): string {
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${Math.round(s % 60)}s` : ''}`
  return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60) ? ` ${Math.round((s % 3600) / 60)}m` : ''}`
}
