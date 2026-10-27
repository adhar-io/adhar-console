import { type ReactNode, useMemo, useState } from 'react'
import {
  canResource,
  EmptyState,
  LogConsole,
  Spinner,
  StatusBadge,
  type StatusKind,
  type TabDef,
  Tabs,
  TimeSeriesChart,
  useAccessReview,
  useLogStream,
  usePublicBaseDomain,
  useToast,
  useToolPublicUrl,
} from '@adhar/shell-ui'
import { cn, crStatus, formatAbsolute, formatDuration, formatRelative } from '@adhar/utils'
import { CloseButton, Drawer, Segmented } from '../components/list-kit.tsx'
import { usePrometheusReachable } from '../data/perf-metrics.ts'
import {
  useAppBuilds,
  useAutoscalers,
  useDelivery,
  useFunction,
  useFunctionMetrics,
  useFunctionPods,
  useKnativeRoute,
  useKnativeService,
  useNamespaceEvents,
  useRevisions,
} from '../data/functions.ts'
import {
  type ApplicationXR,
  buildRows,
  type BuildState,
  type FunctionCell,
  functionEnvironment,
  functionEvents,
  type FunctionGroup,
  type FunctionState,
  functionState,
  functionTriggers,
  functionUrl,
  type FunctionXR,
  giteaTreeUrl,
  gitopsOwner,
  type GitOpsOwner,
  HEALTH_BADGE,
  isServing,
  type KRevision,
  overlayDir,
  podRows,
  readyDigest,
  repoFromUrl,
  type RepoRef,
  revisionRows,
  runtimeLabel,
  scaleView,
  triggerLabel,
  USER_CONTAINER,
  deliveryRows,
} from '../data/functions-model.ts'
import { ConfigurationTab, DeleteTab, InvokeTab } from './function-ops.tsx'

/**
 * One function, in one environment at a time — the drawer behind every row of
 * Develop → Functions (and Deliver → Functions, which opens it on Delivery).
 *
 * Stability rules, from the other drawers in this module: the drawer is keyed
 * by the function's row, so switching rows resets its state; every read is a
 * live query keyed by namespace + name, so switching environment never shows
 * the previous environment's data; and nothing is fetched for a tab that is
 * not open.
 */

export type FunctionTab =
  | 'overview'
  | 'revisions'
  | 'scale'
  | 'pods'
  | 'metrics'
  | 'events'
  | 'builds'
  | 'delivery'
  | 'invoke'
  | 'config'
  | 'delete'

const ALL_TABS: Array<[FunctionTab, string]> = [
  ['overview', 'Overview'],
  ['revisions', 'Revisions & traffic'],
  ['scale', 'Scale'],
  ['pods', 'Pods & logs'],
  ['metrics', 'Metrics'],
  ['events', 'Events'],
  ['builds', 'Builds'],
  ['delivery', 'Delivery'],
  ['invoke', 'Invoke'],
  ['config', 'Configuration'],
  ['delete', 'Delete'],
]

/** What a function app with nothing deployed yet can show. */
const PENDING_TABS: FunctionTab[] = ['overview', 'builds', 'delivery']

export interface FunctionDrawerProps {
  group: FunctionGroup
  /** The environment's Function to open; the first environment when absent. */
  selected?: { namespace: string; name: string }
  mode: 'develop' | 'delivery'
  tab?: FunctionTab
  /** Every environment column of the page, for the switcher. */
  environments: readonly string[]
  envByNamespace: ReadonlyMap<string, string>
  /** The function's project's own environments, in order, when known. */
  projectEnvironments?: readonly string[]
  applications?: readonly ApplicationXR[]
  onSelect(cell: FunctionCell): void
  onTab(tab: FunctionTab): void
  onClose(): void
}

