import { Card, CardBody, CardHeader, EmptyState, StatusBadge } from '@adhar/shell-ui'
import { useCRD } from '../data/k8s.ts'

const CONTROL_PLANE_NS = 'adhar-system'
const FUNCTIONS_GVR = {
  group: 'platform.adhar.io',
  version: 'v1alpha1',
  resource: 'functions',
  namespaced: true,
} as const
const TEST_RUNS_GVR = {
  group: 'k6.io',
  version: 'v1alpha1',
  resource: 'testruns',
  namespaced: true,
} as const
const CHAOS_ENGINES_GVR = {
  group: 'litmuschaos.io',
  version: 'v1alpha1',
  resource: 'chaosengines',
  namespaced: true,
} as const

function readyKind(conditions?: Array<{ type?: string; status?: string }>) {
  const ready = conditions?.find((c) => c.type === 'Ready')?.status
  if (ready === 'True') return 'healthy'
  if (ready === 'False') return 'failed'
  return 'unknown'
}

export function Functions() {
  const q = useCRD(FUNCTIONS_GVR, CONTROL_PLANE_NS, true)
  const perfQ = useCRD(TEST_RUNS_GVR, CONTROL_PLANE_NS, true)
  const chaosQ = useCRD(CHAOS_ENGINES_GVR, CONTROL_PLANE_NS, true)
  const rows = (q.data ?? []) as Array<{
    metadata: { name: string }
    spec?: { parameters?: { runtime?: string; trigger?: string; minScale?: number; maxScale?: number } }
    status?: { url?: string; conditions?: Array<{ type?: string; status?: string }> }
  }>
  const testRuns = (perfQ.data ?? []) as Array<{ status?: { stage?: string } }>
  const chaosEngines = (chaosQ.data ?? []) as Array<{ status?: { engineStatus?: string } }>
  const activeTests = testRuns.filter((r) => {
    const stage = (r.status?.stage ?? '').toLowerCase()
    return stage !== '' && stage !== 'finished' && stage !== 'stopped' && stage !== 'error'
  }).length
  const activeChaos = chaosEngines.filter((e) => {
    const state = (e.status?.engineStatus ?? '').toLowerCase()
    return state !== '' && state !== 'completed' && state !== 'stopped'
  }).length

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card>
          <CardBody>
            <div className="text-xs text-content-subtle">Functions</div>
            <div className="text-2xl font-semibold">{rows.length}</div>
            <div className="text-xs text-content-subtle">Platform Function resources in {CONTROL_PLANE_NS}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-content-subtle">Performance runs</div>
            <div className="text-2xl font-semibold">{activeTests}</div>
            <div className="text-xs text-content-subtle">
              {perfQ.isError ? 'k6 unavailable' : `${testRuns.length} total TestRuns`}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-content-subtle">Chaos runs</div>
            <div className="text-2xl font-semibold">{activeChaos}</div>
            <div className="text-xs text-content-subtle">
              {chaosQ.isError ? 'Litmus unavailable' : `${chaosEngines.length} total ChaosEngines`}
            </div>
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Function operations</div>
          <div className="text-[11px] text-content-subtle">
            Runtime status for Function XR resources, with delivery operations context for performance and chaos.
          </div>
        </CardHeader>
        <CardBody className="p-0!">
          {q.isLoading ? (
            <div className="px-4 py-5 text-sm text-content-subtle">Loading functions…</div>
          ) : q.isError ? (
            <EmptyState
              compact
              title="Could not load functions"
              description={q.error instanceof Error ? q.error.message : String(q.error)}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              compact
              title="No functions found"
              description="Create functions under Develop → Functions, then track runtime and delivery status here."
              action={<a className="text-sm text-brand-600 hover:underline" href="/develop?section=functions">Open Develop Functions</a>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-surface-muted text-content-subtle">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Runtime</th>
                    <th className="px-3 py-2 text-left font-medium">Trigger</th>
                    <th className="px-3 py-2 text-left font-medium">Scale</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Operations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {rows.map((fn) => {
                    const p = fn.spec?.parameters
                    return (
                      <tr key={fn.metadata.name}>
                        <td className="px-3 py-2 font-medium">{fn.metadata.name}</td>
                        <td className="px-3 py-2">{p?.runtime ?? '—'}</td>
                        <td className="px-3 py-2">{p?.trigger ?? 'http'}</td>
                        <td className="px-3 py-2">{`${p?.minScale ?? 0}–${p?.maxScale ?? 0}`}</td>
                        <td className="px-3 py-2"><StatusBadge kind={readyKind(fn.status?.conditions)}>{readyKind(fn.status?.conditions)}</StatusBadge></td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-2">
                            <a className="text-xs text-brand-600 hover:underline" href={`/deliver?section=performance&app=${encodeURIComponent(fn.metadata.name)}`}>Performance</a>
                            <a className="text-xs text-brand-600 hover:underline" href={`/deliver?section=chaos&app=${encodeURIComponent(fn.metadata.name)}`}>Chaos</a>
                            {fn.status?.url ? <a className="text-xs text-brand-600 hover:underline" href={fn.status.url} target="_blank" rel="noreferrer">Open URL</a> : null}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
