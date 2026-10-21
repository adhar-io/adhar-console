import { parseYaml, type YamlValue } from '@adhar/utils'
import { yamlScalar } from './k8s-yaml.ts'

/**
 * Minimal, comment-preserving edits to block-style YAML.
 *
 * The scorecard fixes change one or two fields in a file a person wrote —
 * `catalog-info.yaml`, a Deployment, a `kustomization.yaml`. Parsing and
 * re-serialising would throw away every comment and reorder keys, which turns a
 * one-line fix into a review nobody wants to read. So these helpers work on the
 * LINES: find the key at the right indentation, replace or insert lines, leave
 * every other byte alone.
 *
 * The scope is deliberately narrow — block mappings and block sequences, which
 * is how these files are written in practice. Anything else (flow mappings,
 * anchors) makes an edit return `null`, and the caller falls back to a clean
 * re-serialisation that it SHOWS as such. Every successful edit is verified by
 * parsing the result back (see `verify*` in the callers), so a line edit that
 * produced something other than what was asked is never committed.
 *
 * Pure and JSX-free: the Deno test runner exercises it directly.
 */

/* ─────────── documents ─────────── */

export interface YamlStream {
  /** Each document's text, without its `---` separator line. */
  docs: string[]
  /** The separator line that preceded docs[i] (`''` for an unseparated first doc). */
  seps: string[]
}

const SEP = /^---(\s.*)?$/

/** Split a multi-document stream, keeping separators so `joinDocs` is exact. */
export function splitDocs(text: string): YamlStream {
  const lines = text.split('\n')
  const docs: string[] = []
  const seps: string[] = []
  let cur: string[] = []
  let sep = ''
  for (const line of lines) {
    if (SEP.test(line.replace(/\r$/, ''))) {
      docs.push(cur.join('\n'))
      seps.push(sep)
      cur = []
      sep = line
      continue
    }
    cur.push(line)
  }
  docs.push(cur.join('\n'))
  seps.push(sep)
  return { docs, seps }
}

export function joinDocs(s: YamlStream): string {
  return s.docs.map((d, i) => (i === 0 && s.seps[0] === '' ? d : `${s.seps[i]}\n${d}`)).join('\n')
}

/** Parse every non-empty document of a stream (unparseable ones are `null`). */
export function parseDocs(text: string): Array<{ index: number; value: YamlValue }> {
  const s = splitDocs(text)
  const out: Array<{ index: number; value: YamlValue }> = []
  s.docs.forEach((d, index) => {
    if (!d.split('\n').some(meaningful)) return
    out.push({ index, value: parseYaml(stripComments(d)) })
  })
  return out
}

/**
 * Drop trailing `# comments` outside quotes and outside block scalars. The
 * shared yaml-lite reader keeps them as part of a plain value (`1 # one` reads
 * as the string "1 # one"), which is fine for template discovery and wrong for
 * verifying an edit.
 */
export function stripComments(doc: string): string {
  const out: string[] = []
  let blockIndent = -1
  for (const line of doc.split('\n')) {
    const ind = indentOf(line)
    if (blockIndent >= 0) {
      if (!line.trim() || ind > blockIndent) {
        out.push(line)
        continue
      }
      blockIndent = -1
    }
    let inS = false
    let inD = false
    let cut = line.length
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === "'" && !inD) inS = !inS
      else if (c === '"' && !inS) inD = !inD
      else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
        cut = i
        break
      }
    }
    const kept = line.slice(0, cut).replace(/\s+$/, '')
    if (/(?::|^-|\s-)\s*[|>][-+0-9]*$/.test(kept.trimStart()) || /^\s*-?\s*[|>][-+0-9]*$/.test(kept)) blockIndent = ind
    out.push(kept)
  }
  return out.join('\n')
}

/* ─────────── line model ─────────── */

function meaningful(line: string): boolean {
  const t = line.trim()
  return t !== '' && !t.startsWith('#')
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

const KEY_RE = /^(?:"([^"]+)"|'([^']+)'|([^\s"'#:][^:#]*?))\s*:(?:\s|$)/

