import { assert, assertEquals } from 'jsr:@std/assert@1'
import { type DesignerState, designerDiagnostics, EMPTY_WORKFLOW, FAN_OUT_ID, init, reduce } from '../../../../../modules/platform/src/workflows/canvas/designer-state.ts'
import { prepareTestRun } from '../../../../../modules/platform/src/workflows/data/drafts.ts'
import { platformCatalogue } from '../../../../../modules/platform/src/workflows/model/testdata.ts'
import { hasErrors } from '../../../../../modules/platform/src/workflows/model/validate.ts'
import * as S from '../../../../../modules/platform/src/workflows/model/session.ts'
import { DRAFT_EXPIRES_ANNOTATION, DRAFT_LABEL, draftExpiry, parseTestRun, stampDraft, testRunManifest } from './drafts.ts'

/**
 * W2 acceptance 2, as far as it goes offline: a 6-node DAG built by drag and
 * drop in the designer (the reducer the canvas drives) is test-run through the
 * BFF's own request validation and draft stamping, and what the server would
 * apply is still the same workflow — six steps, no errors — in the same
 * namespace, named as the user's draft, labelled for Kyverno #7 and the
 * janitor. The browser and the server agree on the label, the annotation and
 * the seven days. The live half (Argo running it) is owed on a cluster.
 */

const opts = { catalogue: platformCatalogue() }

function sixNodes(): DesignerState {
  let s = init(EMPTY_WORKFLOW.replace('name: new-workflow', 'name: release-check'), opts)
  for (const [entry, x] of [['container', 0], ['script', 320], ['http', 640], ['approval', 960], ['template', 1280]] as const) s = reduce(s, { type: 'drop', entry, at: { x, y: 100 } })
  s = reduce(s, { type: 'pick', ref: { name: 'adhar-steps', template: 'wait-healthy', clusterScope: true } })
  s = reduce(s, { type: 'drop', entry: FAN_OUT_ID, at: { x: 1600, y: 100 } })
  const ids = s.session.graph.nodes.map((n) => n.uid)
  for (let i = 1; i < ids.length; i++) s = reduce(s, { type: 'connect', source: ids[i - 1], target: ids[i] })
  return s
}

Deno.test('acceptance 2 (offline): the drag-and-drop DAG passes the BFF test-run validation and stamping unchanged in substance', () => {
  const s = sixNodes()
  assertEquals(s.session.graph.nodes.length, 6)
  assert(!hasErrors(designerDiagnostics(s)))
  const now = new Date('2026-11-28T09:00:00Z')
  const prepared = prepareTestRun(S.text(s.session), now, 'shop-dev')
  assert(prepared.ok)

  // What the browser sends (`api.ts` testRunDraft) is what the route accepts.
  const body = parseTestRun({ yaml: prepared.yaml, parameters: {} })
  assert(body.ok, body.ok ? '' : body.detail)
  const stamped = stampDraft(body.value.yaml, { namespace: 'shop-dev', kubeUser: 'oidc:ana', expires: draftExpiry(now.getTime()) })
  assert(stamped.ok, stamped.ok ? '' : stamped.detail)
  assertEquals(stamped.value.name, 'release-check-draft-ana')
  // Browser and server compute the same seven days.
  assertEquals(stamped.value.expires, prepared.expires)

  // The server's text opens in the designer as the same six-step workflow.
  const back = S.open(stamped.value.yaml, opts)
  assertEquals(back.graph.nodes.map((n) => n.kind), s.session.graph.nodes.map((n) => n.kind))
  assertEquals(back.graph.edges.length, 5)
  assert(!hasErrors(back.graph.diagnostics))
  assert(stamped.value.yaml.includes(`${DRAFT_LABEL}: "true"`))
  assert(stamped.value.yaml.includes(`${DRAFT_EXPIRES_ANNOTATION}: "${prepared.expires}"`))
  // The person's own document was never stamped (it is what they will publish).
  assert(!S.text(s.session).includes(DRAFT_LABEL))

  // The run the server then creates refers to that draft.
  const run = testRunManifest('shop-dev', stamped.value.name, []) as { spec: { workflowTemplateRef: { name: string } } }
  assertEquals(run.spec.workflowTemplateRef.name, 'release-check-draft-ana')
})
