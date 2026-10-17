/**
 * Thin, typed access to a Babel AST — just what the importer, printer and
 * route discovery need. The parser itself is injected (`ParseFn`) so the pure
 * code is testable and `@babel/parser` stays a lazy chunk in the browser.
 */

// deno-lint-ignore no-explicit-any
export type Node = any

export type ParseFn = (code: string, opts: { sourceType: 'module'; plugins: string[]; errorRecovery?: boolean }) => Node

export function pluginsFor(path: string): string[] {
  if (/\.tsx$/.test(path)) return ['jsx', 'typescript']
  if (/\.ts$/.test(path)) return ['typescript']
  return ['jsx']
}

export function parseModule(parse: ParseFn, code: string, path: string): Node {
  return parse(code, { sourceType: 'module', plugins: pluginsFor(path), errorRecovery: true })
}

/** Depth-first walk; return `false` from `visit` to skip a node's children. */
export function walk(node: Node, visit: (n: Node, parent: Node | null) => boolean | void, parent: Node | null = null): void {
  if (!node || typeof node.type !== 'string') return
  if (visit(node, parent) === false) return
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
    const v = node[key]
    if (Array.isArray(v)) for (const c of v) walk(c, visit, node)
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, visit, node)
  }
}

export function jsxName(n: Node): string {
  if (!n) return ''
  if (n.type === 'JSXIdentifier') return n.name
  if (n.type === 'JSXMemberExpression') return `${jsxName(n.object)}.${jsxName(n.property)}`
  if (n.type === 'JSXNamespacedName') return `${n.namespace.name}:${n.name.name}`
  return ''
}

export function attrName(a: Node): string {
  return a.type === 'JSXAttribute' ? jsxName(a.name) : ''
}

/** A static string value of a JSX attribute (`a="x"`, `a={'x'}`, `` a={`x`} `` without expressions). */
export function staticString(value: Node): string | null {
  if (!value) return null
  if (value.type === 'StringLiteral') return value.value
  if (value.type === 'JSXExpressionContainer') {
    const e = value.expression
    if (e.type === 'StringLiteral') return e.value
    if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return e.quasis.map((q: Node) => q.value.cooked).join('')
  }
  return null
}

export interface ImportDecl {
  local: string
  source: string
  isDefault: boolean
  start: number
  end: number
}

export function importsOf(program: Node): ImportDecl[] {
  const out: ImportDecl[] = []
  for (const st of program.body) {
    if (st.type !== 'ImportDeclaration') continue
    for (const sp of st.specifiers) {
      out.push({ local: sp.local.name, source: st.source.value, isDefault: sp.type === 'ImportDefaultSpecifier', start: st.start, end: st.end })
    }
  }
  return out
}

/** Where to insert a new import line: after the last import (or at the top, after directives). */
export function importInsertOffset(program: Node, code: string): number {
  let at = 0
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration') at = st.end
  }
  if (at === 0 && program.directives?.length) at = program.directives[program.directives.length - 1].end
  if (at > 0) {
    const nl = code.indexOf('\n', at)
    return nl === -1 ? code.length : nl + 1
  }
  return 0
}
