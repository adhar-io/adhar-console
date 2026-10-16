/**
 * Dependency-free API-spec engine for the API & Schemas view.
 *
 *   • parse JSON or YAML (block scalars, flow collections, folded plain
 *     scalars, line-numbered errors) and serialise back to YAML
 *   • detect OpenAPI 3.x / Swagger 2.0 / AsyncAPI 2.x–3.x / JSON Schema
 *   • normalise operations (params, request bodies, responses, $refs)
 *   • validate structure with issues located on editor lines
 *   • generate example payloads, cURL / fetch / Python snippets
 *   • semantic diff between two versions with breaking-change detection
 *   • a small JSON Schema instance validator
 *
 * Everything is pure and unit-tested in `openapi_test.ts`.
 */

export type SpecFormat = 'json' | 'yaml'

export interface ParseResult {
  doc: OpenApiDoc | null
  format: SpecFormat | null
  error: string | null
  /** 1-based line of a parse error, when known. */
  errorLine?: number
}

export interface OpenApiDoc {
  openapi?: string
  swagger?: string
  asyncapi?: string
  info?: { title?: string; version?: string; description?: string }
  paths?: Record<string, Record<string, unknown>>
  components?: { schemas?: Record<string, RawSchema>; [k: string]: unknown }
  definitions?: Record<string, RawSchema>
  [key: string]: unknown
}

export interface RawSchema {
  type?: string | string[]
  format?: string
  enum?: unknown[]
  const?: unknown
  required?: string[]
  properties?: Record<string, RawSchema>
  additionalProperties?: boolean | RawSchema
  items?: RawSchema
  $ref?: string
  allOf?: RawSchema[]
  oneOf?: RawSchema[]
  anyOf?: RawSchema[]
  description?: string
  example?: unknown
  examples?: unknown[]
  default?: unknown
  nullable?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  title?: string
  deprecated?: boolean
  [k: string]: unknown
}

/* ───────────────────────── parsing ───────────────────────── */

export class YamlError extends Error {
  constructor(public line: number, message: string) {
    super(`Line ${line}: ${message}`)
  }
}

export function parseSpec(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { doc: null, format: null, error: 'Document is empty.' }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const doc = JSON.parse(trimmed) as OpenApiDoc
      return { doc, format: 'json', error: null }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { doc: null, format: 'json', error: `Invalid JSON — ${msg}`, errorLine: jsonErrorLine(text, msg) }
    }
  }

  try {
    const doc = parseYaml(text) as OpenApiDoc
    if (doc && typeof doc === 'object' && !Array.isArray(doc) && Object.keys(doc).length > 0) {
      return { doc, format: 'yaml', error: null }
    }
    return { doc: null, format: 'yaml', error: 'The document must be a YAML/JSON object at the top level.', errorLine: 1 }
  } catch (e) {
    if (e instanceof YamlError) return { doc: null, format: 'yaml', error: e.message, errorLine: e.line }
    return { doc: null, format: 'yaml', error: e instanceof Error ? e.message : String(e) }
  }
}

function jsonErrorLine(text: string, msg: string): number | undefined {
  const line = /line (\d+)/i.exec(msg)
  if (line) return Number(line[1])
  const pos = /position (\d+)/i.exec(msg)
  if (pos) return text.slice(0, Number(pos[1])).split('\n').length
  return undefined
}

interface Ln {
  no: number
  indent: number
  text: string
}

const SEQ = /^-(\s|$)/

