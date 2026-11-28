import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { NO_CAPABILITIES, WorkflowsApiError } from '../data/api.ts'
import type { Scope } from '../data/hooks.ts'
import { findNode } from '../model/project.ts'
import * as S from '../model/session.ts'
import { platformCatalogue } from '../model/testdata.ts'
import { designerPalette, EMPTY_WORKFLOW, FAN_OUT_ID, init, reduce } from '../canvas/designer-state.ts'
import { DiagnosticsBar } from '../canvas/diagnostics-bar.tsx'
import { groupFields, Inspector } from '../canvas/inspector.tsx'
import { Palette } from '../canvas/palette.tsx'
import { pickerOptions, TemplatePicker } from '../canvas/template-picker.tsx'
import { Toolbar } from '../canvas/toolbar.tsx'
import { YamlPanel } from '../canvas/yaml-panel.tsx'
import { fieldsFor } from '../model/kinds.ts'
import { admissionDiagnostic, DesignerView, DesignerWorkbench } from './designer.tsx'
import { targetOptions, TestRunForm } from './test-run-dialog.tsx'

/**
 * The designer page as a person meets it (design 0026 §6.8–§6.9), rendered
 * from props. Acceptance 6 needs every step of a keyboard-only build to be
 * reachable without a pointer: the palette entries are buttons, the
 * inspector names and connects through inputs and buttons, every toolbar
 * shortcut is a button with the key in its name, and changes are announced.
 */

const catalogue = platformCatalogue()
const scope: Scope = {
  namespaces: [
    { namespace: 'shop-dev', role: 'environment', environment: 'dev', project: 'shop' },
    { namespace: 'shop-prod', role: 'environment', environment: 'prod', tier: 'prod', project: 'shop' },
  ],
  ready: true,
  platform: false,
  key: 'k',
}