/** The mapping key a line starts with (after its indentation), or undefined. */
function keyOf(line: string): string | undefined {
  const m = KEY_RE.exec(line.trimStart())
  if (!m) return undefined
  return (m[1] ?? m[2] ?? m[3])?.trim()
}

/** What follows `key:` on a line, without a trailing comment. */
function inlineValue(line: string): { value: string; comment: string } {
  const t = line.trimStart()
  const m = KEY_RE.exec(t)
  if (!m) return { value: '', comment: '' }
  const rest = t.slice(m[0].length)
  // A ` #` outside quotes starts a comment.
  let inS = false
  let inD = false
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(rest[i - 1]))) {
      return { value: rest.slice(0, i).trim(), comment: rest.slice(i) }
    }
  }
  return { value: rest.trim(), comment: '' }
}

function isSeqItem(line: string): boolean {
  return /^-(\s|$)/.test(line.trimStart())
}

/**
 * Index one past the last meaningful line of the block owned by the key at
 * `i` (indentation `indent`). Children are deeper lines, plus sequence items at
 * the key's own indentation (`key:\n- a`), which YAML allows and kubectl emits.
 */
function blockEnd(lines: string[], i: number, indent: number, limit = lines.length): number {
  let last = i
  for (let j = i + 1; j < limit; j++) {
    if (!meaningful(lines[j])) continue
    const ind = indentOf(lines[j])
    if (ind > indent || (ind === indent && isSeqItem(lines[j]))) {
      last = j
      continue
    }
    break
  }
  return last + 1
}

function findKey(lines: string[], from: number, to: number, indent: number, key: string): number {
  for (let i = from; i < to; i++) {
    if (!meaningful(lines[i])) continue
    if (indentOf(lines[i]) !== indent) continue
    if (isSeqItem(lines[i])) continue
    if (keyOf(lines[i]) === key) return i
  }
  return -1
}

/** Indentation of the mapping children under the key at `i`, or a 2-space default. */
function childIndent(lines: string[], i: number, end: number): number {
  const base = indentOf(lines[i])
  for (let j = i + 1; j < end; j++) {
    if (!meaningful(lines[j])) continue
    const ind = indentOf(lines[j])
    if (ind > base && !isSeqItem(lines[j])) return ind
    if (ind > base) return ind
  }
  return base + 2
}

/** The indentation of the top-level keys of a document (usually 0). */
function rootIndent(lines: string[]): number {
  for (const l of lines) if (meaningful(l)) return indentOf(l)
  return 0
}

/** Insertion point for a new top-level key: after the last meaningful line. */
function docEnd(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (meaningful(lines[i])) return i + 1
  return lines.length
}

function pad(n: number): string {
  return ' '.repeat(n)
}

/** Lines for `path[k..]` = value, nested under one another starting at `indent`. */
function nestedLines(path: string[], value: string, indent: number): string[] {
  const out: string[] = []
  path.forEach((seg, i) => {
    const last = i === path.length - 1
    out.push(`${pad(indent + i * 2)}${seg}:${last ? ` ${value}` : ''}`)
  })
  return out
}

interface Located {
  /** The line of the deepest found key (or -1 at the document root). */
  line: number
  /** How many path segments were found. */
  depth: number
  /** Range searched for the next segment. */
  from: number
  to: number
  indent: number
}

function locate(lines: string[], path: string[]): Located | null {
  let from = 0
  let to = lines.length
  let indent = rootIndent(lines)
  let line = -1
  for (let d = 0; d < path.length; d++) {
    const at = findKey(lines, from, to, indent, path[d])
    if (at < 0) return { line, depth: d, from, to: line < 0 ? docEnd(lines) : to, indent }
    // A key with an inline value that is not a block indicator has no children
    // to descend into; descending would be wrong unless it is the leaf.
    if (d < path.length - 1) {
      const { value } = inlineValue(lines[at])
      if (value !== '') return null // flow mapping / scalar where a mapping is needed
    }
    line = at
    const end = blockEnd(lines, at, indent, to)
    from = at + 1
    to = end
    indent = childIndent(lines, at, end)
  }
  return { line, depth: path.length, from, to, indent }
}

