import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, EmptyState, PageHeader, SearchInput, Select, Skeleton, useGiteaOrg, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { BuilderApp, defaultProjectFor, normalizeProject, type BuilderController, type BuilderSaveEvent, type ThemePreset } from '@adhar/builder'
import type { BuilderProject } from '@adhar/builder/project'
import { isEditable, loadCanvasCss, loadParser, openRepo, previewFile, type ParseFn } from '@adhar/builder/code'
import { KIND, TOKEN_SET_ID, useDoc } from '../data/store.ts'
import type { TokenSet, Wireframe } from '../data/types.ts'
import { projectToBlocks, wireframeToProject } from '../data/wireframe-builder.ts'
import { themeFromTokenSet, WORKSPACE_THEME_ID } from '../data/builder-theme.ts'
import { useUrlParams } from '../data/builder-nav.ts'
import { matchApps, repoApi, useCatalogApps, useDesignerRepos, useLastCommit, useRepoBranches, useRepoFramework } from '../data/designer-repos.ts'
import type { CatalogApp } from '../data/designer-catalog.ts'
import { ErrorBlock } from '../components/async-states.tsx'
import { ReviewChanges } from '../components/review-changes.tsx'

/**
 * Design → Visual Designer — repository first.
 *
 *   • Library: the organisation's repositories (Gitea), labelled with the
 *     platform Applications that deploy them (team / project), with the
 *     detected framework and the last commit.
 *   • Editor:  open an app on a branch; its pages are read from the code and
 *     edited visually (`@adhar/builder`). Code the designer doesn't understand
 *     is preserved exactly. "Review & commit" shows the diff and writes a new
 *     branch + pull request (default) or commits to the branch.
 *   • URL:     `?section=builder&repo=<owner/name>&branch=<b>&page=<path>`.
 */
const PARAMS = ['repo', 'branch', 'page', 'new'] as const

export function Builder() {
  const [params, setParams] = useUrlParams(PARAMS)
  const workspaceTheme = useWorkspaceTheme()

  // The Design dashboard's old "New → Visual designer" link: there's nothing
  // to create here any more — apps come from repositories. Drop the flag.
  useEffect(() => {
    if (params.new) setParams({ new: undefined }, { replace: true })
  }, [params.new, setParams])

  if (params.repo) {
    return (
      <RepoEditor
        key={`${params.repo}@${params.branch ?? ''}`}
        fullName={params.repo}
        branch={params.branch}
        page={params.page}
        workspaceTheme={workspaceTheme}
        onBranch={(b) => setParams({ branch: b, page: undefined })}
        onPage={(p) => setParams({ page: p }, { replace: true })}
        onBack={() => setParams({ repo: undefined, branch: undefined, page: undefined })}
      />
    )
  }
  return <RepoLibrary onOpen={(repo, branch) => setParams({ repo, branch, page: undefined })} />
}

/** The workspace token set as a builder theme; null until/unless it has colours. */
function useWorkspaceTheme(): ThemePreset | null {
  const { data } = useDoc<TokenSet>(KIND.tokenSet, TOKEN_SET_ID)
  return useMemo(() => themeFromTokenSet(data ?? null), [data])
}

/* ───────────────────────────── library ───────────────────────────── */

