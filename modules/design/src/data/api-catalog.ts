/**
 * API & Schemas ↔ the service catalog — pure helpers (tested in
 * `api-catalog_test.ts`): where an API entity's spec lives, how big a change
 * is (semver bump from a breaking-change diff), and a typed TypeScript fetch
 * client generated from an OpenAPI document.
 */

import { deref, extractOperations, type OpenApiDoc, type Operation, type RawSchema, serversOf, type SpecDiff } from './openapi.ts'
import type { PEntity } from './platform-model.ts'

export type SpecSource =
  | { type: 'repo'; repo: string; path: string; branch?: string }
  | { type: 'inline'; text: string }
  | { type: 'url'; url: string }

/** Where an API entity's definition comes from, or null when the descriptor names none. */
export function specSource(e: Pick<PEntity, 'definition' | 'definitionPath' | 'definitionUrl' | 'repo' | 'location'>): SpecSource | null {
  if (e.definitionPath && (e.location?.repo ?? e.repo)) {
    return { type: 'repo', repo: (e.location?.repo ?? e.repo)!, path: e.definitionPath, branch: e.location?.branch }
  }
  if (e.definitionUrl) return { type: 'url', url: e.definitionUrl }
  if (e.definition?.trim()) return { type: 'inline', text: e.definition }
  return null
}

export function describeSource(s: SpecSource | null): string {
  if (!s) return 'No definition in catalog-info'
  if (s.type === 'repo') return `${s.repo}/${s.path}`
  if (s.type === 'url') return s.url
  return 'Inline in catalog-info.yaml'
}

export type Bump = 'major' | 'minor' | 'patch' | 'none'

/** Semver bump a diff calls for: breaking → major, additions → minor, other changes → patch. */
export function bumpFor(d: SpecDiff): Bump {
  if (d.breaking.length) return 'major'
  if (d.added.length || d.schemasAdded.length) return 'minor'
  if (d.changed.length || d.removed.length || d.schemasChanged.length || d.schemasRemoved.length) return 'patch'
  return 'none'
}

/** Apply a bump to a `x.y.z` version (anything unparseable is returned unchanged). */
export function bumpVersion(version: string, bump: Bump): string {
  const m = /^(v?)(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim())
  if (!m || bump === 'none') return version
  const [, v, a, b, c] = m
  const [maj, min, pat] = [Number(a), Number(b), Number(c)]
  if (bump === 'major') return `${v}${maj + 1}.0.0`
  if (bump === 'minor') return `${v}${maj}.${min + 1}.0`
  return `${v}${maj}.${min}.${pat + 1}`
}

/* ───────────────────────── TypeScript client ───────────────────────── */

function camel(parts: string[]): string {
  const words = parts.join(' ').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const out = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('')
  return /^[0-9]/.test(out) ? `op${out}` : out || 'operation'
}

/** `operationId`, else a camel-cased method + path (`GET /users/{id}` → `getUsersById`). */
export function operationName(op: Pick<Operation, 'operationId' | 'method' | 'path'>): string {
  if (op.operationId) return camel([op.operationId])
  const segs = op.path.split('/').filter(Boolean).map((s) => (s.startsWith('{') ? `by ${s.slice(1, -1)}` : s))
  return camel([op.method.toLowerCase(), ...segs])
}

