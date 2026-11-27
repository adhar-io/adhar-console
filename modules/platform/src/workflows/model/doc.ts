import { Document, isCollection, isMap, isNode, isPair, isScalar, isSeq, LineCounter, parseDocument, Scalar, visit } from 'yaml'
import type { Node, Pair, YAMLMap, YAMLSeq } from 'yaml'

/**
 * The designer's state is a parsed YAML Document, never a typed model of one
 * (design 0026 §6.5, INV-6): a field the designer does not understand is never
 * read into a model field, so it cannot be dropped on the way back out.
 *
 * A `WfDoc` is an IMMUTABLE snapshot: the exact text it was parsed from plus
 * the yaml Document for that text. Every edit goes clone → mutate → print →
 * parse, so three things always hold:
 *
 *   - `print(d)` is the text the document was parsed from, byte for byte. A
 *     document nobody edited saves with no diff, whatever its formatting;
 *   - node ranges (diagnostics, the YAML panel's cursor) describe the text the
 *     panel is showing, because that text is what was parsed;
 *   - undo is a list of snapshots, with nothing to invert.
 *
 * `reprint(d)` is the other half: the text an edit would produce if it changed
 * nothing. The corpus test holds it to JSON-equality with the source and to
 * keeping every comment (`roundtrip_test.ts`); it does NOT promise byte
 * identity, because a re-flowed scalar or a re-spaced comment is the same
 * document.
 *
 * Pure: no React, no fetch. `doc_test.ts`.
 */

export type Path = readonly (string | number)[]

export interface DocProblem {
  /** yaml's error code (`BAD_INDENT`, `DUPLICATE_KEY`, `MULTIPLE_DOCS`, …). */
  code: string
  message: string
  range?: TextRange
}

export interface TextRange {
  /** Offsets into `source`, end exclusive. */
  start: number
  end: number
  /** 1-based, as Monaco counts. */
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}

/** How the source was written, so an edit does not re-indent the whole file. */
export interface PrintStyle {
  /** `- item` indented under its key (yaml's default) or level with it (kubectl's). */
  indentSeq: boolean
  /** `{ a: 1 }` or `{a: 1}`. */
  flowPadding: boolean
}

export interface WfDoc {
  readonly source: string
  readonly doc: Document
  readonly errors: readonly DocProblem[]
  readonly warnings: readonly DocProblem[]
  readonly style: PrintStyle
  readonly lines: LineCounter
}

/* ─────────────────────────── parse / print ─────────────────────────── */

