import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { parse } from '@babel/parser'
import type { ParseFn } from './ast.ts'
import { computeChanges, DESIGNER_META, findConflicts, openRepo, type RepoApi } from './repo-session.ts'
import { DEMO_REPO, fakeSha } from './fixtures.ts'
import { addFileToFolder, findFileInTree, type CanvasNode } from '../lib/builder-types.ts'
import { makeSymbol, newPage, SYMBOLS_FOLDER } from '../lib/studio.ts'
import { importPage } from './jsx-import.ts'
import { detectFramework } from './framework.ts'
import { diffLines, diffStats, hunks } from './line-diff.ts'
import { scopeCss, toTailwindInput } from './css-theme.ts'
import { addReactRoute, nextPages, reactRouterPages } from './routes.ts'

const P = parse as unknown as ParseFn

function api(files: Record<string, string>): RepoApi {
  return {
    tree: () => Promise.resolve({ entries: Object.keys(files).map((p) => ({ path: p, sha: fakeSha(files[p]) })), truncated: false }),
    read: (p) => (p in files ? Promise.resolve({ content: files[p], sha: fakeSha(files[p]) }) : Promise.reject(new Error('404'))),
  }
}

function find(nodes: CanvasNode[], pred: (n: CanvasNode) => boolean): CanvasNode | undefined {
  for (const n of nodes) {
    if (pred(n)) return n
    const hit = find(n.children, pred)
    if (hit) return hit
  }
  return undefined
}

Deno.test('open: framework, routes (nested, index, alias, named export), pages imported', async () => {
  const { session, project } = await openRepo(api(DEMO_REPO), P, 'acme-portal', 'main')
  assertEquals(session.framework.id, 'vite-react')
  assert(session.framework.tailwind && session.framework.tailwindVersion === 4)
  assertEquals(session.routerFile, 'src/App.tsx')
  assertEquals(session.pages.map((p) => [p.route, p.path, p.exportName ?? '']), [
    ['/', 'src/pages/Home.tsx', ''], ['/customers', 'src/pages/Customers.tsx', ''], ['/settings', 'src/pages/Settings.tsx', 'Settings'],
  ])
  assert(session.pages.every((p) => p.imported.ok))
  assertEquals(session.appCss?.path, 'src/index.css')
  const home = findFileInTree(project.files, 'pg:src/pages/Home.tsx')!
  assert(home.home)
  // <Link to="/customers"> drives navigation in the prototype.
  const link = find(home.nodes!, (n) => n.type === 'link' && n.props.to === '/customers')!
  assertEquals(link.interactions?.[0].targetPageId, 'pg:src/pages/Customers.tsx')
  // The data file is offered as a data source.
  assert(findFileInTree(project.files, 'data:src/data/customers.json'))
})

Deno.test('changes: nothing edited → no changes at all', async () => {
  const { session, project } = await openRepo(api(DEMO_REPO), P, 'acme-portal', 'main')
  assertEquals(computeChanges(session, project, P).changes, [])
})

Deno.test('changes: edit one page → only that file, untouched lines preserved, re-import consistent', async () => {
  const { session, project } = await openRepo(api(DEMO_REPO), P, 'acme-portal', 'main')
  const home = findFileInTree(project.files, 'pg:src/pages/Home.tsx')!
  find(home.nodes!, (n) => n.type === 'h1')!.props.children = 'Welcome back to Acme'
  const { changes } = computeChanges(session, project, P)
  assertEquals(changes.map((c) => c.path), ['src/pages/Home.tsx'])
  const after = changes[0].after
  assertStringIncludes(after, '<h1 className="text-4xl font-bold tracking-tight text-slate-900">Welcome back to Acme</h1>')
  assertStringIncludes(after, '// Landing page for signed-in users.')
  assertStringIncludes(after, '<Link to="/customers" className="rounded-[var(--radius-card)] bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground">View customers</Link>')
  const d = diffLines(changes[0].before!, after)
  assertEquals(diffStats(d), { added: 1, removed: 1 })
  assertEquals(hunks(d).length, 1)
  const again = importPage(P, after, 'src/pages/Home.tsx')
  assertEquals(find(again.nodes, (n) => n.type === 'h1')!.props.children, 'Welcome back to Acme')
})

