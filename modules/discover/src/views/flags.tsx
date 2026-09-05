import { Card, CardBody, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useFeatureFlags, useToggleFlag } from '../data/observability.ts'
import { LoadingCard, SourceError } from './states.tsx'

export function Flags() {
  const q = useFeatureFlags()
  const toggle = useToggleFlag()

  if (q.isLoading) return <LoadingCard label="Loading flags…" />
  if (q.isError) return <SourceError tool="PostHog" error={q.error} onRetry={() => q.refetch()} />
  const list = q.data ?? []
  if (list.length === 0) {
    return <EmptyState title="No flags" />
  }
  return (
    <Card>
      <CardBody className="p-0!">
        <ul className="divide-y divide-edge-subtle">
          {list.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">
                    {f.key}
                  </code>
                  <span className="truncate text-sm text-content">{f.name}</span>
                  <StatusBadge kind={f.active ? 'healthy' : 'unknown'}>
                    {f.active ? 'on' : 'off'}
                  </StatusBadge>
                </div>
                {f.rollout_percentage != null ? (
                  <div className="mt-1.5">
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="text-content-subtle">rollout</span>
                      <span className="font-mono tabular-nums text-content">
                        {f.rollout_percentage}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                      <div
                        className="h-full bg-linear-to-r from-brand-500 to-brand-400"
                        style={{ width: `${f.rollout_percentage}%` }}
                      />
                    </div>
                  </div>
                ) : null}
                {f.variants?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1 font-mono text-[10px]">
                    {f.variants.map((v) => (
                      <span key={v.key} className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted">
                        {v.key} <span className="text-content">{v.rollout_percentage}%</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-[11px] text-content-subtle">
                  {f.updated_at ? formatRelative(f.updated_at) : formatRelative(f.created_at)}
                </span>
                <Toggle
                  enabled={f.active}
                  onChange={(en) => toggle.mutate({ id: f.id, active: en })}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange(v: boolean): void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        enabled ? 'bg-brand-500' : 'bg-edge-default'
      }`}
      role="switch"
      aria-checked={enabled}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface-raised shadow transition-all ${
          enabled ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}
