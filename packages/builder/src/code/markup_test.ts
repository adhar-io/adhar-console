import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { computeChanges, openRepo } from './repo-session.ts'
import { escapeAttr, escapeLiteral, escapeText, markupTextValue } from './markup.ts'
import { addSvelteRoutingRoute, htmlRoute, resolveHref, svelteKitPages } from './markup-routes.ts'
import { detectFramework } from './framework.ts'
import { addFileToFolder, findFileInTree } from '../lib/builder-types.ts'
import { newPage } from '../lib/studio.ts'
import { api, commit, find, P } from './test-helpers.ts'

Deno.test('markup: escaping per dialect, entity decoding', () => {
  assertEquals(escapeText('a {b} @c <d> & {{e}}', 'angular'), 'a &#123;b&#125; &#64;c &lt;d&gt; &amp; &#123;&#123;e&#125;&#125;')
  assertEquals(escapeText('a {b} {{e}}', 'vue'), 'a {b} &#123;&#123;e&#125;&#125;')
  assertEquals(escapeText('a {b}', 'svelte'), 'a &#123;b&#125;')
  assertEquals(escapeText('a {b} @c', 'html'), 'a {b} @c')
  assertEquals(escapeAttr('say "hi" {x}', 'svelte'), 'say &quot;hi&quot; &#123;x&#125;')
  assertEquals(escapeLiteral('`a` ${b} \\'), '\\`a\\` \\${b} \\\\')
  assertEquals(markupTextValue('  Fish&nbsp;&amp;\n   chips &#x2014; &#169; '), ' Fish & chips — © ')
})

Deno.test('markup: routes helpers (SvelteKit groups/params, HTML hrefs, svelte-routing insert)', () => {
  const kit = detectFramework(JSON.stringify({ devDependencies: { '@sveltejs/kit': '2', svelte: '5' } }), [])
  assertEquals(svelteKitPages(kit, ['src/routes/+page.svelte', 'src/routes/(app)/dash/+page.svelte', 'src/routes/[[lang]]/docs/[...path]/+page.svelte', 'src/routes/+layout.svelte']).map((p) => p.route),
    ['/', '/:lang?/docs/*', '/dash'])
  assertEquals(resolveHref('docs/a.html', '../index.html'), 'index.html')
  assertEquals(resolveHref('docs/a.html', 'b.html#x'), 'docs/b.html')
  assertEquals(resolveHref('docs/a.html', '/blog/'), 'blog/index.html')
  assertEquals(resolveHref('a.html', 'https://x.io'), null)
  assertEquals([htmlRoute('index.html'), htmlRoute('blog/index.html'), htmlRoute('about.html')], ['/', '/blog/', '/about.html'])
  assertEquals(addSvelteRoutingRoute('<Router>\n  <Route path="/" component={Home} />\n</Router>', '/team', 'Team'), '<Router>\n  <Route path="/" component={Home} />\n  <Route path="team" component={Team} />\n</Router>')
})

const NG_MODULE: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { '@angular/core': '^16.2.0', '@angular/router': '^16.2.0' } }),
  'src/app/app-routing.module.ts': `import { NgModule } from '@angular/core';\nimport { RouterModule, Routes } from '@angular/router';\nimport { DashboardComponent } from './dashboard/dashboard.component';\n\nconst routes: Routes = [\n  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },\n  { path: 'dashboard', component: DashboardComponent },\n];\n\n@NgModule({ imports: [RouterModule.forRoot(routes)], exports: [RouterModule] })\nexport class AppRoutingModule {}\n`,
  'src/app/dashboard/dashboard.component.ts': `import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-dashboard',\n  templateUrl: './dashboard.component.html',\n})\nexport class DashboardComponent {}\n`,
  'src/app/dashboard/dashboard.component.html': `<div class="dash">\n  <h2 i18n="@@title">Dashboard</h2>\n  <div *ngIf="ready; else loading" class="grid">\n    <span>{{ count }}</span>\n  </div>\n  <ng-template #loading><p>Loading…</p></ng-template>\n  <input [(ngModel)]="q" placeholder="Search">\n</div>\n`,
}

