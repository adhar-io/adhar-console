/**
 * Support / end-of-life dates for the runtimes and frameworks the Tech stack
 * tab reports, so "Java 11" or "Spring Boot 3.3" can be flagged without a
 * network call.
 *
 * LAST REVIEWED: 2026-10 (October 2026).
 * Re-check against each project's published policy (endoflife.date is a
 * convenient index) at least every six months, and bump REVIEWED_AT. The
 * console never fetches this at runtime: a static, dated table is honest
 * about its age, an external call is a dependency and a privacy leak.
 *
 * Dates are the END of free/community support for the cycle (the day after
 * which no more fixes ship from the upstream project):
 *   - Java: Eclipse Temurin (Adoptium) community builds for LTS releases,
 *     six months after GA for feature releases.
 *   - Node.js / Python / Go / .NET / PostgreSQL / Ruby / PHP / Django /
 *     Angular / Rails / MySQL: the upstream project's own EOL date.
 *   - Spring Boot: end of OSS support (commercial support runs longer).
 *   - React / Vue: only the latest major is maintained upstream, so an older
 *     major is "end of life" from the day its successor shipped.
 * A date marked `approx` is a published schedule that has not happened yet
 * (or an announced month) — good to plan by, not to the day.
 */

export const REVIEWED_AT = '2026-10'

export interface SupportCycle {
  /** The release line, matched against a version's prefix: `21`, `3.12`, `1.25`. */
  cycle: string
  /** End of support (ISO date). Undefined = no announced end yet. */
  eol?: string
  lts?: boolean
  approx?: boolean
  note?: string
}

export interface SupportProduct {
  label: string
  /** How many dotted parts identify a cycle: 1 → `21`, 2 → `3.12`. */
  parts: 1 | 2
  /** Where the dates come from — shown in tooltips. */
  policy: string
  cycles: SupportCycle[]
}

