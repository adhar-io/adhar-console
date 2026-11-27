/**
 * Argo Workflows' kinds and the labels this module reads (design 0026 §6.2,
 * F-10, §4.7). Pure constants: imported by data, views and tests alike.
 */

export const ARGO_GROUP = 'argoproj.io'
export const ARGO_VERSION = 'v1alpha1'

const argo = (resource: string, namespaced = true) => ({ group: ARGO_GROUP, version: ARGO_VERSION, resource, namespaced }) as const

export const WORKFLOWS = argo('workflows')
export const WORKFLOW_TEMPLATES = argo('workflowtemplates')
export const CLUSTER_WORKFLOW_TEMPLATES = argo('clusterworkflowtemplates', false)
export const CRON_WORKFLOWS = argo('cronworkflows')
export const WORKFLOW_EVENT_BINDINGS = argo('workfloweventbindings')
export const GAMEDAYS = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'gamedays', namespaced: true } as const
export const PROJECTS = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'projects', namespaced: true } as const
export const PODS = { group: '', version: 'v1', resource: 'pods', namespaced: true } as const
export const EVENTS = { group: '', version: 'v1', resource: 'events', namespaced: true } as const

/** Where Project XRs (and platform workflows) live. */
export const CONTROL_PLANE_NS = 'adhar-system'

/** Argo's own labels (F-10) and the platform's (§4.7). */
export const LABEL = {
  phase: 'workflows.argoproj.io/phase',
  completed: 'workflows.argoproj.io/completed',
  template: 'workflows.argoproj.io/workflow-template',
  clusterTemplate: 'workflows.argoproj.io/cluster-workflow-template',
  cron: 'workflows.argoproj.io/cron-workflow',
  eventBinding: 'workflows.argoproj.io/workflow-event-binding',
  resubmittedFrom: 'workflows.argoproj.io/resubmitted-from-workflow',
  creatorUsername: 'workflows.argoproj.io/creator-preferred-username',
  creatorEmail: 'workflows.argoproj.io/creator-email',
  submitter: 'adhar.io/submitter',
  hasApprovals: 'adhar.io/has-approvals',
  templateSpecHash: 'adhar.io/template-spec-hash',
  catalog: 'adhar.io/catalog',
  catalogTags: 'adhar.io/catalog-tags',
  team: 'adhar.io/team',
  draft: 'adhar.io/workflow-draft',
  gameday: 'adhar.io/chaos-gameday',
} as const

export const ANNOTATION = {
  submittedBy: 'adhar.io/submitted-by',
  source: 'adhar.io/source',
  specHash: 'adhar.io/spec-hash',
  positions: 'adhar.io/designer-positions',
  title: 'workflows.argoproj.io/title',
  description: 'workflows.argoproj.io/description',
  nodeId: 'workflows.argoproj.io/node-id',
} as const

/** Active runs: Argo labels a finished workflow `completed=true`. */
export const ACTIVE_SELECTOR = `${LABEL.completed}!=true`
/** Runs inside the TTL window that have finished. */
export const FINISHED_SELECTOR = `${LABEL.completed}=true`

/** The console never lists more than this many live objects per request (§4.4). */
export const LIST_LIMIT = 200

/** Every Workflows section id (`?section=`), in nav order. */
export const SECTIONS = ['workflows', 'workflow-catalog', 'workflow-runs', 'workflow-history', 'workflow-engine'] as const
export type WorkflowSection = typeof SECTIONS[number]

/** Sections designed but not built in W1 (designer W2; schedules, triggers W4). */
export const LATER_SECTIONS: Record<string, string> = {
  'workflow-designer': 'The designer arrives with phase W2.',
  'workflow-schedules': 'Schedules arrive with phase W4.',
  'workflow-triggers': 'Triggers arrive with phase W4.',
}
