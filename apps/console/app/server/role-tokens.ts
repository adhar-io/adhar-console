/**
 * Keycloak role / group spelling → bare token: `/org/Platform-Admins` →
 * `platform-admins`. The one normalisation every server-side role gate uses
 * (app-delete.ts, scan-waivers-model.ts). Dependency-free so pure modules and
 * their tests can import it without the handlers' I/O.
 */
export function normaliseToken(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/^\/+/, '')
  return t.split('/').pop() || t
}
