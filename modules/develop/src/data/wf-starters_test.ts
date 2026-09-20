import { assertEquals } from 'jsr:@std/assert'
import { STARTERS, starterById } from './wf-starters.ts'
import { fromArgoSpec, toArgoSpec, validateGraph } from './wf-model.ts'

/**
 * A starter is copied, then edited. If one is subtly invalid the person who
 * copied it inherits the bug and has no reason to suspect the template.
 */

Deno.test('every starter is a valid graph', () => {
  for (const s of STARTERS) {
    assertEquals(validateGraph(s.build('ci')), [], `${s.id} is not valid`)
  }
})

Deno.test('every starter round-trips through Argo', () => {
  for (const s of STARTERS) {
    const original = s.build('ci')
    const back = fromArgoSpec(toArgoSpec(original))
    assertEquals(back?.steps.map((x) => x.id), original.steps.map((x) => x.id), `${s.id} does not round-trip`)
  }
})

Deno.test('no starter pins a floating tag', () => {
  // A starter is copied and lives for years; `latest` turns it into an
  // unreproducible pipeline the first time the base image changes.
  for (const s of STARTERS) {
    for (const step of s.build('ci').steps) {
      assertEquals(step.image.includes(':'), true, `${s.id}/${step.id} has no tag`)
      assertEquals(step.image.endsWith(':latest'), false, `${s.id}/${step.id} uses :latest`)
    }
  }
})

Deno.test('starters are laid out, not stacked at the origin', () => {
  for (const s of STARTERS) {
    const steps = s.build('ci').steps
    if (steps.length < 2) continue
    assertEquals(new Set(steps.map((x) => `${x.x},${x.y}`)).size, steps.length, `${s.id} has overlapping nodes`)
  }
})

Deno.test('the pipeline starters actually branch — that is why a DAG is worth drawing', () => {
  const g = starterById('build-test-publish')!.build('ci')
  const fanOut = g.steps.filter((x) => x.dependsOn.includes('checkout'))
  assertEquals(fanOut.length >= 2, true)
  const join = g.steps.find((x) => x.dependsOn.length >= 2)
  assertEquals(Boolean(join), true)
})

Deno.test('every parameter referenced by a step is declared', () => {
  // An undeclared `{{workflow.parameters.x}}` fails at submit with an error
  // that names the template rather than the missing parameter.
  for (const s of STARTERS) {
    const g = s.build('ci')
    const declared = new Set(g.params.map((p) => p.name))
    const text = g.steps.map((x) => `${x.command} ${Object.values(x.env ?? {}).join(' ')} ${x.when ?? ''}`).join(' ')
    for (const m of text.matchAll(/\{\{workflow\.parameters\.([A-Za-z0-9_-]+)\}\}/g)) {
      assertEquals(declared.has(m[1]), true, `${s.id} uses undeclared parameter ${m[1]}`)
    }
  }
})

Deno.test('starter ids are unique and resolvable', () => {
  assertEquals(new Set(STARTERS.map((s) => s.id)).size, STARTERS.length)
  assertEquals(starterById('blank')?.id, 'blank')
  assertEquals(starterById('nope'), undefined)
})
