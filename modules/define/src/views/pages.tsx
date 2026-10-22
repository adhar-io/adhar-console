import { type DragEvent, useEffect, useMemo, useState } from 'react'
import { EmptyIcon } from '../components/empty-icon.tsx'
import { Button, docStore, EmptyState, Field, Input, Modal, Select, StatusBadge, Textarea, useOptionalUser, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { useProject, useProjects } from '../data/plane.ts'
import { classifyError, useProjectsData } from '../data/insights-data.ts'
import { defineLink, jql, useDefineParams, useOpenDefine, useSetDefineParams } from '../data/insights-nav.ts'
import {
  ancestors,
  buildTree,
  canMove,
  descendants,
  diffLines,
  diffStats,
  exportPath,
  type PageMeta,
  type PageNode,
  searchPages,
  TEMPLATES,
  toggleTaskAt,
} from '../data/pages-model.ts'
import { PageConflictError, useAllPages, usePageBody, usePageComments, usePageMutations, usePageSettings, usePageVersion } from '../data/pages-store.ts'
import { useExportPagesPr, useGiteaBranches, useGiteaRepos } from '../data/pages-gitea.ts'
import { ConsoleSideBadge, Loading, SourceNote } from '../components/insights-ui.tsx'
import { type IssueChipInfo, type MarkdownHooks, PageMarkdown } from '../components/page-markdown.tsx'
import { PageEditor } from '../components/page-editor.tsx'

/**
 * Pages — the project's wiki, kept by the console (Plane 1.4's public API has
 * no pages endpoints). Nested page tree, templates, markdown with a
 * sanitised live preview, @mentions, live Plane issue chips, version history
 * with diffs and restore, comments, lock / publish, search, and export to the
 * project's repository as a pull request.
 */

export function Pages({ projectId }: { projectId?: string }) {
  const params = useDefineParams()
  const setParams = useSetDefineParams()
  const project = useProject(projectId)
  const all = useAllPages()
  const user = useOptionalUser()
  const m = usePageMutations()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState<{ parent: string | null; title?: string } | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)

  const projectPages = useMemo(
    () => (all.data ?? []).filter((p) => p.project === projectId && (p.published !== false || p.createdBy === user?.id)),
    [all.data, projectId, user?.id],
  )
  const live = projectPages.filter((p) => !p.archived)
  const archived = projectPages.filter((p) => p.archived)
  const tree = buildTree(live)
  const current = params.page ? projectPages.find((p) => p.id === params.page) : undefined
  const hits = query.trim() ? searchPages(live, query) : []

  const openPage = (id: string | undefined, mode?: string) => {
    setParams({ page: id, mode }, { push: true })
    setTreeOpen(false)
  }

  const onWiki = (title: string) => {
    const hit = live.find((p) => p.title.toLowerCase() === title.toLowerCase())
    if (hit) openPage(hit.id)
    else setCreating({ parent: current?.id ?? null, title })
  }

  const move = (id: string, parent: string | null) => {
    const page = live.find((p) => p.id === id)
    if (!page || page.parent === parent) return
    if (!canMove(id, parent, live)) return toast.error("A page can't move inside itself")
    const siblings = live.filter((p) => p.parent === parent)
    m.update.mutate({ page, patch: { parent, order: siblings.length } }, { onError: (e) => toast.error("Couldn't move the page", { description: classifyError(e).message }) })
  }

  if (!projectId) return <EmptyState icon={<EmptyIcon name="folder" />} title="Pick a project" description="Pages belong to a project." />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Button size="sm" className="lg:hidden" onClick={() => setTreeOpen((o) => !o)}>{treeOpen ? 'Hide pages' : `Pages (${live.length})`}</Button>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search pages…" aria-label="Search pages" className="h-8 max-w-xs text-[13px]" />
          <ConsoleSideBadge label="Console-side wiki" />
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreating({ parent: null })}>New page</Button>
      </div>

      {all.error ? <SourceNote {...classifyError(all.error)} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className={cn('min-w-0 lg:block', treeOpen ? 'block' : 'hidden')}>
          <div className="rounded-xl border border-edge-default bg-surface-raised p-2 lg:sticky lg:top-4">
            {all.isLoading ? <Loading /> : (
              <>
                <RootDropZone onDrop={(id) => move(id, null)} />
                {tree.length
                  ? <ul className="space-y-0.5">{tree.map((n) => <TreeItem key={n.page.id} node={n} activeId={current?.id} onOpen={openPage} onAddChild={(id) => setCreating({ parent: id })} onDropOn={move} />)}</ul>
                  : <p className="px-2 py-3 text-[12px] text-content-subtle">No pages yet.</p>}
                {archived.length
                  ? (
                    <div className="mt-2 border-t border-edge-subtle pt-2">
                      <button type="button" className="px-2 text-[11px] font-medium text-content-subtle hover:text-content" onClick={() => setShowArchived((s) => !s)}>
                        {showArchived ? '▾' : '▸'} Archived ({archived.length})
                      </button>
                      {showArchived
                        ? <ul className="mt-1 space-y-0.5">{archived.map((p) => <li key={p.id}><button type="button" onClick={() => openPage(p.id)} className="block w-full truncate rounded px-2 py-1 text-left text-[12px] text-content-subtle hover:bg-surface-sunken">{p.title}</button></li>)}</ul>
                        : null}
                    </div>
                  )
                  : null}
              </>
            )}
          </div>
        </aside>

        <main className="min-w-0">
          {query.trim()
            ? (
              <div className="space-y-2">
                <div className="text-[12px] text-content-muted">{hits.length} result{hits.length === 1 ? '' : 's'} for “{query}”</div>
                <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
                  {hits.map((h) => (
                    <li key={h.page.id}>
                      <button type="button" onClick={() => { setQuery(''); openPage(h.page.id) }} className="block w-full px-4 py-3 text-left hover:bg-surface-sunken/50">
                        <div className="text-[13px] font-medium text-content">{h.page.icon ? `${h.page.icon} ` : ''}{h.page.title}</div>
                        <div className="mt-0.5 line-clamp-2 text-[12px] text-content-muted">{h.snippet}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
            : current
            ? (
              <PageView
                key={current.id}
                page={current}
                pages={projectPages}
                project={project.data}
                mode={params.mode}
                onMode={(mode) => setParams({ mode })}
                onOpen={openPage}
                onWiki={onWiki}
                onAddChild={() => setCreating({ parent: current.id })}
              />
            )
            : <PagesHome pages={live} onOpen={openPage} onNew={() => setCreating({ parent: null })} projectName={project.data?.name} loading={all.isLoading} />}
        </main>
      </div>

      {creating
        ? (
          <NewPageModal
            projectId={projectId}
            pages={live}
            parent={creating.parent}
            title={creating.title}
            onClose={() => setCreating(null)}
            onCreated={(p) => {
              setCreating(null)
              openPage(p.id, 'edit')
            }}
          />
        )
        : null}
    </div>
  )
}

/* ───── tree ───── */

const DND_TYPE = 'application/x-define-page'

function RootDropZone({ onDrop }: { onDrop(id: string): void }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_TYPE)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const id = e.dataTransfer.getData(DND_TYPE)
        if (id) onDrop(id)
      }}
      className={cn('mb-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle', over && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200')}
    >
      Pages {over ? '— drop to move to top level' : ''}
    </div>
  )
}

function TreeItem({ node, activeId, onOpen, onAddChild, onDropOn }: {
  node: PageNode
  activeId?: string
  onOpen(id: string): void
  onAddChild(id: string): void
  onDropOn(id: string, parent: string): void
}) {
  const containsActive = !!activeId && (node.page.id === activeId || node.children.some(function has(c): boolean {
    return c.page.id === activeId || c.children.some(has)
  }))
  const [open, setOpen] = useState(containsActive || node.depth === 0)
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (containsActive) setOpen(true)
  }, [containsActive])
  const p = node.page
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const id = e.dataTransfer.getData(DND_TYPE)
    if (id && id !== p.id) {
      onDropOn(id, p.id)
      setOpen(true)
    }
  }
  return (
    <li>
      <div
        draggable
        onDragStart={(e) => e.dataTransfer.setData(DND_TYPE, p.id)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DND_TYPE)) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn('group flex items-center gap-0.5 rounded-md pr-1', activeId === p.id ? 'bg-surface-sunken' : 'hover:bg-surface-sunken/60', over && 'ring-2 ring-brand-400')}
        style={{ paddingLeft: node.depth * 12 }}
      >
        <button type="button" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)} className={cn('w-5 shrink-0 text-[10px] text-content-subtle', !node.children.length && 'invisible')}>
          {open ? '▾' : '▸'}
        </button>
        <button type="button" onClick={() => onOpen(p.id)} className={cn('min-w-0 flex-1 truncate py-1 text-left text-[13px]', activeId === p.id ? 'font-semibold text-content' : 'text-content-muted')}>
          {p.icon ? `${p.icon} ` : ''}{p.title || 'Untitled'}
          {p.published === false ? <span className="ml-1 text-[10px] text-content-subtle">(draft)</span> : null}
          {p.locked ? <span className="ml-1 text-[10px]" title="Locked">🔒</span> : null}
        </button>
        <button type="button" aria-label={`Add a page under ${p.title}`} title="Add sub-page" onClick={() => onAddChild(p.id)} className="shrink-0 rounded px-1 text-[13px] text-content-subtle opacity-0 hover:text-content group-hover:opacity-100 focus:opacity-100">+</button>
      </div>
      {open && node.children.length
        ? <ul className="space-y-0.5">{node.children.map((c) => <TreeItem key={c.page.id} node={c} activeId={activeId} onOpen={onOpen} onAddChild={onAddChild} onDropOn={onDropOn} />)}</ul>
        : null}
    </li>
  )
}

