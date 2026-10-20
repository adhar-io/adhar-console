import { useMemo, useState } from 'react'
import { Button, EmptyState, Field, Modal, Select, Spinner, StatusBadge, type StatusKind, TeamScopeBar, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { kargo } from '@adhar/api-clients'
import { useAbortPromotion, usePromote } from '../data/delivery.ts'
import { useAnalysisRun, useProjectEnvironmentsData } from '../data/project-environments.ts'

/**
 * **Project environments** — the top of Deliver → Environments.
 *
 * Environments belong to a project, not to an application: every app of the
 * project is deployed into the same dev → test → prod. So the page is
 * organised Project → its environments, and each environment lists every
 * application with the version it is running there, its health and sync, its
 * last promotion and a promote / abort for that ONE application.
 *
 * Works for both Kargo shapes — the project's shared stage per environment
 * (target) and the per-app `<app>-<env>` stages (current) — through
 * `kargo.buildProjectMatrix`, which reads each app's own freight out of a
 * shared stage.
 */

type View = 'columns' | 'matrix'

const PROJECT_KEY = 'adhar.deliver.env-project'
const VIEW_KEY = 'adhar.deliver.env-view'

function readPref(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function writePref(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    /* storage unavailable — the choice just does not persist */
  }
}
function initialProject(): string {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('project')
    if (q) return q
  } catch {
    /* no location (tests) */
  }
  return readPref(PROJECT_KEY)
}

const ENV_LABEL: Record<string, string> = { dev: 'Development', development: 'Development', test: 'Test', qa: 'QA', uat: 'UAT', staging: 'Staging', stage: 'Staging', prod: 'Production', production: 'Production' }
const envTitle = (name: string) => ENV_LABEL[name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1)

function healthKind(h?: string): StatusKind {
  if (h === 'Healthy') return 'healthy'
  if (h === 'Progressing') return 'progressing'
  if (h === 'Degraded' || h === 'Missing') return 'degraded'
  if (h === 'Suspended') return 'paused'
  return 'unknown'
}

const DOT: Record<StatusKind, string> = {
  healthy: 'bg-emerald-500',
  progressing: 'bg-indigo-500',
  degraded: 'bg-rose-500',
  failed: 'bg-rose-500',
  paused: 'bg-amber-500',
  unknown: 'bg-slate-400',
} as Record<StatusKind, string>

type Target = { cell: kargo.MatrixCell; view: kargo.AppStage }