/** YAML subset parser sufficient for real-world API specs. */
export function parseYaml(input: string): unknown {
  const raw = input.replace(/\r\n?/g, '\n').split('\n')
  let i = 0

  const skippable = (l: string) => /^\s*(#.*)?$/.test(l) || /^---(\s.*)?$/.test(l) || /^\.\.\.\s*$/.test(l)

  const peek = (): Ln | null => {
    while (i < raw.length && skippable(raw[i])) i++
    if (i >= raw.length) return null
    const r = raw[i]
    if (/^ *\t/.test(r)) throw new YamlError(i + 1, 'Tabs are not allowed for indentation.')
    const m = /^( *)(.*)$/.exec(r)!
    return { no: i + 1, indent: m[1].length, text: stripComment(m[2]).trimEnd() }
  }

  const parseNode = (indent: number): unknown => {
    const l = peek()
    if (!l || l.indent < indent) return null
    return SEQ.test(l.text) ? parseSeq(l.indent) : parseMap(l.indent)
  }

  const parseMap = (indent: number): Record<string, unknown> => {
    const obj: Record<string, unknown> = {}
    for (;;) {
      const l = peek()
      if (!l || l.indent < indent) break
      if (l.indent > indent) throw new YamlError(l.no, 'Unexpected indentation.')
      if (SEQ.test(l.text)) break
      const ci = keyColon(l.text)
      if (ci === -1) throw new YamlError(l.no, `Expected "key: value", found "${l.text.slice(0, 40)}".`)
      const key = String(parseScalar(l.text.slice(0, ci).trim()))
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(l.no, `Duplicate key "${key}".`)
      const rest = l.text.slice(ci + 1).trim()
      i++
      obj[key] = parseValue(rest, indent, l.no)
    }
    return obj
  }

  const parseSeq = (indent: number): unknown[] => {
    const arr: unknown[] = []
    for (;;) {
      const l = peek()
      if (!l || l.indent !== indent || !SEQ.test(l.text)) break
      const rest = l.text.slice(1).trim()
      if (rest === '') {
        i++
        const n = peek()
        arr.push(n && n.indent > indent ? parseNode(n.indent) : null)
      } else if (keyColon(rest) !== -1 && !/^["'[{]/.test(rest)) {
        // `- key: value` → a map whose keys align with `key`.
        const col = raw[i].indexOf(rest.slice(0, 1), indent + 1)
        raw[i] = ' '.repeat(col) + raw[i].slice(col)
        arr.push(parseMap(col))
      } else {
        i++
        arr.push(parseValue(rest, indent, l.no))
      }
    }
    return arr
  }

  const parseValue = (rest: string, indent: number, lineNo: number): unknown => {
    let v = rest
    // Anchors are accepted and ignored; aliases are unsupported.
    if (/^&\S+(\s|$)/.test(v)) v = v.replace(/^&\S+\s*/, '')
    if (/^\*\S+$/.test(v)) throw new YamlError(lineNo, 'YAML aliases (*name) are not supported — inline the value.')
    if (/^!\S+\s*/.test(v)) v = v.replace(/^!\S+\s*/, '')
    if (v === '') {
      const n = peek()
      if (n && (n.indent > indent || (n.indent === indent && SEQ.test(n.text)))) return parseNode(n.indent)
      return null
    }
    if (/^[|>][-+0-9]*$/.test(v)) return readBlock(v, indent)
    if ((v.startsWith('[') || v.startsWith('{')) && !balanced(v)) {
      let acc = v
      while (i < raw.length && !balanced(acc)) {
        acc += ' ' + stripComment(raw[i].trim())
        i++
      }
      if (!balanced(acc)) throw new YamlError(lineNo, 'Unclosed flow collection.')
      v = acc
    }
    const quoted = /^["']/.test(v)
    if (quoted && !closesQuote(v)) {
      // Multi-line quoted scalar: fold following lines.
      let acc = v
      while (i < raw.length && !closesQuote(acc)) {
        acc += ' ' + raw[i].trim()
        i++
      }
      v = acc
    }
    let out = parseScalar(v, lineNo)
    if (typeof out === 'string' && !quoted && !/^[[{]/.test(v)) {
      // Plain multi-line scalar continues on deeper-indented lines.
      for (;;) {
        const n = peek()
        if (!n || n.indent <= indent || SEQ.test(n.text) && n.indent === indent) break
        if (keyColon(n.text) !== -1 && n.indent > indent) {
          throw new YamlError(n.no, 'Unexpected mapping — a scalar value cannot have nested keys.')
        }
        out += ' ' + n.text.trim()
        i++
      }
    }
    return out
  }

  const readBlock = (header: string, parentIndent: number): string => {
    const folded = header[0] === '>'
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
    const lines: string[] = []
    let blockIndent = -1
    while (i < raw.length) {
      const r = raw[i]
      if (/^\s*$/.test(r)) {
        lines.push('')
        i++
        continue
      }
      const ind = /^( *)/.exec(r)![1].length
      if (ind <= parentIndent) break
      if (blockIndent < 0) blockIndent = ind
      if (ind < blockIndent) break
      lines.push(r.slice(blockIndent))
      i++
    }
    let trailing = 0
    while (lines.length && lines[lines.length - 1] === '') {
      lines.pop()
      trailing++
    }
    let text = folded ? foldLines(lines) : lines.join('\n')
    if (!lines.length) return ''
    if (chomp === 'clip') text += '\n'
    else if (chomp === 'keep') text += '\n'.repeat(trailing + 1)
    return text
  }

  const root = peek()
  if (!root) return null
  if (root.indent !== 0 && !SEQ.test(root.text)) throw new YamlError(root.no, 'The first key must not be indented.')
  const value = parseNode(root.indent)
  const rest = peek()
  if (rest) throw new YamlError(rest.no, 'Unexpected content — check the indentation of this line.')
  return value
}

function foldLines(lines: string[]): string {
  let out = ''
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]
    if (l === '') out += '\n'
    else if (/^\s/.test(l)) out += (out && !out.endsWith('\n') ? '\n' : '') + l + '\n'
    else out += (out && !out.endsWith('\n') && !out.endsWith(' ') ? ' ' : '') + l
  }
  return out.replace(/\n$/, '')
}

function closesQuote(v: string): boolean {
  if (v[0] === "'") {
    for (let k = 1; k < v.length; k++) {
      if (v[k] !== "'") continue
      if (v[k + 1] === "'") k++
      else return true
    }
    return false
  }
  let esc = false
  for (let k = 1; k < v.length; k++) {
    const c = v[k]
    if (esc) esc = false
    else if (c === '\\') esc = true
    else if (c === '"') return true
  }
  return false
}

function balanced(s: string): boolean {
  let depth = 0
  let inS = false
  let inD = false
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS && s[k - 1] !== '\\') inD = !inD
    else if (!inS && !inD) {
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
    }
  }
  return depth <= 0
}

function stripComment(s: string): string {
  let inS = false
  let inD = false
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS && s[k - 1] !== '\\') inD = !inD
    else if (c === '#' && !inS && !inD && (k === 0 || s[k - 1] === ' ' || s[k - 1] === '\t')) {
      return s.slice(0, k)
    }
  }
  return s
}

function keyColon(text: string): number {
  let inS = false
  let inD = false
  let depth = 0
  for (let k = 0; k < text.length; k++) {
    const c = text[k]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS && text[k - 1] !== '\\') inD = !inD
    else if (!inS && !inD) {
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
      else if (c === ':' && depth === 0 && (k + 1 >= text.length || text[k + 1] === ' ')) return k
    }
  }
  return -1
}

function parseScalar(v: string, lineNo?: number): unknown {
  const s = v.trim()
  if (s === '') return null
  if (s.startsWith('"')) {
    const end = s.lastIndexOf('"')
    const body = s.slice(0, end + 1)
    try {
      return JSON.parse(body.replace(/\\'/g, "'").replace(/\t/g, '\\t'))
    } catch {
      return s.slice(1, end > 0 ? end : undefined)
    }
  }
  if (s.startsWith("'")) {
    const end = s.lastIndexOf("'")
    return s.slice(1, end > 0 ? end : undefined).replace(/''/g, "'")
  }
  if (s === 'null' || s === '~' || s === 'Null' || s === 'NULL') return null
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (/^[-+]?\d+$/.test(s) && Math.abs(Number(s)) <= Number.MAX_SAFE_INTEGER) return Number.parseInt(s, 10)
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number.parseFloat(s)
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitFlow(inner).map((x) => parseScalar(x, lineNo))
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    const obj: Record<string, unknown> = {}
    if (inner) {
      for (const pair of splitFlow(inner)) {
        const ci = keyColon(pair) !== -1 ? keyColon(pair) : pair.indexOf(':')
        if (ci === -1) {
          obj[String(parseScalar(pair, lineNo))] = null
          continue
        }
        obj[String(parseScalar(pair.slice(0, ci), lineNo))] = parseScalar(pair.slice(ci + 1), lineNo)
      }
    }
    return obj
  }
  return s
}

function splitFlow(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inS = false
  let inD = false
  let start = 0
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS && s[k - 1] !== '\\') inD = !inD
    else if (!inS && !inD) {
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
      else if (c === ',' && depth === 0) {
        out.push(s.slice(start, k).trim())
        start = k + 1
      }
    }
  }
  out.push(s.slice(start).trim())
  return out.filter((x) => x !== '')
}

/* ───────────────────────── YAML output ───────────────────────── */