/** Read how the source indents sequences and pads flow collections; yaml's defaults when it shows neither. */
export function detectStyle(source: string, doc?: Document): PrintStyle {
  let indentSeq = true
  const lines = source.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    const key = /^(\s*)(?:- )?[^\s#'"-][^#]*:\s*(?:#.*)?$/.exec(lines[i])
    if (!key) continue
    let j = i + 1
    while (j < lines.length && /^\s*(#.*)?$/.test(lines[j])) j++
    const item = /^(\s*)- /.exec(lines[j] ?? '') ?? /^(\s*)-$/.exec(lines[j] ?? '')
    if (!item) continue
    const keyIndent = key[1].length + (/^\s*- /.test(lines[i]) ? 2 : 0)
    if (item[1].length === keyIndent) indentSeq = false
    else if (item[1].length < keyIndent) continue
    break
  }
  const flow = /(?:^|[\s,\[:])\{(\s?)[^{}\s]/m.exec(source.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '""'))
  return { indentSeq, flowPadding: flowPaddingOf(source, doc) ?? (flow ? flow[1] === ' ' : true) }
}

/** From the parsed tree: how the first non-empty flow collection (`{a: 1}` or `[a, b]`) is padded. Text inside scalars cannot mislead it. */
function flowPaddingOf(source: string, doc: Document | undefined): boolean | undefined {
  if (!doc) return undefined
  let padded: boolean | undefined
  visit(doc, {
    Collection(_k, n) {
      if (!n.flow || !n.items.length || !n.range) return undefined
      padded = source[n.range[0] + 1] === ' '
      return visit.BREAK
    },
  })
  return padded
}

function rangeFrom(lines: LineCounter, start: number, end: number): TextRange {
  const a = lines.linePos(start)
  const b = lines.linePos(Math.max(start, end))
  return { start, end, startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col }
}

/**
 * Parse ONE document. A stream of several (`---`) is reported as an error
 * (`MULTIPLE_DOCS`); split it with `splitStream` and open the part to edit.
 */
export function parse(source: string): WfDoc {
  const lines = new LineCounter()
  // `merge` so `<<:` reads as Kubernetes reads it; `uniqueKeys` because the API server would refuse the duplicate.
  const doc = parseDocument(source, { lineCounter: lines, merge: true, uniqueKeys: true, prettyErrors: false })
  const problem = (e: { code: string; message: string; pos: [number, number] }): DocProblem => ({
    code: e.code,
    message: e.message,
    range: rangeFrom(lines, e.pos[0], e.pos[1]),
  })
  return {
    source,
    doc,
    errors: doc.errors.map(problem),
    warnings: doc.warnings.map(problem),
    style: detectStyle(source, doc),
    lines,
  }
}

/** The text of this snapshot: exactly what it was parsed from. */
export function print(d: WfDoc): string {
  return d.source
}

function stringify(doc: Document, style: PrintStyle): string {
  return doc.toString({
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    indentSeq: style.indentSeq,
    flowCollectionPadding: style.flowPadding,
  })
}

/** What an edit that changed nothing would write (JSON-equal to the source, comments kept; not byte-identical). */
export function reprint(d: WfDoc): string {
  return stringify(d.doc, d.style)
}

/** The document as plain data. `null` when it does not parse. */
export function toJS(d: WfDoc): unknown {
  if (d.errors.length) return null
  try {
    return d.doc.toJS({ maxAliasCount: 100 })
  } catch {
    return null
  }
}

export class DocEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocEditError'
  }
}

/**
 * One edit: `fn` mutates a CLONE of the document, and the result is the
 * snapshot parsed from what that clone prints. Refuses a document that does
 * not parse (the designer never auto-fixes YAML), and refuses an edit whose
 * output would not parse back.
 */
export function edit(d: WfDoc, fn: (doc: Document) => void): WfDoc {
  if (d.errors.length) throw new DocEditError('The YAML has errors; fix them in the YAML panel first.')
  const clone = d.doc.clone()
  fn(clone)
  const next = parse(stringify(clone, d.style))
  if (next.errors.length) throw new DocEditError(`The edit produced YAML that does not parse: ${next.errors[0].message}`)
  return next
}

/** Whether two snapshots say the same thing (JSON-equal). Publishing drops a file that only changed its formatting. */
export function sameContent(a: WfDoc, b: WfDoc): boolean {
  if (a.errors.length || b.errors.length) return a.source === b.source
  return JSON.stringify(toJS(a)) === JSON.stringify(toJS(b))
}

/* ─────────────────────────── streams ─────────────────────────── */

/**
 * Split a multi-document stream into its documents, each keeping its own
 * `---` line and everything up to the next one; `parts.join('')` is the input
 * byte for byte. A `---` at column 0 followed by a space or a line end is
 * always a document marker — block scalars are indented and a flow scalar may
 * not carry one.
 */
export function splitStream(source: string): string[] {
  const parts: string[] = []
  let start = 0
  const re = /^---(?=[ \t\r\n]|$)/gm
  for (const m of source.matchAll(re)) {
    if (m.index === 0) continue
    parts.push(source.slice(start, m.index))
    start = m.index
  }
  parts.push(source.slice(start))
  // A leading part that holds only comments and blank lines belongs to the first document.
  if (parts.length > 1 && /^(\s*(#.*)?(\r?\n|$))*$/.test(parts[0])) {
    parts.splice(0, 2, parts[0] + parts[1])
  }
  return parts
}

/* ─────────────────────────── reading ─────────────────────────── */

/** The node at `path`, or undefined. */
export function nodeAt(d: WfDoc | Document, path: Path): Node | undefined {
  const doc = d instanceof Document ? d : d.doc
  if (!path.length) return isNode(doc.contents) ? doc.contents : undefined
  const n = doc.getIn(path as unknown[], true)
  return isNode(n) ? n : undefined
}

/** The plain value at `path` (aliases resolved), or undefined. */
export function getIn<T = unknown>(d: WfDoc | Document, path: Path): T | undefined {
  const doc = d instanceof Document ? d : d.doc
  const n = nodeAt(doc, path)
  if (!n) return undefined
  try {
    return n.toJS(doc, { maxAliasCount: 100 }) as T
  } catch {
    return undefined
  }
}

export function hasIn(d: WfDoc | Document, path: Path): boolean {
  return nodeAt(d, path) !== undefined
}

function pairAt(doc: Document, path: Path): Pair | undefined {
  if (!path.length) return undefined
  const parent = nodeAt(doc, path.slice(0, -1))
  if (!isMap(parent)) return undefined
  const key = path[path.length - 1]
  return parent.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key)
}

/**
 * Where `path` sits in the source. `what: 'key'` gives the key of a map entry
 * (the natural place for a marker on a missing or forbidden field); the
 * default is the value, falling back to the key when the value is empty.
 */
export function rangeOf(d: WfDoc, path: Path, what: 'value' | 'key' = 'value'): TextRange | undefined {
  const pair = pairAt(d.doc, path)
  const key = pair && isNode(pair.key) ? pair.key.range : undefined
  if (what === 'key' && key) return rangeFrom(d.lines, key[0], key[1])
  const n = nodeAt(d, path)
  const r = n?.range
  if (r && r[1] > r[0]) return rangeFrom(d.lines, r[0], r[1])
  if (key) return rangeFrom(d.lines, key[0], key[1])
  return undefined
}

/**
 * The deepest path whose node contains `offset` — how the YAML panel keeps its
 * cursor across a canvas edit (`rangeOf(next, pathAt(prev, offset))`).
 */
export function pathAt(d: WfDoc, offset: number): Path {
  const path: (string | number)[] = []
  let cur: unknown = d.doc.contents
  for (;;) {
    if (isMap(cur)) {
      const hit = cur.items.find((p) => {
        const k = isNode(p.key) ? p.key.range : undefined
        const v = isNode(p.value) ? p.value.range : undefined
        const from = k?.[0] ?? v?.[0]
        const to = v?.[2] ?? k?.[2]
        return from !== undefined && to !== undefined && offset >= from && offset <= to
      })
      if (!hit || !isScalar(hit.key)) return path
      path.push(hit.key.value as string | number)
      cur = hit.value
      continue
    }
    if (isSeq(cur)) {
      const i = cur.items.findIndex((n) => isNode(n) && n.range && offset >= n.range[0] && offset <= n.range[2])
      if (i < 0) return path
      path.push(i)
      cur = cur.items[i]
      continue
    }
    return path
  }
}

/** Every comment in the source, trimmed, in order — what a round trip must keep. */
export function commentsOf(d: WfDoc): string[] {
  const out: string[] = []
  const push = (c: string | null | undefined) => {
    if (!c) return
    for (const line of c.split('\n')) {
      const t = line.trim()
      if (t) out.push(t)
    }
  }
  push(d.doc.commentBefore)
  // `visit` reaches a pair's key and value as nodes, so each comment is seen once.
  visit(d.doc, {
    Node(_k, n) {
      push((n as Node).commentBefore)
      push((n as Node).comment)
    },
  })
  push(d.doc.comment)
  return out
}

/* ─────────────────────────── writing (inside `edit`) ─────────────────────────── */

/**
 * Strings YAML 1.1 reads as something else. Kubernetes parses manifests as
 * YAML 1.1 (`on`, `yes`, `n` are booleans; `1:30` is ninety; `1_000` is a
 * thousand), this library writes 1.2, where each of those is a plain string.
 * Written unquoted, a label value of `yes` would reach the API server as
 * `true` and be refused. Anything matching is written double-quoted.
 */
const YAML11_AMBIGUOUS =
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|~|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|[-+]?[0-9][0-9_]*_[0-9_]*(?:\.[0-9_]*)?|[-+]?0b[01_]+|[-+]?0[0-7_]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|=|<<)$/

export function needsQuoting(value: string): boolean {
  return YAML11_AMBIGUOUS.test(value)
}

/** A yaml node for a plain value, with strings Kubernetes would misread quoted. */
export function createValue(doc: Document, value: unknown): Node {
  const node = doc.createNode(value) as Node
  visit(node, {
    Scalar(_k, s) {
      if (typeof s.value === 'string' && needsQuoting(s.value)) s.type = Scalar.QUOTE_DOUBLE
    },
  })
  // Keys too: `on: push` would become `true: push`.
  visit(node, {
    Pair(_k, p) {
      if (isScalar(p.key) && typeof p.key.value === 'string' && needsQuoting(p.key.value)) p.key.type = Scalar.QUOTE_DOUBLE
    },
  })
  return node
}

const isPrimitive = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v)