/* ───── home ───── */

function PagesHome({ pages, onOpen, onNew, projectName, loading }: { pages: PageMeta[]; onOpen(id: string): void; onNew(): void; projectName?: string; loading: boolean }) {
  if (loading) return <Loading label="Loading pages…" />
  const recent = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)
  return (
    <div className="space-y-5">
      {recent.length
        ? (
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-content">Recently updated</h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recent.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => onOpen(p.id)} className="block w-full rounded-xl border border-edge-default bg-surface-raised p-3 text-left shadow-sm hover:border-edge-strong">
                    <div className="truncate text-[13px] font-semibold text-content">{p.icon ? `${p.icon} ` : ''}{p.title}</div>
                    <div className="mt-1 line-clamp-2 text-[12px] text-content-muted">{p.excerpt || 'Empty page'}</div>
                    <div className="mt-2 text-[11px] text-content-subtle">v{p.version} · {p.updatedByName ? `${p.updatedByName} · ` : ''}{formatRelative(p.updatedAt)}</div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
        : <EmptyState icon={<EmptyIcon name="page" />} title={`No pages in ${projectName ?? 'this project'} yet`} description="Start a wiki: PRDs, RFCs, runbooks, meeting notes. Pages are stored by the console and can be exported to the project's repository." action={<Button variant="primary" onClick={() => onNew()}>New page</Button>} />}
    </div>
  )
}

