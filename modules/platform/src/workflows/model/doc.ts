import { Document, isAlias, isCollection, isMap, isNode, isPair, isScalar, isSeq, LineCounter, Pair, parseDocument, Scalar, visit } from 'yaml'
import type { Alias, Node, ScalarTag, Tags, YAMLMap, YAMLSeq } from 'yaml'

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
  /** The file's line ending: a Windows file stays a Windows file after an edit. */
  eol: '\n' | '\r\n'
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
  // Windows line endings only when EVERY line ends that way; a mixed file is written with `\n`, as yaml writes it.
  const eol = /\r\n/.test(source) && !/(^|[^\r])\n/.test(source) ? '\r\n' : '\n'
  return { indentSeq, flowPadding: flowPaddingOf(source, doc) ?? (flow ? flow[1] === ' ' : true), eol }
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

const INT_TAG = 'tag:yaml.org,2002:int'
const FLOAT_TAG = 'tag:yaml.org,2002:float'

/**
 * Numbers are printed AS THEY WERE WRITTEN.
 *
 * This library reads YAML 1.2 and Kubernetes reads YAML 1.1, and the two
 * disagree about what a number is: `mode: 0644` is 644 here and octal 420
 * there. Left to itself the library prints the number it read — `644` — so one
 * unrelated edit anywhere in the file would silently change a volume's
 * permissions (two upstream examples carry exactly that line). It also prints
 * a 20-digit integer as the float it was rounded to.
 *
 * So every numeric tag keeps the scalar's source text for as long as that text
 * still reads as the scalar's value; a number an edit CHANGED has no source
 * (`setNode` drops it) and prints normally.
 */
function keepNumberSpelling(tags: Tags): Tags {
  const numeric = tags.filter((t): t is ScalarTag => typeof t !== 'string' && (t.tag === INT_TAG || t.tag === FLOAT_TAG) && t.test instanceof RegExp && typeof (t as ScalarTag).resolve === 'function')
  /** What `text` reads as: the first numeric tag whose test matches, as the composer picks it. */
  const read = (text: string): unknown => {
    for (const t of numeric) {
      if (!t.test!.test(text)) continue
      const r = t.resolve(text, () => {}, { intAsBigInt: false } as Parameters<ScalarTag['resolve']>[2])
      return isScalar(r) ? r.value : r
    }
    return undefined
  }
  return tags.map((t) => {
    if (typeof t === 'string' || !numeric.includes(t as ScalarTag)) return t
    const tag = t as ScalarTag
    const wrapped: ScalarTag = {
      ...tag,
      stringify(item, ctx, onComment, onChompKeep) {
        const text = item.source
        if (typeof text === 'string' && typeof item.value === 'number' && Object.is(read(text), item.value)) return text
        return tag.stringify ? tag.stringify(item, ctx, onComment, onChompKeep) : String(item.value)
      },
    }
    return wrapped
  }) as Tags
}

/**
 * Parse ONE document. A stream of several (`---`) is reported as an error
 * (`MULTIPLE_DOCS`); split it with `splitStream` and open the part to edit.
 */
export function parse(source: string): WfDoc {
  const lines = new LineCounter()
  // `merge` so `<<:` reads as Kubernetes reads it; `uniqueKeys` because the API server would refuse the duplicate.
  const doc = parseDocument(source, { lineCounter: lines, merge: true, uniqueKeys: true, prettyErrors: false, customTags: keepNumberSpelling })
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
  const out = doc.toString({
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    indentSeq: style.indentSeq,
    flowCollectionPadding: style.flowPadding,
  })
  return style.eol === '\r\n' ? out.replace(/\r?\n/g, '\r\n') : out
}

/** What an edit that changed nothing would write (JSON-equal to the source, comments kept; not byte-identical). */
export function reprint(d: WfDoc): string {
  return stringify(d.doc, d.style)
}

/**
 * The document as plain data. `null` when it does not parse.
 *
 * This is the document as THIS library reads it (YAML 1.2), for projecting and
 * validating. It is NOT what to send to the cluster: the API server reads YAML
 * 1.1, where `mode: 0644` is 420 and `enabled: yes` is true. Anything that
 * creates or updates the object (a draft save, a test run, a publish) sends
 * the TEXT (`print`) and lets the server parse it, as `kubectl apply -f` and
 * Argo CD do; JSON made from this value would be a different manifest.
 */
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
  let text: string
  try {
    fn(clone)
    text = stringify(clone, d.style)
  } catch (e) {
    // The caller's own refusals pass through; anything the library throws (an alias left with no anchor, a node it cannot print) becomes one error type the canvas can show.
    if (e instanceof DocEditError || (e instanceof Error && e.name === 'OpError')) throw e
    throw new DocEditError(`The edit could not be written: ${e instanceof Error ? e.message : String(e)}`)
  }
  const next = parse(text)
  if (next.errors.length) throw new DocEditError(`The edit produced YAML that does not parse: ${next.errors[0].message}`)
  return next
}