/**
 * Set a scalar at `path` (e.g. `['spec', 'owner']`), creating missing parents.
 * Returns the new document text, or null when the shape is outside what a line
 * edit can do safely.
 */
export function setScalar(doc: string, path: string[], value: string | number | boolean): string | null {
  const lines = doc.split('\n')
  const loc = locate(lines, path)
  if (!loc) return null
  const rendered = yamlScalar(value)
  if (loc.depth === path.length) {
    const i = loc.line
    const ind = indentOf(lines[i])
    const keyText = lines[i].trimStart().slice(0, lines[i].trimStart().indexOf(':'))
    const { value: old, comment } = inlineValue(lines[i])
    // A block scalar or a nested mapping under the key goes with the old value.
    const end = blockEnd(lines, i, ind)
    const keepComment = old !== '' && !/^[|>]/.test(old) && comment ? ` ${comment}` : ''
    const replaced = `${pad(ind)}${keyText}: ${rendered}${keepComment}`
    lines.splice(i, end - i, replaced)
    return lines.join('\n')
  }
  const rest = path.slice(loc.depth)
  const insertAt = loc.depth === 0 ? docEnd(lines) : loc.to
  lines.splice(insertAt, 0, ...nestedLines(rest, rendered, loc.indent))
  return lines.join('\n')
}

/** Remove a scalar key (and nothing else). Returns the doc unchanged when absent. */
export function removeKey(doc: string, path: string[]): string | null {
  const lines = doc.split('\n')
  const loc = locate(lines, path)
  if (!loc) return null
  if (loc.depth !== path.length) return doc
  const i = loc.line
  const end = blockEnd(lines, i, indentOf(lines[i]))
  lines.splice(i, end - i)
  return lines.join('\n')
}

/** Render one sequence item (a scalar or a flat/nested mapping) at `indent`. */
function itemLines(item: YamlValue, indent: number): string[] {
  if (item === null || typeof item !== 'object') return [`${pad(indent)}- ${yamlScalar(item)}`]
  const body = mappingLines(item as Record<string, YamlValue>, indent + 2)
  if (!body.length) return [`${pad(indent)}- {}`]
  return [`${pad(indent)}- ${body[0].trimStart()}`, ...body.slice(1)]
}

function mappingLines(obj: Record<string, YamlValue>, indent: number): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(`${pad(indent)}${k}:`, ...mappingLines(v as Record<string, YamlValue>, indent + 2))
    } else if (Array.isArray(v)) {
      out.push(`${pad(indent)}${k}:`)
      for (const it of v) out.push(...itemLines(it, indent))
    } else {
      out.push(`${pad(indent)}${k}: ${yamlScalar(v)}`)
    }
  }
  return out
}

/**
 * Append an item to the block sequence at `path`, creating it (and missing
 * parents) when absent. `key: []` becomes a block sequence; a non-empty flow
 * sequence returns null (the caller re-serialises instead).
 */