/* ───── create ───── */

function NewPageModal({ projectId, pages, parent: initialParent, title: initialTitle, onClose, onCreated }: {
  projectId: string
  pages: PageMeta[]
  parent: string | null
  title?: string
  onClose(): void
  onCreated(p: PageMeta): void
}) {
  const m = usePageMutations()
  const user = useOptionalUser()
  const toast = useToast()
  const [title, setTitle] = useState(initialTitle ?? '')
  const [parent, setParent] = useState<string | null>(initialParent)
  const [template, setTemplate] = useState('blank')
  const [draft, setDraft] = useState(false)
  const create = () => {
    const t = TEMPLATES.find((x) => x.id === template) ?? TEMPLATES[0]
    const name = title.trim() || 'Untitled'
    m.create.mutate(
      {
        project: projectId,
        parent,
        title: name,
        template: t.id,
        published: !draft,
        order: pages.filter((p) => p.parent === parent).length,
        body: t.body({ title: name, date: new Date().toISOString().slice(0, 10), author: (user?.name ?? 'me').replace(/\s+/g, '') }),
      },
      {
        onSuccess: (p) => {
          toast.success('Page created')
          onCreated(p)
        },
        onError: (e) => toast.error("Couldn't create the page", { description: classifyError(e).message }),
      },
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title="New page"
      footer={
        <div className="flex items-center justify-between gap-2">
          <label className="inline-flex items-center gap-1.5 text-[12px] text-content-muted"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Private draft</label>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={m.create.isPending} onClick={create}>Create page</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Title"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="Untitled" /></Field>
        <Field label="Location">
          <Select value={parent ?? ''} onChange={(e) => setParent(e.target.value || null)} options={[{ value: '', label: 'Top level' }, ...pages.map((p) => ({ value: p.id, label: [...ancestors(p.id, pages).map((a) => a.title), p.title].join(' / ') }))]} />
        </Field>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-content">Template</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TEMPLATES.map((t) => (
              <button key={t.id} type="button" onClick={() => setTemplate(t.id)} className={cn('rounded-lg border p-3 text-left', template === t.id ? 'border-brand-500 ring-2 ring-brand-500/30' : 'border-edge-default hover:border-edge-strong')}>
                <div className="text-[13px] font-semibold text-content">{t.icon} {t.name}</div>
                <div className="mt-0.5 text-[11px] text-content-muted">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

/* ───── page view / edit / history ───── */

function useIssueChips(project: plane.Project | undefined, refs: string[]): Pick<MarkdownHooks, 'issueKeys' | 'resolveIssue'> & { byKey: Map<string, { project: string; id: string }> } {
  const projects = useProjects()
  const identifiers = new Set((projects.data ?? []).map((p) => p.identifier))
  const referenced = [...new Set(refs.map((r) => r.split('-')[0]))].filter((k) => identifiers.has(k))
  const toLoad = (projects.data ?? []).filter((p) => p.id === project?.id || referenced.includes(p.identifier)).slice(0, 4)
  const data = useProjectsData(toLoad, { snapshot: false })
  return useMemo(() => {
    const stateName = new Map(data.states.map((s) => [s.id, s.name]))
    const map = new Map<string, IssueChipInfo>()
    const byKey = new Map<string, { project: string; id: string }>()
    for (const i of data.items) {
      if (!i.key) continue
      map.set(i.key, { name: i.name, group: i.group, stateName: stateName.get(i.state) })
      byKey.set(i.key, { project: i.project, id: i.id })
    }
    return { issueKeys: identifiers.size ? identifiers : undefined, resolveIssue: (k: string) => map.get(k), byKey }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.updatedAt, data.items.length, projects.data])
}

function PageView({ page, pages, project, mode, onMode, onOpen, onWiki, onAddChild }: {
  page: PageMeta
  pages: PageMeta[]
  project?: plane.Project
  mode?: string
  onMode(mode?: string): void
  onOpen(id?: string, mode?: string): void
  onWiki(title: string): void
  onAddChild(): void
}) {
  const body = usePageBody(page.id)
  const m = usePageMutations()
  const toast = useToast()
  const open = useOpenDefine()
  const user = useOptionalUser()
  const [draft, setDraft] = useState<string | null>(null)
  const [title, setTitle] = useState(page.title)
  const [base, setBase] = useState(page.version)
  const [conflict, setConflict] = useState<PageMeta | null>(null)
  const [exporting, setExporting] = useState(false)
  const [moving, setMoving] = useState(false)
  const editing = mode === 'edit'
  const text = body.data?.body ?? ''
  const chips = useIssueChips(project, [...(page.issueRefs ?? []), ...(draft ? (draft.match(/\b[A-Z][A-Z0-9]{1,11}-\d+\b/g) ?? []) : [])])
  const wikiExists = (t: string) => pages.some((p) => p.title.toLowerCase() === t.toLowerCase() && !p.archived)
  const hooks: MarkdownHooks = {
    ...chips,
    wikiExists,
    onWiki,
    onIssue: (key) => {
      const hit = chips.byKey.get(key)
      open('issues', hit ? { project: hit.project, issue: hit.id, q: jql({ key }) } : { q: jql({ key }) })
    },
  }

  // Enter edit mode with the latest body.
  useEffect(() => {
    if (editing && draft === null && body.data) {
      setDraft(body.data.body)
      setTitle(page.title)
      setBase(page.version)
    }
    if (!editing) setDraft(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, body.data])

  // Warn before leaving with unsaved edits.
  const dirty = editing && draft !== null && (draft !== text || title !== page.title)
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    globalThis.addEventListener('beforeunload', h)
    return () => globalThis.removeEventListener('beforeunload', h)
  }, [dirty])

  const save = (force = false) => {
    if (draft === null) return
    m.save.mutate(
      { page, title: title.trim() || 'Untitled', body: draft, baseVersion: base, issueKeys: chips.issueKeys, force },
      {
        onSuccess: (p) => {
          toast.success(`Saved v${p.version}`)
          setConflict(null)
          onMode(undefined)
        },
        onError: (e) => {
          if (e instanceof PageConflictError) setConflict(e.latest)
          else toast.error("Couldn't save the page", { description: e instanceof Error ? e.message : classifyError(e).message })
        },
      },
    )
  }

  const patch = (p: Parameters<typeof m.update.mutate>[0]['patch'], ok: string) =>
    m.update.mutate({ page, patch: p }, { onSuccess: () => toast.success(ok), onError: (e) => toast.error("Couldn't update the page", { description: classifyError(e).message }) })

  const crumbs = ancestors(page.id, pages)
  const canEdit = !page.locked && !page.archived

  return (
    <article className="space-y-4">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-[12px] text-content-subtle">
        <button type="button" className="hover:text-content" onClick={() => onOpen(undefined)}>Pages</button>
        {crumbs.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1">/ <button type="button" className="hover:text-content" onClick={() => onOpen(c.id)}>{c.title}</button></span>
        ))}
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing
            ? <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Page title" className="text-lg font-semibold" />
            : <h1 className="text-[22px] font-semibold tracking-tight text-content">{page.icon ? `${page.icon} ` : ''}{page.title}</h1>}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-content-subtle">
            <span>v{page.version}</span>
            <span>· {page.updatedByName ? `${page.updatedByName}, ` : ''}{formatRelative(page.updatedAt)}</span>
            {page.published === false ? <StatusBadge kind="unknown">Draft</StatusBadge> : null}
            {page.locked ? <StatusBadge kind="paused">Locked</StatusBadge> : null}
            {page.archived ? <StatusBadge kind="failed">Archived</StatusBadge> : null}
            {page.mentions?.length ? <span>· mentions {page.mentions.map((x) => `@${x}`).join(', ')}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editing
            ? (
              <>
                <Button size="sm" onClick={() => {
                  if (dirty && !confirm('Discard your changes?')) return
                  onMode(undefined)
                }}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" loading={m.save.isPending} disabled={!dirty} onClick={() => save()}>Save</Button>
              </>
            )
            : mode === 'history'
            ? <Button size="sm" onClick={() => onMode(undefined)}>Close history</Button>
            : (
              <>
                <Button size="sm" onClick={() => onMode('history')}>History</Button>
                <PageMenu
                  page={page}
                  onLock={() => patch({ locked: !page.locked }, page.locked ? 'Page unlocked' : 'Page locked')}
                  onPublish={() => patch({ published: page.published === false }, page.published === false ? 'Page published' : 'Page is now a private draft')}
                  onArchive={() => patch({ archived: !page.archived }, page.archived ? 'Page restored' : 'Page archived')}
                  onMove={() => setMoving(true)}
                  onExport={() => setExporting(true)}
                  onAddChild={onAddChild}
                  onCopy={() => void navigator.clipboard?.writeText(defineLink({ page: page.id, mode: undefined })).then(() => toast.success('Link copied'))}
                  onDelete={() => {
                    const kids = descendants(page.id, pages)
                    if (!confirm(`Delete “${page.title}”${kids.length ? ` and its ${kids.length} sub-page${kids.length === 1 ? '' : 's'}` : ''}, with all versions and comments? This can't be undone.`)) return
                    m.remove.mutate({ pages: [page, ...pages.filter((p) => kids.includes(p.id))] }, {
                      onSuccess: () => {
                        toast.success('Page deleted')
                        onOpen(undefined)
                      },
                      onError: (e) => toast.error("Couldn't delete", { description: classifyError(e).message }),
                    })
                  }}
                  canDelete={page.createdBy === user?.id || !page.createdBy}
                />
                <Button size="sm" variant="primary" disabled={!canEdit} onClick={() => onMode('edit')} title={page.locked ? 'Unlock the page to edit it' : undefined}>Edit</Button>
              </>
            )}
        </div>
      </header>

      {conflict
        ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <span className="flex-1">{conflict.updatedByName ?? 'Someone'} saved v{conflict.version} while you were editing. Your text is still here.</span>
            <Button size="xs" onClick={() => {
              void navigator.clipboard?.writeText(draft ?? '')
              toast.info('Your draft is on the clipboard')
              setDraft(null)
              setConflict(null)
              void body.refetch().then((r) => {
                setDraft(r.data?.body ?? '')
                setBase(conflict.version)
              })
            }}>
              Load theirs (copy mine)
            </Button>
            <Button size="xs" variant="danger" onClick={() => save(true)}>Overwrite with mine</Button>
          </div>
        )
        : null}

      {body.isLoading ? <Loading /> : body.error ? <SourceNote {...classifyError(body.error)} /> : editing && draft !== null
        ? <PageEditor value={draft} onChange={setDraft} onSave={() => dirty && save()} hooks={hooks} autoFocus />
        : mode === 'history'
        ? <HistoryPanel page={page} current={text} onRestore={(restored) => {
          m.save.mutate({ page, title: page.title, body: restored.body, baseVersion: page.version, note: `Restored v${restored.v}`, issueKeys: chips.issueKeys }, {
            onSuccess: (p) => {
              toast.success(`Restored v${restored.v} as v${p.version}`)
              onMode(undefined)
            },
            onError: (e) => toast.error("Couldn't restore", { description: e instanceof Error ? e.message : classifyError(e).message }),
          })
        }} />
        : (
          <div className="rounded-xl border border-edge-default bg-surface-raised p-5 sm:p-6">
            <PageMarkdown
              text={text}
              hooks={{
                ...hooks,
                onToggleTask: canEdit
                  ? (n) => m.save.mutate({ page, title: page.title, body: toggleTaskAt(text, n), baseVersion: page.version, note: 'Checked a task', issueKeys: chips.issueKeys }, {
                    onError: (e) => toast.error("Couldn't update the task", { description: e instanceof Error ? e.message : classifyError(e).message }),
                  })
                  : undefined,
              }}
            />
          </div>
        )}

      {!editing && mode !== 'history' ? <SubPages page={page} pages={pages} onOpen={onOpen} /> : null}
      {!editing ? <CommentsPanel pageId={page.id} /> : null}

      {exporting ? <ExportModal page={page} pages={pages} project={project} onClose={() => setExporting(false)} /> : null}
      {moving
        ? (
          <MoveModal
            page={page}
            pages={pages}
            onClose={() => setMoving(false)}
            onMove={(parent) => {
              patch({ parent, order: pages.filter((p) => p.parent === parent).length }, 'Page moved')
              setMoving(false)
            }}
          />
        )
        : null}
    </article>
  )
}

