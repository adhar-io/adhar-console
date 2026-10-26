import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  type CatalogApp,
  isUiRepo,
  judgeRepos,
  matchApps,
  notEditableReason,
  type RepoFacts,
  type RepoFiles,
  repoFramework,
  repoFromUrl,
  uiVerdict,
} from './designer-catalog.ts'

Deno.test('repo URLs in Application XRs', () => {
  assertEquals(repoFromUrl('https://gitea.example.com/acme/portal.git'), { owner: 'acme', name: 'portal' })
  assertEquals(repoFromUrl('git@gitea.example.com:acme/portal.git'), { owner: 'acme', name: 'portal' })
  assertEquals(repoFromUrl('http://gitea-http.gitea.svc:3000/adhar/shop/'), { owner: 'adhar', name: 'shop' })
})

Deno.test('apps match their repository by owner/name', () => {
  const apps = [
    { name: 'Portal', team: 'web', project: 'customer', repoUrl: 'https://g/acme/portal.git' },
    { name: 'Other', repoUrl: 'https://g/else/portal.git' },
    { name: 'Shop', repoUrl: 'https://g/acme/shop' },
  ]
  assertEquals(matchApps(apps, { name: 'portal', owner: 'acme' }).map((a) => a.name), ['Portal'])
  assertEquals(matchApps(apps, { name: 'portal' }).map((a) => a.name), ['Portal', 'Other'])
})

/* ── which repositories the Visual Designer offers to open ── */

/** An Application XR as `useCatalogApps` reads it: what the console scaffolder stamps. */
function scaffolded(name: string, dashboardType: string, extra: Partial<CatalogApp> = {}): CatalogApp {
  return {
    name,
    id: name,
    type: 'service',
    labels: {
      'adhar.io/managed-by': 'adhar-console',
      'adhar.io/project': 'adhar',
      'adhar.io/application': name,
      'adhar.io/scaffolded': 'true',
      'adhar.io/dashboard-type': dashboardType,
    },
    project: 'adhar',
    repoUrl: `https://gitea.cloud.adhar.io/adhar/${name}.git`,
    ...extra,
  }
}

/** A repository's files from a fixture; records what was read. */
function files(tree: Record<string, string>): RepoFiles & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    read: (p) => {
      reads.push(p)
      return Promise.resolve(Object.hasOwn(tree, p) ? tree[p] : null)
    },
    paths: () => Promise.resolve(Object.keys(tree)),
  }
}

const REACT_PKG = JSON.stringify({
  dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', '@adhar-ui/react': '^0.1.0' },
  devDependencies: { vite: '^6.0.7', '@vitejs/plugin-react': '^4.3.4', tailwindcss: '^4.0.0' },
})
const ANGULAR_PKG = JSON.stringify({ dependencies: { '@angular/core': '^20.3.0', '@angular/router': '^20.3.0', '@adhar-ui/angular': '^0.1.0' } })
const TANSTACK_PKG = JSON.stringify({
  dependencies: { '@tanstack/react-start': '^1.169.0', '@tanstack/react-router': '^1.170.0', react: '^19.0.0', 'prom-client': '15.1.3' },
  devDependencies: { vite: '^8.0.0' },
})
const NODE_SERVICE_PKG = JSON.stringify({ dependencies: { express: '^4.21.0', pg: '^8.12.0' } })
const FUNCTION_PKG = JSON.stringify({ name: 'test-func', private: true, scripts: { start: 'node index.js' } })

/**
 * The library as builder.tsx computes it: `judgeRepos`, a `check` settled by
 * the repository's files, `isUiRepo`. `listed` = the default "UI apps" view,
 * `all` = "Show all repositories".
 */
async function library(repos: RepoFacts[], apps: CatalogApp[], trees: Record<string, Record<string, string>> = {}) {
  const judged = judgeRepos(repos, apps)
  const listed: string[] = []
  const reads: Record<string, string[]> = {}
  for (const x of judged) {
    let fw: Parameters<typeof isUiRepo>[1] = undefined
    if (x.verdict === 'check') {
      const f = files(trees[x.repo.name] ?? {})
      fw = await repoFramework(f)
      reads[x.repo.name] = f.reads
    }
    if (isUiRepo(x.verdict, fw)) listed.push(x.repo.name)
  }
  return { listed, all: judged.map((x) => x.repo.name), reads }
}

