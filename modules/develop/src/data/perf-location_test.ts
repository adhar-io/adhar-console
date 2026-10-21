import { assertEquals } from 'jsr:@std/assert@1'
import {
  applicationOf,
  configPathOf,
  type DirEntry,
  discoverPerfTests,
  filesUrlOf,
  isApplicationRepo,
  newTestProblem,
  perfTestDir,
  perfTestName,
  perfTestsInRepo,
  scriptPathOf,
} from './perf-location.ts'

// A fake Gitea: repo → directory → entries. A directory not listed is a 404.
function lister(tree: Record<string, Record<string, DirEntry[]>>) {
  const calls: string[] = []
  const list = (repo: string, _branch: string, path: string) => {
    calls.push(`${repo}:${path}`)
    return Promise.resolve(tree[repo]?.[path] ?? null)
  }
  return { list, calls }
}

const blob = (path: string): DirEntry => ({ path, type: 'blob' })
const dir = (path: string): DirEntry => ({ path, type: 'tree' })

Deno.test('perf/test.json is the app\'s default test, named <repo>-load like the scaffolder did', async () => {
  const { list } = lister({ checkout: { perf: [blob('perf/load.js'), blob('perf/test.json')] } })
  const tests = await perfTestsInRepo('adhar', { name: 'checkout', default_branch: 'trunk' }, list)
  assertEquals(tests.map((t) => t.name), ['checkout-load'])
  assertEquals(tests[0].dir, 'perf')
  assertEquals(tests[0].branch, 'trunk')
  assertEquals(scriptPathOf(tests[0]), 'perf/load.js')
  assertEquals(configPathOf(tests[0]), 'perf/test.json')
})

Deno.test('perf/<test>/test.json is a further test, named <repo>-<test>', async () => {
  const { list } = lister({
    checkout: {
      perf: [blob('perf/load.js'), blob('perf/test.json'), dir('perf/smoke'), dir('perf/lib')],
      'perf/smoke': [blob('perf/smoke/load.js'), blob('perf/smoke/test.json')],
      // Shared helpers are not a test.
      'perf/lib': [blob('perf/lib/helpers.js')],
    },
  })
  const tests = await perfTestsInRepo('adhar', { name: 'checkout' }, list)
  assertEquals(tests.map((t) => `${t.name}@${t.dir}`), ['checkout-load@perf', 'checkout-smoke@perf/smoke'])
  assertEquals(scriptPathOf(tests[1]), 'perf/smoke/load.js')
  assertEquals(configPathOf(tests[1]), 'perf/smoke/test.json')
})

Deno.test('a repo without perf/ has no tests, and that is not an error', async () => {
  const { list } = lister({ cart: {} })
  assertEquals(await perfTestsInRepo('adhar', { name: 'cart' }, list), [])
  const out = await discoverPerfTests('adhar', [{ name: 'cart' }], list)
  assertEquals(out, { tests: [], unreadable: [] })
})

Deno.test('platform repos, the retired suite repo and mirrors are never read as applications', async () => {
  for (const name of ['packages', 'environments', 'adhar-templates', 'adhar', 'adhar-kit', 'adhar-ui', 'performance-tests', 'Performance-Tests']) {
    assertEquals(isApplicationRepo({ name }), false, `${name} is not an application`)
  }
  assertEquals(isApplicationRepo({ name: 'upstream', mirror: true }), false)
  assertEquals(isApplicationRepo({ name: 'old', archived: true }), false)
  assertEquals(isApplicationRepo({ name: 'checkout' }), true)

  const perf = [blob('perf/load.js'), blob('perf/test.json')]
  const { list, calls } = lister({
    checkout: { perf },
    'performance-tests': { perf },
    packages: { perf },
  })
  const out = await discoverPerfTests('adhar', [{ name: 'performance-tests' }, { name: 'packages' }, { name: 'checkout' }], list)
  assertEquals(out.tests.map((t) => `${t.repo}/${t.name}`), ['checkout/checkout-load'])
  assertEquals(calls, ['checkout:perf'])
})

Deno.test('one unreadable repo does not hide the others', async () => {
  const list = (repo: string, _b: string, path: string) =>
    repo === 'broken' ? Promise.reject(new Error('500')) : Promise.resolve(path === 'perf' ? [blob('perf/test.json')] : null)
  const out = await discoverPerfTests('adhar', [{ name: 'broken' }, { name: 'zeta' }, { name: 'alpha' }], list)
  assertEquals(out.tests.map((t) => t.name), ['alpha-load', 'zeta-load'])
  assertEquals(out.unreadable, ['broken'])
})

Deno.test('names are capped at 63 characters without a trailing dash', () => {
  assertEquals(perfTestName('checkout'), 'checkout-load')
  assertEquals(perfTestName('checkout', 'smoke'), 'checkout-smoke')
  const long = perfTestName('a'.repeat(62), 'smoke')
  assertEquals(long, 'a'.repeat(62))
})

Deno.test('files link to the test directory on the default branch', () => {
  assertEquals(
    filesUrlOf({ name: 'checkout-smoke', org: 'adhar', repo: 'checkout', branch: 'main', dir: 'perf/smoke', repoUrl: 'https://gitea.example/adhar/checkout/' }),
    'https://gitea.example/adhar/checkout/src/branch/main/perf/smoke',
  )
})

Deno.test('a new test goes to perf/ for the default, perf/<test>/ otherwise, and never over an existing one', () => {
  const existing = [{ name: 'checkout-load' }]
  assertEquals(newTestProblem(existing, 'cart', ''), null)
  assertEquals(typeof newTestProblem(existing, 'checkout', ''), 'string')
  assertEquals(typeof newTestProblem(existing, 'checkout', 'load'), 'string')
  assertEquals(newTestProblem(existing, 'checkout', 'smoke'), null)
  assertEquals(typeof newTestProblem(existing, '', 'smoke'), 'string')
  assertEquals(typeof newTestProblem(existing, 'checkout', 'Smoke Test'), 'string')
  assertEquals(typeof newTestProblem(existing, 'a'.repeat(60), 'smoke'), 'string')
  assertEquals(perfTestDir(''), 'perf')
  assertEquals(perfTestDir('load'), 'perf')
  assertEquals(perfTestDir('smoke'), 'perf/smoke')
})

Deno.test('the application label is the repo, when it can be a label value', () => {
  assertEquals(applicationOf({ repo: 'checkout' }), 'checkout')
  assertEquals(applicationOf({ repo: 'x'.repeat(64) }), undefined)
  assertEquals(applicationOf(undefined), undefined)
})
