/**
 * Reading a Tetragon TracingPolicy.
 *
 * A TracingPolicy is the unit an operator actually manages, and the two
 * questions asked of one are "what does it watch?" and "does it stop
 * anything, or only report it?". Neither is a field: the hooks are spread
 * across `kprobes`, `tracepoints`, `uprobes`, `lsmhooks` and `fentries`, and
 * enforcement is a `Sigkill`, `Override`, `Signal` or `NotifyEnforcer` action
 * buried in a matchAction inside a selector inside one of those lists.
 *
 * Tetragon v1.7 ships no `status` subresource on the CRD, so whether a policy
 * is loaded is not knowable from the object — that comes from the agent's
 * metrics. Everything here is read from the spec, which is what the operator
 * wrote and what the console can state without guessing.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

type Json = Record<string, unknown>

/** Actions that stop or alter the process rather than report on it. */
const ENFORCING_ACTIONS = new Set(['sigkill', 'override', 'signal', 'notifyenforcer'])

export interface PolicyHook {
  /** `kprobe`, `tracepoint`, `uprobe`, `lsm` or `fentry`. */
  type: string
  /** The kernel symbol, tracepoint or user function hooked. */
  name: string
  /** Whether this hook carries an enforcing action. */
  enforcing: boolean
}

export interface PolicyView {
  name: string
  /** Namespaced policies apply to one namespace; TracingPolicy is cluster-wide. */
  namespace?: string
  scope: 'cluster' | 'namespace'
  hooks: PolicyHook[]
  /** Deduplicated action verbs the policy can take, e.g. `Sigkill`. */
  actions: string[]
  enforcing: boolean
  /** Human description of what the policy is scoped to. */
  selector?: string
  created?: string
}

const HOOK_LISTS: Array<[string, string, string]> = [
  // [spec field, hook type, field holding the symbol name]
  ['kprobes', 'kprobe', 'call'],
  ['tracepoints', 'tracepoint', 'event'],
  ['uprobes', 'uprobe', 'symbols'],
  ['lsmhooks', 'lsm', 'hook'],
  ['fentries', 'fentry', 'call'],
  ['usdts', 'usdt', 'symbols'],
]

function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === 'object') : []
}

function hookName(entry: Json, field: string): string {
  // A tracepoint is identified by subsystem and event together: `sys_enter`
  // alone exists under several subsystems and names none of them.
  if (field === 'event' && typeof entry.subsystem === 'string' && typeof entry.event === 'string') {
    return `${entry.subsystem}/${entry.event}`
  }
  const v = entry[field]
  if (typeof v === 'string') return v
  // `symbols` is a list — a uprobe hooks several functions at once.
  if (Array.isArray(v)) {
    const names = v.filter((x): x is string => typeof x === 'string')
    if (names.length) return names.join(', ')
  }
  return 'unnamed'
}

/** Every `matchActions[].action` reachable from one hook's selectors. */
function hookActions(entry: Json): string[] {
  const found: string[] = []
  for (const sel of asArray(entry.selectors)) {
    for (const ma of asArray(sel.matchActions)) {
      const action = typeof ma.action === 'string' ? ma.action : undefined
      if (action) found.push(action)
    }
  }
  return found
}

function describeSelector(spec: Json): string | undefined {
  const parts: string[] = []
  const pod = spec.podSelector as Json | undefined
  const container = spec.containerSelector as Json | undefined
  const labels = pod?.matchLabels as Json | undefined
  if (labels && Object.keys(labels).length) {
    parts.push(Object.entries(labels).map(([k, v]) => `${k}=${String(v)}`).join(', '))
  }
  if (asArray(pod?.matchExpressions).length) parts.push('label expressions')
  if (container && Object.keys(container).length) parts.push('container selector')
  return parts.length ? parts.join(' · ') : undefined
}

export function readPolicy(obj: Json): PolicyView {
  const metadata = (obj.metadata ?? {}) as Json
  const spec = (obj.spec ?? {}) as Json
  const namespace = typeof metadata.namespace === 'string' ? metadata.namespace : undefined

  const hooks: PolicyHook[] = []
  const actions = new Set<string>()
  for (const [field, type, nameField] of HOOK_LISTS) {
    for (const entry of asArray(spec[field])) {
      const found = hookActions(entry)
      for (const a of found) actions.add(a)
      hooks.push({
        type,
        name: hookName(entry, nameField),
        enforcing: found.some((a) => ENFORCING_ACTIONS.has(a.toLowerCase())),
      })
    }
  }
  // `enforcers` names the binaries allowed to enforce; its presence alone does
  // not make a policy enforcing, but an action in a selector does.
  const enforcing = hooks.some((h) => h.enforcing)

  return {
    name: typeof metadata.name === 'string' ? metadata.name : 'unnamed',
    namespace,
    scope: namespace ? 'namespace' : 'cluster',
    hooks,
    actions: [...actions].sort(),
    enforcing,
    selector: describeSelector(spec),
    created: typeof metadata.creationTimestamp === 'string' ? metadata.creationTimestamp : undefined,
  }
}

/** A one-line summary of what a policy hooks, for a table cell. */
export function hookSummary(p: PolicyView): string {
  if (!p.hooks.length) return 'no hooks'
  const byType = new Map<string, number>()
  for (const h of p.hooks) byType.set(h.type, (byType.get(h.type) ?? 0) + 1)
  return [...byType]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
    .join(', ')
}
