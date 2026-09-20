/**
 * The on-disk shape of a performance test, and the starter scripts.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TESTS LIVE IN GIT
 * ---------------------------------------------------------------------------
 * A load test is code. It is reviewed, it has a history, it is the thing you
 * bisect when last week's p95 was 90ms and today's is 400ms. Keeping scripts
 * in ConfigMaps — the only place the k6 operator can read them — makes that
 * impossible: a ConfigMap has no author, no diff and no previous version, so
 * "what changed?" has no answer and a number has no provenance.
 *
 * So the repository is the source of truth and the ConfigMap is a build
 * artefact, materialised at launch and stamped with the commit it came from.
 * That stamp is what lets a result be traced back to the exact script that
 * produced it.
 *
 * Layout, one directory per test:
 *
 *   tests/<name>/script.js   — the k6 script
 *   tests/<name>/test.json   — everything that is not the script
 *
 * This module is pure: no network, no React. The parsing and the defaults are
 * the part worth testing, because a malformed config must degrade to a usable
 * test rather than an unusable page.
 */

export const TESTS_DIR = 'tests'
export const SCRIPT_FILE = 'script.js'
export const CONFIG_FILE = 'test.json'

/** Labels the console stamps on generated ConfigMaps and TestRuns. */
export const LABEL_TEST = 'adhar.io/perf-test'
export const LABEL_COMMIT = 'adhar.io/perf-commit'
export const LABEL_MANAGED = 'app.kubernetes.io/managed-by'

export interface Threshold {
  /** e.g. `http_req_duration` */
  metric: string
  /** e.g. `p(95)<500` */
  expression: string
}

export interface PerfTestConfig {
  /** Human title; the directory name stays the id. */
  title: string
  description: string
  /** Namespace the TestRun and its ConfigMap are created in. */
  namespace: string
  /** Runner pods the load is split across. */
  parallelism: number
  /** Extra k6 CLI arguments, e.g. `--vus 50 --duration 30s`. */
  arguments: string
  /** Environment variables passed to every runner. */
  env: Record<string, string>
  /**
   * Thresholds mirrored from the script, for display only.
   *
   * k6 enforces what is IN the script; anything here that the script does not
   * declare would be a promise the run cannot keep. The UI says so rather than
   * pretending this list is authoritative.
   */
  thresholds: Threshold[]
  tags: string[]
  /** Workload this test drives, so a report can chart the right pods. */
  target?: {
    namespace?: string
    /** Label selector identifying the system under test, e.g. `app=checkout`. */
    selector?: string
    /** Service the test calls, for the report header. */
    service?: string
  }
}

export const DEFAULT_CONFIG: PerfTestConfig = {
  title: '',
  description: '',
  namespace: 'default',
  parallelism: 1,
  arguments: '',
  env: {},
  thresholds: [],
  tags: [],
}

/* ─────────────────────────── parsing ─────────────────────────── */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function strMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val)
  }
  return out
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Read `test.json`, tolerating anything.
 *
 * A config someone hand-edited badly should still open in the editor so they
 * can fix it — refusing to parse would lock them out of the only screen that
 * lets them repair it.
 */
export function parseConfig(raw: string, name: string): PerfTestConfig {
  let doc: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>
    }
  } catch {
    // Fall through to defaults; the editor still shows the raw text.
  }

  const parallelism = Number(doc.parallelism)
  const rawTarget = doc.target && typeof doc.target === 'object' && !Array.isArray(doc.target)
    ? doc.target as Record<string, unknown>
    : undefined
  // An empty `target: {}` must come back as ABSENT, not as an object of
  // undefineds — the UI tests `config.target` for truthiness and would render
  // a "system under test" section describing nothing.
  const target = rawTarget &&
      (str(rawTarget.namespace) || str(rawTarget.selector) || str(rawTarget.service))
    ? rawTarget
    : undefined

  return {
    title: str(doc.title) || humanize(name),
    description: str(doc.description),
    namespace: str(doc.namespace) || DEFAULT_CONFIG.namespace,
    // Parallelism below 1 would create a TestRun the operator never starts.
    parallelism: Number.isFinite(parallelism) && parallelism >= 1 ? Math.floor(parallelism) : 1,
    arguments: str(doc.arguments),
    env: strMap(doc.env),
    thresholds: Array.isArray(doc.thresholds)
      ? doc.thresholds.flatMap((t) => {
        if (!t || typeof t !== 'object') return []
        const o = t as Record<string, unknown>
        const metric = str(o.metric)
        const expression = str(o.expression)
        return metric && expression ? [{ metric, expression }] : []
      })
      : [],
    tags: strList(doc.tags),
    ...(target
      ? {
        target: {
          namespace: str(target.namespace) || undefined,
          selector: str(target.selector) || undefined,
          service: str(target.service) || undefined,
        },
      }
      : {}),
  }
}

