import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, EmptyState, PageHeader, SearchInput, Select, Skeleton, Spinner, useGiteaOrg, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { BuilderApp, defaultProjectFor, normalizeProject, type BuilderController, type BuilderSaveEvent, type ThemePreset } from '@adhar/builder'
import type { BuilderProject } from '@adhar/builder/project'
import { familyOf, isEditable, loadCanvasCss, loadParser, openRepo, plainCanvasCss, previewFile, SUPPORTED_FRAMEWORKS, type ParseFn } from '@adhar/builder/code'
import { KIND, useCollection, useUpdate } from '../data/store.ts'
import type { Wireframe } from '../data/types.ts'
import { addWireframePage, projectToBlocks, wireframeToProject } from '../data/wireframe-builder.ts'
import { useEffectiveTokens } from '../data/token-scope.ts'
import { useDesignScope } from '../data/design-scope.ts'
import { appProjectSlug } from '../data/designer-catalog.ts'
import { themeFromTokenSet, WORKSPACE_THEME_ID } from '../data/builder-theme.ts'
import { useUrlParams } from '../data/builder-nav.ts'
import { matchApps, repoApi, useCatalogApps, useDesignerRepos, useLastCommit, useRepoBranches, useRepoFramework, useRepoFrameworks } from '../data/designer-repos.ts'
import { isUiRepo, judgeRepos, notEditableReason, type CatalogApp } from '../data/designer-catalog.ts'
import { ErrorBlock } from '../components/async-states.tsx'
import { Icon } from '../components/ui-bits.tsx'
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
const PARAMS = ['repo', 'branch', 'page', 'new', 'from'] as const

export function Builder() {
  const [params, setParams] = useUrlParams(PARAMS)
  const apps = useCatalogApps()
  const scope = useDesignScope()
  // The open repository's project (via the catalog application that deploys
  // it) decides which token set the canvas theme follows.
  const repoName = params.repo?.split('/').pop()
  const repoOwner = params.repo?.includes('/') ? params.repo.split('/')[0] : undefined
  const app = repoName ? matchApps(apps.data ?? [], { name: repoName, owner: repoOwner })[0] : undefined
  const project = app ? appProjectSlug(app, scope.projects) : undefined
  const workspaceTheme = useWorkspaceTheme(project)

  // The Design dashboard's old "New → Visual designer" link: there's nothing
  // to create here any more — apps come from repositories. Drop the flag.
  useEffect(() => {
    if (params.new) setParams({ new: undefined }, { replace: true })
  }, [params.new, setParams])

  if (params.repo) {
    return (
      <RepoEditor
        key={`${params.repo}@${params.branch ?? ''}@${params.from ?? ''}`}
        fullName={params.repo}
        branch={params.branch}
        page={params.page}
        fromWireframe={params.from}
        onWireframeDone={() => setParams({ from: undefined }, { replace: true })}
        workspaceTheme={workspaceTheme}
        onBranch={(b) => setParams({ branch: b, page: undefined })}
        onPage={(p) => setParams({ page: p }, { replace: true })}
        onBack={() => setParams({ repo: undefined, branch: undefined, page: undefined, from: undefined })}
      />
    )
  }
  return <RepoLibrary onOpen={(repo, branch) => setParams({ repo, branch, page: undefined })} />
}

/**
 * The design-token set as a builder theme — the project's set (workspace +
 * project overrides) when the app belongs to a project, else the workspace
 * set; null until/unless it has colours. Edits on Design Tokens re-theme the
 * canvas on the next read.
 */
function useWorkspaceTheme(project?: string): ThemePreset | null {
  const { effective, workspaceStored, overrideCount } = useEffectiveTokens(project)
  return useMemo(() => {
    if (!workspaceStored && !overrideCount) return null
    const t = themeFromTokenSet(effective)
    return t && project && overrideCount ? { ...t, name: `Project · ${project}` } : t
  }, [effective, workspaceStored, overrideCount, project])
}

/* ───────────────────────────── library ───────────────────────────── */