function RepoLibrary({ onOpen }: { onOpen(fullName: string, branch?: string): void }) {
  const repos = useDesignerRepos()
  const apps = useCatalogApps()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'apps' | 'all'>('all')

  const rows = useMemo(() => {
    const list = (repos.data ?? []).map((r) => ({ repo: r, apps: matchApps(apps.data ?? [], { name: r.name, owner: r.owner?.login }) }))
    const q = query.trim().toLowerCase()
    return list
      .filter((x) => scope === 'all' || x.apps.length > 0)
      .filter((x) => !q || [x.repo.name, x.repo.description ?? '', ...x.apps.flatMap((a) => [a.name, a.team ?? '', a.project ?? ''])].join(' ').toLowerCase().includes(q))
      .sort((a, b) => (b.apps.length - a.apps.length) || b.repo.updated_at.localeCompare(a.repo.updated_at))
  }, [repos.data, apps.data, query, scope])
  const anyApps = (apps.data ?? []).length > 0

  return (
    <div className='space-y-6'>
      <PageHeader title='Visual Designer' />
      {repos.error ? (
        <ErrorBlock error={repos.error as Error} onRetry={() => void repos.refetch()} />
      ) : repos.isLoading ? (
        <div className='space-y-2'>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={64} className='block w-full' rounded='lg' />)}</div>
      ) : (repos.data ?? []).length === 0 ? (
        <EmptyState title='No repositories yet' description='The Visual Designer edits the React apps in your Gitea repositories. Create or import a repository in Develop → Repositories, then open it here.' />
      ) : (
        <>
          <div className='flex flex-wrap items-center gap-3'>
            <SearchInput value={query} onChange={setQuery} placeholder='Search apps and repositories…' block={false} className='w-full sm:w-80' />
            {anyApps && (
              <div className='inline-flex rounded-lg border border-edge-default p-0.5 text-xs'>
                {(['all', 'apps'] as const).map((k) => (
                  <button key={k} type='button' onClick={() => setScope(k)}
                    className={cn('rounded-md px-2.5 py-1 font-medium', scope === k ? 'bg-surface-sunken text-content' : 'text-content-muted hover:text-content')}>
                    {k === 'all' ? 'All repositories' : 'Platform apps'}
                  </button>
                ))}
              </div>
            )}
            <span className='text-xs text-content-muted'>{rows.length} of {(repos.data ?? []).length}</span>
          </div>
          {rows.length === 0 ? (
            <EmptyState compact title='Nothing matches' description='Try another name, team or project.' />
          ) : (
            <ul className='divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
              {rows.map(({ repo, apps }) => (
                <RepoRow key={repo.full_name} repo={repo} apps={apps} onOpen={() => onOpen(repo.full_name, repo.default_branch)} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function RepoRow({ repo, apps, onOpen }: {
  repo: { name: string; full_name: string; description?: string; default_branch: string; archived?: boolean; mirror?: boolean; updated_at: string }
  apps: CatalogApp[]
  onOpen(): void
}) {
  // Details are read lazily, per visible row.
  const ref = useRef<HTMLLIElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect() } })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const fw = useRepoFramework(repo.name, visible ? repo.default_branch : undefined)
  const last = useLastCommit(repo.name, visible ? repo.default_branch : undefined)
  const editable = fw.data ? isEditable(fw.data) : null

  return (
    <li ref={ref} className='flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-surface-hover'>
      <button type='button' onClick={onOpen} className='min-w-0 flex-1 text-left focus-visible:outline-none'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='truncate text-sm font-semibold text-content'>{apps[0]?.name ?? repo.name}</span>
          {apps[0] && apps[0].name !== repo.name && <span className='font-mono text-xs text-content-muted'>{repo.name}</span>}
          {apps.slice(0, 1).map((a) => (
            <span key={a.name} className='text-xs text-content-muted'>{[a.team, a.project].filter(Boolean).join(' · ')}</span>
          ))}
          {repo.archived && <Chip tone='slate'>archived</Chip>}
          {repo.mirror && <Chip tone='slate'>mirror</Chip>}
        </div>
        <div className='mt-0.5 truncate text-xs text-content-muted'>
          {last.data ? <>{last.data.message.split('\n')[0]} · {formatRelative(last.data.created)}</> : repo.description || `Updated ${formatRelative(repo.updated_at)}`}
        </div>
      </button>
      <div className='flex shrink-0 items-center gap-2'>
        {fw.isLoading || !visible ? <Skeleton width={84} height={20} rounded='full' /> : fw.data ? (
          <Chip tone={editable ? 'brand' : 'slate'}>{fw.data.label}{fw.data.tailwind ? ' · Tailwind' : ''}</Chip>
        ) : <Chip tone='slate'>No package.json</Chip>}
        <span className='hidden font-mono text-xs text-content-muted sm:inline'>{repo.default_branch}</span>
        <Button size='sm' onClick={onOpen}>Open</Button>
      </div>
    </li>
  )
}

function Chip({ tone, children }: { tone: 'brand' | 'slate'; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
      tone === 'brand' ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'bg-surface-sunken text-content-muted')}>
      {children}
    </span>
  )
}

/* ───────────────────────────── editor ───────────────────────────── */

function RepoEditor({ fullName, branch: branchParam, page, workspaceTheme, onBranch, onPage, onBack }: {
  fullName: string
  branch?: string
  page?: string
  workspaceTheme: ThemePreset | null
  onBranch(branch: string): void
  onPage(path: string | undefined): void
  onBack(): void
}) {
  const org = useGiteaOrg()
  const toast = useToast()
  const qc = useQueryClient()
  const [owner, name] = fullName.includes('/') ? fullName.split('/', 2) : [org, fullName]
  const repos = useDesignerRepos()
  const repo = repos.data?.find((r) => r.full_name === `${owner}/${name}` || r.name === name)
  const branches = useRepoBranches(name)
  const branch = branchParam ?? repo?.default_branch
  const head = branches.data?.find((b) => b.name === branch)?.commit.id
  const api = useMemo(() => repoApi(owner, name, head), [owner, name, head])

  const opened = useQuery({
    queryKey: ['designer', 'session', owner, name, branch, head],
    queryFn: async () => {
      const parse = await loadParser()
      const { session, project } = await openRepo(api, parse, name, branch!)
      project.source = { repo: `${owner}/${name}`, branch: branch!, commit: head }
      if (!session.meta.theme && workspaceTheme && !session.framework.tailwind) project.settings = { ...project.settings, theme: WORKSPACE_THEME_ID }
      const canvasCss = session.framework.tailwind ? await loadCanvasCss(session.appCss?.content ?? null).catch(() => null) : null
      return { session, project, parse, canvasCss }
    },
    enabled: !!branch && !!branches.data,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  useEffect(() => {
    for (const w of opened.data?.session.warnings ?? []) toast.warning(w)
    // Once per load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened.data?.session])

  const [review, setReview] = useState<BuilderController | null>(null)
  const themes = useMemo(() => (workspaceTheme ? [workspaceTheme] : []), [workspaceTheme])
  const docId = `repo.${owner}.${name}.${branch ?? ''}`.replace(/[^A-Za-z0-9._-]/g, '-')

  const reload = useCallback(() => {
    try { localStorage.removeItem(`adhar.builder.draft:${docId}`) } catch { /* ignore */ }
    setReview(null)
    void qc.invalidateQueries({ queryKey: ['gitea', 'branches', org, name] })
    void qc.invalidateQueries({ queryKey: ['designer', 'session', owner, name] })
  }, [docId, org, name, owner, qc])

  const branchPicker = (
    <span className='flex items-center gap-2 text-sm font-normal'>
      <Select
        aria-label='Branch'
        value={branch ?? ''}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onBranch(e.target.value)}
        options={(branches.data ?? []).map((b) => ({ value: b.name, label: b.name }))}
        className='h-8 py-0 font-mono text-xs'
        wrapperClassName='w-44'
      />
      {opened.data && <span className='hidden text-xs text-content-muted md:inline'>{opened.data.session.framework.label}{opened.data.session.framework.tailwind ? ' · Tailwind' : ''}</span>}
    </span>
  )

  if (repos.isLoading || branches.isLoading || (opened.isLoading && !!branch)) {
    return (
      <div className='space-y-4'>
        <PageHeader compact title={<span className='flex items-center gap-2'><BackButton onClick={onBack} />{name}</span>} />
        <Skeleton height={560} className='block w-full' rounded='lg' />
      </div>
    )
  }
  const failure = repos.error ?? branches.error ?? opened.error
  if (failure || !repo || !branch) {
    return (
      <div className='space-y-6'>
        <PageHeader title={<span className='flex items-center gap-2'><BackButton onClick={onBack} />{name}</span>} />
        <EmptyState title={!repo ? 'Repository not found' : 'Could not open this repository'}
          description={failure instanceof Error ? failure.message : !repo ? `${fullName} isn't in this organisation, or you can't see it.` : 'Try another branch.'}
          action={<Button variant='primary' onClick={onBack}>Back to apps</Button>} />
      </div>
    )
  }
  const data = opened.data!
  if (!data.session.editable || !data.session.pages.length) {
    return (
      <div className='space-y-6'>
        <PageHeader title={<span className='flex items-center gap-2'><BackButton onClick={onBack} />{name}{branchPicker}</span>} />
        <EmptyState title={data.session.editable ? 'No pages found' : `${data.session.framework.label} isn't supported yet`}
          description={data.session.warnings[0] ?? 'The designer edits React apps (Vite, Next.js, Remix).'}
          action={<Button onClick={onBack}>Back to apps</Button>} />
      </div>
    )
  }

  return (
    <>
      <BuilderApp
        key={`${docId}@${head ?? ''}`}
        mode='visual'
        docId={docId}
        docName={name}
        initialProject={data.project}
        isDraftUsable={(d) => d.source?.commit === head && d.source?.branch === branch}
        onBack={onBack}
        titleExtra={branchPicker}
        saveLabel='Review & commit'
        onSaveRequest={(ctl) => setReview(ctl)}
        initialFileId={page ? `pg:${page}` : undefined}
        onActiveFileChange={(id) => onPage(id?.startsWith('pg:') ? id.slice(3).replace(/#.*$/, '') : undefined)}
        previewCode={(fileId, project: BuilderProject) => previewFile(data.session, project, fileId, data.parse as ParseFn)}
        canvasCss={data.canvasCss}
        themes={themes}
      />
      {review && review.project && (
        <ReviewChanges
          owner={owner}
          repo={repo}
          branch={branch}
          session={data.session}
          project={review.project}
          parse={data.parse}
          api={api}
          onClose={() => setReview(null)}
          onReload={reload}
          onCommitted={(res) => {
            review.markSaved()
            setReview(null)
            void qc.invalidateQueries({ queryKey: ['gitea', 'branches', org, name] })
            void qc.invalidateQueries({ queryKey: ['gitea', 'commits', org, name] })
            if (res.branch !== branch) onBranch(res.branch)
            else reload()
          }}
        />
      )}
    </>
  )
}

function BackButton({ onClick }: { onClick(): void }) {
  return (
    <button type='button' onClick={onClick} aria-label='Back to apps'
      className='inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-content-muted transition-colors hover:bg-surface-hover hover:text-content'>
      <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
        <path d='m12 19-7-7 7-7' /><path d='M19 12H5' />
      </svg>
    </button>
  )
}

/* ───────────────────────────── wireframes ───────────────────────────── */

export interface BuilderEmbedProps {
  doc: Wireframe
  /** Persist the edited wireframe. Errors surface as a toast in the builder. */
  onSave(next: Wireframe): Promise<unknown>
  onBack?(): void
  title?: string
}

/** Edit one wireframe in the Visual Designer; Save writes the project back onto it. */
export function BuilderEmbed({ doc, onSave, onBack, title }: BuilderEmbedProps) {
  const workspaceTheme = useWorkspaceTheme()
  const themes = useMemo(() => (workspaceTheme ? [workspaceTheme] : []), [workspaceTheme])
  const initialProject = useMemo(() => {
    const stored = normalizeProject(doc.builder, doc.name)
    if (stored) return stored
    const base = defaultProjectFor('visual', doc.name)
    if (workspaceTheme) base.settings = { ...base.settings, theme: WORKSPACE_THEME_ID }
    return wireframeToProject(doc, base)
  }, [doc, workspaceTheme])

  const save = useCallback(
    async ({ project }: BuilderSaveEvent) => {
      await onSave({ ...doc, builder: project, blocks: projectToBlocks(project) })
    },
    [doc, onSave],
  )

  return (
    <BuilderApp
      mode='visual'
      docId={`design.wireframe.${doc.id}`}
      docName={doc.name}
      title={title ?? doc.name}
      initialProject={initialProject}
      onSave={save}
      onBack={onBack}
      themes={themes}
      variant='embedded'
      height='calc(100vh - 250px)'
    />
  )
}

export default Builder