/** Serialise for commit — stable key order so diffs stay readable. */
export function serialiseConfig(c: PerfTestConfig): string {
  const ordered: Record<string, unknown> = {
    title: c.title,
    description: c.description,
    namespace: c.namespace,
    parallelism: c.parallelism,
    arguments: c.arguments,
    env: c.env,
    thresholds: c.thresholds,
    tags: c.tags,
  }
  if (c.target && (c.target.namespace || c.target.selector || c.target.service)) {
    ordered.target = c.target
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

function humanize(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

/* ─────────────────────────── names ─────────────────────────── */

/**
 * A test's directory name is also its Kubernetes object name, so it has to
 * satisfy both. DNS-1123: lowercase alphanumerics and dashes, starting and
 * ending with an alphanumeric.
 */
export const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export function normaliseName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    // A trailing dash can survive the slice.
    .replace(/-+$/, '')
}

export function nameError(name: string): string | null {
  if (!name) return 'A name is required.'
  if (!NAME_RE.test(name)) {
    return 'Lowercase letters, numbers and dashes only — it also names the Kubernetes objects.'
  }
  return null
}

/** `tests/checkout-load/script.js` → `checkout-load`. */
export function testNameFromPath(path: string): string | null {
  const m = path.match(new RegExp(`^${TESTS_DIR}/([^/]+)/`))
  return m ? m[1] : null
}

export const scriptPath = (name: string) => `${TESTS_DIR}/${name}/${SCRIPT_FILE}`
export const configPath = (name: string) => `${TESTS_DIR}/${name}/${CONFIG_FILE}`

/* ─────────────────────────── starters ─────────────────────────── */

export interface Starter {
  id: string
  label: string
  blurb: string
  script(name: string): string
  config(name: string): Partial<PerfTestConfig>
}

/**
 * Starter scripts.
 *
 * Every one declares thresholds, because a load test without them measures
 * rather than judges — it produces a number and no verdict, and the whole
 * point of running it in CI is the verdict.
 */
export const STARTERS: Starter[] = [
  {
    id: 'smoke',
    label: 'Smoke test',
    blurb: 'One user, a handful of requests — proves the script and the target work at all.',
    script: () =>
      `import http from 'k6/http'
import { check, sleep } from 'k6'

// A smoke test answers one question: does this work at all? Keep it tiny —
// it runs on every change, and it is the thing that tells you a failure is
// real rather than a broken script.
export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:8080'

export default function () {
  const res = http.get(\`\${BASE}/\`)
  check(res, {
    'status is 200': (r) => r.status === 200,
  })
  sleep(1)
}
`,
    config: () => ({
      description: 'Single-user sanity check.',
      arguments: '',
      thresholds: [
        { metric: 'http_req_failed', expression: 'rate<0.01' },
        { metric: 'http_req_duration', expression: 'p(95)<500' },
      ],
      tags: ['smoke'],
    }),
  },
  {
    id: 'load',
    label: 'Load test',
    blurb: 'Ramp to a steady level and hold — what normal busy looks like.',
    script: () =>
      `import http from 'k6/http'
import { check, sleep } from 'k6'

// Ramp UP, HOLD, ramp DOWN. The hold is the part that matters: steady state
// is where queues fill, caches settle and leaks show. A test that only ramps
// measures the ramp.
export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '2m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800', 'p(99)<2000'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:8080'

export default function () {
  const res = http.get(\`\${BASE}/\`)
  check(res, { 'status is 200': (r) => r.status === 200 })
  // Think time keeps this a load test rather than a benchmark of your own
  // loop: real users pause, and without it you measure the client.
  sleep(Math.random() * 2 + 0.5)
}
`,
    config: () => ({
      description: 'Ramp to 20 VUs, hold for two minutes.',
      parallelism: 2,
      thresholds: [
        { metric: 'http_req_failed', expression: 'rate<0.01' },
        { metric: 'http_req_duration', expression: 'p(95)<800' },
      ],
      tags: ['load'],
    }),
  },
  {
    id: 'stress',
    label: 'Stress test',
    blurb: 'Climb past comfortable until something gives — finds the ceiling.',
    script: () =>
      `import http from 'k6/http'
import { check } from 'k6'

// A stress test is SUPPOSED to break something. The thresholds are therefore
// deliberately loose: you are looking for the point where they stop holding,
// not asserting that they always do.
export const options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '1m', target: 100 },
    { duration: '1m', target: 200 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    // Abort early if the target falls over completely — past this the run
    // tells you nothing new and just costs cluster time.
    http_req_failed: [{ threshold: 'rate<0.25', abortOnFail: true }],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:8080'

export default function () {
  const res = http.get(\`\${BASE}/\`)
  check(res, { 'not a server error': (r) => r.status < 500 })
}
`,
    config: () => ({
      description: 'Climb to 200 VUs; aborts if the target fails outright.',
      parallelism: 4,
      thresholds: [{ metric: 'http_req_failed', expression: 'rate<0.25' }],
      tags: ['stress'],
    }),
  },
  {
    id: 'api',
    label: 'API journey',
    blurb: 'A sequence of calls that carries state — closer to what a client does.',
    script: () =>
      `import http from 'k6/http'
import { check, group, sleep } from 'k6'

// Real clients do not hammer one endpoint; they follow a journey and carry
// state between steps. Grouping makes the summary report each step's timing
// separately, which is what tells you WHICH call got slower.
export const options = {
  vus: 10,
  duration: '2m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'group_duration{group:::list}': ['p(95)<600'],
    'group_duration{group:::detail}': ['p(95)<600'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:8080'
const params = { headers: { 'content-type': 'application/json' } }

export default function () {
  let firstId

  group('list', () => {
    const res = http.get(\`\${BASE}/api/items\`, params)
    check(res, { 'list ok': (r) => r.status === 200 })
    try {
      firstId = res.json('0.id')
    } catch {
      // A body that is not the shape we expect is a finding, not a crash.
    }
  })

  if (firstId) {
    group('detail', () => {
      const res = http.get(\`\${BASE}/api/items/\${firstId}\`, params)
      check(res, { 'detail ok': (r) => r.status === 200 })
    })
  }

  sleep(1)
}
`,
    config: () => ({
      description: 'List then detail, with per-step thresholds.',
      parallelism: 2,
      thresholds: [
        { metric: 'http_req_failed', expression: 'rate<0.01' },
        { metric: 'group_duration{group:::list}', expression: 'p(95)<600' },
      ],
      tags: ['api', 'journey'],
    }),
  },
]

export function starterById(id: string): Starter | undefined {
  return STARTERS.find((s) => s.id === id)
}

/** The README committed when the suite repository is first created. */
export function suiteReadme(org: string, repo: string): string {
  return `# Performance tests

Load and performance tests for the Adhar platform, run by the k6 operator.

Each test is a directory under \`${TESTS_DIR}/\`:

    ${TESTS_DIR}/<name>/${SCRIPT_FILE}   the k6 script
    ${TESTS_DIR}/<name>/${CONFIG_FILE}   parallelism, arguments, env, tags

Edit them here, or in the console under **Develop → Performance**, which
commits to this repository and then runs the committed version — every run is
labelled with the commit it came from, so a result can always be traced back
to the exact script that produced it.

Run locally:

    k6 run ${TESTS_DIR}/<name>/${SCRIPT_FILE}

Repository: \`${org}/${repo}\`
`
}
