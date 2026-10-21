import { useMemo, useState } from 'react'
import { Button, EmptyState, SearchInput, Select, Skeleton, useTeamProjects } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { argoRollouts } from '@adhar/api-clients'
import { useRollouts } from '../data/delivery.ts'
import { useAllArgoApps } from '../data/project-environments.ts'
import {
  type ArgoAppLike,
  attentionNote,
  attentionRank,
  byAppAttention,
  envLabel,
  envOptions,
  filterApps,
  groupRollouts,
  type PhaseFilter,
  projectOptions,
  type RolloutApp,
  type RolloutEnv,
  summariseApps,
} from '../data/rollout-apps.ts'
import { errorStatus, useRolloutParams } from '../data/rollout-queries.ts'
import { CrdMissing } from '../components/crd-missing.tsx'
import { type ArgoAppHistory, RolloutDetail } from './rollouts-detail.tsx'
import { IconChevron, PhasePill, Stat, strategyLabel } from './rollouts-parts.tsx'

/**
 * Argo Rollouts — one entry per APPLICATION.
 *
 * An Adhar app is deployed once per project environment (dev → test → prod),
 * so it owns one Rollout per environment. The page lists each app once, with
 * every environment's state and version on its row; opening it shows the
 * current rollout of an environment in full and every earlier revision as
 * history (`rollouts-detail.tsx`).
 *
 * Grouping, summary and filters live in `data/rollout-apps.ts`; history in
 * `data/rollout-history.ts`; which actions are offered in `rollout-state.ts` —
 * all under test.
 *
 * Deep link: `?section=rollouts&app=<project|namespace>/<app>&env=<env>`.
 */

const ROLLOUTS_DOCS = 'https://argo-rollouts.readthedocs.io/en/stable/installation/'