// GCP, 2026-10-27: the React SPA scaffolded from react-spa-app was an
// Application of `type: service` (the XRD default, which the scaffolder never
// overrode), and the designer took that as "not a UI" — so the one app it
// could edit was hidden. The template's dashboard type says what it is.
Deno.test('scaffolded React, Angular and TanStack Start apps are UI apps, whatever type they were stored with', () => {
  for (const [name, dash] of [['reactapp', 'frontend'], ['ngapp', 'frontend'], ['tsapp', 'fullstack']]) {
    const app = scaffolded(name, dash)
    assertEquals(uiVerdict({ name, language: 'TypeScript' }, [app]), 'ui', `${name} (${dash})`)
    // A language Gitea guessed from a server folder does not hide it either.
    assertEquals(uiVerdict({ name, language: 'Python' }, [app]), 'ui', `${name} (${dash})`)
  }
  // The SPA descriptors' label says the same without a dashboard type…
  assertEquals(uiVerdict({ name: 'portal', language: 'TypeScript' }, [{ type: 'service', labels: { 'adhar.io/frontend': 'true' } }]), 'ui')
  // …and so does the type the scaffolder now writes.
  assertEquals(uiVerdict({ name: 'portal', language: 'TypeScript' }, [{ type: 'web' }]), 'ui')
})

Deno.test('Spring, Quarkus, Go, Python and Node services are not UI apps', () => {
  assertEquals(uiVerdict({ name: 'transaction-service', language: 'Java' }, [scaffolded('transaction-service', 'backend-jvm')]), 'not-ui')
  assertEquals(uiVerdict({ name: 'ledger', language: 'Java' }, [scaffolded('ledger', 'backend-jvm')]), 'not-ui')
  assertEquals(uiVerdict({ name: 'pricing', language: 'Go' }, [scaffolded('pricing', 'backend-generic')]), 'not-ui')
  assertEquals(uiVerdict({ name: 'ml-api', language: 'Python' }, [scaffolded('ml-api', 'backend-generic')]), 'not-ui')
  // Node: a web language, so only what the app says keeps it out — without reading a file.
  assertEquals(uiVerdict({ name: 'orders', language: 'TypeScript' }, [scaffolded('orders', 'backend-generic')]), 'not-ui')
  // With no Application, its package.json does: no UI framework in it.
  assertEquals(uiVerdict({ name: 'orders', language: 'TypeScript' }, []), 'check')
})

Deno.test('functions are not UI apps', async () => {
  // test-func on GCP: a Node function, JavaScript, Application labelled backend-generic.
  assertEquals(uiVerdict({ name: 'test-func', language: 'JavaScript' }, [scaffolded('test-func', 'backend-generic')]), 'not-ui')
  // Without an Application its package.json names no framework.
  assertEquals(await repoFramework(files({ 'package.json': FUNCTION_PKG, 'index.js': '' })).then((f) => f?.id), 'unknown')
  assertEquals((await library([{ name: 'fn', language: 'JavaScript' }], [], { fn: { 'package.json': FUNCTION_PKG } })).listed, [])
})

Deno.test('mirrors, archived and empty repositories are never offered — not even under "show all"', async () => {
  const repos: RepoFacts[] = [
    { name: 'upstream-ui', language: 'TypeScript', mirror: true },
    { name: 'old-portal', language: 'TypeScript', archived: true },
    { name: 'fresh', empty: true },
  ]
  const apps = [scaffolded('old-portal', 'frontend')]
  for (const r of repos) {
    assertEquals(uiVerdict(r, matchApps(apps, r)), 'not-ui', r.name)
    assert(notEditableReason(r), r.name)
  }
  const tree = { 'package.json': REACT_PKG }
  assertEquals(await library(repos, apps, { 'upstream-ui': tree, 'old-portal': tree, fresh: tree }), { listed: [], all: [], reads: {} })
})

// adhar-ui and adhar-kit are force-pushed from GitHub on every adhar-libraries
// sync (NOT Gitea mirrors: `mirror` is false), so an edit made here is undone;
// packages / environments are the GitOps repos. The platform tells them apart
// by name (app-ci skips the same list) — adhar-ui's TypeScript and its
// package.json must not get it listed.
Deno.test('the platform\'s own repositories are never offered, whatever their files say', async () => {
  const repos: RepoFacts[] = ['packages', 'environments', 'templates', 'adhar-templates', 'adhar-ui', 'adhar-kit', 'adhar', 'Adhar-UI']
    .map((name) => ({ name, language: 'TypeScript', mirror: false }))
  for (const r of repos) {
    assertEquals(uiVerdict(r, []), 'not-ui', r.name)
    assert(notEditableReason(r), r.name)
  }
  const trees = Object.fromEntries(repos.map((r) => [r.name, { 'package.json': REACT_PKG, 'index.html': '<html></html>' }]))
  assertEquals(await library(repos, [], trees), { listed: [], all: [], reads: {} })
  // A team's own repository is fine.
  assertEquals(notEditableReason({ name: 'reactapp', language: 'JavaScript' }), null)
})