const YAML_SPECIAL = /^[-?:,[\]{}#&*!|>'"%@`]|^\s|\s$|: | #|^(true|false|null|yes|no|on|off|~)$/i

function yamlString(s: string, indent: number): string {
  if (s === '') return "''"
  if (s.includes('\n')) {
    const pad = ' '.repeat(indent + 2)
    const keep = s.endsWith('\n') ? '' : '-'
    return `|${keep}\n` + s.replace(/\n$/, '').split('\n').map((l) => (l ? pad + l : '')).join('\n')
  }
  if (YAML_SPECIAL.test(s) || /^[-+]?(\d|\.\d)/.test(s) && !Number.isNaN(Number(s))) return JSON.stringify(s)
  return s
}

function yamlKey(k: string): string {
  return k === '' || YAML_SPECIAL.test(k) || /^[-+]?\d/.test(k) && !Number.isNaN(Number(k)) || k.includes(':') ? JSON.stringify(k) : k
}

function yamlScalar(v: unknown, indent: number): string | null {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (typeof v === 'string') return yamlString(v, indent)
  if (Array.isArray(v) && v.length === 0) return '[]'
  if (typeof v === 'object' && Object.keys(v as object).length === 0) return '{}'
  return null
}

/** Serialise a JSON value as block-style YAML. */
export function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  const scalar = yamlScalar(value, indent)
  if (scalar !== null) return pad + scalar
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const s = yamlScalar(item, indent)
        if (s !== null) return `${pad}- ${s}`
        const inner = toYaml(item, indent + 2)
        return `${pad}- ${inner.slice(indent + 2)}`
      })
      .join('\n')
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => {
      const s = yamlScalar(v, indent)
      if (s !== null) return `${pad}${yamlKey(k)}: ${s}`
      return `${pad}${yamlKey(k)}:\n${toYaml(v, indent + 2)}`
    })
    .join('\n')
}

/* ───────────────────────── kinds ───────────────────────── */

export type SpecKind = 'openapi' | 'swagger' | 'asyncapi' | 'jsonschema' | 'unknown'

export const KIND_LABEL: Record<SpecKind, string> = {
  openapi: 'OpenAPI',
  swagger: 'Swagger 2.0',
  asyncapi: 'AsyncAPI',
  jsonschema: 'JSON Schema',
  unknown: 'Unknown',
}

export function detectKind(doc: OpenApiDoc | null): SpecKind {
  if (!doc || typeof doc !== 'object') return 'unknown'
  if (typeof doc.openapi === 'string') return 'openapi'
  if (doc.swagger !== undefined) return 'swagger'
  if (doc.asyncapi !== undefined) return 'asyncapi'
  if (doc.$schema !== undefined || doc.type !== undefined || doc.properties !== undefined || doc.$defs !== undefined) {
    return 'jsonschema'
  }
  return 'unknown'
}

export function specVersionLabel(doc: OpenApiDoc | null): string {
  const k = detectKind(doc)
  if (k === 'openapi') return `OpenAPI ${doc!.openapi}`
  if (k === 'swagger') return 'Swagger 2.0'
  if (k === 'asyncapi') return `AsyncAPI ${doc!.asyncapi}`
  if (k === 'jsonschema') return 'JSON Schema'
  return 'Unknown'
}

/* ───────────────────────── $ref ───────────────────────── */

/** Resolve a local JSON pointer (`#/components/schemas/User`). */
export function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined
  const parts = ref.slice(1).split('/').filter(Boolean).map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')))
  let cur: unknown = doc
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p]
    else return undefined
  }
  return cur
}

export function refName(ref: string): string {
  return ref.split('/').pop() ?? ref
}

/** Follow `$ref` chains (bounded). */
export function deref<T = RawSchema>(doc: unknown, node: unknown, depth = 0): T | undefined {
  let cur = node as { $ref?: string } | undefined
  let n = 0
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string' && n < 12) {
    cur = resolvePointer(doc, cur.$ref) as { $ref?: string } | undefined
    n++
  }
  return depth > 50 ? undefined : (cur as T | undefined)
}

/** Every `$ref` in the document with its JSON path. */
export function collectRefs(node: unknown, path: string[] = [], out: { ref: string; path: string[] }[] = []) {
  if (Array.isArray(node)) node.forEach((v, i) => collectRefs(v, [...path, String(i)], out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') out.push({ ref: v, path: [...path, k] })
      else collectRefs(v, [...path, k], out)
    }
  }
  return out
}

/* ───────────────────────── operations ───────────────────────── */

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']

export interface Param {
  name: string
  in: string
  required: boolean
  description?: string
  schema?: RawSchema
  example?: unknown
  deprecated?: boolean
}

export interface Body {
  contentType: string
  schema?: RawSchema
  example?: unknown
  required?: boolean
  description?: string
}

export interface ResponseInfo {
  status: string
  description?: string
  contentType?: string
  schema?: RawSchema
  example?: unknown
}

export interface Operation {
  /** `GET /users/{id}` — stable key for deep links and diffs. */
  key: string
  method: string
  path: string
  summary: string
  description?: string
  operationId?: string
  tags: string[]
  deprecated?: boolean
  parameters: Param[]
  requestBody?: Body
  responses: ResponseInfo[]
  security?: string[]
  /** AsyncAPI operations carry their message payload here. */
  message?: Body
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function firstContent(content: unknown): { contentType: string; media: Record<string, unknown> } | undefined {
  const c = asObj(content)
  const keys = Object.keys(c)
  if (!keys.length) return undefined
  const pick = keys.find((k) => /json/i.test(k)) ?? keys[0]
  return { contentType: pick, media: asObj(c[pick]) }
}

function exampleOfMedia(media: Record<string, unknown>, doc: unknown): unknown {
  if (media.example !== undefined) return media.example
  const ex = asObj(media.examples)
  const first = Object.values(ex)[0]
  if (first !== undefined) {
    const v = deref<Record<string, unknown>>(doc, first)
    return v && 'value' in v ? v.value : v
  }
  return undefined
}

export function extractOperations(doc: OpenApiDoc | null): Operation[] {
  const kind = detectKind(doc)
  if (!doc) return []
  if (kind === 'asyncapi') return extractAsyncOperations(doc)
  const out: Operation[] = []
  const paths = asObj(doc.paths)
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = asObj(deref(doc, rawItem))
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of HTTP_METHODS) {
      const op = asObj(item[method])
      if (!item[method]) continue
      const params = new Map<string, Param>()
      let swaggerBody: Body | undefined
      for (const rp of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = asObj(deref(doc, rp))
        if (!p.name) continue
        if (p.in === 'body') {
          swaggerBody = { contentType: 'application/json', schema: p.schema as RawSchema, required: !!p.required, description: p.description as string }
          continue
        }
        params.set(`${p.in}:${p.name}`, {
          name: String(p.name),
          in: String(p.in ?? 'query'),
          required: !!p.required || p.in === 'path',
          description: p.description as string | undefined,
          schema: (p.schema as RawSchema) ?? (p.type ? { type: p.type as string, format: p.format as string, enum: p.enum as unknown[] } : undefined),
          example: p.example,
          deprecated: !!p.deprecated,
        })
      }
      let requestBody = swaggerBody
      if (op.requestBody) {
        const rb = asObj(deref(doc, op.requestBody))
        const fc = firstContent(rb.content)
        if (fc) {
          requestBody = {
            contentType: fc.contentType,
            schema: fc.media.schema as RawSchema,
            example: exampleOfMedia(fc.media, doc),
            required: !!rb.required,
            description: rb.description as string,
          }
        }
      }
      const responses: ResponseInfo[] = []
      for (const [status, rr] of Object.entries(asObj(op.responses))) {
        const r = asObj(deref(doc, rr))
        const fc = firstContent(r.content)
        responses.push({
          status,
          description: r.description as string | undefined,
          contentType: fc?.contentType ?? (r.schema ? 'application/json' : undefined),
          schema: (fc?.media.schema as RawSchema) ?? (r.schema as RawSchema | undefined),
          example: fc ? exampleOfMedia(fc.media, doc) : asObj(r.examples)['application/json'],
        })
      }
      responses.sort((a, b) => a.status.localeCompare(b.status))
      const security = Array.isArray(op.security ?? doc.security)
        ? ((op.security ?? doc.security) as Record<string, unknown>[]).flatMap((s) => Object.keys(asObj(s)))
        : undefined
      out.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: (op.summary as string) ?? '',
        description: op.description as string | undefined,
        operationId: op.operationId as string | undefined,
        tags: Array.isArray(op.tags) && op.tags.length ? op.tags.map(String) : ['default'],
        deprecated: !!op.deprecated,
        parameters: [...params.values()],
        requestBody,
        responses,
        security,
      })
    }
  }
  return out
}

