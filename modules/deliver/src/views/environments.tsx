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
import type { argocd } from '@adhar-console/api-clients'
import { useApplications, useStages } from '../data/delivery.ts'

/**
 * Environments — synthesised from ArgoCD destinations + Kargo stages.
 *
 * Each row is one cluster/namespace combo with the apps deployed to it,
 * a roll-up sync/health pill, and the matching Kargo stage if any.
 */
export function Environments() {
  const apps = useApplications()
  const stages = useStages()

  const grouped = useMemo(() => {
    const out: Record<string, EnvBucket> = {}
    for (const a of apps.data ?? []) {
      const key = `${a.spec.destination.server}::${a.spec.destination.namespace}`
      if (!out[key]) {
        out[key] = {
          key,
          server: a.spec.destination.server,
          namespace: a.spec.destination.namespace,
          apps: [],
        }
      }
      out[key].apps.push(a)
    }
    return Object.values(out).sort((a, b) => a.namespace.localeCompare(b.namespace))
  }, [apps.data])

  if (apps.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading environments…
      </div>
    )
  }
  if (apps.isError) {
    return <EmptyState title="Couldn't reach ArgoCD" />
  }

  const stageByKey = new Map(
    (stages.data ?? []).map((s) => [s.name.toLowerCase(), s] as const),
  )

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-content-muted">
        {grouped.length} environment{grouped.length === 1 ? '' : 's'} · derived from ArgoCD destinations
      </div>
      {grouped.length === 0 ? (
        <EmptyState title="No environments" description="No ArgoCD destinations registered yet." />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {grouped.map((env) => (
            <EnvCard
              key={env.key}
              env={env}
              kargoStage={stageByKey.get(envClass(env.namespace))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface EnvBucket {
  key: string
  server: string
  namespace: string
  apps: argocd.Application[]
}

function envClass(namespace: string): string {
  if (/-prod\b/.test(namespace) || namespace.endsWith('prod')) return 'prod'
  if (/-stag(ing)?\b/.test(namespace) || namespace.includes('staging')) return 'staging'
  if (/-dev\b/.test(namespace) || namespace.endsWith('dev')) return 'dev'
  return 'prod'
}

function envTone(namespace: string): { bg: string; tone: 'healthy' | 'progressing' | 'paused' | 'unknown' } {
  const cls = envClass(namespace)
  if (cls === 'prod') return { bg: 'from-rose-50 dark:from-rose-500/10 to-surface-raised', tone: 'unknown' }
  if (cls === 'staging') return { bg: 'from-amber-50 dark:from-amber-500/10 to-surface-raised', tone: 'paused' }
  if (cls === 'dev') return { bg: 'from-emerald-50 dark:from-emerald-500/10 to-surface-raised', tone: 'healthy' }
  return { bg: 'from-slate-50 to-surface-raised', tone: 'progressing' }
}

function EnvCard({ env, kargoStage }: { env: EnvBucket; kargoStage?: { name: string; phase: string; lastPromoted?: string } }) {
  const { bg } = envTone(env.namespace)
  const synced = env.apps.filter((a) => a.status.sync.status === 'Synced').length
  const drift = env.apps.filter((a) => a.status.sync.status === 'OutOfSync').length
  const degraded = env.apps.filter((a) => a.status.health.status === 'Degraded').length
  const overall: 'healthy' | 'paused' | 'failed' =
    degraded > 0 ? 'failed' : drift > 0 ? 'paused' : 'healthy'
  const cls = envClass(env.namespace)

  return (
    <Card className={`relative overflow-hidden bg-linear-to-br ${bg} ring-1 ring-inset ring-edge-subtle`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              <span className={`rounded-md px-1.5 py-0.5 text-white ${envTagBg(cls)}`}>{cls}</span>
              <span className="truncate">{env.server.replace(/^https?:\/\//, '')}</span>
            </div>
            <div className="mt-1 truncate text-base font-semibold tracking-tight text-content">
              {env.namespace}
            </div>
          </div>
          <StatusBadge kind={overall}>
            {overall === 'healthy' ? 'healthy' : overall === 'paused' ? 'drifting' : 'degraded'}
          </StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Tile label="Apps" value={env.apps.length} />
          <Tile label="Synced" value={synced} accent="emerald" />
          <Tile label="Drift" value={drift} accent={drift > 0 ? 'amber' : 'slate'} />
        </div>

        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Applications
          </div>
          <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-subtle bg-surface-raised">
            {env.apps.map((a) => (
              <li key={a.metadata.name} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="truncate font-medium text-content">{a.metadata.name}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[10px]">
                  <Pip tone={a.status.sync.status === 'Synced' ? 'emerald' : 'amber'} />
                  {a.status.sync.status}
                </span>
                <span className="inline-flex items-center gap-1 text-[10px]">
                  <Pip
                    tone={
                      a.status.health.status === 'Healthy'
                        ? 'emerald'
                        : a.status.health.status === 'Progressing'
                          ? 'sky'
                          : 'rose'
                    }
                  />
                  {a.status.health.status}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {kargoStage ? (
          <div className="rounded-lg border border-edge-subtle bg-surface-raised/70 p-2.5 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-content">Kargo stage:</span>
              <span className="font-mono text-content-muted">{kargoStage.name}</span>
              <StatusBadge
                kind={
                  kargoStage.phase === 'Steady'
                    ? 'healthy'
                    : kargoStage.phase === 'Promoting' || kargoStage.phase === 'Verifying'
                      ? 'progressing'
                      : kargoStage.phase === 'Failed'
                        ? 'failed'
                        : 'unknown'
                }
              >
                {kargoStage.phase}
              </StatusBadge>
            </div>
            {kargoStage.lastPromoted ? (
              <div className="mt-1 text-content-muted">
                last promoted {formatRelative(kargoStage.lastPromoted)}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

function envTagBg(cls: string): string {
  if (cls === 'prod') return 'bg-rose-500'
  if (cls === 'staging') return 'bg-amber-500'
  if (cls === 'dev') return 'bg-emerald-500'
  return 'bg-slate-500'
}

function Tile({
  label,
  value,
  accent = 'slate',
}: {
  label: string
  value: number
  accent?: 'slate' | 'emerald' | 'amber'
}) {
  const tone = {
    slate: 'text-content',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
  }[accent]
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-raised p-2">
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function Pip({ tone }: { tone: 'emerald' | 'amber' | 'sky' | 'rose' }) {
  const cls = {
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    sky: 'bg-sky-500',
    rose: 'bg-rose-500',
  }[tone]
  return <span className={`h-1.5 w-1.5 rounded-full ${cls}`} />
}
