/**
 * The pure half of the k6 integration: parsing, naming and formatting.
 *
 * Kept apart from `k6.ts` because that file imports `@adhar-console/shell-ui`
 * for `useLiveRefetch`, which pulls React in and makes the whole module
 * unloadable under `deno test`. These functions are the ones most worth
 * testing — a text parser is fragile by nature — so they live where a test can
 * reach them.
 */

export interface K6Metric {
  name: string
  /** The raw right-hand side, kept so nothing is lost in translation. */
  raw: string
  /** Parsed sub-values: avg, min, med, max, p(90), p(95), rate, count… */
  values: Record<string, string>
}

export interface K6Threshold {
  /** e.g. `http_req_duration` */
  metric: string
  /** e.g. `p(95)<500` */
  expression: string
  passed: boolean
}

export interface K6Summary {
  metrics: K6Metric[]
  thresholds: K6Threshold[]
  checks?: { passed: number; failed: number }
  /** True when a summary was found at all. */
  complete: boolean
}

// `http_req_duration.........: avg=12ms min=1ms med=9ms max=99ms p(95)=44ms`
const METRIC_LINE = /^\s*(?:[✓✗×√]\s+)?([a-z0-9_]+)\.{2,}:\s*(.+)$/i
const KV = /([a-z0-9()._%]+)=([^\s]+)/gi
// Thresholds print the metric on one line and the expression indented below.
const THRESHOLD_HEAD = /^\s*([✓✗×√])\s+([a-z0-9_]+)\s*$/i
const THRESHOLD_EXPR = /^\s{4,}([a-z0-9()._]+\s*[<>=!]+\s*[0-9.]+.*)$/i

/**
 * Pull k6's end-of-test summary out of runner stdout.
 *
 * k6 writes a fixed-width text report, not JSON, unless the test was started
 * with `--summary-export` or a remote-write output. Parsing the text is
 * therefore the only way to show real numbers for a default test, and showing
 * real numbers is the point — the alternative is a page of placeholders.
 *
 * Deliberately lenient: an unparseable line is skipped rather than throwing,
 * and `complete` reports whether anything was found, so the UI can say "still
 * running / no summary yet" instead of showing an empty table as if the test
 * had produced nothing.
 */
export function parseK6Summary(text: string): K6Summary {
  const metrics: K6Metric[] = []
  const thresholds: K6Threshold[] = []
  let checks: K6Summary['checks']

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const metric = line.match(METRIC_LINE)
    if (metric) {
      const [, name, rhs] = metric
      const raw = rhs.trim()
      const values: Record<string, string> = {}
      for (const m of raw.matchAll(KV)) values[m[1].toLowerCase()] = m[2]
      // `checks....: 99.00% ✓ 2934  ✗ 30`
      if (name === 'checks') {
        const pass = raw.match(/[✓√]\s*(\d+)/)
        const fail = raw.match(/[✗×]\s*(\d+)/)
        if (pass || fail) checks = { passed: Number(pass?.[1] ?? 0), failed: Number(fail?.[1] ?? 0) }
      }
      metrics.push({ name, raw, values })
      continue
    }

    const head = line.match(THRESHOLD_HEAD)
    if (head) {
      const expr = lines[i + 1]?.match(THRESHOLD_EXPR)
      if (expr) {
        thresholds.push({
          metric: head[2].trim(),
          expression: expr[1].trim(),
          passed: head[1] === '✓' || head[1] === '√',
        })
        i++
      }
    }
  }

  return { metrics, thresholds, checks, complete: metrics.length > 0 }
}

/** The handful of metrics worth putting at the top of the page. */
export const HEADLINE_METRICS = [
  'http_reqs',
  'http_req_duration',
  'http_req_failed',
  'iterations',
  'vus_max',
  'data_received',
] as const

/** `checkout-load` → `checkout-load-r2`, `…-r2` → `…-r3`. */
export function rerunName(name: string): string {
  const m = name.match(/^(.*)-r(\d+)$/)
  const base = m ? m[1] : name
  const next = m ? Number(m[2]) + 1 : 2
  // 253 is the DNS-subdomain cap the apiserver enforces on names.
  return `${base}-r${next}`.slice(0, 253)
}

export function durationSecs(startedAt?: string, finishedAt?: string): number | undefined {
  if (!startedAt) return undefined
  const start = new Date(startedAt).getTime()
  if (Number.isNaN(start)) return undefined
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  return Math.max(0, Math.floor((end - start) / 1000))
}

export function fmtDuration(secs: number | undefined): string {
  if (secs === undefined) return '—'
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}
