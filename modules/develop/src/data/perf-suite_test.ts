import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { DEFAULT_CONFIG } from './perf-format.ts'
import { type DirEntry, perfTestsInRepo } from './perf-location.ts'
import {
  commitPerfTest,
  consoleRunObjects,
  deletePerfTestFiles,
  fetchPerfTest,
  newTestLocation,
  type PerfGitClient,
  type PerfSuite,
} from './perf-suite.ts'

/**
 * Reading, committing and deleting a test go to the file the test HAS — the
 * templates' `load.ts`, or the `load.js` a repository scaffolded before them
 * still holds. The console writes a new test as `load.ts` and never renames a
 * user's file, so these run against a fake Gitea that records every path it
 * is asked for.
 */

const enc = (s: string) => btoa(s)
const dec = (s: string) => atob(s)

/** A Gitea holding `files` (path → text) in adhar/checkout; every call is recorded. */
function fakeGitea(files: Record<string, string>) {
  const reads: string[] = []
  const writes: Array<{ path: string; content: string; message: string; sha?: string }> = []
  const deletes: Array<{ path: string; sha: string }> = []
  const history: string[] = []
  const missing = () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }))
  const client: PerfGitClient = {
    getFile: (_org, _repo, _ref, path) => {
      reads.push(path)
      if (!(path in files)) return missing()
      return Promise.resolve({ path, content: enc(files[path]), encoding: 'base64' as const, size: files[path].length, sha: `sha:${path}` })
    },
    saveFile: (_org, _repo, _ref, path, body) => {
      writes.push({ path, content: dec(body.content), message: body.message, sha: body.sha })
      files[path] = dec(body.content)
      return Promise.resolve({ commit: { sha: `commit-${writes.length}` } })
    },
    deleteFile: (_org, _repo, _ref, path, body) => {
      if (!(path in files)) return missing()
      deletes.push({ path, sha: body.sha })
      delete files[path]
      return Promise.resolve()
    },
    listCommits: (_org, _repo, _ref, _limit, opts) => {
      history.push(opts?.path ?? '')
      return Promise.resolve(
        opts?.path && opts.path in files
          ? [{ sha: `c:${opts.path}`, short_sha: 'c', message: 'm', author: { login: 'dev' }, created: '2026-11-05T00:00:00Z' }]
          : [],
      )
    },
  }
  return { client, files, reads, writes, deletes, history }
}

/** The suite discovery builds for adhar/checkout with these `perf/` listings. */
async function suiteOf(tree: Record<string, DirEntry[]>): Promise<PerfSuite> {
  const tests = await perfTestsInRepo('adhar', { name: 'checkout', default_branch: 'main' }, (_r, _b, path) => Promise.resolve(tree[path] ?? null))
  return { org: 'adhar', apps: [{ name: 'checkout', branch: 'main' }, { name: 'cart', branch: 'main' }], tests, unreadable: [] }
}

const blob = (path: string): DirEntry => ({ path, type: 'blob' })
const dir = (path: string): DirEntry => ({ path, type: 'tree' })

const LEGACY = `import http from 'k6/http'\nexport const options = { vus: 1 }\nexport default function () { http.get(__ENV.BASE_URL) }\n`
const TYPED = `import http from 'k6/http'\nimport type { Options } from 'k6/options'\nexport const options: Options = { vus: 1 }\nexport default function (): void { http.get(__ENV.BASE_URL) }\n`

Deno.test('an edited legacy load.js is read and committed back as load.js — never renamed to load.ts', async () => {
  const suite = await suiteOf({ perf: [blob('perf/load.js'), blob('perf/test.json')] })
  const git = fakeGitea({ 'perf/load.js': LEGACY, 'perf/test.json': '{}' })

  const test = await fetchPerfTest(suite, 'checkout-load', git.client)
  assertEquals(test.script, LEGACY)
  assertEquals(test.scriptSha, 'sha:perf/load.js')
  assertEquals(git.reads.sort(), ['perf/load.js', 'perf/test.json'])
  // Its provenance is the file it has.
  assertEquals(git.history.sort(), ['perf/load.js', 'perf/test.json'])

  const edited = LEGACY.replace('vus: 1', 'vus: 2')
  const res = await commitPerfTest(test.location!, { name: test.name, script: edited, scriptSha: test.scriptSha }, git.client)
  assertEquals(git.writes, [{ path: 'perf/load.js', content: edited, message: 'perf: update checkout-load (load.js)', sha: 'sha:perf/load.js' }])
  assertEquals(res.commit, 'commit-1')
  assertEquals(Object.keys(git.files).sort(), ['perf/load.js', 'perf/test.json'])
})

Deno.test('a template-era load.ts is read and committed as load.ts', async () => {
  const suite = await suiteOf({ perf: [blob('perf/load.ts'), blob('perf/test.json')] })
  const git = fakeGitea({ 'perf/load.ts': TYPED, 'perf/test.json': '{}' })
  const test = await fetchPerfTest(suite, 'checkout-load', git.client)
  assertEquals(test.script, TYPED)
  assertEquals(test.location?.script, 'load.ts')

  await commitPerfTest(test.location!, { name: test.name, script: TYPED, scriptSha: test.scriptSha, config: { ...DEFAULT_CONFIG, title: 'Checkout' }, configSha: test.configSha }, git.client)
  assertEquals(git.writes.map((w) => `${w.path} ${w.message} ${w.sha}`), [
    'perf/load.ts perf: update checkout-load (load.ts) sha:perf/load.ts',
    'perf/test.json perf: update checkout-load (test.json) sha:perf/test.json',
  ])
})

