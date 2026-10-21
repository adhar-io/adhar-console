import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { renderContent } from './template-render.ts'

// Nested `if`: the old single regex let the outer condition run across `%}`
// into the inner tag, so the inner `endif` closed the OUTER block and the real
// outer `endif` was left in the output — the Spring Boot README and
// catalog-info.yaml shipped a literal `{%- endif %}` (2026-10-22).
const NESTED = [
  'deps:',
  '{%- if values.withDatabase or values.withCache %}',
  '{%- if values.withDatabase %}',
  '  - db',
  '{%- endif %}',
  '{%- if values.withCache %}',
  '  - cache',
  '{%- endif %}',
  '{%- endif %}',
  'end',
].join('\n')

Deno.test('nested if blocks render each level and leave no tags behind', () => {
  assertEquals(renderContent(NESTED, { withDatabase: true, withCache: true }), 'deps:\n  - db\n  - cache\nend')
  assertEquals(renderContent(NESTED, { withDatabase: false, withCache: true }), 'deps:\n  - cache\nend')
  assertEquals(renderContent(NESTED, { withDatabase: false, withCache: false }), 'deps:\nend')
})

// `not (a or b or c)` was looked up as one PATH, found nothing, and `not` made
// it TRUE — compose.yaml rendered `services: {}` beside the real services, a
// duplicate key, whenever any backing service was on.
const COMPOSE = [
  '{%- if not (values.withDatabase or values.withCache or values.withKafka) %}',
  'services: {}',
  '{%- else %}',
  'services:',
  '{%- endif %}',
  '{%- if values.withKafka %}',
  '  kafka: {}',
  '{%- endif %}',
].join('\n')

Deno.test('not over a parenthesised or chooses the right branch', () => {
  assertEquals(renderContent(COMPOSE, { withKafka: true }).trim(), 'services:\n  kafka: {}')
  assertEquals(renderContent(COMPOSE, {}).trim(), 'services: {}')
})

Deno.test('and binds tighter than or, and not tighter than both', () => {
  const r = (c: string, v: Record<string, unknown>) => renderContent(`{% if ${c} %}Y{% else %}N{% endif %}`, v)
  assertEquals(r('a or b and c', { a: true, b: false, c: false }), 'Y')
  assertEquals(r('(a or b) and c', { a: true, b: false, c: false }), 'N')
  assertEquals(r('not a and b', { a: false, b: true }), 'Y')
  assertEquals(r('values.kind == "jvm"', { kind: 'jvm' }), 'Y')
  assertEquals(r('values.withAuth == false', { withAuth: false }), 'Y')
  assertEquals(r("kind != 'jvm'", { kind: 'jvm' }), 'N')
})

Deno.test('elif picks the first true branch only', () => {
  const t = '{% if a %}A{% elif b %}B{% elif c %}C{% else %}D{% endif %}'
  assertEquals(renderContent(t, { b: true, c: true }), 'B')
  assertEquals(renderContent(t, { c: true }), 'C')
  assertEquals(renderContent(t, {}), 'D')
})

// A branch that is not taken is not evaluated, so values it does not need may
// be absent — but its tags must still balance.
Deno.test('an untaken branch is skipped, nested tags included', () => {
  const t = '{% if a %}{% if b %}x{% else %}y{% endif %}{% else %}z{% endif %}'
  assertEquals(renderContent(t, {}), 'z')
  assertEquals(renderContent(t, { a: true }), 'y')
})

Deno.test('unbalanced tags and unsupported conditions fail loudly', () => {
  assertThrows(() => renderContent('{% if a %}x', { a: true }), Error, 'unclosed')
  assertThrows(() => renderContent('x{% endif %}', {}), Error, 'no matching')
  assertThrows(() => renderContent('{% else %}', {}), Error, 'no matching')
  assertThrows(() => renderContent('{% if a in b %}x{% endif %}', {}), Error, 'unexpected')
  assertThrows(() => renderContent('{% if (a %}x{% endif %}', {}), Error, 'parentheses')
  assertThrows(() => renderContent('{% if %}x{% endif %}', {}), Error, 'empty')
})

// Text that only looks like a tag stays literal, as before.
Deno.test('other {% %} tags pass through untouched', () => {
  const t = '{% raw %}keep{% endraw %}'
  assert(renderContent(t, {}).includes('{% raw %}'))
})
