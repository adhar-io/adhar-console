import { assertEquals } from 'jsr:@std/assert'
import {
  configPath,
  DEFAULT_CONFIG,
  nameError,
  normaliseName,
  parseConfig,
  scriptPath,
  serialiseConfig,
  STARTERS,
  testNameFromPath,
} from './perf-format.ts'

/**
 * A test's config is hand-editable — it is a JSON file in a git repo that
 * people will edit in the console, in their editor, and in a pull request.
 * So the parser's job is to never lock anyone out: whatever it is handed, it
 * must produce a config the editor can open and fix.
 */

Deno.test('a well-formed config round-trips', () => {
  const c = {
    ...DEFAULT_CONFIG,
    title: 'Checkout load',
    description: 'Ramp to 20 VUs',
    namespace: 'payments',
    parallelism: 4,
    arguments: '--vus 50 --duration 30s',
    env: { BASE_URL: 'http://checkout' },
    thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
    tags: ['load'],
  }
  assertEquals(parseConfig(serialiseConfig(c), 'checkout-load'), c)
})

Deno.test('unparseable JSON still yields a usable config', () => {
  // Refusing to parse would lock someone out of the only screen that lets
  // them repair the file.
  const c = parseConfig('{ this is not json', 'checkout-load')
  assertEquals(c.title, 'Checkout Load')
  assertEquals(c.parallelism, 1)
  assertEquals(c.namespace, 'default')
})

Deno.test('a JSON array or scalar is not a config', () => {
  assertEquals(parseConfig('[1,2,3]', 'x').parallelism, 1)
  assertEquals(parseConfig('"hello"', 'x').title, 'X')
  assertEquals(parseConfig('null', 'my-test').title, 'My Test')
})

Deno.test('parallelism below one is corrected, not passed through', () => {
  // A TestRun with parallelism 0 is created and then never started; the
  // operator simply ignores it, which looks like the console losing the run.
  assertEquals(parseConfig('{"parallelism":0}', 'x').parallelism, 1)
  assertEquals(parseConfig('{"parallelism":-3}', 'x').parallelism, 1)
  assertEquals(parseConfig('{"parallelism":"nonsense"}', 'x').parallelism, 1)
  assertEquals(parseConfig('{"parallelism":2.7}', 'x').parallelism, 2)
  assertEquals(parseConfig('{"parallelism":8}', 'x').parallelism, 8)
})

Deno.test('env values are coerced to strings — k6 cannot take a number', () => {
  const c = parseConfig('{"env":{"VUS":50,"DEBUG":true,"NAME":"x","BAD":{"a":1}}}', 'x')
  assertEquals(c.env, { VUS: '50', DEBUG: 'true', NAME: 'x' })
})

Deno.test('malformed thresholds are dropped, not rendered half-formed', () => {
  const c = parseConfig(
    '{"thresholds":[{"metric":"a","expression":"b"},{"metric":"only"},"nope",null,{"expression":"orphan"}]}',
    'x',
  )
  assertEquals(c.thresholds, [{ metric: 'a', expression: 'b' }])
})

Deno.test('a target is kept only when it says something', () => {
  assertEquals(parseConfig('{"target":{}}', 'x').target, undefined)
  assertEquals(
    parseConfig('{"target":{"selector":"app=api","namespace":"payments"}}', 'x').target,
    { namespace: 'payments', selector: 'app=api', service: undefined },
  )
  // An empty target must not survive serialisation either.
  assertEquals(serialiseConfig({ ...DEFAULT_CONFIG, target: {} }).includes('target'), false)
})

Deno.test('serialised config is stable and newline-terminated', () => {
  const out = serialiseConfig(DEFAULT_CONFIG)
  assertEquals(out.endsWith('\n'), true)
  // Stable key order keeps git diffs about what changed.
  assertEquals(Object.keys(JSON.parse(out)), [
    'title',
    'description',
    'namespace',
    'parallelism',
    'arguments',
    'env',
    'thresholds',
    'tags',
  ])
})

/* ─────────── names ─────────── */

Deno.test('names are normalised into something Kubernetes accepts', () => {
  // The directory name is also the TestRun and ConfigMap name.
  assertEquals(normaliseName('Checkout Load Test'), 'checkout-load-test')
  assertEquals(normaliseName('  API__journey!! '), 'api-journey')
  assertEquals(normaliseName('--leading-and-trailing--'), 'leading-and-trailing')
  assertEquals(normaliseName('ALLCAPS'), 'allcaps')
})

Deno.test('normalising never leaves a trailing dash, even after truncation', () => {
  // 63 chars is the DNS-1123 limit; slicing can land on a dash, which is
  // invalid — and the apiserver rejects the whole object at launch time.
  const out = normaliseName(`${'a'.repeat(62)}-tail`)
  assertEquals(out.length <= 63, true)
  assertEquals(out.endsWith('-'), false)
})

Deno.test('name validation explains itself', () => {
  assertEquals(nameError('checkout-load'), null)
  assertEquals(nameError('a'), null)
  assertEquals(typeof nameError(''), 'string')
  assertEquals(typeof nameError('Checkout Load'), 'string')
  assertEquals(typeof nameError('-leading'), 'string')
  assertEquals(typeof nameError('trailing-'), 'string')
})

Deno.test('paths and the reverse mapping agree', () => {
  assertEquals(scriptPath('checkout-load'), 'tests/checkout-load/script.js')
  assertEquals(configPath('checkout-load'), 'tests/checkout-load/test.json')
  assertEquals(testNameFromPath('tests/checkout-load/script.js'), 'checkout-load')
  assertEquals(testNameFromPath('tests/checkout-load/test.json'), 'checkout-load')
  // Not a test path.
  assertEquals(testNameFromPath('README.md'), null)
  assertEquals(testNameFromPath('tests/checkout-load'), null)
})

/* ─────────── starters ─────────── */

Deno.test('every starter is a runnable k6 script that judges, not just measures', () => {
  for (const s of STARTERS) {
    const script = s.script('demo')
    assertEquals(script.includes('export default function'), true, `${s.id} needs an entry point`)
    assertEquals(script.includes('export const options'), true, `${s.id} needs options`)
    // A load test with no thresholds produces a number and no verdict, which
    // makes it useless as a gate.
    assertEquals(script.includes('thresholds'), true, `${s.id} must declare thresholds`)
    // `__ENV` is how the config's env reaches the script.
    assertEquals(script.includes('__ENV'), true, `${s.id} should be configurable by env`)
  }
})

Deno.test('starter configs merge into a valid config', () => {
  for (const s of STARTERS) {
    const merged = { ...DEFAULT_CONFIG, ...s.config('demo'), title: 'Demo' }
    const parsed = parseConfig(serialiseConfig(merged), 'demo')
    assertEquals(parsed.parallelism >= 1, true)
    assertEquals(parsed.title, 'Demo')
  }
})

Deno.test('starter ids are unique — they key the picker', () => {
  assertEquals(new Set(STARTERS.map((s) => s.id)).size, STARTERS.length)
})