function extractAsyncOperations(doc: OpenApiDoc): Operation[] {
  const out: Operation[] = []
  const v3 = String(doc.asyncapi ?? '').startsWith('3')
  const msgBody = (m: unknown): Body | undefined => {
    const msg = asObj(deref(doc, m))
    const one = Array.isArray(asObj(msg).oneOf) ? asObj(deref(doc, (msg.oneOf as unknown[])[0])) : msg
    if (!one.payload && !one.name) return undefined
    const ex = Array.isArray(one.examples) ? asObj(one.examples[0]) : {}
    return {
      contentType: (one.contentType as string) ?? (doc.defaultContentType as string) ?? 'application/json',
      schema: one.payload as RawSchema,
      example: ex.payload,
      description: (one.summary as string) ?? (one.description as string),
    }
  }
  if (v3) {
    const channels = asObj(doc.channels)
    for (const [name, rawOp] of Object.entries(asObj(doc.operations))) {
      const op = asObj(rawOp)
      const chRef = asObj(op.channel).$ref as string | undefined
      const chName = chRef ? refName(chRef) : ''
      const ch = asObj(chRef ? resolvePointer(doc, chRef) : channels[chName])
      const address = (ch.address as string) ?? chName
      const msgs = Array.isArray(op.messages) ? op.messages : Object.values(asObj(ch.messages))
      const action = String(op.action ?? 'send').toUpperCase()
      out.push({
        key: `${action} ${address}`,
        method: action,
        path: address,
        summary: (op.summary as string) ?? name,
        description: op.description as string | undefined,
        operationId: name,
        tags: tagNames(op.tags),
        parameters: [],
        responses: [],
        message: msgBody(msgs[0]),
      })
    }
    return out
  }
  for (const [channel, rawCh] of Object.entries(asObj(doc.channels))) {
    const ch = asObj(rawCh)
    for (const action of ['publish', 'subscribe'] as const) {
      const op = asObj(ch[action])
      if (!ch[action]) continue
      const label = action === 'publish' ? 'PUB' : 'SUB'
      out.push({
        key: `${label} ${channel}`,
        method: label,
        path: channel,
        summary: (op.summary as string) ?? '',
        description: (op.description as string) ?? (ch.description as string),
        operationId: op.operationId as string | undefined,
        tags: tagNames(op.tags),
        parameters: Object.entries(asObj(ch.parameters)).map(([n, p]) => ({
          name: n,
          in: 'channel',
          required: true,
          description: asObj(deref(doc, p)).description as string,
          schema: asObj(deref(doc, p)).schema as RawSchema,
        })),
        responses: [],
        message: msgBody(op.message),
      })
    }
  }
  return out
}

function tagNames(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags.map((t) => (typeof t === 'string' ? t : String(asObj(t).name ?? ''))).filter(Boolean) : []
  return list.length ? list : ['default']
}

export function groupByTag(ops: Operation[]): [string, Operation[]][] {
  const groups = new Map<string, Operation[]>()
  for (const op of ops) {
    const tag = op.tags[0] ?? 'default'
    if (!groups.has(tag)) groups.set(tag, [])
    groups.get(tag)!.push(op)
  }
  return [...groups.entries()]
}

/* Back-compat helpers (older callers). */

export interface Endpoint {
  method: string
  path: string
  summary: string
  operationId?: string
}
export interface SchemaField {
  name: string
  type: string
  required: boolean
}
export interface SchemaModel {
  name: string
  type: string
  fields: SchemaField[]
}

export function extractEndpoints(doc: OpenApiDoc | null): Record<string, Endpoint[]> {
  const out: Record<string, Endpoint[]> = {}
  for (const op of extractOperations(doc)) {
    ;(out[op.tags[0] ?? 'default'] ??= []).push({ method: op.method, path: op.path, summary: op.summary || op.description || '', operationId: op.operationId })
  }
  return out
}

export function componentSchemas(doc: OpenApiDoc | null): Record<string, RawSchema> {
  if (!doc) return {}
  const kind = detectKind(doc)
  if (kind === 'jsonschema') {
    const defs = { ...asObj(doc.$defs), ...asObj(doc.definitions) } as Record<string, RawSchema>
    return defs
  }
  if (kind === 'asyncapi') return asObj(asObj(doc.components).schemas) as Record<string, RawSchema>
  return (doc.components?.schemas ?? doc.definitions ?? {}) as Record<string, RawSchema>
}

export function extractSchemas(doc: OpenApiDoc | null): SchemaModel[] {
  return Object.entries(componentSchemas(doc)).map(([name, schema]) => {
    const s = deref(doc, schema) ?? schema
    const required = new Set(Array.isArray(s?.required) ? s.required : [])
    const fields = Object.entries(asObj(s?.properties)).map(([fname, prop]) => ({
      name: fname,
      type: typeLabel(prop as RawSchema),
      required: required.has(fname),
    }))
    return { name, type: typeLabel(s) || (fields.length ? 'object' : 'unknown'), fields }
  })
}

