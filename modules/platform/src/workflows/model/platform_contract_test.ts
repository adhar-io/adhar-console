import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { parse, toJS } from './doc.ts'
import { APPROVAL_REF, BATCH_STEPS_LIBRARY, fieldsFor, GAMEDAY_STEPS_LIBRARY, palette, STEPS_LIBRARY } from './kinds.ts'
import { STARTERS } from './starters.ts'
import { platformCatalogue } from './testdata.ts'

/**
 * What the designer writes by NAME into a workflow, held to the step libraries
 * the platform ships (W2 integration, 2026-11-28; design 0026 drift 45).
 *
 * The palette reads its platform steps from the cluster, so it cannot drift.
 * What can is what the console spells out itself: the starters' templateRefs
 * and their arguments, and the approval entry the palette shows when it has
 * no catalogue to read. A starter that names a template the catalogue does not
 * ship, or passes an argument the template does not declare, opens clean in
 * the designer and is refused by argo-server on its first run; one that omits
 * a required argument fails at submit. `platformCatalogue()` is read from the
 * vendored copies in corpus/platform/, which roundtrip_test.ts holds byte for
 * byte to the adhar stack.
 */

const CATALOGUE = platformCatalogue()
const LIBRARIES = new Set([STEPS_LIBRARY, BATCH_STEPS_LIBRARY, GAMEDAY_STEPS_LIBRARY])

/**
 * Referenced by a starter but not shipped yet. Each must be hidden behind a
 * capability the platform does not report until it ships (§8.4, G1).
 */
const NOT_SHIPPED_YET: Readonly<Record<string, 'gamedays'>> = { 'adhar-steps/run-gameday': 'gamedays' }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Every task (DAG or steps) of every template in a parsed workflow document. */
function tasksOf(doc: Obj): Obj[] {
  const spec = obj(doc.spec)
  const templates = list(obj(spec.workflowSpec).templates ?? spec.templates)
  const out: Obj[] = []
  for (const t of templates.map(obj)) {
    for (const task of list(obj(t.dag).tasks)) out.push(obj(task))
    for (const group of list(t.steps)) for (const step of list(group)) out.push(obj(step))
  }
  return out
}

Deno.test('every platform step a starter calls is one the catalogue ships, with the arguments it declares', () => {
  const shipped = new Map(CATALOGUE.map((s) => [`${s.ref.name}/${s.ref.template}`, s]))
  let calls = 0
  for (const s of STARTERS) {
    for (const task of tasksOf(obj(toJS(parse(s.yaml))))) {
      const ref = obj(task.templateRef)
      if (ref.clusterScope !== true || !LIBRARIES.has(String(ref.name))) continue
      calls++
      const id = `${ref.name}/${ref.template}`
      const step = shipped.get(id)
      if (!step) {
        const gate = NOT_SHIPPED_YET[id]
        assert(gate, `starter ${s.id} task ${task.name} calls ${id}, which the platform catalogue does not ship (it ships ${[...shipped.keys()].join(', ')})`)
        assertEquals(s.requires, gate, `starter ${s.id} calls the unshipped ${id} without being gated on ${gate}`)
        continue
      }
      const passed = list(obj(task.arguments).parameters).map((p) => String(obj(p).name))
      const declared = new Set(step.inputs.map((i) => i.name))
      for (const p of passed) assert(declared.has(p), `starter ${s.id} task ${task.name} passes ${p} to ${id}, which declares only ${[...declared].join(', ')}`)
      for (const i of step.inputs.filter((x) => x.required)) assert(passed.includes(i.name), `starter ${s.id} task ${task.name} omits ${id}'s required input ${i.name}`)
    }
  }
  // The test is not vacuous: the smoke, approval, game-day and batch starters call platform steps.
  assert(calls >= 7, `only ${calls} platform-step calls found in the starters`)
  for (const id of Object.keys(NOT_SHIPPED_YET)) assert(!shipped.has(id), `${id} ships now: remove it from NOT_SHIPPED_YET`)
})

Deno.test('the approval the palette shows without a catalogue is the one the catalogue ships', () => {
  const shipped = CATALOGUE.find((s) => s.ref.name === APPROVAL_REF.name && s.ref.template === APPROVAL_REF.template)
  assert(shipped, `the catalogue ships no ${APPROVAL_REF.name}/${APPROVAL_REF.template}`)
  const view = (fields: ReturnType<typeof fieldsFor>) => fields.filter((f) => f.param).map((f) => ({ param: f.param, placeholder: f.placeholder, options: f.options, required: f.required }))
  assertEquals(view(fieldsFor('approval', APPROVAL_REF)), view(fieldsFor('approval', APPROVAL_REF, CATALOGUE)))
  const builtIn = palette().find((e) => e.id === 'approval')!
  const declared = new Set(shipped.inputs.map((i) => i.name))
  for (const a of builtIn.arguments ?? []) assert(declared.has(a.name), `the built-in approval passes ${a.name}, which ${APPROVAL_REF.name}/approval does not declare`)
  // The guarded `when` the guardrail tells people to write reads an output the step has, with a value it can take.
  assert(shipped.outputs.includes('decision'))
  assert(builtIn.guardrails.some((g) => g.includes('outputs.parameters.decision}} == approve')))
})
