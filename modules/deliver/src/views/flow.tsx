import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { argocd, argoRollouts } from '@adhar-console/api-clients'
import {
  useApplications,
  useFreight,
  useRollouts,
  useStages,
} from '../data/delivery.ts'
import {
  duration,
  isNotInstalled,
  newestFirst,
  useCoderWorkspaces,
  useGiteaCommits,
  useGiteaPulls,
  useGiteaRepos,
  useKpackBuilds,
  useTektonRuns,
  type CRDObject,
} from '../data/flow.ts'
import { age } from '../data/format.ts'

/**
 * Delivery flow — the Deliver phase's marquee value-stream view.
 *
 * Visualises a single service's in-flight change as it travels the delivery
 * lifecycle left → right:
 *
 *   Code → Pull Request → Build → Dev loop → Preview env → Promotion →
 *   GitOps sync → Rollout
 *
 * Every node reflects REAL status pulled from that stage's backing tool
 * (Gitea, Tekton/kpack, Coder, ArgoCD, Kargo, Argo Rollouts). Nothing is
 * fabricated: a stage whose tool isn't reachable/installed, or that has no
 * data yet, renders a muted, honest node — never a fake green.
 */

/* ─────────── stage model ─────────── */

type StageState = 'ok' | 'empty' | 'error' | 'notConfigured' | 'loading'

interface StageModel {
  id: string
  title: string
  icon: ReactNode
  /** Node accent colour. */
  kind: StatusKind
  /** Short status word rendered in the node badge. */
  status: string
  /** One-line real detail under the title. */
  detail: string
  state: StageState
  /** Drives the colour of the edge leaving this stage. */
  positive: boolean
  /** Drill-in panel body. */
  render(): ReactNode
  /** Optional deep-link to the matching full Deliver view. */
  link?: { label: string; href: string }
}

const positiveKind = (k: StatusKind) => k === 'healthy' || k === 'progressing'

/* ─────────── Tekton / kpack status helpers ─────────── */

interface Condition {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

function tektonSucceeded(o: CRDObject): Condition | undefined {
  const conds = ((o.status?.conditions as Condition[] | undefined) ?? []).filter(
    (c) => c.type === 'Succeeded',
  )
  return conds.sort(
    (a, b) =>
      new Date(b.lastTransitionTime ?? 0).getTime() -
      new Date(a.lastTransitionTime ?? 0).getTime(),
  )[0]
}

function condKind(c?: Condition): StatusKind {
  if (!c) return 'unknown'
  if (c.status === 'True') return 'healthy'
  if (c.status === 'False') return 'failed'
  return 'progressing'
}
function condLabel(c?: Condition): string {
  if (!c) return 'Unknown'
  if (c.reason) return c.reason
  return c.status === 'True' ? 'Succeeded' : c.status === 'False' ? 'Failed' : 'Running'
}

/* ─────────── root view ─────────── */

export function DeliveryFlow() {
  const apps = useApplications()
  const [selectedApp, setSelectedApp] = useState<string | null>(null)
  const [openStage, setOpenStage] = useState<string | null>(null)

  const appList = apps.data ?? []
  const app =
    appList.find((a) => a.metadata.name === selectedApp) ?? appList[0] ?? null
  const namespace = app?.spec.destination.namespace

  // Gitea source repo for the service — matched by name (honest miss otherwise).
  const repos = useGiteaRepos()
  const repo = useMemo(
    () => (app ? repos.data?.find((r) => r.name === app.metadata.name) : undefined),
    [repos.data, app],
  )
  const branch = repo?.default_branch

  const commits = useGiteaCommits(repo?.name, branch)
  const pulls = useGiteaPulls(repo?.name, 'all')
  const tekton = useTektonRuns(namespace)
  const kpack = useKpackBuilds(namespace)
  const workspaces = useCoderWorkspaces()
  const stages = useStages()
  const freight = useFreight()
  const rollouts = useRollouts()

  if (apps.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading applications…
      </div>
    )
  }
  if (apps.isError) {
    return (
      <EmptyState
        title="Couldn't reach ArgoCD"
        description={
          apps.error instanceof Error ? apps.error.message : 'Unknown error listing applications.'
        }
      />
    )
  }
  if (!app) {
    return (
      <EmptyState
        title="No applications"
        description="The delivery flow follows an ArgoCD Application. None are registered in this project yet."
      />
    )
  }