const fingerprints = new WeakMap<WfDoc, string>()

/**
 * The document as Kubernetes would read it, as a string to compare.
 *
 * Plain JSON-equality is not enough, for the same reason numbers keep their
 * spelling: `mode: 644` and `mode: 0644` are one number to this library and
 * two to the API server, and `enabled: yes` is a string here and `true` there.
 * So a number carries how it was written, and a plain string that YAML 1.1
 * reads as something else is told apart from the same string quoted.
 */
function fingerprint(d: WfDoc): string {
  let f = fingerprints.get(d)
  if (f !== undefined) return f
  const clone = d.doc.clone()
  visit(clone, {
    Scalar(_k, s) {
      if (typeof s.value === 'number' || typeof s.value === 'bigint') {
        if (typeof s.source === 'string' && s.source !== JSON.stringify(s.value)) s.value = `\u0000number ${s.source}`
      } else if (typeof s.value === 'string' && (!s.type || s.type === Scalar.PLAIN) && needsQuoting(s.value)) {
        s.value = `\u0000plain ${s.value}`
      }
    },
  })
  try {
    f = JSON.stringify(clone.toJS({ maxAliasCount: 100 }))
  } catch {
    f = d.source
  }
  fingerprints.set(d, f)
  return f
}

/**
 * Whether two snapshots say the same thing TO THE CLUSTER. Publishing drops a
 * file that only changed its formatting; it must not drop `644` → `0644`.
 */
export function sameContent(a: WfDoc, b: WfDoc): boolean {
  if (a.errors.length || b.errors.length) return a.source === b.source
  return fingerprint(a) === fingerprint(b)
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
 * `true` and be refused. Anything matching is written double-quoted. A date or
 * a time is in the list too (`2026-12-05T10:00:00Z` is a `!!timestamp` in 1.1):
 * the API server happens to read one back as a string, other readers do not.
 */
const YAML11_AMBIGUOUS =
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|~|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|[-+]?[0-9][0-9_]*_[0-9_]*(?:\.[0-9_]*)?|[-+]?0b[01_]+|[-+]?0[0-7_]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|=|<<|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::?[0-9]{2})?))?)?)$/

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
 * Give a scalar that is already in the document a new string value. The node
 * stays — its comment, and its quoting where the new value allows it — but a
 * plain scalar whose new text YAML 1.1 reads as something else (a task renamed
 * to `no`, a dependency list left holding `on`) becomes quoted.
 */
export function setScalarString(s: Scalar, value: string): void {
  if (s.value !== value) s.source = undefined
  s.value = value
  if (needsQuoting(value) && (s.type === Scalar.PLAIN || !s.type)) s.type = Scalar.QUOTE_DOUBLE
  // A block scalar cannot hold a value with no line break faithfully in every case; let yaml choose again.
  if (!value.includes('\n') && (s.type === Scalar.BLOCK_LITERAL || s.type === Scalar.BLOCK_FOLDED)) s.type = undefined
}

/* ── anchors, aliases and merge keys ──
 *
 * `toJS` shows a document with every alias (`*a`) followed and every merge key
 * (`<<: *a`) folded in, and that view is where the designer's paths come from.
 * The TREE is different: an alias is one node standing for another, and a
 * merged key is not in the map at all. A write that follows a path through
 * either would land in the wrong place — in the anchored original, changing
 * everything that shares it, or in a fresh map beside the inherited one.
 *
 * So a write first makes its path the document's OWN, in both directions:
 *
 *   - an alias on the way is replaced by a copy of what it stood for, and a map
 *     that inherits the next key has its merge written out;
 *   - an ANCHORED node on the way gives each of its aliases a copy and drops
 *     the anchor, because what is about to change here must not change there.
 *
 * The content (`toJS`) is unchanged by that; only the sharing is given up, and
 * only on the path being edited. The rule every operation relies on follows:
 * an edit changes the paths it names and no others. (Someone who wants the
 * sharing kept edits the anchor in the YAML panel, where text is text.)
 */