export function Rollouts() {
  const q = useRollouts()
  const argo = useAllArgoApps()
  const team = useTeamProjects()
  const [params, setParams] = useRolloutParams()

  const [search, setSearch] = useState('')
  const [phase, setPhase] = useState<PhaseFilter | null>(null)
  const [project, setProject] = useState('')
  const [env, setEnv] = useState('')

  const argoApps = useMemo(() => (argo.data ?? []) as unknown as ArgoAppLike[], [argo.data])
  const argoHistory = useMemo<ArgoAppHistory[]>(
    () => (argo.data ?? []).map((a) => ({ name: a.metadata.name, history: a.status.history ?? [] })),
    [argo.data],
  )

  const all = useMemo(
    () => groupRollouts((q.data ?? []) as argoRollouts.Rollout[], argoApps).sort(byAppAttention),
    [q.data, argoApps],
  )
  // The active team's projects, when a team is selected. Rollouts no project
  // owns (platform packages) only show when nothing of the team's is here.
  const apps = useMemo(() => {
    if (!team.filtering) return all
    const slugs = new Set(team.projects.flatMap((p) => [p.slug, p.argoProject].filter((v): v is string => Boolean(v))))
    const mine = all.filter((a) => a.project && slugs.has(a.project))
    return mine.length ? mine : all
  }, [all, team.filtering, team.projects])

  const summary = useMemo(() => summariseApps(apps), [apps])
  const projects = useMemo(() => projectOptions(apps), [apps])
  const envs = useMemo(() => envOptions(apps), [apps])
  const visible = useMemo(
    () => filterApps(apps, { phase, project: project || null, env: env || null, query: search }),
    [apps, phase, project, env, search],
  )

  const selectedApp = params.app ? all.find((a) => a.key === params.app) : undefined
  const selectedEnv = selectedApp
    ? selectedApp.envs.find((e) => e.env === params.env) ??
      [...selectedApp.envs].sort((a, b) => attentionRank(a.view) - attentionRank(b.view))[0]
    : undefined

  const open = (a: RolloutApp, e?: RolloutEnv) => setParams({ app: a.key, env: e?.env }, { push: true })
  const close = () => setParams({ app: undefined, env: undefined })

  if (q.isLoading && !q.data) return <ListSkeleton />
  if (q.isError && !q.data) {
    const status = errorStatus(q.error)
    if (status === 404) return <CrdMissing tool="Argo Rollouts" href={ROLLOUTS_DOCS} />
    if (status === 403) {
      return (
        <EmptyState
          title="No access to Rollouts"
          description="Your role can't list argoproj.io Rollouts on this cluster. Ask a platform admin for read access to see progressive delivery here."
        />
      )
    }
    return (
      <EmptyState
        title="Couldn't reach Argo Rollouts"
        description={q.error instanceof Error ? q.error.message : 'The Rollout CRD could not be read from this cluster.'}
      />
    )
  }
  if (all.length === 0) {
    return (
      <EmptyState
        title="No Argo Rollouts"
        description="Nothing in this cluster uses a Rollout yet. A Rollout replaces a Deployment to get canary or blue/green delivery with analysis between the steps."
      />
    )
  }

  const togglePhase = (p: PhaseFilter) => setPhase((cur) => (cur === p ? null : p))
  const filtered = Boolean(phase || project || env || search.trim())
  const tile = (p: PhaseFilter) => summary.by[p]
  const envHint = (n: number) => `${n} environment${n === 1 ? '' : 's'}`

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Applications"
          value={summary.apps}
          hint={envHint(summary.envs)}
          active={!phase && !filtered}
          onClick={() => setPhase(null)}
        />
        <Stat
          label="Degraded"
          value={tile('Degraded').apps}
          tone={tile('Degraded').apps ? 'failed' : undefined}
          hint={tile('Aborted').envs ? `${tile('Aborted').envs} aborted` : tile('Degraded').envs ? envHint(tile('Degraded').envs) : 'none failing'}
          active={phase === 'Degraded'}
          onClick={() => togglePhase('Degraded')}
        />
        <Stat
          label="Paused"
          value={tile('Paused').apps}
          tone={tile('Paused').apps ? 'paused' : undefined}
          hint={tile('Paused').envs ? `${envHint(tile('Paused').envs)} waiting` : 'nothing waiting'}
          active={phase === 'Paused'}
          onClick={() => togglePhase('Paused')}
        />
        <Stat
          label="Progressing"
          value={tile('Progressing').apps}
          tone={tile('Progressing').apps ? 'progressing' : undefined}
          hint={tile('Progressing').envs ? `${envHint(tile('Progressing').envs)} mid-rollout` : 'none in flight'}
          active={phase === 'Progressing'}
          onClick={() => togglePhase('Progressing')}
        />
        <Stat
          label="Healthy"
          value={tile('Healthy').apps}
          tone={tile('Healthy').apps ? 'healthy' : undefined}
          hint={`${envHint(tile('Healthy').envs)} fully out`}
          active={phase === 'Healthy'}
          onClick={() => togglePhase('Healthy')}
        />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search app, namespace or image…"
          label="Search rollouts"
          block
          className="min-w-0 sm:flex-1"
        />
        <div className="flex gap-2">
          {projects.length > 1 ? (
            <Select
              aria-label="Project"
              value={project}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setProject(e.target.value)}
              wrapperClassName="min-w-0 flex-1 sm:w-44 sm:flex-none"
              options={[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p, label: p }))]}
            />
          ) : null}
          {envs.length > 1 ? (
            <Select
              aria-label="Environment"
              value={env}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEnv(e.target.value)}
              wrapperClassName="min-w-0 flex-1 sm:w-40 sm:flex-none"
              options={[{ value: '', label: 'All environments' }, ...envs.map((p) => ({ value: p, label: p }))]}
            />
          ) : null}
          {filtered ? (
            <Button
              size="md"
              variant="ghost"
              onClick={() => {
                setSearch('')
                setPhase(null)
                setProject('')
                setEnv('')
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState compact title="No matching applications" description="Relax the filters or the search." />
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
          {visible.map((a) => <AppRow key={a.key} app={a} envFilter={env || undefined} onOpen={open} />)}
        </ul>
      )}

      {selectedApp && selectedEnv ? (
        <RolloutDetail
          app={selectedApp}
          env={selectedEnv}
          argoApps={argoHistory}
          onEnv={(e) => setParams({ app: selectedApp.key, env: e.env })}
          onClose={close}
        />
      ) : null}
    </div>
  )
}

