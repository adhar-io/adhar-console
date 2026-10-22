import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { computeChanges, openRepo, previewFile } from './repo-session.ts'
import { ANGULAR_REPO } from './fixtures.ts'
import { detectFramework, isEditable } from './framework.ts'
import { addFileToFolder, findFileInTree } from '../lib/builder-types.ts'
import { newPage } from '../lib/studio.ts'
import { diffLines, diffStats } from './line-diff.ts'
import { all, api, commit, find, P } from './test-helpers.ts'

Deno.test('angular: detection', () => {
  const fw = detectFramework(ANGULAR_REPO['package.json'], Object.keys(ANGULAR_REPO))
  assertEquals([fw.id, fw.router, fw.label, fw.major, fw.adharUi], ['angular', 'angular', 'Angular', 19, '@adhar-ui/angular'])
  assert(isEditable(fw))
  assertEquals(detectFramework(null, ['angular.json', 'src/main.ts']).id, 'angular')
})

Deno.test('angular: routes (component, loadComponent, loadChildren) and templates imported', async () => {
  const { session, project } = await openRepo(api(ANGULAR_REPO), P, 'acme-ng', 'main')
  assertEquals(session.routerFile, 'src/app/app.routes.ts')
  assertEquals(session.pages.map((p) => [p.route, p.path]), [
    ['/', 'src/app/pages/home/home.component.ts'],
    ['/admin/settings', 'src/app/admin/settings.component.ts'],
    ['/customers', 'src/app/pages/customers/customers.component.ts'],
  ])
  assert(session.pages.every((p) => p.imported.ok), session.pages.map((p) => p.imported.reason).join())
  assertEquals(session.appCss?.path, 'src/styles.css')
  assertStringIncludes(session.componentCss ?? '', '.hero { padding: 3rem; }')
  const home = findFileInTree(project.files, 'pg:src/app/pages/home/home.component.ts')!
  assertEquals(home.name, 'Home.ts')
  const main = home.nodes![0]
  assertEquals([main.type, main.props.className], ['main', 'hero'])
  assertEquals(find(main.children, (n) => n.type === 'h1')!.props.children, 'Welcome to Acme')
  // Interpolation + pipe → chip; entity decoded in the text.
  const p = find(main.children, (n) => n.type === 'p')!
  assertEquals(p.children.map((c) => c.type), ['text', 'code', 'text'])
  assertEquals(p.children[1].props.code, '{{ user().name | uppercase }}')
  assertEquals(p.children[2].props.children, '& team')
  // routerLink → link + navigation.
  const link = find(main.children, (n) => n.type === 'link')!
  assertEquals([link.props.to, link.props.linkAttr, link.interactions?.[0].targetPageId], ['/customers', 'routerLink', 'pg:src/app/pages/customers/customers.component.ts'])
  // @if/@else is ONE chip; bindings stay raw; components are chips.
  const chips = all(main.children, (n) => n.type === 'code').map((n) => String(n.props.code))
  assert(chips.some((c) => c.startsWith('@if (open()) {') && c.endsWith('<p class="note">Closed</p>\n  }')), chips.join('\n'))
  assert(chips.includes(`<app-stats [period]="'week'" />`))
  const btn = find(main.children, (n) => n.type === 'button')!
  assertEquals(btn.props.rawAttrs, ['type="button"', '(click)="open.set(!open())"', '[class.active]="open()"'])
  // Inline template with @for/@empty.
  const customers = findFileInTree(project.files, 'pg:src/app/pages/customers/customers.component.ts')!
  assert(find(customers.nodes!, (n) => n.type === 'code' && String(n.props.code).startsWith('@for')))
})

Deno.test('angular: nothing edited → no changes; text edit splices only the template line', async () => {
  const { session, project } = await openRepo(api(ANGULAR_REPO), P, 'acme-ng', 'main')
  assertEquals(computeChanges(session, project, P).changes, [])
  const home = findFileInTree(project.files, 'pg:src/app/pages/home/home.component.ts')!
  find(home.nodes!, (n) => n.type === 'h1')!.props.children = 'Hi {there} @ Acme'
  const { changes } = computeChanges(session, project, P)
  assertEquals(changes.map((c) => c.path), ['src/app/pages/home/home.component.html'])
  const after = changes[0].after
  assertStringIncludes(after, '<h1 class="title">Hi &#123;there&#125; &#64; Acme</h1>')
  assertEquals(diffStats(diffLines(changes[0].before!, after)), { added: 1, removed: 1 })
  // Re-open the committed result: same text, and a no-op.
  const files = commit(ANGULAR_REPO, changes)
  const again = await openRepo(api(files), P, 'acme-ng', 'main')
  const h1 = find(findFileInTree(again.project.files, 'pg:src/app/pages/home/home.component.ts')!.nodes!, (n) => n.type === 'h1')!
  assertEquals(h1.props.children, 'Hi {there} @ Acme')
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
})

