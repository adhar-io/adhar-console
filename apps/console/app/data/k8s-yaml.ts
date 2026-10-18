/**
 * Kubernetes objects (and catalog entities) as YAML, for read-only viewers.
 *
 * The console has no YAML dependency, and adding one to the host for a viewer
 * is a lockfile change in every image. A JSON value — which is all a manifest
 * is — only needs an emitter, so this is one, scoped to exactly that: maps,
 * arrays, strings, numbers, booleans and null. No anchors, tags or streams.
 *
 * What makes it readable rather than merely valid:
 *   • Multi-line strings (scripts, embedded JSON, certificates, composition
 *     templates) are literal block scalars (`|`, `|-`, `|+`), the way people
 *     write them, instead of one long line of `\n` escapes.
 *   • Strings YAML 1.1 would read as something else (`on`, `no`, `1.10`,
 *     `1:30`, `0x1F`, `~`) are quoted, so the text means what the object held.
 *   • Top-level keys come in manifest order (apiVersion, kind, metadata, spec,
 *     status) and metadata starts with its identity.
 *
 * JSX-free so the Deno test runner can exercise it.
 */

const PLAIN_KEY = /^[A-Za-z_][\w./-]*$/

const AMBIGUOUS =
  /^(|~|null|Null|NULL|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|[-+]?\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|[-+]?\.\d+([eE][-+]?\d+)?|[-+]?\.(inf|Inf|INF|nan|NaN|NAN)|0[xXoObB][\da-fA-F_]+|\d+(:\d+)+)$/

/**
 * When a plain scalar would be misread: it starts with an indicator
 * character, contains `: ` or ` #`, ends with `:`, has leading or trailing
 * whitespace, or carries control characters. Everything else — URLs, image
 * refs like `ghcr.io/x:v1`, `a=b` — stays readable and unquoted.
 */
// deno-lint-ignore no-control-regex
const NEEDS_QUOTE = /^[-?:,[\]{}#&*!|>'"%@`\s]|: |\s#|:$|\s$|[\u0000-\u001f\u007f]/

function quote(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  return `"${escaped}"`
}

export function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : quote(String(value))
  if (typeof value === 'bigint') return String(value)
  const s = String(value)
  if (s === '') return "''"
  if (AMBIGUOUS.test(s) || NEEDS_QUOTE.test(s)) return quote(s)
  return s
}

function yamlKey(key: string): string {
  return PLAIN_KEY.test(key) ? key : quote(key)
}

/**
 * Can this string be a literal block? It must contain a newline and nothing a
 * block cannot carry verbatim: carriage returns, tabs-as-indentation is fine,
 * but other control characters are not. Lines that are only whitespace at the
 * very end would be eaten by chomping, so those stay quoted too.
 */
