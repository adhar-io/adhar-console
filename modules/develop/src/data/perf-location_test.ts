import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  applicationOf,
  configPathOf,
  type DirEntry,
  discoverPerfTests,
  filesUrlOf,
  ignoredScriptNote,
  ignoredScriptPathOf,
  isApplicationRepo,
  isJavaScriptFile,
  LEGACY_SCRIPT_FILE,
  locationOf,
  newTestProblem,
  perfTestDir,
  perfTestName,
  perfTestsInRepo,
  REPO_SCRIPT_FILE,
  REPO_SCRIPT_FILES,
  scriptDownloadName,
  scriptLanguageOf,
  scriptPathOf,
  testFilePathsOf,
  testScriptsIn,
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
  const { list } = lister({ checkout: { perf: [blob('perf/load.ts'), blob('perf/test.json')] } })
  const tests = await perfTestsInRepo('adhar', { name: 'checkout', default_branch: 'trunk' }, list)
  assertEquals(tests.map((t) => t.name), ['checkout-load'])
  assertEquals(tests[0].dir, 'perf')
  assertEquals(tests[0].branch, 'trunk')
  assertEquals(scriptPathOf(tests[0]), 'perf/load.ts')
  assertEquals(configPathOf(tests[0]), 'perf/test.json')
})

