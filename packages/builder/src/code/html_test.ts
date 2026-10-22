import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { computeChanges, openRepo } from './repo-session.ts'
import { HTML_REPO } from './fixtures.ts'
import { detectFramework, isEditable } from './framework.ts'
import { addFileToFolder, findFileInTree } from '../lib/builder-types.ts'
import { newPage } from '../lib/studio.ts'
import { diffLines, diffStats } from './line-diff.ts'
import { all, api, commit, find, P } from './test-helpers.ts'

const INDEX = 'pg:index.html'
const ABOUT = 'pg:about.html'

Deno.test('html: detection (no package.json, or one without a framework)', () => {
  const fw = detectFramework(null, Object.keys(HTML_REPO))
  assertEquals([fw.id, fw.router, fw.label], ['html', 'html', 'Static HTML'])
  assert(isEditable(fw))
  assertEquals(detectFramework(JSON.stringify({ devDependencies: { vite: '7' } }), ['index.html', 'main.js']).id, 'html')
})

Deno.test('html: every page is a route; links between pages navigate; scripts / tables / implied ends kept', async () => {
  const { session, project } = await openRepo(api(HTML_REPO), P, 'site', 'main')
  assertEquals(session.pages.map((p) => [p.route, p.path]), [['/', 'index.html'], ['/about.html', 'about.html']])
  assert(session.pages.every((p) => p.imported.ok))
  // The linked stylesheet styles the canvas (plain CSS, no Tailwind).
  assertEquals(session.appCss?.path, 'css/style.css')
  const idx = findFileInTree(project.files, INDEX)!
  assertEquals(idx.name, 'Home.html')
  assertEquals(findFileInTree(project.files, ABOUT)!.name, 'About.html')
  assertEquals(idx.nodes!.map((n) => n.type), ['nav', 'main', 'footer', 'code'])
  const nav = idx.nodes![0]
  assertEquals(nav.children.map((c) => c.interactions?.[0].targetPageId), [INDEX, ABOUT])
  const main = idx.nodes![1]
  assertEquals(find(main.children, (n) => n.type === 'p')!.props.children, 'Everything & more, in one place.')
  const chips = all(main.children, (n) => n.type === 'code').map((n) => String(n.props.code))
  assert(chips.includes('<table class="prices"><tr><td>Basic</td><td>$9</td></tr></table>'))
  // <li> without end tags can't be re-emitted faithfully: kept as chips.
  assert(chips.includes('<li>Fast'))
  assertEquals(String(idx.nodes![3].props.code), '<script src="js/app.js"></script>')
})

Deno.test('html: edit → one line changes, re-import equals, untouched files identical', async () => {
  const { session, project } = await openRepo(api(HTML_REPO), P, 'site', 'main')
  assertEquals(computeChanges(session, project, P).changes, [])
  const idx = findFileInTree(project.files, INDEX)!
  find(idx.nodes!, (n) => n.type === 'h1')!.props.children = 'Fish & <chips>'
  const { changes } = computeChanges(session, project, P)
  assertEquals(changes.map((c) => c.path), ['index.html'])
  assertStringIncludes(changes[0].after, '<h1 class="title">Fish &amp; &lt;chips&gt;</h1>')
  assertEquals(diffStats(diffLines(changes[0].before!, changes[0].after)), { added: 1, removed: 1 })
  const again = await openRepo(api(commit(HTML_REPO, changes)), P, 'site', 'main')
  assertEquals(find(findFileInTree(again.project.files, INDEX)!.nodes!, (n) => n.type === 'h1')!.props.children, 'Fish & <chips>')
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
})

Deno.test('html: new page → document from the home page (head, nav, footer, scripts) + nav link on every page', async () => {
  const { session, project } = await openRepo(api(HTML_REPO), P, 'site', 'main')
  const page = { ...newPage('Pricing'), nodes: [{ id: 's', type: 'section', props: { className: 'pricing' }, style: {}, children: [
    { id: 'h', type: 'h1', props: { children: 'Pricing' }, children: [], style: {} },
    { id: 'b', type: 'button', props: { children: 'Back' }, children: [], style: {}, interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: INDEX }] },
  ] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  const { changes, warnings } = computeChanges(session, project, P)
  assertEquals(warnings, [])
  assertEquals(changes.map((c) => c.path).sort(), ['about.html', 'index.html', 'pricing.html'])
  for (const f of ['index.html', 'about.html']) {
    const after = changes.find((c) => c.path === f)!.after
    assertStringIncludes(after, '    <a href="about.html" class="nav-link">About</a>\n    <a class="nav-link" href="pricing.html">Pricing</a>\n  </nav>')
    assertEquals(diffStats(diffLines(changes.find((c) => c.path === f)!.before!, after)), { added: 1, removed: 0 })
  }
  const created = changes.find((c) => c.path === 'pricing.html')!.after
  assertStringIncludes(created, '<title>Pricing</title>')
  assertStringIncludes(created, '<link rel="stylesheet" href="css/style.css">')
  assertStringIncludes(created, '<body>\n  <nav class="nav">\n    <a href="index.html" class="nav-link">Home</a>\n    <a href="about.html" class="nav-link">About</a>\n    <a class="nav-link" href="pricing.html">Pricing</a>\n  </nav>\n  <div class="pricing">')
  assertStringIncludes(created, `<button onclick="location.href='index.html'">Back</button>`)
  assertStringIncludes(created, '  <footer class="footer">© Acme</footer>\n  <script src="js/app.js"></script>\n</body>\n</html>\n')
  assert(!created.includes('Welcome to Acme'))
  const again = await openRepo(api(commit(HTML_REPO, changes)), P, 'site', 'main')
  const pricing = again.session.pages.find((p) => p.path === 'pricing.html')!
  assert(pricing.imported.ok)
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
  // The nav link drives the prototype.
  const nav = findFileInTree(again.project.files, INDEX)!.nodes![0]
  assertEquals(nav.children[2].interactions?.[0].targetPageId, 'pg:pricing.html')
})
