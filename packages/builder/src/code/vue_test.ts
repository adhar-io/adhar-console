import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { computeChanges, openRepo, previewFile } from './repo-session.ts'
import { VUE_REPO } from './fixtures.ts'
import { detectFramework, isEditable } from './framework.ts'
import { nuxtPages } from './markup-routes.ts'
import { addFileToFolder, findFileInTree } from '../lib/builder-types.ts'
import { makeSymbol, newPage, SYMBOLS_FOLDER } from '../lib/studio.ts'
import { diffLines, diffStats } from './line-diff.ts'
import { all, api, commit, find, P } from './test-helpers.ts'

const HOME = 'pg:src/views/HomeView.vue'

Deno.test('vue: detection (Vue + vue-router, Nuxt)', () => {
  const fw = detectFramework(VUE_REPO['package.json'], Object.keys(VUE_REPO))
  assertEquals([fw.id, fw.router, fw.tailwindVersion, fw.adharUi], ['vue', 'vue-router', 4, '@adhar-ui/vue'])
  assert(isEditable(fw))
  const nuxt = detectFramework(JSON.stringify({ dependencies: { nuxt: '^3.15.0', vue: '^3.5.0' } }), ['pages/index.vue', 'pages/blog/[slug].vue', 'pages/about.vue'])
  assertEquals([nuxt.id, nuxt.router, nuxt.label], ['nuxt', 'nuxt', 'Nuxt'])
  assertEquals(nuxtPages(nuxt, ['pages/index.vue', 'pages/blog/[slug].vue', 'pages/about.vue', 'components/X.vue']).map((p) => p.route), ['/', '/about', '/blog/:slug'])
})

Deno.test('vue: router routes (static + lazy), SFC template imported, dynamic syntax kept', async () => {
  const { session, project } = await openRepo(api(VUE_REPO), P, 'acme-vue', 'main')
  assertEquals(session.routerFile, 'src/router/index.ts')
  assertEquals(session.pages.map((p) => [p.route, p.path]), [['/', 'src/views/HomeView.vue'], ['/about', 'src/views/AboutView.vue']])
  assert(session.pages.every((p) => p.imported.ok))
  assertEquals(session.appCss?.path, 'src/assets/main.css')
  assertStringIncludes(session.componentCss ?? '', 'letter-spacing')
  const home = findFileInTree(project.files, HOME)!
  assertEquals(home.name, 'Home.vue')
  const main = home.nodes![0]
  assertEquals(main.props.className, 'mx-auto max-w-4xl p-8')
  const p = find(main.children, (n) => n.type === 'p')!
  assertEquals(p.props.className, 'mt-2 text-slate-600')
  assertEquals(p.props.rawAttrs, [`:class="{ 'opacity-50': !open }"`])
  assertEquals(p.children.map((c) => c.type), ['text', 'code', 'text'])
  assertEquals(p.children[2].props.children, 'new messages & more')
  const link = find(main.children, (n) => n.type === 'link')!
  assertEquals([link.props.linkTag, link.props.to, link.interactions?.[0].targetPageId], ['RouterLink', '/about', 'pg:src/views/AboutView.vue'])
  const chips = all(main.children, (n) => n.type === 'code').map((n) => String(n.props.code))
  assert(chips.includes('<p v-if="open" class="text-sm">Open</p>\n    <p v-else class="text-sm">Closed</p>'), chips.join('\n'))
  assert(chips.includes('<li v-for="n in count" :key="n" class="py-1">Item {{ n }}</li>'))
  assert(chips.includes('<StatCard title="Revenue" :value="42" />'))
  const btn = find(main.children, (n) => n.type === 'button')!
  assertEquals(btn.props.rawAttrs, ['type="button"', '@click="open = !open"'])
})