Deno.test('a repository with no Application is a UI app when its package.json says so', async () => {
  const repos: RepoFacts[] = [
    { name: 'landing', language: 'TypeScript' },
    { name: 'admin', language: 'TypeScript' },
    { name: 'shop', language: 'TypeScript' },
    { name: 'site', language: 'HTML' },
    { name: 'api', language: 'TypeScript' },
  ]
  const out = await library(repos, [], {
    landing: { 'package.json': REACT_PKG, 'index.html': '' },
    admin: { 'package.json': ANGULAR_PKG, 'angular.json': '{}' },
    shop: { 'package.json': TANSTACK_PKG, 'src/routes/index.tsx': '' },
    site: { 'index.html': '<html></html>', 'about.html': '' },
    api: { 'package.json': NODE_SERVICE_PKG },
  })
  assertEquals(out.listed, ['landing', 'admin', 'shop', 'site'])
  // Still being read: kept listed (its badge shows a skeleton) until it resolves.
  assertEquals(isUiRepo('check', undefined), true)
  assertEquals(isUiRepo('check', null), false)
})

Deno.test('the framework a repository declares: root first, then the app package opening it would pick', async () => {
  // React + Vite at the root (the React SPA template; TanStack Start reads the same).
  assertEquals((await repoFramework(files({ 'package.json': REACT_PKG })))?.id, 'vite-react')
  assertEquals((await repoFramework(files({ 'package.json': TANSTACK_PKG })))?.id, 'vite-react')
  // An Angular workspace, a static site, nothing web-like.
  assertEquals((await repoFramework(files({ 'angular.json': '{}' })))?.id, 'angular')
  assertEquals((await repoFramework(files({ 'index.html': '<html></html>' })))?.id, 'html')
  assertEquals(await repoFramework(files({ 'README.md': '# docs' })), null)
  // A monorepo with no root package.json: the app package opening it would
  // pick (findAppPackageJson) decides, so what the library lists, the editor opens.
  const mono = files({ 'apps/web/package.json': REACT_PKG, 'apps/web/src/App.tsx': '', 'services/api/go.mod': '' })
  const fw = await repoFramework(mono)
  assertEquals([fw?.id, fw?.root], ['vite-react', 'apps/web'])
  // A root package.json that names no framework is what opening reads too:
  // the repository is not read any further.
  const workspace = files({ 'package.json': JSON.stringify({ private: true, devDependencies: { turbo: '^2' } }), 'apps/web/package.json': REACT_PKG })
  assertEquals((await repoFramework(workspace))?.id, 'unknown')
  assertEquals(workspace.reads, ['package.json', 'angular.json', 'index.html'])
})

// The adhar org on the GCP cluster (cloud.adhar.io), 2026-10-27: its eight
// repositories as Gitea lists them and its three Application XRs. Before the
// fix the default view listed nothing — reactapp was hidden by `type: service`
// and every other repository was ruled out — and "Show all" offered the GitOps
// repos and the library copies for editing.
Deno.test('the adhar org on GCP: only reactapp is offered as a UI app', async () => {
  const repos: RepoFacts[] = [
    { name: 'environments', language: '', mirror: false },
    { name: 'packages', language: 'Python', mirror: false },
    { name: 'adhar-templates', language: 'TypeScript', mirror: true },
    { name: 'adhar-ui', language: 'TypeScript', mirror: false },
    { name: 'adhar-kit', language: 'Java', mirror: false },
    { name: 'reactapp', language: 'JavaScript', mirror: false },
    { name: 'test-func', language: 'JavaScript', mirror: false },
    { name: 'transaction-service', language: 'Java', mirror: false },
  ]
  const apps = [
    scaffolded('reactapp', 'frontend', { labels: { ...scaffolded('reactapp', 'frontend').labels, 'adhar.io/frontend': 'true' } }),
    scaffolded('test-func', 'backend-generic'),
    scaffolded('transaction-service', 'backend-jvm'),
  ]
  const out = await library(repos, apps, {
    reactapp: { 'package.json': REACT_PKG, 'index.html': '' },
    'test-func': { 'package.json': FUNCTION_PKG, 'index.js': '' },
    'adhar-ui': { 'package.json': JSON.stringify({ devDependencies: { '@types/node': '^26' } }), 'apps/storybook/package.json': REACT_PKG },
  })
  assertEquals(out.listed, ['reactapp'])
  assertEquals(out.all, ['reactapp', 'test-func', 'transaction-service'])
  // Every verdict came from the Applications: no repository had to be read.
  assertEquals(out.reads, {})
})