/** Short human type: `string · uuid`, `User[]`, `integer (enum)`, `A | B`. */
export function typeLabel(s: RawSchema | undefined): string {
  if (!s || typeof s !== 'object') return 'any'
  if (s.$ref) return refName(s.$ref)
  if (s.oneOf || s.anyOf) return (s.oneOf ?? s.anyOf)!.map((x) => typeLabel(x)).join(' | ')
  if (s.allOf) return s.allOf.map((x) => typeLabel(x)).join(' & ')
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null').join(' | ') + (s.type.includes('null') ? '?' : '') : s.type
  if (t === 'array') return `${typeLabel(s.items)}[]`
  if (s.enum) return `${t ?? 'string'} (enum)`
  if (s.format && t) return `${t} · ${s.format}`
  if (!t && s.properties) return 'object'
  return (t ?? 'any') + (s.nullable ? '?' : '')
}

/* ───────────────────────── examples ───────────────────────── */

const FORMAT_EXAMPLE: Record<string, unknown> = {
  'date-time': '2026-10-17T09:30:00Z',
  date: '2026-10-17',
  time: '09:30:00',
  email: 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'api.example.com',
  ipv4: '10.0.0.1',
  ipv6: '::1',
  byte: 'U3dhZ2dlcg==',
  password: '********',
}

/** Generate a representative example value for a schema. */
export function exampleFor(schema: RawSchema | undefined, doc: unknown, depth = 0, seen: Set<string> = new Set()): unknown {
  if (!schema || typeof schema !== 'object' || depth > 8) return null
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return {}
    const next = new Set(seen).add(schema.$ref)
    return exampleFor(resolvePointer(doc, schema.$ref) as RawSchema, doc, depth + 1, next)
  }
  if (schema.example !== undefined) return schema.example
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0]
  if (schema.const !== undefined) return schema.const
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  if (schema.allOf) {
    const merged: Record<string, unknown> = {}
    for (const part of schema.allOf) {
      const v = exampleFor(part, doc, depth + 1, seen)
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v)
    }
    return merged
  }
  if (schema.oneOf?.length) return exampleFor(schema.oneOf[0], doc, depth + 1, seen)
  if (schema.anyOf?.length) return exampleFor(schema.anyOf[0], doc, depth + 1, seen)
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type
  switch (type ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined)) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = exampleFor(v, doc, depth + 1, seen)
      if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        out.key = exampleFor(schema.additionalProperties, doc, depth + 1, seen)
      }
      return out
    }
    case 'array':
      return [exampleFor(schema.items, doc, depth + 1, seen)]
    case 'integer':
      return schema.minimum ?? 0
    case 'number':
      return schema.minimum ?? 0.0
    case 'boolean':
      return true
    case 'string':
      if (schema.format && FORMAT_EXAMPLE[schema.format] !== undefined) return FORMAT_EXAMPLE[schema.format]
      return 'string'
    case 'null':
      return null
    default:
      return null
  }
}

/* ───────────────────────── snippets ───────────────────────── */

export function serversOf(doc: OpenApiDoc | null): string[] {
  if (!doc) return []
  if (Array.isArray(doc.servers)) {
    return (doc.servers as Record<string, unknown>[]).map((s) => {
      let url = String(s.url ?? '')
      for (const [k, v] of Object.entries(asObj(s.variables))) url = url.replace(`{${k}}`, String(asObj(v).default ?? k))
      return url
    }).filter(Boolean)
  }
  if (doc.host) {
    const schemes = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : ['https']
    return [`${schemes[0]}://${doc.host}${doc.basePath ?? ''}`]
  }
  if (detectKind(doc) === 'asyncapi') {
    return Object.values(asObj(doc.servers)).map((s) => {
      const o = asObj(s)
      return String(o.url ?? (o.host ? `${o.protocol ?? ''}://${o.host}${o.pathname ?? ''}` : ''))
    }).filter(Boolean)
  }
  return []
}

function fillPath(op: Operation, doc: unknown): string {
  let p = op.path
  for (const prm of op.parameters.filter((x) => x.in === 'path')) {
    const ex = prm.example ?? exampleFor(prm.schema, doc)
    p = p.replace(`{${prm.name}}`, encodeURIComponent(String(ex ?? prm.name)))
  }
  const q = op.parameters.filter((x) => x.in === 'query' && x.required)
  if (q.length) {
    p += '?' + q.map((x) => `${encodeURIComponent(x.name)}=${encodeURIComponent(String(x.example ?? exampleFor(x.schema, doc) ?? ''))}`).join('&')
  }
  return p
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export type SnippetLang = 'curl' | 'fetch' | 'python'

export function snippetFor(lang: SnippetLang, op: Operation, server: string, doc: unknown): string {
  const url = `${server.replace(/\/+$/, '')}${fillPath(op, doc)}`
  const headers: [string, string][] = op.parameters
    .filter((p) => p.in === 'header' && p.required)
    .map((p) => [p.name, String(p.example ?? exampleFor(p.schema, doc) ?? '')])
  if (op.security?.length) headers.push(['Authorization', 'Bearer $TOKEN'])
  const body = op.requestBody ? op.requestBody.example ?? exampleFor(op.requestBody.schema, doc) : undefined
  if (body !== undefined) headers.push(['Content-Type', op.requestBody!.contentType])
  const json = body !== undefined ? JSON.stringify(body, null, 2) : undefined
  if (lang === 'curl') {
    const parts = [`curl -X ${op.method} ${shellQuote(url)}`]
    for (const [k, v] of headers) parts.push(`-H ${k === 'Authorization' ? `"${k}: ${v}"` : shellQuote(`${k}: ${v}`)}`)
    if (json) parts.push(`-d ${shellQuote(json)}`)
    return parts.join(' \\\n  ')
  }
  if (lang === 'fetch') {
    const h = headers.map(([k, v]) => `    ${JSON.stringify(k)}: ${k === 'Authorization' ? '`Bearer ${token}`' : JSON.stringify(v)},`).join('\n')
    return [
      `const res = await fetch(${JSON.stringify(url)}, {`,
      `  method: ${JSON.stringify(op.method)},`,
      headers.length ? `  headers: {\n${h}\n  },` : '',
      json ? `  body: JSON.stringify(${json.replace(/\n/g, '\n  ')}),` : '',
      '})',
      'const data = await res.json()',
    ].filter(Boolean).join('\n')
  }
  const h = headers.map(([k, v]) => `    ${JSON.stringify(k)}: ${k === 'Authorization' ? 'f"Bearer {token}"' : JSON.stringify(v)},`).join('\n')
  return [
    'import requests',
    '',
    `res = requests.request(`,
    `    ${JSON.stringify(op.method)},`,
    `    ${JSON.stringify(url)},`,
    headers.length ? `    headers={\n${h.replace(/^ {4}/gm, '        ')}\n    },` : '',
    json ? `    json=${pyLiteral(body)},` : '',
    ')',
    'res.raise_for_status()',
    'print(res.json())',
  ].filter((l) => l !== '').join('\n')
}

function pyLiteral(v: unknown): string {
  return JSON.stringify(v, null, 4)
    .replace(/\n/g, '\n    ')
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')
    .replace(/\bnull\b/g, 'None')
}

/* ───────────────────────── validation ───────────────────────── */

export type Severity = 'error' | 'warning' | 'info'

export interface Issue {
  severity: Severity
  message: string
  path: string[]
  line?: number
}

/**
 * Best-effort line of a JSON path in the source text: walks the path
 * segment by segment, each match searched below the previous one with a
 * deeper indent. Works for YAML and pretty-printed JSON.
 */
export function locateLine(text: string, path: string[]): number | undefined {
  const lines = text.split('\n')
  let from = 0
  let minIndent = -1
  let found: number | undefined
  for (const seg of path) {
    if (/^\d+$/.test(seg)) continue
    const esc = seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^(\\s*)(?:-\\s+)?["']?${esc}["']?\\s*:`)
    let hit = -1
    for (let k = from; k < lines.length; k++) {
      const m = re.exec(lines[k])
      if (m && m[1].length > minIndent) {
        hit = k
        minIndent = m[1].length
        break
      }
      // Left the parent block.
      const ind = /^(\s*)\S/.exec(lines[k])
      if (k > from && ind && ind[1].length <= minIndent && minIndent >= 0 && !/^\s*[}\]],?\s*$/.test(lines[k])) break
    }
    if (hit < 0) break
    found = hit + 1
    from = hit + 1
  }
  return found
}

