import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { dirname, fromFileUrl, join, resolve } from 'jsr:@std/path@^1.0.0'

/**
 * W1 acceptance 5 (design 0026 §6.8, §15): the Workflows overview — and the
 * Home chunk that lazy-loads it — must not contain @xyflow.
 *
 * Rollup puts into a chunk exactly the modules its entry reaches through
 * STATIC imports; a module reached only through `import()` gets a chunk of its
 * own. So "the overview chunk has no @xyflow" is the statement "no chain of
 * static imports leads from the overview to @xyflow", and that is what this
 * walks: real source, every static `import`/`export … from`, through the
 * workspace's `@adhar/*` aliases, skipping `import type` (erased) and
 * `import()` (split). A positive control proves the walker does see React
 * Flow where it is meant to be — the canvas.
 */

const HERE = dirname(fromFileUrl(import.meta.url))
const SRC = resolve(HERE, '..')
const ROOT = resolve(SRC, '../../..')

const rootImports: Record<string, string> = JSON.parse(await Deno.readTextFile(join(ROOT, 'deno.json'))).imports ?? {}

function aliasTarget(spec: string): string | undefined {
  if (rootImports[spec] && rootImports[spec].startsWith('./')) return join(ROOT, rootImports[spec])
  return undefined
}

const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

async function exists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile
  } catch {
    return false
  }
}

async function resolveFile(base: string): Promise<string | undefined> {
  for (const e of EXTS) if (await exists(base + e)) return base + e
  return undefined
}

/** Static runtime imports of one module (type-only imports and `import()` excluded). */
export function staticImports(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const out: string[] = []
  const re = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g
  for (const m of code.matchAll(re)) {
    if (m[2]) continue // `import type … from` / `export type … from`
    if (m[1] === 'export' && !/from\s+['"]/.test(m[0])) continue
    out.push(m[3])
  }
  return out
}

/** Every bare specifier (package) statically reachable from `entry`, with one path to it. */
async function closure(entry: string): Promise<Map<string, string[]>> {
  const bare = new Map<string, string[]>()
  const seen = new Set<string>()
  const queue: Array<{ file: string; path: string[] }> = [{ file: entry, path: [entry] }]
  while (queue.length) {
    const { file, path } = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    let text: string
    try {
      text = await Deno.readTextFile(file)
    } catch {
      continue
    }
    for (const spec of staticImports(text)) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const f = await resolveFile(resolve(dirname(file), spec.replace(/\?.*$/, '')))
        if (f) queue.push({ file: f, path: [...path, f] })
        continue
      }
      const alias = aliasTarget(spec)
      if (alias) {
        const f = await resolveFile(alias)
        if (f) queue.push({ file: f, path: [...path, f] })
        continue
      }
      if (!bare.has(spec)) bare.set(spec, [...path, spec])
    }
  }
  return bare
}

const rel = (p: string) => p.replace(`${ROOT}/`, '')

function xyflowIn(bare: Map<string, string[]>): string[] | undefined {
  for (const [spec, path] of bare) if (spec.startsWith('@xyflow')) return path.map(rel)
  return undefined
}

Deno.test('the import scanner reads static imports and skips type-only and dynamic ones', () => {
  const src = `
import { a } from './a.ts'
import type { B } from './b.ts'
import './side.css'
export { c } from './c.ts'
export type { D } from './d.ts'
const L = lazy(() => import('./lazy.tsx'))
// import { x } from './commented.ts'
import {
  e,
  type F,
} from '@scope/e'
`
  assertEquals(staticImports(src), ['./a.ts', './side.css', './c.ts', '@scope/e'])
})

Deno.test('positive control: the workflow canvas does reach @xyflow', async () => {
  const bare = await closure(join(SRC, 'workflows/canvas/workflow-canvas.tsx'))
  assert(xyflowIn(bare), 'the walker should see @xyflow/react from the canvas — if not, it is blind and the tests below prove nothing')
})

Deno.test('positive control: the designer canvas does reach @xyflow, and the designer does reach yaml', async () => {
  assert(xyflowIn(await closure(join(SRC, 'workflows/canvas/designer-canvas.tsx'))), 'the walker should see @xyflow/react from the designer canvas')
  assert(yamlIn(await closure(join(SRC, 'workflows/views/designer.tsx'))), 'the walker should see yaml from the designer — if not, the yaml checks below prove nothing')
})

/**
 * W2: the designer page, its palette, inspector, YAML panel and test-run
 * dialog carry no @xyflow — the designer loads its canvas with React.lazy
 * once a document is open (design 0026 §6.8 "lazy designer and run graph
 * chunks").
 */
for (const entry of ['workflows/views/designer.tsx', 'workflows/views/test-run-dialog.tsx', 'workflows/canvas/palette.tsx', 'workflows/canvas/inspector.tsx', 'workflows/canvas/yaml-panel.tsx']) {
  Deno.test(`${entry} does not statically reach @xyflow (W2)`, async () => {
    const path = xyflowIn(await closure(join(SRC, entry)))
    assertEquals(path, undefined, `@xyflow reached through:\n  ${(path ?? []).join('\n  → ')}\nLoad the canvas with React.lazy instead.`)
  })
}

/** Only the two canvases import React Flow directly; anything else that needs it is a canvas too and belongs behind a lazy import. */
Deno.test('only the run canvas and the designer canvas import @xyflow directly', async () => {
  const direct: string[] = []
  for await (const f of walkFiles(join(SRC, 'workflows'))) {
    if (!/\.tsx?$/.test(f) || /_test\.tsx?$/.test(f)) continue
    if (staticImports(await Deno.readTextFile(f)).some((s) => s.startsWith('@xyflow'))) direct.push(rel(f))
  }
  assertEquals(direct.sort(), ['modules/platform/src/workflows/canvas/designer-canvas.tsx', 'modules/platform/src/workflows/canvas/workflow-canvas.tsx'])
})

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name)
    if (e.isDirectory) yield* walkFiles(p)
    else if (e.isFile) yield p
  }
}

function yamlIn(bare: Map<string, string[]>): string[] | undefined {
  for (const [spec, path] of bare) if (spec === 'yaml' || spec.startsWith('npm:yaml')) return path.map(rel)
  return undefined
}

for (const entry of ['workflows/views/overview.tsx', 'workflows/area.tsx', 'home.tsx']) {
  Deno.test(`${entry} does not statically reach the designer's yaml model (W2)`, async () => {
    const path = yamlIn(await closure(join(SRC, entry)))
    assertEquals(path, undefined, `yaml reached through:\n  ${(path ?? []).join('\n  → ')}\nLoad the designer with React.lazy instead.`)
  })
}

for (const entry of ['workflows/views/overview.tsx', 'workflows/area.tsx', 'home.tsx']) {
  Deno.test(`${entry} does not statically reach @xyflow (W1 acceptance 5)`, async () => {
    const path = xyflowIn(await closure(join(SRC, entry)))
    assertEquals(path, undefined, `@xyflow reached through:\n  ${(path ?? []).join('\n  → ')}\nLoad the canvas with React.lazy instead.`)
  })
}
