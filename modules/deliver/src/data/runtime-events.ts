/**
 * One event model for both runtime-security engines on this platform.
 *
 * Tetragon and Falco answer different questions — Tetragon reports what
 * processes actually did at the kernel level and can enforce against it, Falco
 * matches a rule library against syscalls — but an operator reading a runtime
 * feed wants one list in time order, not two. Both agents already write newline
 * -delimited JSON to stdout, so both are read the same way: the container log,
 * through the apiserver the console is already authenticated to. Nothing here
 * is seeded; an engine that is not installed contributes no events.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export type RuntimeEngine = 'tetragon' | 'falco'

/** Ordered: `SEVERITY_RANK` relies on the position. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type RuntimeSeverity = typeof SEVERITIES[number]
export const SEVERITY_RANK: Record<RuntimeSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

export interface RuntimeEvent {
  id: string
  engine: RuntimeEngine
  /** ISO 8601. */
  time: string
  /** The row's headline. */
  title: string
  severity: RuntimeSeverity
  /** Why it was given that severity — shown rather than left to be guessed. */
  reason: string
  /** Engine-specific event type: `exec`, `kprobe`, `syscall`, … */
  kind: string
  node?: string
  namespace?: string
  pod?: string
  container?: string
  image?: string
  binary?: string
  args?: string
  parent?: string
  pid?: number
  uid?: number
  user?: string
  /** Tetragon: the TracingPolicy that matched. Falco: the rule that fired. */
  policy?: string
  /** Tetragon: the kernel function or tracepoint hooked. */
  hook?: string
  /** Enforcement actually applied — a kill or an override, not a request. */
  action?: string
  tags: string[]
  /** Everything the engine reported, for the detail drawer. */
  fields: Record<string, string>
}

/* ─────────── shared helpers ─────────── */

/**
 * Interactive shells. A shell starting inside a container is the one process
 * event worth raising on its own: it is how a person, rather than the image's
 * entrypoint, ends up running commands in a workload.
 */
const SHELLS = new Set(['sh', 'bash', 'ash', 'dash', 'zsh', 'ksh', 'csh', 'fish', 'busybox'])