Deno.test('angular: inline template edit, new node with navigation → RouterLink imported', async () => {
  const { session, project } = await openRepo(api(ANGULAR_REPO), P, 'acme-ng', 'main')
  const page = findFileInTree(project.files, 'pg:src/app/pages/customers/customers.component.ts')!
  const section = page.nodes![0]
  section.children.push({ id: 'n1', type: 'p', props: { className: 'hint', children: 'Back `home`' }, children: [], style: {},
    interactions: [{ trigger: 'click', action: 'navigate', targetPageId: 'pg:src/app/pages/home/home.component.ts' }] })
  const { changes, warnings } = computeChanges(session, project, P)
  assertEquals(warnings, [])
  assertEquals(changes.map((c) => c.path), ['src/app/pages/customers/customers.component.ts'])
  const after = changes[0].after
  assertStringIncludes(after, "import { RouterLink } from '@angular/router';")
  assertStringIncludes(after, 'imports: [RouterLink],')
  // Escaped for the template literal, inserted after the last child with its indentation.
  assertStringIncludes(after, '      </ul>\n      <p class="hint" routerLink="/">Back \\`home\\`</p>\n    </section>')
  // The @for block is untouched.
  assertStringIncludes(after, ANGULAR_REPO['src/app/pages/customers/customers.component.ts'].match(/@for[\s\S]*?\} @empty \{[\s\S]*?\}/)![0])
  const files = commit(ANGULAR_REPO, changes)
  const again = await openRepo(api(files), P, 'acme-ng', 'main')
  const p2 = find(findFileInTree(again.project.files, page.id)!.nodes!, (n) => n.type === 'p' && n.props.className === 'hint')!
  assertEquals(p2.props.children, 'Back `home`')
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
})

Deno.test('angular: delete + reorder keep the rest byte-identical', async () => {
  const { session, project } = await openRepo(api(ANGULAR_REPO), P, 'acme-ng', 'main')
  const home = findFileInTree(project.files, 'pg:src/app/pages/home/home.component.ts')!
  const main = home.nodes![0]
  main.children = main.children.filter((c) => c.type !== 'button')
  const { changes } = computeChanges(session, project, P)
  const after = changes[0].after
  assert(!after.includes('Toggle</button>'))
  assertEquals(after, ANGULAR_REPO['src/app/pages/home/home.component.html'].replace(`\n  <button type="button" (click)="open.set(!open())" [class.active]="open()">Toggle</button>`, ''))
  main.children.reverse()
  const re = computeChanges(session, project, P).changes[0].after
  assert(re.indexOf('<app-stats') < re.indexOf('<h1'))
  assertStringIncludes(re, '<!-- greeting -->')
})

Deno.test('angular: new page → standalone component (Adhar UI), lazy route before the catch-all', async () => {
  const { session, project } = await openRepo(api(ANGULAR_REPO), P, 'acme-ng', 'main')
  const page = { ...newPage('Billing'), nodes: [{ id: 's', type: 'section', props: { className: 'page' }, style: {}, children: [
    { id: 'h', type: 'h1', props: { children: 'Billing' }, children: [], style: {} },
    { id: 'b', type: 'button', props: { className: 'w-full', children: 'Pay now' }, children: [], style: {},
      interactions: [{ trigger: 'click' as const, action: 'navigate' as const, targetPageId: 'pg:src/app/pages/home/home.component.ts' }] },
  ] }] }
  project.files = addFileToFolder(project.files, 'f_pages', page)
  const { changes } = computeChanges(session, project, P)
  const created = changes.find((c) => c.path === 'src/app/pages/billing/billing.component.ts')!
  assertEquals(created.before, null)
  assertStringIncludes(created.after, "import Button from '@adhar-ui/angular/components/button/Button.ts';")
  assertStringIncludes(created.after, "selector: 'app-billing',")
  assertStringIncludes(created.after, 'imports: [Button, RouterLink],')
  assertStringIncludes(created.after, 'templateUrl: \'./billing.component.html\',')
  const tpl = changes.find((c) => c.path === 'src/app/pages/billing/billing.component.html')!.after
  assertStringIncludes(tpl, '<adhar-button className="w-full" routerLink="/">Pay now</adhar-button>')
  assertStringIncludes(created.after, 'export class BillingComponent {}')
  const routes = changes.find((c) => c.path === 'src/app/app.routes.ts')!.after
  assertStringIncludes(routes, "  { path: 'billing', loadComponent: () => import('./pages/billing/billing.component').then((m) => m.BillingComponent) },\n  { path: '**', redirectTo: '' },")
  // Reopen: the new page is a routed, editable page.
  const again = await openRepo(api(commit(ANGULAR_REPO, changes)), P, 'acme-ng', 'main')
  const billing = again.session.pages.find((p) => p.route === '/billing')!
  assert(billing.imported.ok, billing.imported.reason)
  assertEquals(computeChanges(again.session, again.project, P).changes, [])
})

Deno.test('angular: the Code view shows a templateUrl page\'s template', async () => {
  const { session, project } = await openRepo(api(ANGULAR_REPO), P, 'acme-ng', 'main')
  const id = 'pg:src/app/pages/home/home.component.ts'
  assertEquals(previewFile(session, project, id, P), ANGULAR_REPO['src/app/pages/home/home.component.html'])
  find(findFileInTree(project.files, id)!.nodes!, (n) => n.type === 'h1')!.props.children = 'Hey'
  assertStringIncludes(previewFile(session, project, id, P)!, '<h1 class="title">Hey</h1>')
})
