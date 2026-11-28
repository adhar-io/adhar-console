import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import { getIn, parse, sameContent } from '../model/doc.ts'
import { DRAFT_EXPIRES_ANNOTATION, DRAFT_LABEL } from '../model/ops.ts'
import { EMPTY_WORKFLOW } from '../canvas/designer-state.ts'
import { DebouncedSave, draftAt, draftId, myDrafts, staleDraft, objectToYaml, prepareTestRun, readDraft, testRunTargets } from './drafts.ts'

/** W2-C3: the autosave's keys and the test run's stamped copy (§4.5, §6.9). */

Deno.test('a test run sends a stamped COPY: label "true", expiry seven days on, the rest byte-for-byte', () => {
  const text = `${EMPTY_WORKFLOW}# kept\n`.replace('tasks: []', 'tasks: []\n  arguments:\n    parameters:\n      - name: mode\n        value: 0644')
  const r = prepareTestRun(text, new Date('2026-11-28T09:30:15.123Z'))
  assert(r.ok)
  assertEquals(r.expires, '2026-12-05T09:30:15Z')
  const d = parse(r.yaml)
  assertEquals(getIn(d, ['metadata', 'labels', DRAFT_LABEL]), 'true')
  assertEquals(getIn(d, ['metadata', 'annotations', DRAFT_EXPIRES_ANNOTATION]), '2026-12-05T09:30:15Z')
  // Written quoted: the API server must read a string, not a boolean or a timestamp.
  assert(r.yaml.includes(`${DRAFT_LABEL}: "true"`), r.yaml)
  assert(r.yaml.includes(`${DRAFT_EXPIRES_ANNOTATION}: "2026-12-05T09:30:15Z"`), r.yaml)
  // Number spelling and comments are the author's (YAML 1.1 reads 0644 as 420; JSON would have sent 644).
  assert(r.yaml.includes('value: 0644'))
  assert(r.yaml.includes('# kept'))
  // The input is not touched.
  assert(!text.includes(DRAFT_LABEL))
  assert(!sameContent(parse(text), d))
})

Deno.test('the stamped copy is placed in the namespace the test run goes to', () => {
  const r = prepareTestRun(EMPTY_WORKFLOW.replace('name: new-workflow', 'name: nightly\n  namespace: shop-prod'), new Date(), 'shop-dev')
  assert(r.ok)
  assertEquals(getIn(parse(r.yaml), ['metadata', 'namespace']), 'shop-dev')
})

Deno.test('a text that does not parse is refused, not repaired', () => {
  const r = prepareTestRun('kind: WorkflowTemplate\nspec: [1, 2\n', new Date())
  assert(!r.ok)
  assert(/does not parse/.test(r.detail))
})

Deno.test('autosave ids are per user, namespace and template, inside the store alphabet', () => {
  assertEquals(draftId('8f1c-user', 'shop-dev', 'nightly'), '8f1c-user.shop-dev.nightly')
  assert(/^jane-doe-example-com\.shop-dev\.nightly-build\.[0-9a-f]{8}$/.test(draftId('Jane.Doe@Example.com', 'shop-dev', 'Nightly Build')))
  assert(draftId('u'.repeat(200), 'n'.repeat(100), 't'.repeat(100)).length <= 128)
  assertThrows(() => draftId('', 'shop-dev', 'nightly'), Error, 'no user')
})

Deno.test('two different templates never share an autosave, however long or oddly spelled their names', () => {
  // The store PUTs by id: one shared id is one draft silently replacing another.
  const pairs: Array<[[string, string, string], [string, string, string]]> = [
    // template names (up to 253 characters on the cluster) that differ only after the cut
    [['u', 'shop-dev', `${'nightly-billing-report-for-customers'.padEnd(60, 'x')}-eu`], ['u', 'shop-dev', `${'nightly-billing-report-for-customers'.padEnd(60, 'x')}-us`]],
    // namespaces (63) that differ only after the cut
    [['u', `${'team-payments-checkout'.padEnd(50, 'x')}-prod`, 'w'], ['u', `${'team-payments-checkout'.padEnd(50, 'x')}-dev1`, 'w']],
    // folded the same way
    [['Alice', 'ns', 'w'], ['alice', 'ns', 'w']],
    [['a.b', 'ns', 'w'], ['a-b', 'ns', 'w']],
    [['u', 'ns', 'a.b'], ['u', 'ns', 'a-b']],
  ]
  for (const [a, b] of pairs) {
    const x = draftId(...a)
    const y = draftId(...b)
    assert(x !== y, `${a.join('|')} and ${b.join('|')} share ${x}`)
    assert(x.length <= 128 && y.length <= 128)
  }
  // The same triple is always the same id (a reload finds its draft).
  assertEquals(draftId('Alice', 'ns', 'w'), draftId('Alice', 'ns', 'w'))
})

