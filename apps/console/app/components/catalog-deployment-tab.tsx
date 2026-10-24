import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Button,
  canResource,
  Field as FormField,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  type StatusKind,
  useCan,
  usePublicUrl,
  useToast,
  useToolPublicUrl,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { type argocd, kargo as kargoModel } from '@adhar/api-clients'
import type { Entity } from '~/data/catalog.ts'
import {
  type EntityDeployment,
  envLabel,
  envOrder,
  freightLabel,
  freightTags,
  kargoEnvironments,
  type KargoEnvironment,
  projectEnvLabel,
  promotableFreightFor,
  unhealthyNodes,
  useKargoActions,
  useKargoFreight,
  useKargoPromotions,
  useKargoStages,
  useResourceTree,
  workloadNamespace,
} from '~/data/catalog-deployment.ts'
import type { EntityRoute } from '~/data/catalog-routes.ts'
import { type PipelineRunSummary, usePipelineRuns } from '~/data/catalog-pipelines.ts'
import { describeProgress } from '~/data/pipeline-progress.ts'
import { useDiscoverAlerts } from '~/data/cross-module-signals.ts'
import {
  ago,
  alertMatches,
  appDashboardUrl,
  type DeployEvent,
  deployEvents,
  deployFrequency,
  describeTrigger,
  environmentRows,
  envNamespaces,
  type EnvRow,
  fmtDuration,
  giteaRepoRef,
  harborRepoOf,
  imageVersion,
  isSha,
  parseImage,
  routeEnvironment,
  shortSha,
  workloadDashboardUrl,
} from '~/data/catalog-deployment-model.ts'
import {
  useAnalysisRun,
  useApplicationXRs,
  useComposedObjects,
  useEnvironmentRoutes,
  useImageArtifacts,
  useProjectXR,
  useRepoSummary,
  useWorkloads,
} from '~/data/catalog-deployment-live.ts'
import {
  authorisationProblem,
  type DeliveryDiagnosis,
  describeWorkload,
  diagnoseDelivery,
  expectedEnvs,
  findApplicationXR,
  isAuthorisationError,
  type Piece,
  pickWorkload,
  projectOf,
  type Release,
  releaseHistory,
  type WorkloadStatus,
} from '~/data/catalog-deployment-delivery.ts'
import { withExpectedEnvs } from '~/data/catalog-deployment-model.ts'
import type { KObj } from '~/data/catalog-composition-model.ts'
import { isSafeLinkUrl } from '~/data/safe-url.ts'

/**
 * The catalog drawer's Deployment tab.
 *
 * Read top to bottom it answers, in order: is it running and healthy
 * (Rollout), is the control plane delivering it (Delivery — shown whenever it
 * is not fully set up), where and at which version in each environment
 * (Environments, with the rollout's own state), what was released when and by
 * whom (Releases), how often it ships (Deploy frequency, Sync history), how
 * Argo CD is configured to deliver it (GitOps), where it answers (Endpoints),
 * what it is built from (Repository), how the build is doing (Pipeline runs)
 * and how to watch it (Observability).
 *
 * Each section owns exactly one state — first load, unavailable, empty, or
 * data — and background refetches never change it: queries keep their last
 * good answer, so the tab refreshes silently instead of flickering.
 */

type ArgoApp = argocd.Application

export interface CatalogDeploymentTabProps {
  entity: Entity
  deployment: EntityDeployment
  repoUrl?: string
  /** The drawer's own route lookup — used when the service has no environment namespaces. */
  routes: EntityRoute[]
  monitorUrl?: string
  onMetrics?(): void
  /** Switch the drawer to its Composition tab. */
  onComposition?(): void
}

export function CatalogDeploymentTab({ entity, deployment, repoUrl, routes, monitorUrl, onMetrics, onComposition }: CatalogDeploymentTabProps) {
  const name = entity.metadata.name
  const argoBase = useToolPublicUrl('argocd')
  const giteaPublic = useToolPublicUrl('gitea')
  const appUrl = (app: ArgoApp): string | undefined =>
    argoBase ? `${argoBase.replace(/\/$/, '')}/applications/${app.metadata.namespace}/${app.metadata.name}` : undefined

  // The control plane's view: the Application XR behind this entity, its
  // Project, and the Objects it composed. This is what explains a service
  // that has no Argo CD application yet.
  const xrs = useApplicationXRs()
  const xr = useMemo(() => findApplicationXR(xrs.data, name, entity.metadata.annotations ?? {}), [xrs.data, name, entity.metadata.annotations])
  const project = useProjectXR(xr ? projectOf(xr) : undefined, xr?.metadata.namespace)
  const objects = useComposedObjects(xr?.metadata.namespace)
  const appName = xr?.metadata.name ?? name

  const hasApps = deployment.apps.length > 0
  const stages = useKargoStages(hasApps || Boolean(xr))
  // Environments are the PROJECT's (dev → test → prod, shared by every app of
  // it); this service's Kargo state per environment is its own freight in the
  // project's shared stage, or its own stage until the platform moves.
  const projName = xr ? projectOf(xr) : deployment.apps.map((a) => a.metadata.labels?.['adhar.io/project']).find(Boolean)
  const projEnvs = useMemo(() => kargoModel.projectEnvironments(project.data ?? undefined), [project.data])
  const kenvs0 = useMemo(
    () => kargoEnvironments(stages.data, deployment, appName, { project: projName, envs: projEnvs }),
    [stages.data, deployment, appName, projName, projEnvs],
  )
  const kargoProject = kenvs0[0]?.stage.project ?? projName
  const freight = useKargoFreight(kargoProject, Boolean(kargoProject) && (hasApps || Boolean(xr)))
  const kenvs = useMemo(
    () => (freight.data ? kargoEnvironments(stages.data, deployment, appName, { project: projName, envs: projEnvs, freight: freight.data }) : kenvs0),
    [freight.data, kenvs0, stages.data, deployment, appName, projName, projEnvs],
  )
  const envProject = kenvs[0]?.project ?? projName
  const diagnosis = useMemo(
    () => (xr ? diagnoseDelivery({ xr, project: project.data, objects: objects.data ?? [], argoApps: deployment.apps, stages: stages.data ?? [] }) : undefined),
    [xr, project.data, objects.data, deployment.apps, stages.data],
  )
  const rows = useMemo(
    () => withExpectedEnvs(environmentRows(deployment, kenvs), expectedEnvs(diagnosis)).map((r) => (envProject ? { ...r, label: projectEnvLabel(envProject, r.key) } : r)),
    [deployment, kenvs, diagnosis, envProject],
  )
  const namespaces = useMemo(() => {
    const ns = envNamespaces(rows)
    return ns.length ? ns : deployment.namespace ? [deployment.namespace] : []
  }, [rows, deployment.namespace])
  const workloads = useWorkloads(envNamespaces(rows))
  const events = useMemo(() => deployEvents(deployment), [deployment])

  const repoRef = giteaRepoRef(repoUrl, giteaPublic)
  const repo = useRepoSummary(repoRef)
  const commits = useMemo(() => {
    const m = new Map<string, { message: string; author: string }>()
    for (const c of repo.data?.commits ?? []) m.set(c.sha, { message: c.message.split('\n')[0], author: c.author.login })
    return m
  }, [repo.data])
  const images = useMemo(() => [...new Set(deployment.apps.flatMap((a) => a.status.images))], [deployment.apps])
  const harborRef = harborRepoOf(images, repoRef?.repo ?? appName) ?? (xr ? { project: 'library', repo: repoRef?.repo ?? appName } : undefined)
  const artifacts = useImageArtifacts(harborRef)

  const freightAlias = useMemo(() => new Map((freight.data ?? []).filter((f) => f.alias).map((f) => [f.id, f.alias!])), [freight.data])
  const ctx: Ctx = {
    entity, deployment, repoUrl, repoRef, rows, kenvs, events, commits, artifacts: artifacts.data, appUrl, argoBase,
    appName, workloads: workloads.data ?? [], freightAlias,
  }
  const p = deployment.primary
  const delivery = diagnosis ? <DeliverySection diagnosis={diagnosis} onComposition={onComposition} loading={project.isLoading || objects.isLoading} /> : null

  return (
    <div className="min-w-0 space-y-5">
      {deployment.isLoading || (!p && !xr && xrs.isLoading) ? (
        <Section title="Rollout">
          <Loading>Reading rollout state from Argo CD…</Loading>
        </Section>
      ) : deployment.isError ? (
        <>
          <DeploymentUnavailable reason="unreachable" name={name} argoBase={argoBase} />
          {delivery}
        </>
      ) : !p ? (
        xr ? (
          <>
            {delivery}
            {rows.length ? <EnvironmentsSection ctx={ctx} /> : null}
            {kenvs.length ? <ReleasesSection ctx={ctx} /> : null}
          </>
        ) : (
          <DeploymentUnavailable reason="unmatched" name={name} argoBase={argoBase} />
        )
      ) : (
        <>
          <RolloutSummary ctx={ctx} primary={p} stagesLoading={stages.isLoading} />
          {diagnosis && diagnosis.phase !== 'ready' ? delivery : null}
          {rows.length ? <EnvironmentsSection ctx={ctx} /> : null}
          {kenvs.length ? <ReleasesSection ctx={ctx} /> : null}
          {deployment.unscoped.length ? <OtherAppsSection ctx={ctx} titled={rows.length > 0} /> : null}
          <div className="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-2">
            <DeployFrequencySection events={events} rows={rows} />
            <SyncHistorySection ctx={ctx} />
          </div>
          <GitOpsSection ctx={ctx} />
        </>
      )}
      <EndpointsSection name={appName} rows={rows} namespaces={namespaces} fallback={routes} />
      <RepositorySection ctx={ctx} repoLoading={repo.isLoading} repoError={repo.isError && !repo.data} repoData={repo.data} />
      <PipelinesSection entity={entity} repoUrl={repoUrl} runsIn={deployment.namespace} />
      <MonitoringSection entity={entity} rows={rows} namespaces={namespaces} monitorUrl={monitorUrl} onMetrics={onMetrics} />
    </div>
  )
}

interface Ctx {
  entity: Entity
  deployment: EntityDeployment
  repoUrl?: string
  repoRef?: { org: string; repo: string }
  rows: EnvRow[]
  kenvs: KargoEnvironment[]
  events: DeployEvent[]
  commits: Map<string, { message: string; author: string }>
  artifacts?: Array<{ digest: string; push_time: string; tags?: Array<{ name: string }> }>
  appUrl(app: ArgoApp): string | undefined
  argoBase: string
  /** The application's name on the platform (the XR's, else the entity's). */
  appName: string
  workloads: KObj[]
  /** Freight id → its Kargo alias (stages report only the id). */
  freightAlias: Map<string, string>
}

/* ─────────── building blocks ─────────── */

