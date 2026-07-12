import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { coder, gitea } from '@adhar-console/api-clients'
import { useAllOpenPullRequests, useRepos } from '../data/git.ts'
import { useTemplates, useWorkspaces } from '../data/coder.ts'
import { RepoMark } from '../components/repo-picker.tsx'

/**
 * Develop dashboard. Aggregates Gitea (repos, open PRs, issues) and Coder
 * (workspaces, templates) into a single workspace-level pulse, mirroring
 * the Define and Design dashboards.
 */
export function Dashboard() {
  const repos = useRepos()
  const prs = useAllOpenPullRequests()
  const workspaces = useWorkspaces()
  const templates = useTemplates()

  if (repos.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading workspace…
      </div>
    )
  }
  if (repos.isError) {
    return (
      <EmptyState
        title="Couldn't reach Gitea"
        description={repos.error instanceof Error ? repos.error.message : 'Unknown error.'}
      />
    )
  }

  const repoList = repos.data ?? []
  const prList = prs.data ?? []
  const wsList = workspaces.data ?? []
  const tplList = templates.data ?? []

  const totalIssues = repoList.reduce((acc, r) => acc + (r.open_issues_count ?? 0), 0)
  const runningWs = wsList.filter((w) => w.latest_build.status === 'running').length
  const startingWs = wsList.filter((w) => w.latest_build.status === 'starting').length
  const failedWs = wsList.filter((w) => w.latest_build.status === 'failed').length

  // Top by activity = recently updated repos.
  const topRepos = repoList
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 5)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeroStat
          label="Repositories"
          value={repoList.length}
          tone="brand"
          icon={<IconBranch />}
          hint={`${repoList.filter((r) => r.private).length} private`}
        />
        <HeroStat
          label="Open PRs"
          value={prList.length}
          tone="amber"
          icon={<IconPr />}
          hint="awaiting review"
        />
        <HeroStat
          label="Open issues"
          value={totalIssues}
          tone="rose"
          icon={<IconBug />}
          hint="across all repos"
        />
        <HeroStat
          label="Cloud envs"
          value={wsList.length}
          tone="violet"
          icon={<IconCloud />}
          hint={`${runningWs} running${startingWs ? ` · ${startingWs} starting` : ''}${failedWs ? ` · ${failedWs} failed` : ''}`}
        />
        <HeroStat
          label="Env templates"
          value={tplList.length}
          tone="sky"
          icon={<IconStack />}
          hint="reusable images"
        />
        <HeroStat
          label="Languages"
          value={new Set(repoList.map((r) => r.language).filter(Boolean)).size}
          tone="emerald"
          icon={<IconLang />}
          hint="across the org"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Top repositories</div>
                <div className="text-[11px] text-content-subtle">Most recently active</div>
              </div>
              <StatusBadge kind="info">{topRepos.length}</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            {topRepos.length === 0 ? (
              <EmptyState compact title="No repos yet" />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {topRepos.map((r) => (
                  <RepoRow key={r.id} repo={r} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Cloud environments</div>
            <div className="text-[11px] text-content-subtle">Latest build status</div>
          </CardHeader>
          <CardBody className="p-0!">
            {wsList.length === 0 ? (
              <EmptyState compact title="No envs yet" />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {wsList.slice(0, 5).map((w) => (
                  <WorkspaceRow key={w.id} workspace={w} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Open pull requests</div>
                <div className="text-[11px] text-content-subtle">Across every repo in the org</div>
              </div>
              <StatusBadge kind="info">{prList.length}</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            {prList.length === 0 ? (
              <EmptyState compact title="Nothing to review 🎉" />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {prList.slice(0, 8).map((p) => (
                  <PullRow key={p.id} pr={p} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <QuickStartCard
            title="Code"
            description="Browse repos, edit files in the in-browser IDE, manage branches and commits."
            links={[
              { label: 'Repositories', href: '?repos' },
              { label: 'Browser IDE', href: '?ide' },
              { label: 'Branches', href: '?branches' },
              { label: 'Commits', href: '?commits' },
            ]}
            tone="brand"
          />
          <QuickStartCard
            title="Review"
            description="Open PRs and issues across the org with author + diff stats."
            links={[
              { label: 'Pull requests', href: '?prs' },
              { label: 'Issues', href: '?issues' },
            ]}
            tone="amber"
          />
          <QuickStartCard
            title="Run"
            description="CI pipelines + cloud development environments."
            links={[
              { label: 'CI Workflows', href: '?workflows' },
              { label: 'Cloud Envs', href: '?environments' },
            ]}
            tone="violet"
          />
          <QuickStartCard
            title="Generate"
            description="Drag-and-drop code builder for components and services."
            links={[{ label: 'Code Builder', href: '?codebuilder' }]}
            tone="emerald"
          />
        </div>
      </div>
    </div>
  )
}

function RepoRow({ repo }: { repo: gitea.Repo }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
      <RepoMark name={repo.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-content">{repo.name}</span>
          <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] font-semibold text-content-muted">
            {repo.default_branch}
          </span>
          {repo.private ? <StatusBadge kind="unknown">private</StatusBadge> : null}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-content-subtle">
          {repo.description ?? '—'}
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-content-muted">
          <span>{repo.language ?? '—'}</span>
          <span>· {repo.open_issues_count} open</span>
          <span>· ★ {repo.stars_count}</span>
          <span>· {formatRelative(repo.updated_at)}</span>
        </div>
      </div>
    </li>
  )
}

function PullRow({ pr }: { pr: gitea.PullRequest & { repo?: string } }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
      <img
        src={pr.user.avatar_url}
        alt=""
        className="h-7 w-7 shrink-0 rounded-full ring-1 ring-edge-subtle"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="font-mono text-[10px] text-content-muted">#{pr.number}</code>
          {pr.repo ? (
            <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
              {pr.repo}
            </span>
          ) : null}
          <span className="truncate text-sm font-medium text-content">{pr.title}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-content-subtle">
          {pr.user.login} opened {formatRelative(pr.created_at)}
          {pr.head ? ` · ${pr.head.ref} → ${pr.base?.ref ?? 'main'}` : ''}
        </div>
      </div>
      {pr.changed_files != null ? (
        <div className="hidden text-right text-[11px] sm:block">
          <span className="font-mono text-emerald-700">+{pr.additions ?? 0}</span>{' '}
          <span className="font-mono text-rose-700">-{pr.deletions ?? 0}</span>
        </div>
      ) : null}
    </li>
  )
}

function WorkspaceRow({ workspace: w }: { workspace: coder.Workspace }) {
  const tone = STATUS_TONE[w.latest_build.status] ?? 'unknown'
  return (
    <li className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-brand-50/40">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white ${TPL_BG[w.template_name] ?? 'bg-violet-500'}`}
      >
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
    </li>
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

const TPL_BG: Record<string, string> = {
  'node-ts': 'bg-emerald-500',
  'go-dev': 'bg-sky-500',
  python: 'bg-amber-500',
  'fullstack-tilt': 'bg-violet-500',
}

function HeroStat({
  label,
  value,
  tone,
  icon,
  hint,
}: {
  label: string
  value: number
  tone: 'brand' | 'amber' | 'rose' | 'violet' | 'sky' | 'emerald'
  icon: React.ReactNode
  hint?: string
}) {
  const cls = {
    brand: 'from-brand-50 to-white text-brand-700',
    amber: 'from-amber-50 to-white text-amber-700',
    rose: 'from-rose-50 to-white text-rose-700',
    violet: 'from-violet-50 to-white text-violet-700',
    sky: 'from-sky-50 to-white text-sky-700',
    emerald: 'from-emerald-50 to-white text-emerald-700',
  }[tone]
  return (
    <Card className={`relative overflow-hidden bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="space-y-1 p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/80 shadow-sm">
            {icon}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            {label}
          </span>
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {value}
        </div>
        {hint ? <div className="text-[11px] text-content-muted">{hint}</div> : null}
      </CardBody>
    </Card>
  )
}

function QuickStartCard({
  title,
  description,
  links,
  tone,
}: {
  title: string
  description: string
  links: { label: string; href: string }[]
  tone: 'brand' | 'amber' | 'violet' | 'emerald'
}) {
  const accent = {
    brand: 'border-brand-200/60 bg-brand-50/30',
    amber: 'border-amber-200/60 bg-amber-50/30',
    violet: 'border-violet-200/60 bg-violet-50/30',
    emerald: 'border-emerald-200/60 bg-emerald-50/30',
  }[tone]
  return (
    <Card className={`${accent} border`}>
      <CardBody className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-content">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-content-muted">{description}</p>
        </div>
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline"
              >
                <IconArrow /> {l.label}
              </a>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
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
