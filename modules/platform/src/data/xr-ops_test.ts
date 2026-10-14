import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  composedRefs,
  attentionItems, changeLog, cloneManifest, cloneName, filterXrs, groupXrs, ownership, ownershipPatch,
  pausePatch, protectPatch, toCsv, toYamlBundle, validLabelValue, type XrLike, xrState,
} from './xr-ops.ts'

const NOW = Date.parse('2026-10-11T12:00:00Z')
const cond = (type: string, status: string, at = '2026-10-11T11:00:00Z', reason?: string, message?: string) => ({ type, status, lastTransitionTime: at, reason, message })

const xr = (name: string, over: Partial<XrLike['metadata']> = {}, status?: XrLike['status'], spec: Record<string, unknown> = {}): XrLike => ({
  apiVersion: 'platform.adhar.io/v1alpha1',
  kind: 'Database',
  metadata: { name, namespace: 'shop', creationTimestamp: '2026-10-11T10:00:00Z', ...over },
  spec,
  status,
})

const ready = xr('orders', { labels: { 'adhar.io/team': 'payments' } }, { conditions: [cond('Ready', 'True'), cond('Synced', 'True')] }, { compositionRef: { name: 'pg-small' } })
const stuck = xr('carts', { labels: { team: 'web' } }, { conditions: [cond('Ready', 'False', '2026-10-11T11:00:00Z', 'Creating', 'waiting for instance')] })
const failing = xr('users', {}, { conditions: [cond('Synced', 'False', '2026-10-11T11:50:00Z', 'ReconcileError', 'cannot compose: quota')] })
const fresh = xr('logs', { creationTimestamp: '2026-10-11T11:58:00Z' }, { conditions: [] })
const paused = xr('legacy', { annotations: { 'crossplane.io/paused': 'true' } })
const deleting = xr('old', { deletionTimestamp: '2026-10-11T11:59:00Z' })

Deno.test('xrState names the most urgent state', () => {
  assertEquals([ready, stuck, failing, fresh, paused, deleting].map((r) => xrState(r, NOW)), ['ready', 'stuck', 'failing', 'progressing', 'paused', 'deleting'])
})

Deno.test('attention lists failing and stuck resources with the controller\'s reason, oldest first', () => {
  const items = attentionItems([ready, failing, stuck, fresh], NOW)
  assertEquals(items.map((i) => `${i.xr.metadata.name}:${i.state}`), ['carts:stuck', 'users:failing'])
  assertEquals(items[1].reason, 'ReconcileError: cannot compose: quota')
})

Deno.test('ownership reads common label keys', () => {
  assertEquals(ownership(ready).team, 'payments')
  assertEquals(ownership(stuck).team, 'web')
  assertEquals(ownership(failing).team, undefined)
})

Deno.test('filters combine and search covers team and composition', () => {
  const rows = [ready, stuck, failing]
  assertEquals(filterXrs(rows, { search: 'pg-small' }, NOW).map((r) => r.metadata.name), ['orders'])
  assertEquals(filterXrs(rows, { search: 'payments' }, NOW).map((r) => r.metadata.name), ['orders'])
  assertEquals(filterXrs(rows, { team: 'web' }, NOW).map((r) => r.metadata.name), ['carts'])
  assertEquals(filterXrs(rows, { states: new Set(['stuck', 'failing'] as const) }, NOW).map((r) => r.metadata.name), ['carts', 'users'])
})

Deno.test('grouping by team puts untagged resources under "no team"', () => {
  const g = groupXrs([ready, stuck, failing], 'team', NOW)
  assertEquals(g.map((x) => `${x.key}:${x.rows.length}`), ['no team:1', 'payments:1', 'web:1'])
})

