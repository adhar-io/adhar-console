/**
 * yaml-lite — a tiny, dependency-free YAML reader for the *specific* subset the
 * Backstage Software Templates use (`catalog-info.yaml` Locations and
 * `template.yaml` Templates). It is deliberately NOT a general YAML engine.
 *
 * Supported: block mappings + sequences (2-space or any consistent indent),
 * flow sequences (`[a, b]`), single/double-quoted and plain scalars, folded
 * block scalars (`>-` / `>`), literal block scalars (`|` / `|-`), integers,
 * floats, booleans, null, `#` comment lines, and keys that contain a colon
 * (e.g. `ui:field:`). Anchors, aliases, tags and complex flow maps are not
 * needed by these documents and are treated as plain strings.
 *
 * Kept server-side; both the template discovery (`templates.ts`) and the
 * scaffolder (`scaffolder.ts`) parse the platform's real template docs with it.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue }

interface Line {
  indent: number
  content: string // trimmed of leading indent; trailing \r removed
}

/** Split into meaningful lines, dropping blanks and whole-line comments. */
function scan(src: string): Line[] {
  const out: Line[] = []
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    out.push({ indent, content: line.slice(indent) })
  }
  return out
}

/** Find the first `:` that acts as a key/value separator (followed by space or EOL). */
function splitKeyValue(content: string): { key: string; value: string } | null {
  let inS = false
  let inD = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (c === ':' && !inS && !inD) {
      const next = content[i + 1]
      if (next === undefined || next === ' ') {
        return { key: unquote(content.slice(0, i).trim()), value: content.slice(i + 1).trim() }
      }
    }
  }
  return null
}

function unquote(s: string): string {
  if (s.length >= 2) {
    if (s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
    if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'")
  }
  return s
}

/** Parse a plain / flow scalar into a typed value. */
function parseScalar(raw: string): YamlValue {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return s === '' ? '' : null
  if (s === 'true' || s === 'True') return true
  if (s === 'false' || s === 'False') return false
  if (s[0] === '[' && s[s.length - 1] === ']') {
    const inner = s.slice(1, -1).trim()
    if (inner === '') return []
    return splitFlow(inner).map((p) => parseScalar(p))
  }
  if (s[0] === '{' && s[s.length - 1] === '}') {
    // Minimal flow map support (not used by these docs, but harmless).
    const inner = s.slice(1, -1).trim()
    const obj: { [k: string]: YamlValue } = {}
    if (inner === '') return obj
    for (const part of splitFlow(inner)) {
      const kv = splitKeyValue(part)
      if (kv) obj[kv.key] = parseScalar(kv.value)
    }
    return obj
  }
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
    return unquote(s)
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s)
  return s
}

/** Split a flow-collection body on top-level commas (respecting quotes/brackets). */
function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inS = false
  let inD = false
  let cur = ''
  for (const c of inner) {
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    if (!inS && !inD) {
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
      else if (c === ',' && depth === 0) {
        parts.push(cur.trim())
        cur = ''
        continue
      }
    }
    cur += c
  }
  if (cur.trim() !== '') parts.push(cur.trim())
  return parts
}

class Reader {
  private i = 0
  constructor(private lines: Line[]) {}

  private peek(): Line | undefined {
    return this.lines[this.i]
  }

  parse(): YamlValue {
    const first = this.peek()
    if (!first) return null
    return this.parseBlock(first.indent)
  }

  /** Parse either a mapping or a sequence at exactly `indent`. */
  private parseBlock(indent: number): YamlValue {
    const line = this.peek()
    if (!line) return null
    if (line.content.startsWith('-')) return this.parseSequence(indent)
    return this.parseMapping(indent)
  }

  private parseMapping(indent: number): YamlValue {
    const map: { [k: string]: YamlValue } = {}
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]
      if (line.indent < indent) break
      if (line.indent > indent) break // defensive; shouldn't happen for well-formed docs
      if (line.content.startsWith('- ') || line.content === '-') break
      const kv = splitKeyValue(line.content)
      if (!kv) break
      this.i++
      if (kv.value === '' ) {
        map[kv.key] = this.parseChildBlock(indent)
      } else if (kv.value === '>' || kv.value === '>-' || kv.value === '>+' ||
                 kv.value === '|' || kv.value === '|-' || kv.value === '|+') {
        map[kv.key] = this.parseBlockScalar(indent, kv.value)
      } else {
        map[kv.key] = parseScalar(kv.value)
      }
    }
    return map
  }

  private parseSequence(indent: number): YamlValue {
    const items: YamlValue[] = []
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]
      if (line.indent !== indent) break
      if (!(line.content.startsWith('- ') || line.content === '-')) break
      const after = line.content === '-' ? '' : line.content.slice(2)
      const rest = after.replace(/^\s+/, '')
      if (rest === '') {
        // Nested block begins on the following line(s).
        this.i++
        const next = this.peek()
        if (next && next.indent > indent) items.push(this.parseBlock(next.indent))
        else items.push(null)
        continue
      }
      const kv = splitKeyValue(rest)
      if (kv) {
        // The item is a mapping whose first key sits inline after the dash.
        const restCol = indent + (line.content.length - rest.length)
        this.lines[this.i] = { indent: restCol, content: rest }
        items.push(this.parseMapping(restCol))
      } else {
        this.i++
        items.push(parseScalar(rest))
      }
    }
    return items
  }

  /** Value block that follows a `key:` with no inline value. */
  private parseChildBlock(parentIndent: number): YamlValue {
    const next = this.peek()
    if (!next) return null
    if (next.indent > parentIndent) return this.parseBlock(next.indent)
    // A sequence may be indented at the SAME column as its key.
    if (next.indent === parentIndent && (next.content.startsWith('- ') || next.content === '-')) {
      return this.parseSequence(parentIndent)
    }
    return null
  }

  /** Folded (`>`) or literal (`|`) block scalar. */
  private parseBlockScalar(parentIndent: number, marker: string): string {
    const folded = marker[0] === '>'
    const chomp = marker.includes('-') ? 'strip' : marker.includes('+') ? 'keep' : 'clip'
    const parts: string[] = []
    let blockIndent = -1
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]
      if (line.indent <= parentIndent) break
      if (blockIndent === -1) blockIndent = line.indent
      // Re-add indentation beyond the block's base so literal blocks keep shape.
      const extra = line.indent - blockIndent
      parts.push(' '.repeat(Math.max(0, extra)) + line.content)
      this.i++
    }
    let text = folded ? parts.join(' ') : parts.join('\n')
    if (chomp === 'strip') text = text.replace(/\n+$/, '')
    else if (chomp === 'clip') text = text.replace(/\n+$/, '') // block scalars here never need a trailing NL
    return text
  }
}

/** Parse a YAML document string into a JS value. */
export function parseYaml(src: string): YamlValue {
  try {
    return new Reader(scan(src)).parse()
  } catch {
    return null
  }
}
