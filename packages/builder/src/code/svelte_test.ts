import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { computeChanges, openRepo } from './repo-session.ts'
import { SVELTEKIT_REPO } from './fixtures.ts'
import { detectFramework, isEditable } from './framework.ts'
import { addFileToFolder, findFileInTree } from '../lib/builder-types.ts'
import { newPage } from '../lib/studio.ts'
import { diffLines, diffStats } from './line-diff.ts'
import { all, api, commit, find, P } from './test-helpers.ts'

const HOME = 'pg:src/routes/+page.svelte'

const SPA: Record<string, string> = {
  'package.json': JSON.stringify({ devDependencies: { svelte: '^4.2.0', 'svelte-spa-router': '^4.0.0', vite: '^5.0.0' } }),
  'src/App.svelte': `<script>\n  import Router from 'svelte-spa-router'\n  import Home from './routes/Home.svelte'\n  import About from './routes/About.svelte'\n  import NotFound from './routes/NotFound.svelte'\n\n  const routes = {\n    '/': Home,\n    '/about': About,\n    '*': NotFound,\n  }\n</script>\n\n<Router {routes} />\n`,
  'src/routes/Home.svelte': `<script>\n  let n = 0\n</script>\n\n<h1>Home</h1>\n<a href="#/about">About</a>\n<button on:click={() => n++}>{n}</button>\n`,
  'src/routes/About.svelte': `<h1>About</h1>\n`,
  'src/routes/NotFound.svelte': `<h1>Not found</h1>\n`,
}

Deno.test('svelte: detection (SvelteKit, Svelte + spa router)', () => {
  const kit = detectFramework(SVELTEKIT_REPO['package.json'], Object.keys(SVELTEKIT_REPO))
  assertEquals([kit.id, kit.router, kit.major, kit.adharUi], ['sveltekit', 'sveltekit', 5, '@adhar-ui/svelte'])
  assert(isEditable(kit))
  const spa = detectFramework(SPA['package.json'], Object.keys(SPA))
  assertEquals([spa.id, spa.router, spa.major], ['svelte', 'svelte-spa-router', 4])
})

Deno.test('svelte: SvelteKit file routes; markup imported with blocks / expressions as chips', async () => {
  const { session, project } = await openRepo(api(SVELTEKIT_REPO), P, 'acme-kit', 'main')
  assertEquals(session.pages.map((p) => p.route), ['/', '/about', '/blog/:slug'])
  assert(session.pages.every((p) => p.imported.ok), session.pages.map((p) => p.imported.reason).join())
  assertEquals(session.appCss?.path, 'src/app.css')
  assertStringIncludes(session.componentCss ?? '', '.hero { padding: 3rem; }')
  const home = findFileInTree(project.files, HOME)!
  assertEquals(home.name, 'Home.svelte')
  // <svelte:head> is kept but hidden; the page root is <main>.
  assertEquals(home.nodes!.map((n) => n.type), ['code', 'main'])
  const main = home.nodes![1]
  const p = find(main.children, (n) => n.type === 'p')!
  assertEquals([p.props.classExpr, p.props.className], [`class="lead {open ? 'open' : ''}"`, 'lead'])
  assertEquals(p.children.map((c) => c.type), ['text', 'code', 'text'])
  const link = find(main.children, (n) => n.type === 'link')!
  assertEquals([link.props.href, link.interactions?.[0].targetPageId], ['/about', 'pg:src/routes/about/+page.svelte'])
  const chips = all(main.children, (n) => n.type === 'code').map((n) => String(n.props.code))
  assert(chips.some((c) => c.startsWith('{#if open}') && c.endsWith('{/if}')))
  assert(chips.includes('<Counter start={3} />'))
  assertEquals(find(main.children, (n) => n.type === 'button')!.props.rawAttrs, ['type="button"', 'onclick={() => (open = !open)}'])
})