Deno.test('perf/<test>/test.json is a further test, named <repo>-<test>', async () => {
  const { list } = lister({
    checkout: {
      perf: [blob('perf/load.ts'), blob('perf/test.json'), dir('perf/smoke'), dir('perf/lib')],
      'perf/smoke': [blob('perf/smoke/load.ts'), blob('perf/smoke/test.json')],
      // Shared helpers are not a test.
      'perf/lib': [blob('perf/lib/helpers.ts')],
    },
  })
  const tests = await perfTestsInRepo('adhar', { name: 'checkout' }, list)
  assertEquals(tests.map((t) => `${t.name}@${t.dir}`), ['checkout-load@perf', 'checkout-smoke@perf/smoke'])
  assertEquals(scriptPathOf(tests[1]), 'perf/smoke/load.ts')
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

  const perf = [blob('perf/load.ts'), blob('perf/test.json')]
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
  // A location built the way discovery and the New-test dialog build it.
  const loc = locationOf('adhar', { name: 'checkout', default_branch: 'main', html_url: 'https://gitea.example/adhar/checkout/' }, 'smoke')
  assertEquals(filesUrlOf(loc), 'https://gitea.example/adhar/checkout/src/branch/main/perf/smoke')
  // The link needs only where the folder is — not which script is in it.
  assertEquals(
    filesUrlOf({ repoUrl: 'https://gitea.example/adhar/cart', branch: 'release/1.x', dir: 'perf' }),
    'https://gitea.example/adhar/cart/src/branch/release%2F1.x/perf',
  )
  assertEquals(filesUrlOf({ branch: 'main', dir: 'perf' }), undefined)
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

/* ─────────── TypeScript scripts, and the JavaScript ones before them ─────────── */

Deno.test('the script names: load.ts first, the legacy load.js second', () => {
  assertEquals(REPO_SCRIPT_FILE, 'load.ts')
  assertEquals(LEGACY_SCRIPT_FILE, 'load.js')
  // The order is the precedence when a folder holds both.
  assertEquals([...REPO_SCRIPT_FILES], ['load.ts', 'load.js'])
})

Deno.test('a template-era test reports its load.ts as the script it runs', async () => {
  const { list } = lister({ checkout: { perf: [blob('perf/load.ts'), blob('perf/test.json')] } })
  const [t, ...rest] = await perfTestsInRepo('adhar', { name: 'checkout' }, list)
  assertEquals(rest, [])
  assertEquals(t.script, 'load.ts')
  assertEquals(t.ignoredScript, undefined)
  assertEquals(scriptPathOf(t), 'perf/load.ts')
  assertEquals(scriptLanguageOf(t), 'typescript')
  assertEquals(ignoredScriptNote(t), undefined)
  assertEquals(testFilePathsOf(t), ['perf/load.ts', 'perf/test.json'])
})

Deno.test('a repo scaffolded before the TypeScript templates keeps its load.js — read, run and committed as itself', async () => {
  const { list } = lister({
    checkout: {
      perf: [blob('perf/load.js'), blob('perf/test.json'), dir('perf/smoke')],
      'perf/smoke': [blob('perf/smoke/load.js'), blob('perf/smoke/test.json')],
    },
  })
  const tests = await perfTestsInRepo('adhar', { name: 'checkout' }, list)
  assertEquals(tests.map((t) => `${t.name}:${scriptPathOf(t)}`), ['checkout-load:perf/load.js', 'checkout-smoke:perf/smoke/load.js'])
  for (const t of tests) {
    assertEquals(t.script, 'load.js')
    assertEquals(t.ignoredScript, undefined)
    assertEquals(scriptLanguageOf(t), 'javascript')
  }
  assertEquals(testFilePathsOf(tests[1]), ['perf/smoke/load.js', 'perf/smoke/test.json'])
})

Deno.test('a folder holding both scripts runs load.ts, and says load.js beside it is not run', async () => {
  const { list } = lister({
    checkout: {
      // load.js listed first: precedence is by name, not by Gitea's order.
      perf: [blob('perf/load.js'), blob('perf/load.ts'), blob('perf/test.json'), dir('perf/smoke')],
      'perf/smoke': [blob('perf/smoke/load.js'), blob('perf/smoke/load.ts')],
    },
  })
  const [top, smoke] = await perfTestsInRepo('adhar', { name: 'checkout' }, list)
  assertEquals([top.name, smoke.name], ['checkout-load', 'checkout-smoke'])
  for (const t of [top, smoke]) {
    assertEquals(t.script, 'load.ts')
    assertEquals(t.ignoredScript, 'load.js')
    assertEquals(scriptLanguageOf(t), 'typescript')
  }
  assertEquals(scriptPathOf(top), 'perf/load.ts')
  assertEquals(ignoredScriptPathOf(top), 'perf/load.js')
  assertEquals(ignoredScriptPathOf(smoke), 'perf/smoke/load.js')

  // The page names the file that runs and the one that does not.
  const note = ignoredScriptNote(smoke)!
  assertStringIncludes(note, 'runs perf/smoke/load.ts')
  assertStringIncludes(note, 'perf/smoke/load.js')
  assertStringIncludes(note, 'not run')

  // Deleting the test removes the shadowed script too — left behind, it
  // would bring the test straight back as the JavaScript it was hiding.
  assertEquals(testFilePathsOf(top), ['perf/load.ts', 'perf/load.js', 'perf/test.json'])
})

Deno.test('a folder with only test.json is a test whose script the console writes as load.ts', async () => {
  const { list } = lister({ checkout: { perf: [blob('perf/test.json')] } })
  const [t] = await perfTestsInRepo('adhar', { name: 'checkout' }, list)
  assertEquals(t.name, 'checkout-load')
  assertEquals(scriptPathOf(t), 'perf/load.ts')
  assertEquals(t.ignoredScript, undefined)
})

Deno.test('a script on its own is a test; helpers, look-alikes and folders named like scripts are not', async () => {
  const { list } = lister({
    checkout: {
      perf: [dir('perf/ts'), dir('perf/js'), dir('perf/lib'), dir('perf/load.ts')],
      'perf/ts': [blob('perf/ts/load.ts')],
      'perf/js': [blob('perf/js/load.js')],
      'perf/lib': [blob('perf/lib/helpers.ts'), blob('perf/lib/load.mjs'), blob('perf/lib/load.tsx'), blob('perf/lib/Load.ts'), dir('perf/lib/load.js')],
    },
  })
  const tests = await perfTestsInRepo('adhar', { name: 'checkout' }, list)
  assertEquals(tests.map((t) => `${t.name}:${scriptPathOf(t)}`), ['checkout-ts:perf/ts/load.ts', 'checkout-js:perf/js/load.js'])

  // The directory reader on its own.
  assertEquals(testScriptsIn([blob('perf/load.ts')]), { script: 'load.ts' })
  assertEquals(testScriptsIn([blob('perf/load.js')]), { script: 'load.js' })
  assertEquals(testScriptsIn([blob('perf/load.js'), blob('perf/load.ts')]), { script: 'load.ts', ignoredScript: 'load.js' })
  assertEquals(testScriptsIn([blob('perf/test.json')]), { script: 'load.ts' })
  assertEquals(testScriptsIn([dir('perf/load.ts'), blob('perf/README.md')]), null)
  assertEquals(testScriptsIn([]), null)
})

Deno.test('a new test is written as load.ts', () => {
  const smoke = locationOf('adhar', { name: 'checkout', default_branch: 'main' }, 'smoke')
  assertEquals(smoke.script, 'load.ts')
  assertEquals(smoke.ignoredScript, undefined)
  assertEquals(scriptPathOf(smoke), 'perf/smoke/load.ts')
  const own = locationOf('adhar', { name: 'checkout' })
  assertEquals(scriptPathOf(own), 'perf/load.ts')
  assertEquals(scriptLanguageOf(own), 'typescript')
  // A location read from git keeps the file it found.
  assertEquals(scriptPathOf(locationOf('adhar', { name: 'checkout' }, undefined, { script: 'load.js' })), 'perf/load.js')
})

Deno.test('a script is JavaScript only when its file says .js — the editor language and download name follow the file', () => {
  assertEquals(isJavaScriptFile('load.js'), true)
  assertEquals(isJavaScriptFile('LOAD.JS'), true)
  assertEquals(isJavaScriptFile('load.ts'), false)
  assertEquals(isJavaScriptFile(undefined), false)
  assertEquals(scriptLanguageOf({ script: 'load.js' }), 'javascript')
  assertEquals(scriptLanguageOf({ script: 'load.ts' }), 'typescript')
  // Not known yet: TypeScript, what the console writes.
  assertEquals(scriptLanguageOf(undefined), 'typescript')

  const legacy = locationOf('adhar', { name: 'checkout' }, undefined, { script: 'load.js' })
  const smoke = locationOf('adhar', { name: 'checkout' }, 'smoke')
  assertEquals(scriptDownloadName(legacy, 'checkout-load'), 'perf/load.js')
  assertEquals(scriptDownloadName(smoke, 'checkout-smoke'), 'perf/smoke/load.ts')
  assertEquals(scriptDownloadName(undefined, 'checkout-load'), 'checkout-load.ts')
  assert(!scriptDownloadName(legacy, 'x').endsWith('.ts'), 'a legacy script downloads as the .js it is')
})