export function validateSpec(doc: OpenApiDoc | null, text = ''): Issue[] {
  const issues: Issue[] = []
  const add = (severity: Severity, message: string, path: string[]) =>
    issues.push({ severity, message, path, line: text ? locateLine(text, path) ?? (path.length ? undefined : 1) : undefined })
  if (!doc) return issues
  const kind = detectKind(doc)

  if (kind === 'unknown') {
    add('error', 'Not a recognised document — add `openapi: 3.1.0`, `asyncapi: 3.0.0`, or a JSON Schema `type`.', [])
    return issues
  }

  // $refs everywhere.
  for (const { ref, path } of collectRefs(doc)) {
    if (!ref.startsWith('#')) {
      add('info', `External reference "${ref}" is not resolved here.`, path)
    } else if (resolvePointer(doc, ref) === undefined) {
      add('error', `Unresolved reference "${ref}".`, path)
    }
  }

  if (kind === 'jsonschema') {
    const props = asObj(doc.properties)
    for (const r of Array.isArray(doc.required) ? doc.required : []) {
      if (!(String(r) in props)) add('warning', `Required property "${r}" is not defined in properties.`, ['required'])
    }
    if (!doc.$schema) add('info', 'Add `$schema` to declare the JSON Schema dialect (e.g. 2020-12).', [])
    return issues
  }

  const info = asObj(doc.info)
  if (!doc.info) add('error', 'Missing `info` object.', [])
  else {
    if (!info.title) add('error', 'Missing `info.title`.', ['info'])
    if (info.version === undefined) add('error', 'Missing `info.version`.', ['info'])
    if (!info.description) add('info', 'Add `info.description` so consumers know what this API is for.', ['info'])
  }

  if (kind === 'asyncapi') {
    if (!doc.channels) add('error', 'Missing `channels`.', [])
    if (!doc.servers) add('info', 'No `servers` declared.', [])
    for (const op of extractOperations(doc)) {
      if (!op.message) add('warning', `${op.key}: no message payload.`, String(doc.asyncapi).startsWith('3') ? ['operations', op.operationId ?? ''] : ['channels', op.path])
    }
    return issues
  }

  const v31 = kind === 'openapi' && String(doc.openapi).startsWith('3.1')
  if (kind === 'openapi' && !/^3\.\d+(\.\d+)?$/.test(String(doc.openapi))) {
    add('warning', `Unexpected openapi version "${doc.openapi}" — use 3.0.x or 3.1.x.`, ['openapi'])
  }
  if (!doc.paths) {
    add(v31 ? 'info' : 'error', 'Missing `paths`.', [])
  }
  if (kind === 'openapi' && !Array.isArray(doc.servers)) add('info', 'No `servers` declared — snippets will use a placeholder host.', [])

  const declaredTags = new Set((Array.isArray(doc.tags) ? doc.tags : []).map((t) => String(asObj(t).name)))
  const usedTags = new Set<string>()
  const opIds = new Map<string, string>()

  for (const [path, rawItem] of Object.entries(asObj(doc.paths))) {
    if (!path.startsWith('/')) add('error', `Path "${path}" must start with "/".`, ['paths', path])
    const item = asObj(deref(doc, rawItem))
    const templ = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.includes(method)) continue
      const op = asObj(item[method])
      const where = ['paths', path, method]
      const label = `${method.toUpperCase()} ${path}`
      for (const t of Array.isArray(op.tags) ? op.tags : []) usedTags.add(String(t))
      if (!op.responses || !Object.keys(asObj(op.responses)).length) add('error', `${label}: no responses defined.`, where)
      for (const code of Object.keys(asObj(op.responses))) {
        if (!/^(default|[1-5](\d\d|XX))$/.test(code)) add('error', `${label}: invalid response code "${code}".`, [...where, 'responses', code])
      }
      if (!op.summary && !op.description) add('warning', `${label}: add a summary.`, where)
      if (typeof op.operationId === 'string') {
        const prev = opIds.get(op.operationId)
        if (prev) add('error', `Duplicate operationId "${op.operationId}" (also on ${prev}).`, [...where, 'operationId'])
        else opIds.set(op.operationId, label)
      }
      const params = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => asObj(deref(doc, p)))
      const pathParams = params.filter((p) => p.in === 'path')
      for (const name of templ) {
        if (!pathParams.some((p) => p.name === name)) add('error', `${label}: path parameter "{${name}}" is not declared.`, where)
      }
      for (const p of pathParams) {
        if (!templ.includes(String(p.name))) add('error', `${label}: path parameter "${p.name}" is not in the path template.`, where)
        else if (p.required !== true) add('error', `${label}: path parameter "${p.name}" must be required: true.`, where)
      }
      if ((method === 'get' || method === 'delete' || method === 'head') && op.requestBody) {
        add('warning', `${label}: request bodies on ${method.toUpperCase()} are discouraged.`, [...where, 'requestBody'])
      }
    }
  }
  for (const t of usedTags) {
    if (declaredTags.size && !declaredTags.has(t)) add('info', `Tag "${t}" is used but not declared in top-level \`tags\`.`, [])
  }
  return issues
}