export function appendSeqItem(doc: string, path: string[], item: YamlValue): string | null {
  const lines = doc.split('\n')
  const loc = locate(lines, path)
  if (!loc) return null
  if (loc.depth < path.length) {
    const rest = path.slice(loc.depth)
    const insertAt = loc.depth === 0 ? docEnd(lines) : loc.to
    const head = rest.map((seg, i) => `${pad(loc.indent + i * 2)}${seg}:`)
    const itemIndent = loc.indent + (rest.length - 1) * 2
    lines.splice(insertAt, 0, ...head, ...itemLines(item, itemIndent))
    return lines.join('\n')
  }
  const i = loc.line
  const ind = indentOf(lines[i])
  const { value, comment } = inlineValue(lines[i])
  if (value === '[]') {
    const keyText = lines[i].trimStart().slice(0, lines[i].trimStart().indexOf(':'))
    lines.splice(i, 1, `${pad(ind)}${keyText}:${comment ? ` ${comment}` : ''}`, ...itemLines(item, ind))
    return lines.join('\n')
  }
  if (value !== '') return null
  const end = blockEnd(lines, i, ind)
  let itemIndent = -1
  for (let j = i + 1; j < end; j++) {
    if (meaningful(lines[j]) && isSeqItem(lines[j])) {
      itemIndent = indentOf(lines[j])
      break
    }
  }
  if (itemIndent < 0) {
    // `key:` with mapping children (not a sequence) cannot take an item.
    for (let j = i + 1; j < end; j++) if (meaningful(lines[j])) return null
    itemIndent = ind
  }
  lines.splice(end, 0, ...itemLines(item, itemIndent))
  return lines.join('\n')
}

/* ─────────── value access (for verification) ─────────── */

export function getPath(v: YamlValue | undefined, path: Array<string | number>): YamlValue | undefined {
  let cur: YamlValue | undefined = v
  for (const seg of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = Array.isArray(cur) ? cur[seg as number] : (cur as Record<string, YamlValue>)[seg as string]
  }
  return cur
}

export function asRecord(v: YamlValue | undefined): Record<string, YamlValue> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, YamlValue>) : undefined
}

export function asArray(v: YamlValue | undefined): YamlValue[] {
  return Array.isArray(v) ? v : []
}

/* ─────────── Kubernetes-workload edits ─────────── */

export interface ResourceSpec {
  requests: { cpu: string; memory: string }
  limits: { cpu: string; memory: string }
}

/**
 * Give every container under `spec.template.spec.containers` the requests and
 * limits it is missing. A container that already declares both keeps its own
 * numbers — the fix only fills gaps. Returns the new text and how many
 * containers changed, or null when the containers block could not be found.
 */
