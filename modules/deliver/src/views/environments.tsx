import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Card,
  CardBody,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { argocd } from '@adhar-console/api-clients'
import { useApplications, useStages } from '../data/delivery.ts'
import {
  endpointOf,
  formatBytes,
  matchStage,
  useArgoClusters,
  useEnvironmentModel,
  useLocalNamespaces,
  useLocalNodes,
  useNamespaceDeployments,
  useNamespacePods,
  type ClusterRow,
  type EnvHealth,
  type EnvironmentRow,
  type ProviderId,
} from '../data/environments.ts'
import { age } from '../data/format.ts'

/**
 * **Environments** — every place the platform actually deploys to.
 *
 * The page is organised cluster-first, because that is the real shape of the
 * thing: a cluster is a machine (or a fleet of them) somewhere specific, and an
 * environment is a namespace inside it. Grouping by namespace alone — which is
 * what this page used to do — produced two identical-looking `adhar-system`
 * cards for two entirely different clusters, and guessed at an environment's
 * health from its name.
 *
 * Every fact here is sourced, and the UI says which source it came from:
 *
 *   • **Argo CD** knows the cluster registry, so it covers remote clusters the
 *     console holds no credentials for — another cloud, or an on-prem box.
 *     It reports connection state, Kubernetes version, cached resource counts
 *     and Application health.
 *   • **The Kubernetes gateway** adds live infrastructure for the clusters it
 *     can reach: nodes, provider, region, CPU/memory capacity, running pods.
 *     Where it can't reach, that detail is simply absent — never estimated.
 */

const HEALTH_KIND: Record<EnvHealth, StatusKind> = {
  healthy: 'healthy',
  degraded: 'degraded',
  progressing: 'progressing',
  drift: 'paused',
  unknown: 'unknown',
}

const HEALTH_LABEL: Record<EnvHealth, string> = {
  healthy: 'healthy',
  degraded: 'degraded',
  progressing: 'progressing',
  drift: 'drifted',
  unknown: 'unknown',
}

const HEALTH_HEX: Record<EnvHealth, string> = {
  healthy: 'var(--color-emerald-500)',
  degraded: 'var(--color-rose-500)',
  progressing: 'var(--color-indigo-500)',
  drift: 'var(--color-amber-500)',
  unknown: 'var(--color-slate-400)',
}

type HealthFilter = 'all' | EnvHealth