/* ───────────────────────── diff ───────────────────────── */

export interface OpChange {
  key: string
  changes: string[]
  breaking: string[]
}

export interface SpecDiff {
  added: string[]
  removed: string[]
  changed: OpChange[]
  schemasAdded: string[]
  schemasRemoved: string[]
  schemasChanged: OpChange[]
  breaking: string[]
}

function propsOf(doc: unknown, s: RawSchema | undefined): { props: Record<string, RawSchema>; required: Set<string> } {
  const r = deref(doc, s) ?? {}
  const props: Record<string, RawSchema> = {}
  const required = new Set<string>(Array.isArray(r.required) ? r.required : [])
  for (const part of r.allOf ?? []) {
    const p = propsOf(doc, part)
    Object.assign(props, p.props)
    p.required.forEach((x) => required.add(x))
  }
  Object.assign(props, r.properties ?? {})
  return { props, required }
}

function compareSchemas(a: OpenApiDoc, b: OpenApiDoc, sa: RawSchema | undefined, sb: RawSchema | undefined, label: string, out: OpChange, direction: 'request' | 'response') {
  const pa = propsOf(a, sa)
  const pb = propsOf(b, sb)
  for (const k of Object.keys(pa.props)) {
    if (!(k in pb.props)) {
      out.changes.push(`${label}: removed property "${k}"`)
      if (direction === 'response') out.breaking.push(`${out.key} — ${label} no longer returns "${k}"`)
    } else if (typeLabel(pa.props[k]) !== typeLabel(pb.props[k])) {
      out.changes.push(`${label}: "${k}" ${typeLabel(pa.props[k])} → ${typeLabel(pb.props[k])}`)
      out.breaking.push(`${out.key} — ${label} "${k}" changed type`)
    }
  }
  for (const k of Object.keys(pb.props)) {
    if (!(k in pa.props)) {
      out.changes.push(`${label}: added property "${k}"${pb.required.has(k) ? ' (required)' : ''}`)
      if (direction === 'request' && pb.required.has(k)) out.breaking.push(`${out.key} — new required request field "${k}"`)
    } else if (direction === 'request' && pb.required.has(k) && !pa.required.has(k)) {
      out.changes.push(`${label}: "${k}" is now required`)
      out.breaking.push(`${out.key} — request field "${k}" became required`)
    }
  }
}

export function diffSpecs(a: OpenApiDoc | null, b: OpenApiDoc | null): SpecDiff {
  const d: SpecDiff = { added: [], removed: [], changed: [], schemasAdded: [], schemasRemoved: [], schemasChanged: [], breaking: [] }
  if (!a || !b) return d
  const oa = new Map(extractOperations(a).map((o) => [o.key, o]))
  const ob = new Map(extractOperations(b).map((o) => [o.key, o]))
  for (const k of oa.keys()) {
    if (!ob.has(k)) {
      d.removed.push(k)
      d.breaking.push(`${k} — operation removed`)
    }
  }
  for (const k of ob.keys()) if (!oa.has(k)) d.added.push(k)
  for (const [k, x] of oa) {
    const y = ob.get(k)
    if (!y) continue
    const c: OpChange = { key: k, changes: [], breaking: [] }
    const px = new Map(x.parameters.map((p) => [`${p.in}:${p.name}`, p]))
    const py = new Map(y.parameters.map((p) => [`${p.in}:${p.name}`, p]))
    for (const [pk, p] of px) {
      if (!py.has(pk)) c.changes.push(`removed ${p.in} parameter "${p.name}"`)
    }
    for (const [pk, p] of py) {
      const old = px.get(pk)
      if (!old) {
        c.changes.push(`added ${p.in} parameter "${p.name}"${p.required ? ' (required)' : ''}`)
        if (p.required) c.breaking.push(`${k} — new required ${p.in} parameter "${p.name}"`)
      } else if (p.required && !old.required) {
        c.changes.push(`${p.in} parameter "${p.name}" is now required`)
        c.breaking.push(`${k} — ${p.in} parameter "${p.name}" became required`)
      }
    }
    if (!x.requestBody && y.requestBody?.required) {
      c.changes.push('added required request body')
      c.breaking.push(`${k} — now requires a request body`)
    } else if (x.requestBody && !y.requestBody) c.changes.push('removed request body')
    else if (x.requestBody && y.requestBody) compareSchemas(a, b, x.requestBody.schema, y.requestBody.schema, 'request body', c, 'request')
    const rx = new Map(x.responses.map((r) => [r.status, r]))
    const ry = new Map(y.responses.map((r) => [r.status, r]))
    for (const [s] of rx) {
      if (!ry.has(s)) {
        c.changes.push(`removed response ${s}`)
        if (s.startsWith('2')) c.breaking.push(`${k} — success response ${s} removed`)
      }
    }
    for (const [s] of ry) if (!rx.has(s)) c.changes.push(`added response ${s}`)
    for (const [s, r] of rx) {
      const r2 = ry.get(s)
      if (r2 && s.startsWith('2')) compareSchemas(a, b, r.schema, r2.schema, `response ${s}`, c, 'response')
    }
    if (x.deprecated !== y.deprecated && y.deprecated) c.changes.push('marked deprecated')
    if (c.changes.length) {
      d.changed.push(c)
      d.breaking.push(...c.breaking)
    }
  }
  const sa = componentSchemas(a)
  const sb = componentSchemas(b)
  for (const n of Object.keys(sa)) if (!(n in sb)) d.schemasRemoved.push(n)
  for (const n of Object.keys(sb)) if (!(n in sa)) d.schemasAdded.push(n)
  for (const n of Object.keys(sa)) {
    if (!(n in sb)) continue
    const c: OpChange = { key: n, changes: [], breaking: [] }
    compareSchemas(a, b, sa[n], sb[n], 'schema', c, 'response')
    if (c.changes.length) d.schemasChanged.push({ ...c, breaking: [] })
  }
  return d
}

/* ───────────────────────── JSON Schema instance validation ───────────────────────── */

export interface InstanceError {
  path: string
  message: string
}

