import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Input, LogConsole, Select, Spinner, StatusBadge, type StatusKind, useLogStream, usePublicUrl, useToast, useToolPublicUrl } from '@adhar/shell-ui'
import type { argocd } from '@adhar/api-clients'
import { cn } from '@adhar/utils'
import { CodeViewer, IconBtn, Segmented, ToggleChip } from '~/components/code-viewer.tsx'
import {
  ConditionsTable,
  FieldList,
  GraphView,
  HealthMark,
  KindIcon,
  LEVEL_DOT,
  LEVEL_KIND,
  NodeSidePanel,
  RelatedList,
  StatusCallout,
  SyncMark,
} from '~/components/resource-graph.tsx'
import type { Entity } from '~/data/catalog.ts'
import { type EntityDeployment, kargoEnvironments, useKargoStages } from '~/data/catalog-deployment.ts'
import { useDiscovery, useLiveObject, useObjectEvents } from '~/data/catalog-composition.ts'
import { age, apiVersionOf, argoHealthLevel, type CompNode, type CompositionGraph, kindsOf } from '~/data/catalog-composition-model.ts'
import { RESOURCES_REFRESH_MS, useAppResources, useManagedResources } from '~/data/catalog-resources.ts'
import {
  comparable,
  diffChunks,
  envTabs,
  fmtCpu,
  fmtMem,
  groupPods,
  hostnamesOf,
  imagesOf,
  imageTag,
  lineDiff,
  networkGraph,
  podInfo,
  type PodRow,
  podRows,
  type ResourceFilter,
  resourceVisible,
  workloadReplicas,
} from '~/data/catalog-resources-model.ts'
import { toYaml } from '~/data/k8s-yaml.ts'
import { EventsList } from './_catalog-composition.tsx'

/**
 * The Resources tab: an entity's Argo CD applications, the way Argo CD's
 * application details view shows them — per environment, read-only.
 *
 *   • Environment switcher: every app matched to the entity, in promotion
 *     order (Kargo's stage chain when known), plus an all-environments
 *     overview of health and sync.
 *   • Per app: a header (sync + revision, health, last sync, policy, source,
 *     destination) and four views — Tree (Argo's resource tree), Network
 *     (route → Service → Pods), Pods (by node or owner, with usage) and List.
 *   • A node opens a side panel: summary and conditions, events, the live
 *     manifest, desired-vs-live diff for out-of-sync resources, and for Pods
 *     their containers and logs.
 *
 * Sync, rollback and delete stay in Argo CD (each node and app links there).
 */

type ArgoApp = argocd.Application

const ALL = 'all'

function argoKind(status?: string): StatusKind {
  return LEVEL_KIND[argoHealthLevel(status)]
}

function syncKind(status?: string): StatusKind {
  return status === 'Synced' ? 'healthy' : status === 'OutOfSync' ? 'paused' : 'unknown'
}

const isSha = (s?: string) => Boolean(s && /^[0-9a-f]{7,40}$/i.test(s))

function commitUrl(repoUrl: string | undefined, rev: string | undefined): string | undefined {
  if (!repoUrl || !rev || !isSha(rev) || !/^https?:/.test(repoUrl)) return undefined
  return `${repoUrl.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${rev}`
}

export function ResourcesTab({ entity, deployment, overview = true }: {
  entity: Entity
  deployment: EntityDeployment
  /**
   * Show the "All environments" summary cards. Off where the page already
   * summarises the environments (the Deployment tab's Environments section) —
   * the view then opens on the first environment's resources.
   */
  overview?: boolean
}) {
  const stages = useKargoStages(deployment.apps.length > 0)
  const kargoOrder = useMemo(
    () => kargoEnvironments(stages.data, deployment, entity.metadata.name).map((k) => k.stage.name),
    [stages.data, deployment, entity.metadata.name],
  )
  const tabs = useMemo(() => envTabs(deployment.environments, deployment.unscoped, kargoOrder), [deployment.environments, deployment.unscoped, kargoOrder])
  const [envId, setEnvId] = useState<string>(ALL)
  const current = tabs.find((t) => t.id === envId)
  const active = tabs.length === 1 ? tabs[0] : current ?? (overview ? undefined : tabs[0])

  if (deployment.isLoading) {
    return <div className="flex items-center gap-2 py-10 text-sm text-content-muted"><Spinner /> Finding the Argo CD applications for this entity…</div>
  }
  if (!tabs.length) {
    return (
      <EmptyState
        compact
        title={deployment.isError ? 'Argo CD could not be reached' : 'No Argo CD application deploys this entity'}
        description={deployment.isError
          ? 'The application list did not load, so there are no resources to show.'
          : 'Applications are matched by name (<name>, <name>-<env>), the adhar.io/application label, or the adhar.io/argocd-app annotation.'}
      />
    )
  }

  return (
    <div className="space-y-4">
      {tabs.length > 1 ? (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Environment">
          {overview ? <EnvChip selected={!active} onClick={() => setEnvId(ALL)} label="All environments" /> : null}
          {tabs.map((t) => (
            <EnvChip key={t.id} selected={active?.id === t.id} onClick={() => setEnvId(t.id)} label={t.label} health={t.app.status.health.status} sync={t.app.status.sync.status} />
          ))}
        </div>
      ) : null}
      {active ? <AppView key={active.id} app={active.app} label={active.label} /> : <AllEnvironments tabs={tabs} onPick={setEnvId} />}
    </div>
  )
}

