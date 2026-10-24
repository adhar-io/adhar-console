/**
 * Safety rails for starting chaos from the console.
 *
 * Breaking things on purpose is only safe when the blast radius is bounded
 * and stated. The rails below are checked before the Launch button enables,
 * and every one is a sentence the person reads — never a silent refusal:
 *
 *   • BLOCK   — the run is not allowed from here at all: the platform's own
 *               namespaces (a fault there takes the console, the operator or
 *               the cluster down with it), a duration over the cap, a name
 *               Kubernetes would reject.
 *   • CONFIRM — allowed, but only after typing the run's name: high-blast
 *               faults, every matching pod, a production namespace.
 *   • WARN    — allowed, said out loud: no steady-state probe (the verdict
 *               then only says the fault ran), no label (every pod in the
 *               namespace is a target).
 *
 * Pure, so the rules are pinned by tests rather than by the form.
 */

/** Longest single fault the console will start. Litmus would run longer; nobody should need to. */
export const MAX_FAULT_SECONDS = 600
/** Longest game day (faults plus pauses). */
export const MAX_GAMEDAY_SECONDS = 3600

/**
 * Namespaces chaos may never target from the console: the cluster's own, and
 * the platform's control plane — the operator that would recover the fault
 * lives in one of them.
 */
export const PROTECTED_NAMESPACES = [
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'adhar-system',
  'argocd',
  'litmus',
  'cert-manager',
  'keycloak',
  'cilium',
  'monitoring',
  'kyverno',
  'kargo',
  'gitea',
  'harbor',
  'tekton-pipelines',
  'argo',
  'argo-rollouts',
  'external-secrets',
  'crossplane-system',
]

export type GuardLevel = 'block' | 'confirm' | 'warn'

export interface Guard {
  level: GuardLevel
  message: string
}

/** True for the namespaces the console refuses to target. */
export function isProtectedNamespace(ns: string): boolean {
  return PROTECTED_NAMESPACES.includes(ns) || ns.startsWith('kube-') || ns.startsWith('openshift-')
}

/** A namespace that looks like production: `prod`, `production`, `*-prod`, or labelled so. */
export function isProductionNamespace(ns: string, labels: Record<string, string> = {}): boolean {
  const env = (labels['adhar.io/environment'] ?? labels.environment ?? '').toLowerCase()
  return env === 'prod' || env === 'production' || /(^|-)(prod|production)$/.test(ns)
}

const DNS_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

export interface LaunchReview {
  name: string
  /** Empty for node faults. */
  namespace?: string
  namespaceLabels?: Record<string, string>
  /** `app=checkout`; empty means every pod in the namespace. */
  label?: string
  mode: 'one' | 'percent' | 'all'
  percent?: string
  blast: 'low' | 'medium' | 'high'
  /** Total seconds the faults inject (a game day: the whole sequence). */
  seconds: number
  maxSeconds?: number
  hasProbe: boolean
  /** A node fault: its target is a node, not pods. */
  node?: boolean
  /** Names already taken in the chaos namespace — applying one would rewrite that run. */
  taken?: string[]
}

/** Every rail that applies to a launch, most severe first. */
export function reviewLaunch(r: LaunchReview): Guard[] {
  const out: Guard[] = []
  const cap = r.maxSeconds ?? MAX_FAULT_SECONDS
  if (!DNS_NAME.test(r.name)) out.push({ level: 'block', message: 'The name must be lowercase letters, digits and dashes (it names the Kubernetes object).' })
  else if (r.taken?.includes(r.name)) out.push({ level: 'block', message: `A run named ${r.name} already exists. Choose another name — or re-run that one from its page.` })
  if (!r.node) {
    if (!r.namespace) out.push({ level: 'block', message: 'Choose the namespace whose pods are targeted.' })
    else if (isProtectedNamespace(r.namespace)) {
      out.push({ level: 'block', message: `${r.namespace} is a platform namespace — chaos there can take down the console, the operator that recovers the fault, or the cluster. Target an application namespace.` })
    }
  }
  if (!Number.isFinite(r.seconds) || r.seconds <= 0) out.push({ level: 'block', message: 'The duration must be a positive number of seconds.' })
  else if (r.seconds > cap) out.push({ level: 'block', message: `${r.seconds}s is over the ${cap}s the console allows for one run. Shorter runs answer the same question.` })
  if (r.mode === 'percent') {
    const n = Number(r.percent)
    if (!Number.isFinite(n) || n <= 0 || n > 100) out.push({ level: 'block', message: 'The share of pods must be between 1 and 100%.' })
  }

  if (r.blast === 'high') out.push({ level: 'confirm', message: 'High blast radius: this resembles a real outage.' })
  if (!r.node && r.mode === 'all') out.push({ level: 'confirm', message: 'Every matching pod is targeted at once.' })
  if (r.node) out.push({ level: 'confirm', message: 'A node fault affects every pod on that node, whichever team owns it.' })
  if (r.namespace && isProductionNamespace(r.namespace, r.namespaceLabels)) out.push({ level: 'confirm', message: `${r.namespace} looks like production.` })

  if (!r.hasProbe) out.push({ level: 'warn', message: 'No steady-state probe: the verdict will only say whether the fault ran, not whether the system kept serving.' })
  if (!r.node && r.namespace && !r.label?.trim()) out.push({ level: 'warn', message: `No app label: any pod in ${r.namespace} may be picked.` })
  const rank: Record<GuardLevel, number> = { block: 0, confirm: 1, warn: 2 }
  return out.sort((a, b) => rank[a.level] - rank[b.level])
}

/** Launch is possible when nothing blocks and, if anything needs it, the name was typed back. */
export function launchAllowed(guards: Guard[], typed: string, name: string): boolean {
  if (guards.some((g) => g.level === 'block')) return false
  return !guards.some((g) => g.level === 'confirm') || typed.trim() === name
}
