/**
 * Fields that NAME another platform object, by the XRDs' own convention.
 *
 * The concept hierarchy (ADR-0026) is Organisation → Team → Project →
 * Application → Environment, and a child names its parent in a string field
 * called after the parent's kind: `Team.spec.parameters.organisation`,
 * `Project.spec.parameters.team`, and so on. Typed by hand, one of those is a
 * typo away from a composition that never resolves — and the objects it could
 * name are already on the cluster, so the create form offers them as a list.
 */
const HIERARCHY_REF_KINDS: Record<string, string> = {
  organisation: 'Organisation',
  organization: 'Organisation',
  team: 'Team',
  project: 'Project',
  application: 'Application',
  environment: 'Environment',
}

/** The XR kind a field named `name` refers to, or undefined when it is not a reference. */
export function hierarchyRefKind(name: string): string | undefined {
  return HIERARCHY_REF_KINDS[name.toLowerCase()]
}
