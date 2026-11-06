import { assertEquals } from 'jsr:@std/assert@1'
import {
  derivePackageState,
  DISABLE_LIMIT_MS,
  ENABLE_LIMIT_MS,
  type PackageApplication,
  packageApplication,
} from './package-state.ts'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000

const phase = (desired: boolean, app?: PackageApplication, desiredSince?: string) =>
  derivePackageState({ desired, app, desiredSince }, NOW).phase

// The whole enable path, in the order the cluster moves through it.
Deno.test('disabled -> enabling -> enabled follows the cluster, not the click', () => {
  assertEquals(phase(false), 'disabled')
  // The commit landed: Git says true, Argo CD has generated nothing yet. A
  // successful write is exactly this state, and it must not read as Enabled.
  assertEquals(phase(true, undefined, ago(5_000)), 'enabling')
  // Application generated, nothing reported yet.
  assertEquals(phase(true, { createdAt: ago(5_000) }), 'enabling')
  // First sync running, wave-gated.
  assertEquals(phase(true, { createdAt: ago(MIN), sync: 'OutOfSync', health: 'Missing', operationPhase: 'Running' }), 'enabling')
  // First sync finished but the pods are still starting.
  assertEquals(phase(true, { createdAt: ago(2 * MIN), sync: 'Synced', health: 'Progressing', operationPhase: 'Succeeded', appliedOnce: true }), 'enabling')
  assertEquals(phase(true, { createdAt: ago(3 * MIN), sync: 'Synced', health: 'Healthy', operationPhase: 'Succeeded', appliedOnce: true }), 'enabled')
})

Deno.test('enabled requires BOTH Synced and Healthy', () => {
  assertEquals(phase(true, { createdAt: ago(MIN), sync: 'Synced', health: 'Progressing' }), 'enabling')
  assertEquals(phase(true, { createdAt: ago(MIN), sync: 'OutOfSync', health: 'Healthy' }), 'enabling')
})

Deno.test('enabling -> failed: Degraded and a failed sync show at once', () => {
  const degraded = derivePackageState(
    { desired: true, app: { createdAt: ago(MIN), sync: 'Synced', health: 'Degraded', healthMessage: 'CrashLoopBackOff' } },
    NOW,
  )
  assertEquals([degraded.phase, degraded.detail, degraded.settling], ['failed', 'CrashLoopBackOff', false])
  assertEquals(
    phase(true, { createdAt: ago(MIN), sync: 'OutOfSync', health: 'Missing', operationPhase: 'Failed' }),
    'failed',
  )
  assertEquals(
    phase(true, { createdAt: ago(MIN), sync: 'OutOfSync', health: 'Missing', operationPhase: 'Error' }),
    'failed',
  )
})

Deno.test('a failed state clears by itself once the cluster converges', () => {
  // Nothing is remembered: Degraded then Healthy is simply Enabled.
  const app = { createdAt: ago(MIN), sync: 'Synced', operationPhase: 'Failed' }
  assertEquals(phase(true, { ...app, health: 'Degraded' }), 'failed')
  assertEquals(phase(true, { ...app, health: 'Healthy' }), 'enabled')
})

Deno.test('enabling -> failed: stuck past the limit stops spinning', () => {
  // No Application ever appeared.
  const noApp = derivePackageState({ desired: true, desiredSince: ago(ENABLE_LIMIT_MS + MIN) }, NOW)
  assertEquals([noApp.phase, noApp.settling], ['failed', false])
  // Application exists but its first sync never finished.
  const noSync = derivePackageState(
    { desired: true, app: { createdAt: ago(ENABLE_LIMIT_MS + MIN), sync: 'OutOfSync', health: 'Progressing', operationPhase: 'Running', operationMessage: 'waiting for healthy state' } },
    NOW,
  )
  assertEquals([noSync.phase, noSync.detail, noSync.available], ['failed', 'waiting for healthy state', false])
  // Just inside the limit it is still in progress.
  assertEquals(phase(true, undefined, ago(ENABLE_LIMIT_MS - MIN)), 'enabling')
})

Deno.test('enabled -> disabling -> disabled, until the Application is gone', () => {
  const live = { createdAt: ago(60 * MIN), sync: 'Synced', health: 'Healthy', appliedOnce: true }
  assertEquals(phase(true, live), 'enabled')
  // The commit landed; the Application is still there, still healthy.
  assertEquals(phase(false, live, ago(5_000)), 'disabling')
  // Argo CD is pruning it.
  assertEquals(phase(false, { ...live, deletingSince: ago(30_000) }), 'disabling')
  assertEquals(phase(false), 'disabled')
})

Deno.test('disabling past the limit is a visible failure', () => {
  const live = { createdAt: ago(60 * MIN), sync: 'Synced', health: 'Healthy' }
  const held = derivePackageState({ desired: false, app: { ...live, deletingSince: ago(DISABLE_LIMIT_MS + MIN) } }, NOW)
  assertEquals([held.phase, held.settling, held.available], ['failed', false, false])
  // Never picked up at all: measured from the commit instead.
  assertEquals(phase(false, live, ago(DISABLE_LIMIT_MS + MIN)), 'failed')
  assertEquals(phase(false, live, ago(DISABLE_LIMIT_MS - MIN)), 'disabling')
})

