import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { CATEGORIES, loadFromFiles, matchesPattern, parsePattern, PatternError } from './patterns.ts'

const DIR = new URL('../content/patterns/', import.meta.url)

async function readAll(): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for await (const e of Deno.readDir(DIR)) {
    if (e.isFile && e.name.endsWith('.md')) files[e.name] = await Deno.readTextFile(new URL(e.name, DIR))
  }
  return files
}

/**
 * The docs are plain Markdown that anyone edits. This test is the review:
 * every file must parse, every category must have docs, and every console
 * link in a body must point at a page that exists.
 */
Deno.test('every pattern file parses', async () => {
  const list = loadFromFiles(await readAll())
  assert(list.length >= 20, `expected the pattern library, found ${list.length}`)
  assertEquals(new Set(list.map((p) => p.slug)).size, list.length)
  for (const c of CATEGORIES) assert(list.some((p) => p.category === c), `no pattern in category ${c}`)
  for (const p of list) {
    assert(p.summary.length <= 200, `${p.slug}: summary is longer than a card can hold`)
    for (const h of ['## Why', '## How Adhar does it', '## Use it', '## Watch out']) {
      assert(p.body.includes(h), `${p.slug}: missing section "${h}"`)
    }
  }
})

// Sections the console actually serves, per route — keep in step with the modules.
const SECTIONS: Record<string, string[]> = {
  '/deliver': ['dashboard', 'flow', 'apps', 'environments', 'stages', 'rollouts', 'releases', 'registry', 'scans', 'runtime', 'policy', 'chaos', 'performance'],
  '/discover': ['dashboard', 'metrics', 'logs', 'traces', 'servicemap', 'alerts', 'slos', 'dashboards', 'analytics'],
  '/decide': ['dashboard', 'dashboards', 'questions', 'sql', 'databases', 'pulses', 'dora', 'spend'],
  '/develop': ['dashboard', 'repos', 'branches', 'commits', 'prs', 'issues', 'environments', 'builds', 'pipelines', 'content', 'codebuilder'],
  '/settings': ['organization'],
  '/platform': [
    'catalog', 'scaling', 'caches', 'queues', 'topics', 'databases', 'tables', 'buckets', 'backup-policies', 'restores',
    'secret-stores', 'secret-rotations', 'compliance-policies', 'teams', 'projects', 'environments', 'cost-trackers', 'xr-clusters',
  ],
}
const ROUTES = new Set(['/catalog', '/scorecards', '/decide', '/help', '/status'])

Deno.test('console links point at real pages', async () => {
  for (const p of loadFromFiles(await readAll())) {
    for (const m of p.body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
      const url = new URL(m[1], 'http://x')
      const section = url.searchParams.get('section')
      if (!section) {
        assert(ROUTES.has(url.pathname) || SECTIONS[url.pathname], `${p.slug}: unknown page ${m[1]}`)
        continue
      }
      assert(SECTIONS[url.pathname]?.includes(section), `${p.slug}: ${url.pathname} has no section "${section}"`)
    }
  }
})

Deno.test('a malformed file fails with a message a writer can act on', () => {
  assertThrows(() => parsePattern('x', '# no front matter'), PatternError, 'missing front matter')
  assertThrows(() => parsePattern('Bad_Name', '---\ntitle: a\n---\nbody'), PatternError, 'kebab-case')
  assertThrows(
    () => parsePattern('x', '---\ntitle: A\ncategory: Speed\nsummary: s\n---\n' + 'word '.repeat(40)),
    PatternError,
    'category "Speed"',
  )
  const ok = parsePattern('ok', '---\ntitle: A\ncategory: Scale\nsummary: s\ntools: [Kafka, KEDA]\norder: 5\n---\n' + 'word '.repeat(400))
  assertEquals(ok.tools, ['Kafka', 'KEDA'])
  assertEquals(ok.order, 5)
  assertEquals(ok.minutes, 2)
})

Deno.test('search matches all words across title, tools and body', async () => {
  const list = loadFromFiles(await readAll())
  const hits = list.filter((p) => matchesPattern(p, 'kafka partition'))
  assert(hits.some((p) => p.slug === 'sharding'))
  assert(!list.filter((p) => matchesPattern(p, 'zzzz-nothing')).length)
})
