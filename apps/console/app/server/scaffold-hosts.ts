/**
 * The hostnames a scaffolded application's HTTPRoute serves.
 *
 * Every app gets its platform route by default — `<name>.<environment>.<base
 * domain>` — because the environment is part of the address: `my-service.<base>`
 * cannot be the dev copy and the prod copy at once, and the promotion chain
 * this platform is built around (dev → test → prod) needs one hostname per
 * environment. The Gateway terminates TLS for `*.<env>.<base>` precisely so this
 * resolves and serves the right certificate on a fresh scaffold.
 *
 * On top of that, a template's `customHostnames` parameter adds any hostnames
 * the team wants — a product domain, a legacy name. They are appended, never
 * substituted: the platform route stays, so the console's links keep working.
 * A custom hostname outside the Gateway's listeners is the team's to wire
 * (listener + certificate); the route still lists it.
 */

/** Scaffolds land in the first environment of the promotion chain. */
export const SCAFFOLD_ENVIRONMENT = 'dev'

/** `<name>.<env>.<base>`; the base is the platform domain with no port. */
export function platformRouteHost(name: string, environment: string, baseDomain: string): string {
  const base = baseDomain.replace(/:\d+$/, '').replace(/^\.+|\.+$/g, '')
  return `${name}.${environment}.${base}`
}

/**
 * Parse a `customHostnames` parameter: comma/space/newline separated, or
 * already an array. Lower-cased, de-duplicated, invalid entries dropped.
 */
export function parseCustomHostnames(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/)
      : []
  const out: string[] = []
  for (const p of parts) {
    const h = p.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!h || !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) continue
    if (!out.includes(h)) out.push(h)
  }
  return out
}

/** The full ordered list the route serves: the platform route first, then custom ones. */
export function routeHostnames(platformHost: string, custom: unknown): string[] {
  const list = [platformHost.toLowerCase()]
  for (const h of parseCustomHostnames(custom)) if (!list.includes(h)) list.push(h)
  return list
}
