/**
 * What a platform package is actually doing — pure, shared by the BFF (which
 * apps the drawer may offer) and the Marketplace (the status on each card).
 *
 * The two inputs are the only things that exist on the server: what is DESIRED
 * (`enabled` in the ApplicationSet) and what is REAL (the Argo CD Application).
 * Nothing here remembers a click, so a reload, a second tab and another
 * operator's click all read the same answer. A commit only ever moves `desired`,
 * which is why a successful Git write can never show "Enabled" by itself.
 *
 * Reading the Application correctly is not just "is it Synced + Healthy":
 *
 *   • A push to the monorepo flips about 80 Applications OutOfSync for ten
 *     minutes. Calling those "Enabling…" or failed would light up the whole
 *     catalogue on every upgrade, so an app that has been applied before only
 *     ever reads as updating until a clock says otherwise.
 *   • Argo CD keeps no clock for sync status, only for health
 *     (`status.health.lastTransitionTime`). OutOfSync therefore never becomes a
 *     failure on its own; it stops spinning and says "Out of sync" instead.
 *   • Degraded is a failure as soon as it is seen, even mid-install. It may
 *     clear (the state is derived, so it then simply moves on), but a wedged
 *     install must not sit behind a spinner until the limit runs out.
 */

/** How long a first install may take before it is reported as stuck (a heavy app on a loaded cluster takes minutes). */
export const ENABLE_LIMIT_MS = 20 * 60_000
/** How long removal may take. Pruning is quick; past this a finalizer is holding on to something. */
export const DISABLE_LIMIT_MS = 10 * 60_000

export type PackagePhase = 'disabled' | 'enabling' | 'enabled' | 'updating' | 'failed' | 'disabling'

export interface PackageState {
  phase: PackagePhase
  /** Short status for a pill or button. */
  label: string
  /** One sentence for the detail view, in Argo CD's own words where it has some. */
  detail?: string
  /** True while the state is still expected to change on its own. */
  settling: boolean
  /** Whether the package's UI should be offered to people right now (apps drawer). */
  available: boolean
}

/** The fields of an Argo CD Application this module reads. */
export interface PackageApplication {
  health?: string
  sync?: string
  healthMessage?: string
  healthSince?: string
  operationPhase?: string
  operationMessage?: string
  createdAt?: string
  deletingSince?: string
  /** At least one sync has finished (`status.history`), so the package has been applied at some point. */
  appliedOnce?: boolean
}

/** The `applications.argoproj.io` shape behind {@link packageApplication}. */
export interface RawArgoApplication {
  metadata?: { name?: string; creationTimestamp?: string; deletionTimestamp?: string; labels?: Record<string, string> }
  status?: {
    health?: { status?: string; message?: string; lastTransitionTime?: string }
    sync?: { status?: string }
    operationState?: { phase?: string; message?: string }
    history?: unknown[]
  }
}

export function packageApplication(app: RawArgoApplication): PackageApplication {
  return {
    health: app.status?.health?.status,
    sync: app.status?.sync?.status,
    healthMessage: app.status?.health?.message,
    healthSince: app.status?.health?.lastTransitionTime,
    operationPhase: app.status?.operationState?.phase,
    operationMessage: app.status?.operationState?.message,
    createdAt: app.metadata?.creationTimestamp,
    deletingSince: app.metadata?.deletionTimestamp,
    appliedOnce: (app.status?.history?.length ?? 0) > 0,
  }
}

function olderThan(iso: string | undefined, limitMs: number, now: number): boolean {
  if (!iso) return false
  const at = Date.parse(iso)
  return Number.isFinite(at) && now - at > limitMs
}

