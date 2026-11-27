/**
 * Argo's `depends` expressions (design 0026 §6.5): parse, print and the three
 * edits the canvas makes to one — add a term, remove a task, rename a task.
 *
 *   depends: "build && (lint.Succeeded || lint.Skipped) && !flaky.Failed"
 *
 * A term is a task name, optionally `.Condition`. A BARE name is not
 * `.Succeeded`: Argo reads it as `(name.Succeeded || name.Skipped ||
 * name.Daemoned)`, so the two are kept apart — the canvas draws both as a
 * success edge, and an edit never rewrites one into the other.
 *
 * Precedence, as Argo's evaluator has it: `!` binds tightest, then `&&`, then
 * `||`. Pure: `depends_test.ts`.
 */

export const CONDITIONS = ['Succeeded', 'Failed', 'Errored', 'Skipped', 'Omitted', 'Daemoned', 'AnySucceeded', 'AllFailed'] as const
export type Condition = typeof CONDITIONS[number]

const CONDITION_SET: ReadonlySet<string> = new Set(CONDITIONS)

export type DependsNode =
  | { type: 'term'; task: string; condition?: Condition; start: number; end: number }
  | { type: 'and'; items: DependsNode[] }
  | { type: 'or'; items: DependsNode[] }
  | { type: 'not'; operand: DependsNode }
  | { type: 'group'; inner: DependsNode }

export interface DependsTerm {
  task: string
  /** Undefined for a bare name. */
  condition?: Condition
  /** Offsets of the task NAME in the source (the condition follows `end`). */
  start: number
  end: number
}

export type DependsParse =
  | { ok: true; ast: DependsNode | null }
  | { ok: false; message: string; offset: number }

const NAME = /[A-Za-z0-9_][A-Za-z0-9_-]*/y

class ParseFail extends Error {
  constructor(message: string, readonly offset: number) {
    super(message)
  }
}

/** Parse a `depends` expression. An empty string is a valid, empty expression (`ast: null`). */
export function parseDepends(src: string): DependsParse {
  let i = 0
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++
  }
  const term = (): DependsNode => {
    ws()
    if (src[i] === '!') {
      i++
      return { type: 'not', operand: term() }
    }
    if (src[i] === '(') {
      const open = i++
      const inner = or()
      ws()
      if (src[i] !== ')') throw new ParseFail('Missing a closing parenthesis.', open)
      i++
      return { type: 'group', inner }
    }
    NAME.lastIndex = i
    const m = NAME.exec(src)
    if (!m) throw new ParseFail(i >= src.length ? 'The expression ends where a task name is expected.' : `Expected a task name, found "${src[i]}".`, i)
    const start = i
    i += m[0].length
    let condition: Condition | undefined
    if (src[i] === '.') {
      const dot = i++
      const c = /[A-Za-z]+/y
      c.lastIndex = i
      const cm = c.exec(src)
      if (!cm || !CONDITION_SET.has(cm[0])) {
        throw new ParseFail(`"${m[0]}.${cm?.[0] ?? ''}" is not a result Argo knows; use one of ${CONDITIONS.join(', ')}.`, dot)
      }
      condition = cm[0] as Condition
      i += cm[0].length
    }
    return { type: 'term', task: m[0], condition, start, end: start + m[0].length }
  }
  const and = (): DependsNode => {
    const items = [term()]
    for (;;) {
      ws()
      if (src.startsWith('&&', i)) {
        i += 2
        items.push(term())
      } else break
    }
    return items.length === 1 ? items[0] : { type: 'and', items }
  }
  function or(): DependsNode {
    const items = [and()]
    for (;;) {
      ws()
      if (src.startsWith('||', i)) {
        i += 2
        items.push(and())
      } else break
    }
    return items.length === 1 ? items[0] : { type: 'or', items }
  }
  try {
    ws()
    if (i >= src.length) return { ok: true, ast: null }
    const ast = or()
    ws()
    if (i < src.length) throw new ParseFail(`Unexpected "${src[i]}"; join terms with && or ||.`, i)
    return { ok: true, ast }
  } catch (e) {
    if (e instanceof ParseFail) return { ok: false, message: e.message, offset: e.offset }
    throw e
  }
}

const printTerm = (t: { task: string; condition?: Condition }) => (t.condition ? `${t.task}.${t.condition}` : t.task)

/** Print an expression; parentheses appear where the source had them or precedence needs them. */
export function printDepends(ast: DependsNode | null): string {
  if (!ast) return ''
  const p = (n: DependsNode, parent: 'or' | 'and' | 'not' | 'top'): string => {
    switch (n.type) {
      case 'term':
        return printTerm(n)
      case 'group':
        return `(${p(n.inner, 'top')})`
      case 'not':
        return `!${p(n.operand, 'not')}`
      case 'and': {
        const s = n.items.map((x) => p(x, 'and')).join(' && ')
        return parent === 'not' ? `(${s})` : s
      }
      case 'or': {
        const s = n.items.map((x) => p(x, 'or')).join(' || ')
        return parent === 'and' || parent === 'not' ? `(${s})` : s
      }
    }
  }
  return p(ast, 'top')
}

