import { assertEquals } from 'jsr:@std/assert'
import { summarizeServerCheck } from './check-server.ts'

Deno.test('syntax errors fail the server-only gate', () => {
  const text = `error: SyntaxError: Unexpected token EOF
  |
1 | function broken( {
  |                   ~
    at file:///Users/example/adhar-console/apps/console/app/server/scaffolder.ts:1:19`

  assertEquals(summarizeServerCheck(1, text), {
    code: 1,
    totalErrors: 0,
    serverErrors: 0,
    isFailure: true,
  })
})

Deno.test('ts diagnostics still fail only when they are in app/server', () => {
  const text = `TS2304 [ERROR]: Cannot find name 'params'
  at file:///Users/example/adhar-console/apps/console/app/server/scaffolder.ts:563:21

TS2304 [ERROR]: Cannot find name 'params'
  at file:///Users/example/adhar-console/packages/shell-ui/src/status-badge.tsx:12:5`

  assertEquals(summarizeServerCheck(1, text), {
    code: 1,
    totalErrors: 2,
    serverErrors: 1,
    isFailure: true,
  })
})

Deno.test('unrelated package errors are ignored by the server-only gate', () => {
  const text = `TS7006 [ERROR]: Parameter 's' implicitly has an 'any' type.
  at file:///Users/example/adhar-console/packages/shell-ui/src/data-table.tsx:351:18`

  assertEquals(summarizeServerCheck(1, text), {
    code: 1,
    totalErrors: 1,
    serverErrors: 0,
    isFailure: false,
  })
})

Deno.test('clean output is not treated as a failure', () => {
  assertEquals(summarizeServerCheck(0, 'No problems'), {
    code: 0,
    totalErrors: 0,
    serverErrors: 0,
    isFailure: false,
  })
})