function waited(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(at)) return 'too long'
  const mins = Math.round((now - at) / 60_000)
  return mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`
}

export function derivePackageState(
  input: {
    /** `enabled` in the ApplicationSet. */
    desired: boolean
    /** The live Application, when one exists. */
    app?: PackageApplication
    /** When the desired state last changed (the ApplicationSet file's last commit), if known. */
    desiredSince?: string
  },
  now: number = Date.now(),
): PackageState {
  const { desired, app, desiredSince } = input

  if (!desired) {
    if (!app) return { phase: 'disabled', label: 'Disabled', settling: false, available: false }
    const since = app.deletingSince ?? desiredSince
    if (olderThan(since, DISABLE_LIMIT_MS, now)) {
      return {
        phase: 'failed',
        label: 'Stuck disabling',
        detail: `The Argo CD Application still exists ${waited(since, now)} after this was disabled. Its finalizer is waiting on a resource it cannot remove.`,
        settling: false,
        available: false,
      }
    }
    return {
      phase: 'disabling',
      label: 'Disabling…',
      detail: app.deletingSince
        ? 'Argo CD is removing what this package installed.'
        : 'Waiting for Argo CD to pick up the change and remove the Application.',
      settling: true,
      available: false,
    }
  }

  if (!app) {
    if (olderThan(desiredSince, ENABLE_LIMIT_MS, now)) {
      return {
        phase: 'failed',
        label: 'Stuck enabling',
        detail: `Argo CD has not generated an Application ${waited(desiredSince, now)} after this was enabled. Check the ApplicationSet and the adhar-platform-applicationset Application.`,
        settling: false,
        available: false,
      }
    }
    return {
      phase: 'enabling',
      label: 'Enabling…',
      detail: 'Waiting for Argo CD to pick up the change and generate the Application.',
      settling: true,
      available: false,
    }
  }

  // Enabled again while the previous removal is still running: the generator
  // makes a new Application once this one is gone.
  if (app.deletingSince) {
    return {
      phase: 'enabling',
      label: 'Enabling…',
      detail: 'The previous install is still being removed; Argo CD installs it again once that finishes.',
      settling: true,
      available: false,
    }
  }

  if (app.sync === 'Synced' && app.health === 'Healthy') {
    return { phase: 'enabled', label: 'Enabled', settling: false, available: true }
  }

  // "Has been applied before", as opposed to still on its first install: a sync
  // has finished AND the install window has passed. The second half is what
  // keeps "the first sync finished, the pods are still starting" under Enabling.
  const fresh = !olderThan(app.createdAt, ENABLE_LIMIT_MS, now)
  const established = Boolean(app.appliedOnce) && !fresh

  if (app.health === 'Degraded') {
    return {
      phase: 'failed',
      label: 'Degraded',
      detail: app.healthMessage ?? app.operationMessage,
      settling: false,
      available: established,
    }
  }
  if (app.operationPhase === 'Failed' || app.operationPhase === 'Error') {
    return {
      phase: 'failed',
      label: 'Sync failed',
      detail: app.operationMessage ?? app.healthMessage,
      settling: false,
      available: established,
    }
  }

  if (!established) {
    if (!fresh) {
      return {
        phase: 'failed',
        label: 'Stuck enabling',
        detail: app.healthMessage ?? app.operationMessage ??
          `The first sync has not finished ${waited(app.createdAt, now)} after the Application was created.`,
        settling: false,
        available: false,
      }
    }
    return {
      phase: 'enabling',
      label: 'Enabling…',
      detail: app.healthMessage ?? app.operationMessage ?? 'Argo CD is applying this package.',
      settling: true,
      available: false,
    }
  }

  if (app.health !== 'Healthy' && olderThan(app.healthSince, ENABLE_LIMIT_MS, now)) {
    return {
      phase: 'failed',
      label: `Stuck ${app.health ?? 'Unknown'}`,
      detail: app.healthMessage ?? `${app.health ?? 'Unknown'} for ${waited(app.healthSince, now)}.`,
      settling: false,
      available: true,
    }
  }

  const syncing = app.operationPhase === 'Running' || app.health === 'Progressing'
  return {
    phase: 'updating',
    label: syncing ? 'Updating…' : 'Out of sync',
    detail: app.healthMessage ?? app.operationMessage,
    settling: syncing,
    available: true,
  }
}
