import { type AccessCheck, CONSOLE_PERMISSIONS, consoleCheck } from '@adhar/auth/server'
import { type LintRequest, lintResource, type Route } from './model.ts'

/**
 * Operation → the ONE authorization question it needs (design 0026 §6.4).
 *
 * Every `/api/workflows/*` route is answered by a SelfSubjectAccessReview sent
 * AS THE SIGNED-IN USER through `k8s/access.ts` `authorize` — the same cache
 * and identity as the browser's `<Can>`, so a button that is shown is a request
 * that passes. The check is decided here, before any upstream call, and
 * nothing in a handler may widen it.
 *
 * Why this matters more than usual: argo-server has no per-user impersonation
 * (F-3). When the console's API server rejects user tokens, the BFF calls
 * argo-server with the `adhar-console-argo` ServiceAccount, which can act in
 * EVERY namespace. This table plus namespace pinning (`argo-server.ts`) is then
 * the whole boundary between a team member and another team's runs.
 *
 * `null` = signed in is enough (capabilities: what the cluster has installed,
 * which says nothing about anyone's runs).
 */

export const ARGO_GROUP = 'argoproj.io'

const wf = (verb: string, namespace: string, resource = 'workflows'): AccessCheck => ({ verb, group: ARGO_GROUP, resource, namespace })

export function checkFor(route: Route, lint?: LintRequest): AccessCheck | null {
  switch (route.op) {
    case 'capabilities':
      return null
    case 'run.get':
    case 'run.artifact':
    case 'archive.get':
      return wf('get', route.namespace)
    case 'run.retry':
    case 'run.approve':
      return wf('update', route.namespace)
    case 'run.resubmit':
    case 'archive.retry':
    case 'archive.resubmit':
      return wf('create', route.namespace)
    case 'run.logs':
      return { verb: 'get', group: '', resource: 'pods', subresource: 'log', namespace: route.namespace }
    case 'archive.list':
      return wf('list', route.namespace)
    case 'archive.delete':
    case 'engine.get':
    case 'engine.suspend-all':
      return consoleCheck(CONSOLE_PERMISSIONS.workflowsAdmin)
    case 'lint': {
      if (!lint) throw new Error('lint needs its parsed request to choose a check')
      const resource = lintResource(lint.kind)
      // A ClusterWorkflowTemplate is cluster-scoped: asking in a namespace would
      // be answered by a namespaced RoleBinding, which cannot grant it.
      return lint.kind === 'ClusterWorkflowTemplate'
        ? { verb: 'create', group: ARGO_GROUP, resource }
        : wf('create', lint.namespace as string, resource)
    }
  }
}

/** Mutations, recorded with `writeAudit` (design 0026 §6.10). */
export const AUDIT_ACTION: Partial<Record<Route['op'], string>> = {
  'run.retry': 'workflow.retry',
  'run.resubmit': 'workflow.resubmit',
  'archive.retry': 'workflow.retry',
  'archive.resubmit': 'workflow.resubmit',
  'archive.delete': 'workflow.delete',
  'engine.suspend-all': 'workflow.engine.suspend-all',
}