function typeOfValue(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

/** Validate `value` against a schema (common keywords only). */
export function validateInstance(schema: RawSchema | undefined, value: unknown, doc: unknown, path = '$', out: InstanceError[] = [], depth = 0): InstanceError[] {
  if (!schema || typeof schema !== 'object' || depth > 32) return out
  if (schema.$ref) {
    validateInstance(resolvePointer(doc, schema.$ref) as RawSchema, value, doc, path, out, depth + 1)
    return out
  }
  for (const s of schema.allOf ?? []) validateInstance(s, value, doc, path, out, depth + 1)
  if (schema.oneOf || schema.anyOf) {
    const opts = (schema.oneOf ?? schema.anyOf)!
    const passing = opts.filter((s) => validateInstance(s, value, doc, path, [], depth + 1).length === 0).length
    if (schema.oneOf ? passing !== 1 : passing === 0) {
      out.push({ path, message: schema.oneOf ? `must match exactly one schema (matched ${passing})` : 'must match at least one schema' })
    }
  }
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : []
  const actual = typeOfValue(value)
  if (schema.nullable && value === null) return out
  if (types.length && !types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) {
    out.push({ path, message: `expected ${types.join(' | ')}, got ${actual}` })
    return out
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` })
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push({ path, message: `must equal ${JSON.stringify(schema.const)}` })
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push({ path, message: `shorter than ${schema.minLength}` })
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push({ path, message: `longer than ${schema.maxLength}` })
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) out.push({ path, message: `does not match /${schema.pattern}/` })
      } catch { /* invalid pattern — reported by spec validation */ }
    }
    if (schema.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) out.push({ path, message: 'is not an email' })
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) out.push({ path, message: 'is not a uuid' })
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) out.push({ path, message: 'is not a date-time' })
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `less than ${schema.minimum}` })
    if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, message: `greater than ${schema.maximum}` })
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push({ path, message: `fewer than ${schema.minItems} items` })
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push({ path, message: `more than ${schema.maxItems} items` })
    if (schema.items) value.forEach((v, i) => validateInstance(schema.items, v, doc, `${path}[${i}]`, out, depth + 1))
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>
    for (const r of schema.required ?? []) if (!(r in obj)) out.push({ path, message: `missing required property "${r}"` })
    for (const [k, v] of Object.entries(obj)) {
      const ps = schema.properties?.[k]
      if (ps) validateInstance(ps, v, doc, `${path}.${k}`, out, depth + 1)
      else if (schema.additionalProperties === false) out.push({ path: `${path}.${k}`, message: 'additional property not allowed' })
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateInstance(schema.additionalProperties, v, doc, `${path}.${k}`, out, depth + 1)
      }
    }
  }
  return out
}

/* ───────────────────────── starter documents ───────────────────────── */

export const SPEC_STARTERS: { id: string; label: string; description: string; document: string }[] = [
  {
    id: 'openapi',
    label: 'OpenAPI 3.1 — REST resource',
    description: 'CRUD endpoints, a component schema, bearer auth and error model.',
    document: `openapi: 3.1.0
info:
  title: Orders API
  version: 1.0.0
  description: Create and track orders.
servers:
  - url: https://api.example.com/v1
tags:
  - name: orders
    description: Order lifecycle
security:
  - bearer: []
paths:
  /orders:
    get:
      tags: [orders]
      summary: List orders
      operationId: listOrders
      parameters:
        - name: status
          in: query
          schema:
            type: string
            enum: [pending, paid, shipped]
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
      responses:
        '200':
          description: A page of orders
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Order'
    post:
      tags: [orders]
      summary: Create an order
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/NewOrder'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
        '422':
          $ref: '#/components/responses/Invalid'
  /orders/{orderId}:
    parameters:
      - name: orderId
        in: path
        required: true
        schema:
          type: string
          format: uuid
    get:
      tags: [orders]
      summary: Get an order
      operationId: getOrder
      responses:
        '200':
          description: The order
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
        '404':
          description: Not found
components:
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
  responses:
    Invalid:
      description: Validation failed
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
  schemas:
    NewOrder:
      type: object
      required: [sku, quantity]
      properties:
        sku:
          type: string
          example: SKU-1042
        quantity:
          type: integer
          minimum: 1
    Order:
      allOf:
        - $ref: '#/components/schemas/NewOrder'
        - type: object
          required: [id, status]
          properties:
            id:
              type: string
              format: uuid
            status:
              type: string
              enum: [pending, paid, shipped]
            createdAt:
              type: string
              format: date-time
    Error:
      type: object
      properties:
        code:
          type: string
        message:
          type: string
`,
  },
  {
    id: 'asyncapi',
    label: 'AsyncAPI 2.6 — events',
    description: 'Kafka topics with publish / subscribe and message payloads.',
    document: `asyncapi: 2.6.0
info:
  title: Order events
  version: 1.0.0
  description: Domain events emitted by the orders service.
servers:
  production:
    url: kafka.platform.svc:9092
    protocol: kafka
channels:
  orders.created:
    subscribe:
      summary: An order was created
      operationId: onOrderCreated
      tags:
        - name: orders
      message:
        name: OrderCreated
        contentType: application/json
        payload:
          $ref: '#/components/schemas/OrderCreated'
  orders.shipped:
    publish:
      summary: Mark an order as shipped
      operationId: shipOrder
      tags:
        - name: orders
      message:
        name: ShipOrder
        payload:
          type: object
          required: [orderId]
          properties:
            orderId:
              type: string
              format: uuid
            carrier:
              type: string
components:
  schemas:
    OrderCreated:
      type: object
      required: [orderId, total]
      properties:
        orderId:
          type: string
          format: uuid
        total:
          type: number
        createdAt:
          type: string
          format: date-time
`,
  },
  {
    id: 'jsonschema',
    label: 'JSON Schema 2020-12',
    description: 'A standalone schema with $defs, enums and constraints.',
    document: `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.example.com/team.json",
  "title": "Team",
  "type": "object",
  "required": ["name", "slug", "members"],
  "properties": {
    "name": { "type": "string", "minLength": 2 },
    "slug": { "type": "string", "pattern": "^[a-z0-9-]+$", "example": "platform" },
    "visibility": { "type": "string", "enum": ["private", "internal", "public"], "default": "internal" },
    "members": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/Member" }
    }
  },
  "$defs": {
    "Member": {
      "type": "object",
      "required": ["email", "role"],
      "properties": {
        "email": { "type": "string", "format": "email" },
        "role": { "type": "string", "enum": ["owner", "maintainer", "member"] }
      }
    }
  }
}
`,
  },
]