Deno.test('a test created from the console is written as load.ts, beside its test.json', async () => {
  const suite = await suiteOf({ perf: [blob('perf/load.js'), blob('perf/test.json')] })
  const git = fakeGitea({})

  // A further test of an app whose default test is still JavaScript: new
  // tests are TypeScript regardless.
  const smoke = newTestLocation(suite, 'checkout', 'smoke')
  assertEquals(smoke.name, 'checkout-smoke')
  await commitPerfTest(smoke, { name: smoke.name, script: TYPED, config: DEFAULT_CONFIG, message: 'perf: add checkout-smoke' }, git.client)
  // The default test of an app that has none.
  const own = newTestLocation(suite, 'cart')
  await commitPerfTest(own, { name: own.name, script: TYPED, config: DEFAULT_CONFIG, message: 'perf: add cart-load' }, git.client)

  assertEquals(git.writes.map((w) => `${w.path} | ${w.message} | ${w.sha}`), [
    'perf/smoke/load.ts | perf: add checkout-smoke (load.ts) | undefined',
    'perf/smoke/test.json | perf: add checkout-smoke (test.json) | undefined',
    'perf/load.ts | perf: add cart-load (load.ts) | undefined',
    'perf/test.json | perf: add cart-load (test.json) | undefined',
  ])
  assertThrows(() => newTestLocation(suite, 'nope'), Error, 'not an application repository')
})

Deno.test('a folder holding both scripts edits load.ts, and deleting the test removes both scripts and the config', async () => {
  const suite = await suiteOf({ perf: [blob('perf/load.js'), blob('perf/load.ts'), blob('perf/test.json'), dir('perf/smoke')], 'perf/smoke': [blob('perf/smoke/load.ts')] })
  const git = fakeGitea({ 'perf/load.js': LEGACY, 'perf/load.ts': TYPED, 'perf/test.json': '{}', 'perf/smoke/load.ts': TYPED })

  const test = await fetchPerfTest(suite, 'checkout-load', git.client)
  assertEquals(test.script, TYPED)
  assertEquals(git.reads.includes('perf/load.js'), false)
  await commitPerfTest(test.location!, { name: test.name, script: TYPED, scriptSha: test.scriptSha }, git.client)
  assertEquals(git.writes.map((w) => w.path), ['perf/load.ts'])

  await deletePerfTestFiles(test.location!, test.name, git.client)
  assertEquals(git.deletes, [
    { path: 'perf/load.ts', sha: 'sha:perf/load.ts' },
    { path: 'perf/load.js', sha: 'sha:perf/load.js' },
    { path: 'perf/test.json', sha: 'sha:perf/test.json' },
  ])
  // The other test is untouched.
  assertEquals(Object.keys(git.files), ['perf/smoke/load.ts'])
})

Deno.test('deleting a test whose files are partly gone already is not an error', async () => {
  const suite = await suiteOf({ perf: [blob('perf/test.json')] })
  const git = fakeGitea({ 'perf/test.json': '{}' })
  await deletePerfTestFiles(suite.tests[0], 'checkout-load', git.client)
  assertEquals(git.deletes.map((d) => d.path), ['perf/test.json'])
})

Deno.test('"Run test" mounts the script under the file the test has: load.ts as script.ts, a legacy load.js as script.js', async () => {
  const suite = await suiteOf({
    perf: [blob('perf/load.js'), blob('perf/test.json'), dir('perf/smoke')],
    'perf/smoke': [blob('perf/smoke/load.ts'), blob('perf/smoke/test.json')],
  })
  const git = fakeGitea({ 'perf/load.js': LEGACY, 'perf/test.json': '{"namespace":"perf"}', 'perf/smoke/load.ts': TYPED, 'perf/smoke/test.json': '{}' })
  for (const [name, key, source] of [['checkout-load', 'script.js', LEGACY], ['checkout-smoke', 'script.ts', TYPED]] as const) {
    const test = await fetchPerfTest(suite, name, git.client)
    const { artefact, run } = consoleRunObjects(test, { runName: `${name}-20261105-101500` })
    assertEquals(Object.keys(artefact.data).filter((k) => /\.(js|ts)$/.test(k)), [key], name)
    assertEquals(artefact.data[key], source, `${name}: the script exactly as committed`)
    assertEquals(run.spec.script, { configMap: { name: `k6-${name}`, file: key } }, name)
    // Stamped with the commit the read found and the app the repo is.
    assertEquals(run.metadata.labels['adhar.io/perf-commit'], `c:perf/${name === 'checkout-load' ? 'load.js' : 'smoke/load.ts'}`)
    assertEquals(run.metadata.labels['adhar.io/application'], 'checkout')
  }
  const legacy = await fetchPerfTest(suite, 'checkout-load', git.client)
  assertEquals(consoleRunObjects(legacy, { runName: 'r' }).run.metadata.namespace, 'perf')
})