/* ─────────── rows ─────────── */

const ENV_EDGE: Record<string, string> = {
  Healthy: 'border-edge-default',
  Progressing: 'border-indigo-300 dark:border-indigo-500/40',
  Paused: 'border-amber-300 dark:border-amber-500/40',
  Degraded: 'border-rose-300 dark:border-rose-500/40',
  Unknown: 'border-edge-default',
}

function AppRow({
  app: a,
  envFilter,
  onOpen,
}: {
  app: RolloutApp
  envFilter?: string
  onOpen(a: RolloutApp, e?: RolloutEnv): void
}) {
  const urgent = a.envs.filter((e) => attentionNote(e) && attentionRank(e.view) < 4)
  const note = urgent.length ? `${envLabel(a, urgent[0])}: ${attentionNote(urgent[0])}${urgent.length > 1 ? ` (+${urgent.length - 1})` : ''}` : undefined
  const envs = envFilter ? a.envs.filter((e) => e.env === envFilter) : a.envs

  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-center lg:gap-5">
      <button type="button" onClick={() => onOpen(a)} className="group min-w-0 text-left lg:w-64 lg:shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-semibold text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">{a.app}</span>
          <IconChevron className="h-3.5 w-3.5 text-content-subtle opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-content-subtle">
          <span className="truncate">{a.scope}</span>
          <span>·</span>
          <span>{strategyLabel(a.strategy)}</span>
        </div>
        {note ? (
          <div className={cn('mt-1 truncate text-[11px] font-medium', a.rank <= 0 ? 'text-rose-700 dark:text-rose-300' : a.rank === 1 ? 'text-amber-700 dark:text-amber-300' : 'text-indigo-700 dark:text-indigo-300')}>
            {note}
          </div>
        ) : null}
      </button>

      <div className="flex min-w-0 flex-1 flex-wrap gap-2">
        {envs.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => onOpen(a, e)}
            title={`${e.namespace}/${e.name}`}
            className={cn(
              'flex min-w-0 basis-full flex-col gap-1 rounded-lg border bg-surface-raised px-2.5 py-2 text-left transition-colors hover:bg-surface-sunken/50 sm:basis-auto sm:min-w-40',
              e.view.aborted ? 'border-rose-300 dark:border-rose-500/40' : ENV_EDGE[e.view.phase] ?? 'border-edge-default',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-semibold text-content">{envLabel(a, e)}</span>
              <PhasePill phase={e.view.phase} aborted={e.view.aborted} className="px-1.5 text-[11px]" />
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-content-subtle">
              {e.tag ? <span className="min-w-0 truncate font-mono text-content" title={e.images[0]?.image}>{e.tag}</span> : null}
              {e.revision ? <span className="shrink-0">· rev {e.revision}</span> : null}
              {e.view.strategy === 'canary' && e.view.totalSteps && !e.view.fullyRolledOut && !e.view.aborted && e.view.phase !== 'Healthy'
                ? <span className="ml-auto shrink-0 tabular-nums">{Math.min(e.view.currentStep + 1, e.view.totalSteps)}/{e.view.totalSteps}</span>
                : null}
            </span>
          </button>
        ))}
      </div>
    </li>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading rollouts">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={74} className="block w-full" rounded="lg" />)}
      </div>
      <Skeleton height={36} className="block w-full" />
      <div className="space-y-2">
        {[0, 1, 2].map((i) => <Skeleton key={i} height={68} className="block w-full" rounded="lg" />)}
      </div>
    </div>
  )
}

export default Rollouts