/**
 * Set the value at `path`, creating missing maps on the way. A scalar that is
 * already there keeps its node — its comment and its quoting — and only
 * changes value.
 */
export function setNode(doc: Document, path: Path, value: unknown): void {
  if (!path.length) {
    doc.contents = createValue(doc, value) as unknown as typeof doc.contents
    return
  }
  const existing = nodeAt(doc, path)
  if (isScalar(existing) && isPrimitive(value)) {
    existing.value = value
    if (typeof value === 'string') {
      if (needsQuoting(value) && (existing.type === Scalar.PLAIN || !existing.type)) existing.type = Scalar.QUOTE_DOUBLE
      // A block scalar cannot hold a value with no line break faithfully in every case; let yaml choose again.
      if (!value.includes('\n') && (existing.type === Scalar.BLOCK_LITERAL || existing.type === Scalar.BLOCK_FOLDED)) existing.type = undefined
    } else if (existing.type && existing.type !== Scalar.PLAIN) {
      existing.type = undefined // `"3"` (a string) becoming 3 must not stay quoted
    }
    return
  }
  ensureParents(doc, path)
  doc.setIn(path as unknown[], createValue(doc, value))
}

function ensureParents(doc: Document, path: Path): void {
  if (doc.contents == null) doc.contents = doc.createNode(typeof path[0] === 'number' ? [] : {}) as unknown as typeof doc.contents
  for (let i = 1; i < path.length; i++) {
    const at = path.slice(0, i)
    const n = nodeAt(doc, at)
    if (isCollection(n)) continue
    if (n !== undefined && !(isScalar(n) && n.value == null)) {
      throw new DocEditError(`Cannot set ${path.join('.')}: ${at.join('.')} is not a map or a list.`)
    }
    doc.setIn(at as unknown[], doc.createNode(typeof path[i] === 'number' ? [] : {}))
  }
}

