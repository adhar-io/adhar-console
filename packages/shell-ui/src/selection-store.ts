import { useSyncExternalStore } from 'react'

/**
 * Shared cluster + namespace selection store — the ONE source of truth for the
 * active cluster, the active namespace, and the org→namespace scope, shared
 * between the host shell (which renders the pickers in the top bar) and the
 * platform remote (whose data hooks read the selection).
 *
 * `@adhar-console/shell-ui` is **not** a Module-Federation shared singleton, so
 * a plain module-level variable does NOT sync across the host↔remote boundary —
 * the host and the platform remote each get their own copy of this module.
 * Instead the source of truth is `localStorage`, and every mutation broadcasts
 *   • a same-document `window` CustomEvent — heard by the *other* MF instance
 *     living in the same browser window, and
 *   • (implicitly) the cross-tab `storage` event.
 * Both instances re-read `localStorage` on either signal, so they stay in sync.
 * Components subscribe through `useSyncExternalStore`.
 *
 * Cluster semantics match the platform's legacy store: `local` / `default` /
 * empty all mean "the gateway's default cluster", and the persisted key is the
 * same one the platform module already used, so existing selections carry over.
 */

export const LOCAL_CLUSTER = 'local'

const CLUSTER_KEY = 'adhar.platform.active-cluster'
const NAMESPACE_KEY = 'adhar.platform.active-namespace'
const SCOPE_KEY = 'adhar.platform.ns-scope'
const TEAM_KEY = 'adhar.platform.active-team'
const TEAM_ALL_KEY = 'adhar.platform.team-show-all'
const SELECTION_EVENT = 'adhar:selection-change'

export interface Selection {
  /** Active cluster name (`local` == the gateway's default cluster). */
  cluster: string
  /** Active namespace, or `''` for "All namespaces". */
  namespace: string
  /**
   * Kubernetes label selector restricting which namespaces belong to the active
   * organization (e.g. `adhar.io/org=default`), or `''` when the default / no-org
   * case is active and every namespace is in scope.
   */
  namespaceScope: string
  /**
   * Slug of the active team, or `''` when no team is selected.
   *
   * This is a **lens, not a boundary**. Real isolation is enforced where it can
   * actually be enforced — Kubernetes RBAC against the signed-in user, and the
   * Keycloak groups behind it — and the console impersonates that user for every
   * cluster read. Filtering here narrows what is *shown* to the team you are
   * working in; it never decides what you are *allowed* to see, and pretending
   * otherwise would be security theatre that also hides things people
   * legitimately need.
   */
  team: string
  /** True when the user has asked to see everything regardless of team. */
  teamShowAll: boolean
}

function read(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, value)
    else globalThis.localStorage?.removeItem(key)
  } catch {
    /* private mode etc. — selection just won't persist */
  }
}

function fresh(): Selection {
  return {
    cluster: read(CLUSTER_KEY) || LOCAL_CLUSTER,
    namespace: read(NAMESPACE_KEY),
    namespaceScope: read(SCOPE_KEY),
    team: read(TEAM_KEY),
    teamShowAll: read(TEAM_ALL_KEY) === '1',
  }
}

// Cached snapshot — a stable reference so `useSyncExternalStore` only re-renders
// when a value actually changes.
let snapshot: Selection = fresh()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** Re-read persisted state; notify subscribers only when something changed. */
function rebuild(): void {
  const next = fresh()
  if (
    next.cluster === snapshot.cluster &&
    next.namespace === snapshot.namespace &&
    next.namespaceScope === snapshot.namespaceScope &&
    next.team === snapshot.team &&
    next.teamShowAll === snapshot.teamShowAll
  ) {
    return
  }
  snapshot = next
  emit()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (
      e.key === null || e.key === CLUSTER_KEY || e.key === NAMESPACE_KEY ||
      e.key === SCOPE_KEY || e.key === TEAM_KEY || e.key === TEAM_ALL_KEY
    ) {
      rebuild()
    }
  })
  window.addEventListener(SELECTION_EVENT, () => rebuild())
}

/** Notify this instance's subscribers + the sibling MF instance / other tabs. */
function broadcast(): void {
  emit()
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SELECTION_EVENT))
  } catch {
    /* dispatch unsupported — the storage event still covers other tabs */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/* ─────────── imperative API (usable from non-React `.ts` files) ─────────── */

export function getSelection(): Selection {
  return snapshot
}

export function getActiveCluster(): string {
  return snapshot.cluster
}

export function getActiveNamespace(): string | undefined {
  return snapshot.namespace || undefined
}

export function getNamespaceScope(): string {
  return snapshot.namespaceScope
}

export function setActiveCluster(name: string): void {
  const next = name || LOCAL_CLUSTER
  if (next === snapshot.cluster) return
  snapshot = { ...snapshot, cluster: next }
  write(CLUSTER_KEY, next)
  broadcast()
}

export function setActiveNamespace(ns?: string): void {
  const next = ns ?? ''
  if (next === snapshot.namespace) return
  snapshot = { ...snapshot, namespace: next }
  write(NAMESPACE_KEY, next)
  broadcast()
}

export function setNamespaceScope(selector?: string): void {
  const next = selector ?? ''
  if (next === snapshot.namespaceScope) return
  snapshot = { ...snapshot, namespaceScope: next }
  write(SCOPE_KEY, next)
  broadcast()
}

export function getActiveTeam(): string {
  return snapshot.team
}

export function setActiveTeam(slug?: string): void {
  const next = slug ?? ''
  if (next === snapshot.team) return
  snapshot = { ...snapshot, team: next }
  write(TEAM_KEY, next)
  broadcast()
}

export function setTeamShowAll(on: boolean): void {
  if (on === snapshot.teamShowAll) return
  snapshot = { ...snapshot, teamShowAll: on }
  write(TEAM_ALL_KEY, on ? '1' : '')
  broadcast()
}

export function subscribeSelection(listener: () => void): () => void {
  return subscribe(listener)
}

/* ─────────── React hooks ─────────── */

export function useSelection(): Selection {
  return useSyncExternalStore(subscribe, getSelection, getSelection)
}

/** Reactive active-cluster selection — `{ cluster, setCluster }`. */
export function useActiveCluster(): { cluster: string; setCluster: (name: string) => void } {
  const { cluster } = useSelection()
  return { cluster, setCluster: setActiveCluster }
}

/** Reactive active-namespace selection — `{ namespace, setNamespace }`. */
export function useActiveNamespace(): {
  namespace: string | undefined
  setNamespace: (ns?: string) => void
} {
  const { namespace } = useSelection()
  return { namespace: namespace || undefined, setNamespace: setActiveNamespace }
}

/** Reactive org→namespace label selector (`''` when unscoped). */
export function useNamespaceScope(): string {
  return useSelection().namespaceScope
}

/**
 * Reactive team lens.
 *
 * `active` is the team slug being worked in; `showAll` overrides the filter.
 * `filtering` is the question every view actually asks — "should I narrow what
 * I show?" — so callers do not each re-derive it and drift apart.
 */
export function useTeamScope(): {
  team: string
  showAll: boolean
  filtering: boolean
  setTeam: (slug?: string) => void
  setShowAll: (on: boolean) => void
} {
  const { team, teamShowAll } = useSelection()
  return {
    team,
    showAll: teamShowAll,
    filtering: Boolean(team) && !teamShowAll,
    setTeam: setActiveTeam,
    setShowAll: setTeamShowAll,
  }
}
