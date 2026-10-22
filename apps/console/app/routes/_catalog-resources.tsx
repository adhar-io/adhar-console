import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Input, Select, Spinner, StatusBadge, type StatusKind, usePublicUrl, useToast, useToolPublicUrl } from '@adhar/shell-ui'
import type { argocd } from '@adhar/api-clients'
import { cn } from '@adhar/utils'
import { IconBtn, Segmented, ToggleChip } from '~/components/code-viewer.tsx'
import { GraphView, HealthMark, KindIcon, LEVEL_DOT, LEVEL_KIND, SyncMark } from '~/components/resource-graph.tsx'
import { cardExtra, networkExtra, ResourceDetail } from '~/components/resource-detail.tsx'
import type { Entity } from '~/data/catalog.ts'
import { type EntityDeployment, kargoEnvironments, useKargoStages } from '~/data/catalog-deployment.ts'
import type { CompositionRoots } from '~/data/catalog-composition.ts'
import { age, argoHealthLevel, type CompositionGraph, kindsOf, nodeId } from '~/data/catalog-composition-model.ts'
import { RESOURCES_REFRESH_MS, useAppResources } from '~/data/catalog-resources.ts'
import {
  envTabs,
  resourceViews,
  type ResourcesView,
  fmtCpu,
  fmtMem,
  groupPods,
  networkGraph,
  type PodRow,
  podRows,
  type ResourceFilter,
  resourceVisible,
} from '~/data/catalog-resources-model.ts'
import { CompositionView } from './_catalog-composition.tsx'

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

const VIEW_LABEL: Record<ResourcesView, string> = { composition: 'Composition', tree: 'Tree', network: 'Network', pods: 'Pods', list: 'List' }

/**
 * The drawer's Resources tab — one tool for everything the entity runs:
 *
 *   • Composition: the platform composite and all it composed, down to the
 *     Argo CD apps and their live resources (`CompositionView`).
 *   • Tree / Network / Pods / List: one Argo CD application at a time, the way
 *     Argo CD's app view shows it (`AppView`).
 *
 * The environment chips scope both: an environment picks the app the Argo
 * views show and narrows the composition graph to that app's branch; "All
 * environments" shows the whole composition and, for the Argo views, a health
 * and sync summary of every environment. Every view opens the same side
 * panel (Summary / Events / YAML / Diff / Logs).
 */
