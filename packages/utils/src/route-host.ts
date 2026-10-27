/**
 * The platform route rule — the ONE answer to "what host does `<name>` answer
 * on in `<environment>`".
 *
 * It lives here rather than in the console's scaffolder because two sides need
 * the same answer: the BFF writes it into a scaffolded repository's HTTPRoutes
 * (and resolves a function's URL server-side before invoking it), and the
 * browser modules show it when an object has not published its URL yet. Two
 * copies of a hostname rule drift, and a drifted rule is a link that 404s.
 * The control plane's Function composition and the CLI scaffolder
 * (`cmd/apps/scaffold_hosts.go`) implement the same rule.
 */

/** `<name>.<env>.<base>`; the base is the platform domain with no port. */
export function platformRouteHost(name: string, environment: string, baseDomain: string): string {
  const base = baseDomain.replace(/:\d+$/, '').replace(/^\.+|\.+$/g, '')
  // `<app>.test.test.<zone>` is a name Let's Encrypt refuses (repeated label)
  // and the Gateway omits that listener; `<app>-test.<zone>` sits under the
  // host's own wildcard instead, so the environment stays reachable.
  if (environmentRepeatsHostLabel(environment, base)) return `${name}-${environment}.${base}`
  return `${name}.${environment}.${base}`
}

export function environmentRepeatsHostLabel(environment: string, base: string): boolean {
  const first = base.toLowerCase().split('.')[0]
  return first !== '' && first === environment.toLowerCase()
}