export function basename(path: string): string {
  if (!path) return ''
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

export function isShell(binary: string): boolean {
  return SHELLS.has(basename(binary))
}

/** Tetragon enforcement verbs that mean something was actually stopped. */
const ENFORCING = new Set(['SIGKILL', 'OVERRIDE', 'SIGNAL', 'NOTIFY_ENFORCER'])

function cleanAction(action?: string): string | undefined {
  if (!action) return undefined
  const v = action.replace(/^ACTION_/, '').trim()
  return v && v !== 'POST' && v !== 'UNKNOWN' ? v : undefined
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'string') return v || undefined
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

type Json = Record<string, unknown>

/* ─────────── Tetragon ─────────── */

const TETRAGON_KINDS: Record<string, string> = {
  process_exec: 'exec',
  process_exit: 'exit',
  process_kprobe: 'kprobe',
  process_tracepoint: 'tracepoint',
  process_uprobe: 'uprobe',
  process_lsm: 'lsm',
  process_loader: 'loader',
  process_throttle: 'throttle',
}

/**
 * One line of Tetragon's JSON export.
 *
 * The envelope carries the node and timestamp and exactly one `process_*`
 * payload; `node_labels` lines carry no event and are skipped rather than
 * rendered as a blank row.
 */
export function parseTetragonEvent(line: Json): RuntimeEvent | null {
  const key = Object.keys(TETRAGON_KINDS).find((k) => line[k] !== null && typeof line[k] === 'object')
  if (!key) return null
  const kind = TETRAGON_KINDS[key]
  const body = line[key] as Json
  const proc = (body.process ?? {}) as Json
  const parent = (body.parent ?? {}) as Json
  const pod = (proc.pod ?? {}) as Json
  const container = (pod.container ?? {}) as Json
  const image = (container.image ?? {}) as Json

  const binary = str(proc.binary) ?? ''
  const args = str(proc.arguments) ?? ''
  const namespace = str(pod.namespace)
  const policy = str(body.policy_name)
  const hook = str(body.function_name) ??
    (str(body.subsys) && str(body.event) ? `${str(body.subsys)}/${str(body.event)}` : undefined)
  const action = cleanAction(str(body.action))

  let severity: RuntimeSeverity = 'info'
  let reason = 'Process activity, no policy matched'
  if (action && ENFORCING.has(action.toUpperCase())) {
    severity = 'critical'
    reason = `Tetragon enforced ${action} — the process was stopped, not just observed`
  } else if (policy) {
    severity = 'medium'
    reason = `Matched the TracingPolicy "${policy}"`
  } else if (kind === 'exec' && isShell(binary) && namespace) {
    severity = 'low'
    reason = 'An interactive shell started inside a container'
  }

  const fields: Record<string, string> = {}
  const put = (k: string, v: string | number | undefined) => {
    if (v !== undefined && v !== '') fields[k] = String(v)
  }
  put('binary', binary)
  put('arguments', args)
  put('cwd', str(proc.cwd))
  put('pid', num(proc.pid))
  put('uid', num(proc.uid))
  put('flags', str(proc.flags))
  put('start_time', str(proc.start_time))
  put('parent', str(parent.binary))
  put('parent_pid', num(parent.pid))
  put('namespace', namespace)
  put('pod', str(pod.name))
  put('container', str(container.name))
  put('image', str(image.name))
  put('node', str(line.node_name))
  put('policy', policy)
  put('hook', hook)
  put('action', action)
  if (kind === 'exit') {
    put('exit_status', num(body.status))
    put('exit_signal', str(body.signal))
  }

  const time = str(line.time) ?? str(proc.start_time) ?? ''
  const title = kind === 'kprobe' || kind === 'lsm' || kind === 'uprobe'
    ? hook ?? kind
    : kind === 'tracepoint'
    ? hook ?? 'tracepoint'
    : `${kind === 'exec' ? 'Exec' : kind === 'exit' ? 'Exit' : kind} ${basename(binary) || 'unknown'}`

  return {
    // `exec_id` identifies the process, not the event: an exec and its exit
    // share one, so the kind and time have to be part of the key or React
    // collapses the pair into a single row.
    id: `tg:${str(proc.exec_id) ?? str(proc.pid) ?? 'x'}:${kind}:${time}`,
    engine: 'tetragon',
    time,
    title,
    severity,
    reason,
    kind,
    node: str(line.node_name),
    namespace,
    pod: str(pod.name),
    container: str(container.name),
    image: str(image.name),
    binary,
    args,
    parent: str(parent.binary),
    pid: num(proc.pid),
    uid: num(proc.uid),
    policy,
    hook,
    action,
    tags: [],
    fields,
  }
}

/* ─────────── Falco ─────────── */

/** Falco's own priority scale, mapped onto the shared one. */
export const FALCO_SEVERITY: Record<string, RuntimeSeverity> = {
  Emergency: 'critical',
  Alert: 'critical',
  Critical: 'critical',
  Error: 'high',
  Warning: 'medium',
  Notice: 'low',
  Informational: 'info',
  Debug: 'info',
}

export function parseFalcoEvent(line: Json): RuntimeEvent | null {
  const rule = str(line.rule)
  if (!rule) return null
  const priority = str(line.priority) ?? 'Notice'
  const of = (line.output_fields ?? {}) as Json
  const tags = Array.isArray(line.tags) ? line.tags.filter((t): t is string => typeof t === 'string') : []

  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(of)) {
    const s = str(v)
    if (s !== undefined) fields[k] = s
  }
  const image = [str(of['container.image.repository']), str(of['container.image.tag'])]
    .filter(Boolean)
    .join(':')
  if (image) fields.image = image

  const time = str(line.time) ?? ''
  return {
    id: `fl:${time}:${rule}:${str(line.hostname) ?? ''}:${str(of['proc.pid']) ?? str(of['evt.time']) ?? ''}`,
    engine: 'falco',
    time,
    title: rule,
    severity: FALCO_SEVERITY[priority] ?? 'low',
    reason: `Falco rule "${rule}" fired at priority ${priority}`,
    kind: str(line.source) ?? 'syscall',
    node: str(line.hostname),
    namespace: str(of['k8s.ns.name']),
    pod: str(of['k8s.pod.name']),
    container: str(of['container.name']),
    image: image || undefined,
    binary: str(of['proc.exepath']) ?? str(of['proc.name']),
    args: str(of['proc.cmdline']),
    parent: str(of['proc.pname']),
    pid: num(of['proc.pid']),
    uid: num(of['user.uid']),
    user: str(of['user.name']) === '<NA>' ? undefined : str(of['user.name']),
    policy: rule,
    tags,
    fields: { ...fields, priority, output: str(line.output) ?? '' },
  }
}