export function ResourcesTab({ entity, deployment, roots }: {
  entity: Entity
  deployment: EntityDeployment
  roots: CompositionRoots
}) {
  const stages = useKargoStages(deployment.apps.length > 0)
  const kargoOrder = useMemo(
    () => kargoEnvironments(stages.data, deployment, entity.metadata.name).map((k) => k.stage.name),
    [stages.data, deployment, entity.metadata.name],
  )
  const tabs = useMemo(() => envTabs(deployment.environments, deployment.unscoped, kargoOrder), [deployment.environments, deployment.unscoped, kargoOrder])
  const hasComposition = roots.roots.length > 0 || Boolean(roots.error) || roots.isLoading
  const { views, initial } = resourceViews({ composition: hasComposition, apps: tabs.length })
  const [picked, setView] = useState<ResourcesView | null>(null)
  const view = picked && views.includes(picked) ? picked : initial
  const [envId, setEnvId] = useState<string>(ALL)
  const current = tabs.length === 1 ? tabs[0] : tabs.find((t) => t.id === envId)
  const scope = current ? nodeId({ group: 'argoproj.io', kind: 'Application', namespace: current.app.metadata.namespace, name: current.app.metadata.name }) : null

  if (deployment.isLoading && !hasComposition) {
    return <div className="flex items-center gap-2 py-10 text-sm text-content-muted"><Spinner /> Finding what this entity runs…</div>
  }
  if (!views.length || (!tabs.length && !hasComposition)) {
    return (
      <EmptyState
        compact
        title={deployment.isError ? 'Argo CD could not be reached' : 'Nothing deployed or composed for this entity'}
        description={deployment.isError
          ? 'The application list did not load, and no platform composite was found.'
          : 'Argo CD apps are matched by name (<name>, <name>-<env>), the adhar.io/application label or the adhar.io/argocd-app annotation; a composite by adhar.io/xr or its name.'}
      />
    )
  }

  const argoView = view !== 'composition'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {views.length > 1 ? (
          <Segmented<ResourcesView> value={view} onChange={setView} ariaLabel="Resources view" options={views.map((v) => ({ value: v, label: VIEW_LABEL[v] }))} />
        ) : null}
        {tabs.length > 1 ? (
          <div className="-mx-1 flex min-w-0 basis-full gap-1.5 overflow-x-auto px-1 py-0.5 sm:basis-auto sm:flex-1 sm:justify-end" role="tablist" aria-label="Environment">
            <EnvChip selected={!current} onClick={() => setEnvId(ALL)} label="All environments" />
            {tabs.map((t) => (
              <EnvChip key={t.id} selected={current?.id === t.id} onClick={() => setEnvId(t.id)} label={t.label} health={t.app.status.health.status} sync={t.app.status.sync.status} />
            ))}
          </div>
        ) : null}
      </div>

      {current ? <AppHeader app={current.app} label={current.label} /> : null}

      {!argoView ? (
        <CompositionView roots={roots} scope={scope} />
      ) : current ? (
        <AppView key={current.id} app={current.app} view={view as AppViewKind} />
      ) : (
        <AllEnvironments tabs={tabs} onPick={setEnvId} />
      )}
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

type AppViewKind = 'tree' | 'network' | 'pods' | 'list'

const NO_COLLAPSE: ReadonlySet<string> = new Set()

function AppView({ app, view }: { app: ArgoApp; view: AppViewKind }) {
  const ref = useMemo(() => ({ name: app.metadata.name, namespace: app.metadata.namespace }), [app.metadata.name, app.metadata.namespace])
  const [paused, setPaused] = useState(false)
  const data = useAppResources(ref, { paused })
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
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-content-subtle">
          Argo CD app <span className="font-mono text-content-muted">{app.metadata.name}</span>
          {data.data ? ` · ${Object.keys(data.data.graph.nodes).length - 1} resources` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => setPaused((p) => !p)} aria-pressed={!paused} title={paused ? 'Resume auto-refresh' : `Auto-refreshing every ${RESOURCES_REFRESH_MS / 1000}s — pause`}>
            <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', paused ? 'bg-content-subtle' : 'bg-emerald-500')} aria-hidden />
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
        <ResourceDetail graph={graph} node={graph.nodes[selected]} appRef={ref} onClose={() => setSelected(null)} onSelect={setSelected} now={now} />
      ) : null}
    </div>
  )
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
    <div className="max-h-[min(68vh,680px)] overflow-auto rounded-xl border border-edge-default">
      <table className="w-full table-fixed text-left text-xs">
        <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-medium uppercase tracking-wide text-content-subtle">
          <tr>
            <th className="px-3 py-2 font-medium">Resource</th>
            <th className="hidden w-40 px-3 py-2 font-medium md:table-cell">Namespace</th>
            <th className="w-28 px-3 py-2 font-medium">Sync</th>
            <th className="w-32 px-3 py-2 font-medium">Health</th>
            <th className="w-16 px-3 py-2 text-right font-medium">Age</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-default bg-surface-raised">
          {rows.map((n) => (
            <tr
              key={n.id}
              onClick={() => onSelect(n.id)}
              // Keyboard parity with the click: focusable, Enter/Space opens.
              tabIndex={0}
              aria-selected={selected === n.id}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                onSelect(n.id)
              }}
              className={cn('cursor-pointer hover:bg-surface-sunken/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500', selected === n.id && 'bg-brand-50/60 dark:bg-brand-500/10')}
            >
              <td className="px-3 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <KindIcon node={n} className="h-6 w-6 shrink-0 text-[9px]" />
                  <span className="min-w-0 flex-1" title={n.name}>
                    <span className="block truncate font-mono text-[12px] text-content">{n.name}</span>
                    <span className="block truncate text-[11px] text-content-subtle">{n.kind}{cardExtra(n) ? ` · ${cardExtra(n)}` : ''}</span>
                  </span>
                </div>
              </td>
              <td className="hidden truncate whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-content-muted md:table-cell">{n.namespace ?? '—'}</td>
              <td className="px-3 py-1.5 text-[11px]"><SyncMark sync={n.status.sync} prune={n.status.prune} />{!n.status.sync && !n.status.prune ? <span className="text-content-subtle">—</span> : null}</td>
              <td className="px-3 py-1.5 text-[11px]"><HealthMark level={n.status.level} label={n.status.health ?? n.status.label} /></td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-content-subtle">{age(n.createdAt, now)}</td>
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
          <h4 className="mb-1.5 flex min-w-0 items-center gap-2 text-xs font-semibold text-content">
            <span className={cn('h-2 w-2 rounded-full', LEVEL_DOT[g.worst])} aria-hidden />
            <span className="truncate font-mono">{g.key}</span>
            <span className="shrink-0 font-normal text-content-subtle">{g.rows.length} pod{g.rows.length === 1 ? '' : 's'}</span>
          </h4>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
            {g.rows.map((r) => (
              <button
                key={r.node.id}
                type="button"
                onClick={() => onSelect(r.node.id)}
                className={cn(
                  'min-w-0 rounded-lg border bg-surface-raised p-2.5 text-left text-xs shadow-sm hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
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