Deno.test('only my own drafts are listed (the store is shared by the tenant), newest first', () => {
  const item = (id: string, user: string, savedAt: string) => ({ id, data: { text: 'x', namespace: 'n', name: id, user, savedAt, origin: { from: 'empty' } }, createdBy: null, updatedBy: null, createdAt: '', updatedAt: '' })
  const mine = myDrafts([item('a', 'me', '2026-11-01'), item('b', 'you', '2026-11-03'), item('c', 'me', '2026-11-02'), { ...item('d', 'me', ''), data: { nope: true } } as never], 'me')
  assertEquals(mine.map((d) => d.id), ['c', 'a'])
  assertEquals(readDraft({ text: 1 }), null)
})

Deno.test('test runs go to dev namespaces; platform and other tiers are refused; unknown tiers are the server\'s call', () => {
  const t = testRunTargets([
    { namespace: 'shop', role: 'home', project: 'shop' },
    { namespace: 'shop-dev', role: 'environment', environment: 'dev', project: 'shop' },
    { namespace: 'shop-prod', role: 'environment', environment: 'prod', tier: 'prod', project: 'shop' },
    { namespace: 'shop-qa', role: 'environment', environment: 'qa', tier: 'dev', project: 'shop' },
    { namespace: 'adhar-system', role: 'platform' },
  ])
  assertEquals(t.dev.map((n) => n.namespace), ['shop-dev', 'shop-qa'])
  assertEquals(t.other.map((n) => n.namespace), ['shop-prod', 'adhar-system'])
  assertEquals(t.unknown.map((n) => n.namespace), ['shop'])
})

Deno.test('a template read from the cluster opens as the author wrote it, quoted for YAML 1.1', () => {
  const y = objectToYaml({
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { name: 'nightly', namespace: 'shop-dev', uid: 'u', resourceVersion: '9', managedFields: [{}], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' }, labels: { a: 'b' } },
    spec: { entrypoint: 'main', arguments: { parameters: [{ name: 'flag', value: 'yes' }, { name: 'mode', value: '0644' }] } },
    status: { x: 1 },
  })
  for (const gone of ['uid:', 'resourceVersion', 'managedFields', 'last-applied', 'status:', 'annotations']) assert(!y.includes(gone), gone)
  assert(y.includes('labels:'))
  assert(/value: ["']yes["']/.test(y), y)
  assert(/value: ["']0644["']/.test(y), y)
})

/** A clock the test turns by hand. */
function manualClock() {
  let next = 1
  const timers = new Map<number, () => void>()
  return {
    clock: { set: (f: () => void) => (timers.set(next, f), next++), clear: (t: unknown) => void timers.delete(t as number) },
    fire: () => [...timers.entries()].forEach(([k, f]) => (timers.delete(k), f())),
    waiting: () => timers.size,
  }
}

Deno.test('the autosave debounce: one save per pause, made on the way out, never after a discard', () => {
  let saves = 0
  const m = manualClock()
  const d = new DebouncedSave(() => void saves++, 1500, m.clock)
  // Typing: each edit restarts the wait; one save when it ends.
  d.schedule()
  d.schedule()
  d.schedule()
  assertEquals(m.waiting(), 1)
  m.fire()
  assertEquals(saves, 1)
  assert(!d.pending)
  // Closing the designer 0.5 s after an edit: the waiting save is made then, not dropped.
  d.schedule()
  d.flush()
  assertEquals(saves, 2)
  assertEquals(m.waiting(), 0)
  // Nothing waiting: closing saves nothing.
  d.flush()
  assertEquals(saves, 2)
  // Discard cancels: the discarded draft is not written back on the way out.
  d.schedule()
  d.cancel()
  d.flush()
  m.fire()
  assertEquals(saves, 2)
})

Deno.test('a new canvas under a name with unsaved work finds that draft (the gallery offers it back)', () => {
  const drafts = [{ namespace: 'shop-dev', name: 'nightly', text: 'a' }, { namespace: 'shop-qa', name: 'nightly', text: 'b' }]
  assertEquals(draftAt(drafts, 'shop-dev', 'nightly')?.text, 'a')
  assertEquals(draftAt(drafts, 'shop-qa', 'nightly')?.text, 'b')
  assertEquals(draftAt(drafts, 'shop-dev', 'weekly'), undefined)
})

Deno.test('a draft is stale only when its template has a NEW version on the cluster', () => {
  const origin = { from: 'template' as const, resourceVersion: '41' }
  assert(staleDraft(origin, '57'))
  assert(!staleDraft(origin, '41'))
  // Not readable or gone (the console cannot tell 403 from 404 here): no claim either way.
  assert(!staleDraft(origin, null))
  assert(!staleDraft(origin, undefined))
  // A draft that did not start from the cluster cannot be behind it.
  assert(!staleDraft({ from: 'starter', starter: 'nightly' }, '57'))
  assert(!staleDraft({ from: 'template' }, '57'))
})
