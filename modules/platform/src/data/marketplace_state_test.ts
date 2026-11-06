import { assertEquals } from 'jsr:@std/assert@1'
import { type AppLiveStatus, type AppsetElement, type DesiredState, packageStates, statusBucket } from './marketplace.ts'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString()

const element = (over: Partial<AppsetElement> = {}): AppsetElement => ({
  name: 'n8n',
  enabled: false,
  category: 'application',
  appset: 'helm-charts-production',
  ...over,
})

function live(health: string, sync: string, over: Partial<AppLiveStatus['application']> = {}): Map<string, AppLiveStatus> {
  return new Map([[
    'n8n',
    {
      name: 'n8n',
      namespace: 'adhar-system',
      health: health as AppLiveStatus['health'],
      sync: sync as AppLiveStatus['sync'],
      application: { health, sync, createdAt: ago(1), ...over },
    },
  ]])
}

const NONE = new Map<string, AppLiveStatus>()
const git = (enabled: boolean, changedAt = ago(1)): Map<string, DesiredState> =>
  new Map([['helm-charts-production', { changedAt, elements: { n8n: enabled } }]])
const clicked = (enabled: boolean) => [{ app: { name: 'n8n', appset: 'helm-charts-production' }, enabled }]

const state = (
  el: AppsetElement,
  desired: ReadonlyMap<string, DesiredState>,
  liveApps: ReadonlyMap<string, AppLiveStatus>,
  pending: Array<{ app: { name: string; appset: string }; enabled: boolean }> = [],
) => packageStates([el], desired, liveApps, pending, NOW)[0]

Deno.test('a click reads as Enabling at once, before anything answers', () => {
  const row = state(element(), new Map(), NONE, clicked(true))
  assertEquals([row.state.phase, row.state.label, row.enabled], ['enabling', 'Enabling…', true])
})

Deno.test('a click to disable reads as Disabling at once', () => {
  const row = state(element({ enabled: true }), git(true), live('Healthy', 'Synced'), clicked(false))
  assertEquals([row.state.phase, row.state.label], ['disabling', 'Disabling…'])
})

Deno.test('a successful commit is not Enabled: Git moved, the cluster has not', () => {
  // The exact moment the old code said Enabled: the write succeeded and nothing
  // else has happened. The live ApplicationSet still says false.
  assertEquals(state(element({ enabled: false }), git(true), NONE).state.phase, 'enabling')
})

Deno.test('a reload after the commit, before Argo CD syncs, still shows it in progress', () => {
  // No pending click: a new page, a second tab, another operator. The live
  // ApplicationSet lags Git by up to the reconciliation period, and reading it
  // alone said "Disabled" for that long.
  assertEquals(state(element({ enabled: false }), git(true), NONE, []).state.phase, 'enabling')
  assertEquals(state(element({ enabled: true }), git(false), live('Healthy', 'Synced')).state.phase, 'disabling')
})

Deno.test('Enabled arrives only with a Synced + Healthy Application', () => {
  const el = element({ enabled: true })
  assertEquals(state(el, git(true), live('Progressing', 'OutOfSync')).state.phase, 'enabling')
  assertEquals(state(el, git(true), live('Progressing', 'Synced')).state.phase, 'enabling')
  assertEquals(state(el, git(true), live('Healthy', 'Synced')).state.phase, 'enabled')
})

Deno.test('Disabled arrives only once the Application is gone', () => {
  assertEquals(state(element(), git(false), live('Healthy', 'Synced', { deletingSince: ago(1) })).state.phase, 'disabling')
  assertEquals(state(element(), git(false), NONE).state.phase, 'disabled')
})

Deno.test('without Git the live ApplicationSet answers', () => {
  assertEquals(state(element({ enabled: true }), new Map(), live('Healthy', 'Synced')).state.phase, 'enabled')
  assertEquals(state(element({ enabled: false }), new Map(), NONE).state.phase, 'disabled')
  // An element missing from the file is not "disabled in Git".
  const other = new Map([['helm-charts-production', { elements: { other: true } }]])
  assertEquals(state(element({ enabled: true }), other, live('Healthy', 'Synced')).state.phase, 'enabled')
})

Deno.test('the file commit is the clock for a change Argo CD never picks up', () => {
  assertEquals(state(element(), git(true, ago(25)), NONE).state.phase, 'failed')
  assertEquals(state(element({ enabled: true }), git(false, ago(25)), live('Healthy', 'Synced', { createdAt: ago(99) })).state.phase, 'failed')
})

Deno.test('a click restarts that clock, so re-trying a stuck change is in progress again', () => {
  assertEquals(state(element(), git(true, ago(25)), NONE).state.phase, 'failed')
  assertEquals(state(element(), git(true, ago(25)), NONE, clicked(true)).state.phase, 'enabling')
})

Deno.test('a toggle of another package does not touch this one', () => {
  const pending = [{ app: { name: 'other', appset: 'helm-charts-production' }, enabled: true }]
  assertEquals(state(element(), git(false), NONE, pending).state.phase, 'disabled')
})

Deno.test('elements repeated across generators appear once', () => {
  assertEquals(packageStates([element(), element()], new Map(), NONE, [], NOW).length, 1)
})

Deno.test('filters: what is settled counts as settled, and the rest is in progress', () => {
  const bucket = (el: AppsetElement, d: ReadonlyMap<string, DesiredState>, l: ReadonlyMap<string, AppLiveStatus>) => statusBucket(state(el, d, l))
  assertEquals(bucket(element(), git(false), NONE), 'disabled')
  assertEquals(bucket(element({ enabled: true }), git(true), live('Healthy', 'Synced')), 'enabled')
  // A just-clicked package must not inflate the Enabled count.
  assertEquals(bucket(element(), git(true), NONE), 'changing')
  assertEquals(bucket(element({ enabled: true }), git(false), live('Healthy', 'Synced')), 'changing')
  // Failed on the way in is still enabled-and-broken; failed on the way out is not enabled.
  assertEquals(bucket(element({ enabled: true }), git(true), live('Degraded', 'Synced')), 'enabled')
  assertEquals(bucket(element({ enabled: true }), git(false, ago(25)), live('Healthy', 'Synced', { createdAt: ago(99) })), 'changing')
})