Deno.test('angular: NgModule app (v16) — RouterModule.forRoot routes, structural directives as chips, standalone new page', async () => {
  const { session, project } = await openRepo(api(NG_MODULE), P, 'ng16', 'main')
  assertEquals(session.routerFile, 'src/app/app-routing.module.ts')
  assertEquals(session.pages.map((p) => p.route), ['/dashboard'])
  const nodes = findFileInTree(project.files, 'pg:src/app/dashboard/dashboard.component.ts')!.nodes!
  const dash = nodes[0]
  assertEquals(dash.children.map((c) => c.type), ['h2', 'code', 'code', 'input'])
  assertEquals(find(dash.children, (n) => n.type === 'h2')!.props.rawAttrs, ['i18n="@@title"'])
  assertEquals(find(dash.children, (n) => n.type === 'input')!.props.rawAttrs, ['[(ngModel)]="q"'])
  // Edit the input placeholder: only that start tag changes.
  find(dash.children, (n) => n.type === 'input')!.props.placeholder = 'Find'
  const page = { ...newPage('Reports'), nodes: [{ id: 'l', type: 'link', props: { children: 'Dashboard' }, children: [], style: {},
    interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: 'pg:src/app/dashboard/dashboard.component.ts' }] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  const { changes } = computeChanges(session, project, P)
  const tpl = changes.find((c) => c.path === 'src/app/dashboard/dashboard.component.html')!.after
  assertEquals(tpl, NG_MODULE['src/app/dashboard/dashboard.component.html'].replace('<input [(ngModel)]="q" placeholder="Search">', '<input placeholder="Find" [(ngModel)]="q">'))
  const created = changes.find((c) => c.path === 'src/app/reports/reports.component.ts')!.after
  assertStringIncludes(created, 'standalone: true,')
  assertEquals(changes.find((c) => c.path === 'src/app/reports/reports.component.html')!.after, '<a routerLink="/dashboard">Dashboard</a>\n')
  const routing = changes.find((c) => c.path === 'src/app/app-routing.module.ts')!.after
  assertStringIncludes(routing, "  { path: 'dashboard', component: DashboardComponent },\n  { path: 'reports', component: ReportsComponent },\n];")
  assertStringIncludes(routing, "import { ReportsComponent } from './reports/reports.component';")
})

const NUXT: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { nuxt: '^3.15.0', vue: '^3.5.0' } }),
  'pages/index.vue': `<template>\n  <div>\n    <h1>Home</h1>\n    <NuxtLink to="/about">About</NuxtLink>\n  </div>\n</template>\n`,
  'pages/about.vue': `<template>\n  <div><h1>About</h1></div>\n</template>\n`,
  'assets/css/main.css': 'h1 { color: teal; }\n',
}

Deno.test('vue: Nuxt — file routes, NuxtLink navigation, new page in pages/ with NuxtLink', async () => {
  const { session, project } = await openRepo(api(NUXT), P, 'nuxt', 'main')
  assertEquals(session.pages.map((p) => [p.route, p.path]), [['/', 'pages/index.vue'], ['/about', 'pages/about.vue']])
  assertEquals(session.appCss?.path, 'assets/css/main.css')
  const link = find(findFileInTree(project.files, 'pg:pages/index.vue')!.nodes!, (n) => n.type === 'link')!
  assertEquals([link.props.linkTag, link.interactions?.[0].targetPageId], ['NuxtLink', 'pg:pages/about.vue'])
  // About's single-line markup: text change in place.
  find(findFileInTree(project.files, 'pg:pages/about.vue')!.nodes!, (n) => n.type === 'h1')!.props.children = 'About us'
  const page = { ...newPage('Faq'), nodes: [{ id: 'l', type: 'link', props: { children: 'Home' }, children: [], style: {},
    interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: 'pg:pages/index.vue' }] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  const { changes, warnings } = computeChanges(session, project, P)
  assertEquals(warnings, [])
  assertEquals(changes.find((c) => c.path === 'pages/about.vue')!.after, `<template>\n  <div><h1>About us</h1></div>\n</template>\n`)
  assertEquals(changes.find((c) => c.path === 'pages/faq.vue')!.after, '<template>\n  <NuxtLink to="/">Home</NuxtLink>\n</template>\n')
  const again = await openRepo(api(commit(NUXT, changes)), P, 'nuxt', 'main')
  assert(again.session.pages.some((p) => p.route === '/faq' && p.imported.ok))
})

Deno.test('markup: a text element gaining children, and attribute-only edits keep multi-line content', async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0' } }),
    'src/App.vue': `<template>\n  <section\n    class="a"\n    data-x="1"\n  >\n    <p>Hello</p>\n    <ul class="list">\n      <li>One</li>\n    </ul>\n  </section>\n</template>\n`,
  }
  const { session, project } = await openRepo(api(files), P, 'v', 'main')
  const sec = findFileInTree(project.files, 'pg:src/App.vue')!.nodes![0]
  sec.props.className = 'b'
  const p = find(sec.children, (n) => n.type === 'p')!
  p.children = [{ id: 't', type: 'text', props: { children: 'Hi' }, children: [], style: {} }, { id: 's', type: 'strong', props: { children: 'there' }, children: [], style: {} }]
  delete p.props.children
  const after = computeChanges(session, project, P).changes[0].after
  assertEquals(after, `<template>\n  <section class="b" data-x="1">\n    <p>\n      Hi\n      <strong>there</strong>\n    </p>\n    <ul class="list">\n      <li>One</li>\n    </ul>\n  </section>\n</template>\n`)
})
