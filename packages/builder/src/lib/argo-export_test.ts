import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { slug, workflowToArgo } from './argo-export.ts'

/**
 * The exporter targets Argo Workflows v4 (the platform pins v4.1.6). Every
 * rule pinned here is one the v4.1.6 controller enforces in
 * `workflow/validate/validate.go`; the full YAML below was also run through
 * that validator (`validate.WorkflowTemplate` / `validate.CronWorkflow`) when
 * the v4 shape was introduced.
 */

const wf = (steps: unknown[], connections: unknown[] = []) => JSON.stringify({ steps, connections })
const cron = (id: string, schedule: unknown) => ({ id, type: 'trigger', name: 'Schedule', config: { schedule } })

/** The CronWorkflow document, or undefined when the export has none. */
const cronDoc = (yaml: string) => yaml.split('\n---\n').find((d) => d.includes('kind: CronWorkflow'))

/** The `schedules` list of the CronWorkflow, read back as JSON (it is a flow sequence of JSON strings). */
const schedulesOf = (yaml: string): string[] | undefined => {
  const line = cronDoc(yaml)?.split('\n').find((l) => l.startsWith('  schedules: '))
  return line ? JSON.parse(line.slice('  schedules: '.length)) : undefined
}

Deno.test('workflow → Argo WorkflowTemplate DAG, triggers skipped, deps follow connections', () => {
  const yaml = workflowToArgo(
    wf(
      [
        cron('t', '*/5 * * * *'),
        { id: 'a', type: 'action', name: 'HTTP Request', config: { method: 'POST', url: 'https://x.test/hook' } },
        { id: 'd', type: 'delay', name: 'Delay', config: { delayValue: 2, delayUnit: 'minutes' } },
      ],
      [{ from: 't', to: 'a' }, { from: 'a', to: 'd' }],
    ),
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
  assertEquals(schedulesOf(yaml), ['*/5 * * * *'])
  assert(!yaml.includes('schedule-'), 'triggers are not tasks')
})

Deno.test('the whole export is the v4 shape, line for line', () => {
  const yaml = workflowToArgo(
    wf(
      [
        cron('t1', '0 9 * * 1-5'),
        cron('t2', ' 0  0 * * * '),
        { id: 'h', type: 'action', name: 'HTTP Request', config: { method: 'POST', url: 'https://x.test/hook' } },
        { id: 'a', type: 'action', name: '2FA check', config: { message: 'verify' } },
        { id: 'd', type: 'delay', name: 'Delay', config: { delayValue: 2, delayUnit: 'minutes' } },
      ],
      [{ from: 't1', to: 'h' }, { from: 'h', to: 'a' }, { from: 'a', to: 'd' }],
    ),
    'Nightly Sync',
  )
  assertEquals(
    yaml,
    [
      'apiVersion: argoproj.io/v1alpha1',
      'kind: WorkflowTemplate',
      'metadata:',
      '  name: "nightly-sync"',
      '  labels:',
      '    app.kubernetes.io/managed-by: "adhar-builder"',
      'spec:',
      '  entrypoint: "main"',
      '  templates:',
      '    - name: "main"',
      '      dag:',
      '        tasks:',
      '          - name: "http-request-1"',
      '            template: "http-request-1"',
      '          - name: "step-2fa-check-2"',
      '            template: "step-2fa-check-2"',
      '            dependencies: ["http-request-1"]',
      '          - name: "delay-3"',
      '            template: "delay-3"',
      '            dependencies: ["step-2fa-check-2"]',
      '    - name: "http-request-1"',
      '      container:',
      '        image: "curlimages/curl:8.10.1"',
      '        args: ["-sSfL", "-X", "POST", "https://x.test/hook"]',
      '    - name: "step-2fa-check-2"',
      '      container:',
      '        image: "alpine:3.20"',
      '        command: ["sh", "-c"]',
      '        args: ["echo \\"[2FA check] verify\\""]',
      '    - name: "delay-3"',
      '      suspend:',
      '        duration: "2m"',
      '---',
      'apiVersion: argoproj.io/v1alpha1',
      'kind: CronWorkflow',
      'metadata:',
      '  name: "nightly-sync"',
      '  labels:',
      '    app.kubernetes.io/managed-by: "adhar-builder"',
      'spec:',
      '  schedules: ["0 9 * * 1-5", "0 0 * * *"]',
      '  concurrencyPolicy: "Forbid"',
      '  workflowSpec:',
      '    workflowTemplateRef:',
      '      name: "nightly-sync"',
      '',
    ].join('\n'),
  )
})

Deno.test('a CronWorkflow never carries the singular `schedule` v4 removed', () => {
  // v4 decodes `spec.schedule` into nothing and then refuses the CronWorkflow
  // ("cron workflow must have at least one schedule"): it would be stored and never run.
  const yaml = workflowToArgo(wf([cron('t', '0 2 * * *'), { id: 'a', type: 'action', name: 'Log' }]), 'nightly')!
  const doc = cronDoc(yaml)!
  assert(!/^\s*schedule:/m.test(doc), doc)
  assertEquals(schedulesOf(yaml), ['0 2 * * *'])
})

Deno.test('every distinct cron trigger is one entry of `schedules`, in canvas order', () => {
  const yaml = workflowToArgo(
    wf([
      cron('t1', '0 9 * * 1-5'),
      cron('t2', '0 0 * * *'),
      cron('t3', '0   9 * * 1-5'), // the first one again, spaced differently
      cron('t4', 'every five minutes'), // not a cron expression: ignored
      cron('t5', 42), // not a string: ignored
      { id: 'w', type: 'trigger', name: 'Webhook', config: { webhookUrl: 'https://x.test' } },
      { id: 'a', type: 'action', name: 'Log' },
    ]),
    'two schedules',
  )!
  assertEquals(schedulesOf(yaml), ['0 9 * * 1-5', '0 0 * * *'])
  // One CronWorkflow carries them all.
  assertEquals(yaml.split('\n---\n').filter((d) => d.includes('kind: CronWorkflow')).length, 1)
})

Deno.test('no cron trigger, no CronWorkflow', () => {
  const yaml = workflowToArgo(wf([cron('t', 'whenever'), { id: 'a', type: 'action', name: 'Log' }]), 'x')!
  assertEquals(cronDoc(yaml), undefined)
  assert(!yaml.includes('schedules'))
})

Deno.test('no DAG task name starts with a digit (v4 refuses one that has dependencies)', () => {
  const yaml = workflowToArgo(
    wf(
      [
        { id: 'a', type: 'action', name: '1st call' },
        { id: 'b', type: 'action', name: '2FA check' },
        { id: 'c', type: 'action', name: '42' },
        { id: 'd', type: 'action', name: `9${'x'.repeat(80)}` },
      ],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }],
    ),
    'digits',
  )!
  const names = [...yaml.matchAll(/^ {10}- name: "([^"]+)"$/gm)].map((m) => m[1])
  assertEquals(names.length, 4)
  for (const n of names) {
    assert(/^[a-z][-a-z0-9]*[a-z0-9]$/.test(n), `${n} is not a DNS label that starts with a letter`)
    assert(n.length <= 63, `${n} is longer than 63`)
  }
  assertEquals(names.slice(0, 3), ['step-1st-call-1', 'step-2fa-check-2', 'step-42-3'])
  // Every dependency names a task that exists.
  for (const m of yaml.matchAll(/dependencies: \[(.*)\]/g)) {
    for (const dep of JSON.parse(`[${m[1]}]`) as string[]) assert(names.includes(dep), dep)
  }
})

