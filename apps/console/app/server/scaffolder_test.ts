import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { committedPerfTest, PERF_TEST_CONFIG, PERF_TEST_SCRIPTS, resolveTemplateSource } from './scaffolder.ts'
// The Performance Center's discovery — a pure module the server cannot import
// at runtime, read here only to hold the two lists of script names together.
import { PERF_DIR, REPO_CONFIG_FILE, REPO_SCRIPT_FILES } from '../../../../modules/develop/src/data/perf-location.ts'

// The curated template collection, mirrored from
// github.com/adhar-io/adhar-templates by the `adhar-libraries` package.
const REPO = 'adhar/adhar-templates'

Deno.test('a golden path GENERATES — it is not a stored skeleton', () => {
  // The regression this exists for: `templateId: golden-microservice` used to
  // make the scaffolder render `templates/golden-microservice` (404 — golden
  // paths are generated, not stored) AND skip the generator, leaving a repo with
  // only catalog-info.yaml behind an Argo CD Application pointing at a missing
  // deploy/.
  const r = resolveTemplateSource({
    templateId: 'golden-microservice',
    templatesRepo: REPO,
    goldenPath: 'microservice',
  })
  assertEquals(r.isBackstage, false)
  assertEquals(r.templatePath, undefined)
  assertEquals(r.goldenPath, 'microservice')
})

Deno.test('a templateId with no golden-path family renders the stored skeleton', () => {
  const r = resolveTemplateSource({ templateId: 'go-rest-service', templatesRepo: REPO })
  assertEquals(r.isBackstage, true)
  // The layout of the curated collection: templates/<id>/ holds template.yaml
  // plus the skeleton/ tree it renders.
  assertEquals(r.templatePath, 'templates/go-rest-service')
  assertEquals(r.goldenPath, undefined)
})

Deno.test('the templates directory is configurable, and a bare one still joins', () => {
  assertEquals(
    resolveTemplateSource({ templateId: 'svc', templatesRepo: REPO, templatesPath: 'custom/dir' }).templatePath,
    'custom/dir/svc',
  )
  // An install that puts templates at the repo root gets no stray slash.
  assertEquals(
    resolveTemplateSource({ templateId: 'svc', templatesRepo: REPO, templatesPath: '' }).templatePath,
    'svc',
  )
})

Deno.test('an explicitly named Backstage source wins over a golden-path family', () => {
  // Asking for a specific skeleton is an explicit instruction; honour it.
  for (
    const o of [
      { templatePath: 'templates/custom', templatesRepo: REPO, goldenPath: 'microservice' },
      { templateId: 'x', templatesRepo: REPO, explicitTemplatesRepo: true, goldenPath: 'ml' },
    ]
  ) {
    const r = resolveTemplateSource(o)
    assertEquals(r.isBackstage, true)
    assertEquals(r.goldenPath, undefined)
  }
})

Deno.test('an unknown golden-path family is not treated as one', () => {
  const r = resolveTemplateSource({ templateId: 'x', templatesRepo: REPO, goldenPath: 'not-a-family' })
  assertEquals(r.goldenPath, undefined)
  assertEquals(r.isBackstage, true)
})

Deno.test('exactly one of the two paths is ever selected', () => {
  const cases: Parameters<typeof resolveTemplateSource>[0][] = [
    { templateId: 'golden-frontend', templatesRepo: REPO, goldenPath: 'frontend' },
    { templateId: 'go-rest-service', templatesRepo: REPO },
    { templatesRepo: REPO, goldenPath: 'data-pipeline' },
    { templatesRepo: REPO },
  ]
  for (const c of cases) {
    const r = resolveTemplateSource(c)
    // Never both — that contradiction is what produced an empty repo.
    assertEquals(r.isBackstage && r.goldenPath !== undefined, false)
  }
})

/* ─────────── the template's performance test ─────────── */

Deno.test('a TypeScript template\'s perf/load.ts is reported as the service\'s Performance Center test', () => {
  // What the templates ship since they moved to TypeScript.
  assertEquals(committedPerfTest(new Set(['src/index.ts', 'perf/load.ts', 'perf/test.json', 'catalog-info.yaml'])), 'perf/load.ts')
  assertEquals(committedPerfTest(new Set(['perf/load.ts'])), 'perf/load.ts')
})

Deno.test('a template from before TypeScript still reports its perf/load.js test', () => {
  assertEquals(committedPerfTest(new Set(['perf/load.js', 'perf/test.json'])), 'perf/load.js')
  assertEquals(committedPerfTest(new Set(['perf/load.js'])), 'perf/load.js')
})

Deno.test('a scaffold carrying both scripts reports load.ts — the one the Performance Center runs', () => {
  assertEquals(committedPerfTest(new Set(['perf/load.js', 'perf/load.ts', 'perf/test.json'])), 'perf/load.ts')
})

Deno.test('a config alone is still the test; no perf files, a sub-test or a look-alike is not the template\'s test', () => {
  assertEquals(committedPerfTest(new Set(['perf/test.json'])), 'perf/test.json')
  assertEquals(committedPerfTest(new Set()), null)
  assertEquals(committedPerfTest(new Set(['README.md', 'src/perf/load.ts', 'perf/smoke/load.ts', 'perf/load.tsx', 'perf/load.mjs'])), null)
})

Deno.test('the scaffolder and the Performance Center agree on the script names and which one wins', () => {
  // The scaffolder reports `<name>-load` when it committed what discovery will
  // find as that test; two lists that drift apart would report a test the
  // Performance Center does not list, or miss one it does.
  assertEquals([...PERF_TEST_SCRIPTS], REPO_SCRIPT_FILES.map((f) => `${PERF_DIR}/${f}`))
  assertEquals(PERF_TEST_CONFIG, `${PERF_DIR}/${REPO_CONFIG_FILE}`)
})
