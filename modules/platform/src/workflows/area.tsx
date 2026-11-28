import { lazy, Suspense, useCallback } from 'react'
import { Button, Can, CONSOLE_PERMISSIONS, consoleCheck, EmptyState, PageHeader, Tabs, useCan } from '@adhar/shell-ui'
import { ConnectionGate } from '../components/connection-banner.tsx'
import { LATER_SECTIONS, SECTIONS, type WorkflowSection } from './data/gvr.ts'
import { goToSection, useCapabilities, useIsPlatformStaff, useScope, useWfParams } from './data/hooks.ts'
import type { Workflow } from './data/nodes.ts'
import { Loading, parseRunRef } from './views/common.tsx'
import { CatalogView } from './views/catalog.tsx'
import { EngineView } from './views/engine.tsx'
import { HistoryView } from './views/history.tsx'
import { OverviewView } from './views/overview.tsx'
import { RunView } from './views/run-view.tsx'
import { RunsView, type RunsTab } from './views/runs.tsx'

// The designer brings the YAML model (`yaml`) and, once a document is open,
// the edit canvas (@xyflow): neither belongs in the chunk every Workflows page loads.
const DesignerView = lazy(() => import('./views/designer.tsx').then((m) => ({ default: m.DesignerView })))

/**
 * Platform → Workflows (design 0026 §6.1): the section router, the capability
 * gate and the run drawer every page can open.
 *
 * Loaded on demand by `home.tsx` for every `workflows` / `workflow-*` section.
 * The canvases (@xyflow) are NOT among its static imports: the run view loads
 * the run canvas when its Graph tab renders and the designer loads the edit
 * canvas when it opens a document (W1 acceptance 5, `chunks_test.ts`).
 *
 * The gate asks one thing — the capability probe — and when Argo's CRDs are
 * absent every page says so in one honest state, with the way to enable it for
 * the people who can (the pattern game days use).
 */

const TITLES: Record<WorkflowSection, { label: string; description: string }> = {
  workflows: { label: 'Overview', description: 'What is running, what needs you, and what just happened.' },
  'workflow-catalog': { label: 'Catalog', description: 'Workflow templates you can run, with how they have been doing.' },
  'workflow-designer': { label: 'Designer', description: 'Build a workflow on a canvas, and test-run it in dev.' },
  'workflow-runs': { label: 'Runs', description: 'Every run in your namespaces, live.' },
  'workflow-history': { label: 'History', description: 'Finished runs from the archive (60 days).' },
  'workflow-engine': { label: 'Engine', description: 'The workflow controller, archive and limits.' },
}

export function WorkflowsArea({ section }: { section: string }) {
  const later = LATER_SECTIONS[section]
  const active = ((SECTIONS as readonly string[]).includes(section) ? section : 'workflows') as WorkflowSection
  const [params, setParams] = useWfParams()
  const caps = useCapabilities()
  const scope = useScope()
  const platform = useIsPlatformStaff()
  const admin = useCan(consoleCheck(CONSOLE_PERMISSIONS.workflowsAdmin))
  const runRef = parseRunRef(params.run)
  const openRun = useCallback((w: Workflow) => {
    if (w.metadata.namespace && w.metadata.name) setParams({ run: `${w.metadata.namespace}/${w.metadata.name}`, node: undefined, tab: undefined }, true)
  }, [setParams])
  const tabs = SECTIONS.filter((s) => s !== 'workflow-engine' || admin || platform).map((id) => ({ id, label: TITLES[id].label, description: TITLES[id].description }))

  return (
    <div className="space-y-6">
      <PageHeader title="Workflows" />
      <ConnectionGate>
        {caps.isLoading ? <Loading label="Checking for Argo Workflows…" /> : !caps.caps.installed ? (
          <NotInstalled />
        ) : (
          <Tabs tabs={tabs} value={later ? 'workflows' : active} onChange={(id) => goToSection(id)} ariaLabel="Workflows">
            {() => (
              <div className="space-y-4 pt-4">
                {caps.bff && !caps.caps.argoServer.reachable ? (
                  <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                    The console cannot reach argo-server. Runs, submit, stop and resubmit still work; retry, approvals, logs after clean-up and History need it.
                  </p>
                ) : !caps.bff ? (
                  <p role="status" className="rounded-lg border border-edge-default bg-surface-sunken px-3 py-2 text-xs text-content-muted">
                    This console server has no Workflows API yet: runs are read from the cluster directly, and retry, approvals and History are unavailable.
                  </p>
                ) : null}
                {later ? (
                  <EmptyState title="Not in this release yet" description={later} action={<Button size="sm" onClick={() => goToSection('workflows')}>Go to the overview</Button>} />
                ) : active === 'workflows' ? (
                  <OverviewView scope={scope} caps={caps.caps} platform={platform} onOpenRun={openRun} onSection={(s, extra) => goToSection(s, extra)} />
                ) : active === 'workflow-catalog' ? (
                  <CatalogView scope={scope} q={params.q} onQuery={(q) => setParams({ q: q || undefined })} onOpenRun={openRun} onHistory={(e) => goToSection('workflow-history', { ...(e.namespace ? { ns: e.namespace } : {}), q: e.name })} onDesign={(e) => goToSection('workflow-designer', { ...(e.namespace ? { ns: e.namespace } : {}), q: e.name, view: e.kind })} />
                ) : active === 'workflow-designer' ? (
                  <Suspense fallback={<Loading label="Loading the designer…" />}>
                    <DesignerView
                      scope={scope}
                      caps={caps.caps}
                      ns={params.ns}
                      name={params.q}
                      kind={params.view}
                      onParams={(p) => setParams(p)}
                      onOpenRun={(r) => setParams({ run: `${r.namespace}/${r.name}`, node: undefined, tab: 'graph' }, true)}
                    />
                  </Suspense>
                ) : active === 'workflow-runs' ? (
                  <RunsView scope={scope} tab={params.view} onTab={(t: RunsTab) => setParams({ view: t })} onOpen={openRun} />
                ) : active === 'workflow-history' ? (
                  <HistoryView scope={scope} caps={caps.caps} ns={params.ns} uid={params.uid} template={params.q} onParams={(p, push) => setParams(p, push)} />
                ) : (
                  admin || platform ? <EngineView caps={caps.caps} /> : <EmptyState title="The engine page is for platform staff" />
                )}
              </div>
            )}
          </Tabs>
        )}
      </ConnectionGate>
      {runRef && caps.caps.installed ? (
        <RunView
          namespace={runRef.namespace}
          name={runRef.name}
          tab={params.tab}
          node={params.node}
          caps={caps.caps}
          onClose={() => setParams({ run: undefined, node: undefined, tab: undefined })}
          onParams={(p) => setParams(p)}
        />
      ) : null}
    </div>
  )
}

function NotInstalled() {
  return (
    <EmptyState
      title="Argo Workflows is not enabled on this cluster"
      description="Workflows run on the platform's Argo Workflows package. Once it is enabled, templates, runs, approvals and history appear here."
      action={
        <Can check={consoleCheck(CONSOLE_PERMISSIONS.packagesToggle)}>
          <Button size="sm" onClick={() => goToSection('marketplace')}>Enable it in Marketplace</Button>
        </Can>
      }
    />
  )
}
