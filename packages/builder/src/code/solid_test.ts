import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { computeChanges, openRepo } from './repo-session.ts'
import { SOLID_REPO } from './fixtures.ts'
import { detectFramework, isEditable } from './framework.ts'
import { solidStartPages } from './markup-routes.ts'
import { addFileToFolder, findFileInTree } from '../lib/builder-types.ts'
import { newPage } from '../lib/studio.ts'
import { diffLines, diffStats } from './line-diff.ts'
import { all, api, commit, find, P } from './test-helpers.ts'

const HOME = 'pg:src/pages/Home.tsx'

Deno.test('solid: detection (Solid + router, SolidStart file routes)', () => {
  const fw = detectFramework(SOLID_REPO['package.json'], Object.keys(SOLID_REPO))
  assertEquals([fw.id, fw.router, fw.label], ['solid', 'solid-router', 'Solid'])
  assert(isEditable(fw))
  const start = detectFramework(JSON.stringify({ dependencies: { '@solidjs/start': '^1.1.0', 'solid-js': '^1.9.0' } }), [])
  assertEquals([start.id, start.router], ['solid-start', 'solid-start'])
  assertEquals(solidStartPages(start, ['src/routes/index.tsx', 'src/routes/(marketing)/about.tsx', 'src/routes/users/[id].tsx', 'src/routes/api/x.ts']).map((p) => p.route), ['/', '/about', '/users/:id'])
})

Deno.test('solid: JSX router config (incl. lazy) → pages; class, <A href>, Show/For as chips', async () => {
  const { session, project } = await openRepo(api(SOLID_REPO), P, 'acme-solid', 'main')
  assertEquals(session.routerFile, 'src/index.tsx')
  assertEquals(session.pages.map((p) => [p.route, p.path]), [['/', 'src/pages/Home.tsx'], ['/about', 'src/pages/About.tsx']])
  assert(session.pages.every((p) => p.imported.ok))
  const main = findFileInTree(project.files, HOME)!.nodes![0]
  assertEquals(main.props.className, 'mx-auto max-w-4xl p-8')
  const link = find(main.children, (n) => n.type === 'link')!
  assertEquals([link.props.linkTag, link.props.to, link.interactions?.[0].targetPageId], ['A', '/about', 'pg:src/pages/About.tsx'])
  const chips = all(main.children, (n) => n.type === 'code').map((n) => String(n.props.code))
  assert(chips.some((c) => c.startsWith('<Show when={open()}')))
  assert(chips.some((c) => c.startsWith('<For each={items}>')))
})

Deno.test('solid: edit splices with `class`; new page + <Route component> wiring, <A> links', async () => {
  const { session, project } = await openRepo(api(SOLID_REPO), P, 'acme-solid', 'main')
  assertEquals(computeChanges(session, project, P).changes, [])
  const main = findFileInTree(project.files, HOME)!.nodes![0]
  find(main.children, (n) => n.type === 'h1')!.props.className = 'text-5xl'
  main.children.push({ id: 'x', type: 'button', props: { className: 'mt-2', children: 'About' }, children: [], style: {},
    interactions: [{ trigger: 'click', action: 'navigate', targetPageId: 'pg:src/pages/About.tsx' }] })
  const page = { ...newPage('Team'), nodes: [{ id: 'l', type: 'link', props: { className: 'underline', children: 'Home' }, children: [], style: {},
    interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: HOME }] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  const { changes } = computeChanges(session, project, P)
  const home = changes.find((c) => c.path === 'src/pages/Home.tsx')!.after
  assertStringIncludes(home, '<h1 class="text-5xl">Welcome to Acme</h1>')
  assertStringIncludes(home, `<button class="mt-2" onClick={() => navigate("/about")}>About</button>`)
  assertStringIncludes(home, "import { useNavigate } from '@solidjs/router'")
  assertStringIncludes(home, '<Show when={open()} fallback={<p>Closed</p>}>\n        <p>Open</p>\n      </Show>')
  const team = changes.find((c) => c.path === 'src/pages/Team.tsx')!.after
  assertStringIncludes(team, "import { A } from '@solidjs/router'")
  assertStringIncludes(team, '<A class="underline" href="/">Home</A>')
  const index = changes.find((c) => c.path === 'src/index.tsx')!.after
  assertStringIncludes(index, '<Route path="/about" component={About} />\n      <Route path="/team" component={Team} />')
  assertStringIncludes(index, "import Team from './pages/Team'")
  const again = await openRepo(api(commit(SOLID_REPO, changes)), P, 'acme-solid', 'main')
  assert(again.session.pages.some((p) => p.route === '/team' && p.imported.ok))
  assertEquals(find(findFileInTree(again.project.files, HOME)!.nodes!, (n) => n.type === 'h1')!.props.className, 'text-5xl')
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
  void diffLines; void diffStats
})