function PageMenu(props: {
  page: PageMeta
  onLock(): void
  onPublish(): void
  onArchive(): void
  onMove(): void
  onExport(): void
  onAddChild(): void
  onCopy(): void
  onDelete(): void
  canDelete: boolean
}) {
  const { page } = props
  const items: Array<{ value: string; label: string; run(): void }> = [
    { value: 'child', label: 'Add sub-page', run: props.onAddChild },
    { value: 'copy', label: 'Copy link', run: props.onCopy },
    { value: 'move', label: 'Move…', run: props.onMove },
    { value: 'lock', label: page.locked ? 'Unlock' : 'Lock editing', run: props.onLock },
    { value: 'publish', label: page.published === false ? 'Publish to everyone' : 'Make private draft', run: props.onPublish },
    { value: 'export', label: 'Export to repo as PR…', run: props.onExport },
    { value: 'archive', label: page.archived ? 'Restore from archive' : 'Archive', run: props.onArchive },
    ...(props.canDelete ? [{ value: 'delete', label: 'Delete…', run: props.onDelete }] : []),
  ]
  return (
    <Select
      aria-label="More page actions"
      value=""
      onChange={(e) => items.find((i) => i.value === e.target.value)?.run()}
      options={[{ value: '', label: 'More…' }, ...items.map(({ value, label }) => ({ value, label }))]}
      className="h-8 py-1 text-[12px]"
    />
  )
}