export function ProjectEnvironments() {
  const [picked, setPicked] = useState(initialProject)
  const [view, setView] = useState<View>(() => (readPref(VIEW_KEY) === 'matrix' ? 'matrix' : 'columns'))
  const d = useProjectEnvironmentsData(picked || undefined)
  const [promoting, setPromoting] = useState<Target | null>(null)
  const [aborting, setAborting] = useState<Target | null>(null)

  const choose = (p: string) => {
    setPicked(p)
    writePref(PROJECT_KEY, p)
  }
  const switchView = (v: View) => {
    setView(v)
    writePref(VIEW_KEY, v)
  }

  const m = d.matrix
  const shapeNote = m?.shape === 'shared'
    ? 'one shared promotion chain for every application'
    : m?.shape === 'per-app'
      ? 'promoted through per-application stages'
      : m?.shape === 'mixed'
        ? 'moving to one shared chain — some apps still use their own stages'
        : 'no Kargo stages yet'

  return (
    <section className='space-y-3'>
      <div className='flex flex-wrap items-end justify-between gap-x-4 gap-y-2'>
        <div className='min-w-0'>
          <h2 className='text-[15px] font-semibold tracking-tight text-content'>Project environments</h2>
          <p className='text-[11px] text-content-subtle'>
            {m
              ? `${m.apps.length} ${m.apps.length === 1 ? 'application' : 'applications'} · ${m.envs.map((e) => e.name).join(' → ') || 'no environments'} · ${shapeNote}`
              : 'every application of a project shares its environments'}
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          {d.scoped.length ? (
            <Select
              aria-label='Project'
              value={d.active ?? ''}
              onChange={(e) => choose(e.currentTarget.value)}
              className='h-8 min-w-[10rem] text-xs'
            >
              {d.scoped.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name}
                  {o.declared ? '' : ' (no Project resource)'}
                </option>
              ))}
            </Select>
          ) : null}
          <div role='tablist' aria-label='Layout' className='inline-flex rounded-lg border border-edge-default bg-surface-raised p-0.5'>
            {(['columns', 'matrix'] as const).map((v) => (
              <button
                key={v}
                type='button'
                role='tab'
                aria-selected={view === v}
                onClick={() => switchView(v)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors pointer-coarse:py-2',
                  view === v ? 'bg-surface-sunken text-content' : 'text-content-muted hover:text-content',
                )}
              >
                {v === 'columns' ? 'Environments' : 'Versions matrix'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <TeamScopeBar team={d.team.filtering ? d.team.team : ''} shown={d.scoped.length} total={d.options.length} noun='projects' />

      {d.loading ? (
        <div className='flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-5 text-sm text-content-muted shadow-sm'>
          <Spinner size={14} /> Loading project environments…
        </div>
      ) : d.errors.stages && d.errors.argo ? (
        <EmptyState
          compact
          title="Couldn't read Kargo or Argo CD"
          description={(d.errors.stages as Error)?.message ?? 'Neither the promotion stages nor the deployments are readable with your access.'}
        />
      ) : !m || !d.active ? (
        <EmptyState
          compact
          title='No projects yet'
          description='Environments belong to a project. Create one in Platform → Projects; every application in it is then deployed to its dev → test → prod.'
          action={<a href='/platform?section=projects' className='text-xs font-medium text-brand-700 hover:underline dark:text-brand-300'>Platform → Projects</a>}
        />
      ) : !m.envs.length ? (
        <EmptyState
          compact
          title={`Project ${m.project} has no environments`}
          description='Nothing is deployed until the project publishes its environments. Add them at the project level in Platform → Environments.'
          action={<a href='/platform?section=environments' className='text-xs font-medium text-brand-700 hover:underline dark:text-brand-300'>Platform → Environments</a>}
        />
      ) : view === 'columns' ? (
        <div className={cn('grid grid-cols-1 gap-3 md:grid-cols-2', m.envs.length >= 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
          {m.envs.map((env, i) => (
            <EnvColumn
              key={env.name}
              env={env}
              step={i + 1}
              matrix={m}
              onPromote={(t) => setPromoting(t)}
              onAbort={(t) => setAborting(t)}
            />
          ))}
        </div>
      ) : (
        <VersionsMatrix matrix={m} onPromote={(t) => setPromoting(t)} />
      )}

      {promoting ? <PromoteAppDialog target={promoting} freight={d.freight} onClose={() => setPromoting(null)} /> : null}
      {aborting ? <AbortDialog target={aborting} onClose={() => setAborting(null)} /> : null}
    </section>
  )
}

/* ─────────── one environment ─────────── */

function EnvColumn({
  env,
  step,
  matrix,
  onPromote,
  onAbort,
}: {
  env: kargo.ProjectEnv
  step: number
  matrix: kargo.ProjectMatrix
  onPromote(t: Target): void
  onAbort(t: Target): void
}) {
  const cells = matrix.rows.map((r) => r.cells.find((c) => c.env === env.name)!).filter(Boolean)
  const group = matrix.groups.get(env.name.toLowerCase())
  const deployed = cells.filter((c) => c.argoApp || c.version)
  const unhealthy = cells.filter((c) => c.health === 'Degraded' || c.health === 'Missing').length
  const drifted = cells.filter((c) => c.driftFrom).length
  // The shared stage's verification is ONE run with per-app metrics: each
  // app's verdict comes out of it, and any app failing fails the environment.
  const run = useAnalysisRun(group?.shared?.verification?.analysisRun)
  const failedRun = group?.shared?.verification && ['Failed', 'Error', 'Inconclusive'].includes(group.shared.verification.phase)
  const stageLine = group?.shared
    ? `stage ${group.shared.name} · shared by ${Math.max(group.shared.origins?.length ?? 0, Object.keys(group.shared.freightByOrigin ?? {}).length)} apps`
    : group && Object.keys(group.perApp).length
      ? `${Object.keys(group.perApp).length} per-app ${Object.keys(group.perApp).length === 1 ? 'stage' : 'stages'}`
      : 'no Kargo stage'

  return (
    <div className='flex min-w-0 flex-col rounded-xl border border-edge-default bg-surface-raised shadow-sm'>
      <div className='border-b border-edge-subtle px-3.5 py-3'>
        <div className='flex items-start justify-between gap-2'>
          <div className='min-w-0'>
            <div className='flex items-center gap-1.5'>
              <span className='inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[9px] font-bold text-content-muted ring-1 ring-edge-default'>{step}</span>
              <span className='truncate text-[14px] font-semibold text-content'>{matrix.project} · {envTitle(env.name)}</span>
            </div>
            <div className='mt-0.5 truncate font-mono text-[10px] text-content-subtle' title={`namespace ${env.namespace}`}>ns {env.namespace}</div>
          </div>
          <StatusBadge kind={unhealthy ? 'degraded' : deployed.length ? 'healthy' : 'unknown'} className='shrink-0 px-1.5 py-0 text-[10px]'>
            {unhealthy ? `${unhealthy} unhealthy` : `${deployed.length}/${cells.length} deployed`}
          </StatusBadge>
        </div>
        <div className='mt-1.5 flex flex-wrap items-center gap-1'>
          <span className='text-[10px] text-content-subtle'>{stageLine}</span>
          {group?.shared?.verification ? (
            <span className={cn('text-[10px]', failedRun ? 'text-rose-700 dark:text-rose-300' : 'text-content-subtle')}>· verification {group.shared.verification.phase.toLowerCase()}</span>
          ) : null}
          {drifted ? <span className='rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>{drifted} behind</span> : null}
        </div>
        {failedRun ? (
          <p className='mt-1.5 text-[10px] leading-relaxed text-rose-700 dark:text-rose-300'>
            One failing application blocks verification for the whole environment
            {(() => {
              const blockers = run.data ? [...new Set(cells.flatMap((c) => kargo.appVerification(run.data!, c.app)?.blockedBy ?? []))] : []
              return blockers.length ? ` — failing: ${blockers.join(', ')}` : ''
            })()}.
          </p>
        ) : null}
        {env.guardrails.length ? (
          <div className='mt-1.5 flex flex-wrap gap-1'>
            {env.guardrails.map((g) => (
              <span key={g} className='rounded border border-edge-subtle bg-surface-sunken/60 px-1.5 py-px text-[10px] text-content-muted'>{g}</span>
            ))}
          </div>
        ) : null}
      </div>
      {cells.length === 0 ? (
        <p className='px-3.5 py-4 text-[12px] text-content-muted'>No applications in this project yet.</p>
      ) : (
        <ul className='divide-y divide-edge-subtle'>
          {cells.map((c) => (
            <AppRow
              key={c.app}
              cell={c}
              verification={c.stage?.shape === 'shared' && run.data ? kargo.appVerification(run.data, c.app) : undefined}
              onPromote={onPromote}
              onAbort={onAbort}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function AppRow({ cell: c, verification, onPromote, onAbort }: { cell: kargo.MatrixCell; verification?: kargo.AppVerification; onPromote(t: Target): void; onAbort(t: Target): void }) {
  const view = c.stage
  const hk = healthKind(c.health)
  return (
    <li className='min-w-0 px-3.5 py-2.5'>
      <div className='flex min-w-0 items-start justify-between gap-2'>
        <div className='min-w-0'>
          <div className='flex min-w-0 items-center gap-1.5'>
            <span className={cn('size-2 shrink-0 rounded-full', c.argoApp ? DOT[hk] : 'bg-edge-strong')} aria-hidden />
            <span className='truncate text-[13px] font-medium text-content' title={c.argoApp}>{c.app}</span>
          </div>
          <div className='mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 pl-3.5 text-[11px]'>
            {c.version ? (
              <span className='truncate font-mono text-content' title={[c.version.freight && `freight ${c.version.freight}`, c.version.tag && `tag ${c.version.tag}`, c.version.commit && `commit ${c.version.commit}`].filter(Boolean).join('\n')}>
                {c.version.label}
              </span>
            ) : (
              <span className='text-content-subtle'>{c.argoApp ? 'no version yet' : 'not deployed'}</span>
            )}
            {c.version?.tag && c.version.tag !== c.version.label ? <span className='truncate font-mono text-content-subtle'>{c.version.tag}</span> : null}
            {verification && verification.metrics.length ? (
              <span
                className={cn('text-[10px]', ['Failed', 'Error', 'Inconclusive'].includes(verification.phase) ? 'text-rose-700 dark:text-rose-300' : verification.phase === 'Successful' ? 'text-emerald-700 dark:text-emerald-300' : 'text-content-subtle')}
                title={verification.metrics.map((m) => `${m.name}: ${m.phase}${m.message ? ` — ${m.message}` : ''}`).join('\n')}
              >
                verify {verification.phase.toLowerCase()}
              </span>
            ) : null}
            {c.driftFrom ? (
              <span className='rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' title={`Runs something different from ${c.driftFrom}`}>
                ≠ {c.driftFrom}
              </span>
            ) : null}
          </div>
        </div>
        <div className='flex shrink-0 flex-col items-end gap-1'>
          {c.argoApp ? <StatusBadge kind={hk} dot={false} className='px-1.5 py-0 text-[10px]'>{c.health}</StatusBadge> : null}
          {c.sync && c.sync !== 'Synced' ? <StatusBadge kind='paused' dot={false} className='px-1.5 py-0 text-[10px]'>{c.sync}</StatusBadge> : null}
        </div>
      </div>
      <div className='mt-1 flex min-w-0 items-center justify-between gap-2 pl-3.5'>
        <span className='min-w-0 truncate text-[11px] text-content-muted' title={c.lastPromotion?.message}>
          {view?.promotion
            ? <span className='text-indigo-700 dark:text-indigo-300'>promoting · {view.promotion}</span>
            : c.lastPromotion
              ? <>promoted {formatRelative(c.lastPromotion.at)}{c.lastPromotion.phase !== 'Succeeded' ? <span className='text-rose-700 dark:text-rose-300'> · {c.lastPromotion.phase.toLowerCase()}</span> : null}</>
              : view ? 'never promoted' : 'no Kargo stage'}
        </span>
        {view ? (
          view.promotion ? (
            <Button size='xs' variant='danger' onClick={() => onAbort({ cell: c, view })}>Abort</Button>
          ) : (
            <Button
              size='xs'
              variant='secondary'
              disabled={view.busyWithOther}
              title={view.busyWithOther ? `Another application's promotion is running in ${view.stage.name}` : `Promote ${c.app} in ${c.env}`}
              onClick={() => onPromote({ cell: c, view })}
            >
              Promote…
            </Button>
          )
        ) : null}
      </div>
      {c.authProblem ? <p className='mt-1 break-words rounded-md bg-rose-50 px-2 py-1 pl-3.5 text-[10px] leading-relaxed text-rose-800 dark:bg-rose-500/10 dark:text-rose-200'>{c.authProblem}</p> : null}
    </li>
  )
}

/* ─────────── versions across environments ─────────── */

function VersionsMatrix({ matrix: m, onPromote }: { matrix: kargo.ProjectMatrix; onPromote(t: Target): void }) {
  const drifting = m.rows.filter((r) => r.drifted.length).length
  return (
    <div className='rounded-xl border border-edge-default bg-surface-raised shadow-sm'>
      <div className='flex flex-wrap items-baseline justify-between gap-2 border-b border-edge-subtle px-3.5 py-2'>
        <span className='text-[12px] font-semibold text-content'>Versions across environments</span>
        <span className='text-[11px] text-content-subtle'>
          {drifting ? `${drifting} of ${m.rows.length} ${m.rows.length === 1 ? 'application differs' : 'applications differ'} between environments` : 'every application runs the same version everywhere'}
        </span>
      </div>
      {m.rows.length === 0 ? (
        <p className='px-3.5 py-4 text-[12px] text-content-muted'>No applications in this project yet.</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[32rem] border-collapse text-[12px]'>
            <thead>
              <tr className='text-left text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
                <th className='px-3.5 py-2 font-semibold'>Application</th>
                {m.envs.map((e) => <th key={e.name} className='px-3 py-2 font-semibold'>{e.name}</th>)}
              </tr>
            </thead>
            <tbody className='divide-y divide-edge-subtle'>
              {m.rows.map((r) => (
                <tr key={r.app}>
                  <td className='px-3.5 py-2 font-medium text-content'>
                    {r.app}
                    {r.drifted.length ? <span className='ml-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-300'>drift</span> : null}
                  </td>
                  {r.cells.map((c) => {
                    const view = c.stage
                    const clickable = Boolean(view && !view.promotion && !view.busyWithOther)
                    return (
                      <td key={c.env} className='px-1.5 py-1'>
                        <button
                          type='button'
                          disabled={!clickable}
                          onClick={() => view && onPromote({ cell: c, view })}
                          title={[c.argoApp, c.version?.freight && `freight ${c.version.freight}`, c.driftFrom && `differs from ${c.driftFrom}`, clickable ? 'Click to promote' : ''].filter(Boolean).join('\n') || undefined}
                          className={cn(
                            'flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors',
                            c.driftFrom ? 'bg-amber-50 ring-1 ring-inset ring-amber-300/70 dark:bg-amber-500/10 dark:ring-amber-500/30' : '',
                            clickable ? 'hover:bg-surface-sunken' : 'cursor-default',
                          )}
                        >
                          <span className={cn('size-1.5 shrink-0 rounded-full', c.argoApp ? DOT[healthKind(c.health)] : 'bg-edge-strong')} aria-hidden />
                          <span className={cn('truncate font-mono', c.version ? 'text-content' : 'text-content-subtle')}>{c.version?.label ?? '—'}</span>
                          {view?.promotion ? <span className='shrink-0 text-[10px] text-indigo-700 dark:text-indigo-300'>promoting</span> : null}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ─────────── actions ─────────── */

function actionError(what: string, e: unknown): string {
  const status = (e as { status?: number } | undefined)?.status
  if (status === 403) return `${what}: not allowed — this needs write access to Kargo in the project.`
  return `${what} failed: ${e instanceof Error ? e.message : String(e)}`
}

function PromoteAppDialog({ target, freight, onClose }: { target: Target; freight: readonly kargo.Freight[]; onClose(): void }) {
  const { cell, view } = target
  const candidates = useMemo(() => kargo.promotableFreightForApp(view, freight), [view, freight])
  const [choice, setChoice] = useState('')
  const promote = usePromote()
  const toast = useToast()
  const selected = choice || candidates[0]?.id || ''
  const pick = candidates.find((f) => f.id === selected)
  const go = async () => {
    if (!selected) return
    try {
      await promote.mutateAsync({ stage: view.stage.name, freight: selected, project: view.stage.project })
      toast.success(`Promoting ${cell.app} in ${cell.env}`)
      onClose()
    } catch (e) {
      toast.error(actionError(`Promote ${cell.app}`, e))
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Promote ${cell.app} in ${cell.env}`}
      footer={
        <div className='flex justify-end gap-2'>
          <Button variant='ghost' onClick={onClose}>Cancel</Button>
          <Button variant='primary' onClick={() => void go()} disabled={!selected} loading={promote.isPending}>Promote {cell.app}</Button>
        </div>
      }
    >
      <div className='space-y-3 text-xs leading-relaxed text-content-muted'>
        <p>
          Creates a Kargo <code className='font-mono'>Promotion</code> of <span className='font-medium text-content'>{cell.app}</span>'s freight into stage{' '}
          <span className='font-mono text-content'>{view.stage.project}/{view.stage.name}</span>.
          {view.shape === 'shared' ? ' The stage is shared by the project — only this application changes; the others keep what they run.' : ''}
        </p>
        <div className='rounded-lg border border-edge-subtle bg-surface-sunken/50 px-3 py-2'>
          <span className='text-content-subtle'>Running now: </span>
          <span className='font-mono text-content'>{cell.version?.label ?? 'nothing yet'}</span>
        </div>
        {candidates.length ? (
          <Field label='Freight' hint={view.stage.upstream?.length ? `verified in ${view.stage.upstream.join(', ')}` : 'discovered by the warehouse'}>
            <Select value={selected} onChange={(e) => setChoice(e.currentTarget.value)}>
              {candidates.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.alias ?? f.id.slice(0, 12)}
                  {f.images[0]?.tag ? ` — ${f.images[0].tag}` : f.commits?.[0]?.id ? ` — ${f.commits[0].id.slice(0, 7)}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className='rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
            No {cell.app} freight is eligible for {view.stage.name} yet.
            {view.stage.upstream?.length ? ` It accepts only what ${view.stage.upstream.join(', ')} has verified.` : ' The warehouse has not discovered an image yet.'}
          </div>
        )}
        {pick ? <p className='text-[11px] text-content-subtle'>{pick.images.map((i) => `${i.repoURL}:${i.tag}`).join(', ') || pick.id}</p> : null}
      </div>
    </Modal>
  )
}

function AbortDialog({ target, onClose }: { target: Target; onClose(): void }) {
  const { cell, view } = target
  const abort = useAbortPromotion()
  const toast = useToast()
  const go = async () => {
    if (!view.promotion) return
    try {
      await abort.mutateAsync({ promotion: view.promotion, project: view.stage.project })
      toast.success(`Abort requested for ${cell.app} in ${cell.env}`)
      onClose()
    } catch (e) {
      toast.error(actionError(`Abort ${view.promotion}`, e))
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Abort ${cell.app}'s promotion?`}
      footer={
        <div className='flex justify-end gap-2'>
          <Button variant='ghost' onClick={onClose}>Keep it running</Button>
          <Button variant='danger' onClick={() => void go()} loading={abort.isPending}>Abort promotion</Button>
        </div>
      }
    >
      <p className='text-xs leading-relaxed text-content-muted'>
        Stops <span className='font-mono text-content'>{view.promotion}</span> promoting {cell.app} into{' '}
        <span className='font-mono text-content'>{view.stage.project}/{view.stage.name}</span>. {cell.env} keeps running {cell.version?.label ?? 'what it has'}.
      </p>
    </Modal>
  )
}
