import { assertEquals } from 'jsr:@std/assert@^1'
import { crStatus, groupLabel } from './crd-status.ts'

Deno.test('Argo CD health wins', () => {
  assertEquals(crStatus({ status: { health: { status: 'Degraded', message: 'pod crash' } } }).health, 'degraded')
  assertEquals(crStatus({ status: { health: { status: 'Healthy' } } }).health, 'healthy')
  assertEquals(crStatus({ status: { health: { status: 'Healthy' }, sync: { status: 'Synced', revision: 'abc1234def' } } }).note, 'Synced at abc1234')
})

Deno.test('a failing Ready outranks a passing Synced (Crossplane)', () => {
  const s = crStatus({
    status: {
      conditions: [
        { type: 'Synced', status: 'True', reason: 'ReconcileSuccess' },
        { type: 'Ready', status: 'False', reason: 'Creating', message: 'waiting for db' },
      ],
    },
  })
  assertEquals(s.health, 'progressing')
  assertEquals(s.label, 'Creating')
  assertEquals(s.message, 'waiting for db')
})

Deno.test('Ready=False with an error reason is degraded', () => {
  assertEquals(crStatus({ status: { conditions: [{ type: 'Ready', status: 'False', reason: 'ReconcileError' }] } }).health, 'degraded')
})

Deno.test('Unknown readiness is progressing; True is healthy', () => {
  assertEquals(crStatus({ status: { conditions: [{ type: 'Succeeded', status: 'Unknown', reason: 'Running' }] } }).health, 'progressing')
  assertEquals(crStatus({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }).health, 'healthy')
})

Deno.test('phase and missing status', () => {
  assertEquals(crStatus({ status: { phase: 'Completed' } }).health, 'healthy')
  assertEquals(crStatus({ status: { phase: 'Failed' } }).health, 'degraded')
  assertEquals(crStatus({}).label, 'No status')
})

Deno.test('group labels', () => {
  assertEquals(groupLabel('postgresql.cnpg.io'), 'CloudNativePG')
  assertEquals(groupLabel('argoproj.io'), 'Argo')
  assertEquals(groupLabel('example.com'), 'example.com')
})
