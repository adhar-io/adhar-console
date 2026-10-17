import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { workflowToArgo, slug } from './argo-export.ts'
import { defaultProjectFor, normalizeProject } from './project.ts'
import { extractFence } from './html-to-nodes.ts'
import { designThemeVars } from './design-theme.ts'

Deno.test('workflow → Argo WorkflowTemplate DAG, triggers skipped, deps follow connections', () => {
  const yaml = workflowToArgo(
    JSON.stringify({
      steps: [
        { id: 't', type: 'trigger', name: 'Schedule', config: { schedule: '*/5 * * * *' } },
        { id: 'a', type: 'action', name: 'HTTP Request', config: { method: 'POST', url: 'https://x.test/hook' } },
        { id: 'd', type: 'delay', name: 'Delay', config: { delayValue: 2, delayUnit: 'minutes' } },
      ],
      connections: [{ from: 't', to: 'a' }, { from: 'a', to: 'd' }],
    }),
    'Nightly Sync',
  )!
  assertStringIncludes(yaml, 'kind: WorkflowTemplate')
  assertStringIncludes(yaml, 'name: "nightly-sync"')
  assertStringIncludes(yaml, 'template: "http-request-1"')
  assertStringIncludes(yaml, 'dependencies: ["http-request-1"]')
  assertStringIncludes(yaml, 'duration: "2m"')
  assertStringIncludes(yaml, '"-X", "POST", "https://x.test/hook"')
  // The cron trigger becomes a CronWorkflow pointing at the template.
  assertStringIncludes(yaml, 'kind: CronWorkflow')
  assertStringIncludes(yaml, 'schedule: "*/5 * * * *"')
  assert(!yaml.includes('schedule-'), 'triggers are not tasks')
})

Deno.test('workflow with only triggers or bad JSON exports nothing', () => {
  assertEquals(workflowToArgo('{"steps":[{"id":"t","type":"trigger","name":"Webhook"}]}', 'x'), null)
  assertEquals(workflowToArgo('{not json', 'x'), null)
})

Deno.test('slug is DNS-safe', () => {
  assertEquals(slug('  My  Flow!! v2 '), 'my-flow-v2')
  assertEquals(slug('***'), 'workflow')
})

Deno.test('normalizeProject accepts the standalone builder file array and rejects junk', () => {
  const arr = defaultProjectFor('workflow').files
  assertEquals(normalizeProject(arr, 'legacy')?.name, 'legacy')
  assertEquals(normalizeProject({ nope: 1 }), null)
  assertEquals(normalizeProject(null), null)
  assertEquals(normalizeProject({ files: [], settings: { framework: 'svelte' } })?.settings.theme, 'adhar')
})

Deno.test('extractFence prefers the requested language', () => {
  const reply = 'Here:\n```css\na{}\n```\nand\n```html\n<div>x</div>\n```'
  assertEquals(extractFence(reply, ['html']), '<div>x</div>')
  assertEquals(extractFence(reply), 'a{}')
  assertEquals(extractFence('no code'), null)
})

Deno.test('design theme vars map onto --b-* with mode-scoped overrides', () => {
  const light = designThemeVars('adhar', false, { 'light.primary': '0 100% 50%', 'dark.primary': '120 100% 50%' })
  assertEquals(light['--b-primary'], 'hsl(0 100% 50%)')
  assertEquals(light['--b-primary-foreground'], 'hsl(0 0% 100%)')
  const dark = designThemeVars('adhar', true, { 'dark.primary': '120 100% 50%' })
  assertEquals(dark['--b-primary'], 'hsl(120 100% 50%)')
})