/** A block of the tab — the drawer's section style: quiet eyebrow, actions on the right. */
function Section({ title, count, actions, children }: { title: string; count?: number; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-4 py-4 sm:px-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-content-subtle">
          {title}
          {count !== undefined ? <span className="ml-1.5 tabular-nums text-content-muted">· {count}</span> : null}
        </h3>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

function Loading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[12px] text-content-muted">
      <Spinner size={12} /> {children}
    </div>
  )
}

/** The one-line "nothing here / cannot tell" state of a section. */
function Note({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-edge-default px-3.5 py-3">
      <div className="text-[12px] font-medium text-content">{title}</div>
      {children ? <p className="mt-0.5 text-[11px] leading-relaxed text-content-muted">{children}</p> : null}
    </div>
  )
}

const ACTION =
  'inline-flex min-h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2.5 py-1 text-[12px] font-medium text-content-muted shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/30 dark:hover:text-brand-300 pointer-coarse:min-h-11'

/** A header action: an internal console link, or an external one with an arrow. */
function ActionLink({ href, external, children, title }: { href: string; external?: boolean; children: React.ReactNode; title?: string }) {
  return (
    <a href={href} title={title} className={ACTION} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
      {children}
      {external ? <IconArrowUpRight /> : <span aria-hidden>→</span>}
    </a>
  )
}

function TextLink({ href, children, title, mono }: { href?: string; children: React.ReactNode; title?: string; mono?: boolean }) {
  if (!href) return <span className={cn('text-content', mono && 'font-mono')} title={title}>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" title={title} className={cn('text-brand-700 hover:underline dark:text-brand-300', mono && 'font-mono')}>
      {children}
    </a>
  )
}

function CopyButton({ text, what = 'Copied' }: { text: string; what?: string }) {
  const toast = useToast()
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          toast.success(what)
        } catch {
          toast.error('The browser blocked clipboard access')
        }
      }}
      title={`Copy ${text}`}
      className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] font-medium text-content-muted transition-colors hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/30 dark:hover:text-brand-300 pointer-coarse:min-h-11"
    >
      <IconCopy /> Copy
    </button>
  )
}

/** A label/value row that never pushes the layout wider than the card. */
function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="shrink-0 text-content-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right text-content" title={title}>{children}</dd>
    </div>
  )
}

function argoHealthKind(status?: string): StatusKind {
  switch (status) {
    case 'Healthy':
      return 'healthy'
    case 'Progressing':
      return 'progressing'
    case 'Degraded':
      return 'degraded'
    case 'Suspended':
      return 'paused'
    case 'Missing':
      return 'failed'
    default:
      return 'unknown'
  }
}

function argoSyncKind(status?: string): StatusKind {
  if (status === 'Synced') return 'healthy'
  if (status === 'OutOfSync') return 'paused'
  return 'unknown'
}

function kargoKind(stage: KargoEnvironment['stage']): StatusKind {
  if (stage.phase === 'Failed' || stage.phase === 'Erroring') return 'failed'
  if (stage.phase === 'Promoting' || stage.phase === 'Verifying' || stage.health === 'Progressing') return 'progressing'
  if (stage.health === 'Healthy') return 'healthy'
  if (stage.health === 'Unhealthy') return 'degraded'
  return 'unknown'
}

const DOT: Record<StatusKind, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-rose-500',
  failed: 'bg-rose-600',
  paused: 'bg-amber-500',
  progressing: 'bg-indigo-500 animate-pulse',
  unknown: 'bg-slate-400',
  info: 'bg-sky-500',
}

/** `<repo>/commit/<sha>` on Gitea, GitHub and GitLab alike. */
function commitUrl(repoUrl: string | undefined, rev: string | undefined): string | undefined {
  if (!repoUrl || !rev || !isSha(rev)) return undefined
  return `${repoUrl.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${rev}`
}

/**
 * Series colours for environments: a validated categorical trio (sky,
 * violet, orange — CVD-separated in both themes). Production always takes
 * orange so it reads the same on every service; earlier stages take the rest
 * in promotion order. Unscoped apps are neutral slate.
 */
function envSwatches(keys: readonly string[]): Record<string, string> {
  const pre = ['bg-[#0284c7] dark:bg-[#0891d1]', 'bg-[#7c3aed] dark:bg-[#8b5cf6]', 'bg-[#0d9488] dark:bg-[#14b8a6]']
  const out: Record<string, string> = {}
  let i = 0
  for (const k of keys) {
    if (k === 'other') out[k] = 'bg-slate-400 dark:bg-slate-500'
    else if (k.startsWith('prod')) out[k] = 'bg-[#ea580c]'
    else out[k] = pre[i++ % pre.length]
  }
  return out
}

/* ─────────── unavailable ─────────── */

function DeploymentUnavailable({ reason, name, argoBase }: { reason: 'unreachable' | 'unmatched'; name: string; argoBase: string }) {
  return (
    <Section
      title="Rollout"
      actions={
        <>
          {argoBase ? <ActionLink href={`${argoBase.replace(/\/$/, '')}/applications`} external>Argo CD</ActionLink> : null}
          <ActionLink href="/deliver?section=apps">GitOps view</ActionLink>
        </>
      }
    >
      <div className="text-[13px] font-semibold text-content">
        {reason === 'unreachable' ? 'Argo CD is not reachable' : 'Not deployed through Argo CD'}
      </div>
      {reason === 'unreachable' ? (
        <p className="mt-1 text-[12px] leading-relaxed text-content-muted">
          The console could not read Applications from Argo CD, so rollout state, environments and history are unknown — not empty. They
          appear as soon as Argo CD answers.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[12px] leading-relaxed text-content-muted">
            No Argo CD Application is labelled <code className="font-mono text-content">adhar.io/application={name}</code>, is named{' '}
            <code className="font-mono text-content">{name}</code> (optionally with an environment suffix), or is named by the entity's{' '}
            <code className="font-mono text-content">adhar.io/argocd-app</code> annotation.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] text-content-muted">
            <li>Deployed under another name? Set <code className="font-mono text-content">adhar.io/argocd-app</code> on the entity.</li>
            <li>Not deployed yet? Create an Application for it — the control plane then composes its environments and promotion chain.</li>
            <li>A library or a docs site legitimately has no deployment.</li>
          </ul>
        </>
      )}
    </Section>
  )
}

/* ─────────── rollout summary ─────────── */

function RolloutSummary({ ctx, primary, stagesLoading }: { ctx: Ctx; primary: ArgoApp; stagesLoading: boolean }) {
  const { deployment, rows, kenvs, events } = ctx
  const envApps = rows.map((r) => r.app).filter((a): a is ArgoApp => Boolean(a))
  const scope = envApps.length ? envApps : deployment.apps
  // The app to explain: the first environment that is not Healthy, else production.
  const troubled = scope.find((a) => a.status.health.status !== 'Healthy' && a.status.health.status !== 'Unknown')
  const focus = troubled ?? primary
  const tree = useResourceTree(focus)
  const bad = unhealthyNodes(tree.data ?? [])
  const envName = (app: ArgoApp) => rows.find((r) => r.app?.metadata.name === app.metadata.name)?.label

  const healthy = scope.filter((a) => a.status.health.status === 'Healthy').length
  const drifted = scope.filter((a) => a.status.resources.outOfSync > 0)
  const driftCount = drifted.reduce((n, a) => n + a.status.resources.outOfSync, 0)
  const autoApps = scope.filter((a) => a.spec.syncPolicy.automated)
  const running = scope.find((a) => a.status.operationState?.phase === 'Running')
  const lastEvent = events[0]
  const lastOp = primary.status.operationState
  // Only THIS service's promotions: a shared stage promoting another app is not its rollout.
  const promoting = kenvs.find((k) => k.promotion || (k.shape === 'per-app' && k.stage.phase === 'Promoting'))
  const failedStage = kenvs.find((k) => (k.shape === 'per-app' && (k.stage.phase === 'Failed' || k.stage.phase === 'Erroring')) || k.lastPromotionPhase === 'Failed')

  const tiles: Array<{ label: string; value: string; kind: StatusKind; sub: string }> = [
    {
      label: 'Health',
      value: focus.status.health.status,
      kind: argoHealthKind(focus.status.health.status),
      sub: scope.length > 1 ? `${healthy} of ${scope.length} healthy${troubled ? ` · ${envName(troubled) ?? troubled.metadata.name}` : ''}` : (envName(focus) ?? focus.metadata.name),
    },
    {
      label: 'Sync',
      value: drifted.length ? 'OutOfSync' : primary.status.sync.status,
      kind: drifted.length ? 'paused' : argoSyncKind(primary.status.sync.status),
      sub: drifted.length
        ? `${driftCount} ${driftCount === 1 ? 'resource' : 'resources'} drifted · ${drifted.map((a) => envName(a) ?? a.metadata.name).join(', ')}`
        : `${scope.reduce((n, a) => n + a.status.resources.total, 0)} resources in sync`,
    },
    running
      ? { label: 'Last deploy', value: 'Syncing', kind: 'progressing', sub: `${envName(running) ?? running.metadata.name} · started ${ago(running.status.operationState?.startedAt)}` }
      : lastEvent
        ? {
          label: 'Last deploy',
          value: ago(lastEvent.deployedAt) || '—',
          kind: lastOp?.phase && lastOp.phase !== 'Succeeded' ? 'degraded' : 'healthy',
          sub: [lastEvent.envLabel, shortSha(lastEvent.revision), lastOp?.phase && lastOp.phase !== 'Succeeded' ? `last sync ${lastOp.phase.toLowerCase()}` : null].filter(Boolean).join(' · '),
        }
        : { label: 'Last deploy', value: 'None', kind: 'unknown', sub: 'no sync history recorded' },
    {
      label: 'Auto-sync',
      value: autoApps.length === scope.length ? 'On' : autoApps.length ? 'Mixed' : 'Manual',
      kind: autoApps.length === scope.length ? 'healthy' : 'paused',
      sub: autoApps.length
        ? [autoApps.every((a) => a.spec.syncPolicy.automated?.prune) ? 'prune' : null, autoApps.every((a) => a.spec.syncPolicy.automated?.selfHeal) ? 'self-heal' : null]
          .filter(Boolean).join(' · ') || 'no prune, no self-heal'
        : 'syncs only when someone presses Sync',
    },
    kenvs.length
      ? {
        label: 'Promotion',
        value: promoting ? 'Promoting' : failedStage ? 'Failed' : 'Steady',
        kind: promoting ? 'progressing' : failedStage ? 'failed' : 'healthy',
        sub: promoting
          ? `into ${promoting.label}`
          : failedStage
            ? `${failedStage.label}: ${failedStage.stage.issues?.[0] ?? failedStage.lastPromotionPhase ?? failedStage.stage.phase}`
            : `${kenvs.filter((k) => k.freight).length} of ${kenvs.length} environments have freight`,
      }
      : {
        label: 'Environments',
        value: rows.length ? String(rows.length) : '—',
        kind: rows.length ? 'info' : 'unknown',
        sub: rows.length ? rows.map((r) => r.label).join(' → ') : stagesLoading ? 'reading Kargo…' : `not environment-scoped${deployment.namespace ? ` · runs in ${deployment.namespace}` : ''}`,
      },
  ]

  const url = ctx.appUrl(primary)
  return (
    <Section
      title="Rollout"
      actions={url ? <ActionLink href={url} external title={`${primary.metadata.namespace}/${primary.metadata.name}`}>Open in Argo CD</ActionLink> : null}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]">
        {tiles.map((t) => (
          <div key={t.label} className="min-w-0 rounded-lg border border-edge-subtle bg-surface-sunken/40 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-content-subtle">{t.label}</div>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-[14px] font-semibold leading-tight text-content">
              <span className={cn('size-2 shrink-0 rounded-full', DOT[t.kind])} aria-hidden />
              <span className="truncate" title={t.value}>{t.value}</span>
            </div>
            <div className="mt-1 truncate text-[11px] text-content-muted" title={t.sub}>{t.sub}</div>
          </div>
        ))}
      </div>
      {bad.length ? (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 dark:border-rose-500/30 dark:bg-rose-500/10">
          <div className="text-[12px] font-semibold text-rose-800 dark:text-rose-200">
            {envName(focus) ? `${envName(focus)} is ` : 'It is '}
            {focus.status.health.status.toLowerCase()} · {bad.length} unhealthy {bad.length === 1 ? 'resource' : 'resources'}
          </div>
          <ul className="mt-1 space-y-0.5">
            {bad.slice(0, 5).map((n) => (
              <li key={`${n.kind}/${n.namespace}/${n.name}`} className="flex min-w-0 items-baseline gap-2 text-[11px] text-rose-800 dark:text-rose-200">
                <span className="shrink-0 font-mono font-medium">{n.kind}/{n.name}</span>
                <span className="min-w-0 truncate text-rose-700 dark:text-rose-300" title={n.reason || n.status}>{n.reason || n.status}</span>
              </li>
            ))}
            {bad.length > 5 ? <li className="text-[11px] text-rose-700 dark:text-rose-300">+{bad.length - 5} more in Argo CD</li> : null}
          </ul>
        </div>
      ) : focus.status.health.message && focus.status.health.status !== 'Healthy' ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3.5 py-2 text-[11px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{focus.status.health.message}</p>
      ) : null}
    </Section>
  )
}

