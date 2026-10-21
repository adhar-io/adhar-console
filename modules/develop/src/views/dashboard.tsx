import { useMemo } from 'react'
import { Button, Card, CardBody, CardHeader, EmptyState, StatusBadge } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { coder, gitea } from '@adhar/api-clients'
import { type RepoIssue, type RepoPull, useOrgIssues, useOrgPullRequests, useOrgPullSearch, useRepos } from '../data/git.ts'
import { type DevelopParams, type DevelopSection, itemRef, useGoDevelop } from '../data/nav.ts'
import { useTemplates, useWorkspaces } from '../data/coder.ts'
import { RepoMark } from '../components/repo-picker.tsx'
import { langColor } from '../components/repo-bits.tsx'
import { Avatar, DiffStat, GiteaError, IssueStateIcon, LabelPill, ListSkeleton, prState, PrStateIcon } from '../components/list-kit.tsx'

/**
 * Develop dashboard — the engineering pulse of the org: Gitea (repositories,
 * pull requests, issues) and Coder (cloud environments) in one screen.
 *
 * Everything is a door: each tile opens its section, each repository opens
 * its detail drawer on the Repositories page, and each pull request or issue
 * opens in its own drawer — via `?repo=` / `?pr=` / `?issue=` deep links.
 */
export function Dashboard() {
  const repos = useRepos()
  const prs = useOrgPullRequests('open')
  // The cross-repo search fills the review queue first; the full list follows.
  const quickPrs = useOrgPullSearch('open', !prs.data)
  const issues = useOrgIssues('open')
  const workspaces = useWorkspaces()
  const templates = useTemplates()
  const go = useGoDevelop()

  const repoList = useMemo(() => (repos.data ?? []).filter((r) => !r.archived), [repos.data])
  const prList = prs.data ?? quickPrs.data ?? []
  const prsShown = { isLoading: prs.isLoading && !quickPrs.data, isError: prs.isError && !prs.data && !quickPrs.data }
  const issueList = issues.data ?? []
  const wsList = workspaces.data ?? []
  const tplList = templates.data ?? []

  const prCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of prList) m.set(p.repo, (m.get(p.repo) ?? 0) + 1)
    return m
  }, [prList])

  const languages = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of repoList) if (r.language) m.set(r.language, (m.get(r.language) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [repoList])

  if (repos.isLoading) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the Develop dashboard" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton-shimmer h-20 rounded-xl" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              <div className="border-b border-edge-subtle px-5 py-3"><span className="skeleton-shimmer block h-4 w-40 rounded" /></div>
              <ListSkeleton rows={4} />
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (repos.isError && !repos.data) {
    return <GiteaError what="repositories" error={repos.error} onRetry={() => repos.refetch()} retrying={repos.isFetching} />
  }

  const runningWs = wsList.filter((w) => w.latest_build.status === 'running').length
  const failedWs = wsList.filter((w) => w.latest_build.status === 'failed').length
  const conflicts = prList.filter((p) => p.mergeable === false).length
  const unassigned = issueList.filter((i) => !i.assignees?.length).length
  const weekAgo = Date.now() - 7 * 86_400_000
  const activeRepos = repoList.filter((r) => Date.parse(r.updated_at) > weekAgo).length

  const topRepos = repoList
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 6)
  const reviewQueue = prList
    .slice()
    .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
    .slice(0, 6)
  const recentIssues = issueList
    .slice()
    .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
    .slice(0, 6)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeroStat label="Repositories" value={repoList.length} tone="brand" icon={<IconBranch />} hint={`${activeRepos} active this week`} onClick={() => go('repos')} />
        <HeroStat label="Open PRs" value={shown(prsShown, prList.length)} tone="amber" icon={<IconPr />} hint={prs.isError ? "couldn't load" : conflicts ? `${conflicts} with conflicts` : 'awaiting review'} onClick={() => go('prs', { state: 'open' })} />
        <HeroStat label="Open issues" value={shown(issues, issueList.length)} tone="rose" icon={<IconBug />} hint={issues.isError ? "couldn't load" : `${unassigned} unassigned`} onClick={() => go('issues', { state: 'open' })} />
        <HeroStat label="Cloud envs" value={shown(workspaces, wsList.length)} tone="violet" icon={<IconCloud />} hint={workspaces.isError ? 'Coder unreachable' : `${runningWs} running${failedWs ? ` · ${failedWs} failed` : ''}`} onClick={() => go('environments')} />
        <HeroStat label="Env templates" value={shown(templates, tplList.length)} tone="sky" icon={<IconStack />} hint={templates.isError ? 'Coder unreachable' : 'reusable images'} onClick={() => go('environments')} />
        <HeroStat label="Languages" value={languages.length} tone="emerald" icon={<IconLang />} hint={languages[0] ? `mostly ${languages[0][0]}` : 'across the org'} onClick={() => go('repos')} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Recently active repositories"
          subtitle="Open one for files, branches, PRs, releases and settings"
          count={repoList.length}
          onAll={() => go('repos')}
          allLabel="All repositories"
        >
          {topRepos.length === 0 ? (
            <EmptyState
              compact
              title="No repositories yet"
              description="Repositories in the Gitea org appear here, most recently active first."
              action={<Button size="sm" variant="secondary" onClick={() => go('repos')}>Open Repositories</Button>}
            />
          ) : (
            <ul className="grid grid-cols-1 divide-y divide-edge-subtle sm:grid-cols-2 sm:divide-y-0">
              {topRepos.map((r, i) => (
                <RepoTile key={r.id} repo={r} prs={prCount.get(r.name) ?? 0} border={i >= 2} onOpen={(params) => go('repos', { repo: r.name, ...params })} />
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Languages" subtitle="Primary language per repository" onAll={() => go('repos')} allLabel="Browse">
          <LanguageMix languages={languages} total={repoList.length} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel
          title="Review queue"
          subtitle="Open pull requests across the org, most recently active first"
          count={prs.isError ? undefined : prList.length}
          onAll={() => go('prs', { state: 'open' })}
          allLabel="All pull requests"
        >
          {prsShown.isLoading ? <PanelLoading /> : prsShown.isError ? <SourceError what="pull requests from Gitea" error={prs.error} retry={() => prs.refetch()} /> : reviewQueue.length === 0 ? <EmptyState compact title="Nothing to review" description="No open pull requests." /> : (
            <ul className="divide-y divide-edge-subtle">
              {reviewQueue.map((p) => <PullRow key={`${p.repo}#${p.number}`} pr={p} go={go} />)}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent issues"
          subtitle="Open issues with the latest activity"
          count={issues.isError ? undefined : issueList.length}
          onAll={() => go('issues', { state: 'open' })}
          allLabel="All issues"
        >
          {issues.isLoading ? <PanelLoading /> : issues.isError && !issues.data ? <SourceError what="issues from Gitea" error={issues.error} retry={() => issues.refetch()} /> : recentIssues.length === 0 ? <EmptyState compact title="No open issues" /> : (
            <ul className="divide-y divide-edge-subtle">
              {recentIssues.map((i) => <IssueRow key={`${i.repo}#${i.number}`} issue={i} go={go} />)}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Panel title="Cloud environments" subtitle="Latest build status" count={workspaces.isLoading || workspaces.isError ? undefined : wsList.length} onAll={() => go('environments')} allLabel="All environments">
          {workspaces.isLoading ? <PanelLoading /> : workspaces.isError ? <SourceError what="Coder" error={workspaces.error} retry={() => workspaces.refetch()} /> : wsList.length === 0 ? (
            <EmptyState
              compact
              title="No cloud environments yet"
              description="Workspaces you create in Coder appear here with their latest build status."
              action={<Button size="sm" variant="secondary" onClick={() => go('environments')}>Create one</Button>}
            />
          ) : (
            <ul className="divide-y divide-edge-subtle">
              {wsList.slice(0, 5).map((w) => <WorkspaceRow key={w.id} workspace={w} onOpen={() => go('environments')} />)}
            </ul>
          )}
        </Panel>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-2">
          <QuickStartCard title="Code" description="Repositories, branches and history — and a cloud environment to work in." tone="brand" go={go} links={[['Repositories', 'repos'], ['Branches', 'branches'], ['Commits', 'commits'], ['Cloud Envs', 'environments']]} />
          <QuickStartCard title="Review" description="Pull requests and issues across the org — review, merge and triage." tone="amber" go={go} links={[['Pull requests', 'prs'], ['Issues', 'issues']]} />
          <QuickStartCard title="Run" description="Data pipelines and load tests on the cluster." tone="violet" go={go} links={[['Pipelines', 'pipelines'], ['Performance Center', 'performance']]} />
          <QuickStartCard title="Content" description="Strapi content types, entries, drafts and media for your apps." tone="emerald" go={go} links={[['Content', 'content']]} />
        </div>
      </div>
    </div>
  )
}

type Go = ReturnType<typeof useGoDevelop>

function Panel({ title, subtitle, count, onAll, allLabel, className, children }: {
  title: string
  subtitle?: string
  count?: number
  onAll?(): void
  allLabel?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-content">
              {title}
              {count != null ? <StatusBadge kind="unknown">{count}</StatusBadge> : null}
            </div>
            {subtitle ? <div className="truncate text-[11px] text-content-subtle">{subtitle}</div> : null}
          </div>
          {onAll ? (
            <button type="button" onClick={onAll} className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
              {allLabel ?? 'View all'} <IconArrow />
            </button>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="p-0!">{children}</CardBody>
    </Card>
  )
}

/** "…" while a source loads, "—" when it could not be read — never a made-up 0. */
function shown(q: { isLoading: boolean; isError: boolean }, n: number): number | string {
  return q.isLoading ? '…' : q.isError ? '—' : n
}

function SourceError({ what, error, retry }: { what: string; error: unknown; retry(): void }) {
  return (
    <EmptyState
      compact
      title={`Couldn't load ${what}`}
      description={error instanceof Error ? error.message : String(error ?? 'Unknown error.')}
      action={<Button size="sm" variant="secondary" onClick={retry}>Retry</Button>}
    />
  )
}

function PanelLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <ListSkeleton rows={3} />
    </div>
  )
}

function RepoTile({ repo, prs, border, onOpen }: { repo: gitea.Repo; prs: number; border: boolean; onOpen(params?: DevelopParams): void }) {
  return (
    <li className={cn(border && 'sm:border-t sm:border-edge-subtle')}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen()}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
        className="group flex h-full cursor-pointer items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-sunken/50"
      >
        <RepoMark name={repo.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">{repo.name}</span>
            {repo.private ? <StatusBadge kind="unknown">private</StatusBadge> : null}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-content-subtle">{repo.description || 'No description'}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted">
            {repo.language ? <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: langColor(repo.language) }} />{repo.language}</span> : null}
            <button type="button" onClick={(e) => { e.stopPropagation(); onOpen({ tab: 'pulls' }) }} className={cn('hover:underline', prs ? 'font-medium text-amber-700 dark:text-amber-300' : '')}>
              {prs} PR{prs === 1 ? '' : 's'}
            </button>
            <button type="button" onClick={(e) => { e.stopPropagation(); onOpen({ tab: 'issues' }) }} className="hover:underline">
              {repo.open_issues_count} issue{repo.open_issues_count === 1 ? '' : 's'}
            </button>
            <span title={repo.updated_at}>{formatRelative(repo.updated_at)}</span>
          </div>
        </div>
        <span className="mt-1 text-content-subtle opacity-0 transition-opacity group-hover:opacity-100"><IconArrow /></span>
      </div>
    </li>
  )
}

function LanguageMix({ languages, total }: { languages: Array<[string, number]>; total: number }) {
  if (!languages.length) return <EmptyState compact title="No languages detected" />
  const top = languages.slice(0, 7)
  const rest = languages.slice(7).reduce((s, [, n]) => s + n, 0)
  const rows: Array<[string, number]> = rest ? [...top, ['Other', rest]] : top
  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label="Language mix">
        {rows.map(([l, n]) => <i key={l} className="h-full" style={{ width: `${(n / total) * 100}%`, background: l === 'Other' ? 'var(--color-edge-strong, #94a3b8)' : langColor(l) }} title={`${l}: ${n}`} />)}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {rows.map(([l, n]) => (
          <li key={l} className="flex items-center gap-2 text-[12px]">
            <i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: l === 'Other' ? 'var(--color-edge-strong, #94a3b8)' : langColor(l) }} />
            <span className="min-w-0 flex-1 truncate text-content">{l}</span>
            <span className="tabular-nums text-content-muted">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PullRow({ pr, go }: { pr: RepoPull; go: Go }) {
  const s = prState(pr)
  return (
    <li>
      <button type="button" onClick={() => go('prs', { pr: itemRef(pr.repo, pr.number) })} className="group flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-sunken/50">
        <span className="mt-0.5"><PrStateIcon state={s} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-medium text-content-muted">{pr.repo}</span>
            <span className="truncate text-sm font-medium text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">{pr.title}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-content-subtle">
            <span>#{pr.number} by {pr.user.login}</span>
            <span>· {formatRelative(pr.updated_at ?? pr.created_at)}</span>
            {pr.mergeable === false ? <span className="font-semibold text-amber-700 dark:text-amber-300">· conflicts</span> : null}
            {pr.comments ? <span>· {pr.comments} comments</span> : null}
          </div>
        </div>
        {pr.additions != null ? <span className="hidden sm:block"><DiffStat add={pr.additions} del={pr.deletions} /></span> : null}
        <Avatar login={pr.user.login} url={pr.user.avatar_url} size={22} />
      </button>
    </li>
  )
}

function IssueRow({ issue: i, go }: { issue: RepoIssue; go: Go }) {
  return (
    <li>
      <button type="button" onClick={() => go('issues', { issue: itemRef(i.repo, i.number) })} className="group flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-sunken/50">
        <span className="mt-0.5"><IssueStateIcon state={i.state} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-medium text-content-muted">{i.repo}</span>
            <span className="truncate text-sm font-medium text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">{i.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-content-subtle">
            <span>#{i.number} by {i.user.login} · {formatRelative(i.updated_at ?? i.created_at)}</span>
            {i.labels.slice(0, 3).map((l) => <LabelPill key={l.name} name={l.name} color={l.color} />)}
          </div>
        </div>
        {i.assignees?.length ? <Avatar login={i.assignees[0].login} url={i.assignees[0].avatar_url} size={22} /> : <span className="text-[10px] text-content-subtle">unassigned</span>}
      </button>
    </li>
  )
}

function WorkspaceRow({ workspace: w, onOpen }: { workspace: coder.Workspace; onOpen(): void }) {
  const tone = STATUS_TONE[w.latest_build.status] ?? 'unknown'
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-sunken/50">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500 text-[11px] font-bold text-white">
          {w.template_name.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-content">{w.name}</span>
            <StatusBadge kind={tone}>{w.latest_build.status}</StatusBadge>
          </div>
          <div className="mt-0.5 text-[11px] text-content-subtle">
            {w.template_name} · {w.owner_name}
            {w.last_used_at ? ` · ${formatRelative(w.last_used_at)}` : ''}
          </div>
        </div>
      </button>
    </li>
  )
}

function HeroStat({ label, value, tone, icon, hint, onClick }: {
  label: string
  value: number | string
  tone: 'brand' | 'amber' | 'rose' | 'violet' | 'sky' | 'emerald'
  icon: React.ReactNode
  hint?: string
  onClick?(): void
}) {
  const cls = {
    brand: 'from-brand-50 to-surface-raised text-brand-700 dark:from-brand-500/10 dark:text-brand-300',
    amber: 'from-amber-50 to-surface-raised text-amber-700 dark:from-amber-500/10 dark:text-amber-300',
    rose: 'from-rose-50 to-surface-raised text-rose-700 dark:from-rose-500/10 dark:text-rose-300',
    violet: 'from-violet-50 to-surface-raised text-violet-700 dark:from-violet-500/10 dark:text-violet-300',
    sky: 'from-sky-50 to-surface-raised text-sky-700 dark:from-sky-500/10 dark:text-sky-300',
    emerald: 'from-emerald-50 to-surface-raised text-emerald-700 dark:from-emerald-500/10 dark:text-emerald-300',
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative overflow-hidden rounded-xl border border-edge-default bg-linear-to-br p-4 text-left shadow-sm transition-all hover:-translate-y-px hover:border-edge-strong hover:shadow-md ${cls}`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-raised/80 shadow-sm">{icon}</span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{label}</span>
        <span className="ml-auto text-content-subtle opacity-0 transition-opacity group-hover:opacity-100"><IconArrow /></span>
      </div>
      <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-content">{value}</div>
      {hint ? <div className="truncate text-[11px] text-content-muted">{hint}</div> : null}
    </button>
  )
}

function QuickStartCard({ title, description, links, tone, go }: {
  title: string
  description: string
  links: Array<[string, DevelopSection]>
  tone: 'brand' | 'amber' | 'violet' | 'emerald'
  go: Go
}) {
  const accent = {
    brand: 'border-brand-200/60 bg-brand-50/30 dark:border-brand-500/20 dark:bg-brand-500/5',
    amber: 'border-amber-200/60 bg-amber-50/30 dark:border-amber-500/20 dark:bg-amber-500/5',
    violet: 'border-violet-200/60 bg-violet-50/30 dark:border-violet-500/20 dark:bg-violet-500/5',
    emerald: 'border-emerald-200/60 bg-emerald-50/30 dark:border-emerald-500/20 dark:bg-emerald-500/5',
  }[tone]
  return (
    <Card className={`${accent} border`}>
      <CardBody className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-content">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-content-muted">{description}</p>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {links.map(([label, section]) => (
            <li key={section + label}>
              <button type="button" onClick={() => go(section)} className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline dark:text-brand-300">
                <IconArrow /> {label}
              </button>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

const STATUS_TONE: Record<coder.WorkspaceStatus, 'healthy' | 'progressing' | 'paused' | 'failed' | 'info' | 'unknown'> = {
  running: 'healthy',
  starting: 'progressing',
  pending: 'progressing',
  stopping: 'paused',
  stopped: 'paused',
  canceling: 'paused',
  canceled: 'unknown',
  deleting: 'paused',
  deleted: 'unknown',
  failed: 'failed',
}

function IconBranch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}
function IconPr() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="6" y1="9" x2="6" y2="15" />
      <path d="m21 6-3-3-3 3" />
      <path d="M18 3v9c0 3-2 6-6 6" />
    </svg>
  )
}
function IconBug() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="8" y="6" width="8" height="14" rx="4" />
      <path d="M19 7l-3 2" />
      <path d="M5 7l3 2" />
      <path d="M19 13h-3" />
      <path d="M5 13h3" />
      <path d="M19 19l-3-2" />
      <path d="M5 19l3-2" />
      <path d="M12 2v4" />
    </svg>
  )
}
function IconCloud() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.5 19a4.5 4.5 0 1 0 0-9 5.5 5.5 0 0 0-10.83-1A4 4 0 0 0 6.5 19h11Z" />
    </svg>
  )
}
function IconStack() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  )
}
function IconLang() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}
function IconArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