export function FunctionDrawer(props: FunctionDrawerProps) {
  const { group, selected, mode, envByNamespace, onSelect, onTab, onClose } = props
  const cell = (selected && group.cells.find((c) => c.fn.metadata.namespace === selected.namespace && c.fn.metadata.name === selected.name)) ??
    group.cells[0]
  const ns = cell?.fn.metadata.namespace
  const name = cell?.fn.metadata.name
  const live = useFunction(ns, name)
  const gone = live.data === null
  const fn: FunctionXR | undefined = live.data ?? cell?.fn
  const state = fn ? functionState(fn) : undefined
  const env = fn ? functionEnvironment(fn, envByNamespace) ?? ns : undefined

  const baseDomain = usePublicBaseDomain()
  const giteaPublic = useToolPublicUrl('gitea')
  const app = props.applications?.find((a) => (a.metadata.labels?.['adhar.io/application'] || a.metadata.name) === group.application)
  const repo = repoFromUrl(app?.spec?.parameters?.source?.repoURL, giteaPublic)
  const owner = fn ? gitopsOwner(fn.metadata) : { managed: false }
  const envs = useMemo(() => {
    const list = [...(props.projectEnvironments ?? props.environments)]
    for (const c of group.cells) if (!list.includes(c.env)) list.push(c.env)
    return list
  }, [props.projectEnvironments, props.environments, group.cells])

  const available: FunctionTab[] = cell ? ALL_TABS.map(([id]) => id) : PENDING_TABS
  const fallback: FunctionTab = mode === 'delivery' ? 'delivery' : 'overview'
  const active: FunctionTab = props.tab && available.includes(props.tab) ? props.tab : fallback
  const tabs: TabDef<FunctionTab>[] = ALL_TABS.filter(([id]) => available.includes(id)).map(([id, label]) => ({ id, label }))
  const url = fn ? functionUrl(fn, baseDomain, envByNamespace) : undefined

  return (
    <Drawer
      onClose={onClose}
      width='max-w-5xl'
      widthId='develop.function'
      header={
        <div className='space-y-3'>
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0'>
              <div className='flex flex-wrap items-center gap-2'>
                <h2 className='truncate text-lg font-semibold tracking-tight text-content'>{group.name}</h2>
                {state
                  ? <StatusBadge kind={HEALTH_BADGE[state.health]}>{state.label}</StatusBadge>
                  : <StatusBadge kind='info'>not deployed yet</StatusBadge>}
                {gone ? <StatusBadge kind='failed'>deleted</StatusBadge> : null}
              </div>
              <div className='mt-0.5 truncate text-[12px] text-content-subtle'>
                {[
                  group.application !== group.name ? `app ${group.application}` : null,
                  group.project ? `project ${group.project}` : null,
                  group.team ? `team ${group.team}` : null,
                  runtimeLabel(group.runtime),
                  triggerLabel(group.triggers),
                ].filter(Boolean).join(' · ')}
              </div>
              {url?.url ? <UrlLine url={url.url} derived={url.derived} clusterOnly={url.clusterOnly} /> : null}
            </div>
            <CloseButton onClick={onClose} />
          </div>
          {group.cells.length
            ? (
              <div className='flex flex-wrap items-center gap-1.5' role='tablist' aria-label='Environment'>
                {envs.map((e) => {
                  const c = group.cells.find((x) => x.env === e)
                  const on = c && c === cell
                  return (
                    <button
                      key={e}
                      type='button'
                      role='tab'
                      aria-selected={Boolean(on)}
                      disabled={!c}
                      onClick={() => c && onSelect(c)}
                      title={c ? `${c.state.label} — ${c.fn.metadata.namespace}/${c.fn.metadata.name}` : `Not deployed to ${e}`}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors',
                        on
                          ? 'border-content bg-surface-sunken text-content'
                          : c
                          ? 'border-edge-default text-content-muted hover:border-edge-strong hover:text-content'
                          : 'cursor-not-allowed border-dashed border-edge-default text-content-subtle opacity-60',
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', c ? DOT[c.state.health] : 'bg-content-subtle/40')} />
                      <span className='capitalize'>{e}</span>
                    </button>
                  )
                })}
              </div>
            )
            : null}
        </div>
      }
    >
      <Tabs<FunctionTab> ariaLabel='Function' value={active} onChange={onTab} tabs={tabs}>
        {(t) => (
          <div className='pt-4'>
            {!cell || !fn || !state
              ? t === 'overview'
                ? <PendingOverview group={group} app={app} repo={repo} />
                : t === 'builds'
                ? <BuildsTab app={group.application} />
                : <DeliveryTab app={group.application} project={group.project} envs={envs} group={group} />
              : gone && t !== 'builds' && t !== 'delivery'
              ? (
                <EmptyState
                  title='This function no longer exists'
                  description={`${ns}/${name} was deleted — by its application, by Git, or from here. Its builds and promotion history are still under Builds and Delivery.`}
                />
              )
              : t === 'overview'
              ? <OverviewTab fn={fn} state={state} env={env} repo={repo} owner={owner} baseDomain={baseDomain} envByNamespace={envByNamespace} />
              : t === 'revisions'
              ? <RevisionsTab fn={fn} />
              : t === 'scale'
              ? <ScaleTab fn={fn} state={state} />
              : t === 'pods'
              ? <PodsTab fn={fn} />
              : t === 'metrics'
              ? <MetricsTab fn={fn} />
              : t === 'events'
              ? <EventsTab fn={fn} />
              : t === 'builds'
              ? <BuildsTab app={group.application} />
              : t === 'delivery'
              ? <DeliveryTab app={group.application} project={group.project} envs={envs} group={group} />
              : t === 'invoke'
              ? <InvokeTab fn={fn} state={state} />
              : t === 'config'
              ? <ConfigurationTab fn={fn} env={env} repo={repo} owner={owner} app={app} />
              : <DeleteTab fn={fn} owner={owner} application={group.application} cells={group.cells.length} onDeleted={onClose} />}
          </div>
        )}
      </Tabs>
    </Drawer>
  )
}

/* ─────────────────────────── shared bits ─────────────────────────── */

const DOT: Record<FunctionState['health'], string> = {
  ready: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  deploying: 'bg-sky-500',
  failed: 'bg-rose-500',
  deleting: 'bg-sky-500',
  unknown: 'bg-content-subtle',
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className='space-y-2'>
      <div className='flex items-center justify-between gap-2'>
        <h3 className='text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '')
  return (
    <dl className='grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border border-edge-default bg-surface-raised p-4 text-[13px] sm:grid-cols-[11rem_1fr]'>
      {shown.map(([k, v]) => (
        <div key={k} className='contents'>
          <dt className='text-content-subtle'>{k}</dt>
          <dd className='min-w-0 break-words text-content [overflow-wrap:anywhere]'>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'zero'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-[12px] leading-relaxed',
        tone === 'warn'
          ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200'
          : tone === 'zero'
          ? 'border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-500/25 dark:bg-violet-500/10 dark:text-violet-200'
          : 'border-edge-default bg-surface-sunken text-content-muted',
      )}
    >
      {children}
    </div>
  )
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const external = /^https?:/.test(href)
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className='text-brand-700 hover:underline dark:text-brand-300'
    >
      {children}
      {external ? ' ↗' : ''}
    </a>
  )
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const toast = useToast()
  return (
    <button
      type='button'
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => toast.success('Copied'),
          (e: Error) => toast.error('Could not copy', { description: e.message }),
        )}
      className='rounded px-1.5 py-0.5 text-[11px] font-medium text-content-subtle hover:bg-surface-sunken hover:text-content'
    >
      {label}
    </button>
  )
}