/* ─────────── stream ─────────── */

/**
 * Parse an agent's log output.
 *
 * Both agents print one JSON object per line, but a log tail is not a clean
 * JSON document: agents log plain-text startup banners, and the first line of
 * a tail is routinely a fragment of a line that began before the window. Those
 * are skipped — a malformed line is not an error worth failing a feed over.
 */
export function parseEventLines(text: string, engine: RuntimeEngine): RuntimeEvent[] {
  const out: RuntimeEvent[] = []
  for (const line of (text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    let json: Json
    try {
      json = JSON.parse(trimmed) as Json
    } catch {
      continue
    }
    const event = engine === 'tetragon' ? parseTetragonEvent(json) : parseFalcoEvent(json)
    if (event) out.push(event)
  }
  return out
}

/** Newest first, with a stable tie-break so equal timestamps do not shuffle. */
export function byNewest(a: RuntimeEvent, b: RuntimeEvent): number {
  if (a.time !== b.time) return a.time < b.time ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export interface EventFilter {
  engines?: RuntimeEngine[]
  severities?: RuntimeSeverity[]
  namespace?: string
  /** Free text over the title, pod, binary, policy and namespace. */
  search?: string
}

export function matchesFilter(e: RuntimeEvent, f: EventFilter): boolean {
  if (f.engines?.length && !f.engines.includes(e.engine)) return false
  if (f.severities?.length && !f.severities.includes(e.severity)) return false
  if (f.namespace && e.namespace !== f.namespace) return false
  const q = f.search?.trim().toLowerCase()
  if (q) {
    const hay = [e.title, e.pod, e.binary, e.args, e.policy, e.namespace, e.node, e.container]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

export interface Tally {
  name: string
  count: number
}

export interface RuntimeSummary {
  total: number
  bySeverity: Record<RuntimeSeverity, number>
  byEngine: Record<RuntimeEngine, number>
  namespaces: Tally[]
  rules: Tally[]
  binaries: Tally[]
  /** Events per minute across the observed window, or 0 when it is not known. */
  rate: number
  oldest?: string
  newest?: string
}

function top(counts: Map<string, number>, limit: number): Tally[] {
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    // Count first, then name, so equal counts do not reorder between polls.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

export function summarise(events: RuntimeEvent[], limit = 6): RuntimeSummary {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<RuntimeSeverity, number>
  const byEngine = { tetragon: 0, falco: 0 } as Record<RuntimeEngine, number>
  const ns = new Map<string, number>()
  const rules = new Map<string, number>()
  const bins = new Map<string, number>()
  let oldest: string | undefined
  let newest: string | undefined

  for (const e of events) {
    bySeverity[e.severity]++
    byEngine[e.engine]++
    if (e.namespace) ns.set(e.namespace, (ns.get(e.namespace) ?? 0) + 1)
    // What matched: a Falco rule or a Tetragon policy. Plain process activity
    // matched nothing and would otherwise dominate the list with "exec".
    if (e.policy) rules.set(e.policy, (rules.get(e.policy) ?? 0) + 1)
    const b = basename(e.binary ?? '')
    if (b) bins.set(b, (bins.get(b) ?? 0) + 1)
    if (e.time) {
      if (!oldest || e.time < oldest) oldest = e.time
      if (!newest || e.time > newest) newest = e.time
    }
  }

  const spanMs = oldest && newest ? Date.parse(newest) - Date.parse(oldest) : 0
  const rate = spanMs > 1000 ? (events.length / spanMs) * 60_000 : 0

  return {
    total: events.length,
    bySeverity,
    byEngine,
    namespaces: top(ns, limit),
    rules: top(rules, limit),
    binaries: top(bins, limit),
    rate: Math.round(rate * 10) / 10,
    oldest,
    newest,
  }
}