/* ─────────── delivery (control plane) ─────────── */

const PIECE: Record<Piece['state'], { kind: StatusKind; label: string }> = {
  live: { kind: 'healthy', label: 'Live' },
  composed: { kind: 'progressing', label: 'Applying' },
  failing: { kind: 'failed', label: 'Failing' },
  missing: { kind: 'unknown', label: 'Not composed' },
}

const PHASE: Record<DeliveryDiagnosis['phase'], StatusKind> = { ready: 'healthy', 'setting-up': 'progressing', failed: 'failed', blocked: 'paused' }

/**
 * Why the platform has (not) deployed it: the Application XR's conditions,
 * its Project's environments, and — per environment — which of the pieces the
 * composition creates exist, are applying, are failing (with the
 * provider-kubernetes error) or were never composed.
 */
function DeliverySection({ diagnosis: d, onComposition, loading }: { diagnosis: DeliveryDiagnosis; onComposition?(): void; loading: boolean }) {
  // ProjectEnvironments is informational (Inherited / OverrideIgnored), shown below.
  const bad = d.conditions.filter((c) => c.status !== 'True' && c.type !== 'ProjectEnvironments')
  return (
    <Section
      title="Delivery"
      actions={
        <>
          {onComposition ? <button type="button" onClick={onComposition} className={ACTION}>Resources <span aria-hidden>→</span></button> : null}
          {d.phase === 'blocked' && !d.project.environments.length ? <ActionLink href="/platform?section=environments">Environments</ActionLink> : null}
          <ActionLink href="/platform?section=applications">Applications</ActionLink>
        </>
      }
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <StatusBadge kind={PHASE[d.phase]} className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px]">
          {d.phase === 'setting-up' ? 'Setting up' : d.phase === 'ready' ? 'Ready' : d.phase === 'failed' ? 'Failed' : 'Blocked'}
        </StatusBadge>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-content">{d.headline}</div>
          {d.detail ? <p className="mt-0.5 break-words text-[12px] leading-relaxed text-content-muted">{d.detail}</p> : null}
          {loading ? <div className="mt-1"><Loading>Reading the control plane…</Loading></div> : null}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-[12px] md:grid-cols-2">
        <Fact label="Application" title={`${d.xr.namespace}/${d.xr.name}`}>
          <span className="font-mono">{d.xr.namespace}/{d.xr.name}</span>
          {d.xr.phase ? <span className="text-content-subtle"> · {d.xr.phase}</span> : null}
        </Fact>
        <Fact label="Composition">{d.xr.composition ? <span className="font-mono">{d.xr.composition}</span> : '—'}</Fact>
        <Fact label="Project">
          <span className="font-mono">{d.project.name}</span>
          {!d.project.found ? <span className="text-rose-700 dark:text-rose-300"> · not found</span> : null}
        </Fact>
        <Fact label="Environments" title={d.project.environments.map((e) => `${e.name} → ${e.namespace ?? '?'}`).join('\n') || undefined}>
          {d.project.environments.length
            ? d.project.environments.map((e) => e.name).join(' → ')
            : <span className="text-amber-700 dark:text-amber-300">none published</span>}
          {d.wanted.length
            ? <span className="text-content-subtle">{d.wantedIgnored ? ` · the app's own list (${d.wanted.join(', ')}) is ignored` : ` · app asks for ${d.wanted.join(', ')}`}</span>
            : null}
        </Fact>
      </dl>
      {d.inheritance?.reason === 'OverrideIgnored' ? (
        <p className="mt-2 rounded-md bg-sky-50 px-3 py-2 text-[11px] leading-relaxed text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
          {d.inheritance.message ?? `This application lists its own environments; they are ignored — it is deployed to every environment of project ${d.project.name}.`}
        </p>
      ) : null}
      {d.unknownEnvs.length ? (
        <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300">
          The application asks for {d.unknownEnvs.join(', ')}, which project {d.project.name} does not have — {d.unknownEnvs.length === 1 ? 'it is' : 'they are'} skipped.
        </p>
      ) : null}

      {bad.length ? (
        <ul className="mt-3 space-y-1.5">
          {bad.map((c) => (
            <li
              key={c.type}
              className={cn(
                'break-words rounded-md px-3 py-2 text-[11px] leading-relaxed',
                c.type === 'Synced' || /error|fail/i.test(c.reason ?? '')
                  ? 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200'
                  : 'bg-surface-sunken text-content-muted',
              )}
            >
              <span className="font-semibold">{c.type} = {c.status}</span>
              {c.reason ? ` · ${c.reason}` : ''}
              {c.message ? ` — ${c.message}` : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {d.envs.length ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-edge-subtle">
          <div className="hidden grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 bg-surface-sunken/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle sm:grid">
            <span>Env</span>
            <span>Argo CD app</span>
            <span>Kargo stage</span>
            <span>Verification</span>
          </div>
          <ul className="divide-y divide-edge-subtle">
            {d.envs.map((e) => (
              <li key={e.env} className="grid grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-3 py-2 text-[11px] sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <div className="font-medium text-content">{e.env}</div>
                  {e.namespace ? <div className="truncate font-mono text-[10px] text-content-subtle" title={e.namespace}>{e.namespace}</div> : null}
                </div>
                <PieceCell p={e.app} />
                <PieceCell p={e.stage} />
                <div className="hidden min-w-0 sm:block"><PieceCell p={e.analysis} /></div>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 items-center gap-2 border-t border-edge-subtle px-3 py-1.5 text-[11px]">
            <span className="text-content-subtle">Warehouse</span>
            <span className="truncate font-mono text-content" title={`${d.warehouse.namespace}/${d.warehouse.name}`}>{d.warehouse.name}</span>
            <StatusBadge kind={PIECE[d.warehouse.state].kind} dot={false} className="px-1 py-0 text-[9px]">{PIECE[d.warehouse.state].label}</StatusBadge>
          </div>
        </div>
      ) : null}

      {d.objectErrors.length ? (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Composed objects reporting errors</div>
          <ul className="space-y-1.5">
            {d.objectErrors.slice(0, 6).map((o) => (
              <li key={o.name} className="break-words rounded-md border border-rose-200 px-3 py-2 text-[11px] leading-relaxed dark:border-rose-500/30">
                <div className="font-mono text-content">{o.wraps ?? o.name}{o.reason ? <span className="text-content-subtle"> · {o.reason}</span> : null}</div>
                <div className="text-rose-800 dark:text-rose-200">{o.message}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  )
}

function PieceCell({ p }: { p: Piece }) {
  return (
    <div className="min-w-0">
      <StatusBadge kind={PIECE[p.state].kind} dot={false} className="px-1 py-0 text-[9px]">{PIECE[p.state].label}</StatusBadge>
      <div className="mt-0.5 truncate font-mono text-[10px] text-content-muted" title={`${p.namespace}/${p.name}`}>{p.name}</div>
      {p.reason ? <div className="mt-0.5 line-clamp-2 break-words text-[10px] text-rose-700 dark:text-rose-300" title={p.reason}>{p.reason}</div> : null}
    </div>
  )
}

/* ─────────── releases ─────────── */

const PROMO: Record<Release['phase'], StatusKind> = {
  Pending: 'unknown',
  Running: 'progressing',
  Succeeded: 'healthy',
  Failed: 'failed',
  Errored: 'failed',
  Aborted: 'paused',
  Unknown: 'unknown',
}

/**
 * What is released where, and the history of how it got there. A release is
 * Kargo freight (the image CI built from a commit) promoted into a stage:
 * Kargo pins the image digest in the environment's overlay, commits it, and
 * Argo CD syncs that commit.
 */
function ReleasesSection({ ctx }: { ctx: Ctx }) {
  const project = ctx.kenvs[0]?.stage.project
  const freight = useKargoFreight(project)
  const promotions = useKargoPromotions(project)
  const stageEnvs = useMemo(
    () => ctx.rows.filter((r) => r.kargo).map((r) => ({ stage: r.kargo!.stage, env: r.label, shared: r.kargo!.shape === 'shared' })),
    [ctx.rows],
  )
  const history = useMemo(() => releaseHistory(stageEnvs, promotions.data, freight.data, ctx.appName), [stageEnvs, promotions.data, freight.data, ctx.appName])
  const fById = useMemo(() => new Map((freight.data ?? []).map((f) => [f.id, f])), [freight.data])
  const base = ctx.repoUrl?.replace(/\.git$/, '').replace(/\/$/, '')
  const authFail = history.find((r) => (r.phase === 'Failed' || r.phase === 'Errored') && isAuthorisationError(r.message))
  const loading = (freight.isLoading || promotions.isLoading) && !promotions.data
  return (
    <Section
      title="Releases"
      actions={<ActionLink href="/deliver?section=environments">Promotions</ActionLink>}
    >
      <div className="overflow-hidden rounded-lg border border-edge-subtle">
        <ul className="divide-y divide-edge-subtle">
          {ctx.rows.filter((r) => r.kargo).map((r) => {
            const st = r.kargo!.stage
            const current = r.kargo!.freight
            const f = current ? fById.get(current) : undefined
            const img = f?.images[0]
            const source = f?.commits?.[0]?.id ?? (img?.tag && isSha(img.tag) ? img.tag : undefined)
            const last = history.find((h) => h.stage === st.name && h.phase === 'Succeeded')
            const rev = r.app?.status.sync.revision
            const version = r.app?.status.images[0] ? imageVersion(r.app.status.images[0], ctx.artifacts) : undefined
            return (
              <li key={r.key} className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 px-3 py-2.5 text-[12px] sm:grid-cols-[7rem_1fr_auto]">
                <div className="font-medium text-content">{r.label}</div>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-content" title={current}>{f ? kargoModel.freightDisplayName(f) : (r.kargo!.shape === 'per-app' ? st.currentFreightAlias : undefined) ?? (current ? current.slice(0, 12) : 'no freight yet')}</span>
                    {source ? <span className="text-[11px] text-content-muted">built from <TextLink href={commitUrl(base, source)} mono>{source.slice(0, 7)}</TextLink></span> : null}
                    {img?.digest || version?.digest ? <span className="truncate font-mono text-[10px] text-content-subtle" title={img?.digest ?? version?.digest}>{(img?.digest ?? version?.digest)!.replace(/^sha256:/, '').slice(0, 12)}</span> : null}
                  </div>
                  <div className="truncate text-[11px] text-content-muted">
                    {[
                      rev ? `Argo CD at ${shortSha(rev)}` : r.app ? null : 'no Argo CD app',
                      last?.promotionCommit ? `promotion commit ${last.promotionCommit.slice(0, 7)}` : null,
                      f?.verifiedIn?.includes(st.name) ? 'verified' : st.verification ? `verification ${st.verification.phase.toLowerCase()}` : null,
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="text-[11px] text-content-muted sm:text-right">
                  {(() => {
                    const at = r.kargo!.lastPromoted ?? last?.finished ?? last?.created
                    return at ? <span title={new Date(at).toLocaleString()}>{ago(at)}</span> : '—'
                  })()}
                  {last?.actor ? <span className="text-content-subtle"> · {last.actor}</span> : null}
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {authFail ? (
        <p className="mt-3 break-words rounded-md bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
          The last promotion into {authFail.env} failed because Kargo is not authorised to update its Argo CD app. The app must carry{' '}
          <code className="font-mono">kargo.akuity.io/authorized-stage: {project}:{authFail.stage}</code> — the control plane sets it; a hand-made app needs it added.
        </p>
      ) : null}

      <div className="mt-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">History</div>
        {loading ? (
          <Loading>Reading promotions…</Loading>
        ) : history.length === 0 ? (
          <Note title="No promotions yet">Freight appears when CI publishes an image; the first stage takes it automatically, later stages when it is verified upstream.</Note>
        ) : (
          <ol className="space-y-2">
            {history.slice(0, 12).map((h) => (
              <li key={h.promotion} className="flex min-w-0 items-start gap-2.5 text-[12px]">
                <span className="w-[4.75rem] shrink-0">
                  <StatusBadge kind={PROMO[h.phase]} className="px-1.5 py-0 text-[10px]">{h.phase}</StatusBadge>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-content">{h.env}</span>
                    <span className="font-mono text-content-muted" title={h.freight?.id}>{h.freight?.label}</span>
                    {h.freight?.sourceCommit ? <TextLink href={commitUrl(base, h.freight.sourceCommit)} mono title="Source commit the image was built from">{h.freight.sourceCommit.slice(0, 7)}</TextLink> : null}
                    {h.verified ? <span className="rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">verified</span> : null}
                  </div>
                  <div className="truncate text-[11px] text-content-muted" title={h.message}>
                    {h.actor ? `by ${h.actor}` : <span className="font-mono text-content-subtle">{h.promotion}</span>}
                    {h.promotionCommit ? <> · pushed <TextLink href={commitUrl(base, h.promotionCommit)} mono>{h.promotionCommit.slice(0, 7)}</TextLink></> : null}
                    {h.phase !== 'Succeeded' && h.message ? ` · ${h.message}` : null}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-content-subtle" title={new Date(h.created).toLocaleString()}>{ago(h.finished ?? h.created)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Section>
  )
}

/* ─────────── environments ─────────── */

function EnvironmentsSection({ ctx }: { ctx: Ctx }) {
  const { rows, kenvs } = ctx
  const [promoting, setPromoting] = useState<KargoEnvironment | null>(null)
  const project = kenvs[0]?.stage.project
  const shared = kenvs.some((k) => k.shape === 'shared')
  return (
    <Section
      title="Environments"
      count={rows.length}
      actions={
        <>
          {kenvs.length ? <ActionLink href="/deliver?section=environments">Promotions</ActionLink> : null}
          <ActionLink href="/deliver?section=apps">GitOps view</ActionLink>
        </>
      }
    >
      <ol className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row, i) => (
          <li key={row.key} className="min-w-0">
            <EnvCard ctx={ctx} row={row} step={i + 1} onPromote={row.kargo ? () => setPromoting(row.kargo!) : undefined} />
          </li>
        ))}
      </ol>
      {kenvs.length ? (
        <p className="mt-2.5 text-[11px] leading-relaxed text-content-subtle">
          The environments of project <span className="font-mono text-content-muted">{project}</span> — every application in it is deployed through the same ones.
          {shared ? ' Promoting here moves only this service\'s freight; the other applications keep what they run.' : ''} Each environment takes only what the one before it has verified.
        </p>
      ) : null}
      {promoting ? <PromoteDialog env={promoting} project={project} onClose={() => setPromoting(null)} /> : null}
    </Section>
  )
}

/** Kargo objects the stage actions write — each action is gated on its own verb (docs/rbac.md). */
const KARGO_STAGES = { group: 'kargo.akuity.io', resource: 'stages', namespaced: true } as const
const KARGO_PROMOTIONS = { group: 'kargo.akuity.io', resource: 'promotions', namespaced: true } as const

function EnvCard({ ctx, row, step, onPromote }: { ctx: Ctx; row: EnvRow; step: number; onPromote?(): void }) {
  const { app, kargo } = row
  const pub = usePublicUrl()
  const toast = useToast()
  const actions = useKargoActions(kargo?.stage.project)
  // Refresh and abort are merge patches (stage / promotion annotations);
  // promote creates a Promotion in the Kargo project namespace.
  const kNs = kargo?.stage.project
  const canRefresh = useCan(canResource(KARGO_STAGES, 'patch', { namespace: kNs, name: kargo?.stage.name }), { enabled: Boolean(kargo) })
  const canAbort = useCan(canResource(KARGO_PROMOTIONS, 'patch', { namespace: kNs, name: kargo?.promotion }), { enabled: Boolean(kargo?.promotion) })
  const canPromote = useCan(canResource(KARGO_PROMOTIONS, 'create', { namespace: kNs }), { enabled: Boolean(kargo && onPromote) })
  const busy = actions.abort.isPending || actions.refresh.isPending
  const act = async (what: string, run: () => Promise<unknown>) => {
    if (!kargo) return
    try {
      await run()
      toast.success(`${what} ${kargo.stage.name}`)
    } catch (e) {
      toast.error(kargoActionError(what, kargo.stage.name, e))
    }
  }
  const rev = app?.status.sync.revision
  const link = commitUrl(ctx.repoUrl ?? (app ? pub(app.spec.source.repoURL) : undefined), rev)
  const lastEv = app ? ctx.events.find((e) => e.app === app.metadata.name) : undefined
  const trigger = lastEv ? describeTrigger(lastEv, lastEv.revision ? ctx.commits.get(lastEv.revision)?.message : undefined) : undefined
  const version = app?.status.images[0] ? imageVersion(app.status.images[0], ctx.artifacts) : undefined
  const url = app ? ctx.appUrl(app) : undefined
  const stage = kargo?.stage
  // A shared stage's health is whichever app was promoted last: this app's
  // health is its Argo CD app's, never the stage's.
  const sharedStage = kargo?.shape === 'shared'
  const headKind: StatusKind = app ? argoHealthKind(app.status.health.status) : stage && !sharedStage ? kargoKind(stage) : 'unknown'
  const run = useAnalysisRun(sharedStage ? stage?.verification?.analysisRun : undefined)
  const verify = sharedStage && run.data ? kargoModel.appVerification(run.data, ctx.appName) : undefined
  const workload = row.namespace ? pickWorkload(ctx.workloads, ctx.appName, row.namespace) : undefined
  const authProblem = authorisationProblem(app, stage)
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-edge-default bg-surface-raised">
      <div className="flex items-start justify-between gap-2 px-3.5 pt-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[9px] font-bold text-content-muted ring-1 ring-edge-default">{step}</span>
            <span className="truncate text-[13px] font-semibold text-content">{row.label}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle" title={app ? `${app.metadata.name} → ${row.namespace ?? app.spec.destination.namespace}` : stage?.name}>
            {row.namespace ? `ns ${row.namespace}` : stage ? `stage ${stage.name}` : '—'}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge kind={app || stage ? headKind : 'paused'} className="px-1.5 py-0 text-[10px]">
            {app ? app.status.health.status : stage && !sharedStage ? stage.health ?? stage.phase : 'Not deployed'}
          </StatusBadge>
          {app ? (
            <StatusBadge kind={argoSyncKind(app.status.sync.status)} dot={false} className="px-1.5 py-0 text-[10px]">
              {app.status.sync.status}
              {app.status.resources.outOfSync ? ` · ${app.status.resources.outOfSync}` : ''}
            </StatusBadge>
          ) : null}
        </div>
      </div>
      <dl className="mt-2.5 space-y-1.5 px-3.5 pb-3 text-[11px]">
        {app ? (
          <>
            <Row label="Revision" title={rev}>
              {shortSha(rev) ? <TextLink href={link} mono>{shortSha(rev)}</TextLink> : '—'}
              {app.spec.source.targetRevision ? <span className="text-content-subtle"> · {app.spec.source.targetRevision}</span> : null}
            </Row>
            <Row label="Image" title={app.status.images.join('\n') || undefined}>
              {version ? (
                <span className="font-mono">
                  {version.commit ? <TextLink href={commitUrl(ctx.repoUrl, version.commit)} mono>{version.label}</TextLink> : version.label}
                  {app.status.images.length > 1 ? <span className="text-content-subtle"> +{app.status.images.length - 1}</span> : null}
                </span>
              ) : '—'}
            </Row>
            <Row label="Deployed" title={lastEv ? new Date(lastEv.deployedAt).toLocaleString() : undefined}>
              {lastEv ? ago(lastEv.deployedAt) : '—'}
              {trigger?.label ? <span className="text-content-subtle"> · {trigger.kind === 'promotion' ? 'Kargo' : trigger.kind === 'auto' ? 'auto-sync' : trigger.label.replace(/^Synced by /, '')}</span> : null}
            </Row>
            {workload ? <WorkloadRow w={workload} /> : null}
            {app.status.operationState?.phase && app.status.operationState.phase !== 'Succeeded' ? (
              <Row label="Last sync" title={app.status.operationState.message}>
                <span className={app.status.operationState.phase === 'Running' ? 'text-indigo-700 dark:text-indigo-300' : 'text-rose-700 dark:text-rose-300'}>
                  {app.status.operationState.phase}
                </span>
              </Row>
            ) : null}
          </>
        ) : null}
        {stage ? (
          <>
            <Row label="Freight" title={kargo!.freight}>
              <span className="font-mono">
                {kargo!.freight
                  ? ctx.freightAlias.get(kargo!.freight) ?? (kargo!.shape === 'per-app' ? stage.currentFreightAlias : undefined) ?? kargo!.freight.slice(0, 12)
                  : 'none yet'}
              </span>
            </Row>
            <Row label="Promoted" title={kargo!.lastPromoted ? new Date(kargo!.lastPromoted).toLocaleString() : undefined}>
              {kargo!.lastPromoted ? ago(kargo!.lastPromoted) : '—'}
              {kargo!.lastPromotionPhase ? (
                <span className={kargo!.lastPromotionPhase === 'Succeeded' ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}>
                  {` · ${kargo!.lastPromotionPhase.toLowerCase()}`}
                </span>
              ) : null}
            </Row>
            {sharedStage ? (
              verify ? (
                <Row label="Verification" title={verify.metrics.map((m) => `${m.name}: ${m.phase}${m.message ? ` — ${m.message}` : ''}`).join('\n')}>
                  <span className={['Failed', 'Error', 'Inconclusive'].includes(verify.phase) ? 'text-rose-700 dark:text-rose-300' : undefined}>{verify.phase}</span>
                  {verify.blockedBy.length ? <span className="text-rose-700 dark:text-rose-300"> · environment blocked by {verify.blockedBy.join(', ')}</span> : null}
                </Row>
              ) : stage.verification ? (
                <Row label="Verification" title={stage.verification.message}>{`environment ${stage.verification.phase.toLowerCase()}`}</Row>
              ) : null
            ) : stage.verification ? <Row label="Verification" title={stage.verification.message}>{stage.verification.phase}</Row> : null}
            {sharedStage && (verify?.blockedBy.length || (stage.verification && ['Failed', 'Error'].includes(stage.verification.phase))) ? (
              <p className="text-[10px] leading-relaxed text-content-subtle">One failing application blocks verification for the whole {row.label} environment.</p>
            ) : null}
            {kargo!.promotion ? (
              <Row label="Promoting" title={kargo!.promotion}>
                <span className="font-mono text-indigo-700 dark:text-indigo-300">{kargo!.promotion}</span>
              </Row>
            ) : kargo!.busyWithOther ? (
              <Row label="Stage" title={stage.currentPromotion}>
                <span className="text-content-subtle">promoting another application</span>
              </Row>
            ) : null}
            {stage.issues?.length && !sharedStage ? (
              <p className="truncate text-rose-700 dark:text-rose-300" title={stage.issues.join('\n')}>{stage.issues[0]}</p>
            ) : null}
          </>
        ) : null}
        {!app && workload ? <WorkloadRow w={workload} /> : null}
        {row.missing ? (
          <p className="line-clamp-3 break-words rounded-md bg-amber-50 px-2 py-1.5 leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-200" title={row.missing}>
            {row.missing}
          </p>
        ) : null}
        {authProblem ? (
          <p className="break-words rounded-md bg-rose-50 px-2 py-1.5 leading-relaxed text-rose-800 dark:bg-rose-500/10 dark:text-rose-200" title="Kargo only updates an Argo CD app that names the stage in kargo.akuity.io/authorized-stage">
            {authProblem}
          </p>
        ) : null}
      </dl>
      <div className="mt-auto flex min-w-0 items-center justify-between gap-2 border-t border-edge-subtle bg-surface-sunken/40 px-3.5 py-1.5 text-[11px]">
        {app ? (
          url ? (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-content-muted hover:text-brand-700 hover:underline dark:hover:text-brand-300" title={`Open ${app.metadata.name} in Argo CD`}>
              <span className="truncate font-mono">{app.metadata.name}</span>
              <IconArrowUpRight />
            </a>
          ) : (
            <span className="truncate font-mono text-content-subtle">{app.metadata.name}</span>
          )
        ) : (
          <span className="truncate text-content-subtle">{stage ? 'Kargo stage only' : 'No Argo CD app'}</span>
        )}
        {stage ? (
          <span className="flex shrink-0 items-center gap-0.5">
            {canRefresh ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act('Refreshed', () => actions.refresh.mutateAsync({ stage: stage.name }))}
                title="Ask Kargo to reconcile this stage now"
                className="rounded px-1.5 py-0.5 font-medium text-content-muted transition-colors hover:bg-surface-raised hover:text-content disabled:opacity-50 pointer-coarse:py-2"
              >
                Refresh
              </button>
            ) : null}
            {kargo!.promotion ? (canAbort ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act('Aborted the promotion on', () => actions.abort.mutateAsync({ promotion: kargo!.promotion! }))}
                title="Abort the promotion running against this stage"
                className="rounded px-1.5 py-0.5 font-semibold text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50 dark:text-rose-300 dark:hover:bg-rose-500/10 pointer-coarse:py-2"
              >
                Abort
              </button>
            ) : null) : onPromote && canPromote ? (
              <button
                type="button"
                onClick={onPromote}
                disabled={kargo!.busyWithOther}
                title={kargo!.busyWithOther ? `Another application's promotion is running in ${stage.name}` : `Promote ${ctx.appName} in ${row.label}`}
                className="rounded px-1.5 py-0.5 font-semibold text-brand-700 transition-colors hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10 pointer-coarse:py-2"
              >
                Promote…
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** The workload's own rollout state: canary step and weight, pause/abort, replicas. */
function WorkloadRow({ w }: { w: WorkloadStatus }) {
  const tone = w.aborted || w.phase === 'Degraded'
    ? 'text-rose-700 dark:text-rose-300'
    : w.paused
      ? 'text-amber-700 dark:text-amber-300'
      : w.phase === 'Progressing'
        ? 'text-indigo-700 dark:text-indigo-300'
        : undefined
  return (
    <Row label={w.kind} title={[`${w.kind} ${w.namespace}/${w.name}`, w.strategy ? `strategy: ${w.strategy}` : '', w.message ?? ''].filter(Boolean).join('\n')}>
      <span className={tone}>{describeWorkload(w)}</span>
    </Row>
  )
}

/** A refused Kargo write is the common case for a viewer — name the permission, not "Failed to fetch". */
function kargoActionError(what: string, stage: string, e: unknown): string {
  const status = (e as { status?: number } | undefined)?.status
  if (status === 403) return `Not allowed to change ${stage} — this needs write access to Kargo in its project.`
  const msg = e instanceof Error ? e.message : String(e)
  if (isAuthorisationError(msg)) return `${stage}: Kargo is not authorised to update the Argo CD app — it must carry kargo.akuity.io/authorized-stage naming this stage.`
  return `${what} ${stage} failed: ${msg}`
}

function PromoteDialog({ env, project, onClose }: { env: KargoEnvironment; project: string | undefined; onClose(): void }) {
  const { stage } = env
  const freight = useKargoFreight(project)
  const candidates = useMemo(() => promotableFreightFor(env, freight.data), [env, freight.data])
  const [choice, setChoice] = useState('')
  const toast = useToast()
  const { promote } = useKargoActions(project)
  const selected = choice || candidates[0]?.id || ''
  const go = async () => {
    if (!selected) return
    try {
      await promote.mutateAsync({ stage: stage.name, freight: selected })
      toast.success(`Promoting ${env.label}`)
      onClose()
    } catch (e) {
      toast.error(kargoActionError('Promoted', stage.name, e))
    }
  }
  return (
    <Modal open onClose={onClose} title={`Promote ${env.label}`}>
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-content-muted">
          Creates a Kargo <code className="font-mono">Promotion</code> of <span className="font-medium text-content">{env.view.app}</span>'s freight into stage{' '}
          <span className="font-mono text-content">{stage.name}</span> in project <span className="font-mono text-content">{project}</span>. Kargo commits the new image
          digest to the environment's overlay and waits for Argo CD to roll it out.
          {env.shape === 'shared' ? ' The stage is shared by the project — only this service changes; the other applications keep what they run.' : ''}
        </p>
        {freight.isLoading ? (
          <Loading>Reading freight…</Loading>
        ) : candidates.length ? (
          <FormField label="Freight" hint="What the upstream stage has verified, newest first.">
            <Select value={selected} onChange={(e) => setChoice(e.currentTarget.value)}>
              {candidates.map((f) => (
                <option key={f.id} value={f.id}>
                  {freightLabel(f)}
                  {freightTags(f) ? ` — ${freightTags(f)}` : ''}
                </option>
              ))}
            </Select>
          </FormField>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            No freight is eligible for <span className="font-mono">{stage.name}</span> yet.
            {stage.upstream?.length
              ? <> It accepts only what <span className="font-mono">{stage.upstream.join(', ')}</span> has verified — promote and verify upstream first, or approve a freight for this stage in Kargo.</>
              : <> Its warehouse has not discovered an image yet — CI publishes one per push to the default branch.</>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void go()} disabled={!selected} loading={promote.isPending}>Promote</Button>
        </div>
      </div>
    </Modal>
  )
}

/** Matched apps that belong to no environment — bootstrap apps, platform singletons. */
function OtherAppsSection({ ctx, titled }: { ctx: Ctx; titled: boolean }) {
  const pub = usePublicUrl()
  const apps = ctx.deployment.unscoped
  return (
    <Section title={titled ? 'Other Argo CD applications' : 'Argo CD applications'} count={apps.length}>
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
        {apps.map((app) => {
          const url = ctx.appUrl(app)
          const rev = app.status.sync.revision
          return (
            <li key={app.metadata.name} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono text-content" title={`${app.metadata.namespace}/${app.metadata.name}`}>
                {url ? <TextLink href={url} mono>{app.metadata.name}</TextLink> : app.metadata.name}
              </span>
              <span className="truncate text-[11px] text-content-subtle" title={workloadNamespace(app)}>ns {workloadNamespace(app)}</span>
              {shortSha(rev) ? <TextLink href={commitUrl(ctx.repoUrl ?? pub(app.spec.source.repoURL), rev)} mono title={rev}>{shortSha(rev)}</TextLink> : null}
              <StatusBadge kind={argoHealthKind(app.status.health.status)} className="px-1.5 py-0 text-[10px]">{app.status.health.status}</StatusBadge>
              <StatusBadge kind={argoSyncKind(app.status.sync.status)} dot={false} className="px-1.5 py-0 text-[10px]">{app.status.sync.status}</StatusBadge>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/* ─────────── deploy frequency ─────────── */

const DAYS = 14

/**
 * Deploys per day per environment over two weeks, from Argo CD's sync
 * history. Stacked columns, one colour per environment, a legend, and a
 * per-day tooltip. Honest when empty: it says when the last deploy was.
 */
function DeployFrequencySection({ events, rows, action }: { events: DeployEvent[]; rows: EnvRow[]; action?: React.ReactNode }) {
  const freq = useMemo(() => deployFrequency(events, DAYS), [events])
  const keys = freq.keys.length ? freq.keys : rows.map((r) => r.key)
  const swatch = envSwatches(keys)
  const labelOf = (k: string) => (k === 'other' ? 'Other' : envLabel(k))
  const max = Math.max(1, ...freq.days.map((d) => d.total))
  const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const perDay = (freq.total / DAYS).toFixed(1)
  return (
    <Section title="Deploy frequency" actions={action ?? <span className="text-[11px] text-content-subtle">last {DAYS} days · UTC</span>}>
      {freq.total === 0 ? (
        <Note title={`No deploys in the last ${DAYS} days`}>
          {freq.last ? `The most recent sync was ${ago(freq.last)}.` : 'Argo CD has no sync history for these applications yet.'}
        </Note>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-semibold tabular-nums text-content">{freq.total}</span>
            <span className="text-[12px] text-content-muted">deploys · {perDay}/day{freq.last ? ` · last ${ago(freq.last)}` : ''}</span>
          </div>
          <div className="mt-3 flex h-20 items-end gap-[2px]" role="img" aria-label={`Deploys per day over the last ${DAYS} days, ${freq.total} in total`}>
            {freq.days.map((d, di) => (
              <div key={d.date} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end">
                <div className="flex w-full flex-col-reverse gap-[2px]" style={{ height: `${(d.total / max) * 100}%` }}>
                  {keys.filter((k) => d.counts[k]).map((k, i, arr) => (
                    <div
                      key={k}
                      className={cn('w-full', swatch[k], i === arr.length - 1 && 'rounded-t-[3px]')}
                      style={{ flexGrow: d.counts[k], minHeight: 3 }}
                    />
                  ))}
                </div>
                {d.total === 0 ? <div className="h-px w-full bg-edge-subtle" /> : null}
                <div
                  className={cn(
                    'pointer-events-none invisible absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[10px] text-white shadow-md group-hover:visible dark:bg-slate-700',
                    // Anchored to the chart's edges so the tooltip never widens the page.
                    di < DAYS / 3 ? 'left-0' : di >= (2 * DAYS) / 3 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                  )}
                >
                  <div className="font-semibold">{fmtDay(d.date)} · {d.total}</div>
                  {keys.filter((k) => d.counts[k]).map((k) => <div key={k}>{labelOf(k)}: {d.counts[k]}</div>)}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-content-subtle">
            <span>{fmtDay(freq.days[0].date)}</span>
            <span>today</span>
          </div>
          <ul className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-content-muted">
            {keys.map((k) => (
              <li key={k} className="inline-flex items-center gap-1.5">
                <span className={cn('size-2 rounded-sm', swatch[k])} aria-hidden />
                {labelOf(k)}
                <span className="tabular-nums text-content-subtle">{freq.days.reduce((n, d) => n + (d.counts[k] ?? 0), 0)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  )
}

/** The Overview tab's compact deploy frequency, linking into this tab. */
export function DeployFrequencyCard({ deployment, onOpen }: { deployment: EntityDeployment; onOpen?(): void }) {
  const events = useMemo(() => deployEvents(deployment), [deployment])
  const rows = useMemo(() => environmentRows(deployment, []), [deployment])
  if (deployment.isLoading) {
    return <Section title="Deploy frequency"><Loading>Reading Argo CD…</Loading></Section>
  }
  if (deployment.isError || !deployment.apps.length) {
    return (
      <Section title="Deploy frequency">
        <Note title={deployment.isError ? 'Argo CD is not reachable' : 'Not deployed through Argo CD'} />
      </Section>
    )
  }
  return (
    <DeployFrequencySection
      events={events}
      rows={rows}
      action={onOpen ? (
        <button type="button" onClick={onOpen} className="inline-flex min-h-8 items-center text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300 pointer-coarse:min-h-11">
          Deployment →
        </button>
      ) : undefined}
    />
  )
}

/* ─────────── sync history ─────────── */

function SyncHistorySection({ ctx }: { ctx: Ctx }) {
  const pub = usePublicUrl()
  const rows = ctx.events.slice(0, 10)
  const keys = [...new Set(ctx.events.map((e) => e.env ?? 'other'))].sort((a, b) => (a === 'other' ? 1 : b === 'other' ? -1 : envOrder(a) - envOrder(b)))
  const swatch = envSwatches(keys)
  const automated = ctx.deployment.apps.some((a) => a.spec.syncPolicy.automated)
  const url = ctx.deployment.primary ? ctx.appUrl(ctx.deployment.primary) : undefined
  return (
    <Section
      title="Sync history"
      count={ctx.events.length || undefined}
      actions={url ? <ActionLink href={url} external>History in Argo CD</ActionLink> : null}
    >
      {rows.length === 0 ? (
        <Note title="No syncs recorded yet">Argo CD records an entry each time an application syncs to a new revision.</Note>
      ) : (
        <>
          <ol className="space-y-2.5">
            {rows.map((r) => {
              const repo = ctx.repoUrl ?? (r.repoURL ? pub(r.repoURL) : undefined)
              const commit = r.revision ? ctx.commits.get(r.revision) : undefined
              const trig = describeTrigger(r, commit?.message)
              return (
                <li key={`${r.app}-${r.id}`} className="flex min-w-0 gap-2.5">
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', swatch[r.env ?? 'other'])} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
                      <span className="font-medium text-content">{r.envLabel}</span>
                      {shortSha(r.revision) ? <TextLink href={commitUrl(repo, r.revision)} mono title={r.revision}>{shortSha(r.revision)}</TextLink> : null}
                      {r.current ? <span className="rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">live</span> : null}
                      <span className="text-[11px] text-content-subtle" title={new Date(r.deployedAt).toLocaleString()}>{ago(r.deployedAt)}</span>
                      {r.durationSecs !== undefined ? <span className="text-[11px] text-content-subtle">· {fmtDuration(r.durationSecs)}</span> : null}
                    </div>
                    <div className="truncate text-[11px] text-content-muted" title={commit?.message}>
                      {[trig.label || null, commit && trig.kind !== 'promotion' ? `${commit.message}${commit.author ? ` — ${commit.author}` : ''}` : null, r.previousRevision && r.previousRevision !== r.revision ? `from ${shortSha(r.previousRevision)}` : null]
                        .filter(Boolean)
                        .join(' · ') || <span className="font-mono text-content-subtle">#{r.id} · {r.app}</span>}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
          <p className="mt-3 border-t border-edge-subtle pt-2.5 text-[11px] leading-relaxed text-content-subtle">
            {automated
              ? 'Rolling back: auto-sync is on, so Argo CD refuses a manual rollback — promote earlier freight in Kargo, or revert the commit.'
              : 'Rolling back: use History and Rollback on the application in Argo CD.'}
          </p>
        </>
      )}
    </Section>
  )
}

/* ─────────── GitOps details ─────────── */

function GitOpsSection({ ctx }: { ctx: Ctx }) {
  const pub = usePublicUrl()
  const choices = ctx.rows.filter((r) => r.app).map((r) => ({ key: r.key, label: r.label, app: r.app! }))
  const primary = ctx.deployment.primary!
  const defaultKey = choices.find((c) => c.app.metadata.name === primary.metadata.name)?.key ?? choices[0]?.key
  const [pick, setPick] = useState<string | undefined>(undefined)
  const sel = choices.find((c) => c.key === (pick ?? defaultKey))
  const app = sel?.app ?? primary
  const src = app.spec.source
  const repoURL = pub(src.repoURL)
  const auto = app.spec.syncPolicy.automated
  const runsIn = workloadNamespace(app)
  const url = ctx.appUrl(app)
  return (
    <Section
      title="GitOps"
      actions={
        <>
          {choices.length > 1 ? (
            <div role="tablist" aria-label="Environment" className="inline-flex rounded-md border border-edge-default bg-surface-sunken/50 p-0.5">
              {choices.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="tab"
                  aria-selected={c.key === sel?.key}
                  onClick={() => setPick(c.key)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium transition-colors pointer-coarse:py-2',
                    c.key === sel?.key ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content',
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
          {url ? <ActionLink href={url} external>Argo CD</ActionLink> : null}
        </>
      }
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[12px] md:grid-cols-2">
        <Fact label="Application"><span className="font-mono">{app.metadata.namespace}/{app.metadata.name}</span></Fact>
        <Fact label="Project">{app.spec.project}</Fact>
        <Fact label="Source" title={repoURL}>
          {repoURL ? <TextLink href={repoURL} mono>{repoURL.replace(/^https?:\/\//, '')}</TextLink> : <span className="text-content-subtle">none</span>}
        </Fact>
        <Fact label="Path"><span className="font-mono">{src.path || '/'}{src.targetRevision ? ` @ ${src.targetRevision}` : ''}</span></Fact>
        <Fact label="Destination">
          <span className="font-mono">{app.spec.destination.name || (app.spec.destination.server === 'https://kubernetes.default.svc' ? 'adhar-controlplane' : app.spec.destination.server)} · {app.spec.destination.namespace || '—'}</span>
        </Fact>
        {runsIn !== app.spec.destination.namespace ? (
          <Fact label="Runs in" title="The manifests set their own namespace"><span className="font-mono">{runsIn}</span></Fact>
        ) : null}
        <Fact label="Sync policy" title={app.spec.syncPolicy.syncOptions.join(', ') || undefined}>
          {auto ? ['Automated', auto.prune ? 'prune' : null, auto.selfHeal ? 'self-heal' : null].filter(Boolean).join(' · ') : 'Manual'}
          {app.spec.syncPolicy.syncOptions.length ? <span className="text-content-subtle"> · {app.spec.syncPolicy.syncOptions.join(', ')}</span> : null}
        </Fact>
        <Fact label="Resources">
          {app.status.resources.total} managed
          {app.status.resources.outOfSync ? <span className="text-amber-700 dark:text-amber-300"> · {app.status.resources.outOfSync} out of sync</span> : null}
          {app.status.resources.unhealthy ? <span className="text-rose-700 dark:text-rose-300"> · {app.status.resources.unhealthy} unhealthy</span> : null}
        </Fact>
        <Fact label="Reconciled" title={app.status.reconciledAt}>{app.status.reconciledAt ? ago(app.status.reconciledAt) : '—'}</Fact>
        {app.status.operationState ? (
          <Fact label="Last operation" title={app.status.operationState.message}>
            {app.status.operationState.phase}
            {app.status.operationState.initiatedBy ? <span className="text-content-subtle"> · by {app.status.operationState.initiatedBy}</span> : null}
            {app.status.operationState.finishedAt ? <span className="text-content-subtle"> · {ago(app.status.operationState.finishedAt)}</span> : null}
          </Fact>
        ) : null}
      </dl>
      {app.status.conditions.length ? (
        <ul className="mt-3 space-y-1.5">
          {app.status.conditions.map((c, i) => (
            <li
              key={`${c.type}-${i}`}
              className={cn(
                'break-words rounded-md px-3 py-2 text-[11px] leading-relaxed',
                /error/i.test(c.type) ? 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200',
              )}
            >
              <span className="font-semibold">{c.type}</span>
              {c.message ? ` — ${c.message}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  )
}

function Fact({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-edge-subtle pb-2 md:border-b-0 md:pb-0">
      <dt className="w-24 shrink-0 text-[11px] font-medium text-content-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-right text-content" title={title}>{children}</dd>
    </div>
  )
}

/* ─────────── endpoints ─────────── */

function EndpointsSection({ name, rows, namespaces, fallback }: { name: string; rows: EnvRow[]; namespaces: string[]; fallback: EntityRoute[] }) {
  const pub = usePublicUrl()
  const env = useEnvironmentRoutes(name, namespaces, namespaces.length > 0)
  const routes = useMemo(() => {
    const seen = new Set<string>()
    const out: EntityRoute[] = []
    for (const r of [...env.routes, ...fallback]) {
      const url = pub(r.url)
      if (seen.has(url)) continue
      seen.add(url)
      out.push(url === r.url ? r : { ...r, url })
    }
    const order = (r: EntityRoute) => {
      const k = routeEnvironment(r, rows)
      const i = rows.findIndex((x) => x.key === k)
      return i < 0 ? rows.length : i
    }
    return out.sort((a, b) => order(a) - order(b) || (a.via === b.via ? 0 : a.via === 'backend' ? -1 : 1) || a.url.localeCompare(b.url))
  }, [env.routes, fallback, rows, pub])
  const loading = namespaces.length > 0 && env.isLoading && routes.length === 0
  const primary = routes[0]
  return (
    <Section title="Endpoints" count={routes.length || undefined}>
      {loading ? (
        <Loading>Reading HTTPRoutes…</Loading>
      ) : routes.length === 0 ? (
        env.isError ? (
          <Note title="Could not read routes">The cluster gateway did not answer; endpoints appear when it does.</Note>
        ) : (
          <Note title="No HTTP endpoint">
            No HTTPRoute or Ingress forwards to a <code className="font-mono">{name}</code> Service
            {namespaces.length ? <> in {namespaces.map((n, i) => <span key={n}>{i ? ', ' : ''}<code className="font-mono">{n}</code></span>)}</> : null}. A worker or library
            legitimately has none.
          </Note>
        )
      ) : (
        <>
          <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
            {routes.map((r) => {
              const k = routeEnvironment(r, rows)
              const row = rows.find((x) => x.key === k)
              const path = r.path && r.path !== '/' ? r.path : ''
              return (
                <li key={r.url} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:flex-nowrap">
                  <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                    <a href={r.url} target="_blank" rel="noreferrer" title={r.url} className="block truncate font-mono text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                      {r.host}
                      {path ? <span className="text-content-muted">{path}</span> : null}
                    </a>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-content-subtle">
                      {row ? (
                        <span className="inline-flex items-center gap-1 font-medium text-content-muted">
                          {row.app ? <span className={cn('size-1.5 rounded-full', DOT[argoHealthKind(row.app.status.health.status)])} title={`${row.label}: ${row.app.status.health.status}`} /> : null}
                          {row.label}
                        </span>
                      ) : null}
                      <span className={r.secure ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>{r.secure ? 'HTTPS' : 'HTTP'}</span>
                      <span className="truncate" title={`${r.kind} ${r.namespace}/${r.name}`}>{r.kind} {r.namespace}/{r.name}</span>
                      <span title={r.via === 'backend' ? `backendRefs → Service/${r.service ?? '?'} — the cluster asserts this link` : 'Matched by route name only — verify it belongs to this service'}>
                        {r.via === 'backend' ? `→ svc/${r.service ?? name}` : 'matched by name'}
                      </span>
                    </div>
                  </div>
                  <CopyButton text={r.url} what="URL copied" />
                  <a href={r.url} target="_blank" rel="noreferrer" className={ACTION}>Open <IconArrowUpRight /></a>
                </li>
              )
            })}
          </ul>
          {primary ? (
            <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-edge-subtle bg-surface-sunken px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-content-muted" title={`curl -fsSI ${primary.url}`}>curl -fsSI {primary.url}</code>
              <CopyButton text={`curl -fsSI ${primary.url}`} what="Command copied" />
            </div>
          ) : null}
        </>
      )}
    </Section>
  )
}

/* ─────────── repository ─────────── */

function RepositorySection({
  ctx,
  repoLoading,
  repoError,
  repoData,
}: {
  ctx: Ctx
  repoLoading: boolean
  repoError: boolean
  repoData?: { repo: { default_branch: string; open_pr_counter?: number; html_url: string; updated_at: string }; commits: Array<{ sha: string; message: string; author: { login: string }; created: string }> }
}) {
  const { repoUrl, repoRef, deployment } = ctx
  const primary = deployment.primary
  const base = repoUrl?.replace(/\.git$/, '').replace(/\/$/, '')
  const branch = repoData?.repo.default_branch ?? primary?.spec.source.targetRevision ?? 'main'
  const last = repoData?.commits[0]
  const prs = repoData?.repo.open_pr_counter
  const deployedRev = primary?.status.sync.revision
  const primaryEnv = ctx.rows.find((r) => r.app && r.app.metadata.name === primary?.metadata.name)?.label
  const devRepo = repoRef ? encodeURIComponent(repoRef.repo) : ''
  const giteaTree = (ref: string) => (base ? (isSha(ref) ? `${base}/src/commit/${ref}` : `${base}/src/branch/${encodeURIComponent(ref)}`) : undefined)
  const browse = (ref: string) => (repoRef ? giteaTree(ref) : base ? `${base}/tree/${encodeURIComponent(ref)}` : undefined)
  const behind = deployedRev && repoData?.commits.length ? repoData.commits.findIndex((c) => c.sha === deployedRev) : -1

  // Images each environment runs, and the registry's newest tags.
  const runningBy = new Map<string, string[]>()
  for (const r of ctx.rows) {
    for (const img of r.app?.status.images ?? []) {
      const d = parseImage(img).digest
      const key = d ?? img
      runningBy.set(key, [...(runningBy.get(key) ?? []), r.label])
    }
  }
  const artifacts = (ctx.artifacts ?? []).filter((a) => a.tags?.length).slice(0, 5)
  const images = [...new Set(deployment.apps.flatMap((a) => a.status.images))]

  return (
    <Section
      title="Repository"
      actions={
        base ? (
          <>
            {repoRef ? <ActionLink href={`/develop?section=prs&repo=${devRepo}`}>Pull requests{prs !== undefined ? ` · ${prs}` : ''}</ActionLink> : null}
            <ActionLink href={base} external>Open repo</ActionLink>
          </>
        ) : null
      }
    >
      {!base ? (
        <Note title="No repository linked">
          Set the <code className="font-mono">adhar.io/source-repo</code> annotation or add a <code className="font-mono">repo</code> link; a service deployed by the
          control plane gets it from its Argo CD source automatically.
        </Note>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
            <Stat label="Default branch">
              <TextLink href={browse(branch)} mono>{branch}</TextLink>
            </Stat>
            <Stat label="Deploy path">
              <span className="font-mono text-content">{primary?.spec.source.path || '—'}</span>
            </Stat>
            <Stat label={primaryEnv ? `In ${primaryEnv.toLowerCase()}` : 'Deployed commit'}>
              {shortSha(deployedRev) ? <TextLink href={commitUrl(base, deployedRev)} mono>{shortSha(deployedRev)}</TextLink> : <span className="text-content-subtle">not deployed</span>}
              {behind > 0 ? <span className="ml-1 text-[11px] text-amber-700 dark:text-amber-300">{behind} behind</span> : null}
            </Stat>
            <Stat label="Open PRs">
              {repoRef ? (
                prs !== undefined ? <a href={`/develop?section=prs&repo=${devRepo}`} className="text-brand-700 hover:underline dark:text-brand-300">{prs}</a> : repoLoading ? '…' : '—'
              ) : <span className="text-content-subtle">not on Gitea</span>}
            </Stat>
          </dl>
          {repoRef ? (
            repoLoading && !repoData ? (
              <Loading>Reading Gitea…</Loading>
            ) : repoError ? (
              <p className="text-[11px] text-content-subtle">Gitea did not answer — branch and commit details above come from Argo CD.</p>
            ) : last ? (
              <div className="flex min-w-0 items-baseline gap-2 rounded-lg border border-edge-subtle px-3 py-2 text-[12px]">
                <span className="shrink-0 text-[11px] text-content-subtle">Last commit</span>
                <TextLink href={commitUrl(base, last.sha)} mono>{last.sha.slice(0, 7)}</TextLink>
                <span className="min-w-0 flex-1 truncate text-content" title={last.message}>{last.message.split('\n')[0]}</span>
                <span className="hidden shrink-0 text-[11px] text-content-subtle sm:inline">{last.author.login} · {ago(last.created)}</span>
              </div>
            ) : null
          ) : null}
          {artifacts.length ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Images · Harbor</div>
              <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
                {artifacts.map((a) => {
                  const tag = a.tags![0].name
                  const envs = runningBy.get(a.digest) ?? []
                  return (
                    <li key={a.digest} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-[12px]">
                      <span className="min-w-0 truncate font-mono text-content" title={`${tag}\n${a.digest}`}>
                        {isSha(tag) ? <TextLink href={commitUrl(base, tag)} mono>{tag.slice(0, 7)}</TextLink> : tag}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                        {envs.map((e) => <span key={e} className="rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">{e}</span>)}
                      </span>
                      <span className="shrink-0 text-[11px] text-content-subtle" title={a.push_time}>{ago(a.push_time)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : images.length ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Images</div>
              <ul className="space-y-0.5">
                {images.slice(0, 4).map((img) => (
                  <li key={img} className="truncate font-mono text-[11px] text-content-muted" title={img}>{img.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, '@sha256:$1…')}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-edge-subtle bg-surface-sunken px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-content-muted" title={`git clone ${base}.git`}>git clone {base}.git</code>
            <CopyButton text={`git clone ${base}.git`} what="Clone command copied" />
          </div>
        </div>
      )}
    </Section>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</dt>
      <dd className="mt-0.5 truncate">{children}</dd>
    </div>
  )
}

/* ─────────── pipeline runs ─────────── */

const RUN: Record<PipelineRunSummary['state'], { kind: StatusKind; label: string }> = {
  running: { kind: 'progressing', label: 'Running' },
  succeeded: { kind: 'healthy', label: 'Succeeded' },
  failed: { kind: 'failed', label: 'Failed' },
  cancelled: { kind: 'paused', label: 'Cancelled' },
  pending: { kind: 'unknown', label: 'Pending' },
}

const TRIGGER_LABEL: Record<PipelineRunSummary['trigger'], string> = { push: 'push', 'pull-request': 'pull request', manual: 'manual' }

function PipelinesSection({ entity, repoUrl, runsIn }: { entity: Entity; repoUrl?: string; runsIn?: string }) {
  const { runs, isLoading, isError, notInstalled } = usePipelineRuns(entity, repoUrl, true, runsIn)
  const finished = runs.filter((r) => r.state === 'succeeded' || r.state === 'failed')
  const ok = finished.filter((r) => r.state === 'succeeded').length
  const base = repoUrl?.replace(/\.git$/, '').replace(/\/$/, '')
  const navigate = useNavigate()
  // Builds (Develop) opens the run's drawer from `?run=<namespace>/<name>`.
  const openRun = (r: PipelineRunSummary) =>
    void navigate({ to: '/develop', search: { section: 'builds', run: `${r.namespace}/${r.name}` } as never })
  return (
    <Section
      title="Pipeline runs"
      count={runs.length || undefined}
      actions={
        <>
          {finished.length ? <span className="text-[11px] text-content-muted">{ok}/{finished.length} succeeded</span> : null}
          <ActionLink href="/develop?section=builds">Builds</ActionLink>
        </>
      }
    >
      {isLoading ? (
        <Loading>Reading Tekton PipelineRuns…</Loading>
      ) : notInstalled ? (
        <Note title="Tekton is not installed on this cluster">Pipeline runs appear here once the CI package is enabled.</Note>
      ) : isError ? (
        <Note title="Could not read PipelineRuns">The cluster gateway did not answer; runs appear when it does.</Note>
      ) : runs.length === 0 ? (
        <Note title="No runs yet">
          A push to the default branch of <code className="font-mono">{entity.metadata.name}</code>'s repository starts the platform's{' '}
          <code className="font-mono">app-ci</code> pipeline (test, build, scan, sign, publish to Harbor); a pull request labelled{' '}
          <code className="font-mono">preview</code> starts a preview build. Tekton prunes old runs, so an idle service can show none.
        </Note>
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
          {runs.map((r) => (
            <li
              key={`${r.namespace}/${r.name}`}
              role="link"
              tabIndex={0}
              title={`Open build ${r.name}`}
              onClick={() => openRun(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openRun(r)
                }
              }}
              className="flex min-w-0 cursor-pointer items-start gap-3 px-3 py-2 transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
            >
              <span className="mt-0.5 w-[5.5rem] shrink-0">
                <StatusBadge kind={RUN[r.state].kind} className="px-1.5 py-0 text-[10px]">{RUN[r.state].label}</StatusBadge>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
                  {r.commit ? (
                    // The commit opens in Gitea; the rest of the row opens the build.
                    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <TextLink href={commitUrl(base, r.commit)} mono title={r.commit}>{r.commit.slice(0, 7)}</TextLink>
                    </span>
                  ) : null}
                  <span className="rounded bg-surface-sunken px-1 text-[10px] text-content-muted">{TRIGGER_LABEL[r.trigger]}</span>
                  {r.branch ? <span className="max-w-[12rem] truncate rounded bg-surface-sunken px-1 font-mono text-[10px] text-content-muted" title={r.branch}>{r.branch}</span> : null}
                  <span className="min-w-0 truncate font-mono text-[11px] text-content-subtle" title={`${r.namespace}/${r.name}`}>{r.name}</span>
                </div>
                <div className="truncate text-[11px] text-content-muted" title={r.message}>
                  {[r.pipeline, r.tasks ? describeProgress(r.tasks) : null, r.state === 'failed' && !r.tasks && r.message ? r.message : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="shrink-0 text-right text-[11px] text-content-muted">
                <div title={r.startedAt}>{ago(r.startedAt) || '—'}</div>
                <div className="font-mono text-[10px] text-content-subtle">{fmtDuration(r.durationSecs)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/* ─────────── observability ─────────── */

function MonitoringSection({
  entity,
  rows,
  namespaces,
  monitorUrl,
  onMetrics,
}: {
  entity: Entity
  rows: EnvRow[]
  namespaces: string[]
  monitorUrl?: string
  onMetrics?(): void
}) {
  const grafana = useToolPublicUrl('grafana')
  const a = entity.metadata.annotations ?? {}
  const name = entity.metadata.name
  const workload = a['adhar.io/workload'] ?? name
  const composed = rows.some((r) => r.app?.metadata.labels['adhar.io/application'])
  // Annotations are author-controlled (catalog-info.yaml) and go straight
  // into hrefs: only plain web links survive.
  const safe = (u: string | undefined) => (isSafeLinkUrl(u) ? u : undefined)
  const pinned = safe((entity.metadata.links ?? []).find((l) => l.icon === 'dashboard')?.url ?? a['adhar.io/dashboard'] ?? a['backstage.io/dashboard'])
  const runbook = safe((entity.metadata.links ?? []).find((l) => l.icon === 'runbook')?.url ?? a['adhar.io/runbook'] ?? a['backstage.io/runbook'])
  // Alerts are scoped to where the service RUNS — the environments'
  // namespaces or an explicit adhar.io/namespace — never the catalog grouping.
  const scope = useMemo(() => {
    const declared = (a['adhar.io/namespace'] ?? '').trim()
    return [...new Set([...namespaces, ...(declared ? [declared] : [])])]
  }, [namespaces, a])
  const alertsQ = useDiscoverAlerts()
  const mine = useMemo(
    () => (alertsQ.data ?? []).filter((al) => al.state !== 'resolved' && alertMatches(al.labels, workload, scope)),
    [alertsQ.data, workload, scope],
  )
  const firing = mine.filter((al) => al.state === 'firing')
  const sev: Record<string, string> = { critical: 'bg-rose-500', warning: 'bg-amber-500', info: 'bg-sky-500' }
  const alertsError = alertsQ.isError && !alertsQ.data

  const dashboards: Array<{ label: string; url: string }> = []
  if (pinned) dashboards.push({ label: 'Dashboard', url: pinned })
  if (composed && grafana) {
    for (const r of rows.filter((x) => x.app)) {
      const u = appDashboardUrl(grafana, name, r.key)
      if (u) dashboards.push({ label: `${r.label} dashboard`, url: u })
    }
  } else if (grafana && rows.some((r) => r.app && r.namespace)) {
    for (const r of rows.filter((x) => x.app && x.namespace)) {
      const u = workloadDashboardUrl(grafana, workload, r.namespace)
      if (u) dashboards.push({ label: `${r.label} workload`, url: u })
    }
  } else if (monitorUrl && !pinned) {
    dashboards.push({ label: 'Workload dashboard', url: monitorUrl })
  }

  return (
    <Section
      title="Observability"
      actions={
        <>
          {alertsQ.isLoading || alertsError ? null : mine.length ? (
            <StatusBadge kind={firing.some((al) => al.severity === 'critical') ? 'failed' : firing.length ? 'degraded' : 'paused'} className="px-1.5 py-0 text-[10px]">
              {firing.length ? `${firing.length} firing` : `${mine.length} pending`}
            </StatusBadge>
          ) : (
            <StatusBadge kind="healthy" dot={false} className="px-1.5 py-0 text-[10px]">No alerts</StatusBadge>
          )}
          <ActionLink href="/discover?section=alerts">All alerts</ActionLink>
        </>
      }
    >
      <div className="space-y-3">
        {alertsQ.isLoading ? (
          <Loading>Reading Alertmanager…</Loading>
        ) : alertsError ? (
          <p className="text-[12px] text-content-muted">Alertmanager is not reachable — alert state is unknown, not clear.</p>
        ) : mine.length ? (
          <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle">
            {mine.slice(0, 5).map((al) => (
              <li key={al.fingerprint} className="flex min-w-0 items-start gap-3 px-3 py-2">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', sev[al.severity] ?? 'bg-slate-400', al.state === 'pending' && 'opacity-60')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px]">
                    <span className="font-medium text-content">{al.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-content-subtle">{al.severity} · {al.state}</span>
                    {al.labels.namespace ? <span className="font-mono text-[10px] text-content-subtle">{al.labels.namespace}</span> : null}
                    <span className="text-[10px] text-content-subtle">since {ago(al.startsAt) || '—'}</span>
                  </div>
                  {al.summary || al.description ? <div className="mt-0.5 text-[11px] leading-relaxed text-content-muted">{al.summary ?? al.description}</div> : null}
                </div>
                {isSafeLinkUrl(al.runbook_url) ? <TextLink href={al.runbook_url}>Runbook</TextLink> : null}
              </li>
            ))}
            {mine.length > 5 ? <li className="px-3 py-1.5 text-[11px] text-content-subtle">+{mine.length - 5} more</li> : null}
          </ul>
        ) : (
          <p className="text-[12px] text-content-muted">
            No alerts firing or pending for <span className="font-mono text-content">{workload}</span>
            {scope.length ? <> in {scope.join(', ')}</> : null}.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {dashboards.map((d) => <ActionLink key={d.url} href={d.url} external>{d.label}</ActionLink>)}
          {onMetrics ? (
            <button type="button" onClick={onMetrics} className={ACTION}>Live metrics</button>
          ) : null}
          {runbook ? <ActionLink href={runbook} external>Runbook</ActionLink> : null}
          <ActionLink href="/discover?section=slos">SLOs</ActionLink>
        </div>
        {a['adhar.io/slo'] || a['adhar.io/alerts'] || a['adhar.io/alerting'] ? (
          <dl className="grid grid-cols-2 gap-3 text-[12px]">
            {a['adhar.io/slo'] ? <Stat label="SLO target"><span className="text-content">{a['adhar.io/slo']}</span></Stat> : null}
            {a['adhar.io/alerts'] || a['adhar.io/alerting'] ? <Stat label="Alerting"><span className="text-content">{a['adhar.io/alerts'] ?? a['adhar.io/alerting']}</span></Stat> : null}
          </dl>
        ) : null}
        {!runbook ? (
          <p className="text-[11px] text-content-subtle">
            Add a runbook link (<code className="font-mono">adhar.io/runbook</code>) so on-call can go from an alert to the procedure in one click.
          </p>
        ) : null}
      </div>
    </Section>
  )
}

/* ─────────── icons ─────────── */

function IconArrowUpRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  )
}

function IconCopy() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