/** Delete the value at `path`. True when something was there. */
export function deleteNode(doc: Document, path: Path): boolean {
  if (!path.length || nodeAt(doc, path) === undefined) return false
  return doc.deleteIn(path as unknown[])
}

/** Append to the list at `path` (created when missing), or insert at `index`. Returns the item's index. */
export function insertNode(doc: Document, path: Path, value: unknown, index?: number): number {
  let seq = nodeAt(doc, path)
  if (seq === undefined || (isScalar(seq) && seq.value == null)) {
    ensureParents(doc, [...path, 0])
    doc.setIn(path as unknown[], doc.createNode([]))
    seq = nodeAt(doc, path)
  }
  if (!isSeq(seq)) throw new DocEditError(`${path.join('.')} is not a list.`)
  // A flow list (`[a, b]`) that gains a map would print as one long line; block style reads better.
  const node = createValue(doc, value)
  if (seq.flow && isCollection(node)) seq.flow = false
  const at = index === undefined || index < 0 || index > seq.items.length ? seq.items.length : index
  seq.items.splice(at, 0, node)
  return at
}

/** Rewrite every string scalar under `path` in place (quoting and comments kept). Returns how many changed. */
export function mapStrings(doc: Document, path: Path, fn: (value: string, at: Path) => string): number {
  const root = nodeAt(doc, path)
  if (!root) return 0
  let changed = 0
  const walk = (n: unknown, at: (string | number)[]): void => {
    if (isScalar(n)) {
      if (typeof n.value !== 'string') return
      const next = fn(n.value, at)
      if (next !== n.value) {
        n.value = next
        changed++
      }
      return
    }
    if (isMap(n)) {
      for (const p of (n as YAMLMap).items) {
        if (!isPair(p)) continue
        const key = isScalar(p.key) ? p.key.value : p.key
        if (typeof key === 'string' || typeof key === 'number') walk(p.value, [...at, key])
      }
      return
    }
    if (isSeq(n)) (n as YAMLSeq).items.forEach((item, i) => walk(item, [...at, i]))
  }
  walk(root, [...path])
  return changed
}