function EnvChip({ selected, onClick, label, health, sync }: { selected: boolean; onClick(): void; label: string; health?: string; sync?: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
        selected ? 'bg-brand-50 text-brand-700 ring-brand-300 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-400/40' : 'text-content-muted ring-edge-default hover:bg-surface-sunken hover:text-content',
      )}
    >
      {health ? <span className={cn('h-2 w-2 rounded-full', LEVEL_DOT[argoHealthLevel(health)])} aria-hidden /> : null}
      {label}
      {sync === 'OutOfSync' ? <span className="text-amber-600 dark:text-amber-300" title="Out of sync">↻</span> : null}
    </button>
  )
}

/* ───────────────────────── all environments ───────────────────────── */

function AllEnvironments({ tabs, onPick }: { tabs: Array<{ id: string; label: string; app: ArgoApp }>; onPick(id: string): void }) {
  const now = Date.now()
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {tabs.map((t) => {
        const a = t.app
        const op = a.status.operationState
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className="rounded-lg border border-edge-default bg-surface-raised p-3 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-content">{t.label}</span>
              <span className="truncate font-mono text-[11px] text-content-subtle">{a.metadata.name}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <StatusBadge kind={argoKind(a.status.health.status)}>{a.status.health.status}</StatusBadge>
              <StatusBadge kind={syncKind(a.status.sync.status)} dot={false}>{a.status.sync.status}</StatusBadge>
            </div>
            <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-y-0.5 text-[11px]">
              <dt className="text-content-subtle">Revision</dt>
              <dd className="truncate font-mono text-content">{a.status.sync.revision?.slice(0, 8) ?? '—'}</dd>
              <dt className="text-content-subtle">Last sync</dt>
              <dd className="truncate text-content">{op ? `${op.phase}${op.finishedAt ? ` · ${age(op.finishedAt, now)} ago` : ''}` : '—'}</dd>
              <dt className="text-content-subtle">Resources</dt>
              <dd className="text-content">
                {a.status.resources.total}
                {a.status.resources.outOfSync ? <span className="text-amber-700 dark:text-amber-300"> · {a.status.resources.outOfSync} out of sync</span> : null}
                {a.status.resources.unhealthy ? <span className="text-rose-700 dark:text-rose-300"> · {a.status.resources.unhealthy} unhealthy</span> : null}
              </dd>
              <dt className="text-content-subtle">Namespace</dt>
              <dd className="truncate font-mono text-content">{a.spec.destination.namespace || '—'}</dd>
            </dl>
          </button>
        )
      })}
    </div>
  )
}

/* ───────────────────────── one application ───────────────────────── */

type View = 'tree' | 'network' | 'pods' | 'list'

const NO_COLLAPSE: ReadonlySet<string> = new Set()

