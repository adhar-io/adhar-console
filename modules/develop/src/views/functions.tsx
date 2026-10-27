import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  type Column,
  CONSOLE_PERMISSIONS,
  DataTable,
  EmptyState,
  type Facet,
  type FacetValues,
  FilterBar,
  matchesFacets,
  matchesQuery,
  optionsFromItems,
  PageHeader,
  StatusBadge,
  useAccessReview,
  useActiveNamespace,
  usePublicBaseDomain,
  useWatchSignal,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { useDevelopParams, useSetDevelopParams } from '../data/nav.ts'
import { StatTile } from '../components/list-kit.tsx'
import {
  FUNCTIONS_KEY,
  type FunctionList,
  useApplications,
  useFunctionList,
  useKnativeIndex,
  useProjects,
  watchOf,
} from '../data/functions.ts'
import {
  cellFor,
  environmentColumns,
  type FunctionCell,
  type FunctionGroup,
  FUNCTIONS_GVR,
  functionUrl,
  groupFacets,
  groupFunctions,
  groupHealth,
  groupSearchText,
  HEALTH_BADGE,
  isServing,
  LABEL,
  lastDeployed,
  parseFunctionRef,
  PLATFORM_ENVIRONMENTS,
  PODS_GVR,
  REVISIONS_GVR,
  runtimeLabel,
  scaleView,
  STATUS_LABEL,
  triggerLabel,
} from '../data/functions-model.ts'
import { FunctionDrawer, type FunctionTab } from './function-drawer.tsx'

/**
 * Develop → Functions — THE place functions are managed.
 *
 * Every Function the signed-in user can see, across namespaces, one row per
 * function with a column per environment (status, revision, scale, URL, last
 * deploy), kept live by apiserver watches. A row opens the function's drawer:
 * revisions and traffic, scale, pods and logs, metrics, events, builds,
 * delivery, invoke, configuration and delete.
 *
 * Functions are not created here. "New function" opens Catalog → Create New
 * on the function templates: a template scaffolds the repository, app-ci
 * builds it and the control plane deploys a Function into each environment
 * from the repository's overlays. A form that applied Function XRs directly
 * produced objects no repository owned, in the platform namespace, that
 * Argo CD would never reconcile — the inline create form is gone for that
 * reason.
 *
 * Deliver → Functions renders this same component in `delivery` mode (the
 * drawer opens on Delivery), so there is one table, not two that disagree.
 */

export type FunctionsMode = 'develop' | 'delivery'

const NEW_FUNCTION_HREF = '/catalog?section=create&family=function'

const FACET_LABEL: Record<string, string> = {
  project: 'Project',
  team: 'Team',
  runtime: 'Runtime',
  trigger: 'Trigger',
  status: 'Status',
  environment: 'Environment',
}