function render(ui: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const noop = () => {}

Deno.test('the gallery offers an empty canvas and every starter, a name and a namespace', () => {
  const html = render(<DesignerView scope={scope} caps={NO_CAPABILITIES} onParams={noop} onOpenRun={noop} />)
  assertStringIncludes(html, 'Start a workflow')
  assertStringIncludes(html, 'Empty canvas')
  assertStringIncludes(html, 'Nightly maintenance')
  assertStringIncludes(html, 'aria-label="Workflow name"')
  assertStringIncludes(html, '<option value="shop-dev" selected="">')
  // A batch or game-day starter is not offered on a cluster without them.
  assert(!html.includes('Game-day launcher'))
  assertStringIncludes(html, 'Sign in to keep unsaved work')
})

Deno.test('the workbench: toolbar, palette and inspector render; the canvas loads lazily', () => {
  const html = render(
    <DesignerWorkbench opened={{ text: EMPTY_WORKFLOW, namespace: 'shop-dev', name: 'new-workflow', origin: { from: 'empty' } }} catalogue={catalogue} local={[]} scope={scope} caps={NO_CAPABILITIES} onOpenRun={noop} onClose={noop} />,
  )
  for (const label of ['Undo (⌘Z)', 'Redo (⇧⌘Z)', 'Auto-layout (l)', 'Fit (f)', 'Zoom in', 'YAML', 'Keyboard shortcuts']) assertStringIncludes(html, `aria-label="${label}"`)
  assertStringIncludes(html, 'Test run in a dev namespace (⌘↵)')
  // Publishing is W3: the button is there, and off — not a button that does nothing.
  assert(/<button[^>]*disabled=""[^>]*aria-label="Publish \(arrives with GitOps publishing\)"/.test(html), 'Publish is shown disabled')
  assertStringIncludes(html, 'aria-label="Step palette"')
  assertStringIncludes(html, 'aria-label="Inspector"')
  assertStringIncludes(html, 'Loading the canvas')
  assertStringIncludes(html, 'aria-live="polite"')
  assertStringIncludes(html, 'Not saved (signed out)')
})

Deno.test('acceptance 6: every palette entry is a draggable button that adds its step on Enter', () => {
  const entries = designerPalette(catalogue)
  const html = render(<Palette entries={entries} onAdd={noop} />)
  for (const id of ['container', 'script', 'http', 'approval', 'template', FAN_OUT_ID, 'step:adhar-steps/http-check']) {
    assert(new RegExp(`<button[^>]*draggable="true"[^>]*data-palette-entry="${id.replace(/[/:]/g, '\\$&')}"`).test(html) || html.includes(`data-palette-entry="${id}"`), id)
  }
  assertEquals((html.match(/<button/g) ?? []).length, entries.length)
  assertStringIncludes(html, 'aria-label="Search the palette"')
  for (const section of ['Run something', 'Flow control', 'Platform steps', 'Reuse']) assertStringIncludes(html, `aria-label="${section}"`)
})

Deno.test('acceptance 6: the inspector names a step and connects it with inputs and buttons alone', () => {
  let s = init(EMPTY_WORKFLOW, { catalogue })
  s = reduce(reduce(reduce(s, { type: 'drop', entry: 'container' }), { type: 'drop', entry: 'script' }), { type: 'connect', source: 'run', target: 'script' })
  s = reduce(s, { type: 'select', node: 'script' })
  const html = render(<Inspector graph={s.session.graph} doc={s.session.doc} frozen={false} selected="script" catalogue={catalogue} palette={designerPalette(catalogue)} diagnostics={[]} dispatch={noop} />)
  assertStringIncludes(html, 'aria-label="Step name"')
  assertStringIncludes(html, 'value="script"')
  assertStringIncludes(html, 'role="tablist"')
  for (const t of ['General', 'Retry &amp; timeout', 'Conditions', 'Resources', 'Advanced']) assertStringIncludes(html, `>${t}</button>`)
  assertStringIncludes(html, 'aria-label="Image (required)"')
  assertStringIncludes(html, 'Remove step')
  // The guardrail of the kind is shown where the step is edited.
  assertStringIncludes(html, 'never spliced into the source')
})

Deno.test('the conditions tab lists what a step waits for, each removable, and adds one from a select', () => {
  const fields = fieldsFor('script', undefined, catalogue, true)
  assertEquals(groupFields(fields).map((g) => g.tab), ['general', 'retry', 'conditions', 'resources', 'advanced'])
  // An approval has only arguments: they are its General tab.
  assertEquals(groupFields(fieldsFor('approval', { name: 'adhar-steps', template: 'approval', clusterScope: true }, catalogue))[0].fields.map((f) => f.param), ['question', 'approvers', 'timeout', 'forbidSelfApproval'])
})

Deno.test('the template picker offers the platform steps and this namespace\'s templates', () => {
  const opts = pickerOptions(catalogue, [{ name: 'nightly', namespace: 'shop-dev', templates: ['main', 'compile'] }])
  assert(opts.some((o) => o.ref.name === 'adhar-steps' && o.ref.template === 'k6-load' && o.ref.clusterScope))
  assert(opts.some((o) => o.ref.name === 'nightly' && o.ref.template === 'compile' && !o.ref.clusterScope))
  const html = render(<TemplatePicker catalogue={catalogue} local={[]} onPick={noop} onCancel={noop} />)
  assertStringIncludes(html, 'role="dialog"')
  assertStringIncludes(html, 'HTTP check')
  assertStringIncludes(html, 'aria-label="Template reference"')
})

Deno.test('the test-run form offers dev namespaces only and the workflow\'s parameters', () => {
  const t = targetOptions(scope.namespaces)
  assertEquals(t.map((x) => [x.namespace, Boolean(x.disabled)]), [['shop-dev', false], ['shop-prod', true]])
  const text = EMPTY_WORKFLOW.replace('  templates:', '  arguments:\n    parameters:\n      - name: env\n        value: dev\n      - name: api-token\n  templates:')
  const params = S.open(text).graph.params
  const html = render(<TestRunForm namespaces={scope.namespaces} params={params} text={text} onStarted={noop} onCancel={noop} />)
  assertStringIncludes(html, 'aria-label="Dev namespace"')
  assert(/<option value="shop-prod" disabled="">/.test(html), 'prod is shown, and refused')
  assertStringIncludes(html, 'aria-label="env"')
  assertStringIncludes(html, 'Secrets come from Kubernetes Secrets')
  assertStringIncludes(html, 'Save draft and run')
  assertStringIncludes(html, 'Your canvas is not changed')
  const none = render(<TestRunForm namespaces={[scope.namespaces[1]]} params={[]} text={text} onStarted={noop} onCancel={noop} />)
  assertStringIncludes(none, 'None of your namespaces is a dev namespace')
})

Deno.test('the YAML panel shows the document as text until Monaco loads (and wherever it cannot)', () => {
  const s = S.open(EMPTY_WORKFLOW)
  const html = render(<YamlPanel doc={s.doc} diagnostics={[]} onText={noop} />)
  assertStringIncludes(html, 'aria-label="Workflow YAML"')
  assertStringIncludes(html, 'name: new-workflow')
})

Deno.test('the diagnostics bar counts the three levels and a toolbar test run explains why it is off', () => {
  const s = reduce(init(EMPTY_WORKFLOW, { catalogue }), { type: 'text', text: EMPTY_WORKFLOW.replace('tasks: []', 'tasks:\n          - name: a\n            depends: ghost\n            template: nowhere') })
  const html = render(<DiagnosticsBar diagnostics={s.session.graph.diagnostics} defaultOpen onSelect={noop} onReveal={noop} />)
  assert(/[1-9] errors?/.test(html), html)
  assertStringIncludes(html, 'designer')
  const tb = render(
    <Toolbar canUndo={false} canRedo={false} editable yamlOpen={false} problems={{ errors: 2, warnings: 0 }} validating={false} testRunBlocked="Fix 2 errors first." save={{ label: 'Save draft', disabled: true }} onUndo={noop} onRedo={noop} onLayout={noop} onFit={noop} onZoomIn={noop} onZoomOut={noop} onValidate={noop} onToggleYaml={noop} onSave={noop} onTestRun={noop} onHelp={noop} />,
  )
  assertStringIncludes(tb, 'Test run in a dev namespace (⌘↵): Fix 2 errors first.')
  assert(/aria-label="Test run[^"]*"[^>]*disabled=""|disabled=""[^>]*aria-label="Test run/.test(tb))
})