function AppView({ app, label }: { app: ArgoApp; label: string }) {
  const ref = useMemo(() => ({ name: app.metadata.name, namespace: app.metadata.namespace }), [app.metadata.name, app.metadata.namespace])
  const [paused, setPaused] = useState(false)
  const data = useAppResources(ref, { paused })
  const [view, setView] = useState<View>(() =>
    typeof globalThis.matchMedia === 'function' && !globalThis.matchMedia('(min-width: 640px)').matches ? 'list' : 'tree'
  )
  const [filter, setFilter] = useState<ResourceFilter>({ search: '', kind: '', health: '', sync: '', showOld: false })
  const [groupBy, setGroupBy] = useState<'node' | 'owner'>('owner')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const toast = useToast()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [])

  const graph = data.data?.graph
  const visible = useMemo(() => (graph ? resourceVisible(graph, filter) : undefined), [graph, filter])
  const net = useMemo(() => (graph ? networkGraph(graph) : undefined), [graph])
  const kinds = useMemo(() => (graph ? kindsOf(graph).filter((k) => k !== 'Application') : []), [graph])
  const filtering = Boolean(filter.search || filter.kind || filter.health || filter.sync)
  const set = (patch: Partial<ResourceFilter>) => setFilter((f) => ({ ...f, ...patch }))
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-3">
      <AppHeader app={app} label={label} />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<View>
          value={view}
          onChange={setView}
          ariaLabel="View"
          options={[
            { value: 'tree', label: 'Tree' },
            { value: 'network', label: 'Network' },
            { value: 'pods', label: 'Pods' },
            { value: 'list', label: 'List' },
          ]}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => setPaused((p) => !p)} aria-pressed={!paused} title={paused ? 'Resume auto-refresh' : `Auto-refreshing every ${RESOURCES_REFRESH_MS / 1000}s — pause`}>
            <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', paused ? 'bg-slate-400' : 'bg-emerald-500')} aria-hidden />
            {paused ? 'Paused' : 'Live'}
          </Button>
          <IconBtn
            label="Refresh now"
            onClick={() => {
              data.refetch().then((r) => {
                if (r.error) toast.error('Refresh failed', { description: r.error instanceof Error ? r.error.message : String(r.error) })
              })
            }}
          >
            <path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 1 0 22 12h-2a8 8 0 1 1-8-8z" />
          </IconBtn>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input value={filter.search} onChange={(e) => set({ search: e.target.value })} placeholder="Filter by name, kind, status…" aria-label="Filter resources" className="h-8 min-w-40 flex-1 basis-40 py-0 text-sm" />
        <Select value={filter.kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Kind" className="h-8 py-0 text-sm" wrapperClassName="min-w-0" options={[{ value: '', label: 'All kinds' }, ...kinds.map((k) => ({ value: k, label: k }))]} />
        <Select
          value={filter.health}
          onChange={(e) => set({ health: e.target.value as ResourceFilter['health'] })}
          aria-label="Health"
          className="h-8 py-0 text-sm"
          wrapperClassName="min-w-0"
          options={[
            { value: '', label: 'Any health' },
            { value: 'healthy', label: 'Healthy' },
            { value: 'progressing', label: 'Progressing' },
            { value: 'degraded', label: 'Degraded' },
            { value: 'suspended', label: 'Suspended' },
            { value: 'missing', label: 'Missing' },
            { value: 'unknown', label: 'Unknown' },
          ]}
        />
        <Select
          value={filter.sync}
          onChange={(e) => set({ sync: e.target.value as ResourceFilter['sync'] })}
          aria-label="Sync"
          className="h-8 py-0 text-sm"
          wrapperClassName="min-w-0"
          options={[{ value: '', label: 'Any sync' }, { value: 'Synced', label: 'Synced' }, { value: 'OutOfSync', label: 'OutOfSync' }]}
        />
        {view === 'tree' || view === 'list' ? (
          <ToggleChip on={Boolean(filter.showOld)} onClick={() => set({ showOld: !filter.showOld })} title="Show ReplicaSets scaled to zero (rollout history)">
            Old ReplicaSets
          </ToggleChip>
        ) : null}
        {view === 'pods' ? (
          <Segmented<'node' | 'owner'> value={groupBy} onChange={setGroupBy} ariaLabel="Group pods by" options={[{ value: 'owner', label: 'By owner' }, { value: 'node', label: 'By node' }]} />
        ) : null}
      </div>

      {data.error && !graph ? (
        <EmptyState
          compact
          title={(data.error as { status?: number }).status === 403 ? 'No permission to read this application' : 'Could not read the application'}
          description={data.error instanceof Error ? data.error.message : String(data.error)}
        />
      ) : !graph ? (
        <div className="h-64 animate-pulse rounded-lg bg-surface-sunken" aria-hidden />
      ) : (
        <>
          {data.data?.treeUnavailable ? (
            <p className="text-xs text-amber-800 dark:text-amber-300">Argo CD's live resource tree is unavailable — showing the application's managed resources only (no Pods or ReplicaSets).</p>
          ) : null}
          {visible && visible.size === 0 ? (
            <EmptyState compact title="No resources match" description="Clear the filters to see everything." action={<Button size="sm" variant="secondary" onClick={() => setFilter({ search: '', kind: '', health: '', sync: '', showOld: filter.showOld })}>Clear filters</Button>} />
          ) : view === 'tree' ? (
            <GraphView ariaLabel="Resource tree" graph={graph} visible={visible} collapsed={filtering ? NO_COLLAPSE : collapsed} onToggle={toggle} selected={selected} onSelect={setSelected} now={now} cardExtra={cardExtra} fitKey={`tree|${JSON.stringify(filter)}`} />
          ) : view === 'network' ? (
            net && net.roots.length ? (
              <GraphView ariaLabel="Network" graph={net} collapsed={NO_COLLAPSE} onToggle={() => {}} selected={selected} onSelect={setSelected} now={now} cardExtra={networkExtra} fitKey={`net|${JSON.stringify(filter)}`} />
            ) : (
              <EmptyState compact title="No network resources" description="This application has no Service, Ingress or route." />
            )
          ) : view === 'pods' ? (
            <PodsView rows={podRows(graph, data.data?.usage).filter((r) => !visible || visible.has(r.node.id))} groupBy={groupBy} onSelect={setSelected} selected={selected} now={now} hasMetrics={Boolean(data.data?.usage)} />
          ) : (
            <ListView graph={graph} visible={visible} onSelect={setSelected} selected={selected} now={now} />
          )}
          <div className="flex justify-end text-[11px] text-content-subtle">
            {data.dataUpdatedAt ? `Updated ${age(new Date(data.dataUpdatedAt).toISOString(), now)} ago` : null}
            {data.error ? ' · last refresh failed' : ''}
          </div>
        </>
      )}

      {selected && graph?.nodes[selected] ? (
        <ResourceDetail graph={graph} node={graph.nodes[selected]} app={app} onClose={() => setSelected(null)} onSelect={setSelected} now={now} />
      ) : null}
    </div>
  )
}