Deno.test('vue: untouched → no changes; edits splice only their range; re-import equals', async () => {
  const { session, project } = await openRepo(api(VUE_REPO), P, 'acme-vue', 'main')
  assertEquals(computeChanges(session, project, P).changes, [])
  const home = findFileInTree(project.files, HOME)!
  const h1 = find(home.nodes!, (n) => n.type === 'h1')!
  h1.props.children = 'Hello {{ world }} <3'
  h1.props.className = 'text-5xl font-black'
  const { changes } = computeChanges(session, project, P)
  assertEquals(changes.map((c) => c.path), ['src/views/HomeView.vue'])
  const after = changes[0].after
  assertStringIncludes(after, '<h1 class="text-5xl font-black">Hello &#123;&#123; world &#125;&#125; &lt;3</h1>')
  assertEquals(diffStats(diffLines(changes[0].before!, after)), { added: 1, removed: 1 })
  for (const keep of ['<!-- hero -->', `:class="{ 'opacity-50': !open }"`, '<style scoped>', "import StatCard from '@/components/StatCard.vue'"]) assertStringIncludes(after, keep)
  const again = await openRepo(api(commit(VUE_REPO, changes)), P, 'acme-vue', 'main')
  const h1b = find(findFileInTree(again.project.files, HOME)!.nodes!, (n) => n.type === 'h1')!
  assertEquals([h1b.props.children, h1b.props.className], ['Hello {{ world }} <3', 'text-5xl font-black'])
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
})

Deno.test('vue: add a node (Adhar UI button + navigation), delete one — script setup gets the import', async () => {
  const { session, project } = await openRepo(api(VUE_REPO), P, 'acme-vue', 'main')
  const home = findFileInTree(project.files, HOME)!
  const main = home.nodes![0]
  main.children = main.children.filter((c) => c.type !== 'button')
  main.children.push({ id: 'n', type: 'button', props: { className: 'mt-4', children: 'About' }, children: [], style: {},
    interactions: [{ trigger: 'click', action: 'navigate', targetPageId: 'pg:src/views/AboutView.vue' }] })
  const after = computeChanges(session, project, P).changes[0].after
  assertStringIncludes(after, "import StatCard from '@/components/StatCard.vue'\nimport Button from '@adhar-ui/vue/components/button/Button.vue'\n")
  assertStringIncludes(after, `<StatCard title="Revenue" :value="42" />\n    <Button className="mt-4" @click="$router.push('/about')">About</Button>\n  </main>`)
  assert(!after.includes('Toggle</button>'))
  assertEquals(previewFile(session, project, HOME, P), after)
})

Deno.test('vue: new page → SFC + router entry (lazy, named) before the catch-all; components', async () => {
  const { session, project } = await openRepo(api(VUE_REPO), P, 'acme-vue', 'main')
  const page = { ...newPage('Pricing'), nodes: [{ id: 'h', type: 'h1', props: { className: 'text-3xl', children: 'Pricing' }, children: [], style: {} },
    { id: 'l', type: 'link', props: { children: 'Home' }, children: [], style: {}, interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: HOME }] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  // A designer component, used on the home page.
  const home = findFileInTree(project.files, HOME)!
  const h1 = find(home.nodes!, (n) => n.type === 'h1')!
  const { symbol, instance } = makeSymbol(h1, 'Hero title')
  home.nodes![0].children = home.nodes![0].children.map((c) => (c.id === h1.id ? instance : c))
  project.files = addFileToFolder(project.files, SYMBOLS_FOLDER, symbol)
  const { changes } = computeChanges(session, project, P)
  const created = changes.find((c) => c.path === 'src/views/PricingView.vue')!
  assertEquals(created.after, '<template>\n  <h1 class="text-3xl">Pricing</h1>\n  <RouterLink to="/">Home</RouterLink>\n</template>\n')
  const router = changes.find((c) => c.path === 'src/router/index.ts')!.after
  assertStringIncludes(router, "    { path: '/pricing', name: 'pricing', component: () => import('../views/PricingView.vue') },\n    { path: '/:pathMatch(.*)*'")
  const comp = changes.find((c) => c.path === 'src/components/HeroTitle.vue')!.after
  assertStringIncludes(comp, '<template>\n  <h1 class="text-4xl font-bold text-brand">Welcome to Acme</h1>\n</template>')
  const homeAfter = changes.find((c) => c.path === 'src/views/HomeView.vue')!.after
  assertStringIncludes(homeAfter, "import HeroTitle from '../components/HeroTitle.vue'")
  assertStringIncludes(homeAfter, '    <HeroTitle />\n')
  // Reopen: the page is routed and the component re-links.
  const again = await openRepo(api(commit(VUE_REPO, changes)), P, 'acme-vue', 'main')
  assert(again.session.pages.some((p) => p.route === '/pricing' && p.imported.ok))
  const sym = findFileInTree(again.project.files, 'sym:src/components/HeroTitle.vue')!
  assertEquals(sym.nodes![0].props.children, 'Welcome to Acme')
  assert(find(findFileInTree(again.project.files, HOME)!.nodes!, (n) => n.type === 'symbol' && n.props.symbolId === sym.id))
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
})