Deno.test('svelte: edit + add with navigation → goto imported into the script, rest byte-identical', async () => {
  const { session, project } = await openRepo(api(SVELTEKIT_REPO), P, 'acme-kit', 'main')
  assertEquals(computeChanges(session, project, P).changes, [])
  const home = findFileInTree(project.files, HOME)!
  const main = home.nodes![1]
  find(main.children, (n) => n.type === 'h1')!.props.children = 'Hi {you}'
  const { changes } = computeChanges(session, project, P)
  assertEquals(diffStats(diffLines(changes[0].before!, changes[0].after)), { added: 1, removed: 1 })
  assertStringIncludes(changes[0].after, '<h1 class="title">Hi &#123;you&#125;</h1>')
  // After the comment chip and the h1.
  main.children.splice(2, 0, { id: 'b', type: 'button', props: { children: 'Read about us' }, children: [], style: {},
    interactions: [{ trigger: 'click', action: 'navigate', targetPageId: 'pg:src/routes/about/+page.svelte' }] })
  const after = computeChanges(session, project, P).changes[0].after
  assertStringIncludes(after, "  import Counter from '$lib/Counter.svelte';\n  import Button from '@adhar-ui/svelte/components/button/Button.svelte';\n  import { goto } from '$app/navigation';\n")
  assertStringIncludes(after, `<h1 class="title">Hi &#123;you&#125;</h1>\n  <Button onclick={() => goto('/about')}>Read about us</Button>\n  <p class="lead`)
  for (const keep of ['<svelte:head>\n  <title>Home</title>\n</svelte:head>', '{#if open}\n    <p>Open</p>\n  {:else}\n    <p>Closed</p>\n  {/if}', '<style>\n  .hero { padding: 3rem; }\n</style>']) assertStringIncludes(after, keep)
  const again = await openRepo(api(commit(SVELTEKIT_REPO, [{ path: 'src/routes/+page.svelte', after }])), P, 'acme-kit', 'main')
  assertEquals(find(findFileInTree(again.project.files, HOME)!.nodes!, (n) => n.type === 'h1')!.props.children, 'Hi {you}')
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
})

Deno.test('svelte: new SvelteKit page → src/routes/<slug>/+page.svelte, no wiring needed', async () => {
  const { session, project } = await openRepo(api(SVELTEKIT_REPO), P, 'acme-kit', 'main')
  const page = { ...newPage('Contact'), nodes: [{ id: 'h', type: 'h1', props: { children: 'Contact {us}' }, children: [], style: {} },
    { id: 'l', type: 'link', props: { children: 'Home' }, children: [], style: {}, interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: HOME }] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  const { changes, warnings } = computeChanges(session, project, P)
  assertEquals(warnings, [])
  assertEquals(changes.map((c) => c.path), ['src/routes/contact/+page.svelte'])
  assertEquals(changes[0].after, '<h1>Contact &#123;us&#125;</h1>\n<a href="/">Home</a>\n')
  const again = await openRepo(api(commit(SVELTEKIT_REPO, changes)), P, 'acme-kit', 'main')
  assert(again.session.pages.some((p) => p.route === '/contact' && p.imported.ok))
})

Deno.test('svelte: spa-router routes object → pages; new page wired into the object + import', async () => {
  const { session, project } = await openRepo(api(SPA), P, 'spa', 'main')
  assertEquals(session.routerFile, 'src/App.svelte')
  assertEquals(session.pages.map((p) => [p.route, p.path]), [['/', 'src/routes/Home.svelte'], ['/about', 'src/routes/About.svelte']])
  const home = findFileInTree(project.files, 'pg:src/routes/Home.svelte')!
  assertEquals(find(home.nodes!, (n) => n.type === 'link')!.interactions?.[0].targetPageId, 'pg:src/routes/About.svelte')
  const page = { ...newPage('Team'), nodes: [{ id: 'b', type: 'button', props: { children: 'Home' }, children: [], style: {},
    interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: 'pg:src/routes/Home.svelte' }] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  const { changes } = computeChanges(session, project, P)
  const created = changes.find((c) => c.path === 'src/routes/Team.svelte')!
  assertEquals(created.after, `<script>\n  import { push } from 'svelte-spa-router'\n</script>\n\n<button on:click={() => push('/')}>Home</button>\n`)
  const app = changes.find((c) => c.path === 'src/App.svelte')!.after
  assertStringIncludes(app, "  import NotFound from './routes/NotFound.svelte'\n  import Team from './routes/Team.svelte'\n")
  assertStringIncludes(app, "    '/about': About,\n    '/team': Team,\n    '*': NotFound,")
  const again = await openRepo(api(commit(SPA, changes)), P, 'spa', 'main')
  assert(again.session.pages.some((p) => p.route === '/team' && p.imported.ok))
})