function RepoLibrary({ onOpen }: { onOpen(fullName: string, branch?: string): void }) {
  const repos = useDesignerRepos()
  const apps = useCatalogApps()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'apps' | 'all'>('all')
  // Only UI applications by default: the designer edits pages, so services,
  // functions, workers and data/AI apps are noise here.
  const [showAll, setShowAll] = useState(false)
  // Opening reads the repo tree and parses pages — give the click instant feedback.
  const [opening, setOpening] = useState<string | null>(null)

  // Mirrors, archived / empty repos and the platform's own repositories are
  // never listed, not even under "Show all": a change made there is refused
  // or overwritten (designer-catalog.ts `notEditableReason`).
  const judged = useMemo(() => judgeRepos(repos.data ?? [], apps.data ?? []), [repos.data, apps.data])
  const frameworks = useRepoFrameworks(judged.filter((x) => x.verdict === 'check').map((x) => x.repo))
  const isUi = (x: (typeof judged)[number]) => isUiRepo(x.verdict, frameworks.get(x.repo.name))
  const hiddenCount = judged.filter((x) => !isUi(x)).length

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return judged
      .filter((x) => showAll || isUi(x))
      .filter((x) => scope === 'all' || x.apps.length > 0)
      .filter((x) => !q || [x.repo.name, x.repo.description ?? '', ...x.apps.flatMap((a) => [a.name, a.team ?? '', a.project ?? ''])].join(' ').toLowerCase().includes(q))
      .sort((a, b) => (b.apps.length - a.apps.length) || b.repo.updated_at.localeCompare(a.repo.updated_at))
  }, [judged, frameworks, query, scope, showAll])
  const anyApps = (apps.data ?? []).length > 0

  return (
    <div className='space-y-6'>
      <PageHeader title='Visual Designer' />
      {repos.error ? (
        <ErrorBlock title='Couldn’t list repositories' error={repos.error as Error} onRetry={() => void repos.refetch()} />
      ) : repos.isLoading ? (
        <div className='space-y-2'>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={64} className='block w-full' rounded='lg' />)}</div>
      ) : (repos.data ?? []).length === 0 ? (
        <EmptyState icon={<Icon name='git' size={22} />} title='No repositories yet' description={`The Visual Designer edits the web apps in your Gitea repositories — ${SUPPORTED_FRAMEWORKS}. Create or import a repository in Develop → Repositories, then open it here.`} />
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
            <span className='text-xs text-content-muted'>
              {rows.length} {showAll ? 'repositories' : rows.length === 1 ? 'UI app' : 'UI apps'}
            </span>
            {hiddenCount > 0 ? (
              <button type='button' onClick={() => setShowAll((v) => !v)} className='text-xs font-medium text-brand-700 hover:underline dark:text-brand-300'>
                {showAll ? 'Show UI apps only' : `Show all repositories (${hiddenCount} hidden)`}
              </button>
            ) : null}
          </div>
          {rows.length === 0 ? (
            <EmptyState
              compact
              title={query || scope === 'apps' ? 'Nothing matches' : 'No UI applications yet'}
              description={query || scope === 'apps'
                ? 'Try another name, team or project.'
                : `The Visual Designer edits ${SUPPORTED_FRAMEWORKS} apps. Create one from a golden path in Service Catalog → Create New${hiddenCount > 0 ? ', or show all repositories' : ''}.`}
            />
          ) : (
            <ul className='divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
              {rows.map(({ repo, apps }) => (
                <RepoRow
                  key={repo.full_name}
                  repo={repo}
                  apps={apps}
                  opening={opening === repo.full_name}
                  onOpen={() => {
                    if (opening) return
                    setOpening(repo.full_name)
                    // Paint the pending state before the editor takes over.
                    requestAnimationFrame(() => onOpen(repo.full_name, repo.default_branch))
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function RepoRow({ repo, apps, onOpen, opening = false }: {
  repo: { name: string; full_name: string; description?: string; default_branch: string; updated_at: string }
  apps: CatalogApp[]
  onOpen(): void
  opening?: boolean
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
        </div>
        <div className='mt-0.5 truncate text-xs text-content-muted'>
          {last.data ? <>{last.data.message.split('\n')[0]} · {formatRelative(last.data.created)}</> : repo.description || `Updated ${formatRelative(repo.updated_at)}`}
        </div>
      </button>
      <div className='flex shrink-0 items-center gap-2'>
        {fw.isLoading || !visible ? <Skeleton width={84} height={20} rounded='full' /> : fw.data ? (
          <Chip tone={editable ? 'brand' : 'slate'}>{fw.data.label}{fw.data.tailwind ? ' · Tailwind' : ''}</Chip>
        ) : <Chip tone='slate'>No web app found</Chip>}
        <span className='hidden font-mono text-xs text-content-muted sm:inline'>{repo.default_branch}</span>
        <Button size='sm' variant='primary' onClick={onOpen} loading={opening} disabled={opening}>{opening ? 'Opening…' : 'Open'}</Button>
      </div>
    </li>
  )
}

/** The editor while a repository opens: what is happening, not a blank box. */
function OpeningState({ name, step }: { name: string; step: string }) {
  return (
    <div className='relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised' style={{ height: 'calc(100vh - 210px)', minHeight: 420 }} role='status' aria-live='polite'>
      <div className='absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-brand-500/10'>
        <div className='h-full w-1/3 animate-[opening_1.2s_ease-in-out_infinite] bg-brand-500' />
      </div>
      <style>{'@keyframes opening{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
      <div className='flex h-full flex-col items-center justify-center gap-3 px-6 text-center'>
        <Spinner size={20} />
        <div className='text-sm font-semibold text-content'>Opening {name}…</div>
        <div className='text-xs text-content-muted'>{step}</div>
      </div>
    </div>
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

function RepoEditor({ fullName, branch: branchParam, page, fromWireframe, onWireframeDone, workspaceTheme, onBranch, onPage, onBack }: {
  fullName: string
  branch?: string
  page?: string
  /** Wireframe id to add as a new page ("Implement in repo"). */
  fromWireframe?: string
  onWireframeDone(): void
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
  // A link can still name a repository the library never offers (a mirror, the
  // platform's own repos): it is not opened — a change there would not stick.
  const locked = repo ? notEditableReason(repo) : null
  const branches = useRepoBranches(name)
  const branch = branchParam ?? repo?.default_branch
  const head = branches.data?.find((b) => b.name === branch)?.commit.id
  const api = useMemo(() => repoApi(owner, name, head), [owner, name, head])
  const wireframes = useCollection<Wireframe>(KIND.wireframe)
  const updateWf = useUpdate<Wireframe>(KIND.wireframe)
  const wf = fromWireframe ? wireframes.items.find((w) => w.id === fromWireframe) ?? null : null
  const waitingForWf = !!fromWireframe && wireframes.isLoading

  const opened = useQuery({
    queryKey: ['designer', 'session', owner, name, branch, head, wf?.id ?? ''],
    queryFn: async () => {
      const parse = await loadParser()
      const { session, project } = await openRepo(api, parse, name, branch!)
      project.source = { repo: `${owner}/${name}`, branch: branch!, commit: head }
      if (!session.meta.theme && workspaceTheme && !session.framework.tailwind) project.settings = { ...project.settings, theme: WORKSPACE_THEME_ID }
      // Tailwind repos: their Tailwind compiled in the browser (+ component styles). Other non-React
      // repos (Angular / Vue / Svelte / Solid / static HTML): their plain CSS, scoped to the canvas.
      const otherCss = familyOf(session.framework) === 'react' ? '' : (session.componentCss ?? '')
      const canvasCss = session.framework.tailwind
        ? await loadCanvasCss(session.appCss?.content ?? null, otherCss).catch(() => null)
        : familyOf(session.framework) !== 'react' && (session.appCss || otherCss)
        ? plainCanvasCss(`${session.appCss?.content ?? ''}\n${otherCss}`)
        : null
      // "Implement in repo": the wireframe starts a NEW page; existing pages are untouched.
      if (wf && session.editable) {
        const added = addWireframePage(project, wf)
        return { session, project: added.project, parse, canvasCss, newPage: added.pageId }
      }
      return { session, project, parse, canvasCss, newPage: undefined as string | undefined }
    },
    enabled: !!branch && !!branches.data && !waitingForWf && !locked,
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
  // A wireframe-started session keeps its own draft so it never mixes with a plain one.
  const docId = `repo.${owner}.${name}.${branch ?? ''}${wf ? `.wf-${wf.id}` : ''}`.replace(/[^A-Za-z0-9._-]/g, '-')
  useEffect(() => {
    if (opened.data?.newPage && wf) toast.info(`Added “${wf.name}” as a new page`, { description: 'Review & commit opens a pull request that creates it.' })
    // Once per load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened.data?.newPage])

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

  if (locked) {
    return (
      <div className='space-y-6'>
        <PageHeader title={<span className='flex items-center gap-2'><BackButton onClick={onBack} />{name}</span>} />
        <EmptyState title={`${name} can’t be edited here`} description={locked}
          action={<Button variant='primary' onClick={onBack}>Back to apps</Button>} />
      </div>
    )
  }
  if (repos.isLoading || branches.isLoading || waitingForWf || (opened.isLoading && !!branch)) {
    return (
      <div className='space-y-4'>
        <PageHeader compact title={<span className='flex items-center gap-2'><BackButton onClick={onBack} />{name}</span>} />
        <OpeningState
          name={name}
          step={repos.isLoading ? 'Finding the repository' : branches.isLoading ? 'Reading branches' : waitingForWf ? 'Loading the wireframe' : `Reading pages and components on ${branch}`}
        />
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
          description={data.session.warnings[0] ?? `The designer edits ${SUPPORTED_FRAMEWORKS} apps.`}
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
        initialFileId={data.newPage ?? (page ? `pg:${page}` : undefined)}
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
            // Surface the PR on the wireframe it came from (Wireframes + dashboard).
            if (wf && res.pr) {
              const pr = { repo: `${owner}/${name}`, number: res.pr, branch: res.branch, base: branch, createdAt: new Date().toISOString() }
              updateWf.mutate({ ...wf, prs: [pr, ...(wf.prs ?? [])] }, {
                onError: (e) => toast.error('Could not link the pull request to the wireframe', { description: e.message }),
              })
              onWireframeDone()
            }
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
  // A project's wireframe is themed with the project's token set.
  const workspaceTheme = useWorkspaceTheme(doc.project)
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
