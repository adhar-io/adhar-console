/**
 * Which agent fits the page you are on.
 *
 * Adhar AI is one surface reachable from everywhere — ⌘K on any page, and the
 * /ai page. Opening it on Develop → Pull Requests and getting the reliability
 * agent is a small papercut that repeats hundreds of times: you ask about a
 * diff, the agent reaches for pod diagnostics, and you switch manually. So the
 * roster is pre-selected from the route.
 *
 * The rule that keeps this from being annoying: it is a DEFAULT, never an
 * override. The moment someone picks an agent themselves that choice is
 * remembered and this function stops being consulted. An assistant that keeps
 * changing who you are talking to as you navigate would be worse than one that
 * always guesses wrong.
 *
 * Pure and free of React so the mapping can be tested directly — it is a table
 * of judgements, and judgements are what regress silently.
 */

export interface RouteHint {
  /** Pathname, e.g. `/develop`. */
  path: string
  /** The `section` search param the modules use for their internal tabs. */
  section?: string
}

/**
 * Sections that are about code rather than about the phase they live in.
 * Develop is mostly a git surface, but "Cloud Envs" and "Data Pipelines" are
 * not, so the mapping is per-section rather than per-phase.
 */
const REVIEW_SECTIONS = new Set(['prs', 'commits', 'branches', 'repos', 'issues'])
const SECURITY_SECTIONS = new Set(['scans', 'policy', 'rbac', 'runtime'])

/**
 * The agent to open with, or null when the page suggests nothing in
 * particular and the roster's own default should stand.
 */
export function agentForRoute(hint: RouteHint): string | null {
  const path = hint.path.toLowerCase()
  const section = (hint.section ?? '').toLowerCase()

  // Section wins over phase where it disagrees: vulnerability scans sit under
  // Deliver but are a security question, not a delivery one.
  if (SECURITY_SECTIONS.has(section)) return 'security'

  if (path.startsWith('/design')) return 'design'

  if (path.startsWith('/develop')) {
    if (REVIEW_SECTIONS.has(section)) return 'review'
    if (section === 'performance') return 'sre'
    return 'review'
  }

  // Every Deliver section that is not a security one is a delivery question.
  if (path.startsWith('/deliver')) return 'delivery'

  // Discover is metrics, logs, traces, alerts — triage, which is the
  // reliability agent's whole job.
  if (path.startsWith('/discover')) return 'sre'

  // Decide is cost, DORA and BI. Spend is the part an agent can act on.
  if (path.startsWith('/decide')) return 'finops'

  if (path.startsWith('/platform')) {
    if (section === 'chaos') return 'sre'
    if (section === 'ci') return 'delivery'
    return 'platform'
  }

  // Define is planning: issues, cycles, roadmap. None of the agents read Plane,
  // so claiming one fits would be pretending.
  if (path.startsWith('/define')) return null

  // Catalog, settings, profile, the /ai page opened directly — no page context
  // to go on.
  return null
}

/**
 * Resolve the agent to start with.
 *
 * `stored` is the user's own choice, or null if they have never made one.
 * `available` is the roster the server actually offers, which matters because
 * Review and Design are absent on an install without Gitea — routing to an
 * agent that is not in the switcher would leave it showing nothing.
 */
export function resolveInitialAgent(
  stored: string | null,
  route: RouteHint,
  available: string[],
  fallback: string,
): string {
  const has = (id: string | null): id is string => Boolean(id) && available.includes(id!)
  if (has(stored)) return stored
  const suggested = agentForRoute(route)
  if (has(suggested)) return suggested
  return available.includes(fallback) ? fallback : available[0] ?? fallback
}