function SubPages({ page, pages, onOpen }: { page: PageMeta; pages: PageMeta[]; onOpen(id: string): void }) {
  const kids = pages.filter((p) => p.parent === page.id && !p.archived).sort((a, b) => a.order - b.order)
  if (!kids.length) return null
  return (
    <section>
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-content-subtle">Sub-pages</h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {kids.map((k) => (
          <li key={k.id}><button type="button" onClick={() => onOpen(k.id)} className="block w-full truncate rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-left text-[13px] text-content hover:border-edge-strong">{k.icon ? `${k.icon} ` : ''}{k.title}</button></li>
        ))}
      </ul>
    </section>
  )
}

function HistoryPanel({ page, current, onRestore }: { page: PageMeta; current: string; onRestore(v: { v: number; body: string }): void }) {
  const versions = [...page.history].reverse()
  const [sel, setSel] = useState<number | undefined>(versions[1]?.v ?? versions[0]?.v)
  const [against, setAgainst] = useState<number>(page.version)
  const a = usePageVersion(page.id, sel)
  const b = usePageVersion(page.id, against !== page.version ? against : undefined)
  const right = against === page.version ? current : b.data?.body ?? ''
  const diff = a.data ? diffLines(a.data.body, right) : []
  const stats = diffStats(diff)
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <ul className="max-h-128 space-y-0.5 overflow-auto rounded-xl border border-edge-default bg-surface-raised p-1.5">
        {versions.map((h) => (
          <li key={h.v}>
            <button type="button" onClick={() => setSel(h.v)} className={cn('block w-full rounded-md px-2 py-1.5 text-left', sel === h.v ? 'bg-surface-sunken' : 'hover:bg-surface-sunken/60')}>
              <div className="text-[12px] font-medium text-content">v{h.v}{h.v === page.version ? ' · current' : ''}</div>
              <div className="text-[11px] text-content-subtle">{h.by ? `${h.by} · ` : ''}{formatRelative(h.at)}{h.note ? ` · ${h.note}` : ''}</div>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-content-muted">
          <span>Comparing v{sel ?? '—'} with</span>
          <Select aria-label="Compare with" value={String(against)} onChange={(e) => setAgainst(Number(e.target.value))} options={versions.map((h) => ({ value: String(h.v), label: h.v === page.version ? `v${h.v} (current)` : `v${h.v}` }))} className="h-7 py-0.5 text-[12px]" />
          {a.data ? <span><span className="text-emerald-700 dark:text-emerald-300">+{stats.added}</span> / <span className="text-rose-700 dark:text-rose-300">−{stats.removed}</span> lines</span> : null}
          {sel && sel !== page.version && a.data ? <Button size="xs" className="ml-auto" onClick={() => onRestore({ v: sel, body: a.data!.body })}>Restore v{sel}</Button> : null}
        </div>
        {a.isLoading || b.isLoading ? <Loading /> : a.error ? <SourceNote {...classifyError(a.error)} /> : !a.data ? <p className="text-[12px] text-content-subtle">Pick a version.</p> : (
          <pre className="max-h-128 overflow-auto rounded-xl border border-edge-default bg-surface-raised p-0 font-mono text-[12px] leading-relaxed">
            {diff.map((l, i) => (
              <div key={i} className={cn('whitespace-pre-wrap px-3', l.op === 'add' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200', l.op === 'del' && 'bg-rose-50 text-rose-900 line-through decoration-rose-400/60 dark:bg-rose-500/10 dark:text-rose-200')}>
                <span className="mr-2 select-none text-content-subtle">{l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}</span>{l.text || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}

function CommentsPanel({ pageId }: { pageId: string }) {
  const c = usePageComments(pageId)
  const toast = useToast()
  const [text, setText] = useState('')
  const [showResolved, setShowResolved] = useState(false)
  const list = (c.data ?? []).filter((x) => showResolved || !x.resolved)
  const resolvedCount = (c.data ?? []).filter((x) => x.resolved).length
  return (
    <section className="space-y-3 rounded-xl border border-edge-default bg-surface-raised p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-content">Comments {c.data?.length ? <span className="font-normal text-content-subtle">({c.data.length - resolvedCount} open)</span> : null}</h2>
        {resolvedCount ? <button type="button" className="text-[11px] text-content-subtle hover:text-content" onClick={() => setShowResolved((s) => !s)}>{showResolved ? 'Hide' : 'Show'} {resolvedCount} resolved</button> : null}
      </div>
      {c.error ? <SourceNote compact {...classifyError(c.error)} /> : null}
      <ul className="space-y-3">
        {list.map((x) => (
          <li key={x.id} className={cn('rounded-lg border border-edge-subtle p-3', x.resolved && 'opacity-60')}>
            <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-content-subtle">
              <span className="font-semibold text-content">{x.by ?? 'Someone'}</span>
              <span>{formatRelative(x.at)}</span>
              <span className="ml-auto flex gap-2">
                <button type="button" className="hover:text-content" onClick={() => void c.resolve(x.id, !x.resolved)}>{x.resolved ? 'Reopen' : 'Resolve'}</button>
                {x.byId === c.userId ? <button type="button" className="hover:text-rose-600" onClick={() => void c.remove(x.id)}>Delete</button> : null}
              </span>
            </div>
            <PageMarkdown text={x.body} className="mt-1 text-[13px]" />
          </li>
        ))}
      </ul>
      <div className="space-y-2">
        <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment — markdown and @mentions work" aria-label="New comment" />
        <div className="flex justify-end">
          <Button size="sm" variant="primary" disabled={!text.trim()} loading={c.pending} onClick={() => c.add(text.trim()).then(() => setText('')).catch((e) => toast.error("Couldn't comment", { description: classifyError(e).message }))}>Comment</Button>
        </div>
      </div>
    </section>
  )
}

function MoveModal({ page, pages, onClose, onMove }: { page: PageMeta; pages: PageMeta[]; onClose(): void; onMove(parent: string | null): void }) {
  const options = pages.filter((p) => !p.archived && canMove(page.id, p.id, pages))
  const [to, setTo] = useState(page.parent ?? '')
  return (
    <Modal open onClose={onClose} width="sm" title="Move page" description={page.title} footer={<div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onMove(to || null)}>Move</Button></div>}>
      <Field label="New parent">
        <Select value={to} onChange={(e) => setTo(e.target.value)} options={[{ value: '', label: 'Top level' }, ...options.map((p) => ({ value: p.id, label: [...ancestors(p.id, pages).map((a) => a.title), p.title].join(' / ') }))]} />
      </Field>
    </Modal>
  )
}

/* ───── export to repo ───── */

function ExportModal({ page, pages, project, onClose }: { page: PageMeta; pages: PageMeta[]; project?: plane.Project; onClose(): void }) {
  const settings = usePageSettings(page.project)
  const repos = useGiteaRepos(true)
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [folder, setFolder] = useState('docs')
  const [scope, setScope] = useState<'page' | 'tree' | 'all'>('page')
  const branches = useGiteaBranches(repo || undefined)
  const exp = useExportPagesPr()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (settings.data) {
      setRepo(settings.data.repo)
      setBranch(settings.data.branch)
      setFolder(settings.data.folder)
    }
  }, [settings.data])
  useEffect(() => {
    if (repo && !branch) {
      const r = (repos.data ?? []).find((x) => x.name === repo)
      if (r?.default_branch) setBranch(r.default_branch)
    }
  }, [repo, branch, repos.data])
  const live = pages.filter((p) => !p.archived && p.published !== false)
  const chosen = scope === 'page' ? [page] : scope === 'tree' ? [page, ...live.filter((p) => descendants(page.id, live).includes(p.id))] : live
  const run = async () => {
    setBusy(true)
    try {
      await settings.save.mutateAsync({ repo, branch, folder })
      const files = await Promise.all(chosen.map(async (p) => {
        const b = await docStore.get<{ body: string }>('define.page-body', p.id)
        return { path: exportPath(p, pages, folder), content: `${b?.data.body ?? ''}\n` }
      }))
      const pr = await exp.mutateAsync({
        repo,
        branch,
        files,
        title: `docs: ${scope === 'page' ? page.title : `${chosen.length} pages from ${project?.name ?? 'Define'}`}`,
        body: `Exported from Define Pages${project ? ` (${project.name})` : ''}.\n\n${files.map((f) => `- \`${f.path}\``).join('\n')}`,
      })
      toast.success(`Pull request #${pr.number} opened`, { description: pr.url })
      onClose()
    } catch (e) {
      toast.error("Couldn't open the pull request", { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width="md"
      title="Export to repository"
      description="Opens a pull request with the page as markdown. The project's repo choice is remembered."
      footer={<div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!repo || !branch} onClick={() => void run()}>Open pull request</Button></div>}
    >
      <div className="space-y-3">
        {repos.error ? <SourceNote compact {...classifyError(repos.error)} /> : null}
        <Field label="Repository">
          <Select value={repo} onChange={(e) => { setRepo(e.target.value); setBranch('') }} options={[{ value: '', label: repos.isLoading ? 'Loading…' : 'Pick a repository' }, ...(repos.data ?? []).map((r) => ({ value: r.name, label: r.name }))]} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Base branch">
            <Select value={branch} onChange={(e) => setBranch(e.target.value)} options={[{ value: '', label: 'Branch…' }, ...(branches.data ?? []).map((b) => ({ value: b.name, label: b.name }))]} />
          </Field>
          <Field label="Folder"><Input value={folder} onChange={(e) => setFolder(e.target.value)} /></Field>
        </div>
        <Field label="What to export">
          <Select value={scope} onChange={(e) => setScope(e.target.value as 'page' | 'tree' | 'all')} options={[{ value: 'page', label: 'This page' }, { value: 'tree', label: 'This page and its sub-pages' }, { value: 'all', label: 'All published pages in the project' }]} />
        </Field>
        <ul className="max-h-32 overflow-auto rounded-lg bg-surface-sunken/60 px-3 py-2 font-mono text-[11px] text-content-muted">
          {chosen.map((p) => <li key={p.id}>{exportPath(p, pages, folder)}</li>)}
        </ul>
      </div>
    </Modal>
  )
}