export function Environments() {
  const clusters = useArgoClusters()
  const apps = useApplications()
  const stages = useStages()
  const nodes = useLocalNodes()
  const namespaces = useLocalNamespaces()

  const model = useEnvironmentModel(clusters.data, apps.data, nodes.data)

  const [search, setSearch] = useState('')
  const [healthF, setHealthF] = useState<HealthFilter>('all')
  const [clusterF, setClusterF] = useState('all')
  const [open, setOpen] = useState<{ cluster: ClusterRow; env: EnvironmentRow } | null>(null)

  const stats = useMemo(() => {
    const envs = model.flatMap((c) => c.environments)
    return {
      clusters: model.length,
      connected: model.filter((c) => c.connected).length,
      environments: envs.length,
      apps: envs.reduce((n, e) => n + e.apps.length, 0),
      degraded: envs.filter((e) => e.health === 'degraded').length,
      drift: envs.filter((e) => e.health === 'drift').length,
      nodes: model.reduce((n, c) => n + (c.fleet?.nodes ?? 0), 0),
    }
  }, [model])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return model
      .filter((c) => clusterF === 'all' || c.key === clusterF)
      .map((c) => ({
        ...c,
        environments: c.environments.filter((e) => {
          if (healthF !== 'all' && e.health !== healthF) return false
          if (!q) return true
          return (
            e.namespace.toLowerCase().includes(q) ||
            c.name.toLowerCase().includes(q) ||
            e.apps.some((a) => a.metadata.name.toLowerCase().includes(q))
          )
        }),
      }))
      // A cluster with no matching environments is dropped only while a filter
      // is narrowing the view — otherwise an idle cluster is worth seeing.
      .filter((c) => c.environments.length > 0 || (!q && healthF === 'all'))
  }, [model, search, healthF, clusterF])

  if (clusters.isLoading && !clusters.data) {
    return (
      <div className='flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm'>
        <Spinner size={14} /> Loading clusters…
      </div>
    )
  }

  if (clusters.isError) {
    return (
      <EmptyState
        title="Couldn't reach Argo CD"
        description={
          <>
            The cluster registry comes from Argo CD, so nothing can be listed until it responds.
            <div className='mt-2 font-mono text-[11px] text-content-subtle'>
              {(clusters.error as Error)?.message}
            </div>
          </>
        }
        action={
          <button
            type='button'
            onClick={() => void clusters.refetch()}
            className='rounded-lg border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content hover:border-brand-400'
          >
            Retry
          </button>
        }
      />
    )
  }

  const filtering = search.trim() !== '' || healthF !== 'all' || clusterF !== 'all'

  return (
    <div className='space-y-4'>
      {/* Roll-up across every registered cluster. */}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6'>
        <Stat label='Clusters' value={stats.clusters} hint={`${stats.connected} reachable`} />
        <Stat label='Environments' value={stats.environments} hint='cluster + namespace' />
        <Stat label='Applications' value={stats.apps} hint='deployed by Argo CD' />
        <Stat label='Nodes' value={stats.nodes || '—'} hint='where readable' />
        <Stat
          label='Degraded'
          value={stats.degraded}
          tone={stats.degraded ? 'rose' : 'slate'}
          hint='unhealthy apps'
          onClick={() => setHealthF((h) => (h === 'degraded' ? 'all' : 'degraded'))}
          active={healthF === 'degraded'}
        />
        <Stat
          label='Drifted'
          value={stats.drift}
          tone={stats.drift ? 'amber' : 'slate'}
          hint='out of sync with git'
          onClick={() => setHealthF((h) => (h === 'drift' ? 'all' : 'drift'))}
          active={healthF === 'drift'}
        />
      </div>

      {/* Controls */}
      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative min-w-[200px] flex-1'>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search environments, clusters or applications…'
            className='h-9 w-full rounded-lg border border-edge-default bg-surface-raised pl-8 pr-3 text-sm text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none'
          />
          <span className='pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle'>
            <IconSearch />
          </span>
        </div>
        <Picker
          value={clusterF}
          onChange={setClusterF}
          options={[
            { value: 'all', label: 'All clusters' },
            ...model.map((c) => ({ value: c.key, label: c.name })),
          ]}
        />
        <Picker
          value={healthF}
          onChange={(v) => setHealthF(v as HealthFilter)}
          options={[
            { value: 'all', label: 'Any health' },
            { value: 'healthy', label: 'Healthy' },
            { value: 'degraded', label: 'Degraded' },
            { value: 'progressing', label: 'Progressing' },
            { value: 'drift', label: 'Drifted' },
          ]}
        />
        {filtering ? (
          <button
            type='button'
            onClick={() => {
              setSearch('')
              setHealthF('all')
              setClusterF('all')
            }}
            className='h-9 rounded-lg border border-edge-default bg-surface-raised px-3 text-xs font-medium text-content-muted hover:text-content'
          >
            Clear
          </button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title='Nothing matches'
          description='No environment matches the current search and filters.'
        />
      ) : (
        visible.map((c) => (
          <ClusterPanel
            key={c.key}
            cluster={c}
            stages={stages.data}
            namespaceCount={c.local ? namespaces.data?.length : undefined}
            onOpen={(env) => setOpen({ cluster: c, env })}
          />
        ))
      )}

      {open ? (
        <EnvDrawer
          cluster={open.cluster}
          env={open.env}
          stage={matchStage(open.env.namespace, stages.data)}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  )
}

/* ─────────── cluster ─────────── */

function ClusterPanel({
  cluster,
  stages,
  namespaceCount,
  onOpen,
}: {
  cluster: ClusterRow
  stages: Array<{ name: string; phase: string; lastPromoted?: string }> | undefined
  namespaceCount?: number
  onOpen: (env: EnvironmentRow) => void
}) {
  const fleet = cluster.fleet
  return (
    <section className='overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm'>
      {/* Header — identity and where it physically runs. */}
      <div className='relative border-b border-edge-subtle px-4 py-3'>
        <div
          aria-hidden
          className='absolute inset-x-0 top-0 h-px'
          style={{
            background: `linear-gradient(90deg, transparent, ${
              cluster.connected ? 'var(--color-emerald-500)' : 'var(--color-rose-500)'
            }, transparent)`,
            opacity: 0.4,
          }}
        />
        <div className='flex flex-wrap items-start gap-3'>
          <ProviderMark id={cluster.provider.id} />
          <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <h3 className='truncate text-[15px] font-semibold tracking-tight text-content'>
                {cluster.name}
              </h3>
              {cluster.local ? (
                <span className='rounded-md bg-brand-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-700 dark:text-brand-300'>
                  this cluster
                </span>
              ) : null}
              <StatusBadge kind={cluster.connected ? 'healthy' : 'degraded'}>
                {cluster.connected ? 'reachable' : cluster.connectionStatus.toLowerCase()}
              </StatusBadge>
              {cluster.idle ? (
                <span className='rounded-md border border-edge-subtle px-1.5 py-0.5 text-[10px] font-medium text-content-subtle'>
                  no applications
                </span>
              ) : null}
            </div>
            <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-content-muted'>
              <span className='font-mono'>
                {cluster.local ? 'in-cluster' : endpointOf(cluster.server)}
              </span>
              {cluster.version ? <Dotsep>Kubernetes {cluster.version}</Dotsep> : null}
              <Dotsep>{cluster.provider.label}</Dotsep>
              {fleet?.region ? <Dotsep>{fleet.region}</Dotsep> : null}
            </div>
            {!cluster.connected && cluster.connectionMessage ? (
              <p className='mt-1.5 rounded-md bg-rose-500/10 px-2 py-1 font-mono text-[11px] text-rose-700 dark:text-rose-300'>
                {cluster.connectionMessage}
              </p>
            ) : null}
          </div>
        </div>

        {/* Infrastructure facts. Live node data where we have it, Argo CD's
            cache statistics where we don't — labelled either way. */}
        <div className='mt-3 flex flex-wrap gap-x-5 gap-y-2'>
          {fleet ? (
            <>
              <Fact label='Nodes' value={`${fleet.ready}/${fleet.nodes} ready`} />
              <Fact label='CPU' value={`${fleet.cpu} vCPU`} />
              <Fact label='Memory' value={formatBytes(fleet.memory)} />
              <Fact label='Pod capacity' value={fleet.pods.toLocaleString()} />
              {fleet.instanceTypes.length ? (
                <Fact label='Instance' value={fleet.instanceTypes.join(', ')} />
              ) : null}
              {namespaceCount ? <Fact label='Namespaces' value={namespaceCount} /> : null}
            </>
          ) : (
            <>
              <Fact label='Applications' value={cluster.appsCount} />
              {cluster.resourcesCount != null ? (
                <Fact label='Resources' value={cluster.resourcesCount.toLocaleString()} src='Argo CD cache' />
              ) : null}
              {cluster.apisCount != null ? (
                <Fact label='APIs' value={cluster.apisCount} src='Argo CD cache' />
              ) : null}
              {cluster.lastCacheSync ? (
                <Fact label='Cache synced' value={`${age(cluster.lastCacheSync)} ago`} src='Argo CD' />
              ) : null}
            </>
          )}
        </div>
        {fleet ? null : (
          <p className='mt-2 text-[11px] text-content-subtle'>
            Node-level detail needs direct API access to this cluster, which the console does not
            have. Everything above is what Argo CD reports.
          </p>
        )}
      </div>

      {/* Environments inside the cluster. */}
      <div className='p-4'>
        {cluster.environments.length === 0 ? (
          <EmptyState
            compact
            title='No applications target this cluster'
            description='It is registered in Argo CD, but nothing deploys to it yet.'
          />
        ) : (
          <div className='grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3'>
            {cluster.environments.map((env) => (
              <EnvCard
                key={env.key}
                env={env}
                stage={matchStage(env.namespace, stages)}
                onOpen={() => onOpen(env)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/* ─────────── environment ─────────── */

function EnvCard({
  env,
  stage,
  onOpen,
}: {
  env: EnvironmentRow
  stage?: { name: string; phase: string; lastPromoted?: string }
  onOpen: () => void
}) {
  const total = env.apps.length
  const healthyPct = total ? Math.round((env.healthy / total) * 100) : 0
  const syncedPct = total ? Math.round((env.synced / total) * 100) : 0

  return (
    <button
      type='button'
      onClick={onOpen}
      className='group relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-md'
    >
      {/* Health rail — the one colour that carries real meaning on this card. */}
      <span
        aria-hidden
        className='absolute inset-y-0 left-0 w-1'
        style={{ background: HEALTH_HEX[env.health] }}
      />

      <div className='flex items-start justify-between gap-2 pl-2'>
        <div className='min-w-0'>
          <div className='truncate text-sm font-semibold tracking-tight text-content'>
            {env.namespace}
          </div>
          <div className='mt-0.5 text-[11px] text-content-subtle'>
            {total} application{total === 1 ? '' : 's'}
            {env.lastSyncAt ? ` · deployed ${age(env.lastSyncAt)} ago` : ''}
          </div>
        </div>
        <StatusBadge kind={HEALTH_KIND[env.health]}>{HEALTH_LABEL[env.health]}</StatusBadge>
      </div>

      {/* Two honest bars: runtime health and git drift, kept separate. */}
      <div className='mt-3 space-y-2 pl-2'>
        <Meter label='Healthy' pct={healthyPct} count={`${env.healthy}/${total}`} tone='emerald' />
        <Meter label='Synced' pct={syncedPct} count={`${env.synced}/${total}`} tone='sky' />
      </div>

      <div className='mt-2.5 flex flex-wrap items-center gap-1.5 pl-2'>
        {env.degraded ? <Chip tone='rose'>{env.degraded} degraded</Chip> : null}
        {env.missing ? <Chip tone='rose'>{env.missing} missing</Chip> : null}
        {env.progressing ? <Chip tone='indigo'>{env.progressing} progressing</Chip> : null}
        {env.outOfSync ? <Chip tone='amber'>{env.outOfSync} out of sync</Chip> : null}
        {env.suspended ? <Chip tone='slate'>{env.suspended} suspended</Chip> : null}
        {stage ? <Chip tone='violet'>Kargo · {stage.name}</Chip> : null}
      </div>
    </button>
  )
}

/* ─────────── drawer: what is actually running ─────────── */

function EnvDrawer({
  cluster,
  env,
  stage,
  onClose,
}: {
  cluster: ClusterRow
  env: EnvironmentRow
  stage?: { name: string; phase: string; lastPromoted?: string }
  onClose: () => void
}) {
  // Workloads are only readable on a cluster the gateway can reach.
  const live = cluster.local
  const deployments = useNamespaceDeployments(env.namespace, live)
  const pods = useNamespacePods(env.namespace, live)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  const podStats = useMemo(() => {
    const list = pods.data ?? []
    let running = 0
    let pending = 0
    let failed = 0
    let restarts = 0
    for (const p of list) {
      const phase = p.status?.phase
      if (phase === 'Running' || phase === 'Succeeded') running++
      else if (phase === 'Pending') pending++
      else failed++
      for (const cs of p.status?.containerStatuses ?? []) restarts += cs.restartCount ?? 0
    }
    return { total: list.length, running, pending, failed, restarts }
  }, [pods.data])

  const body = (
    <div className='fixed inset-0 z-50 flex justify-end'>
      <div className='absolute inset-0 bg-scrim/40 backdrop-blur-[2px]' onClick={onClose} />
      {/* `bg-surface-app`, not `surface-base` — the latter is not a token, so
          Tailwind emitted no rule and the panel rendered transparent over the
          page behind it. */}
      <aside className='relative flex h-full w-full max-w-2xl flex-col border-l border-edge-default bg-surface-app shadow-2xl'>
        <header className='flex items-start gap-3 border-b border-edge-subtle px-5 py-4'>
          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-2 text-[11px] text-content-subtle'>
              <ProviderMark id={cluster.provider.id} size={16} />
              <span className='truncate'>{cluster.name}</span>
              <span>·</span>
              <span className='font-mono'>{cluster.local ? 'in-cluster' : endpointOf(cluster.server)}</span>
            </div>
            <h2 className='mt-1 truncate text-lg font-semibold tracking-tight text-content'>
              {env.namespace}
            </h2>
          </div>
          <StatusBadge kind={HEALTH_KIND[env.health]}>{HEALTH_LABEL[env.health]}</StatusBadge>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rounded-md p-1 text-content-muted hover:bg-surface-sunken hover:text-content'
          >
            <IconClose />
          </button>
        </header>

        <div className='flex-1 space-y-5 overflow-y-auto px-5 py-4'>
          {/* Applications — always available, from Argo CD. */}
          <Section title='Applications' count={env.apps.length}>
            <ul className='divide-y divide-edge-subtle rounded-xl border border-edge-subtle'>
              {env.apps.map((a) => (
                <AppRow key={a.metadata.name} app={a} />
              ))}
            </ul>
          </Section>

          {/* Workloads — live, and only where we can genuinely read them. */}
          <Section title='Running workloads'>
            {!live ? (
              <p className='rounded-xl border border-edge-subtle bg-surface-sunken/40 px-3 py-3 text-[12px] text-content-muted'>
                The console has no direct API access to <strong>{cluster.name}</strong>, so pod and
                deployment detail cannot be read. Argo CD's per-application resource tree is still
                available from the Applications page.
              </p>
            ) : deployments.isLoading || pods.isLoading ? (
              <div className='flex items-center gap-2 px-1 py-3 text-[12px] text-content-muted'>
                <Spinner size={12} /> Reading workloads…
              </div>
            ) : deployments.isError || pods.isError ? (
              <p className='rounded-xl border border-edge-subtle px-3 py-3 font-mono text-[11px] text-rose-600 dark:text-rose-300'>
                {((deployments.error ?? pods.error) as Error)?.message}
              </p>
            ) : (
              <>
                <div className='mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4'>
                  <Tile label='Pods' value={podStats.total} />
                  <Tile label='Running' value={podStats.running} tone='emerald' />
                  <Tile
                    label='Not running'
                    value={podStats.pending + podStats.failed}
                    tone={podStats.failed ? 'rose' : 'slate'}
                  />
                  <Tile
                    label='Restarts'
                    value={podStats.restarts}
                    tone={podStats.restarts > 0 ? 'amber' : 'slate'}
                  />
                </div>
                {deployments.data?.length ? (
                  <ul className='divide-y divide-edge-subtle rounded-xl border border-edge-subtle'>
                    {deployments.data.map((d) => {
                      const ready = d.status?.readyReplicas ?? 0
                      const want = d.spec?.replicas ?? 0
                      const ok = want > 0 && ready >= want
                      return (
                        <li
                          key={d.metadata.name}
                          className='flex items-center gap-2 px-3 py-2 text-[12.5px]'
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              ok ? 'bg-emerald-500' : want === 0 ? 'bg-slate-400' : 'bg-rose-500',
                            )}
                          />
                          <span className='truncate font-medium text-content'>
                            {d.metadata.name}
                          </span>
                          <span className='ml-auto shrink-0 font-mono text-[11px] text-content-muted'>
                            {ready}/{want}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <EmptyState compact title='No deployments in this namespace' />
                )}
              </>
            )}
          </Section>

          {stage ? (
            <Section title='Promotion'>
              <div className='rounded-xl border border-edge-subtle px-3 py-2.5 text-[12px]'>
                <div className='flex items-center gap-2'>
                  <span className='font-medium text-content'>Kargo stage</span>
                  <span className='font-mono text-content-muted'>{stage.name}</span>
                  <span className='ml-auto'>
                    <StatusBadge
                      kind={
                        stage.phase === 'Steady'
                          ? 'healthy'
                          : stage.phase === 'Promoting' || stage.phase === 'Verifying'
                            ? 'progressing'
                            : stage.phase === 'Failed'
                              ? 'failed'
                              : 'unknown'
                      }
                    >
                      {stage.phase}
                    </StatusBadge>
                  </span>
                </div>
                {stage.lastPromoted ? (
                  <div className='mt-1 text-content-muted'>
                    last promoted {age(stage.lastPromoted)} ago
                  </div>
                ) : null}
              </div>
            </Section>
          ) : null}

          <Section title='Cluster'>
            <Card>
              <CardBody className='space-y-1.5 text-[12px]'>
                <Row label='Endpoint'>
                  <span className='font-mono'>{endpointOf(cluster.server) || '—'}</span>
                </Row>
                <Row label='Kubernetes'>{cluster.version ?? '—'}</Row>
                <Row label='Infrastructure'>
                  {cluster.provider.label}
                  <span className='ml-1.5 text-content-subtle'>
                    ({cluster.provider.source === 'unknown'
                      ? 'not determined'
                      : `from ${cluster.provider.source}`})
                  </span>
                </Row>
                {cluster.fleet?.region ? <Row label='Region'>{cluster.fleet.region}</Row> : null}
                {cluster.fleet?.os.length ? <Row label='OS'>{cluster.fleet.os.join(', ')}</Row> : null}
                <Row label='Argo CD connection'>
                  {cluster.connectionStatus}
                  {cluster.attemptedAt ? (
                    <span className='ml-1.5 text-content-subtle'>
                      checked {age(cluster.attemptedAt)} ago
                    </span>
                  ) : null}
                </Row>
              </CardBody>
            </Card>
          </Section>
        </div>
      </aside>
    </div>
  )

  return createPortal(body, document.body)
}

function AppRow({ app }: { app: argocd.Application }) {
  const sync = app.status?.sync?.status ?? 'Unknown'
  const health = app.status?.health?.status ?? 'Unknown'
  return (
    <li className='flex items-center gap-2 px-3 py-2 text-[12.5px]'>
      <span className='truncate font-medium text-content'>{app.metadata.name}</span>
      <span className='ml-auto flex shrink-0 items-center gap-2'>
        <span className='inline-flex items-center gap-1 text-[11px] text-content-muted'>
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              sync === 'Synced' ? 'bg-emerald-500' : 'bg-amber-500',
            )}
          />
          {sync}
        </span>
        <span className='inline-flex items-center gap-1 text-[11px] text-content-muted'>
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              health === 'Healthy'
                ? 'bg-emerald-500'
                : health === 'Progressing'
                  ? 'bg-indigo-500'
                  : health === 'Suspended'
                    ? 'bg-slate-400'
                    : 'bg-rose-500',
            )}
          />
          {health}
        </span>
      </span>
    </li>
  )
}

/* ─────────── small parts ─────────── */

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <section>
      <div className='mb-1.5 flex items-center gap-2'>
        <h3 className='text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle'>
          {title}
        </h3>
        {count != null ? (
          <span className='rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-content-muted'>
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
  tone = 'slate',
  onClick,
  active = false,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: 'slate' | 'rose' | 'amber'
  onClick?: () => void
  active?: boolean
}) {
  const toneCls = {
    slate: 'text-content',
    rose: 'text-rose-600 dark:text-rose-400',
    amber: 'text-amber-600 dark:text-amber-400',
  }[tone]
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'rounded-xl border bg-surface-raised px-3 py-2 text-left shadow-sm transition-colors',
        active ? 'border-brand-400 ring-1 ring-brand-400/40' : 'border-edge-default',
        onClick ? 'hover:border-edge-strong' : '',
      )}
    >
      <div className={cn('text-lg font-semibold tabular-nums leading-tight', toneCls)}>{value}</div>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
        {label}
      </div>
      {hint ? <div className='mt-0.5 truncate text-[10px] text-content-subtle'>{hint}</div> : null}
    </Tag>
  )
}

function Fact({ label, value, src }: { label: string; value: string | number; src?: string }) {
  return (
    <div>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
        {label}
      </div>
      <div className='text-[12.5px] font-medium tabular-nums text-content'>{value}</div>
      {src ? <div className='text-[10px] text-content-subtle'>{src}</div> : null}
    </div>
  )
}

function Meter({
  label,
  pct,
  count,
  tone,
}: {
  label: string
  pct: number
  count: string
  tone: 'emerald' | 'sky'
}) {
  const bar = tone === 'emerald' ? 'bg-emerald-500' : 'bg-sky-500'
  return (
    <div>
      <div className='flex items-center justify-between text-[10.5px] text-content-muted'>
        <span>{label}</span>
        <span className='font-mono tabular-nums'>{count}</span>
      </div>
      <div className='mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken'>
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', bar)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function Chip({
  tone,
  children,
}: {
  tone: 'rose' | 'amber' | 'indigo' | 'slate' | 'violet'
  children: React.ReactNode
}) {
  const cls = {
    rose: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
    amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    indigo: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
    slate: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
    violet: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  }[tone]
  return (
    <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-medium', cls)}>{children}</span>
  )
}

function Tile({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: number
  tone?: 'slate' | 'emerald' | 'rose' | 'amber'
}) {
  const cls = {
    slate: 'text-content',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    rose: 'text-rose-600 dark:text-rose-400',
    amber: 'text-amber-600 dark:text-amber-400',
  }[tone]
  return (
    <div className='rounded-lg border border-edge-subtle px-2.5 py-1.5'>
      <div className={cn('text-base font-semibold tabular-nums leading-tight', cls)}>{value}</div>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
        {label}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex gap-3'>
      <span className='w-40 shrink-0 text-content-subtle'>{label}</span>
      <span className='min-w-0 flex-1 text-content'>{children}</span>
    </div>
  )
}

function Dotsep({ children }: { children: React.ReactNode }) {
  return (
    <span className='flex items-center gap-3 before:h-0.5 before:w-0.5 before:rounded-full before:bg-content-subtle'>
      {children}
    </span>
  )
}

function Picker({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className='h-9 rounded-lg border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content focus:border-brand-400 focus:outline-none'
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/* ─────────── provider marks ─────────── */

const PROVIDER_TONE: Record<ProviderId, string> = {
  digitalocean: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
  aws: 'bg-amber-500/12 text-amber-600 dark:text-amber-400',
  gcp: 'bg-blue-500/12 text-blue-600 dark:text-blue-400',
  azure: 'bg-cyan-500/12 text-cyan-600 dark:text-cyan-400',
  linode: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  oracle: 'bg-rose-500/12 text-rose-600 dark:text-rose-400',
  ibm: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400',
  openstack: 'bg-red-500/12 text-red-600 dark:text-red-400',
  vsphere: 'bg-slate-500/12 text-slate-600 dark:text-slate-300',
  kind: 'bg-violet-500/12 text-violet-600 dark:text-violet-400',
  k3s: 'bg-yellow-500/12 text-yellow-700 dark:text-yellow-400',
  'self-managed': 'bg-slate-500/12 text-slate-600 dark:text-slate-300',
}

/**
 * A cluster's badge. Cloud providers get a cloud glyph, anything we could not
 * positively identify gets a server glyph — which is also the honest picture of
 * an on-prem or self-managed cluster.
 */
function ProviderMark({ id, size = 34 }: { id: ProviderId; size?: number }) {
  const cloud = !['self-managed', 'vsphere', 'kind', 'k3s'].includes(id)
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-xl', PROVIDER_TONE[id])}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {cloud ? <IconCloud size={Math.round(size * 0.52)} /> : <IconServer size={Math.round(size * 0.52)} />}
    </span>
  )
}

/* ─────────── icons ─────────── */

function IconCloud({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      <path d='M17.5 19a4.5 4.5 0 0 0 .3-9 6.5 6.5 0 0 0-12.6 1.6A4 4 0 0 0 6 19Z' />
    </svg>
  )
}

function IconServer({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      <rect x='3' y='4' width='18' height='6' rx='1.5' />
      <rect x='3' y='14' width='18' height='6' rx='1.5' />
      <path d='M7 7h.01M7 17h.01' />
    </svg>
  )
}

function IconSearch() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      aria-hidden
    >
      <circle cx='11' cy='11' r='7' />
      <path d='m20 20-3.5-3.5' />
    </svg>
  )
}

function IconClose() {
  return (
    <svg
      width='16'
      height='16'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      aria-hidden
    >
      <path d='M18 6 6 18M6 6l12 12' />
    </svg>
  )
}

export default Environments