function cardExtra(n: CompNode): ReactNode {
  const r = workloadReplicas(n)
  const imgs = imagesOf(n)
  const pod = n.kind === 'Pod' ? podInfo(n) : undefined
  const parts: string[] = []
  if (r) parts.push(`${r.ready}/${r.desired} ready`)
  if (pod) parts.push(`${pod.ready} ready${pod.restarts ? ` · ${pod.restarts} restarts` : ''}`)
  if (imgs.length && n.kind !== 'Pod') parts.push(imgs.map(imageTag).join(', '))
  return parts.length ? parts.join(' · ') : null
}

function networkExtra(n: CompNode): ReactNode {
  if (n.kind === 'Service') {
    const spec = (n.object?.spec ?? {}) as { type?: string; clusterIP?: string; ports?: Array<{ port?: number }> }
    return [spec.type, spec.ports?.map((p) => p.port).join(',')].filter(Boolean).join(' · ') || null
  }
  if (n.kind === 'Pod') return podInfo(n)?.reason ?? (n.object?.status as { podIP?: string } | undefined)?.podIP ?? null
  const hosts = hostnamesOf(n)
  return hosts.length ? hosts.join(', ') : null
}

/* ───────────────────────── header ───────────────────────── */

function AppHeader({ app, label }: { app: ArgoApp; label: string }) {
  const pub = usePublicUrl()
  const argoBase = useToolPublicUrl('argocd')
  const src = app.spec.source
  const repo = src.repoURL ? pub(src.repoURL) : ''
  const rev = app.status.sync.revision
  const commit = commitUrl(repo, rev)
  const op = app.status.operationState
  const auto = app.spec.syncPolicy.automated
  const argoUrl = argoBase ? `${argoBase.replace(/\/$/, '')}/applications/${app.metadata.namespace}/${app.metadata.name}` : undefined
  const now = Date.now()
  return (
    <div className="space-y-2 rounded-lg border border-edge-default bg-surface-raised px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-content">{label}</span>
        <span className="font-mono text-xs text-content-subtle">{app.metadata.name}</span>
        <StatusBadge kind={argoKind(app.status.health.status)}>{app.status.health.status}</StatusBadge>
        <StatusBadge kind={syncKind(app.status.sync.status)} dot={false}>{app.status.sync.status}</StatusBadge>
        {argoUrl ? (
          <a href={argoUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
            Open in Argo CD ↗
          </a>
        ) : null}
      </div>
      {app.status.health.message ? <p className="text-xs text-content-muted">{app.status.health.message}</p> : null}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <HeaderFact label="Revision">
          {rev ? (commit ? <a href={commit} target="_blank" rel="noreferrer" className="font-mono text-brand-700 hover:underline dark:text-brand-300">{rev.slice(0, 10)}</a> : <span className="font-mono">{rev.slice(0, 10)}</span>) : '—'}
        </HeaderFact>
        <HeaderFact label="Last sync">
          {op ? (
            <span className={cn(op.phase === 'Failed' || op.phase === 'Error' ? 'text-rose-700 dark:text-rose-300' : '')}>
              {op.phase}
              {op.finishedAt ? ` · ${age(op.finishedAt, now)} ago` : op.startedAt ? ` · started ${age(op.startedAt, now)} ago` : ''}
              {op.initiatedBy ? ` · by ${op.initiatedBy}` : ''}
            </span>
          ) : 'never'}
        </HeaderFact>
        <HeaderFact label="Sync policy">
          {auto ? (
            <span className="inline-flex flex-wrap gap-1">
              <Flag on>auto-sync</Flag>
              <Flag on={auto.selfHeal}>self-heal</Flag>
              <Flag on={auto.prune}>prune</Flag>
            </span>
          ) : <Flag on={false}>manual</Flag>}
        </HeaderFact>
        <HeaderFact label="Source">
          <span className="font-mono" title={src.repoURL}>
            {repo ? <a href={repo.replace(/\.git$/, '')} target="_blank" rel="noreferrer" className="hover:underline">{repo.replace(/^https?:\/\//, '').replace(/\.git$/, '')}</a> : '—'}
            {src.path ? ` · ${src.path}` : ''}
            {src.targetRevision ? ` @ ${src.targetRevision}` : ''}
          </span>
        </HeaderFact>
        <HeaderFact label="Destination">
          <span className="font-mono">{app.spec.destination.name ?? app.spec.destination.server} · {app.spec.destination.namespace || '—'}</span>
        </HeaderFact>
        {app.status.conditions.length ? (
          <HeaderFact label="Conditions">
            <span className="text-rose-700 dark:text-rose-300">{app.status.conditions.map((c) => `${c.type}${c.message ? `: ${c.message}` : ''}`).join(' · ')}</span>
          </HeaderFact>
        ) : null}
      </dl>
    </div>
  )
}

function HeaderFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="w-24 shrink-0 text-content-subtle">{label}</dt>
      <dd className="min-w-0 break-all text-content">{children}</dd>
    </div>
  )
}

function Flag({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset', on ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25' : 'text-content-subtle ring-edge-default line-through')}>
      {children}
    </span>
  )
}