function UrlLine({ url, derived, clusterOnly }: { url: string; derived: boolean; clusterOnly: boolean }) {
  return (
    <div className='mt-1 flex min-w-0 items-center gap-1 text-[12px]'>
      {clusterOnly
        ? <span className='truncate font-mono text-content-muted' title='Reachable only inside the cluster'>{url}</span>
        : (
          <a href={url} target='_blank' rel='noreferrer' className='truncate font-mono text-brand-700 hover:underline dark:text-brand-300'>
            {url}
          </a>
        )}
      <CopyButton text={url} />
      {derived ? <span className='text-[11px] text-content-subtle' title='The platform has not published status.url yet — this is the route it publishes functions on.'>(expected)</span> : null}
      {clusterOnly ? <span className='text-[11px] text-content-subtle'>(cluster only)</span> : null}
    </div>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className='flex items-center gap-2 py-6 text-[13px] text-content-subtle'>
      <Spinner size={12} /> {label}
    </div>
  )
}

function ErrorLine({ error }: { error: unknown }) {
  return <Note tone='warn'>{error instanceof Error ? error.message : String(error)}</Note>
}

const TABLE = 'min-w-full text-[12px]'
const TH = 'px-3 py-2 text-left font-medium text-content-subtle'
const TD = 'px-3 py-2 align-top'

/* ─────────────────────────── Overview ─────────────────────────── */