Deno.test('patches set and remove annotations and labels', () => {
  assertEquals(pausePatch(true), { metadata: { annotations: { 'crossplane.io/paused': 'true' } } })
  assertEquals(pausePatch(false), { metadata: { annotations: { 'crossplane.io/paused': null } } })
  assertEquals(protectPatch(true).metadata.annotations['adhar.io/deletion-protection'], 'true')
  assertEquals(ownershipPatch({ team: 'payments', owner: '' }), { metadata: { labels: { 'adhar.io/team': 'payments', 'adhar.io/owner': null } } })
})

Deno.test('label values are validated the Kubernetes way', () => {
  assertEquals(validLabelValue('payments-team'), true)
  assertEquals(validLabelValue(''), true)
  assertEquals(validLabelValue('Payments Team'), false)
  assertEquals(validLabelValue('-x'), false)
})

Deno.test('clone drops server state, bindings, pause and protection, and gets its own secret', () => {
  const src = xr('orders', {
    uid: 'u1', resourceVersion: '9', annotations: { 'adhar.io/deletion-protection': 'true', note: 'keep' }, labels: { 'adhar.io/team': 'payments' },
  }, { conditions: [cond('Ready', 'True')] }, { size: 'small', resourceRef: { name: 'x' }, writeConnectionSecretToRef: { name: 'orders-conn', namespace: 'shop' } })
  const c = cloneManifest(src, 'orders-copy')
  assertEquals(c.metadata.name, 'orders-copy')
  assertEquals(c.metadata.uid, undefined)
  assertEquals(c.metadata.annotations, { note: 'keep' })
  assertEquals(c.metadata.labels, { 'adhar.io/team': 'payments' })
  assertEquals(c.spec, { size: 'small', writeConnectionSecretToRef: { name: 'orders-copy-conn', namespace: 'shop' } })
  assertEquals((c as { status?: unknown }).status, undefined)
  assertEquals(cloneName('orders', new Set(['orders-copy'])), 'orders-copy-2')
})

Deno.test('exports: YAML bundle has no status, CSV quotes awkward cells', () => {
  const yaml = toYamlBundle([ready, stuck])
  assertStringIncludes(yaml, 'name: orders')
  assertStringIncludes(yaml, '---\n')
  assertEquals(yaml.includes('status:'), false)
  const csv = toCsv([xr('a,b', { labels: { owner: 'x"y' } })], NOW)
  assertStringIncludes(csv, '"a,b"')
  assertStringIncludes(csv, '"x""y"')
})

Deno.test('change log lists writers newest first and classifies them', () => {
  const log = changeLog(xr('o', { managedFields: [
    { manager: 'argocd-controller', operation: 'Apply', time: '2026-10-10T00:00:00Z' },
    { manager: 'adhar-console', operation: 'Apply', time: '2026-10-11T00:00:00Z' },
    { manager: 'crossplane', operation: 'Update', time: '2026-10-11T01:00:00Z', subresource: 'status' },
  ] }))
  assertEquals(log.map((l) => `${l.manager}:${l.kindOfWriter}`), ['crossplane:controller', 'adhar-console:console', 'argocd-controller:gitops'])
})

Deno.test('composedRefs reads the Crossplane v2 location first', () => {
  const xr = {
    metadata: { name: 'console-db', namespace: 'adhar-system' },
    spec: {
      crossplane: {
        resourceRefs: [
          { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', name: 'console-db' },
          { apiVersion: 'postgresql.cnpg.io/v1', kind: 'ScheduledBackup', name: 'console-db-daily' },
        ],
      },
    },
    status: { conditions: [] },
  }
  assertEquals(composedRefs(xr).map((r) => r.kind), ['Cluster', 'ScheduledBackup'])
})

Deno.test('composedRefs still honours the v1 status location and is empty when nothing was composed', () => {
  const v1 = {
    metadata: { name: 'old' },
    status: { resourceRefs: [{ apiVersion: 'v1', kind: 'ConfigMap', name: 'cm' }] },
  }
  assertEquals(composedRefs(v1).map((r) => r.name), ['cm'])
  assertEquals(composedRefs({ metadata: { name: 'bare' } }), [])
})
