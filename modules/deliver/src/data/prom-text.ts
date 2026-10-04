/**
 * Prometheus text exposition parser.
 *
 * Tetragon publishes its own counters on `:2112/metrics` and nowhere else:
 * how many events it has exported, by type and workload, since the agent
 * started; which probes it has missed; which errors it has hit. A log tail
 * shows the last few minutes, these are the totals, and there is no JSON
 * form of them to read instead.
 *
 * This is the subset of the format a `/metrics` endpoint actually emits:
 * `name{label="value",...} number [timestamp]`, with `#` comment lines. It is
 * deliberately not a full implementation — no exemplars, no protobuf.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export interface Sample {
  name: string
  labels: Record<string, string>
  value: number
}

/**
 * Label values are quoted and may contain escaped quotes, backslashes and
 * newlines — a container argv in a label routinely does.
 */
function unescape(v: string): string {
  let out = ''
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== '\\') {
      out += v[i]
      continue
    }
    const next = v[++i]
    out += next === 'n' ? '\n' : next === '\\' ? '\\' : next === '"' ? '"' : next === undefined ? '\\' : next
  }
  return out
}

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {}
  let i = 0
  while (i < text.length) {
    const eq = text.indexOf('=', i)
    if (eq === -1) break
    const key = text.slice(i, eq).trim().replace(/^,/, '').trim()
    // Values are always quoted in the exposition format.
    const openQuote = text.indexOf('"', eq)
    if (openQuote === -1) break
    let j = openQuote + 1
    let raw = ''
    for (; j < text.length; j++) {
      if (text[j] === '\\') {
        raw += text[j] + (text[j + 1] ?? '')
        j++
        continue
      }
      if (text[j] === '"') break
      raw += text[j]
    }
    if (key) labels[key] = unescape(raw)
    i = j + 1
    while (i < text.length && (text[i] === ',' || text[i] === ' ')) i++
  }
  return labels
}

function parseValue(token: string): number {
  // The format spells these out rather than using JSON numbers.
  if (token === '+Inf') return Infinity
  if (token === '-Inf') return -Infinity
  if (token === 'NaN') return NaN
  const n = Number(token)
  return Number.isNaN(n) ? NaN : n
}

export function parsePrometheusText(text: string): Sample[] {
  const out: Sample[] = []
  for (const line of (text ?? '').split('\n')) {
    const trimmed = line.trim()
    // `# HELP` and `# TYPE` are metadata the callers here do not need.
    if (!trimmed || trimmed.startsWith('#')) continue

    const brace = trimmed.indexOf('{')
    let name: string
    let labels: Record<string, string>
    let rest: string

    if (brace === -1) {
      const sp = trimmed.indexOf(' ')
      if (sp === -1) continue
      name = trimmed.slice(0, sp)
      labels = {}
      rest = trimmed.slice(sp + 1)
    } else {
      const close = trimmed.lastIndexOf('}')
      if (close === -1) continue
      name = trimmed.slice(0, brace)
      labels = parseLabels(trimmed.slice(brace + 1, close))
      rest = trimmed.slice(close + 1)
    }

    // A trailing timestamp is allowed and ignored; the value is the first token.
    const value = parseValue(rest.trim().split(/\s+/)[0] ?? '')
    if (!name || Number.isNaN(value)) continue
    out.push({ name, labels, value })
  }
  return out
}

/** Every sample of one metric. */
export function series(samples: Sample[], name: string): Sample[] {
  return samples.filter((s) => s.name === name)
}

/** Total of one metric, optionally restricted to samples matching `where`. */
export function total(
  samples: Sample[],
  name: string,
  where?: (labels: Record<string, string>) => boolean,
): number {
  let sum = 0
  for (const s of samples) {
    if (s.name !== name) continue
    if (where && !where(s.labels)) continue
    if (Number.isFinite(s.value)) sum += s.value
  }
  return sum
}

/**
 * Totals grouped by one label, biggest first. Samples missing the label are
 * skipped rather than bucketed under an empty name — Tetragon reports host
 * processes with an empty `namespace`, and "" is not a namespace.
 */
export function groupBy(
  samples: Sample[],
  name: string,
  label: string,
  limit = 8,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const s of samples) {
    if (s.name !== name) continue
    const key = s.labels[label]
    if (!key) continue
    if (!Number.isFinite(s.value)) continue
    counts.set(key, (counts.get(key) ?? 0) + s.value)
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}