/** Keyed by the catalog tech key (TECH_MAP / catalog-techstack.ts). */
export const SUPPORT_TABLE: Record<string, SupportProduct> = {
  java: {
    label: 'Java',
    parts: 1,
    policy: 'Eclipse Temurin community support (LTS); feature releases end 6 months after GA',
    cycles: [
      { cycle: '8', eol: '2030-12-31', lts: true, note: 'legacy LTS — community builds only' },
      { cycle: '9', eol: '2018-03-20' },
      { cycle: '10', eol: '2018-09-25' },
      { cycle: '11', eol: '2027-10-31', lts: true },
      { cycle: '12', eol: '2019-09-17' },
      { cycle: '13', eol: '2020-03-17' },
      { cycle: '14', eol: '2020-09-15' },
      { cycle: '15', eol: '2021-03-16' },
      { cycle: '16', eol: '2021-09-14' },
      { cycle: '17', eol: '2027-10-31', lts: true },
      { cycle: '18', eol: '2022-09-20' },
      { cycle: '19', eol: '2023-03-21' },
      { cycle: '20', eol: '2023-09-19' },
      { cycle: '21', eol: '2029-12-31', lts: true },
      { cycle: '22', eol: '2024-09-17' },
      { cycle: '23', eol: '2025-03-18' },
      { cycle: '24', eol: '2025-09-16' },
      { cycle: '25', eol: '2031-09-30', lts: true, approx: true },
      { cycle: '26', eol: '2026-09-15' },
      { cycle: '27', eol: '2027-03-16', approx: true },
    ],
  },
  node: {
    label: 'Node.js',
    parts: 1,
    policy: 'Node.js release schedule (even majors become LTS)',
    cycles: [
      { cycle: '12', eol: '2022-04-30', lts: true },
      { cycle: '14', eol: '2023-04-30', lts: true },
      { cycle: '16', eol: '2023-09-11', lts: true },
      { cycle: '17', eol: '2022-06-01' },
      { cycle: '18', eol: '2025-04-30', lts: true },
      { cycle: '19', eol: '2023-06-01' },
      { cycle: '20', eol: '2026-04-30', lts: true },
      { cycle: '21', eol: '2024-06-01' },
      { cycle: '22', eol: '2027-04-30', lts: true },
      { cycle: '23', eol: '2025-06-01' },
      { cycle: '24', eol: '2028-04-30', lts: true },
      { cycle: '25', eol: '2026-06-01' },
      { cycle: '26', eol: '2029-04-30', lts: true, approx: true },
    ],
  },
  python: {
    label: 'Python',
    parts: 2,
    policy: 'Python release cycle (PEP 602: five years per minor)',
    cycles: [
      { cycle: '3.7', eol: '2023-06-27' },
      { cycle: '3.8', eol: '2024-10-07' },
      { cycle: '3.9', eol: '2025-10-31' },
      { cycle: '3.10', eol: '2026-10-31' },
      { cycle: '3.11', eol: '2027-10-31' },
      { cycle: '3.12', eol: '2028-10-31' },
      { cycle: '3.13', eol: '2029-10-31' },
      { cycle: '3.14', eol: '2030-10-31' },
    ],
  },
  go: {
    label: 'Go',
    parts: 2,
    policy: 'Go supports the two most recent minor releases',
    cycles: [
      { cycle: '1.20', eol: '2024-02-06' },
      { cycle: '1.21', eol: '2024-08-13' },
      { cycle: '1.22', eol: '2025-02-11' },
      { cycle: '1.23', eol: '2025-08-12' },
      { cycle: '1.24', eol: '2026-02-10' },
      { cycle: '1.25', eol: '2026-08-11' },
      { cycle: '1.26', eol: '2027-02-09', approx: true },
      { cycle: '1.27', eol: '2027-08-10', approx: true },
    ],
  },
  dotnet: {
    label: '.NET',
    parts: 1,
    policy: 'Microsoft .NET support policy (LTS 3 years, STS 2 years)',
    cycles: [
      { cycle: '5', eol: '2022-05-10' },
      { cycle: '6', eol: '2024-11-12', lts: true },
      { cycle: '7', eol: '2024-05-14' },
      { cycle: '8', eol: '2026-11-10', lts: true },
      { cycle: '9', eol: '2026-11-10' },
      { cycle: '10', eol: '2028-11-14', lts: true },
    ],
  },
  'spring-boot': {
    label: 'Spring Boot',
    parts: 2,
    policy: 'Spring Boot OSS support (commercial support is longer)',
    cycles: [
      { cycle: '2.6', eol: '2022-11-24' },
      { cycle: '2.7', eol: '2023-06-30' },
      { cycle: '3.0', eol: '2023-12-31' },
      { cycle: '3.1', eol: '2024-06-30' },
      { cycle: '3.2', eol: '2024-12-31' },
      { cycle: '3.3', eol: '2025-06-30' },
      { cycle: '3.4', eol: '2025-12-31' },
      { cycle: '3.5', eol: '2026-06-30' },
      { cycle: '4.0', eol: '2026-12-31', approx: true },
      { cycle: '4.1', eol: '2027-06-30', approx: true },
    ],
  },
  react: {
    label: 'React',
    parts: 1,
    policy: 'React maintains only the latest major',
    cycles: [
      { cycle: '16', eol: '2020-10-20', note: 'superseded by React 17' },
      { cycle: '17', eol: '2022-03-29', note: 'superseded by React 18' },
      { cycle: '18', eol: '2024-12-05', note: 'superseded by React 19 — no further upstream fixes' },
      { cycle: '19' },
    ],
  },
  vue: {
    label: 'Vue',
    parts: 1,
    policy: 'Vue.js support policy',
    cycles: [
      { cycle: '2', eol: '2023-12-31' },
      { cycle: '3' },
    ],
  },
  angular: {
    label: 'Angular',
    parts: 1,
    policy: 'Angular support policy (18 months per major)',
    cycles: [
      { cycle: '15', eol: '2024-05-18' },
      { cycle: '16', eol: '2024-11-08' },
      { cycle: '17', eol: '2025-05-15' },
      { cycle: '18', eol: '2025-11-21' },
      { cycle: '19', eol: '2026-05-19' },
      { cycle: '20', eol: '2026-11-28' },
      { cycle: '21', eol: '2027-05-19', approx: true },
      { cycle: '22', eol: '2027-11-30', approx: true },
    ],
  },
  django: {
    label: 'Django',
    parts: 2,
    policy: 'Django release roadmap',
    cycles: [
      { cycle: '3.2', eol: '2024-04-01', lts: true },
      { cycle: '4.0', eol: '2023-04-01' },
      { cycle: '4.1', eol: '2023-12-01' },
      { cycle: '4.2', eol: '2026-04-30', lts: true },
      { cycle: '5.0', eol: '2025-04-30' },
      { cycle: '5.1', eol: '2025-12-31' },
      { cycle: '5.2', eol: '2028-04-30', lts: true },
      { cycle: '6.0', eol: '2027-04-30', approx: true },
    ],
  },
  rails: {
    label: 'Rails',
    parts: 2,
    policy: 'Rails maintenance policy (security fixes)',
    cycles: [
      { cycle: '6.1', eol: '2024-10-01' },
      { cycle: '7.0', eol: '2025-04-01' },
      { cycle: '7.1', eol: '2025-10-01' },
      { cycle: '7.2', eol: '2026-08-09' },
      { cycle: '8.0', eol: '2026-11-07' },
      { cycle: '8.1', eol: '2027-10-01', approx: true },
    ],
  },
  ruby: {
    label: 'Ruby',
    parts: 2,
    policy: 'Ruby maintenance branches',
    cycles: [
      { cycle: '3.0', eol: '2024-04-23' },
      { cycle: '3.1', eol: '2025-03-31' },
      { cycle: '3.2', eol: '2026-03-31' },
      { cycle: '3.3', eol: '2027-03-31' },
      { cycle: '3.4', eol: '2028-03-31' },
    ],
  },
  php: {
    label: 'PHP',
    parts: 2,
    policy: 'PHP supported versions',
    cycles: [
      { cycle: '7.4', eol: '2022-11-28' },
      { cycle: '8.0', eol: '2023-11-26' },
      { cycle: '8.1', eol: '2025-12-31' },
      { cycle: '8.2', eol: '2026-12-31' },
      { cycle: '8.3', eol: '2027-12-31' },
      { cycle: '8.4', eol: '2028-12-31' },
    ],
  },
  postgres: {
    label: 'PostgreSQL',
    parts: 1,
    policy: 'PostgreSQL versioning policy (5 years per major)',
    cycles: [
      { cycle: '11', eol: '2023-11-09' },
      { cycle: '12', eol: '2024-11-21' },
      { cycle: '13', eol: '2025-11-13' },
      { cycle: '14', eol: '2026-11-12' },
      { cycle: '15', eol: '2027-11-11' },
      { cycle: '16', eol: '2028-11-09' },
      { cycle: '17', eol: '2029-11-08' },
      { cycle: '18', eol: '2030-11-14' },
    ],
  },
  mysql: {
    label: 'MySQL',
    parts: 2,
    policy: 'MySQL lifecycle (LTS releases)',
    cycles: [
      { cycle: '5.7', eol: '2023-10-31' },
      { cycle: '8.0', eol: '2026-04-30' },
      { cycle: '8.4', eol: '2032-04-30', lts: true },
    ],
  },
}

