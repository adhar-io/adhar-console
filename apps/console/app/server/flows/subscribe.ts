/**
 * `/api/live` topic `flows` — one viewer of the shared FlowsHub.
 *
 * Access is resolved AS THE VIEWER (SelfSubjectAccessReview through the
 * shared access cache): cluster-wide `list pods` → every namespace; otherwise
 * the namespaces in current traffic where they may `list pods`. Until the
 * first answer lands the viewer receives no frames; a failed check is a "no".
 */

import type { AccessCheck } from '@adhar/auth/server'
import type { K8sIdentity } from '../k8s/gateway.ts'
import { checkAccess, identityKey } from '../k8s/access.ts'
import type { Allow } from './aggregate.ts'
import { ACCESS_REFRESH_MS, type FlowsHub, parseView, sharedHub, type Viewer } from './hub.ts'

type Json = Record<string, unknown>

export type AccessChecker = (checks: AccessCheck[]) => Promise<{ results: boolean[]; degraded: boolean }>

/** Which namespaces this viewer may see flows for. Pure given the checker. */
export async function resolveAllow(check: AccessChecker, candidates: string[]): Promise<{ allow: Allow; degraded: boolean }> {
  const wide = await check([{ verb: 'list', resource: 'pods' }])
  if (wide.results[0]) return { allow: '*', degraded: false }
  const ns = [...new Set(candidates)].slice(0, 200)
  if (!ns.length) return { allow: new Set(), degraded: wide.degraded }
  const res = await check(ns.map((namespace) => ({ verb: 'list', resource: 'pods', namespace })))
  return { allow: new Set(ns.filter((_, i) => res.results[i])), degraded: wide.degraded || res.degraded }
}

export function subscribeFlows(
  sid: string,
  id: K8sIdentity,
  params: Json,
  send: (m: Json) => void,
  deps: { hub?: FlowsHub; check?: AccessChecker } = {},
): { stop(): void } {
  const hub = deps.hub ?? sharedHub()
  const check = deps.check ?? ((checks: AccessCheck[]) => checkAccess(id, checks))
  let stopped = false
  const viewer: Viewer = {
    accessKey: identityKey(id),
    allow: null,
    view: { ...parseView(params), allow: new Set() },
    push: (m) => {
      if (!stopped) send({ ...m, id: sid })
    },
  }
  const requested = viewer.view.namespaces ?? []
  const refresh = async () => {
    try {
      const { allow, degraded } = await resolveAllow(check, [...hub.agg.namespaces(), ...requested])
      if (stopped) return
      viewer.allow = allow
      viewer.view.allow = allow
      if (degraded) viewer.push({ op: 'notice', message: 'Some namespace access checks could not be made; those namespaces are hidden.' })
    } catch {
      // Fail closed — keep whatever was granted before (nothing, on first try).
    }
  }
  const leave = hub.join(viewer)
  void refresh()
  // Traffic reaches new namespaces over time; re-ask about them every minute.
  const timer = setInterval(() => void refresh(), ACCESS_REFRESH_MS)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
      leave()
    },
  }
}
