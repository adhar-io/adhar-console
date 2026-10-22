/**
 * Redaction for evidence that leaves the cluster.
 *
 * A support ticket is read by people who were never granted the cluster RBAC
 * the console's ServiceAccount used to collect it, so everything that goes
 * into one — log lines, object YAML, event messages — passes through here
 * first. The rules are deliberately greedy: a ticket that says `[REDACTED]`
 * where a harmless value stood costs nothing; one that carries a database
 * password into a project tracker is an incident of its own.
 */

export const REDACTED = '[REDACTED]'

/** Keys whose VALUE is a secret, wherever they appear (`password=`, `"apiKey":`, `CLIENT_SECRET: `). */
const SECRET_KEY = String.raw`(?:[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|session[_-]?id|cookie|auth[_-]?key|signature|bearer))`

const RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // PEM private keys — whole block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `-----BEGIN PRIVATE KEY----- ${REDACTED}`],
  // Authorization / proxy-authorization / cookie headers (any scheme).
  [/\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-auth-token)(\s*[:=]\s*)("?)[^\r\n"]+/gi, (_m, h, sep, q) => `${h}${sep}${q}${REDACTED}`],
  // Bearer / Basic tokens anywhere.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_m, s) => `${s} ${REDACTED}`],
  // URL userinfo: scheme://user:pass@host → scheme://user:[REDACTED]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+):[^\s@/"']+@/gi, (_m, pre) => `${pre}:${REDACTED}@`],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  // Well-known token shapes: AWS access keys, GitHub/GitLab/Slack tokens, Plane API keys.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\bplane_api_[A-Za-z0-9]{16,}\b/g, REDACTED],
  // JSON: "password": "value"  /  "apiKey":"value"
  [new RegExp(String.raw`("${SECRET_KEY}"\s*:\s*)"(?:[^"\\]|\\.)*"`, 'gi'), (_m, k) => `${k}"${REDACTED}"`],
  // key=value / key: value (env dumps, logfmt, connection strings, YAML).
  [new RegExp(String.raw`(\b${SECRET_KEY}\b\s*[=:]\s*)(?!\[REDACTED\])("[^"]*"|'[^']*'|[^\s,;&"'}]+)`, 'gi'), (_m, k) => `${k}${REDACTED}`],
]

/** Redact one string. */
export function redactText(input: string): string {
  let out = input
  for (const [re, rep] of RULES) out = out.replace(re, rep as never)
  return out
}

/** Key names whose value is dropped entirely in a structured object. */
const SECRET_FIELD = new RegExp(`^${SECRET_KEY}$`, 'i')

/**
 * Redact a Kubernetes object (or any JSON value) for a ticket: secret-named
 * fields and `env` entries whose NAME looks secret lose their value, a Secret's
 * `data`/`stringData` is dropped, and the noise nobody reads in an incident
 * (managedFields, the last-applied annotation) goes too. Returns a copy.
 */
export function redactObject<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key && SECRET_FIELD.test(key) ? REDACTED : redactText(v)
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (!v || typeof v !== 'object') return v
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    const isSecret = o.kind === 'Secret'
    // An env entry: {name: DB_PASSWORD, value: …}
    const envSecret = typeof o.name === 'string' && 'value' in o && SECRET_FIELD.test(o.name)
    for (const [k, x] of Object.entries(o)) {
      if (k === 'managedFields') continue
      if (isSecret && (k === 'data' || k === 'stringData')) {
        out[k] = REDACTED
        continue
      }
      if (k === 'kubectl.kubernetes.io/last-applied-configuration') continue
      if (envSecret && k === 'value') {
        out[k] = REDACTED
        continue
      }
      out[k] = walk(x, k)
    }
    return out
  }
  return walk(value) as T
}
