import { assertEquals } from 'jsr:@std/assert'
import { provisionState, type Condition } from './provision-state.ts'

const c = (type: string, status: string, reason?: string, message?: string): Condition => ({
  type,
  status,
  reason,
  message,
})

/**
 * The distinction this file exists for: a claim that is still being built and
 * a claim that will never build both report `Ready=False`, and showing them
 * the same way makes every successful provision look broken for its first few
 * seconds — or hides a real failure behind a spinner.
 */

Deno.test('no conditions means the controller has not looked yet', () => {
  const s = provisionState([])
  assertEquals(s.phase, 'accepted')
  assertEquals(s.settling, true)
})

Deno.test('an undefined status block is the same as no conditions', () => {
  assertEquals(provisionState(undefined).phase, 'accepted')
})

Deno.test('Ready=False just after apply is progress, not failure', () => {
  const s = provisionState([c('Synced', 'True'), c('Ready', 'False', 'Creating')])
  assertEquals(s.phase, 'provisioning')
  assertEquals(s.title, 'Provisioning — Creating')
  assertEquals(s.settling, true)
})

Deno.test('Ready=True is the finish line', () => {
  const s = provisionState([c('Synced', 'True'), c('Ready', 'True')])
  assertEquals(s.phase, 'ready')
  assertEquals(s.settling, false)
})

/**
 * Synced=False is the one that does not clear on its own — a composition that
 * cannot be rendered, or a provider that rejected the spec.
 */
Deno.test('Synced=False is a failure even while Ready is absent', () => {
  const s = provisionState([
    c('Synced', 'False', 'ReconcileError', 'cannot resolve composition: no match'),
  ])
  assertEquals(s.phase, 'failed')
  assertEquals(s.title, 'Not synced — ReconcileError')
  assertEquals(s.detail, 'cannot resolve composition: no match')
  assertEquals(s.settling, false)
})

Deno.test('Synced=False outranks Ready=True', () => {
  // Drift after a successful create: it was ready, and now cannot sync.
  const s = provisionState([c('Ready', 'True'), c('Synced', 'False', 'ReconcileError')])
  assertEquals(s.phase, 'failed')
})

Deno.test('an unknown Synced does not read as failure', () => {
  const s = provisionState([c('Synced', 'Unknown'), c('Ready', 'False')])
  assertEquals(s.phase, 'provisioning')
  assertEquals(s.settling, true)
})

Deno.test('the controller’s own message is carried through', () => {
  const s = provisionState([c('Ready', 'False', 'Creating', 'waiting for RDS instance')])
  assertEquals(s.detail, 'waiting for RDS instance')
})

Deno.test('a Ready message falls back to the Synced one', () => {
  const s = provisionState([c('Synced', 'True', undefined, 'composed 3 resources'), c('Ready', 'False')])
  assertEquals(s.detail, 'composed 3 resources')
})

Deno.test('conditions unrelated to provisioning are ignored', () => {
  const s = provisionState([c('LastAsyncOperation', 'True'), c('Ready', 'True')])
  assertEquals(s.phase, 'ready')
})

Deno.test('only settling phases keep the dialog polling', () => {
  const settling = (cs: Condition[]) => provisionState(cs).settling
  assertEquals(settling([]), true)
  assertEquals(settling([c('Ready', 'False')]), true)
  assertEquals(settling([c('Ready', 'True')]), false)
  assertEquals(settling([c('Synced', 'False')]), false)
})