  // Preview/PR environments surface as sibling ArgoCD Applications named after
  // the service + a pr/preview marker. Honest empty when none exist.
  const appName = app.metadata.name
  const previewApps = appList.filter(
    (x) =>
      x.metadata.name !== appName &&
      x.metadata.name.includes(appName) &&
      /(^|[-/])(pr|preview)([-/]|\d|$)/i.test(x.metadata.name),
  )

  const model = buildStages({
    appName,
    namespace,
    app,
    repoName: repo?.name,
    repoConnected: !!repo,
    reposError: repos.isError,
    reposLoading: repos.isLoading,
    previewApps,
    commits,
    pulls,
    tekton,
    kpack,
    workspaces,
    stages,
    freight,
    rollouts,
  })

  const open = model.find((s) => s.id === openStage) ?? null
  const anyRefetching =
    commits.isFetching || tekton.isFetching || stages.isFetching || rollouts.isFetching

  return (
    <div className="space-y-5">
      {/* ── controls ── */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-content-muted">
          <span className="font-medium text-content-subtle">Service</span>
          <select
            value={app.metadata.name}
            onChange={(e) => {
              setSelectedApp(e.target.value)
              setOpenStage(null)
            }}
            className="h-9 rounded-lg border border-edge-default bg-surface-raised px-2 text-sm text-content outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20"
          >
            {appList.map((a) => (
              <option key={a.metadata.name} value={a.metadata.name}>
                {a.metadata.name} · {a.spec.destination.namespace}
              </option>
            ))}
          </select>
        </label>
        <div className="text-[11px] text-content-subtle">
          {repo ? (
            <>
              repo <code className="font-mono text-content-muted">{repo.full_name}</code>
              {branch ? (
                <>
                  {' '}@ <code className="font-mono text-content-muted">{branch}</code>
                </>
              ) : null}
            </>
          ) : (
            <span>no matching Gitea repo</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {anyRefetching ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-content-subtle">
              <Spinner size={12} /> refreshing
            </span>
          ) : null}
          <Legend />
        </div>
      </div>

      {/* ── the value stream ── */}
      <Card>
        <CardBody className="p-0!">
          <div className="overflow-x-auto p-5">
            <div className="flex min-w-max items-stretch">
              {model.map((s, i) => (
                <div key={s.id} className="flex items-stretch">
                  <StageNode
                    stage={s}
                    active={openStage === s.id}
                    onOpen={() => setOpenStage((cur) => (cur === s.id ? null : s.id))}
                  />
                  {i < model.length - 1 ? <FlowEdge lit={s.positive} /> : null}
                </div>
              ))}
            </div>
          </div>
        </CardBody>
      </Card>

      {open ? <StageDrawer stage={open} onClose={() => setOpenStage(null)} /> : null}
    </div>
  )
}

/* ─────────── stage assembly ─────────── */

interface BuildArgs {
  appName: string
  namespace?: string
  app: argocd.Application
  repoName?: string
  repoConnected: boolean
  reposError: boolean
  reposLoading: boolean
  /** ArgoCD Applications that are PR/preview environments for this service. */
  previewApps: argocd.Application[]
  commits: ReturnType<typeof useGiteaCommits>
  pulls: ReturnType<typeof useGiteaPulls>
  tekton: ReturnType<typeof useTektonRuns>
  kpack: ReturnType<typeof useKpackBuilds>
  workspaces: ReturnType<typeof useCoderWorkspaces>
  stages: ReturnType<typeof useStages>
  freight: ReturnType<typeof useFreight>
  rollouts: ReturnType<typeof useRollouts>
}

function buildStages(a: BuildArgs): StageModel[] {
  return [
    codeStage(a),
    pullRequestStage(a),
    buildStage(a),
    devLoopStage(a),
    previewStage(a),
    promotionStage(a),
    gitopsStage(a),
    rolloutStage(a),
  ]
}

/* ── 1. Code ── */
function codeStage(a: BuildArgs): StageModel {
  const { commits, repoConnected, reposError, reposLoading } = a
  const latest = (commits.data ?? [])[0]
  let kind: StatusKind = 'unknown'
  let status = 'No repo'
  let detail = 'No matching Gitea repository'
  let state: StageState = 'empty'

  if (reposError || commits.isError) {
    kind = 'degraded'
    status = 'Error'
    detail = 'Gitea not reachable'
    state = 'error'
  } else if (reposLoading || (repoConnected && commits.isLoading)) {
    status = 'Loading'
    detail = 'Loading commits…'
    state = 'loading'
  } else if (!repoConnected) {
    state = 'empty'
  } else if (latest) {
    kind = 'healthy'
    status = latest.short_sha
    detail = latest.message.split('\n')[0]
    state = 'ok'
  } else {
    status = 'No commits'
    detail = 'Repository has no commits'
  }

  return {
    id: 'code',
    title: 'Code',
    icon: <IconCode />,
    kind,
    status,
    detail,
    state,
    positive: !!latest,
    link: a.repoName ? { label: 'Open in Develop', href: '/develop?section=commits' } : undefined,
    render: () => (
      <div className="space-y-4">
        {commits.isError ? (
          <EmptyState title="Couldn't reach Gitea" description={errText(commits.error)} />
        ) : !repoConnected ? (
          <EmptyState
            title="No matching repository"
            description={`No Gitea repo named "${a.appName}" was found in the org. The Code stage follows the service's source repository.`}
          />
        ) : (commits.data ?? []).length === 0 ? (
          <EmptyState title="No commits" />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {(commits.data ?? []).map((c) => (
              <li key={c.sha} className="py-2.5">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">
                    {c.short_sha}
                  </code>
                  <span className="truncate text-[13px] text-content">
                    {c.message.split('\n')[0]}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-content-subtle">
                  {c.author.login} · {formatRelative(c.created)}
                  {c.stats ? ` · +${c.stats.additions} −${c.stats.deletions}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
  }
}

/* ── 2. Pull Request ── */
function pullRequestStage(a: BuildArgs): StageModel {
  const { pulls, repoConnected } = a
  const all = pulls.data ?? []
  const openPrs = all.filter((p) => p.state === 'open')
  const merged = all.filter((p) => p.merged)
  const latest = [...all].sort(
    (x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime(),
  )[0]

  let kind: StatusKind = 'unknown'
  let status = 'None'
  let detail = 'No pull requests'
  let state: StageState = 'empty'
  let positive = false

  if (pulls.isError) {
    kind = 'degraded'
    status = 'Error'
    detail = 'Gitea not reachable'
    state = 'error'
  } else if (!repoConnected) {
    detail = 'No matching Gitea repository'
  } else if (pulls.isLoading) {
    status = 'Loading'
    detail = 'Loading pull requests…'
    state = 'loading'
  } else if (latest) {
    state = 'ok'
    positive = true
    if (latest.state === 'open') {
      kind = 'progressing'
      status = `#${latest.number} open`
    } else if (latest.merged) {
      kind = 'healthy'
      status = `#${latest.number} merged`
    } else {
      kind = 'unknown'
      status = `#${latest.number} closed`
    }
    detail = `${openPrs.length} open · ${merged.length} merged`
  }

  return {
    id: 'pr',
    title: 'Pull Request',
    icon: <IconPr />,
    kind,
    status,
    detail,
    state,
    positive,
    link: repoConnected ? { label: 'Open in Develop', href: '/develop?section=prs' } : undefined,
    render: () => (
      <div className="space-y-4">
        {pulls.isError ? (
          <EmptyState title="Couldn't reach Gitea" description={errText(pulls.error)} />
        ) : all.length === 0 ? (
          <EmptyState title="No pull requests" />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {all.map((p) => (
              <li key={p.id} className="py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] text-content">
                    <span className="font-mono text-content-subtle">#{p.number}</span> {p.title}
                  </span>
                  <StatusBadge
                    kind={p.state === 'open' ? 'progressing' : p.merged ? 'healthy' : 'unknown'}
                  >
                    {p.state === 'open' ? 'open' : p.merged ? 'merged' : 'closed'}
                  </StatusBadge>
                </div>
                <div className="mt-1 text-[11px] text-content-subtle">
                  {p.user.login} · {p.head?.ref ?? '—'} → {p.base?.ref ?? '—'} ·{' '}
                  {formatRelative(p.created_at)}
                  {typeof p.review_comments === 'number'
                    ? ` · ${p.review_comments} review comments`
                    : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
  }
}

/* ── 3. Build ── */
function buildStage(a: BuildArgs): StageModel {
  const { tekton, kpack, namespace } = a
  const tektonMissing = tekton.isError && isNotInstalled(tekton.error)
  const kpackMissing = kpack.isError && isNotInstalled(kpack.error)

  const tektonRuns = [...(tekton.data ?? [])].sort(newestFirst)
  const kpackRuns = [...(kpack.data ?? [])].sort(newestFirst)
  const usingKpack = tektonRuns.length === 0 && kpackRuns.length > 0
  const runs = usingKpack ? kpackRuns : tektonRuns
  const latest = runs[0]
  const tool = usingKpack ? 'kpack Build' : 'Tekton PipelineRun'

  let kind: StatusKind = 'unknown'
  let status = 'No build'
  let detail = namespace ? `No builds in ${namespace}` : 'No namespace'
  let state: StageState = 'empty'
  let positive = false

  if (tektonMissing && (kpackMissing || kpack.data === undefined)) {
    // Neither CI CRD is installed on this cluster — honest "not configured".
    kind = 'unknown'
    status = 'Not configured'
    detail = 'Tekton / kpack not installed'
    state = 'notConfigured'
  } else if (tekton.isError && !tektonMissing && kpackRuns.length === 0) {
    kind = 'degraded'
    status = 'Error'
    detail = errText(tekton.error)
    state = 'error'
  } else if (tekton.isLoading && kpack.isLoading) {
    status = 'Loading'
    detail = 'Loading builds…'
    state = 'loading'
  } else if (latest) {
    state = 'ok'
    const c = tektonSucceeded(latest)
    kind = condKind(c)
    status = condLabel(c)
    positive = kind === 'healthy'
    detail = `${tool} · ${duration(
      (latest.status?.startTime as string) ?? latest.metadata?.creationTimestamp,
      (latest.status?.completionTime as string) ?? undefined,
    )}`
  }

  return {
    id: 'build',
    title: 'Build',
    icon: <IconBuild />,
    kind,
    status,
    detail,
    state,
    positive,
    link: { label: 'CI runs (Platform)', href: '/platform?section=ci' },
    render: () => (
      <div className="space-y-4">
        {state === 'notConfigured' ? (
          <EmptyState
            title="No CI backend installed"
            description="Neither Tekton (tekton.dev/v1 PipelineRuns) nor kpack (kpack.io/v1alpha2 Builds) is registered on this cluster. Install one to see the Build stage."
          />
        ) : runs.length === 0 ? (
          <EmptyState
            title="No builds"
            description={`No ${tool}s found in ${namespace ?? 'the service namespace'} yet.`}
          />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {runs.slice(0, 8).map((r) => {
              const c = tektonSucceeded(r)
              return (
                <li key={r.metadata?.uid ?? r.metadata?.name} className="py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[12px] text-content">
                      {r.metadata?.name}
                    </span>
                    <StatusBadge kind={condKind(c)}>{condLabel(c)}</StatusBadge>
                  </div>
                  <div className="mt-1 text-[11px] text-content-subtle">
                    started {age((r.status?.startTime as string) ?? r.metadata?.creationTimestamp)} ·{' '}
                    {duration(
                      (r.status?.startTime as string) ?? r.metadata?.creationTimestamp,
                      (r.status?.completionTime as string) ?? undefined,
                    )}
                    {c?.message ? ` · ${c.message}` : ''}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    ),
  }
}

/* ── 4. Dev loop ── */
function devLoopStage(a: BuildArgs): StageModel {
  const { workspaces, appName } = a
  const all = workspaces.data ?? []
  // Match workspaces to the service by name/template substring — honest miss otherwise.
  const mine = all.filter(
    (w) =>
      w.name.includes(appName) ||
      w.template_name.includes(appName) ||
      appName.includes(w.template_name),
  )
  const list = mine.length ? mine : []
  const running = list.filter((w) => w.latest_build.status === 'running')

  let kind: StatusKind = 'unknown'
  let status = 'None'
  let detail = 'No Coder workspace for this service'
  let state: StageState = 'empty'
  let positive = false

  if (workspaces.isError) {
    kind = 'unknown'
    status = 'Not configured'
    detail = 'Coder not reachable'
    state = 'notConfigured'
  } else if (workspaces.isLoading) {
    status = 'Loading'
    detail = 'Loading workspaces…'
    state = 'loading'
  } else if (list.length) {
    state = 'ok'
    positive = running.length > 0
    kind = running.length ? 'healthy' : 'paused'
    status = running.length ? `${running.length} running` : list[0].latest_build.status
    detail = `${list.length} workspace${list.length === 1 ? '' : 's'}`
  }

  return {
    id: 'devloop',
    title: 'Dev loop',
    icon: <IconDev />,
    kind,
    status,
    detail,
    state,
    positive,
    link: { label: 'Cloud Envs (Develop)', href: '/develop?section=environments' },
    render: () => (
      <div className="space-y-4">
        {workspaces.isError ? (
          <EmptyState
            title="Coder not reachable"
            description="Couldn't list Coder workspaces. The Dev loop stage is optional — a service can ship without one."
          />
        ) : list.length === 0 ? (
          <EmptyState
            title="No Coder workspace"
            description={`No Coder workspace matches "${appName}". Developers can spin one up from Develop → Cloud Envs.`}
          />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {list.map((w) => (
              <li key={w.id} className="py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] text-content">{w.name}</span>
                  <StatusBadge kind={coderKind(w.latest_build.status)}>
                    {w.latest_build.status}
                  </StatusBadge>
                </div>
                <div className="mt-1 text-[11px] text-content-subtle">
                  {w.template_name} · owner {w.owner_name}
                  {w.last_used_at ? ` · used ${formatRelative(w.last_used_at)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
  }
}

/* ── 5. Preview environment ── */
function previewStage(a: BuildArgs): StageModel {
  const { appName } = a
  // A preview/PR env surfaces as an ArgoCD Application named for the PR.
  const previews = a.previewApps

  let kind: StatusKind = 'unknown'
  let status = 'None'
  let detail = 'No preview environment'
  let state: StageState = 'empty'
  let positive = false

  if (previews.length) {
    state = 'ok'
    positive = true
    const degraded = previews.find((p) => p.status.health.status === 'Degraded')
    kind = degraded ? 'degraded' : 'healthy'
    status = `${previews.length} preview${previews.length === 1 ? '' : 's'}`
    detail = previews.map((p) => p.metadata.name).join(', ')
  }

  return {
    id: 'preview',
    title: 'Preview env',
    icon: <IconPreview />,
    kind,
    status,
    detail,
    state,
    positive,
    link: previews.length ? { label: 'ArgoCD Apps', href: '/deliver?section=apps' } : undefined,
    render: () => (
      <div className="space-y-4">
        {previews.length === 0 ? (
          <EmptyState
            title="No preview environment"
            description={`No ArgoCD Application is labelled as a PR/preview environment for ${appName}. Ephemeral preview envs appear here when a PR spins one up.`}
          />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {previews.map((p) => (
              <li key={p.metadata.name} className="py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] text-content">{p.metadata.name}</span>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge kind={p.status.sync.status === 'Synced' ? 'healthy' : 'degraded'}>
                      {p.status.sync.status}
                    </StatusBadge>
                    <StatusBadge kind={p.status.health.status === 'Healthy' ? 'healthy' : 'degraded'}>
                      {p.status.health.status}
                    </StatusBadge>
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-content-subtle">
                  {p.spec.destination.namespace}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
  }
}

/* ── 6. Promotion ── */
function promotionStage(a: BuildArgs): StageModel {
  const { stages, freight } = a
  const stageList = stages.data ?? []
  const freightList = freight.data ?? []

  let kind: StatusKind = 'unknown'
  let status = 'None'
  let detail = 'No Kargo stages'
  let state: StageState = 'empty'
  let positive = false

  if (stages.isError) {
    kind = 'unknown'
    status = 'Not configured'
    detail = 'Kargo not reachable'
    state = 'notConfigured'
  } else if (stages.isLoading) {
    status = 'Loading'
    detail = 'Loading stages…'
    state = 'loading'
  } else if (stageList.length) {
    state = 'ok'
    const failed = stageList.some((s) => s.phase === 'Failed')
    const promoting = stageList.some((s) => s.phase === 'Promoting' || s.phase === 'Verifying')
    kind = failed ? 'failed' : promoting ? 'progressing' : 'healthy'
    positive = !failed
    status = failed ? 'Failed' : promoting ? 'Promoting' : 'Steady'
    detail = stageList.map((s) => s.name).join(' → ')
  }

  return {
    id: 'promotion',
    title: 'Promotion',
    icon: <IconPromote />,
    kind,
    status,
    detail,
    state,
    positive,
    link: stageList.length ? { label: 'Kargo Stages', href: '/deliver?section=stages' } : undefined,
    render: () => (
      <div className="space-y-4">
        {stages.isError ? (
          <EmptyState title="Kargo not reachable" description={errText(stages.error)} />
        ) : stageList.length === 0 ? (
          <EmptyState title="No Kargo stages" />
        ) : (
          <div className="space-y-3">
            {stageList.map((s) => {
              const cur = freightList.find((f) => f.id === s.currentFreight)
              return (
                <div
                  key={s.name}
                  className="rounded-lg border border-edge-subtle bg-surface-raised p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-content">{s.name}</span>
                    <StatusBadge kind={phaseKind(s.phase)}>{s.phase}</StatusBadge>
                  </div>
                  <div className="mt-1 text-[11px] text-content-subtle">
                    freight{' '}
                    <code className="font-mono text-content-muted">{s.currentFreight ?? '—'}</code>
                    {s.lastPromoted ? ` · promoted ${formatRelative(s.lastPromoted)}` : ''}
                  </div>
                  {cur?.images.length ? (
                    <div className="mt-1 space-y-0.5 font-mono text-[11px] text-content-muted">
                      {cur.images.map((img, i) => (
                        <div key={i} className="truncate">
                          {img.repoURL.replace(/^https?:\/\//, '')}:
                          <span className="text-content">{img.tag}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    ),
  }
}

/* ── 7. GitOps sync ── */
function gitopsStage(a: BuildArgs): StageModel {
  const { app } = a
  const sync = app.status.sync.status
  const health = app.status.health.status
  const kind: StatusKind =
    health === 'Degraded'
      ? 'degraded'
      : sync === 'OutOfSync'
        ? 'progressing'
        : health === 'Healthy' && sync === 'Synced'
          ? 'healthy'
          : 'unknown'

  return {
    id: 'gitops',
    title: 'GitOps sync',
    icon: <IconSync />,
    kind,
    status: sync,
    detail: `${health}${app.status.sync.revision ? ` · ${app.status.sync.revision.slice(0, 10)}` : ''}`,
    state: 'ok',
    positive: sync === 'Synced' && health !== 'Degraded',
    link: { label: 'ArgoCD Apps', href: '/deliver?section=apps' },
    render: () => (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Tile label="Sync" value={sync} />
          <Tile label="Health" value={health} />
        </div>
        <Card>
          <CardHeader>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
              Source &amp; destination
            </div>
          </CardHeader>
          <CardBody className="space-y-1.5 text-[12px]">
            <Row label="Repo" value={app.spec.source.repoURL} mono />
            <Row label="Path" value={app.spec.source.path ?? '—'} mono />
            <Row label="Revision" value={app.spec.source.targetRevision ?? 'HEAD'} mono />
            {app.status.sync.revision ? (
              <Row label="Resolved" value={app.status.sync.revision} mono />
            ) : null}
            <Row label="Cluster" value={app.spec.destination.server} mono />
            <Row label="Namespace" value={app.spec.destination.namespace} mono />
          </CardBody>
        </Card>
        {app.status.health.message ? (
          <div className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">
            {app.status.health.message}
          </div>
        ) : null}
      </div>
    ),
  }
}

/* ── 8. Rollout ── */
function rolloutStage(a: BuildArgs): StageModel {
  const { rollouts, app, appName } = a
  const list = (rollouts.data ?? []) as argoRollouts.Rollout[]
  const ro = list.find(
    (r) =>
      r.metadata.name === appName && r.metadata.namespace === app.spec.destination.namespace,
  )

  let kind: StatusKind = 'unknown'
  let status = 'None'
  let detail = 'No Argo Rollout'
  let state: StageState = 'empty'
  let positive = false

  if (rollouts.isError) {
    kind = 'unknown'
    status = 'Not configured'
    detail = 'Argo Rollouts not reachable'
    state = 'notConfigured'
  } else if (rollouts.isLoading) {
    status = 'Loading'
    detail = 'Loading rollouts…'
    state = 'loading'
  } else if (ro) {
    state = 'ok'
    const phase = ro.status.phase ?? 'Unknown'
    kind = rolloutKind(phase)
    positive = phase === 'Healthy'
    status = phase
    const strat = ro.spec.strategy?.canary
      ? 'canary'
      : ro.spec.strategy?.blueGreen
        ? 'blue/green'
        : '—'
    const steps = (ro.spec.strategy?.canary?.steps ?? []) as Array<Record<string, unknown>>
    const cur = ro.status.currentStepIndex ?? 0
    detail = steps.length ? `${strat} · step ${Math.min(cur + 1, steps.length)}/${steps.length}` : strat
  }

  return {
    id: 'rollout',
    title: 'Rollout',
    icon: <IconRollout />,
    kind,
    status,
    detail,
    state,
    positive,
    link: ro ? { label: 'Rollouts', href: '/deliver?section=rollouts' } : undefined,
    render: () => (
      <div className="space-y-4">
        {rollouts.isError ? (
          <EmptyState title="Argo Rollouts not reachable" description={errText(rollouts.error)} />
        ) : !ro ? (
          <EmptyState
            title="No Argo Rollout"
            description={`No Rollout named "${appName}" in ${app.spec.destination.namespace}. The service may use a plain Deployment rather than progressive delivery.`}
          />
        ) : (
          <RolloutDetail ro={ro} />
        )}
      </div>
    ),
  }
}

function RolloutDetail({ ro }: { ro: argoRollouts.Rollout }) {
  const phase = ro.status.phase ?? 'Unknown'
  const isCanary = !!ro.spec.strategy?.canary
  const steps = (ro.spec.strategy?.canary?.steps ?? []) as Array<Record<string, unknown>>
  const cur = ro.status.currentStepIndex ?? 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Tile label="Phase" value={phase} />
        <Tile label="Strategy" value={isCanary ? 'canary' : ro.spec.strategy?.blueGreen ? 'blue/green' : '—'} />
      </div>
      {isCanary && steps.length ? (
        <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
          {steps.map((s, i) => {
            const cleared = i < cur
            const live = i === cur
            return (
              <li
                key={i}
                className={
                  live
                    ? 'flex flex-col rounded-md border border-brand-400 bg-brand-50/60 p-2 dark:bg-brand-500/10'
                    : cleared
                      ? 'flex flex-col rounded-md border border-emerald-200 bg-emerald-50/40 p-2 dark:border-emerald-500/25 dark:bg-emerald-500/10'
                      : 'flex flex-col rounded-md border border-edge-subtle bg-surface-sunken/40 p-2'
                }
              >
                <span className="text-[10px] font-mono text-content-subtle">step {i + 1}</span>
                <span className="text-[11px] font-medium text-content">{describeStep(s)}</span>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-3 text-[11px] text-content-muted">
          {isCanary ? 'Canary strategy has no steps configured.' : 'Blue/green — preview service awaiting cutover.'}
        </div>
      )}
      {ro.status.message ? (
        <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
          {ro.status.message}
        </div>
      ) : null}
    </div>
  )
}

function describeStep(s: Record<string, unknown>): string {
  if ('setWeight' in s) return `setWeight ${s.setWeight}%`
  if ('pause' in s) {
    const p = s.pause as { duration?: string } | null
    return p?.duration ? `pause ${p.duration}` : 'pause ∞'
  }
  if ('analysis' in s) return 'analysis'
  if ('experiment' in s) return 'experiment'
  if ('setCanaryScale' in s) return 'scale canary'
  return Object.keys(s)[0] ?? '—'
}

/* ─────────── flow visuals ─────────── */

const NODE_TONE: Record<StatusKind, string> = {
  healthy: 'border-emerald-300/70 dark:border-emerald-500/30',
  degraded: 'border-rose-300/70 dark:border-rose-500/30',
  failed: 'border-rose-400/70 dark:border-rose-500/40',
  progressing: 'border-indigo-300/70 dark:border-indigo-500/30',
  paused: 'border-amber-300/70 dark:border-amber-500/30',
  info: 'border-sky-300/70 dark:border-sky-500/30',
  unknown: 'border-edge-default',
}
const DOT_TONE: Record<StatusKind, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-rose-500',
  failed: 'bg-rose-600',
  progressing: 'bg-indigo-500',
  paused: 'bg-amber-500',
  info: 'bg-sky-500',
  unknown: 'bg-slate-400',
}

function StageNode({
  stage: s,
  active,
  onOpen,
}: {
  stage: StageModel
  active: boolean
  onOpen(): void
}) {
  const muted = s.state === 'empty' || s.state === 'notConfigured'
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={active}
      className={`flex w-[196px] shrink-0 flex-col rounded-xl border bg-surface-raised p-3 text-left shadow-sm transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-400/30 ${
        NODE_TONE[s.kind]
      } ${active ? 'ring-2 ring-brand-400/40' : ''} ${muted ? 'opacity-90' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-content-subtle`}
        >
          {s.icon}
        </span>
        <span className="text-[13px] font-semibold text-content">{s.title}</span>
        <span className={`ml-auto h-2 w-2 shrink-0 rounded-full ${DOT_TONE[s.kind]}`} aria-hidden />
      </div>
      <div className="mt-2">
        <StatusBadge kind={s.kind}>{s.status}</StatusBadge>
      </div>
      <p className="mt-2 line-clamp-2 min-h-[2.2em] text-[11px] leading-snug text-content-muted">
        {s.detail}
      </p>
    </button>
  )
}

/** SVG connector between two stage nodes; lit (emerald) when the change cleared the upstream stage. */
function FlowEdge({ lit }: { lit: boolean }) {
  return (
    <div className="flex w-10 shrink-0 items-center self-stretch" aria-hidden>
      <svg width="40" height="24" viewBox="0 0 40 24" fill="none" className="overflow-visible">
        <line
          x1="0"
          y1="12"
          x2="34"
          y2="12"
          stroke={lit ? 'var(--color-emerald-500, #10b981)' : 'var(--color-edge-strong, #cbd5e1)'}
          strokeWidth="2"
          strokeDasharray={lit ? undefined : '3 3'}
          strokeLinecap="round"
        />
        <path
          d="M30 6l6 6-6 6"
          stroke={lit ? 'var(--color-emerald-500, #10b981)' : 'var(--color-edge-strong, #cbd5e1)'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

function Legend() {
  const items: Array<{ kind: StatusKind; label: string }> = [
    { kind: 'healthy', label: 'Passed / healthy' },
    { kind: 'progressing', label: 'In progress' },
    { kind: 'degraded', label: 'Degraded' },
    { kind: 'failed', label: 'Failed' },
    { kind: 'unknown', label: 'None / not configured' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((i) => (
        <span key={i.kind} className="inline-flex items-center gap-1.5 text-[10px] text-content-subtle">
          <span className={`h-2 w-2 rounded-full ${DOT_TONE[i.kind]}`} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/* ─────────── drill-in drawer ─────────── */

function StageDrawer({ stage: s, onClose }: { stage: StageModel; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Delivery stage
            </div>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold tracking-tight text-content">
              {s.title}
              <StatusBadge kind={s.kind}>{s.status}</StatusBadge>
            </h2>
            <p className="mt-1 text-[12px] text-content-muted">{s.detail}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{s.render()}</div>
        {s.link ? (
          <footer className="border-t border-edge-default bg-surface-raised px-6 py-3">
            <a
              href={s.link.href}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
            >
              {s.link.label}
              <span aria-hidden>↗</span>
            </a>
          </footer>
        ) : null}
      </aside>
    </div>,
    document.body,
  )
}

/* ─────────── small shared bits ─────────── */

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className="text-base font-semibold tabular-nums text-content">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-content-subtle">{label}</span>
      <span className={`min-w-0 truncate ${mono ? 'font-mono' : ''} text-content`}>{value}</span>
    </div>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error.'
}

function phaseKind(phase: string): StatusKind {
  switch (phase) {
    case 'Steady':
      return 'healthy'
    case 'Promoting':
    case 'Verifying':
      return 'progressing'
    case 'Pending':
      return 'info'
    case 'Failed':
      return 'failed'
    default:
      return 'unknown'
  }
}

function rolloutKind(phase: string): StatusKind {
  switch (phase) {
    case 'Healthy':
      return 'healthy'
    case 'Progressing':
      return 'progressing'
    case 'Degraded':
      return 'degraded'
    case 'Paused':
      return 'paused'
    default:
      return 'unknown'
  }
}

function coderKind(status: string): StatusKind {
  switch (status) {
    case 'running':
      return 'healthy'
    case 'starting':
    case 'pending':
      return 'progressing'
    case 'stopping':
    case 'stopped':
      return 'paused'
    case 'failed':
      return 'failed'
    default:
      return 'unknown'
  }
}

/* ─────────── icons ─────────── */

function IconCode() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}
function IconPr() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 9v6" />
      <circle cx="18" cy="18" r="3" />
      <path d="M18 15V9a3 3 0 0 0-3-3h-4" />
      <polyline points="14 3 11 6 14 9" />
    </svg>
  )
}
function IconBuild() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.4-.6-.6-2.4z" />
    </svg>
  )
}
function IconDev() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}
function IconPreview() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function IconPromote() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}
function IconSync() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}
function IconRollout() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 12h16M4 6h10M4 18h13" />
    </svg>
  )
}
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

export default DeliveryFlow
