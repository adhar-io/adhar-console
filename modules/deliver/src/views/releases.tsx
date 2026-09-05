import { useMemo } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useApplications, useFreight, useRepositories, useStages } from '../data/delivery.ts'

interface Release {
  id: string
  service: string
  tag: string
  digest?: string
  pushedAt: string
  stages: { name: string; phase: string; promotedAt?: string; current: boolean }[]
}

/**
 * Releases — derived view.
 *
 * Cross-references Harbor artifact tags, Kargo freight, and Kargo stage
 * promotion history into "release" rows. Each release shows its current
 * environment in the promotion pipeline plus the trail of stages it has
 * already cleared.
 */
export function Releases() {
  const repos = useRepositories()
  const stages = useStages()
  const freight = useFreight()
  const apps = useApplications()

  const releases = useMemo(() => {
    const rels: Release[] = []
    const stageList = stages.data ?? []
    const freightList = freight.data ?? []

    for (const f of freightList) {
      for (const img of f.images) {
        const service = img.repoURL.split('/').pop() ?? img.repoURL
        rels.push({
          id: `${f.id}:${service}:${img.tag}`,
          service,
          tag: img.tag,
          pushedAt: f.created,
          stages: stageList.map((s) => ({
            name: s.name,
            phase: s.phase,
            current: s.currentFreight === f.id,
            promotedAt: s.currentFreight === f.id ? s.lastPromoted : undefined,
          })),
        })
      }
    }
    rels.sort((a, b) => +new Date(b.pushedAt) - +new Date(a.pushedAt))
    return rels
  }, [freight.data, stages.data])

  if (repos.isLoading || stages.isLoading || freight.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading releases…
      </div>
    )
  }

  const appByName = new Map((apps.data ?? []).map((a) => [a.metadata.name, a]))

  if (releases.length === 0) {
    return (
      <EmptyState
        title="No releases yet"
        description="Releases appear when freight is created and promoted through Kargo stages."
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-content-muted">
        {releases.length} release{releases.length === 1 ? '' : 's'} · derived from Kargo freight × stages × Harbor tags
      </div>
      <div className="space-y-3">
        {releases.map((r) => (
          <ReleaseCard key={r.id} release={r} app={appByName.get(r.service)} />
        ))}
      </div>
    </div>
  )
}

function ReleaseCard({
  release,
  app,
}: {
  release: Release
  app?: { status: { sync: { status: string }; health: { status: string } } }
}) {
  const current = release.stages.find((s) => s.current)
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <code className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">
                {release.service}
              </code>
              <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
                {release.tag}
              </span>
              <span className="text-[11px] text-content-muted">
                pushed {formatRelative(release.pushedAt)}
              </span>
            </div>
          </div>
          {current ? (
            <StatusBadge
              kind={
                current.phase === 'Steady'
                  ? 'healthy'
                  : current.phase === 'Promoting' || current.phase === 'Verifying'
                    ? 'progressing'
                    : 'unknown'
              }
            >
              live in {current.name}
            </StatusBadge>
          ) : (
            <StatusBadge kind="unknown">staged</StatusBadge>
          )}
          {app ? (
            <StatusBadge
              kind={
                app.status.health.status === 'Healthy'
                  ? 'healthy'
                  : app.status.health.status === 'Degraded'
                    ? 'failed'
                    : 'progressing'
              }
            >
              {app.status.health.status}
            </StatusBadge>
          ) : null}
        </div>
      </CardHeader>
      <CardBody>
        <PromotionTrail stages={release.stages} />
      </CardBody>
    </Card>
  )
}

function PromotionTrail({ stages }: { stages: Release['stages'] }) {
  return (
    <ol className="flex items-center gap-1.5">
      {stages.map((s, i) => {
        const cleared = !!s.promotedAt
        const live = s.current
        return (
          <li key={s.name} className="flex flex-1 items-center gap-1.5">
            <div
              className={`flex flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${
                live
                  ? 'border-brand-400 bg-brand-50 text-brand-800'
                  : cleared
                    ? 'border-emerald-200 bg-emerald-50/40 text-emerald-800'
                    : 'border-edge-subtle bg-surface-sunken/40 text-content-muted'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  live ? 'bg-brand-500' : cleared ? 'bg-emerald-500' : 'bg-content-subtle'
                }`}
              />
              <span className="font-mono font-semibold">{s.name}</span>
              <span className="ml-auto text-[10px]">
                {live ? s.phase : cleared ? 'promoted' : 'pending'}
              </span>
            </div>
            {i < stages.length - 1 ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-content-subtle">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
