/**
 * Dependency-free OpenAPI helpers for the API/schema design view.
 *
 * Parsing tries JSON first (the canonical, always-safe path) and falls back to
 * a *minimal* indentation-based YAML reader that covers the common OpenAPI
 * subset (nested maps, block + flow sequences, scalars). Anything it can't
 * handle surfaces as a friendly parse error rather than throwing.
 */

export type SpecFormat = 'json' | 'yaml'

export interface ParseResult {
  doc: OpenApiDoc | null
  format: SpecFormat | null
  error: string | null
}

export interface OpenApiDoc {
  openapi?: string
  swagger?: string
  info?: { title?: string; version?: string; description?: string }
  paths?: Record<string, Record<string, RawOperation>>
  components?: { schemas?: Record<string, RawSchema> }
  definitions?: Record<string, RawSchema>
  [key: string]: unknown
}

interface RawOperation {
  summary?: string
  description?: string
  tags?: string[]
  operationId?: string
}

interface RawSchema {
  type?: string
  format?: string
  enum?: unknown[]
  required?: string[]
  properties?: Record<string, RawSchema>
  items?: RawSchema
  $ref?: string
}

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

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']

export function parseSpec(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { doc: null, format: null, error: 'Document is empty.' }

  // JSON first — unambiguous and safe.
  try {
    const doc = JSON.parse(trimmed) as OpenApiDoc
    return { doc, format: 'json', error: null }
  } catch {
    /* fall through to YAML */
  }

  try {
    const doc = parseYaml(trimmed) as OpenApiDoc
    if (doc && typeof doc === 'object' && Object.keys(doc).length > 0) {
      return { doc, format: 'yaml', error: null }
    }
    return {
      doc: null,
      format: null,
      error: 'Could not parse document — paste valid JSON, or check YAML indentation.',
    }
  } catch (e) {
    return {
      doc: null,
      format: null,
      error: `Could not parse document — paste valid JSON, or check YAML indentation. (${
        e instanceof Error ? e.message : String(e)
      })`,
    }
  }
}

export function extractEndpoints(doc: OpenApiDoc | null): Record<string, Endpoint[]> {
  const groups: Record<string, Endpoint[]> = {}
  if (!doc?.paths || typeof doc.paths !== 'object') return groups
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, RawOperation>)[method]
      if (!op || typeof op !== 'object') continue
      const tag = Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : 'default'
      const endpoint: Endpoint = {
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? op.description ?? '',
        operationId: op.operationId,
      }
      ;(groups[tag] ??= []).push(endpoint)
    }
  }
  return groups
}

export function extractSchemas(doc: OpenApiDoc | null): SchemaModel[] {
  const schemas = doc?.components?.schemas ?? doc?.definitions
  if (!schemas || typeof schemas !== 'object') return []
  return Object.entries(schemas).map(([name, schema]) => {
    const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
    const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}
    const fields: SchemaField[] = Object.entries(props).map(([fname, prop]) => ({
      name: fname,
      type: fieldType(prop),
      required: required.has(fname),
    }))
    return { name, type: schema?.type ?? (fields.length ? 'object' : 'unknown'), fields }
  })
}

function fieldType(prop: RawSchema | undefined): string {
  if (!prop || typeof prop !== 'object') return 'any'
  if (prop.$ref) return refName(prop.$ref)
  if (prop.type === 'array') {
    const items = prop.items
    if (items?.$ref) return `${refName(items.$ref)}[]`
    if (items?.type) return `${items.type}[]`
    return 'array'
  }
  if (prop.enum && prop.type) return `${prop.type} (enum)`
  if (prop.format && prop.type) return `${prop.type} · ${prop.format}`
  return prop.type ?? 'object'
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? ref
}

/* ─────────────── minimal YAML ─────────────── */

interface Line {
  indent: number
  text: string
}

function parseYaml(input: string): unknown {
  const lines: Line[] = []
  for (const raw of input.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*$/.test(raw)) continue
    if (/^\s*#/.test(raw)) continue
    const m = /^(\s*)(.*)$/.exec(raw)!
    const text = stripComment(m[2]).replace(/\s+$/, '')
    if (text === '' || text === '---') continue
    lines.push({ indent: m[1].length, text })
  }

  let i = 0

  const parseNode = (indent: number): unknown => {
    if (i >= lines.length || lines[i].indent < indent) return null
    if (lines[i].text === '-' || lines[i].text.startsWith('- ')) return parseSeq(lines[i].indent)
    return parseMap(lines[i].indent)
  }

  const parseMap = (indent: number): Record<string, unknown> => {
    const obj: Record<string, unknown> = {}
    while (i < lines.length && lines[i].indent === indent) {
      const line = lines[i]
      if (line.text === '-' || line.text.startsWith('- ')) break
      const ci = keyColon(line.text)
      if (ci === -1) break
      const key = String(parseScalar(line.text.slice(0, ci).trim()))
      const valuePart = line.text.slice(ci + 1).trim()
      i++
      if (valuePart === '') {
        const next = lines[i]
        if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('-')))) {
          obj[key] = parseNode(next.indent)
        } else {
          obj[key] = null
        }
      } else {
        obj[key] = parseScalar(valuePart)
      }
    }
    return obj
  }

  const parseSeq = (indent: number): unknown[] => {
    const arr: unknown[] = []
    while (
      i < lines.length &&
      lines[i].indent === indent &&
      (lines[i].text === '-' || lines[i].text.startsWith('- '))
    ) {
      const line = lines[i]
      const rest = line.text === '-' ? '' : line.text.slice(2)
      if (rest === '') {
        i++
        if (i < lines.length && lines[i].indent > indent) arr.push(parseNode(lines[i].indent))
        else arr.push(null)
      } else if (keyColon(rest) === -1) {
        arr.push(parseScalar(rest))
        i++
      } else {
        // Inline mapping after the dash: rewrite as a map entry aligned under the dash.
        lines[i] = { indent: indent + 2, text: rest }
        arr.push(parseMap(indent + 2))
      }
    }
    return arr
  }

  return parseNode(0)
}

function stripComment(s: string): string {
  let inS = false
  let inD = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (c === '#' && !inS && !inD && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return s.slice(0, i)
    }
  }
  return s
}

function keyColon(text: string): number {
  let inS = false
  let inD = false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (!inS && !inD) {
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
      else if (c === ':' && depth === 0 && (i + 1 >= text.length || text[i + 1] === ' ')) return i
    }
  }
  return -1
}

function parseScalar(v: string): unknown {
  const s = v.trim()
  if (s === '') return null
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10)
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s)
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitFlow(inner).map((x) => parseScalar(x))
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    const obj: Record<string, unknown> = {}
    if (inner) {
      for (const pair of splitFlow(inner)) {
        const ci = pair.indexOf(':')
        if (ci === -1) continue
        obj[String(parseScalar(pair.slice(0, ci)))] = parseScalar(pair.slice(ci + 1))
      }
    }
    return obj
  }
  return s
}

/** Split a flow collection body on top-level commas (ignores nested/quoted). */
function splitFlow(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inS = false
  let inD = false
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (!inS && !inD) {
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
      else if (c === ',' && depth === 0) {
        out.push(s.slice(start, i).trim())
        start = i + 1
      }
    }
  }
  out.push(s.slice(start).trim())
  return out.filter((x) => x !== '')
}