export function addContainerResources(doc: string, res: ResourceSpec): { text: string; changed: string[] } | null {
  const lines = doc.split('\n')
  const loc = locate(lines, ['spec', 'template', 'spec', 'containers'])
  if (!loc || loc.depth !== 4) return null
  const keyLine = loc.line
  const keyIndent = indentOf(lines[keyLine])
  if (inlineValue(lines[keyLine]).value !== '') return null
  const changed: string[] = []

  // Walk items bottom-up so insertions do not shift the items still to visit.
  const end = blockEnd(lines, keyLine, keyIndent)
  const starts: number[] = []
  let itemIndent = -1
  for (let j = keyLine + 1; j < end; j++) {
    if (!meaningful(lines[j]) || !isSeqItem(lines[j])) continue
    const ind = indentOf(lines[j])
    if (itemIndent < 0) itemIndent = ind
    if (ind === itemIndent) starts.push(j)
  }
  if (!starts.length) return null
  for (let s = starts.length - 1; s >= 0; s--) {
    const start = starts[s]
    const stop = s + 1 < starts.length ? starts[s + 1] : end
    // Key indentation inside the item: the column after `- `.
    const dashLine = lines[start]
    const afterDash = dashLine.slice(itemIndent + 1)
    const k = itemIndent + 1 + (afterDash.length - afterDash.trimStart().length)
    // The item's own last meaningful line.
    let last = start
    for (let j = start + 1; j < stop; j++) if (meaningful(lines[j])) last = j
    const name = (() => {
      const first = dashLine.slice(k)
      if (keyOf(first) === 'name') return inlineValue(first).value.replace(/^["']|["']$/g, '')
      for (let j = start + 1; j <= last; j++) {
        if (indentOf(lines[j]) === k && keyOf(lines[j]) === 'name') return inlineValue(lines[j]).value.replace(/^["']|["']$/g, '')
      }
      return `container ${s + 1}`
    })()
    let resLine = -1
    if (keyOf(dashLine.slice(k)) === 'resources') resLine = start
    for (let j = start + 1; j <= last && resLine < 0; j++) {
      if (meaningful(lines[j]) && indentOf(lines[j]) === k && keyOf(lines[j]) === 'resources') resLine = j
    }
    const block = (indent: number, which: Array<'requests' | 'limits'>) =>
      which.flatMap((w) => [
        `${pad(indent)}${w}:`,
        `${pad(indent + 2)}cpu: ${yamlScalar(res[w].cpu)}`,
        `${pad(indent + 2)}memory: ${yamlScalar(res[w].memory)}`,
      ])
    if (resLine < 0) {
      lines.splice(last + 1, 0, `${pad(k)}resources:`, ...block(k + 2, ['requests', 'limits']))
      changed.push(name)
      continue
    }
    // `- resources: …` as the item's first key is rare; leave it to a re-serialise.
    if (resLine === start) return null
    const { value } = inlineValue(lines[resLine])
    if (value === '{}' || value === '') {
      const resEnd = blockEnd(lines, resLine, k, last + 1)
      if (value === '{}') {
        lines.splice(resLine, resEnd - resLine, `${pad(k)}resources:`, ...block(k + 2, ['requests', 'limits']))
        changed.push(name)
        continue
      }
      // Existing block: add whichever of requests / limits is missing, and
      // the cpu / memory a present one lacks. Work bottom-up (limits first
      // when it comes later) so indexes stay valid.
      const childInd = childIndent(lines, resLine, resEnd)
      const missing = (['requests', 'limits'] as const).filter((w) => findKey(lines, resLine + 1, resEnd, childInd, w) < 0)
      let touched = false
      const present = (['requests', 'limits'] as const)
        .map((w) => ({ w, at: findKey(lines, resLine + 1, resEnd, childInd, w) }))
        .filter((p) => p.at >= 0)
        .sort((a, b) => b.at - a.at)
      if (missing.length) {
        lines.splice(resEnd, 0, ...block(childInd, [...missing]))
        touched = true
      }
      for (const { w, at } of present) {
        if (inlineValue(lines[at]).value !== '') return null
        const wEnd = blockEnd(lines, at, childInd)
        const leafInd = childIndent(lines, at, wEnd)
        const add = (['cpu', 'memory'] as const)
          .filter((q) => findKey(lines, at + 1, wEnd, leafInd, q) < 0)
          .map((q) => `${pad(leafInd)}${q}: ${yamlScalar(res[w][q])}`)
        if (add.length) {
          lines.splice(wEnd, 0, ...add)
          touched = true
        }
      }
      if (touched) changed.push(name)
      continue
    }
    return null
  }
  return { text: lines.join('\n'), changed: changed.reverse() }
}

/* ─────────── line diff (for the preview) ─────────── */

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del'
  text: string
}

/** LCS line diff, trimmed to the common prefix/suffix first (edits are local). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  const out: DiffLine[] = a.slice(0, pre).map((text) => ({ kind: 'ctx' as const, text }))
  if (am.length * bm.length > 2_000_000) {
    for (const t of am) out.push({ kind: 'del', text: t })
    for (const t of bm) out.push({ kind: 'add', text: t })
  } else {
    const n = am.length
    const m = bm.length
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        out.push({ kind: 'ctx', text: am[i] })
        i++
        j++
      } else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) {
        out.push({ kind: 'del', text: am[i] })
        i++
      } else {
        out.push({ kind: 'add', text: bm[j] })
        j++
      }
    }
  }
  for (const t of a.slice(a.length - suf)) out.push({ kind: 'ctx', text: t })
  return out
}

/** Keep `context` unchanged lines around each change; `null` marks a gap. */
export function diffHunks(lines: DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = lines.map(() => false)
  lines.forEach((l, i) => {
    if (l.kind === 'ctx') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const out: Array<DiffLine | null> = []
  let gap = false
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap && out.length) out.push(null)
      gap = false
      out.push(l)
    } else gap = true
  })
  return out
}
