/**
 * A Kubernetes manifest as YAML.
 *
 * The provisioning dialog builds a claim from a form, and the thing it is
 * about to apply was never shown. YAML is how everyone reads a manifest and
 * how it has to look to go into a GitOps repository, so the dialog shows the
 * manifest as YAML — which means serialising it, and this platform has no
 * YAML dependency (`manifest-editor.tsx` chose JSON for exactly that reason).
 *
 * Scope is deliberate: what `kube.apply` accepts — JSON values, which is maps,
 * arrays, strings, numbers, booleans and null. No anchors, no tags, no
 * multi-document streams. A manifest cannot contain them.
 *
 * It emits; it does not parse. Reading YAML back in would make a hand-rolled
 * parser the thing that decides what infrastructure gets provisioned, and a
 * subtle mis-parse there is a wrong database rather than a wrong pixel.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

/** Keys that are safe bare; anything else gets quoted. */
const PLAIN_KEY = /^[A-Za-z_][\w./-]*$/

/**
 * Scalars YAML would read back as something other than a string.
 *
 * `on`, `no` and `y` are booleans in YAML 1.1, which is what a Kubernetes
 * manifest is parsed as, so an unquoted `on` becomes `true`. A version like
 * `1.10` becomes the number 1.1, and `1:30` becomes a sexagesimal integer.
 */
const AMBIGUOUS =
  /^(|~|null|Null|NULL|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|[-+]?\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|[-+]?\.(inf|Inf|INF|nan|NaN|NAN)|0[xXoObB][\da-fA-F_]+|\d+(:\d+)+)$/

/** Characters that force quoting wherever they appear. */
const NEEDS_QUOTE = /[:#\n\r\t"'\\{}[\],&*?|<>=!%@`]|^[\s-]|\s$/

function quote(s: string): string {
  // Double quotes with escapes — the only form that can carry anything.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

export function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : quote(String(value))
  const s = String(value)
  if (s === '') return "''"
  if (AMBIGUOUS.test(s) || NEEDS_QUOTE.test(s)) return quote(s)
  return s
}

function yamlKey(key: string): string {
  return PLAIN_KEY.test(key) ? key : quote(key)
}

function isPlain(v: unknown): boolean {
  return v === null || typeof v !== 'object'
}

function emit(value: unknown, indent: number, out: string[]): void {
  const pad = '  '.repeat(indent)

  if (Array.isArray(value)) {
    if (value.length === 0) return // the caller wrote `key: []`
    for (const item of value) {
      if (isPlain(item)) {
        out.push(`${pad}- ${yamlScalar(item)}`)
        continue
      }
      // A nested block under `- ` starts on the dash's own line, so the first
      // key sits beside the dash and the rest line up under it.
      const nested: string[] = []
      emit(item, indent + 1, nested)
      if (nested.length === 0) {
        out.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`)
        continue
      }
      out.push(`${pad}- ${nested[0].trimStart()}`)
      for (const line of nested.slice(1)) out.push(line)
    }
    return
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not a YAML value; a key whose value is undefined was
    // never set and must not appear as `key: null`.
    .filter(([, v]) => v !== undefined)
  for (const [k, v] of entries) {
    const key = yamlKey(k)
    if (isPlain(v)) {
      out.push(`${pad}${key}: ${yamlScalar(v)}`)
      continue
    }
    if (Array.isArray(v) && v.length === 0) {
      out.push(`${pad}${key}: []`)
      continue
    }
    if (!Array.isArray(v) && Object.keys(v as object).length === 0) {
      out.push(`${pad}${key}: {}`)
      continue
    }
    out.push(`${pad}${key}:`)
    // A list under a key is conventionally written at the key's own indent.
    emit(v, Array.isArray(v) ? indent : indent + 1, out)
  }
}

/** Field order every Kubernetes manifest is read in. */
const TOP_ORDER = ['apiVersion', 'kind', 'metadata', 'spec', 'status']

/**
 * Serialise a manifest. Top-level keys are emitted in the order people read
 * them rather than the order the object happens to hold them in — a manifest
 * that opens with `spec` reads as unfamiliar even when it is correct.
 */
export function toYaml(manifest: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  for (const k of TOP_ORDER) {
    if (manifest[k] !== undefined) ordered[k] = manifest[k]
  }
  for (const [k, v] of Object.entries(manifest)) {
    if (!(k in ordered) && v !== undefined) ordered[k] = v
  }
  const out: string[] = []
  emit(ordered, 0, out)
  return out.length ? `${out.join('\n')}\n` : ''
}
