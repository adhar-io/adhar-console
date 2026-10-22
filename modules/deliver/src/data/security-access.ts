import { CONSOLE_PERMISSIONS, consoleCheck, useAccessReview } from '@adhar/shell-ui'

/**
 * Scan-governance permissions, as Kubernetes RBAC answers them (docs/rbac.md).
 * The same virtual resources the BFF enforces on `/api/security/*`:
 *   approve scan-waivers        approve / reject / revoke, decide gates, re-sync
 *   self-approve scan-waivers   approve a request you made yourself
 *   update scan-policies        change global / project scan policy
 * Each flag is a definite yes only; loading and "couldn't check" read as no.
 * `decided` tells "no" apart from "not answered yet" for read-only notices.
 */
export function useScanGovernanceAccess() {
  const { results } = useAccessReview([
    consoleCheck(CONSOLE_PERMISSIONS.waiverApprove),
    consoleCheck(CONSOLE_PERMISSIONS.waiverSelfApprove),
    consoleCheck(CONSOLE_PERMISSIONS.scanPolicyEdit),
  ])
  return {
    canApprove: results[0] === true,
    canSelfApprove: results[1] === true,
    canEditPolicy: results[2] === true,
    decided: results[0] !== undefined,
  }
}

/**
 * May the user request (or extend) a waiver in at least one of these projects?
 * `create scan-waivers` is asked in each project's namespace — a team that
 * may request waivers for its own project sees the action there only.
 */
export function useCanRequestWaiver(projects: ReadonlyArray<string | undefined>): boolean {
  return useRequestableProjects(projects).size > 0
}

/** The subset of `projects` the user may request waivers in. */
export function useRequestableProjects(projects: ReadonlyArray<string | undefined>): ReadonlySet<string> {
  const list = [...new Set(projects.filter((p): p is string => !!p))].sort()
  const { results } = useAccessReview(
    list.map((p) => consoleCheck(CONSOLE_PERMISSIONS.waiverRequest, p)),
    { enabled: list.length > 0 },
  )
  return new Set(list.filter((_, i) => results[i] === true))
}
