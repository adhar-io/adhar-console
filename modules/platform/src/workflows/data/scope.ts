import { CONTROL_PLANE_NS } from './gvr.ts'

/**
 * Where workflows live for the person looking (design 0026 §4.3): each project's
 * home namespace (`status.namespace`) and its environment namespaces
 * (`status.environments[].namespace`), plus `adhar-system` for platform staff.
 * The top-bar namespace, when one is chosen, narrows to it alone; the team lens
 * narrows to the active team's projects. RBAC — not this list — is the
 * boundary: a namespace the caller cannot read is reported, not hidden.
 * Pure: `scope_test.ts`.
 */

export interface ProjectXR {
  metadata: { name: string; labels?: Record<string, string> }
  spec?: Record<string, unknown>
  status?: { namespace?: string; environments?: Array<{ name?: string; namespace?: string; tier?: string }> } & Record<string, unknown>
}

export interface ScopeNamespace {
  namespace: string
  project?: string
  /** `home` for the project's own namespace, else the environment name. */
  role: 'home' | 'environment' | 'platform' | 'selected'
  environment?: string
  tier?: string
}

const DNS1123 = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

/** A project's namespaces: its home and every environment it resolved. */
export function projectNamespaces(p: ProjectXR): ScopeNamespace[] {
  const out: ScopeNamespace[] = []
  const home = p.status?.namespace
  if (home && DNS1123.test(home)) out.push({ namespace: home, project: p.metadata.name, role: 'home' })
  for (const e of p.status?.environments ?? []) {
    if (e?.namespace && DNS1123.test(e.namespace)) out.push({ namespace: e.namespace, project: p.metadata.name, role: 'environment', environment: e.name, tier: e.tier })
  }
  return out
}

/**
 * The namespaces to show, in a stable order (project, then home before its
 * environments). `projectFilter`, when given, keeps only those projects — the
 * team lens; a filter that would leave nothing keeps everything (team-lens.ts).
 */
export function scopeNamespaces(
  projects: readonly ProjectXR[],
  opts: { selected?: string; platform?: boolean; projectFilter?: ReadonlySet<string> } = {},
): ScopeNamespace[] {
  if (opts.selected) return [{ namespace: opts.selected, role: 'selected' }]
  let chosen = [...projects]
  if (opts.projectFilter && opts.projectFilter.size) {
    const narrowed = chosen.filter((p) => opts.projectFilter!.has(p.metadata.name))
    if (narrowed.length) chosen = narrowed
  }
  chosen.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const seen = new Set<string>()
  const out: ScopeNamespace[] = []
  for (const p of chosen) {
    for (const n of projectNamespaces(p)) {
      if (seen.has(n.namespace)) continue
      seen.add(n.namespace)
      out.push(n)
    }
  }
  if (opts.platform && !seen.has(CONTROL_PLANE_NS)) out.push({ namespace: CONTROL_PLANE_NS, role: 'platform' })
  return out
}

/**
 * The namespace a per-namespace page (History) reads, and the choices its
 * picker offers. A namespace named in the URL wins — it is how one opens
 * another team's archive and is told "You cannot read runs in <ns>"
 * (acceptance 2) — and it is always among the choices, so the picker never
 * shows one namespace while the page reads another. A URL namespace from
 * before the top-bar namespace changed is dropped: the top bar is the newer
 * choice.
 */
export function pageNamespace(
  scope: { namespaces: readonly ScopeNamespace[]; only?: string },
  fromUrl: string | undefined,
): { namespace: string | undefined; options: string[] } {
  const listed = scope.namespaces.map((n) => n.namespace)
  const url = fromUrl && DNS1123.test(fromUrl) && !(scope.only && fromUrl !== scope.only) ? fromUrl : undefined
  const namespace = url ?? scope.only ?? scope.namespaces.find((n) => n.role !== 'platform')?.namespace ?? listed[0]
  const options = namespace && !listed.includes(namespace) ? [namespace, ...listed] : listed
  return { namespace, options }
}

/** Is a namespace a production tier (team members are `view` there; prod is publish-only)? */
export function isProduction(n: ScopeNamespace | undefined): boolean {
  return n?.tier === 'prod' || n?.environment === 'prod' || n?.environment === 'production'
}