export function Functions({ mode = 'develop' }: { mode?: FunctionsMode } = {}) {
  const params = useDevelopParams()
  const setParams = useSetDevelopParams()
  const { namespace: shellNamespace } = useActiveNamespace()
  const baseDomain = usePublicBaseDomain()
  const projects = useProjects()
  const apps = useApplications()

  // Where to look when the caller may not list cluster-wide: every project's
  // environment namespaces, the platform's own environments, and whatever
  // namespace the shell has selected.
  const candidates = useMemo(
    () => [...projects.envNamespaces, ...PLATFORM_ENVIRONMENTS, ...(shellNamespace ? [shellNamespace] : [])],
    [projects.envNamespaces, shellNamespace],
  )
  const listQ = useFunctionList(candidates)
  const list = listQ.data
  const index = useKnativeIndex(list)

  const groups = useMemo(
    () => groupFunctions(list?.items ?? [], { envByNamespace: projects.envByNamespace, applications: apps.data }),
    [list?.items, projects.envByNamespace, apps.data],
  )
  const columns = useMemo(
    () => environmentColumns(groups, projects.environments.length ? projects.environments : PLATFORM_ENVIRONMENTS),
    [groups, projects.environments],
  )

  const scaleOf = (c: FunctionCell) =>
    scaleView(c.fn, { pods: index.podsUnknown ? undefined : index.pods, serving: isServing(c.state) })
  const scaledToZero = (c: FunctionCell) => scaleOf(c).scaledToZero

  // `?app=` (the Create New success link) starts the search on that application.
  const [query, setQuery] = useState(() => params.app ?? '')
  useEffect(() => {
    if (params.app) setQuery(params.app)
  }, [params.app])
  const [facetValues, setFacetValues] = useState<FacetValues>({})

  const facets = useMemo((): Facet[] => {
    const all = groups.map((g) => groupFacets(g, scaledToZero))
    const opts = (id: keyof (typeof all)[number], label?: (v: string) => string) => optionsFromItems(all, (f) => f[id], { label })
    return ([
      ['status', (v: string) => STATUS_LABEL[v as keyof typeof STATUS_LABEL] ?? v],
      ['environment', undefined],
      ['project', undefined],
      ['team', undefined],
      ['runtime', runtimeLabel],
      ['trigger', (v: string) => triggerLabel([v])],
    ] as const)
      .map(([id, label]) => ({ id, label: FACET_LABEL[id], kind: 'multi' as const, options: opts(id, label) }))
      .filter((f) => f.options.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, index.pods])

  const filtered = useMemo(() => {
    const accessors = Object.fromEntries(
      (['project', 'team', 'runtime', 'trigger', 'status', 'environment'] as const).map((id) => [id, (g: FunctionGroup) => groupFacets(g, scaledToZero)[id]]),
    )
    return groups.filter((g) => matchesQuery(query, groupSearchText(g)) && matchesFacets(g, facetValues, accessors))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, query, facetValues, index.pods])

  // Tiles count environments (cells), the unit a person acts on.
  const cells = groups.flatMap((g) => g.cells)
  const count = {
    ready: cells.filter((c) => c.state.health === 'ready').length,
    deploying: cells.filter((c) => c.state.health === 'deploying').length,
    failing: cells.filter((c) => c.state.health === 'failed' || c.state.health === 'degraded').length,
    zero: cells.filter(scaledToZero).length,
  }
  const toggleStatus = (values: string[]) => {
    const cur = facetValues.status ?? []
    const on = values.every((v) => cur.includes(v))
    setFacetValues({ ...facetValues, status: on ? cur.filter((v) => !values.includes(v)) : [...new Set([...cur, ...values])] })
  }

  // The open drawer: `?fn=<namespace>/<name>` (deep-linkable), `?tab=`.
  const open = parseFunctionRef(params.fn)
  const openGroup = open
    ? groups.find((g) => g.cells.some((c) => c.fn.metadata.namespace === open.namespace && c.fn.metadata.name === open.name))
    : params.fn?.startsWith('app:')
    ? groups.find((g) => g.pendingApp && g.application === params.fn!.slice(4))
    : undefined
  const openFn = (g: FunctionGroup, cell?: FunctionCell) => {
    const target = cell ?? g.cells[0]
    setParams({ fn: target ? `${target.fn.metadata.namespace}/${target.fn.metadata.name}` : `app:${g.application}`, tab: params.tab })
  }

  const createAccess = useAccessReview(CONSOLE_PERMISSIONS.applicationsCreate)
  const newFunction = createAccess.allowed
    ? <a href={NEW_FUNCTION_HREF} className={BUTTON_PRIMARY}>New function</a>
    : !createAccess.loading
    ? (
      <span
        className={cn(BUTTON_PRIMARY, 'cursor-not-allowed opacity-50')}
        aria-disabled='true'
        title='Creating a function needs `create applications.console.adhar.io` — ask a platform admin.'
      >
        New function
      </span>
    )
    : null

  const tableColumns = useMemo((): Column<FunctionGroup>[] => [
    {
      key: 'function',
      header: 'Function',
      pinned: true,
      value: (g) => g.name,
      cell: (g) => <FunctionNameCell g={g} />,
    },
    {
      key: 'runtime',
      header: 'Runtime · trigger',
      value: (g) => g.runtime ?? '',
      cell: (g) => (
        <div className='min-w-0 text-[12px]'>
          <div className='text-content'>{runtimeLabel(g.runtime)}</div>
          <div className='text-content-subtle'>{triggerLabel(g.triggers)}</div>
        </div>
      ),
    },
    ...columns.map((env): Column<FunctionGroup> => ({
      key: `env:${env}`,
      header: <span className='capitalize'>{env}</span>,
      sortable: false,
      filter: false,
      cell: (g) => {
        const cell = cellFor(g, env)
        if (!cell) return <span className='text-[12px] text-content-subtle' title={`Not deployed to ${env}`}>—</span>
        return (
          <EnvCell
            cell={cell}
            scale={scaleOf(cell)}
            revisions={index.revisions}
            baseDomain={baseDomain}
            envByNamespace={projects.envByNamespace}
            onOpen={() => openFn(g, cell)}
          />
        )
      },
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [columns, index.pods, index.revisions, baseDomain, projects.envByNamespace, params.tab])

  const filtering = Boolean(query) || Object.values(facetValues).some((v) => v.length)
  const loading = listQ.isLoading && !list

  return (
    <div className='space-y-4'>
      <PageHeader title='Functions' actions={newFunction} />
      {list?.scope === 'namespaces' ? <FunctionsLive list={list} /> : null}

      {list && !list.installed
        ? (
          <EmptyState
            title='Functions are not available on this cluster'
            description='The platform’s Function API (functions.platform.adhar.io) is not served here, so there is nothing to list. It ships with the control plane’s function composition.'
          />
        )
        : listQ.isError && !list
        ? (
          <EmptyState
            title='Could not load functions'
            description={listQ.error instanceof Error ? listQ.error.message : String(listQ.error)}
            action={<button type='button' className={BUTTON_SECONDARY} onClick={() => listQ.refetch()}>Retry</button>}
          />
        )
        : !loading && groups.length === 0
        ? <NoFunctions action={newFunction} />
        : (
          <>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5'>
              <StatTile label='Functions' value={groups.length} hint={`${cells.length} deployed across ${columns.length} environments`} />
              <StatTile label='Ready' value={count.ready} tone='emerald' on={(facetValues.status ?? []).includes('ready')} onClick={() => toggleStatus(['ready'])} />
              <StatTile label='Deploying' value={count.deploying} tone='info' on={(facetValues.status ?? []).includes('deploying')} onClick={() => toggleStatus(['deploying'])} />
              <StatTile label='Failing' value={count.failing} tone='amber' hint='failed or degraded' on={['failed', 'degraded'].every((s) => (facetValues.status ?? []).includes(s))} onClick={() => toggleStatus(['failed', 'degraded'])} />
              <StatTile label='Scaled to zero' value={index.podsUnknown ? '—' : count.zero} tone='violet' hint='next request cold-starts' on={(facetValues.status ?? []).includes('scaled-to-zero')} onClick={() => toggleStatus(['scaled-to-zero'])} />
            </div>

            <FilterBar
              search={{ value: query, onChange: setQuery, placeholder: 'Search functions, applications, images, URLs…', label: 'Search functions' }}
              facets={facets}
              values={facetValues}
              onValuesChange={setFacetValues}
              loading={loading}
              refreshing={listQ.isFetching && !loading}
              summary={
                <span aria-live='polite'>
                  {filtered.length} {filtered.length === 1 ? 'function' : 'functions'}
                  {filtered.length !== groups.length ? ` of ${groups.length}` : ''}
                </span>
              }
            />

            {list?.scope === 'namespaces' && list.denied.length
              ? (
                <p className='text-[11px] text-content-subtle'>
                  Showing functions in the namespaces you can read
                  {list.namespaces.length > list.denied.length ? ` (${list.namespaces.filter((n) => !list.denied.includes(n)).join(', ')})` : ''}. Not visible to you:{' '}
                  <span className='font-mono'>{list.denied.join(', ')}</span>.
                </p>
              )
              : null}

            <DataTable
              columns={tableColumns}
              rows={filtered}
              rowKey={(g) => g.key}
              onRowClick={(g) => openFn(g)}
              loading={loading}
              dense
              empty={
                filtering
                  ? <EmptyState compact title='No functions match' description='Nothing matches the search and filters — clear them to see every function.' />
                  : <NoFunctions action={newFunction} compact />
              }
            />
          </>
        )}

      {openGroup
        ? (
          <FunctionDrawer
            key={openGroup.key}
            group={openGroup}
            selected={open ?? undefined}
            mode={mode}
            tab={params.tab as FunctionTab | undefined}
            environments={columns}
            envByNamespace={projects.envByNamespace}
            projectEnvironments={openGroup.project ? projects.byProject.get(openGroup.project)?.map((e) => e.name) : undefined}
            applications={apps.data}
            onSelect={(cell) => setParams({ fn: `${cell.fn.metadata.namespace}/${cell.fn.metadata.name}` })}
            onTab={(t) => setParams({ tab: t })}
            onClose={() => setParams({ fn: '', tab: '' })}
          />
        )
        : null}
    </div>
  )
}

/* ─────────────────────────── cells ─────────────────────────── */

const BUTTON_PRIMARY =
  'inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 hover:text-white visited:text-white'
const BUTTON_SECONDARY =
  'inline-flex h-8 items-center rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong'

function FunctionNameCell({ g }: { g: FunctionGroup }) {
  const health = groupHealth(g)
  return (
    <div className='min-w-0'>
      <div className='flex items-center gap-2'>
        <span className='truncate font-medium text-content'>{g.name}</span>
        {health === 'pending' ? <StatusBadge kind='info'>not deployed yet</StatusBadge> : null}
      </div>
      <div className='truncate text-[11px] text-content-subtle'>
        {[g.application !== g.name ? `app ${g.application}` : null, g.project ? `project ${g.project}` : null, g.team ? `team ${g.team}` : null]
          .filter(Boolean)
          .join(' · ') || '—'}
      </div>
    </div>
  )
}

function EnvCell({
  cell,
  scale,
  revisions,
  baseDomain,
  envByNamespace,
  onOpen,
}: {
  cell: FunctionCell
  scale: ReturnType<typeof scaleView>
  revisions: Parameters<typeof lastDeployed>[1]
  baseDomain: string
  envByNamespace: ReadonlyMap<string, string>
  onOpen(): void
}) {
  const fn = cell.fn
  const { url, clusterOnly, derived } = functionUrl(fn, baseDomain, envByNamespace)
  const deployed = lastDeployed(fn, revisions)
  const rev = fn.status?.readyRevision
  const shortRev = rev ? rev.replace(`${fn.metadata.name}-`, '') : undefined
  return (
    <div className='min-w-[9.5rem] space-y-0.5 text-[11px]'>
      <div className='flex items-center gap-1.5'>
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          title={cell.state.message ?? cell.state.label}
          className='rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40'
        >
          <StatusBadge kind={HEALTH_BADGE[cell.state.health]}>{cell.state.label}</StatusBadge>
        </button>
        {shortRev ? <span className='font-mono text-content-subtle' title={rev}>{shortRev}</span> : null}
        {url && !clusterOnly && !derived
          ? (
            <a
              href={url}
              target='_blank'
              rel='noreferrer'
              onClick={(e) => e.stopPropagation()}
              className='text-brand-700 hover:underline dark:text-brand-300'
              title={url}
              aria-label={`Open ${url}`}
            >
              ↗
            </a>
          )
          : null}
      </div>
      <div className='text-content-subtle'>
        {scale.scaledToZero
          ? <span className='text-violet-700 dark:text-violet-300' title='No pod is running — the next request cold-starts.'>scaled to zero</span>
          : scale.actual === undefined
          ? <span title={`min ${scale.min} · max ${scale.max}`}>{scale.min}–{scale.max} pods</span>
          : <span title={`min ${scale.min} · max ${scale.max}`}>{scale.actual} {scale.actual === 1 ? 'pod' : 'pods'} ({scale.min}–{scale.max})</span>}
        {deployed ? <span> · {formatRelative(deployed)}</span> : null}
      </div>
    </div>
  )
}

function NoFunctions({ action, compact = false }: { action?: ReactNode; compact?: boolean }) {
  return (
    <EmptyState
      compact={compact}
      title='No functions yet'
      description={
        <>
          Functions are created from templates. Pick a function template in Create New and the platform scaffolds its repository,
          builds it on every push (app-ci) and deploys a Function to each environment of its project — Knative, scaled to zero
          when idle. It appears here as soon as its first build is promoted to dev.
        </>
      }
      action={
        <>
          {action}
          <a href='/catalog?section=create' className={BUTTON_SECONDARY}>Browse all templates</a>
        </>
      }
    />
  )
}

/* ─────────────────────────── live, per namespace ─────────────────────────── */

/**
 * The change signal for callers who cannot watch cluster-wide: one watch per
 * readable namespace for Functions, their pods and their revisions, each
 * invalidating the page's queries. Renders nothing.
 */
function FunctionsLive({ list }: { list: FunctionList }) {
  const readable = list.namespaces.filter((n) => !list.denied.includes(n))
  return <>{readable.map((ns) => <NamespaceWatch key={ns} namespace={ns} />)}</>
}

function NamespaceWatch({ namespace }: { namespace: string }) {
  useWatchSignal(watchOf(FUNCTIONS_GVR, { namespace }), [[...FUNCTIONS_KEY]], { fallbackMs: 60_000, throttleMs: 2_000 })
  useWatchSignal(watchOf(PODS_GVR, { namespace, labelSelector: LABEL.ksvc }), [['functions', 'index', 'pods']], { fallbackMs: 60_000, throttleMs: 2_000 })
  useWatchSignal(watchOf(REVISIONS_GVR, { namespace, labelSelector: LABEL.ksvc }), [['functions', 'index', 'revisions']], { fallbackMs: 60_000, throttleMs: 2_000 })
  return null
}
