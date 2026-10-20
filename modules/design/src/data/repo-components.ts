/**
 * A project's own UI components, discovered from its repositories (best
 * effort, cached): the repo tree is listed once, component-looking files under
 * `components/` are read (capped), and their exported PascalCase names become
 * catalog entries with a source link. Parsing is lexical — no code is run.
 */

/** Files that look like UI component modules. */
export function isComponentFile(path: string): boolean {
  if (!/\.(tsx|jsx)$/.test(path)) return false
  if (/(^|\/)(node_modules|dist|build|\.next|coverage)\//.test(path)) return false
  if (/\.(test|spec|stories|story)\.(tsx|jsx)$/.test(path) || /(^|\/)__tests__\//.test(path)) return false
  return /(^|\/)components\//.test(path)
}

const PASCAL = /^[A-Z][A-Za-z0-9]*$/

/** Exported component names in a module's source (pure). */
export function parseComponentExports(src: string, fileName = ''): string[] {
  // Strip comments so commented-out exports don't count.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const names = new Set<string>()
  const add = (n: string | undefined) => {
    if (n && PASCAL.test(n)) names.add(n)
  }
  for (const m of code.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/g)) add(m[1])
  for (const m of code.matchAll(/export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of code.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().replace(/^type\s+/, '')
      if (!seg || part.trim().startsWith('type ')) continue
      const [orig, alias] = seg.split(/\s+as\s+/).map((s) => s.trim())
      add(alias && alias !== 'default' ? alias : orig)
    }
  }
  // `export default Foo` / `export default memo(Foo)` / anonymous default → file name.
  const def = code.match(/export\s+default\s+(?:React\.)?(?:memo|forwardRef)?\(?\s*([A-Za-z_$][\w$]*)?/)
  if (def) {
    if (def[1] && PASCAL.test(def[1])) add(def[1])
    else if (/export\s+default\s+(?:\(|function\s*\(|\w+\s*=>)/.test(code)) {
      const base = fileName.split('/').pop()?.replace(/\.(tsx|jsx)$/, '') ?? ''
      const pascal = base.replace(/(^|[-_.])(\w)/g, (_, __, c: string) => c.toUpperCase())
      if (pascal && pascal !== 'Index') add(pascal)
    }
  }
  return [...names].sort()
}

/** Count `<Name` JSX usages of each of `names` in a source text (pure). */
export function countJsxUsage(src: string, names: string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const n of names) {
    const re = new RegExp(`<${n}[\\s/>]`, 'g')
    const hits = src.match(re)?.length ?? 0
    if (hits) out.set(n, hits)
  }
  return out
}