/** Every task reference in an expression, in source order. Empty when it does not parse. */
export function dependsTerms(src: string): DependsTerm[] {
  const r = parseDepends(src)
  if (!r.ok || !r.ast) return []
  const out: DependsTerm[] = []
  const walk = (n: DependsNode): void => {
    if (n.type === 'term') out.push({ task: n.task, condition: n.condition, start: n.start, end: n.end })
    else if (n.type === 'group') walk(n.inner)
    else if (n.type === 'not') walk(n.operand)
    else n.items.forEach(walk)
  }
  walk(r.ast)
  return out
}

/**
 * The terms of a PURE conjunction — `a && b.Failed && c`, each task once, no
 * `||`, no `!` — or null. Redundant parentheses do not make an expression
 * impure; a task named twice does, because one edge cannot say two things.
 */
export function conjunctionTerms(src: string): DependsTerm[] | null {
  const r = parseDepends(src)
  if (!r.ok) return null
  if (!r.ast) return []
  const out: DependsTerm[] = []
  const walk = (n: DependsNode): boolean => {
    if (n.type === 'term') {
      out.push({ task: n.task, condition: n.condition, start: n.start, end: n.end })
      return true
    }
    if (n.type === 'group') return walk(n.inner)
    if (n.type === 'and') return n.items.every(walk)
    return false
  }
  if (!walk(r.ast)) return null
  return new Set(out.map((t) => t.task)).size === out.length ? out : null
}

/** Legacy `dependencies: [a, b]` as the `depends` that means the same. */
export function fromDependencies(list: readonly string[]): string {
  return list.join(' && ')
}

/**
 * Add `task` (with `condition`, or bare) to a conjunction with `&&`. `index`
 * places it among the top-level terms (the inverse of a removal); otherwise it
 * goes last. An expression with `||` at the top is wrapped first, so the new
 * term constrains the whole of it.
 */
export function addTerm(src: string, task: string, condition?: Condition, index?: number): string {
  const term = printTerm({ task, condition })
  const r = parseDepends(src)
  if (!r.ok) throw new Error(`depends does not parse: ${r.message}`)
  if (!r.ast) return term
  const items = r.ast.type === 'and' ? [...r.ast.items] : [r.ast.type === 'or' ? ({ type: 'group', inner: r.ast } as DependsNode) : r.ast]
  const at = index === undefined || index < 0 || index > items.length ? items.length : index
  items.splice(at, 0, { type: 'term', task, condition, start: 0, end: 0 })
  return printDepends({ type: 'and', items })
}

/**
 * Remove every reference to `task`. Returns the remaining expression, or
 * undefined when nothing is left (the caller drops `depends`). Also reports
 * where the first reference sat among the top-level `&&` terms, so the removal
 * can be undone in place.
 */
export function removeTask(src: string, task: string): { depends: string | undefined; index: number; term?: DependsTerm } {
  const r = parseDepends(src)
  if (!r.ok) throw new Error(`depends does not parse: ${r.message}`)
  if (!r.ast) return { depends: undefined, index: -1 }
  let first: DependsTerm | undefined
  const strip = (n: DependsNode): DependsNode | null => {
    switch (n.type) {
      case 'term':
        if (n.task !== task) return n
        first ??= { task: n.task, condition: n.condition, start: n.start, end: n.end }
        return null
      case 'group': {
        const inner = strip(n.inner)
        if (!inner) return null
        // Parentheses around a single term or another group say nothing.
        return inner.type === 'term' || inner.type === 'group' ? inner : { type: 'group', inner }
      }
      case 'not': {
        const operand = strip(n.operand)
        return operand ? { type: 'not', operand } : null
      }
      default: {
        const items = n.items.map(strip).filter((x): x is DependsNode => x !== null)
        if (!items.length) return null
        return items.length === 1 ? items[0] : { type: n.type, items }
      }
    }
  }
  const top = r.ast.type === 'and' ? r.ast.items : [r.ast]
  const index = top.findIndex((n) => n.type === 'term' && n.task === task)
  let ast = strip(r.ast)
  // `(a || b)` left alone at the top needs no parentheses.
  if (ast?.type === 'group') ast = ast.inner
  return { depends: ast ? printDepends(ast) : undefined, index, term: first }
}

/** Rename a task in place: only the name's own characters change, so spacing and parentheses survive. */
export function renameTask(src: string, from: string, to: string): string {
  const terms = dependsTerms(src).filter((t) => t.task === from)
  let out = src
  for (const t of terms.reverse()) out = out.slice(0, t.start) + to + out.slice(t.end)
  return out
}

/** Set the condition of `task`'s references (undefined makes them bare). */
export function setCondition(src: string, task: string, condition: Condition | undefined): string {
  const r = parseDepends(src)
  if (!r.ok || !r.ast) return src
  const walk = (n: DependsNode): DependsNode => {
    if (n.type === 'term') return n.task === task ? { ...n, condition } : n
    if (n.type === 'group') return { type: 'group', inner: walk(n.inner) }
    if (n.type === 'not') return { type: 'not', operand: walk(n.operand) }
    return { type: n.type, items: n.items.map(walk) }
  }
  return printDepends(walk(r.ast))
}