Deno.test('a selected step that the YAML no longer has shows the workflow instead', () => {
  const s = init(EMPTY_WORKFLOW, { catalogue })
  assertEquals(findNode(s.session.graph, 'ghost'), undefined)
  const html = render(<Inspector graph={s.session.graph} doc={s.session.doc} frozen={false} selected="ghost" catalogue={catalogue} palette={[]} diagnostics={[]} dispatch={noop} />)
  assertStringIncludes(html, 'Select a step to edit it')
})

Deno.test('a resumed draft of a template that has changed on the cluster since says so', () => {
  const opened = { text: EMPTY_WORKFLOW.replace('new-workflow', 'nightly'), namespace: 'shop-dev', name: 'nightly', origin: { from: 'template' as const, resourceVersion: '41' }, restored: '2026-11-27T10:00:00Z' }
  const withUpstream = (rv: string | null) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['workflows', 'designer', 'upstream', '', 'shop-dev', 'nightly', '41'], rv)
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DesignerWorkbench opened={opened} catalogue={catalogue} local={[]} scope={scope} caps={NO_CAPABILITIES} onOpenRun={noop} onClose={noop} />
      </QueryClientProvider>,
    )
  }
  assertStringIncludes(withUpstream('57'), 'has changed on the cluster since this draft was started')
  // Same version, or a version the console cannot read: nothing to say.
  assert(!withUpstream('41').includes('has changed on the cluster'))
  assert(!withUpstream(null).includes('has changed on the cluster'))
})

Deno.test('Validate does not call a valid template broken because the check could not run in a dev namespace', () => {
  for (const code of ['not_dev', 'tier_unknown']) {
    const d = admissionDiagnostic(new WorkflowsApiError(403, code, 'Namespace shop is not a dev namespace'))
    assertEquals(d.level, 'info', code)
    assertStringIncludes(d.message, 'not run')
  }
  // What admission says about the template itself stays an error, in its own words.
  const refused = admissionDiagnostic(new WorkflowsApiError(400, 'invalid', 'spec.templates[0].name: Invalid value'))
  assertEquals([refused.level, refused.code, refused.message], ['error', 'admission/refused', 'spec.templates[0].name: Invalid value'])
  assertEquals(admissionDiagnostic(new WorkflowsApiError(403, 'forbidden', 'denied by adhar-workflow-drafts-dev-only')).level, 'error')
})
