import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { parse } from '@babel/parser'
import { importPage, unchanged } from './jsx-import.ts'
import { splicePage } from './jsx-print.ts'
import { detectFramework } from './framework.ts'
import type { ParseFn } from './ast.ts'
import type { CanvasNode } from '../lib/builder-types.ts'

const P = parse as unknown as ParseFn
const FW = detectFramework(JSON.stringify({ dependencies: { react: '19', 'react-router-dom': '7' }, devDependencies: { vite: '7', tailwindcss: '4', typescript: '5' } }), ['src/App.tsx'])
const ctx = { framework: FW, filePath: 'src/pages/Home.tsx', routes: { p_about: '/about' }, symbols: {}, data: {} }

const SRC = `import { useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../lib/utils'
import Card from '../components/Card'

// A page with a bit of everything.
export default function Home({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <main className="mx-auto max-w-4xl p-8">
      {/* hero */}
      <h1 className="text-3xl font-bold">Welcome back</h1>
      <p className={cn('text-muted', open && 'hidden')}>
        Hello {items.length} times &amp; more
      </p>
      <Link to="/about" className="text-primary">About us</Link>
      <Card title="Stats">
        <span>inside a custom component</span>
      </Card>
      <ul>
        {items.map((it) => <li key={it} className="py-1">{it}</li>)}
      </ul>
      {open ? <span>Open</span> : null}
      <button onClick={() => setOpen(!open)} className="btn" type="button">Toggle</button>
    </main>
  )
}
`

function find(nodes: CanvasNode[], pred: (n: CanvasNode) => boolean): CanvasNode | undefined {
  for (const n of nodes) {
    if (pred(n)) return n
    const hit = find(n.children, pred)
    if (hit) return hit
  }
  return undefined
}

Deno.test('import: editable vs preserved', () => {
  const r = importPage(P, SRC, 'src/pages/Home.tsx', { routes: { '/about': 'p_about' } })
  assert(r.ok, r.reason)
  const main = r.nodes[0]
  assertEquals(main.type, 'main')
  assertEquals(main.props.className, 'mx-auto max-w-4xl p-8')
  const h1 = find(r.nodes, (n) => n.type === 'h1')!
  assertEquals(h1.props.children, 'Welcome back')
  const p = find(r.nodes, (n) => n.type === 'p')!
  assertEquals(p.props.classExpr, "cn('text-muted', open && 'hidden')")
  assertEquals(p.props.className, 'text-muted')
  assertEquals(p.children.map((c) => c.type), ['text', 'code', 'text'])
  assertEquals(p.children[2].props.children, ' times & more')
  const link = find(r.nodes, (n) => n.type === 'link')!
  assertEquals(link.interactions?.[0].targetPageId, 'p_about')
  const card = find(r.nodes, (n) => n.type === 'code' && String(n.props.code).startsWith('<Card'))!
  assert(Array.isArray(card.props.preview))
  const map = find(r.nodes, (n) => n.type === 'code' && String(n.props.code).includes('items.map'))!
  assertEquals((map.props.preview as CanvasNode[])[0].type, 'li')
  const btn = find(r.nodes, (n) => n.type === 'button')!
  assertEquals(btn.props.rawAttrs, ['onClick={() => setOpen(!open)}', 'type="button"'])
  assert(r.nodes.every(unchanged))
})

Deno.test('splice: untouched page is byte-identical', () => {
  const r = importPage(P, SRC, 'src/pages/Home.tsx')
  assertEquals(splicePage(SRC, r.region!, r.nodes, ctx), SRC)
})

Deno.test('splice: edit text, keep everything else verbatim, re-import equals', () => {
  const r = importPage(P, SRC, 'src/pages/Home.tsx')
  const h1 = find(r.nodes, (n) => n.type === 'h1')!
  h1.props.children = 'Hi <there>'
  const out = splicePage(SRC, r.region!, r.nodes, ctx)
  assertStringIncludes(out, '<h1 className="text-3xl font-bold">{"Hi <there>"}</h1>')
  // Everything outside the edited element survives byte-for-byte.
  for (const keep of ["{/* hero */}", "<p className={cn('text-muted', open && 'hidden')}>\n        Hello {items.length} times &amp; more\n      </p>",
    '{items.map((it) => <li key={it} className="py-1">{it}</li>)}', '<button onClick={() => setOpen(!open)} className="btn" type="button">Toggle</button>',
    "// A page with a bit of everything.", "const [open, setOpen] = useState(false)"]) assertStringIncludes(out, keep)
  const again = importPage(P, out, 'src/pages/Home.tsx')
  assert(again.ok)
  assertEquals(find(again.nodes, (n) => n.type === 'h1')!.props.children, 'Hi <there>')
  // Re-splicing the re-import without edits is a no-op.
  assertEquals(splicePage(out, again.region!, again.nodes, ctx), out)
})

Deno.test('splice: add a node with navigation → hook + imports added', () => {
  const r = importPage(P, SRC, 'src/pages/Home.tsx')
  const main = r.nodes[0]
  main.children.push({ id: 'new', type: 'button', props: { className: 'rounded bg-primary px-4', children: 'Go' }, children: [], style: {},
    interactions: [{ trigger: 'click', action: 'navigate', targetPageId: 'p_about' }] })
  const out = splicePage(SRC, r.region!, r.nodes, ctx)
  assertStringIncludes(out, `<button className="rounded bg-primary px-4" onClick={() => navigate("/about")}>Go</button>`)
  assertStringIncludes(out, "import { useNavigate } from 'react-router-dom'")
  assertStringIncludes(out, "export default function Home({ items }: { items: string[] }) {\n  const navigate = useNavigate()\n  const [open")
  // Untouched siblings verbatim.
  assertStringIncludes(out, '<Card title="Stats">\n        <span>inside a custom component</span>\n      </Card>')
  const again = importPage(P, out, 'src/pages/Home.tsx')
  assert(again.ok)
  assertEquals(splicePage(out, again.region!, again.nodes, ctx), out)
})

Deno.test('splice: reorder and delete', () => {
  const r = importPage(P, SRC, 'src/pages/Home.tsx')
  const main = r.nodes[0]
  main.children = main.children.filter((c) => c.type !== 'button').reverse()
  const out = splicePage(SRC, r.region!, r.nodes, ctx)
  assert(!out.includes('Toggle</button>'))
  assert(out.indexOf('<Card') < out.indexOf('<h1'))
  assert(importPage(P, out, 'src/pages/Home.tsx').ok)
})

Deno.test('import: arrow components, memo, named exports, no JSX', () => {
  assert(importPage(P, `const A = () => <div className="x">hi</div>\nexport default A\n`, 'a.tsx').ok)
  assert(importPage(P, `import { memo } from 'react'\nexport default memo(function B() { return <section /> })\n`, 'b.tsx').ok)
  assert(importPage(P, `export function Pricing() { return (<div>p</div>) }\n`, 'c.jsx').ok)
  assertEquals(importPage(P, `export const x = 1\n`, 'd.ts').ok, false)
  assertEquals(importPage(P, `export default function E() { return null }\n`, 'e.tsx').ok, false)
})