function blockable(s: string): boolean {
  if (!s.includes('\n')) return false
  // deno-lint-ignore no-control-regex
  if (/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return false
  // A trailing line of spaces would not survive the round trip.
  if (/[ \t]+$/.test(s) && !s.endsWith('\n')) return false
  return true
}

function blockScalar(s: string, pad: string): string[] {
  let chomp = '-'
  let body = s
  if (s.endsWith('\n')) {
    const trimmed = s.replace(/\n+$/, '')
    const trailing = s.length - trimmed.length
    chomp = trailing === 1 ? '' : '+'
    body = trailing === 1 ? trimmed : s.slice(0, -1)
  }
  // A first line that starts with a space needs an explicit indentation
  // indicator, or the reader would take that space as the block's indent.
  const indicator = /^[ \t]/.test(body) ? '2' : ''
  const lines = body.split('\n').map((l) => (l === '' ? '' : `${pad}  ${l}`))
  return [`|${indicator}${chomp}`, ...lines]
}

function isPlain(v: unknown): boolean {
  return v === null || typeof v !== 'object'
}

/** A key as it appears in a path: `.name`, or `["odd/key"]` when it needs quoting. */
export function pathKey(k: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`
}

/**
 * Lines with, aligned, the path of the value each line belongs to
 * (`.spec.template.spec.containers[0].image`). The viewer's status bar and
 * "Copy path" read it; emitting it alongside the text is exact where parsing
 * the text back would be a guess.
 */
class Sink {
  lines: string[] = []
  paths: string[] = []
  push(path: string, ...lines: string[]) {
    for (const l of lines) {
      this.lines.push(l)
      this.paths.push(path)
    }
  }
}

function emit(value: unknown, indent: number, out: Sink, path = ''): void {
  const pad = '  '.repeat(indent)

  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const p = `${path}[${i}]`
      if (typeof item === 'string' && blockable(item)) {
        const [head, ...rest] = blockScalar(item, pad)
        out.push(p, `${pad}- ${head}`, ...rest)
        return
      }
      if (isPlain(item)) {
        out.push(p, `${pad}- ${yamlScalar(item)}`)
        return
      }
      const nested = new Sink()
      emit(item, indent + 1, nested, p)
      if (nested.lines.length === 0) {
        out.push(p, `${pad}- ${Array.isArray(item) ? '[]' : '{}'}`)
        return
      }
      out.push(nested.paths[0], `${pad}- ${nested.lines[0].trimStart()}`)
      for (let j = 1; j < nested.lines.length; j++) out.push(nested.paths[j], nested.lines[j])
    })
    return
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || typeof v === 'function') continue
    const key = yamlKey(k)
    const p = `${path}${pathKey(k)}`
    if (typeof v === 'string' && blockable(v)) {
      const [head, ...rest] = blockScalar(v, pad)
      out.push(p, `${pad}${key}: ${head}`, ...rest)
      continue
    }
    if (isPlain(v)) {
      out.push(p, `${pad}${key}: ${yamlScalar(v)}`)
      continue
    }
    if (Array.isArray(v) && v.length === 0) {
      out.push(p, `${pad}${key}: []`)
      continue
    }
    if (!Array.isArray(v) && Object.keys(v as object).filter((x) => (v as Record<string, unknown>)[x] !== undefined).length === 0) {
      out.push(p, `${pad}${key}: {}`)
      continue
    }
    out.push(p, `${pad}${key}:`)
    // Sequences under a key sit at the key's own indent (kubectl style).
    emit(v, Array.isArray(v) ? indent : indent + 1, out, p)
  }
}

const TOP_ORDER = ['apiVersion', 'kind', 'metadata', 'spec', 'data', 'stringData', 'status']
const META_ORDER = ['name', 'generateName', 'namespace', 'uid', 'resourceVersion', 'generation', 'creationTimestamp', 'deletionTimestamp', 'title', 'description']

function ordered(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k]
  for (const [k, v] of Object.entries(obj)) if (!(k in out) && v !== undefined) out[k] = v
  return out
}

/** Serialise any JSON value. Objects that look like manifests get manifest key order. */
export function toYaml(value: unknown): string {
  return toYamlWithPaths(value).text
}

export interface Rendered {
  text: string
  /** `paths[i]` is the path of line `i` (0-based); `''` for the root. */
  paths: string[]
}

function manifestOrdered(value: unknown): unknown {
  if (isPlain(value) || Array.isArray(value)) return value
  const o = value as Record<string, unknown>
  const root = ordered(o, TOP_ORDER)
  const meta = o.metadata
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    root.metadata = ordered(meta as Record<string, unknown>, META_ORDER)
  }
  return root
}

export function toYamlWithPaths(value: unknown): Rendered {
  if (isPlain(value)) return { text: `${yamlScalar(value)}\n`, paths: [''] }
  const out = new Sink()
  emit(manifestOrdered(value), 0, out)
  if (out.lines.length === 0) return { text: Array.isArray(value) ? '[]\n' : '{}\n', paths: [''] }
  return { text: `${out.lines.join('\n')}\n`, paths: out.paths }
}

/** `JSON.stringify(v, null, 2)` (manifest key order), with per-line paths. */
export function toJsonWithPaths(value: unknown): Rendered {
  const lines: string[] = []
  const paths: string[] = []
  const put = (line: string, path: string) => {
    lines.push(line)
    paths.push(path)
  }
  const walk = (v: unknown, indent: number, path: string, prefix: string, comma: string) => {
    const pad = '  '.repeat(indent)
    if (v === null || typeof v !== 'object') {
      put(`${pad}${prefix}${JSON.stringify(v ?? null)}${comma}`, path)
      return
    }
    const entries: Array<[string, unknown, string]> = Array.isArray(v)
      ? v.map((x, i) => [String(i), x, `${path}[${i}]`])
      : Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && typeof x !== 'function').map(([k, x]) => [k, x, `${path}${pathKey(k)}`])
    const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}']
    if (!entries.length) {
      put(`${pad}${prefix}${open}${close}${comma}`, path)
      return
    }
    put(`${pad}${prefix}${open}`, path)
    entries.forEach(([k, x, p], i) => walk(x, indent + 1, p, Array.isArray(v) ? '' : `${JSON.stringify(k)}: `, i < entries.length - 1 ? ',' : ''))
    put(`${pad}${close}${comma}`, path)
  }
  walk(manifestOrdered(value), 0, '', '', '')
  return { text: `${lines.join('\n')}\n`, paths }
}

export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

/** Does this object carry server bookkeeping a reader usually wants hidden? */
export function hasServerNoise(value: unknown): boolean {
  const meta = (value as { metadata?: { managedFields?: unknown; annotations?: Record<string, string> } } | null)?.metadata
  return Boolean(meta && (Array.isArray(meta.managedFields) || meta.annotations?.[LAST_APPLIED]))
}

/**
 * The object without `metadata.managedFields` and the last-applied annotation —
 * hundreds of lines of field-ownership bookkeeping that bury the spec. Returns
 * a copy; the input is never mutated. An annotations map left empty is dropped.
 */
export function stripServerNoise<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const src = value as Record<string, unknown>
  const meta = src.metadata
  if (!meta || typeof meta !== 'object') return value
  const { managedFields: _mf, ...rest } = meta as Record<string, unknown>
  const nextMeta: Record<string, unknown> = { ...rest }
  const ann = rest.annotations as Record<string, string> | undefined
  if (ann && LAST_APPLIED in ann) {
    const { [LAST_APPLIED]: _la, ...others } = ann
    if (Object.keys(others).length) nextMeta.annotations = others
    else delete nextMeta.annotations
  }
  return { ...src, metadata: nextMeta } as T
}
