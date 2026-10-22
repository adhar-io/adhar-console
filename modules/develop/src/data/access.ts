import { type AccessCheck, canResource, useAccessReview } from '@adhar/shell-ui'

/**
 * RBAC checks for the Performance Center's cluster writes (docs/rbac.md).
 * Each asks the verbs the action's requests hit — `kube.apply` is a
 * server-side apply, which needs `patch` and, for a new object, `create`.
 * Writes that go to Gitea (test scripts, configs, baselines) are authorised
 * by Gitea's repository permissions and are not checked here.
 */

const TEST_RUNS = { group: 'k6.io', resource: 'testruns', namespaced: true } as const
const CONFIG_MAPS = { group: '', resource: 'configmaps', namespaced: true } as const
const CRON_JOBS = { group: 'batch', resource: 'cronjobs', namespaced: true } as const
const JOBS = { group: 'batch', resource: 'jobs', namespaced: true } as const
const SERVICE_ACCOUNTS = { group: '', resource: 'serviceaccounts', namespaced: true } as const
const ROLES = { group: 'rbac.authorization.k8s.io', resource: 'roles', namespaced: true } as const
const ROLE_BINDINGS = { group: 'rbac.authorization.k8s.io', resource: 'rolebindings', namespaced: true } as const

const applyChecks = (gvr: { group: string; resource: string; namespaced: true }, namespace: string): AccessCheck[] => [
  canResource(gvr, 'create', { namespace }),
  canResource(gvr, 'patch', { namespace }),
]

/** Start a k6 TestRun (a ConfigMap script, or "Run again" of an existing run). */
export const startTestRunChecks = (namespace: string): AccessCheck[] => applyChecks(TEST_RUNS, namespace)

/** Run a committed test: its `k6-<test>` artefact ConfigMap, then the TestRun. */
export const runPerfTestChecks = (namespace: string): AccessCheck[] => [
  ...applyChecks(CONFIG_MAPS, namespace),
  ...applyChecks(TEST_RUNS, namespace),
]

/** Pause / resume (patch) or delete one TestRun. */
export const testRunCheck = (verb: 'patch' | 'delete', namespace: string, name?: string): AccessCheck =>
  canResource(TEST_RUNS, verb, { namespace, name })

/** Delete a kept result — the `perf-result-*` ConfigMap. */
export const deleteResultCheck = (namespace: string, name?: string): AccessCheck =>
  canResource(CONFIG_MAPS, 'delete', { namespace, name })

/**
 * Install the unattended runner: its ServiceAccount, Role and RoleBinding
 * plus the artefact ConfigMap. Creating the Role/RoleBinding is itself
 * governed by RBAC (no escalation), so the apiserver is the final word.
 */
export const installRunnerChecks = (namespace: string): AccessCheck[] => [
  ...applyChecks(SERVICE_ACCOUNTS, namespace),
  ...applyChecks(ROLES, namespace),
  ...applyChecks(ROLE_BINDINGS, namespace),
  ...applyChecks(CONFIG_MAPS, namespace),
]

/** Create or edit a schedule: the runner, the artefact, then the CronJob. */
export const saveScheduleChecks = (namespace: string): AccessCheck[] => [
  ...installRunnerChecks(namespace),
  ...applyChecks(CRON_JOBS, namespace),
]

/** Suspend / resume (patch) or delete a schedule's CronJob. */
export const cronJobCheck = (verb: 'patch' | 'delete', namespace: string, name?: string): AccessCheck =>
  canResource(CRON_JOBS, verb, { namespace, name })

/** "Run now" — a Job created from the schedule's CronJob. */
export const runScheduleNowChecks = (namespace: string): AccessCheck[] => applyChecks(JOBS, namespace)

/**
 * Which of `namespaces` allow an action, given the checks it needs in each.
 * One batched review; a namespace counts only when every check is a definite
 * yes, so loading and "couldn't check" read as not allowed (hidden).
 */
export function useAllowedNamespaces(
  namespaces: ReadonlyArray<string | undefined>,
  checksFor: (namespace: string) => AccessCheck[],
): ReadonlySet<string> {
  const list = [...new Set(namespaces.filter((n): n is string => !!n))].sort()
  const per = list.map(checksFor)
  const { results } = useAccessReview(per.flat(), { enabled: list.length > 0 })
  const out = new Set<string>()
  let i = 0
  list.forEach((ns, k) => {
    const n = per[k].length
    if (results.slice(i, i + n).every((r) => r === true)) out.add(ns)
    i += n
  })
  return out
}