Deno.test('changes: the .map() list and clsx are preserved verbatim when siblings change', async () => {
  const { session, project } = await openRepo(api(DEMO_REPO), P, 'acme-portal', 'main')
  const page = findFileInTree(project.files, 'pg:src/pages/Customers.tsx')!
  const section = page.nodes![0]
  section.children.push({ id: 'n1', type: 'p', props: { className: 'mt-4 text-xs text-slate-500', children: 'Showing everyone' }, children: [], style: {} })
  const { changes } = computeChanges(session, project, P)
  const after = changes.find((c) => c.path === 'src/pages/Customers.tsx')!.after
  assertStringIncludes(after, "<li key={c.id} className={clsx('flex justify-between px-4 py-3 text-sm', c.status === 'Paused' && 'opacity-60')}>")
  assertStringIncludes(after, '<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customers…" className="mt-6 w-full max-w-sm rounded-lg border px-3 py-2 text-sm" />')
  assertStringIncludes(after, '<p className="mt-4 text-xs text-slate-500">Showing everyone</p>')
  assertStringIncludes(after, "const rows = customers.filter(")
})

Deno.test('changes: new page → file in the repo style + route + import wired', async () => {
  const { session, project } = await openRepo(api(DEMO_REPO), P, 'acme-portal', 'main')
  const page = { ...newPage('Billing'), nodes: [{ id: 'b', type: 'h1', props: { className: 'text-2xl font-bold', children: 'Billing' }, children: [], style: {},
    interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: 'pg:src/pages/Home.tsx' }] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  const { changes } = computeChanges(session, project, P)
  const created = changes.find((c) => c.path === 'src/pages/Billing.tsx')!
  assertEquals(created.before, null)
  assertStringIncludes(created.after, "import { useNavigate } from 'react-router-dom'")
  assertStringIncludes(created.after, 'export default function Billing() {\n  const navigate = useNavigate()')
  assertStringIncludes(created.after, 'onClick={() => navigate("/")}')
  const app = changes.find((c) => c.path === 'src/App.tsx')!.after
  assertStringIncludes(app, "import Billing from './pages/Billing'")
  assertStringIncludes(app, '<Route path="settings" element={<Settings />} />\n          <Route path="/billing" element={<Billing />} />')
  assert(importPage(P, created.after, created.path).ok)
})

Deno.test('changes: designer components become files + imports, and re-link on reopen', async () => {
  const files = { ...DEMO_REPO }
  const first = await openRepo(api(files), P, 'acme-portal', 'main')
  const home = findFileInTree(first.project.files, 'pg:src/pages/Home.tsx')!
  const h1 = find(home.nodes!, (n) => n.type === 'h1')!
  const { symbol, instance } = makeSymbol(h1, 'Hero title')
  const main = home.nodes![0]
  main.children = main.children.map((c) => (c.id === h1.id ? instance : c))
  first.project.files = addFileToFolder(first.project.files, SYMBOLS_FOLDER, symbol)
  const { changes } = computeChanges(first.session, first.project, P)
  const paths = changes.map((c) => c.path).sort()
  assertEquals(paths, [DESIGNER_META, 'src/components/HeroTitle.tsx', 'src/pages/Home.tsx'])
  const homeAfter = changes.find((c) => c.path === 'src/pages/Home.tsx')!.after
  assertStringIncludes(homeAfter, "import HeroTitle from '../components/HeroTitle'")
  assertStringIncludes(homeAfter, '<HeroTitle />')
  // Commit, reopen: the component is editable again and the page links to it.
  for (const c of changes) files[c.path] = c.after
  const second = await openRepo(api(files), P, 'acme-portal', 'main')
  const sym = findFileInTree(second.project.files, 'sym:src/components/HeroTitle.tsx')!
  assert(sym.symbol)
  assertEquals(sym.nodes![0].props.children, 'Welcome to Acme')
  const home2 = findFileInTree(second.project.files, 'pg:src/pages/Home.tsx')!
  assert(find(home2.nodes!, (n) => n.type === 'symbol' && n.props.symbolId === sym.id))
  assertEquals(computeChanges(second.session, second.project, P).changes, [])
})

Deno.test('conflicts: a file changed upstream is reported', async () => {
  const files = { ...DEMO_REPO }
  const { session, project } = await openRepo(api(files), P, 'acme-portal', 'main')
  find(findFileInTree(project.files, 'pg:src/pages/Home.tsx')!.nodes!, (n) => n.type === 'h1')!.props.children = 'x'
  const { changes } = computeChanges(session, project, P)
  assertEquals(await findConflicts(api(files), changes, 'main'), [])
  files['src/pages/Home.tsx'] += '\n// someone else\n'
  assertEquals(await findConflicts(api(files), changes, 'main'), ['src/pages/Home.tsx'])
})

Deno.test('framework detection', () => {
  const fw = (deps: Record<string, string>, paths: string[] = []) => detectFramework(JSON.stringify({ dependencies: deps }), paths)
  assertEquals(fw({ next: '15', react: '19' }, ['app/page.tsx']).router, 'next-app')
  assertEquals(fw({ next: '15', react: '19' }, ['pages/index.tsx']).router, 'next-pages')
  assertEquals(fw({ '@remix-run/react': '2', react: '18' }).id, 'remix')
  assertEquals(fw({ react: '18' }).id, 'react')
  assertEquals(detectFramework(null, ['index.html']).id, 'html')
  assertEquals(detectFramework(JSON.stringify({ dependencies: { react: '18', vite: '5', tailwindcss: '3.4.0' } }), []).tailwindVersion, 3)
})

Deno.test('routes: Next app router, object-form React Router, route insertion', () => {
  const fw = detectFramework(JSON.stringify({ dependencies: { next: '15' } }), ['app/page.tsx'])
  assertEquals(nextPages(fw, ['app/page.tsx', 'app/(marketing)/pricing/page.tsx', 'app/blog/[slug]/page.tsx', 'app/layout.tsx']).map((p) => p.route), ['/', '/blog/:slug', '/pricing'])
  const code = `import { createBrowserRouter } from 'react-router-dom'\nimport Home from './Home'\nimport About from './About'\n\nexport const router = createBrowserRouter([\n  { path: '/', element: <Home />, children: [\n    { path: 'about', element: <About /> },\n  ] },\n])\n`
  const pages = reactRouterPages(P, code, 'src/router.tsx', ['src/router.tsx', 'src/Home.tsx', 'src/About.tsx'])
  assertEquals(pages.map((p) => [p.route, p.path]), [['/', 'src/Home.tsx'], ['/about', 'src/About.tsx']])
  const next = addReactRoute(P, code, 'src/router.tsx', '/contact', 'Contact', './pages/Contact')!
  assertStringIncludes(next, "{ path: 'about', element: <About /> },\n    { path: \"/contact\", element: <Contact /> },")
  assertStringIncludes(next, "import Contact from './pages/Contact'")
  assert(reactRouterPages(P, next, 'src/router.tsx', ['src/router.tsx', 'src/Home.tsx', 'src/About.tsx', 'src/pages/Contact.tsx']).some((p) => p.route === '/contact'))
})

Deno.test('css: v3 + shadcn vars → v4 input; scoped output', () => {
  const v3 = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n:root { --primary: 222 47% 11%; --radius: 0.5rem; }\n`
  const input = toTailwindInput(v3)
  assertStringIncludes(input, '@import "tailwindcss";')
  assertStringIncludes(input, '--color-primary: hsl(var(--primary));')
  const scoped = scopeCss(`@layer theme{:root,:host{--color-brand:red}}@layer utilities{.bg-brand{background:var(--color-brand)}@media (min-width:40rem){.sm\\:p-4{padding:1rem}}}@property --x{syntax:'*';inherits:false}`)
  assertStringIncludes(scoped, "@property --x{syntax:'*';inherits:false}")
  assertStringIncludes(scoped, '.adhar-repo-canvas{')
  assertStringIncludes(scoped, '&{--color-brand:red}')
  assertStringIncludes(scoped, '.bg-brand{background:var(--color-brand)}')
  assert(!scoped.includes('@layer'))
})
