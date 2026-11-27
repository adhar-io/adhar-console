import { useMemo } from 'react'
import { Button, EmptyState, useOptionalUser } from '@adhar/shell-ui'
import { approvalsFor } from '../data/approvals.ts'
import type { Capabilities } from '../data/api.ts'
import { catalogEntries } from '../data/catalog.ts'
import { WORKFLOWS } from '../data/gvr.ts'
import { type Scope, ScopeWatches, TemplateWatches, useEngine, useNow, usePendingApprovals, useRuns, useTemplates } from '../data/hooks.ts'
import { isFinished, msOf, runPhase, type Workflow } from '../data/nodes.ts'
import { ApprovalCard } from './approval-card.tsx'
import { ErrorNote, KpiCard, Loading, ScopeLine, Section } from './common.tsx'
import { EngineStrip } from './engine.tsx'
import { RunTable } from './runs.tsx'

/**
 * Workflows → Overview (design 0026 §6.9): the KPI row, "Needs your
 * attention" (approvals you may decide, answered in place; failed runs;
 * suspended or erroring schedules), recent runs and quick actions — plus the
 * engine strip for platform staff.
 *
 * This chunk must not contain @xyflow (W1 acceptance 5): it imports no canvas
 * and opens runs through the area, whose run view loads the canvas on demand.
 * `chunks_test.ts` walks this file's static imports to keep it that way.
 */

const DAY = 86_400_000

export function OverviewView({ scope, caps, platform, onOpenRun, onSection }: {
  scope: Scope
  caps: Capabilities
  platform: boolean
  onOpenRun(w: Workflow): void
  onSection(section: string, extra?: Record<string, string>): void
}) {
  const runs = useRuns(scope, undefined)
  const t = useTemplates(scope)
  const user = useOptionalUser()
  const engine = useEngine(platform && caps.argoServer.reachable)
  const items = useMemo(() => runs.data?.items ?? [], [runs.data])
  const anyRunning = items.some((w) => !isFinished(w))
  const now = useNow(anyRunning, 5_000)
  const approvals = usePendingApprovals(items)
  const mine = approvalsFor(approvals, user)

  const k = useMemo(() => {
    const since = now - DAY
    const done = items.filter((w) => isFinished(w) && (msOf(w.status?.finishedAt) ?? 0) >= since)
    return {
      running: items.filter((w) => runPhase(w) === 'Running').length,
      queued: items.filter((w) => runPhase(w) === 'Pending').length,
      succeeded: done.filter((w) => runPhase(w) === 'Succeeded').length,
      failed: done.filter((w) => runPhase(w) === 'Failed' || runPhase(w) === 'Error').length,
    }
  }, [items, now])
  const failedRecent = useMemo(() => items.filter((w) => (runPhase(w) === 'Failed' || runPhase(w) === 'Error') && now - (msOf(w.status?.finishedAt) ?? 0) < DAY).slice(0, 5), [items, now])
  const schedules = useMemo(() => {
    const crons = t.data ? catalogEntries([], [], t.data.crons.items) : []
    return crons
      .map((e) => {
        const err = e.object.status?.conditions?.find((c) => c.status === 'True' && /Error/i.test(c.type ?? ''))
        return { e, err: err?.message ?? (err ? err.type : undefined) }
      })
      .filter((x) => x.err || x.e.suspended)
  }, [t.data])

  return (
    <div className="space-y-6">
      <ScopeWatches gvr={WORKFLOWS} mode={runs.data?.mode} namespaces={scope.namespaces.map((n) => n.namespace)} denied={runs.data?.denied} queryKeys={[runs.queryKey]} />
      <TemplateWatches scope={scope} mode={t.data?.crons.mode} queryKey={t.queryKey} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScopeLine scope={scope} mode={runs.data?.mode} denied={runs.data?.denied} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onSection('workflow-catalog')}>Run a template</Button>
          <Button size="sm" variant="secondary" onClick={() => onSection('workflow-catalog')}>Browse catalog</Button>
          <Button size="sm" variant="ghost" onClick={() => onSection('workflow-runs')}>All runs</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Running now" value={k.running} onClick={() => onSection('workflow-runs', { view: 'active' })} />
        <KpiCard label="Queued" value={k.queued} hint="Pending (parallelism)" tone={k.queued ? 'warn' : 'default'} />
        <KpiCard label="Succeeded · 24h" value={k.succeeded} tone="good" hint="live runs" />
        <KpiCard label="Failed · 24h" value={k.failed} tone={k.failed ? 'bad' : 'default'} hint="live runs" onClick={() => onSection('workflow-runs', { view: 'recent' })} />
        <KpiCard label="Approvals for me" value={mine.length} tone={mine.length ? 'warn' : 'default'} />
        <KpiCard label="Failing schedules" value={schedules.filter((s) => s.err).length} tone={schedules.some((s) => s.err) ? 'bad' : 'default'} />
      </div>
      {platform && caps.argoServer.reachable ? <EngineStrip engine={engine.data} /> : null}

      <Section title="Needs your attention">
        {runs.isLoading ? <Loading /> : !mine.length && !failedRecent.length && !schedules.length ? (
          <EmptyState compact title="Nothing needs you right now" description="Approvals you can decide, failed runs and broken schedules show up here." />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {mine.map((a) => <ApprovalCard key={`${a.namespace}/${a.run}/${a.nodeId}`} approval={a} compact />)}
            {failedRecent.map((w) => (
              <button key={`${w.metadata.namespace}/${w.metadata.name}`} type="button" onClick={() => onOpenRun(w)} className="flex flex-col items-start gap-1 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-left text-xs hover:border-rose-500/60">
                <span className="font-medium text-rose-700 dark:text-rose-300">Run failed</span>
                <span className="font-mono text-content">{w.metadata.namespace}/{w.metadata.name}</span>
                {w.status?.message ? <span className="line-clamp-2 text-content-muted">{w.status.message}</span> : null}
              </button>
            ))}
            {schedules.map(({ e, err }) => (
              <div key={e.key} className="flex flex-col gap-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <span className="font-medium text-amber-800 dark:text-amber-300">{err ? 'Schedule erroring' : 'Schedule suspended'}</span>
                <span className="font-mono text-content">{e.namespace}/{e.name}</span>
                {err ? <span className="line-clamp-2 text-content-muted">{err}</span> : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent runs" actions={<Button size="xs" variant="ghost" onClick={() => onSection('workflow-runs')}>See all</Button>}>
        {runs.isLoading ? <Loading label="Loading runs…" /> : runs.error ? <ErrorNote title="Could not list runs" error={runs.error} /> : (
          <RunTable rows={items.slice(0, 10)} now={now} onOpen={onOpenRun} compact empty={{ title: 'No runs yet', description: 'Run a template from the Catalog to see it here, live.' }} />
        )}
      </Section>
    </div>
  )
}