/** Window before the end date in which a cycle is flagged as ending soon. */
export const ENDING_SOON_DAYS = 180

export type SupportState = 'supported' | 'ending' | 'eol' | 'unknown'

export interface SupportStatus {
  state: SupportState
  product: string
  cycle?: string
  eol?: string
  lts?: boolean
  approx?: boolean
  /** Whole days until (positive) or since (negative) the end date. */
  days?: number
  note?: string
  policy?: string
}

/** Product keys share entries under their aliases. */
const ALIAS: Record<string, string> = { nodejs: 'node', 'node.js': 'node', golang: 'go', postgresql: 'postgres', springboot: 'spring-boot', '.net': 'dotnet', 'ruby-on-rails': 'rails' }

/** `21.0.2` → `21` (parts 1), `3.12.4` → `3.12` (parts 2); `20+` → `20`; `8.0` .NET → `8`. */
function cycleOf(version: string, parts: 1 | 2): string | undefined {
  const m = /(\d+)(?:\.(\d+))?/.exec(version.replace(/^v/i, ''))
  if (!m) return undefined
  if (parts === 1) return m[1]
  return m[2] != null ? `${m[1]}.${m[2]}` : undefined
}

function cmpCycle(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * Where `version` of `key` stands on `today`. `unknown` when the tech is
 * not in the table, the version has no number, or the version is newer than
 * every cycle the table knows (the table is out of date, not the service).
 * A version older than every cycle in the table is end-of-life.
 */
export function supportStatus(key: string, version: string | undefined, today: Date = new Date()): SupportStatus {
  const product = SUPPORT_TABLE[ALIAS[key] ?? key]
  if (!product) return { state: 'unknown', product: key }
  const base = { product: product.label, policy: product.policy }
  if (!version) return { state: 'unknown', ...base }
  // Java's legacy `1.8` spelling.
  const v = (ALIAS[key] ?? key) === 'java' ? version.replace(/^1\.(\d)(?!\d)/, '$1') : version
  const cycle = cycleOf(v, product.parts)
  if (!cycle) return { state: 'unknown', ...base }
  const hit = product.cycles.find((c) => c.cycle === cycle)
  if (!hit) {
    const oldest = product.cycles[0]?.cycle
    if (oldest && cmpCycle(cycle, oldest) < 0) return { state: 'eol', ...base, cycle, note: `older than ${product.label} ${oldest}, the oldest line tracked` }
    return { state: 'unknown', ...base, cycle, note: `newer than the support table (reviewed ${REVIEWED_AT})` }
  }
  if (!hit.eol) return { state: 'supported', ...base, cycle, lts: hit.lts, note: hit.note ?? 'current line' }
  const end = new Date(`${hit.eol}T23:59:59Z`)
  const days = Math.floor((end.getTime() - today.getTime()) / 86_400_000)
  const state: SupportState = days < 0 ? 'eol' : days <= ENDING_SOON_DAYS ? 'ending' : 'supported'
  return { state, ...base, cycle, eol: hit.eol, lts: hit.lts, approx: hit.approx, days, note: hit.note }
}

const SEVERITY: Record<SupportState, number> = { eol: 3, ending: 2, supported: 1, unknown: 0 }

/** The most urgent of several statuses (eol › ending › supported › unknown). */
export function worstSupport<T extends { status: SupportStatus }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((w, x) => (!w || SEVERITY[x.status.state] > SEVERITY[w.status.state] ? x : w), undefined)
}

/** A short human phrase: "EOL since Apr 2026", "ends Nov 2026", "supported until Dec 2029". */
export function describeSupport(s: SupportStatus): string {
  const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  if (s.state === 'eol') return s.eol ? `end of life since ${month(s.eol)}` : 'end of life'
  if (s.state === 'ending') return `support ends ${month(s.eol!)}${s.approx ? ' (planned)' : ''}`
  if (s.state === 'supported') return s.eol ? `supported until ${month(s.eol)}${s.approx ? ' (planned)' : ''}` : 'supported'
  return s.note ?? 'no support data'
}
