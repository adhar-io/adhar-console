import { Tabs, type TabDef } from '@adhar/shell-ui'
import { TektonPipelineRuns, TektonPipelines, TektonTasks, TektonTriggers } from './tekton.tsx'

/**
 * CI / CD runs — the Tekton surface, behind one tab row.
 *
 * PipelineRuns with a task DAG, per-step logs and re-run / cancel / delete
 * management, plus Pipelines, Tasks and Triggers. Each tab lives in
 * `tekton.tsx`; this file is only the shell that switches between them.
 *
 * There was a fifth tab here, Argo Workflows, with its own table and drawer
 * reading `argoproj.io/v1alpha1 workflows` straight from the apiserver. Argo
 * Workflows is an optional package rather than part of the platform, so the
 * console no longer presents it as installed — and with the tab went every
 * helper in this file, because all of them existed for it.
 *
 * CI on this platform is Tekton.
 */

type Source = 'runs' | 'pipelines' | 'tasks' | 'triggers'

const SOURCE_TABS: readonly TabDef<Source>[] = [
  { id: 'runs', label: 'PipelineRuns' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'triggers', label: 'Triggers' },
]

export function CiRunsView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Source> tabs={SOURCE_TABS} defaultValue="runs" ariaLabel="CI / CD source">
      {(active) => (
        <>
          {active === 'runs' && <TektonPipelineRuns namespace={namespace} />}
          {active === 'pipelines' && <TektonPipelines namespace={namespace} />}
          {active === 'tasks' && <TektonTasks namespace={namespace} />}
          {active === 'triggers' && <TektonTriggers namespace={namespace} />}
        </>
      )}
    </Tabs>
  )
}

export default CiRunsView
