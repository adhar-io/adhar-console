import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { resolveTemplateSource } from './scaffolder.ts'

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
  assertEquals(r.templatePath, 'templates/go-rest-service')
  assertEquals(r.goldenPath, undefined)
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