const mergeKey = (p: Pair): boolean => {
  const k = isScalar(p.key) ? p.key.value : p.key
  return k === '<<' ? !isScalar(p.key) || !p.key.type || p.key.type === Scalar.PLAIN : typeof k === 'symbol' && k.description === '<<'
}
const keyOf = (p: Pair): unknown => (isScalar(p.key) ? p.key.value : p.key)
const MAX_MERGE_DEPTH = 16

/** A copy of `node` that can stand somewhere else in the document: the anchors stay with the original. */
function detached(node: Node): Node {
  const copy = node.clone() as Node
  visit(copy, {
    Node(_k, n) {
      if (!isAlias(n) && (n as { anchor?: string }).anchor) (n as { anchor?: string }).anchor = undefined
    },
  })
  return copy
}

function resolved(doc: Document, n: unknown): unknown {
  return isAlias(n) ? n.resolve(doc) : n
}

/** What a map inherits through its merge keys: key → the pair that supplies it, nearest source first. */
function inheritedPairs(doc: Document, map: YAMLMap, depth = 0): Map<unknown, Pair> {
  const out = new Map<unknown, Pair>()
  if (depth > MAX_MERGE_DEPTH) return out
  const explicit = new Set(map.items.filter((p) => !mergeKey(p)).map(keyOf))
  for (const p of map.items) {
    if (!mergeKey(p)) continue
    const value = resolved(doc, p.value)
    const sources = isSeq(value) ? value.items.map((x) => resolved(doc, x)) : [value]
    for (const src of sources) {
      if (!isMap(src)) continue
      const own = new Map<unknown, Pair>()
      for (const q of src.items) if (!mergeKey(q)) own.set(keyOf(q), q)
      for (const [k, q] of [...own, ...inheritedPairs(doc, src, depth + 1)]) {
        if (!explicit.has(k) && !out.has(k)) out.set(k, q)
      }
    }
  }
  return out
}

/** Write a map's merge keys out as ordinary keys, where the merge key stood. True when it had any. */
export function expandMerges(doc: Document, map: YAMLMap): boolean {
  const at = map.items.findIndex(mergeKey)
  if (at < 0) return false
  const inherited = [...inheritedPairs(doc, map).values()].map((q) => {
    const key = isNode(q.key) ? detached(q.key) : q.key
    const value = isNode(q.value) ? detached(q.value) : q.value
    return new Pair(key, value) as Pair<unknown, unknown>
  })
  // A comment written above `<<:` stays above what replaced it.
  const first = map.items[at]
  const note = isNode(first.key) ? first.key.commentBefore : undefined
  if (note && inherited.length && isNode(inherited[0].key)) inherited[0].key.commentBefore = note
  map.items = [...map.items.slice(0, at), ...inherited, ...map.items.slice(at)].filter((p) => !mergeKey(p))
  return true
}

/**
 * Give every alias of `node`'s anchor its own copy and drop the anchor. A map
 * that MERGES it (`<<: *a`) gets the inherited keys written out instead.
 */
function disown(doc: Document, node: Node): void {
  const anchor = (node as { anchor?: string }).anchor
  if (isAlias(node) || !anchor) return
  const merging = new Set<YAMLMap>()
  visit(doc, {
    Alias(_k, alias, path) {
      // An anchor name can be defined twice; only an alias that really resolves here is detached.
      if (alias.source !== anchor || alias.resolve(doc) !== node) return undefined
      const parent = path[path.length - 1]
      const up = path[path.length - 2]
      const upper = path[path.length - 3]
      if (isPair(parent) && mergeKey(parent) && isMap(up)) merging.add(up)
      else if (isSeq(parent) && isPair(up) && mergeKey(up) && isMap(upper)) merging.add(upper)
      else return keepComments(detached(node), alias)
      return undefined
    },
  })
  // After the walk: writing a merge out replaces the items of the map being walked.
  for (const m of merging) expandMerges(doc, m)
  ;(node as { anchor?: string }).anchor = undefined
}

/**
 * Make `path` the document's own, as far as it exists, and return the node
 * there.
 *
 *   - `whole`: a map at the end also has its merge keys written out, for a
 *     caller about to change several of its keys;
 *   - `keepLast`: the node at the end is about to be REPLACED or removed, not
 *     changed in place, so it is left as it is (an alias stays an alias; the
 *     caller hands its anchors over, `handOverAnchors`).
 */