Deno.test('a reload mid-transition derives the same answer from server state alone', () => {
  // Three moments of an enable, each computed from nothing but what a freshly
  // loaded page can read. There is no click to remember, so there is nothing to
  // lose: the same inputs must give the same state, twice.
  const moments: Array<[boolean, PackageApplication | undefined, string | undefined, string]> = [
    [true, undefined, ago(MIN), 'enabling'],
    [true, { createdAt: ago(MIN), sync: 'Synced', health: 'Progressing', appliedOnce: true }, ago(2 * MIN), 'enabling'],
    [false, { createdAt: ago(9 * MIN), sync: 'Synced', health: 'Healthy', deletingSince: ago(MIN) }, ago(MIN), 'disabling'],
  ]
  for (const [desired, app, desiredSince, want] of moments) {
    const first = derivePackageState({ desired, app, desiredSince }, NOW)
    const second = derivePackageState({ desired, app, desiredSince }, NOW)
    assertEquals(first, second)
    assertEquals(first.phase, want)
  }
})

Deno.test('a monorepo push storm on established apps is not an enable and not a failure', () => {
  // Any packages push flips ~80 Applications OutOfSync for ten minutes.
  const st = derivePackageState(
    { desired: true, app: { createdAt: ago(24 * 60 * MIN), sync: 'OutOfSync', health: 'Healthy', appliedOnce: true, healthSince: ago(24 * 60 * MIN) } },
    NOW,
  )
  assertEquals([st.phase, st.label, st.settling, st.available], ['updating', 'Out of sync', false, true])
  const running = derivePackageState(
    { desired: true, app: { createdAt: ago(24 * 60 * MIN), sync: 'OutOfSync', health: 'Healthy', appliedOnce: true, operationPhase: 'Running' } },
    NOW,
  )
  assertEquals([running.phase, running.label, running.settling], ['updating', 'Updating…', true])
})

Deno.test('an established app that stays Progressing is reported, and stays openable', () => {
  // argo-workflows on the live cluster: Synced, Progressing for 23 h on a
  // composite Bucket, while its UI answers perfectly well.
  const st = derivePackageState(
    {
      desired: true,
      app: {
        createdAt: ago(23 * 60 * MIN),
        sync: 'Synced',
        health: 'Progressing',
        healthSince: ago(23 * 60 * MIN),
        healthMessage: 'Caused by platform.adhar.io/Bucket:adhar-system/argo-artifacts',
        operationPhase: 'Succeeded',
        appliedOnce: true,
      },
    },
    NOW,
  )
  assertEquals([st.phase, st.label, st.available, st.settling], ['failed', 'Stuck Progressing', true, false])
  assertEquals(st.detail, 'Caused by platform.adhar.io/Bucket:adhar-system/argo-artifacts')
  // The same app inside the limit is merely rolling.
  assertEquals(
    phase(true, { createdAt: ago(23 * 60 * MIN), sync: 'Synced', health: 'Progressing', healthSince: ago(MIN), appliedOnce: true }),
    'updating',
  )
})

Deno.test('availability: only applied, not-departing packages are offered', () => {
  const available = (desired: boolean, app?: PackageApplication) => derivePackageState({ desired, app }, NOW).available
  assertEquals(available(true, { createdAt: ago(99 * MIN), sync: 'Synced', health: 'Healthy', appliedOnce: true }), true)
  assertEquals(available(true, { createdAt: ago(99 * MIN), sync: 'OutOfSync', health: 'Healthy', appliedOnce: true }), true)
  // A long-lived app going Degraded may well still serve its UI.
  assertEquals(available(true, { createdAt: ago(99 * MIN), sync: 'Synced', health: 'Degraded', appliedOnce: true }), true)
  // Still on its first install, or leaving: not yet / no longer.
  assertEquals(available(true, { createdAt: ago(MIN), sync: 'Synced', health: 'Progressing', appliedOnce: true }), false)
  assertEquals(available(true, { createdAt: ago(MIN), sync: 'Synced', health: 'Degraded' }), false)
  assertEquals(available(false, { createdAt: ago(99 * MIN), sync: 'Synced', health: 'Healthy' }), false)
  assertEquals(available(true, { createdAt: ago(99 * MIN), sync: 'Synced', health: 'Healthy', deletingSince: ago(MIN) }), false)
  assertEquals(available(false), false)
  assertEquals(available(true), false)
})

Deno.test('packageApplication reads the fields Argo CD actually publishes', () => {
  assertEquals(
    packageApplication({
      metadata: { name: 'x', creationTimestamp: 'c', deletionTimestamp: 'd' },
      status: {
        health: { status: 'Progressing', message: 'm', lastTransitionTime: 't' },
        sync: { status: 'Synced' },
        operationState: { phase: 'Succeeded', message: 'o' },
        history: [{}],
      },
    }),
    {
      health: 'Progressing',
      sync: 'Synced',
      healthMessage: 'm',
      healthSince: 't',
      operationPhase: 'Succeeded',
      operationMessage: 'o',
      createdAt: 'c',
      deletingSince: 'd',
      appliedOnce: true,
    },
  )
  assertEquals(packageApplication({}).appliedOnce, false)
})