/* ───────────────────────── list & pods ───────────────────────── */

function ListView({ graph, visible, onSelect, selected, now }: { graph: CompositionGraph; visible?: Set<string>; onSelect(id: string): void; selected: string | null; now: number }) {
  const rows = useMemo(
    () => Object.values(graph.nodes).filter((n) => n.id !== graph.roots[0] && (!visible || visible.has(n.id))).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    [graph, visible],
  )
  return (
    <div className="overflow-x-auto rounded-lg border border-edge-default">
      <table className="w-full text-left text-xs">
        <thead className="bg-surface-sunken text-[11px] uppercase tracking-wide text-content-subtle">
          <tr>
            <th className="px-3 py-2 font-medium">Resource</th>
            <th className="hidden px-3 py-2 font-medium md:table-cell">Namespace</th>
            <th className="px-3 py-2 font-medium">Sync</th>
            <th className="px-3 py-2 font-medium">Health</th>
            <th className="px-3 py-2 text-right font-medium">Age</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-default bg-surface-raised">
          {rows.map((n) => (
            <tr key={n.id} onClick={() => onSelect(n.id)} className={cn('cursor-pointer hover:bg-surface-sunken/60', selected === n.id && 'bg-brand-50/60 dark:bg-brand-500/10')}>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <KindIcon node={n} className="h-6 w-6 text-[9px]" />
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[12px] text-content">{n.name}</span>
                    <span className="block truncate text-[11px] text-content-subtle">{n.kind}{cardExtra(n) ? ` · ${cardExtra(n)}` : ''}</span>
                  </span>
                </div>
              </td>
              <td className="hidden whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-content-muted md:table-cell">{n.namespace ?? '—'}</td>
              <td className="px-3 py-1.5 text-[11px]"><SyncMark sync={n.status.sync} prune={n.status.prune} />{!n.status.sync && !n.status.prune ? <span className="text-content-subtle">—</span> : null}</td>
              <td className="px-3 py-1.5 text-[11px]"><HealthMark level={n.status.level} label={n.status.health ?? n.status.label} /></td>
              <td className="px-3 py-1.5 text-right text-content-subtle">{age(n.createdAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PodsView({ rows, groupBy, onSelect, selected, now, hasMetrics }: { rows: PodRow[]; groupBy: 'node' | 'owner'; onSelect(id: string): void; selected: string | null; now: number; hasMetrics: boolean }) {
  const groups = useMemo(() => groupPods(rows, groupBy), [rows, groupBy])
  if (!rows.length) return <EmptyState compact title="No pods" description="Nothing in this application is running a Pod right now." />
  return (
    <div className="space-y-4">
      {!hasMetrics ? <p className="text-[11px] text-content-subtle">CPU and memory need metrics-server; it is not answering on this cluster.</p> : null}
      {groups.map((g) => (
        <section key={g.key}>
          <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-content">
            <span className={cn('h-2 w-2 rounded-full', LEVEL_DOT[g.worst])} aria-hidden />
            <span className="font-mono">{g.key}</span>
            <span className="font-normal text-content-subtle">{g.rows.length} pod{g.rows.length === 1 ? '' : 's'}</span>
          </h4>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {g.rows.map((r) => (
              <button
                key={r.node.id}
                type="button"
                onClick={() => onSelect(r.node.id)}
                className={cn(
                  'rounded-lg border bg-surface-raised p-2.5 text-left text-xs shadow-sm hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  selected === r.node.id ? 'border-brand-500' : r.node.status.level === 'degraded' ? 'border-rose-300 dark:border-rose-500/40' : 'border-edge-default',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', LEVEL_DOT[r.node.status.level])} aria-hidden />
                  <span className="truncate font-mono text-[12px] font-medium text-content">{r.node.name}</span>
                  <span className="ml-auto shrink-0 text-content-subtle">{age(r.node.createdAt, now)}</span>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-1 text-[11px]">
                  <Mini label="Phase" value={r.info.reason ?? r.info.phase} tone={r.node.status.level === 'degraded' ? 'bad' : undefined} />
                  <Mini label="Ready" value={r.info.ready} />
                  <Mini label="Restarts" value={String(r.info.restarts)} tone={r.info.restarts > 3 ? 'bad' : undefined} />
                  <Mini label={groupBy === 'node' ? 'Owner' : 'Node'} value={groupBy === 'node' ? r.owner : r.host} />
                  <Mini label="CPU" value={r.usage ? fmtCpu(r.usage.cpuMilli) : '—'} />
                  <Mini label="Memory" value={r.usage ? fmtMem(r.usage.memBytes) : '—'} />
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-content-subtle">{label}</div>
      <div className={cn('truncate font-mono text-content', tone === 'bad' && 'text-rose-700 dark:text-rose-300')} title={value}>{value}</div>
    </div>
  )
}

/* ───────────────────────── detail panel ───────────────────────── */

type DetailTab = 'summary' | 'events' | 'manifest' | 'diff' | 'logs'

function ResourceDetail({ graph, node, app, onClose, onSelect, now }: { graph: CompositionGraph; node: CompNode; app: ArgoApp; onClose(): void; onSelect(id: string): void; now: number }) {
  const isPod = node.kind === 'Pod'
  const isApp = node.id === graph.roots[0]
  const outOfSync = node.status.sync === 'OutOfSync' || Boolean(node.status.prune)
  const [tab, setTab] = useState<DetailTab>('summary')
  const ref = { group: node.group, version: node.version, kind: node.kind, name: node.name, namespace: node.namespace }
  const discovery = useDiscovery(tab === 'manifest' && !node.object)
  const live = useLiveObject(discovery.data, ref, tab === 'manifest' && !node.object)
  const events = useObjectEvents(isApp ? { kind: 'Application', name: app.metadata.name, namespace: app.metadata.namespace } : ref, tab === 'events')
  const managed = useManagedResources({ name: app.metadata.name, namespace: app.metadata.namespace }, tab === 'diff')
  const argoBase = useToolPublicUrl('argocd')
  const argoUrl = argoBase
    ? `${argoBase.replace(/\/$/, '')}/applications/${app.metadata.namespace}/${app.metadata.name}${isApp ? '' : `?resource=&node=${encodeURIComponent(`${node.group}/${node.kind}/${node.namespace ?? ''}/${node.name}/0`)}`}`
    : undefined
  const pod = isPod ? podInfo(node) : undefined
  const r = workloadReplicas(node)
  const imgs = imagesOf(node)

  const fields: Array<[string, ReactNode]> = [
    ['API version', apiVersionOf(node) ?? (node.group || 'v1')],
    ['Namespace', node.namespace ?? '— (cluster-scoped)'],
    ['Created', node.createdAt ? `${new Date(node.createdAt).toLocaleString()} (${age(node.createdAt, now)} ago)` : '—'],
    ['Health', node.status.health ?? node.status.label],
    ['Sync', node.status.prune ? 'OutOfSync (requires pruning)' : node.status.sync ?? '—'],
  ]
  if (r) fields.push(['Replicas', `${r.ready} ready / ${r.desired} desired (${r.current} current)`])
  if (imgs.length && !isPod) fields.push(['Images', imgs.join('\n')])
  if (pod) {
    fields.push(['Node', pod.nodeName ?? '—'], ['Pod IP', pod.podIP ?? '—'], ['Ready', pod.ready], ['Restarts', String(pod.restarts)])
  }
  const hosts = hostnamesOf(node)
  if (hosts.length) fields.push(['Hostnames', hosts.join(', ')])

  const tabs: Array<{ value: DetailTab; label: string }> = [
    { value: 'summary', label: 'Summary' },
    { value: 'events', label: 'Events' },
    { value: 'manifest', label: 'Live' },
  ]
  if (outOfSync && !isApp) tabs.push({ value: 'diff', label: 'Diff' })
  if (isPod) tabs.push({ value: 'logs', label: 'Logs' })

  return (
    <NodeSidePanel<DetailTab>
      node={node}
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      wide={tab === 'logs' || tab === 'diff'}
      actions={argoUrl ? <a href={argoUrl} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">Argo CD ↗</a> : null}
    >
      {tab === 'summary' ? (
        <>
          <StatusCallout node={node} />
          <FieldList fields={fields} />
          {pod?.containers.length ? <ContainersTable containers={pod.containers} /> : null}
          <ConditionsTable conditions={node.conditions} now={now} />
          {node.info?.length ? (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold text-content">Argo CD info</h4>
              <FieldList fields={node.info.map((i) => [i.name, i.value])} />
            </section>
          ) : null}
          <RelatedList title="Parents" ids={node.parents} graph={graph} onSelect={onSelect} />
          <RelatedList title="Children" ids={node.children} graph={graph} onSelect={onSelect} />
        </>
      ) : null}
      {tab === 'events' ? <EventsList events={events} now={now} /> : null}
      {tab === 'manifest' ? (
        node.object ?? live.data ? (
          <CodeViewer value={node.object ?? live.data} filename={`${node.kind.toLowerCase()}-${node.name}`} ariaLabel={`${node.kind} ${node.name} live manifest`} height="calc(100vh - 230px)" />
        ) : live.isLoading || discovery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner size={14} /> Reading the live object…</div>
        ) : (
          <p className="text-xs text-content-muted">
            {(live.error as { status?: number } | null)?.status === 403 ? 'Your Kubernetes role cannot read this object.' : (live.error as { status?: number } | null)?.status === 404 ? 'It does not exist in the cluster (Missing).' : `Could not read it${live.error instanceof Error ? `: ${live.error.message}` : '.'}`}
          </p>
        )
      ) : null}
      {tab === 'diff' ? <DiffPane managed={managed} id={node.id} /> : null}
      {tab === 'logs' && pod ? <PodLogs namespace={node.namespace ?? ''} pod={node.name} containers={pod.containers.filter((c) => !c.init).map((c) => c.name)} /> : null}
    </NodeSidePanel>
  )
}

function ContainersTable({ containers }: { containers: NonNullable<ReturnType<typeof podInfo>>['containers'] }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold text-content">Containers</h4>
      <div className="overflow-x-auto rounded-md border border-edge-default">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-sunken text-[11px] text-content-subtle">
            <tr>
              <th className="px-2 py-1.5 font-medium">Name</th>
              <th className="px-2 py-1.5 font-medium">Image</th>
              <th className="px-2 py-1.5 font-medium">State</th>
              <th className="px-2 py-1.5 text-right font-medium">Restarts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-default">
            {containers.map((c) => (
              <tr key={`${c.init ? 'i' : 'c'}-${c.name}`} className="align-top">
                <td className="px-2 py-1.5 font-mono text-content">
                  <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', c.ready ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden />
                  {c.name}
                  {c.init ? <span className="ml-1 text-[10px] text-content-subtle">init</span> : null}
                </td>
                <td className="max-w-60 truncate px-2 py-1.5 font-mono text-content-muted" title={c.image}>{c.image ?? '—'}</td>
                <td className="px-2 py-1.5 text-content-muted">{c.state}</td>
                <td className="px-2 py-1.5 text-right text-content">{c.restarts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function DiffPane({ managed, id }: { managed: ReturnType<typeof useManagedResources>; id: string }) {
  const entry = managed.data?.get(id)
  const lines = useMemo(() => {
    if (!entry) return undefined
    const desired = entry.desired === undefined ? '' : toYaml(comparable(entry.desired))
    const liveText = entry.live === undefined ? '' : toYaml(comparable(entry.live))
    return lineDiff(desired, liveText)
  }, [entry])
  const chunks = useMemo(() => (lines ? diffChunks(lines, 3) : []), [lines])
  if (managed.isLoading) return <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner size={14} /> Asking Argo CD for the desired and live manifests…</div>
  if (managed.error) {
    const status = (managed.error as { status?: number }).status
    return <p className="text-xs text-content-muted">{status === 403 || status === 401 ? 'Argo CD did not allow reading this application’s managed resources.' : `Argo CD did not return managed resources: ${managed.error instanceof Error ? managed.error.message : String(managed.error)}`}</p>
  }
  if (!entry || !lines) return <p className="text-xs text-content-muted">Argo CD has no desired/live pair for this resource (it is not one it manages directly).</p>
  const changed = lines.filter((l) => l.type !== 'same').length
  return (
    <div className="space-y-2">
      <p className="text-xs text-content-muted">
        {entry.desired === undefined ? 'Not in Git — Argo CD would prune it on the next sync.' : entry.live === undefined ? 'In Git but missing from the cluster.' : `${changed} changed line${changed === 1 ? '' : 's'}.`}{' '}
        <span className="text-rose-700 dark:text-rose-300">− desired (Git)</span> · <span className="text-emerald-700 dark:text-emerald-300">+ live (cluster)</span>
      </p>
      <div className="overflow-x-auto rounded-lg border border-edge-default bg-surface-sunken font-mono text-[12px] leading-5">
        {chunks.map((c, i) =>
          c.type === 'skip' ? (
            <div key={i} className="border-y border-edge-default bg-surface-raised px-3 py-0.5 text-[11px] text-content-subtle">⋯ {c.count} unchanged lines</div>
          ) : (
            c.lines.map((l, j) => (
              <div
                key={`${i}-${j}`}
                className={cn(
                  'flex whitespace-pre',
                  l.type === 'add' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
                  l.type === 'del' && 'bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200',
                  l.type === 'same' && 'text-content-muted',
                )}
              >
                <span className="w-10 shrink-0 select-none pr-2 text-right text-content-subtle">{l.a ?? ''}</span>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-content-subtle">{l.b ?? ''}</span>
                <span className="w-4 shrink-0 select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                <span className="pr-3">{l.text}</span>
              </div>
            ))
          )
        )}
      </div>
    </div>
  )
}

function PodLogs({ namespace, pod, containers }: { namespace: string; pod: string; containers: string[] }) {
  const main = containers.filter(Boolean)
  const [container, setContainer] = useState(main[0] ?? '')
  const [previous, setPrevious] = useState(false)
  const stream = useLogStream({
    namespace,
    sources: [{ pod, container: container || undefined, label: container || pod }],
    follow: !previous,
    previous,
    tailLines: 500,
  })
  return (
    <LogConsole
      lines={stream.lines}
      status={stream.status}
      error={stream.error}
      reconnect={stream.reconnect}
      live={!previous}
      filename={`${pod}${container ? `-${container}` : ''}`}
      height="h-[calc(100vh-240px)]"
      label={<span className="font-mono">{pod}</span>}
      toolbar={
        <>
          {main.length > 1 ? (
            <select value={container} onChange={(e) => setContainer(e.target.value)} aria-label="Container" className="rounded border border-white/10 bg-transparent px-1 py-0.5 text-[11px] text-slate-200">
              {main.map((c) => <option key={c} value={c} className="text-slate-900">{c}</option>)}
            </select>
          ) : null}
          <button type="button" onClick={() => setPrevious((p) => !p)} className={cn('rounded px-1.5 py-0.5 text-[11px]', previous ? 'bg-white/15 text-white' : 'text-slate-300 hover:text-white')} title="Logs of the previous (crashed) container">
            Previous
          </button>
        </>
      }
      emptyMessage={previous ? 'No previous container — it has not restarted.' : 'No log lines yet.'}
    />
  )
}

