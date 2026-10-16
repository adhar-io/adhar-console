import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { generateReactApp, pascal } from './react-export.ts'
import { createStarterProject } from './starters.ts'
import { studioFiles } from './project.ts'
import { DEFAULT_SETTINGS } from './project.ts'
import type { BuilderProject } from '../types.ts'

const byPath = (files: { path: string; content: string }[]) => Object.fromEntries(files.map((f) => [f.path, f.content]))

Deno.test('CRUD starter exports a runnable multi-page React app', () => {
  const app = byPath(generateReactApp(createStarterProject({ name: 'Acme Admin', starter: 'crud' })))
  for (const p of ['package.json', 'vite.config.ts', 'index.html', 'tsconfig.json', 'src/main.tsx', 'src/App.tsx', 'src/index.css',
    'src/pages/Customers.tsx', 'src/pages/NewCustomer.tsx', 'src/components/AppSidebar.tsx', 'src/data/customers.json']) {
    assert(app[p] !== undefined, `missing ${p}`)
  }
  const pkg = JSON.parse(app['package.json'])
  assertEquals(pkg.name, 'acme-admin')
  assert(pkg.dependencies['react-router-dom'])

  // Routes for every page + fallback to home.
  assertStringIncludes(app['src/App.tsx'], '<Route path="/" element={<Customers />} />')
  assertStringIncludes(app['src/App.tsx'], '<Route path="/customers/new" element={<NewCustomer />} />')
  assertStringIncludes(app['src/App.tsx'], '<Navigate to="/" replace />')

  const list = app['src/pages/Customers.tsx']
  // Component instance → import + element.
  assertStringIncludes(list, "import AppSidebar from '../components/AppSidebar.tsx'")
  assertStringIncludes(list, '<AppSidebar />')
  // Repeater → map over imported JSON with templates.
  assertStringIncludes(list, "import customers from '../data/customers.json'")
  assertStringIncludes(list, '(customers as any[]).map((item: any, i: number) => (')
  assertStringIncludes(list, "{String(item?.email ?? '')}")
  // Navigate → router; toggle → page state, modal starts hidden.
  assertStringIncludes(list, "navigate(\"/customers/new\")")
  assertStringIncludes(list, 'const [hidden, setHidden] = useState<Record<string, boolean>>({"')
  assertStringIncludes(list, 'onClick={() => toggle(')

  const form = app['src/pages/NewCustomer.tsx']
  assertStringIncludes(form, '<input type="email"')
  assertStringIncludes(form, ' required />')
  assertStringIncludes(form, '<option>Enterprise</option>')

  // Theme → Tailwind v4 CSS variables.
  assertStringIncludes(app['src/index.css'], '@import "tailwindcss";')
  assertStringIncludes(app['src/index.css'], '--color-primary: hsl(var(--primary));')
})

Deno.test('JSX text and attributes are escaped', () => {
  const project: BuilderProject = {
    version: 1, name: 'x', settings: { ...DEFAULT_SETTINGS },
    files: studioFiles().map((f) => ({ ...f, children: f.children?.map((c) => c.id === 'f_pages'
      ? { ...c, children: [{ ...c.children![0], nodes: [{ id: 'a', type: 'p', props: { className: 'say "hi"', children: 'a < b {c}' }, children: [], style: {} }] }] }
      : c) })),
  }
  const page = byPath(generateReactApp(project))['src/pages/Home.tsx']
  assertStringIncludes(page, '{"a < b {c}"}')
  assertStringIncludes(page, 'className={"say \\"hi\\""}')
})

Deno.test('names become valid identifiers', () => {
  assertEquals(pascal('new-customer.tsx'), 'NewCustomer')
  assertEquals(pascal('404.tsx'), 'Page404')
  assertEquals(pascal('***'), 'Page')
})