function tsType(doc: unknown, s: RawSchema | undefined, depth = 0): string {
  if (!s) return 'unknown'
  if (s.$ref) {
    const name = String(s.$ref).split('/').pop() ?? 'unknown'
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : 'unknown'
  }
  const r = deref(doc, s) ?? s
  if (depth > 4) return 'unknown'
  if (Array.isArray(r.enum) && r.enum.length) return r.enum.map((v) => JSON.stringify(v)).join(' | ')
  const t = Array.isArray(r.type) ? r.type[0] : r.type
  if (t === 'string') return 'string'
  if (t === 'integer' || t === 'number') return 'number'
  if (t === 'boolean') return 'boolean'
  if (t === 'array') return `Array<${tsType(doc, r.items as RawSchema | undefined, depth + 1)}>`
  if (t === 'object' || r.properties) {
    const req = new Set(Array.isArray(r.required) ? r.required : [])
    const props = Object.entries(r.properties ?? {})
    if (!props.length) return 'Record<string, unknown>'
    return `{ ${props.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${tsType(doc, v, depth + 1)}`).join('; ')} }`
  }
  if (r.allOf?.length) return r.allOf.map((x) => tsType(doc, x, depth + 1)).join(' & ')
  if (r.oneOf?.length || r.anyOf?.length) return (r.oneOf ?? r.anyOf ?? []).map((x) => tsType(doc, x, depth + 1)).join(' | ')
  return 'unknown'
}

/**
 * A dependency-free TypeScript client: one exported type per component
 * schema and one async function per operation, built on `fetch`.
 */
export function tsClientFor(doc: OpenApiDoc | null, opts: { baseUrl?: string } = {}): string {
  if (!doc) return ''
  const ops = extractOperations(doc).filter((o) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(o.method))
  const schemas = ((doc.components as { schemas?: Record<string, RawSchema> } | undefined)?.schemas) ?? {}
  const base = opts.baseUrl ?? serversOf(doc)[0] ?? ''
  const title = String((doc.info as { title?: string } | undefined)?.title ?? 'API')
  const lines: string[] = [
    `// ${title} — generated by Adhar Console (Design → API & Schemas). Do not edit by hand.`,
    '',
  ]
  for (const [name, s] of Object.entries(schemas)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    lines.push(`export type ${name} = ${tsType(doc, s)}`)
  }
  if (Object.keys(schemas).length) lines.push('')
  lines.push(
    'export interface ClientOptions {',
    '  baseUrl?: string',
    '  token?: string',
    '  fetch?: typeof fetch',
    '}',
    '',
    'export function createClient(opts: ClientOptions = {}) {',
    `  const baseUrl = (opts.baseUrl ?? ${JSON.stringify(base)}).replace(/\\/+$/, '')`,
    '  const doFetch = opts.fetch ?? fetch',
    '  async function call<T>(method: string, path: string, query?: Record<string, unknown>, body?: unknown): Promise<T> {',
    '    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : \'\'',
    '    const res = await doFetch(`${baseUrl}${path}${qs ? `?${qs}` : \'\'}`, {',
    '      method,',
    '      headers: { ...(body !== undefined ? { \'content-type\': \'application/json\' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },',
    '      body: body !== undefined ? JSON.stringify(body) : undefined,',
    '    })',
    '    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`)',
    '    const text = await res.text()',
    '    return (text ? JSON.parse(text) : undefined) as T',
    '  }',
    '  return {',
  )
  const used = new Set<string>()
  for (const op of ops) {
    let fn = operationName(op)
    while (used.has(fn)) fn = `${fn}_`
    used.add(fn)
    const pathParams = op.parameters.filter((p) => p.in === 'path')
    const queryParams = op.parameters.filter((p) => p.in === 'query')
    const ok = op.responses.find((r) => /^2/.test(r.status))
    const ret = ok?.schema ? tsType(doc, ok.schema) : 'void'
    const args: string[] = []
    const pFields = [...pathParams, ...queryParams].map((p) => `${/^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name)}${p.required ? '' : '?'}: ${tsType(doc, p.schema)}`)
    if (pFields.length) args.push(`params: { ${pFields.join('; ')} }`)
    if (op.requestBody) args.push(`body${op.requestBody.required ? '' : '?'}: ${tsType(doc, op.requestBody.schema)}`)
    const path = op.path.replace(/\{([^}]+)\}/g, (_m, n) => `\${encodeURIComponent(String(params[${JSON.stringify(n)}]))}`)
    const query = queryParams.length ? `{ ${queryParams.map((p) => `${JSON.stringify(p.name)}: params[${JSON.stringify(p.name)}]`).join(', ')} }` : 'undefined'
    if (op.summary) lines.push(`    /** ${op.summary.replace(/\*\//g, '* /')} */`)
    lines.push(`    ${fn}: (${args.join(', ')}) => call<${ret}>(${JSON.stringify(op.method)}, \`${path}\`, ${query}${op.requestBody ? ', body' : ''}),`)
  }
  lines.push('  }', '}', '')
  return lines.join('\n')
}