export function own(doc: Document, path: Path, opts: { whole?: boolean; keepLast?: boolean } = {}): Node | undefined {
  let cur: unknown = doc.contents
  if (isNode(cur) && !(opts.keepLast && !path.length)) disown(doc, cur)
  for (let i = 0; i < path.length; i++) {
    const key = path[i]
    const last = i === path.length - 1 && opts.keepLast === true
    if (isMap(cur)) {
      let pair = cur.items.find((p) => !mergeKey(p) && keyOf(p) === key)
      if (!pair && inheritedPairs(doc, cur).has(key)) {
        expandMerges(doc, cur)
        pair = cur.items.find((p) => keyOf(p) === key)
      }
      if (!pair) return undefined
      if (!last && isAlias(pair.value)) {
        const target = pair.value.resolve(doc)
        if (!target) return undefined
        pair.value = keepComments(detached(target), pair.value)
      }
      cur = pair.value
    } else if (isSeq(cur)) {
      if (typeof key !== 'number') return undefined
      const item = cur.items[key]
      if (!last && isAlias(item)) {
        const target = item.resolve(doc)
        if (!target) return undefined
        cur.items[key] = keepComments(detached(target), item)
      }
      cur = cur.items[key]
    } else return undefined
    if (!last && isNode(cur)) disown(doc, cur)
  }
  if (opts.whole && isMap(cur)) expandMerges(doc, cur)
  return isNode(cur) ? cur : undefined
}

function keepComments(copy: Node, alias: Alias): Node {
  if (alias.commentBefore) copy.commentBefore = alias.commentBefore
  if (alias.comment && !copy.comment) copy.comment = alias.comment
  return copy
}

/**
 * Before `doomed` leaves the document (or a scalar in it changes value): an
 * anchor inside it that something else still points at moves to the first
 * alias that pointed there, which becomes the definition (a copy of the
 * content). Without this the remaining aliases would name an anchor that no
 * longer exists and the file could not be written. Returns the anchors moved.
 */
function handOverAnchors(doc: Document, doomed: Node): Set<string> {
  const inside = new Set<unknown>()
  const anchors = new Map<string, Node>()
  const moved = new Set<string>()
  visit(doomed, {
    Node(_k, n) {
      inside.add(n)
      const a = (n as { anchor?: string }).anchor
      if (!isAlias(n) && a) anchors.set(a, n as Node)
    },
  })
  if (!anchors.size) return moved
  visit(doc, {
    Alias(_k, alias) {
      if (inside.has(alias) || moved.has(alias.source)) return undefined
      const target = anchors.get(alias.source)
      // An anchor name can be defined twice; only an alias that really resolves into the doomed part is rehomed.
      if (!target || alias.resolve(doc) !== target) return undefined
      const copy = keepComments(target.clone() as Node, alias)
      visit(copy, {
        Node(_k2, n) {
          const a = (n as { anchor?: string }).anchor
          if (!isAlias(n) && a) moved.add(a)
        },
      })
      // The alias becomes the definition. (The walk goes on into the copy; its anchors are in `moved`, so nothing in it is rehomed twice.)
      return copy
    },
  })
  return moved
}

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
  own(doc, path, { keepLast: true })
  const existing = nodeAt(doc, path)
  if (isScalar(existing) && isPrimitive(value)) {
    // Aliases of this scalar keep the value they had.
    if (existing.anchor && handOverAnchors(doc, existing).has(existing.anchor)) existing.anchor = undefined
    if (typeof value === 'string') {
      setScalarString(existing, value)
      return
    }
    // A number that changed is printed as a number, not in the spelling of the one it replaced.
    if (!Object.is(existing.value, value)) {
      existing.source = undefined
      existing.format = undefined
      existing.minFractionDigits = undefined
    }
    existing.value = value
    if (existing.type && existing.type !== Scalar.PLAIN) existing.type = undefined // `"3"` (a string) becoming 3 must not stay quoted
    return
  }
  ensureParents(doc, path)
  if (isNode(existing)) handOverAnchors(doc, existing)
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
  if (!path.length) return false
  own(doc, path, { keepLast: true })
  // In a map that merges another, a deleted key the other also has would show through again: write the merge out first.
  const parent = nodeAt(doc, path.slice(0, -1))
  if (isMap(parent)) expandMerges(doc, parent)
  const doomed = nodeAt(doc, path)
  if (doomed === undefined) return false
  handOverAnchors(doc, doomed)
  return doc.deleteIn(path as unknown[])
}

/** Append to the list at `path` (created when missing), or insert at `index`. Returns the item's index. */
export function insertNode(doc: Document, path: Path, value: unknown, index?: number): number {
  own(doc, path)
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
        setScalarString(n, next)
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