function OverviewTab({
  fn,
  state,
  env,
  repo,
  owner,
  baseDomain,
  envByNamespace,
}: {
  fn: FunctionXR
  state: FunctionState
  env?: string
  repo?: RepoRef
  owner: GitOpsOwner
  baseDomain: string
  envByNamespace: ReadonlyMap<string, string>
}) {
  const p = fn.spec?.parameters ?? {}
  const ns = fn.metadata.namespace ?? ''
  const revs = useRevisions(ns, fn.metadata.name)
  const digest = readyDigest(fn, revs.data?.items)
  const url = functionUrl(fn, baseDomain, envByNamespace)
  const labels = fn.metadata.labels ?? {}
  const conditions = fn.status?.conditions ?? []
  const triggers = Array.isArray(p.triggers) && p.triggers.length ? p.triggers : undefined
  return (
    <div className='space-y-5'>
      <div className='flex items-start gap-3 rounded-xl border border-edge-default bg-surface-raised p-4'>
        <StatusBadge kind={HEALTH_BADGE[state.health]}>{state.label}</StatusBadge>
        <div className='min-w-0 text-[13px] text-content'>
          {state.message ?? (state.health === 'ready' ? 'Serving.' : 'No message from the control plane.')}
          {state.issues.length > 1
            ? <ul className='mt-1 list-disc pl-4 text-[12px] text-content-muted'>{state.issues.map((i) => <li key={i}>{i}</li>)}</ul>
            : null}
        </div>
      </div>

      <Section title='Function'>
        <Facts
          rows={[
            ['URL', url.url ? <span className='font-mono text-[12px]'>{url.url}{url.derived ? ' (expected — not reported yet)' : ''}</span> : 'Not published yet'],
            ['In-cluster address', fn.status?.address ? <span className='font-mono text-[12px]'>{fn.status.address}</span> : undefined],
            ['Environment', env ? <span className='capitalize'>{env}</span> : 'none'],
            ['Namespace', <span className='font-mono text-[12px]'>{ns}</span>],
            ['Runtime', runtimeLabel(p.runtime)],
            ['Triggers', `${triggerLabel(functionTriggers(fn))}${!triggers && p.eventSource ? ` · ${p.eventSource}` : ''}`],
            ['Port', String(p.port ?? 8080)],
            ['Scale', `${p.minScale ?? 0}–${p.maxScale ?? 20} pods${(p.minScale ?? 0) === 0 ? ' (scales to zero when idle)' : ''}`],
            ['Concurrency', `target ${p.targetConcurrency ?? 100} in-flight per pod (soft) · limit ${p.containerConcurrency ? p.containerConcurrency : 'unlimited'}`],
            ['Timeout', `${p.timeoutSeconds ?? 30}s per request`],
            ['Visibility', p.visibility === 'cluster' ? 'cluster only' : 'public, through the platform Gateway'],
            ['Image', p.image ? <span className='font-mono text-[12px]'>{p.image}</span> : '—'],
            ['Image digest', digest ? <span className='font-mono text-[12px]' title='As Knative resolved the tag when the ready revision was created'>{digest}</span> : undefined],
            ['Ready revision', fn.status?.readyRevision ? <span className='font-mono text-[12px]'>{fn.status.readyRevision}</span> : 'none yet'],
            ['Latest revision', fn.status?.latestRevision && fn.status.latestRevision !== fn.status.readyRevision ? <span className='font-mono text-[12px]'>{fn.status.latestRevision} (not ready)</span> : undefined],
            ['Dapr', p.dapr?.enabled ? `sidecar on${p.dapr.appPort ? `, app port ${p.dapr.appPort}` : ''}` : undefined],
          ]}
        />
      </Section>

      {triggers || fn.status?.triggers?.length
        ? (
          <Section title='Event triggers'>
            <div className='overflow-x-auto rounded-xl border border-edge-default'>
              <table className={TABLE}>
                <thead className='bg-surface-muted'>
                  <tr><th className={TH}>Trigger</th><th className={TH}>Source</th><th className={TH}>Ready</th><th className={TH}>Message</th></tr>
                </thead>
                <tbody className='divide-y divide-edge-subtle'>
                  {(triggers ?? []).map((t, i) => {
                    const st = fn.status?.triggers?.find((s) => s.name === t.name) ?? fn.status?.triggers?.[i]
                    return (
                      <tr key={t.name ?? i}>
                        <td className={TD}>{t.name ?? `${t.type}-${i}`} <span className='text-content-subtle'>({t.type})</span></td>
                        <td className={cn(TD, 'font-mono')}>{t.schedule ?? t.topic ?? (t.filter ? Object.entries(t.filter).map(([k, v]) => `${k}=${v}`).join(', ') : t.bucket) ?? '—'}</td>
                        <td className={TD}>{st?.ready ?? '—'}</td>
                        <td className={cn(TD, 'text-content-muted')}>{st?.message ?? ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        )
        : null}

      <Section title='Ownership'>
        <Facts
          rows={[
            ['Source repository', repo?.webUrl ? <ExternalLink href={repo.webUrl}>{`${repo.org}/${repo.repo}`}</ExternalLink> : repo ? `${repo.org}/${repo.repo}` : 'Unknown — no Application XR names one'],
            ['Deployed from', repo?.webUrl && env ? <ExternalLink href={giteaTreeUrl(repo.webUrl, 'main', overlayDir(env))}>{overlayDir(env)}</ExternalLink> : undefined],
            ['GitOps', owner.managed
              ? owner.argoApp ? <ExternalLink href={`/deliver?section=apps&app=${encodeURIComponent(owner.argoApp)}`}>{`Argo CD application ${owner.argoApp}`}</ExternalLink> : 'Managed by Argo CD'
              : 'Not managed from Git'],
            ['Team', labels['adhar.io/team'] ?? p.team],
            ['Project', labels['adhar.io/project'] ?? p.project],
            ['Organisation', labels['adhar.io/organisation'] ?? p.organisation],
            ['Created', fn.metadata.creationTimestamp ? `${formatRelative(fn.metadata.creationTimestamp)} (${formatAbsolute(fn.metadata.creationTimestamp)})` : undefined],
          ]}
        />
      </Section>

      <Section title='Conditions'>
        {conditions.length
          ? (
            <div className='overflow-x-auto rounded-xl border border-edge-default'>
              <table className={TABLE}>
                <thead className='bg-surface-muted'>
                  <tr><th className={TH}>Type</th><th className={TH}>Status</th><th className={TH}>Reason</th><th className={TH}>Message</th><th className={TH}>Since</th></tr>
                </thead>
                <tbody className='divide-y divide-edge-subtle'>
                  {conditions.map((c) => (
                    <tr key={c.type}>
                      <td className={cn(TD, 'font-medium')}>{c.type}</td>
                      <td className={TD}><StatusBadge kind={c.status === 'True' ? 'healthy' : c.status === 'False' ? 'failed' : 'unknown'}>{c.status ?? '—'}</StatusBadge></td>
                      <td className={TD}>{c.reason ?? ''}</td>
                      <td className={cn(TD, 'max-w-md text-content-muted [overflow-wrap:anywhere]')}>{c.message ?? ''}</td>
                      <td className={cn(TD, 'whitespace-nowrap text-content-subtle')}>{c.lastTransitionTime ? formatRelative(c.lastTransitionTime) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <Note>No conditions reported yet — the control plane has not reconciled this Function.</Note>}
      </Section>
    </div>
  )
}

function PendingOverview({ group, app, repo }: { group: FunctionGroup; app?: ApplicationXR; repo?: RepoRef }) {
  const st = app ? crStatus(app) : undefined
  return (
    <div className='space-y-4'>
      <Note>
        <strong className='font-semibold'>{group.application}</strong> is a function application with nothing deployed yet. Its
        first build (app-ci) has to pass its gates and be promoted to the first environment; the control plane then creates the
        Function from the repository’s <span className='font-mono'>deploy/envs/&lt;env&gt;</span> overlay and it appears here.
      </Note>
      <Facts
        rows={[
          ['Application', app ? <span className='font-mono text-[12px]'>{app.metadata.name}</span> : group.application],
          ['Application status', st ? `${st.label}${st.message ? ` — ${st.message}` : ''}` : undefined],
          ['Source repository', repo?.webUrl ? <ExternalLink href={repo.webUrl}>{`${repo.org}/${repo.repo}`}</ExternalLink> : undefined],
          ['Project', group.project],
          ['Deploy status', <ExternalLink href={`/catalog?entity=${encodeURIComponent(`component:${group.application}`)}&tab=deploy`}>Open the catalog’s Deploy tab</ExternalLink>],
        ]}
      />
    </div>
  )
}

/* ─────────────────────────── Revisions & traffic ─────────────────────────── */

function RevisionsTab({ fn }: { fn: FunctionXR }) {
  const ns = fn.metadata.namespace ?? ''
  const name = fn.metadata.name
  const revs = useRevisions(ns, name)
  const route = useKnativeRoute(ns, name)
  const ksvc = useKnativeService(ns, name)
  const traffic = route.data?.status?.traffic ?? ksvc.data?.status?.traffic
  const rows = useMemo(
    () => revisionRows(revs.data?.items ?? [], traffic, { readyRevision: fn.status?.readyRevision, latestRevision: fn.status?.latestRevision }),
    [revs.data, traffic, fn.status?.readyRevision, fn.status?.latestRevision],
  )
  if (revs.isLoading) return <Loading label='Loading revisions…' />
  if (revs.isError) return <ErrorLine error={revs.error} />
  if (revs.data?.forbidden) return <Note tone='warn'>You may not list Knative revisions in {ns}.</Note>
  if (!rows.length) {
    return <Note>No revisions yet. Knative creates one each time the function’s image or configuration changes — the first appears when its Knative Service is admitted.</Note>
  }
  const serving = rows.filter((r) => r.percent > 0)
  return (
    <div className='space-y-4'>
      <Section title='Traffic'>
        {serving.length
          ? (
            <div className='space-y-1.5'>
              <div className='flex h-3 overflow-hidden rounded-full bg-surface-sunken'>
                {serving.map((r, i) => (
                  <div
                    key={r.name}
                    title={`${r.name}: ${r.percent}%`}
                    className={cn('h-full', ['bg-brand-500', 'bg-violet-500', 'bg-amber-500', 'bg-emerald-500'][i % 4])}
                    style={{ width: `${Math.min(100, r.percent)}%` }}
                  />
                ))}
              </div>
              <div className='flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-content-muted'>
                {serving.map((r) => <span key={r.name}><span className='font-mono'>{r.name}</span> {r.percent}%{r.tags.length ? ` (${r.tags.join(', ')})` : ''}</span>)}
              </div>
            </div>
          )
          : <Note tone='warn'>No revision is receiving traffic — the Route has not resolved a ready revision.</Note>}
      </Section>
      <Section title='Revisions'>
        <div className='overflow-x-auto rounded-xl border border-edge-default'>
          <table className={TABLE}>
            <thead className='bg-surface-muted'>
              <tr><th className={TH}>Revision</th><th className={TH}>Created</th><th className={TH}>Image</th><th className={TH}>Ready</th><th className={TH}>Traffic</th></tr>
            </thead>
            <tbody className='divide-y divide-edge-subtle'>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className={TD}>
                    <span className='font-mono'>{r.name}</span>
                    <div className='mt-0.5 flex flex-wrap gap-1'>
                      {r.current ? <StatusBadge kind='healthy'>serving</StatusBadge> : null}
                      {r.latest && !r.current ? <StatusBadge kind='info'>latest</StatusBadge> : null}
                      {r.tags.map((t) => <StatusBadge key={t} kind='unknown'>{t}</StatusBadge>)}
                    </div>
                  </td>
                  <td className={cn(TD, 'whitespace-nowrap text-content-subtle')} title={r.created ? formatAbsolute(r.created) : ''}>{r.created ? formatRelative(r.created) : '—'}</td>
                  <td className={cn(TD, 'font-mono [overflow-wrap:anywhere]')}>
                    {r.image ?? '—'}
                    {r.digest ? <div className='text-[11px] text-content-subtle'>{r.digest.slice(0, 19)}…</div> : null}
                  </td>
                  <td className={TD}>
                    <StatusBadge kind={r.ready === 'True' ? 'healthy' : r.ready === 'False' ? 'failed' : 'progressing'}>{r.ready === 'True' ? 'Ready' : r.reason ?? r.ready}</StatusBadge>
                    {r.ready === 'False' && r.message ? <div className='mt-1 max-w-xs text-[11px] text-content-muted [overflow-wrap:anywhere]'>{r.message}</div> : null}
                  </td>
                  <td className={cn(TD, 'tabular-nums')}>{r.percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}

/* ─────────────────────────── Scale ─────────────────────────── */

function ScaleTab({ fn, state }: { fn: FunctionXR; state: FunctionState }) {
  const ns = fn.metadata.namespace ?? ''
  const name = fn.metadata.name
  const pas = useAutoscalers(ns, name)
  const pods = useFunctionPods(ns, name)
  const view = scaleView(fn, {
    autoscalers: pas.data?.forbidden ? undefined : pas.data?.items,
    pods: pods.data?.forbidden ? undefined : pods.data?.items,
    serving: isServing(state),
  })
  if (pas.isLoading && pods.isLoading) return <Loading label='Reading the autoscaler…' />
  return (
    <div className='space-y-4'>
      {view.scaledToZero
        ? <Note tone='zero'><strong className='font-semibold'>Scaled to zero</strong> — no pod is running. The next request cold-starts one (the activator holds it until the pod is ready).</Note>
        : !isServing(state)
        ? <Note tone='warn'>The function is not serving ({state.label}), so its scale says nothing about traffic yet.</Note>
        : null}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
        <Tile label='Running now' value={view.actual ?? '—'} />
        <Tile label='Wanted' value={view.desired ?? '—'} hint='autoscaler' />
        <Tile label='Ready pods' value={view.ready ?? '—'} />
        <Tile label='Bounds' value={`${view.min}–${view.max}`} hint='min – max' />
        <Tile label='Target' value={view.target} hint='in-flight per pod' />
      </div>
      {pas.data?.forbidden
        ? <Note>Knative’s PodAutoscalers are not readable with your access, so pods are counted instead (a pod about to start is not visible until it exists).</Note>
        : null}
      {pas.data?.items.length
        ? (
          <Section title='Autoscaler per revision'>
            <div className='overflow-x-auto rounded-xl border border-edge-default'>
              <table className={TABLE}>
                <thead className='bg-surface-muted'>
                  <tr><th className={TH}>Revision</th><th className={TH}>Running</th><th className={TH}>Wanted</th><th className={TH}>Reachability</th><th className={TH}>State</th></tr>
                </thead>
                <tbody className='divide-y divide-edge-subtle'>
                  {pas.data.items.map((pa) => {
                    const st = crStatus(pa)
                    const active = pa.status?.conditions?.find((c) => c.type === 'Active')
                    return (
                      <tr key={pa.metadata.name}>
                        <td className={cn(TD, 'font-mono')}>{pa.metadata.name}</td>
                        <td className={cn(TD, 'tabular-nums')}>{pa.status?.actualScale ?? '—'}</td>
                        <td className={cn(TD, 'tabular-nums')}>{pa.status?.desiredScale === undefined || pa.status.desiredScale < 0 ? '—' : pa.status.desiredScale}</td>
                        <td className={TD}>{pa.spec?.reachability ?? '—'}</td>
                        <td className={TD}>
                          <StatusBadge kind={st.health === 'healthy' ? 'healthy' : st.health === 'degraded' ? 'failed' : st.health === 'progressing' ? 'progressing' : 'unknown'}>{st.label}</StatusBadge>
                          {active?.status === 'False' ? <div className='mt-0.5 text-[11px] text-content-subtle'>inactive: {active.reason}</div> : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        )
        : null}
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className='rounded-xl border border-edge-default bg-surface-raised px-3 py-2'>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</div>
      <div className='text-lg font-semibold tabular-nums text-content'>{value}</div>
      <div className='text-[10px] text-content-subtle'>{hint ?? ' '}</div>
    </div>
  )
}

/* ─────────────────────────── Pods & logs ─────────────────────────── */

const PODS = { group: '', resource: 'pods', namespaced: true } as const

function PodsTab({ fn }: { fn: FunctionXR }) {
  const ns = fn.metadata.namespace ?? ''
  const name = fn.metadata.name
  const pods = useFunctionPods(ns, name)
  const rows = useMemo(() => podRows(pods.data?.items ?? []), [pods.data])
  const [pick, setPick] = useState<string>('all')
  const logs = useAccessReview(canResource(PODS, 'get', { namespace: ns, subresource: 'log' }))
  const chosen = pick === 'all' ? rows : rows.filter((r) => r.name === pick)
  const sources = chosen.filter((r) => r.phase !== 'Pending').map((r) => ({ pod: r.name, container: USER_CONTAINER, label: r.name.replace(`${name}-`, '') }))
  const stream = useLogStream({ namespace: ns, sources, follow: true, tailLines: 500, enabled: logs.allowed && sources.length > 0 })

  if (pods.isLoading) return <Loading label='Loading pods…' />
  if (pods.isError) return <ErrorLine error={pods.error} />
  if (pods.data?.forbidden) return <Note tone='warn'>You may not list pods in {ns}.</Note>
  return (
    <div className='space-y-4'>
      {rows.length
        ? (
          <div className='overflow-x-auto rounded-xl border border-edge-default'>
            <table className={TABLE}>
              <thead className='bg-surface-muted'>
                <tr><th className={TH}>Pod</th><th className={TH}>Revision</th><th className={TH}>Phase</th><th className={TH}>Containers</th><th className={TH}>Restarts</th><th className={TH}>Age</th></tr>
              </thead>
              <tbody className='divide-y divide-edge-subtle'>
                {rows.map((r) => (
                  <tr key={r.name} className={cn(pick === r.name && 'bg-surface-sunken')}>
                    <td className={cn(TD, 'font-mono')}>
                      <button type='button' className='text-left hover:underline' onClick={() => setPick(r.name)}>{r.name}</button>
                    </td>
                    <td className={cn(TD, 'font-mono')}>{r.revision ?? '—'}</td>
                    <td className={TD}>
                      <StatusBadge kind={r.ready ? 'healthy' : r.phase === 'Pending' || r.phase === 'Terminating' ? 'progressing' : 'failed'}>{r.reason ?? r.phase}</StatusBadge>
                    </td>
                    <td className={cn(TD, 'tabular-nums')}>{r.containers}</td>
                    <td className={cn(TD, 'tabular-nums', r.restarts > 0 && 'text-amber-700 dark:text-amber-300')}>{r.restarts}</td>
                    <td className={cn(TD, 'whitespace-nowrap text-content-subtle')}>{r.created ? formatRelative(r.created) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : <Note tone='zero'>No pods — the function is scaled to zero (or has not started). Send it a request from the Invoke tab and a pod starts; its logs stream here.</Note>}

      {rows.length
        ? !logs.allowed && !logs.loading
          ? <Note tone='warn'>Reading logs needs <span className='font-mono'>get pods/log</span> in {ns}.</Note>
          : (
            <LogConsole
              lines={stream.lines}
              status={stream.status}
              error={stream.error}
              reconnect={stream.reconnect}
              live={stream.status === 'streaming'}
              filename={`${name}-logs`}
              label={USER_CONTAINER}
              toolbar={
                <select
                  aria-label='Pod'
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  className='max-w-[16rem] rounded border border-code-fg/20 bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-code-fg/80'
                >
                  <option value='all'>All pods ({rows.length})</option>
                  {rows.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
                </select>
              }
              emptyMessage='No output yet from the function container.'
            />
          )
        : null}
    </div>
  )
}

/* ─────────────────────────── Metrics ─────────────────────────── */

const WINDOWS: Array<['1h' | '6h' | '24h', string]> = [['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours']]
const WINDOW_MS = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 24 * 3_600_000 }

function formatValue(unit: string, v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (unit === 'ms') return `${Math.round(v)} ms`
  if (unit === 'req/s') return `${v < 10 ? v.toFixed(2) : Math.round(v)}/s`
  if (unit === 'cores') return v < 1 ? `${Math.round(v * 1000)}m` : v.toFixed(2)
  if (unit === 'bytes') {
    const units = ['B', 'KiB', 'MiB', 'GiB']
    let x = v
    let i = 0
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024
      i++
    }
    return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`
  }
  return String(v)
}

function MetricsTab({ fn }: { fn: FunctionXR }) {
  const [win, setWin] = useState<'1h' | '6h' | '24h'>('1h')
  const prom = usePrometheusReachable()
  const promOk = prom.data?.ok === true
  const panels = useFunctionMetrics(fn.metadata.namespace, fn.metadata.name, WINDOW_MS[win], promOk)
  if (prom.isLoading) return <Loading label='Checking Prometheus…' />
  if (!promOk) return <Note tone='warn'>{prom.data?.reason ?? 'Prometheus is not reachable from the console.'} Metrics cannot be shown.</Note>
  const requestPanels = panels.filter((p) => p.spec.id === 'rps' || p.spec.id === 'errors' || p.spec.id === 'p95')
  const noRequestData = requestPanels.every((p) => !p.loading && !p.points.length)
  return (
    <div className='space-y-4'>
      <div className='flex items-center justify-between gap-2'>
        <div className='w-72'><Segmented value={win} onChange={setWin} options={WINDOWS} /></div>
        <span className='text-[11px] text-content-subtle'>Prometheus · refreshes every minute</span>
      </div>
      {noRequestData
        ? (
          <Note>
            No request metrics for this function in the last {WINDOWS.find(([w]) => w === win)![1]}. Either it served no traffic
            (a function scaled to zero has nothing to report), or Knative’s request metrics are not scraped on this cluster — they come
            from each function pod’s queue-proxy, which needs a PodMonitor.
          </Note>
        )
        : null}
      <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
        {panels.map((p) => (
          <div key={p.spec.id} className='rounded-xl border border-edge-default bg-surface-raised p-3'>
            <div className='mb-1 flex items-baseline justify-between gap-2'>
              <div className='text-[13px] font-semibold text-content'>{p.spec.title}</div>
              <div className='text-[11px] text-content-subtle'>{p.spec.unit}</div>
            </div>
            {p.error
              ? <div className='py-8 text-center text-[12px] text-content-subtle'>{p.error}</div>
              : p.loading
              ? <div className='flex justify-center py-8'><Spinner size={12} /></div>
              : !p.points.length
              ? <div className='py-8 text-center text-[12px] text-content-subtle'>No data</div>
              : <TimeSeriesChart series={[{ name: p.spec.title, points: p.points }]} height={140} formatY={(v) => formatValue(p.spec.unit, v)} />}
            <div className='mt-1 text-[11px] text-content-subtle'>{p.spec.hint}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────── Events ─────────────────────────── */

function EventsTab({ fn }: { fn: FunctionXR }) {
  const ns = fn.metadata.namespace ?? ''
  const q = useNamespaceEvents(ns)
  const rows = useMemo(() => functionEvents(q.data?.items, fn.metadata.name), [q.data, fn.metadata.name])
  if (q.isLoading) return <Loading label='Loading events…' />
  if (q.isError) return <ErrorLine error={q.error} />
  if (q.data?.forbidden) return <Note tone='warn'>You may not list events in {ns}.</Note>
  if (!rows.length) return <Note>No recent events for this function, its revisions or its pods. Kubernetes keeps events for about an hour.</Note>
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default'>
      <table className={TABLE}>
        <thead className='bg-surface-muted'>
          <tr><th className={TH}>Type</th><th className={TH}>Reason</th><th className={TH}>Object</th><th className={TH}>Message</th><th className={TH}>Count</th><th className={TH}>Last seen</th></tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {rows.map((e) => (
            <tr key={e.key}>
              <td className={TD}><StatusBadge kind={e.type === 'Warning' ? 'paused' : 'unknown'}>{e.type}</StatusBadge></td>
              <td className={cn(TD, 'font-medium')}>{e.reason}</td>
              <td className={cn(TD, 'font-mono text-[11px]')}>{e.object}</td>
              <td className={cn(TD, 'max-w-md text-content-muted [overflow-wrap:anywhere]')}>{e.message}</td>
              <td className={cn(TD, 'tabular-nums')}>{e.count}</td>
              <td className={cn(TD, 'whitespace-nowrap text-content-subtle')}>{e.at ? formatRelative(e.at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─────────────────────────── Builds ─────────────────────────── */

const BUILD_BADGE: Record<BuildState, StatusKind> = {
  succeeded: 'healthy',
  failed: 'failed',
  running: 'progressing',
  cancelled: 'paused',
  unknown: 'unknown',
}

function BuildsTab({ app }: { app: string }) {
  const q = useAppBuilds(app)
  const rows = useMemo(() => buildRows(q.data?.items, app), [q.data, app])
  if (q.isLoading) return <Loading label='Loading builds…' />
  if (q.isError) return <ErrorLine error={q.error} />
  if (q.data?.forbidden) return <Note tone='warn'>You may not list Tekton PipelineRuns, so this application’s builds cannot be shown.</Note>
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between text-[12px] text-content-subtle'>
        <span>app-ci runs for <span className='font-mono'>{app}</span> — a push to the repository starts one; a run that passes its gates becomes Kargo freight.</span>
        <ExternalLink href='/develop?section=builds'>All builds</ExternalLink>
      </div>
      {rows.length
        ? (
          <div className='overflow-x-auto rounded-xl border border-edge-default'>
            <table className={TABLE}>
              <thead className='bg-surface-muted'>
                <tr><th className={TH}>Run</th><th className={TH}>Status</th><th className={TH}>Commit</th><th className={TH}>Started</th><th className={TH}>Took</th><th className={TH}>Detail</th></tr>
              </thead>
              <tbody className='divide-y divide-edge-subtle'>
                {rows.slice(0, 25).map((r) => (
                  <tr key={`${r.namespace}/${r.name}`}>
                    <td className={cn(TD, 'font-mono')}><a href={r.href} className='text-brand-700 hover:underline dark:text-brand-300'>{r.name}</a></td>
                    <td className={TD}><StatusBadge kind={BUILD_BADGE[r.state]}>{r.state}</StatusBadge></td>
                    <td className={cn(TD, 'font-mono')}>{r.revision ? r.revision.slice(0, 7) : '—'}</td>
                    <td className={cn(TD, 'whitespace-nowrap text-content-subtle')}>{r.started ? formatRelative(r.started) : '—'}</td>
                    <td className={cn(TD, 'tabular-nums')}>{r.durationMs !== undefined ? formatDuration(r.durationMs) : r.state === 'running' ? 'running…' : '—'}</td>
                    <td className={cn(TD, 'max-w-sm text-content-muted [overflow-wrap:anywhere]')}>{r.message ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : <Note>No builds yet for {app}. The first one starts when the scaffolded repository is pushed (app-ci on the push webhook).</Note>}
    </div>
  )
}

/* ─────────────────────────── Delivery ─────────────────────────── */

function DeliveryTab({ app, project, envs, group }: { app: string; project?: string; envs: readonly string[]; group: FunctionGroup }) {
  const q = useDelivery(project)
  const rows = useMemo(() => deliveryRows(q.stages, q.freight, project, app, envs), [q.stages, q.freight, project, app, envs])
  const deployTab = `/catalog?entity=${encodeURIComponent(`component:${app}`)}&tab=deploy`
  const anyStage = rows.some((r) => r.stage)
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-3 text-[12px]'>
        <a href={deployTab} className='inline-flex h-8 items-center rounded-md bg-brand-600 px-3 font-semibold text-white shadow-sm hover:bg-brand-700 hover:text-white visited:text-white'>
          Promote · open the Deploy tab
        </a>
        <ExternalLink href={`/deliver?section=performance&app=${encodeURIComponent(app)}`}>Performance</ExternalLink>
        <ExternalLink href={`/deliver?section=chaos&app=${encodeURIComponent(app)}`}>Chaos</ExternalLink>
        {project ? <ExternalLink href={`/deliver?section=environments&project=${encodeURIComponent(project)}`}>Project environments</ExternalLink> : null}
      </div>
      {!project
        ? <Note>This function names no project, so it has no promotion chain to show. Functions deployed from a template belong to their application’s project.</Note>
        : q.forbidden
        ? <Note tone='warn'>You may not read Kargo stages in project {project}. The Deploy tab shows what you can see.</Note>
        : q.isLoading
        ? <Loading label='Loading the promotion chain…' />
        : q.error
        ? <ErrorLine error={q.error} />
        : !anyStage
        ? <Note>Project {project} has no Kargo stage that carries {app} yet — the application joins its project’s promotion chain when its Warehouse is created.</Note>
        : (
          <div className='overflow-x-auto rounded-xl border border-edge-default'>
            <table className={TABLE}>
              <thead className='bg-surface-muted'>
                <tr><th className={TH}>Environment</th><th className={TH}>Stage</th><th className={TH}>Running</th><th className={TH}>Last promotion</th><th className={TH}>Verification</th><th className={TH}>Argo CD</th></tr>
              </thead>
              <tbody className='divide-y divide-edge-subtle'>
                {rows.map((r) => {
                  const cell = group.cells.find((c) => c.env === r.env)
                  const argo = cell ? gitopsOwner(cell.fn.metadata).argoApp : undefined
                  return (
                    <tr key={r.env}>
                      <td className={cn(TD, 'font-medium capitalize')}>{r.env}</td>
                      <td className={TD}>
                        {r.stage ? <span className='font-mono'>{r.stage}</span> : <span className='text-content-subtle'>—</span>}
                        {r.stage ? <div className='mt-0.5'><StatusBadge kind={r.phase === 'Steady' ? 'healthy' : r.phase === 'Failed' || r.phase === 'Erroring' ? 'failed' : 'progressing'}>{r.phase ?? 'Unknown'}</StatusBadge></div> : null}
                        {r.promoting ? <div className='mt-0.5 text-[11px] text-sky-700 dark:text-sky-300'>promoting {app}…</div> : null}
                        {r.busyWithOther ? <div className='mt-0.5 text-[11px] text-content-subtle'>busy promoting another app</div> : null}
                      </td>
                      <td className={cn(TD, 'font-mono')}>{r.freight ?? '—'}</td>
                      <td className={TD}>
                        {r.lastPromotionPhase ? <StatusBadge kind={r.lastPromotionPhase === 'Succeeded' ? 'healthy' : /fail|error/i.test(r.lastPromotionPhase) ? 'failed' : 'progressing'}>{r.lastPromotionPhase}</StatusBadge> : '—'}
                        {r.lastPromoted ? <div className='mt-0.5 text-[11px] text-content-subtle'>{formatRelative(r.lastPromoted)}</div> : null}
                      </td>
                      <td className={TD}>{r.verification ?? '—'}</td>
                      <td className={cn(TD, 'font-mono text-[11px]')}>{argo ? <ExternalLink href={`/deliver?section=apps&app=${encodeURIComponent(argo)}`}>{argo}</ExternalLink> : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