/** An RFC 1123 name: what the API server accepts as `metadata.name`. */
const DNS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

Deno.test('names stay DNS-safe and fit Argo’s limits', () => {
  for (const title of ['A'.repeat(90), `${'a'.repeat(51)} b`]) {
    const yaml = workflowToArgo(wf([cron('t', '* * * * *'), { id: 'a', type: 'action', name: 'Log' }]), title)!
    // Both documents carry the one name. A CronWorkflow name over 52
    // characters is refused (its runs append `-<unix time>`), and a name that
    // ends with a hyphen is refused by the API server.
    const names = [...yaml.matchAll(/^ {2}name: (".*")$/gm)].map((m) => JSON.parse(m[1]) as string)
    assertEquals(names.length, 2, yaml)
    for (const name of names) {
      assert(name.length <= 52, name)
      assert(DNS_NAME.test(name), `${name} is not a valid object name`)
    }
  }
})

Deno.test('workflow with only triggers or bad JSON exports nothing', () => {
  assertEquals(workflowToArgo('{"steps":[{"id":"t","type":"trigger","name":"Webhook"}]}', 'x'), null)
  assertEquals(workflowToArgo('{not json', 'x'), null)
})

Deno.test('slug is DNS-safe', () => {
  assertEquals(slug('  My  Flow!! v2 '), 'my-flow-v2')
  assertEquals(slug('***'), 'workflow')
  // The 52-character cut lands on the separator: the hyphen it leaves is trimmed.
  assertEquals(slug(`${'a'.repeat(51)} b`), 'a'.repeat(51))
  for (const s of [`${'a'.repeat(51)} b`, `${'x'.repeat(50)}--yy`, '-lead', 'trail-', 'Ünïcode only ✓', '9 lives']) {
    const v = slug(s)
    assert(v.length <= 52 && DNS_NAME.test(v), `${JSON.stringify(s)} → ${JSON.stringify(v)}`)
  }
})
