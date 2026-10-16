import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  Skeleton,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  BuilderApp,
  createStarterProject,
  defaultProjectFor,
  normalizeProject,
  ProjectThumbnail,
  RepoActions,
  STARTERS,
  type BuilderSaveEvent,
  type StarterId,
  type ThemePreset,
} from '@adhar/builder'
import { KIND, TOKEN_SET_ID, useDoc } from '../data/store.ts'
import type { TokenSet, Wireframe } from '../data/types.ts'
import { projectToBlocks, wireframeToProject } from '../data/wireframe-builder.ts'
import { themeFromTokenSet, WORKSPACE_THEME_ID } from '../data/builder-theme.ts'
import { copyName, filterProjects, newProjectId, type ProjectSummary } from '../data/builder-library.ts'
import { useBuilderProjects, useDeleteProject, useInvalidateProjects, useSaveProject } from '../data/builder-projects.ts'
import { useUrlParam } from '../data/builder-nav.ts'
import { ErrorBlock } from '../components/async-states.tsx'

/**
 * Design → Visual Designer — a drag-and-drop app builder.
 *
 * A project library over the console document store, and `@adhar/builder`
 * (pages & routes, reusable components, data binding, interactions, clickable
 * prototype, versions, React + Tailwind export) for the open project:
 *
 *   • Library — create (blank or a starter app), open, rename, duplicate,
 *     delete, search; live thumbnails of each app's home page.
 *   • Editor  — the studio, plus named versions and a Gitea commit/open
 *     round trip in the header.
 *   • Theme   — the workspace design tokens (Design → Design Tokens) are offered
 *     as the "Workspace" theme; new projects start on it.
 *   • URL     — `?section=builder&doc=<id>` opens a project directly, so
 *     refresh and shared links land on it.
 */
export function Builder() {
  const [docId, setDocId] = useUrlParam('doc')
  const workspaceTheme = useWorkspaceTheme()
  const themes = useMemo(() => (workspaceTheme ? [workspaceTheme] : []), [workspaceTheme])

  if (docId) {
    return <ProjectEditor id={docId} themes={themes} onBack={() => setDocId(undefined)} />
  }
  return <ProjectLibrary workspaceTheme={workspaceTheme} themes={themes} onOpen={(id) => setDocId(id, { replace: false })} />
}

/** The workspace token set as a builder theme; null until/unless it has colours. */
function useWorkspaceTheme(): ThemePreset | null {
  const { data } = useDoc<TokenSet>(KIND.tokenSet, TOKEN_SET_ID)
  return useMemo(() => themeFromTokenSet(data ?? null), [data])
}

/* ───────────────────────────── editor ───────────────────────────── */

function ProjectEditor({ id, themes, onBack }: { id: string; themes: ThemePreset[]; onBack(): void }) {
  const projects = useBuilderProjects()
  const invalidate = useInvalidateProjects()
  const summary = projects.data?.find((p) => p.id === id)

  const back = useCallback(() => {
    void invalidate()
    onBack()
  }, [invalidate, onBack])

  if (projects.isLoading) return <EditorSkeleton />
  if (projects.data && !summary) {
    return (
      <div className="space-y-6">
        <PageHeader title="Visual Designer" />
        <EmptyState
          title="Project not found"
          description="It may have been deleted, or the link points at another workspace."
          action={<Button variant="primary" onClick={back}>Back to projects</Button>}
        />
      </div>
    )
  }
  const name = summary?.name ?? 'Untitled'
  return (
    <BuilderApp
      key={id}
      mode="visual"
      docId={id}
      docName={name}
      onBack={back}
      themes={themes}
      actions={(ctl) => <RepoActions ctl={ctl} commitMessage={`design: update ${name}`} />}
    />
  )
}

function EditorSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton height={36} width={260} className="block" />
      <Skeleton height={560} className="block w-full" rounded="lg" />
    </div>
  )
}

/* ───────────────────────────── library ───────────────────────────── */

type Dialog =
  | { kind: 'create' }
  | { kind: 'rename'; project: ProjectSummary }
  | { kind: 'delete'; project: ProjectSummary }
  | null

function ProjectLibrary({ workspaceTheme, themes, onOpen }: { workspaceTheme: ThemePreset | null; themes: ThemePreset[]; onOpen(id: string): void }) {
  const toast = useToast()
  const projects = useBuilderProjects()
  const save = useSaveProject()
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  // `?new=1` (e.g. from the Design dashboard's "New" menu) opens the create flow once.
  const [newParam, setNewParam] = useUrlParam('new')
  useEffect(() => {
    if (newParam !== '1') return
    setDialog({ kind: 'create' })
    setNewParam(undefined, { replace: true })
  }, [newParam, setNewParam])
  const list = useMemo(() => filterProjects(projects.data ?? [], query), [projects.data, query])

  const duplicate = async (p: ProjectSummary) => {
    const id = newProjectId()
    const name = copyName(p.name, (projects.data ?? []).map((x) => x.name))
    try {
      await save.mutateAsync({ id, project: { ...p.project, name } })
      toast.success('Project duplicated', { description: name })
    } catch (e) {
      toast.error('Duplicate failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visual Designer"
        actions={
          <Button variant="primary" size="sm" onClick={() => setDialog({ kind: 'create' })} leading={<PlusGlyph />}>
            New app
          </Button>
        }
      />

      {projects.error ? (
        <ErrorBlock error={projects.error as Error} onRetry={() => void projects.refetch()} />
      ) : projects.isLoading ? (
        <CardGrid>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton height={170} className="block w-full" rounded="lg" />
              <Skeleton height={14} width="60%" className="block" />
            </div>
          ))}
        </CardGrid>
      ) : (projects.data ?? []).length === 0 ? (
        <EmptyState
          title="No apps yet"
          description={
            workspaceTheme
              ? 'Start blank or from a starter app — admin, dashboard, marketing site, auth flow. New apps use your workspace design tokens.'
              : 'Start blank or from a starter app — admin, dashboard, marketing site, auth flow.'
          }
          action={
            <Button variant="primary" onClick={() => setDialog({ kind: 'create' })} leading={<PlusGlyph />}>
              New app
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput value={query} onChange={setQuery} placeholder="Search projects…" block={false} className="w-full sm:w-72" />
            <span className="text-xs text-content-muted">
              {list.length} of {projects.data!.length} project{projects.data!.length === 1 ? '' : 's'}
            </span>
          </div>
          {list.length === 0 ? (
            <EmptyState compact title="No matching projects" description={`Nothing is named like “${query}”.`} />
          ) : (
            <CardGrid>
              {list.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  themes={themes}
                  onOpen={() => onOpen(p.id)}
                  onRename={() => setDialog({ kind: 'rename', project: p })}
                  onDuplicate={() => void duplicate(p)}
                  onDelete={() => setDialog({ kind: 'delete', project: p })}
                />
              ))}
            </CardGrid>
          )}
        </>
      )}

      {dialog?.kind === 'create' ? (
        <CreateDialog
          workspaceTheme={workspaceTheme}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null)
            onOpen(id)
          }}
        />
      ) : null}
      {dialog?.kind === 'rename' ? <RenameDialog project={dialog.project} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'delete' ? <DeleteDialog project={dialog.project} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}

function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{children}</div>
}

function ProjectCard({
  project,
  themes,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: {
  project: ProjectSummary
  themes: ThemePreset[]
  onOpen(): void
  onRename(): void
  onDuplicate(): void
  onDelete(): void
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full overflow-hidden rounded-xl border border-edge-default bg-surface-raised text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 dark:hover:border-brand-500/40"
      >
        <ProjectThumbnail project={project.project} themes={themes} className="aspect-[16/10] w-full border-b border-edge-subtle" />
        <div className="px-3.5 py-3">
          <div className="truncate pr-24 text-sm font-semibold text-content">{project.name}</div>
          <div className="mt-0.5 text-xs text-content-muted">
            {project.pages} page{project.pages === 1 ? '' : 's'} · edited {formatRelative(project.updatedAt)}
          </div>
        </div>
      </button>
      <div className="absolute bottom-3 right-2.5 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <IconAction label="Rename" onClick={onRename}><PencilGlyph /></IconAction>
        <IconAction label="Duplicate" onClick={onDuplicate}><CopyGlyph /></IconAction>
        <IconAction label="Delete" onClick={onDelete} danger><TrashGlyph /></IconAction>
      </div>
    </div>
  )
}

function IconAction({ label, onClick, danger, children }: { label: string; onClick(): void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
        danger ? 'hover:text-rose-600' : 'hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

/* ───────────────────────────── dialogs ───────────────────────────── */

function CreateDialog({
  workspaceTheme,
  onClose,
  onCreated,
}: {
  workspaceTheme: ThemePreset | null
  onClose(): void
  onCreated(id: string): void
}) {
  const toast = useToast()
  const save = useSaveProject()
  const [name, setName] = useState('')
  const [starter, setStarter] = useState<StarterId>('blank')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const finalName = name.trim() || 'Untitled app'
    setBusy(true)
    try {
      const project = await createStarterProject({
        name: finalName,
        starter,
        theme: workspaceTheme ? WORKSPACE_THEME_ID : 'adhar',
      })
      const id = newProjectId()
      await save.mutateAsync({ id, project })
      onCreated(id)
    } catch (e) {
      toast.error('Could not create the project', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New app"
      description={workspaceTheme ? 'Uses your workspace design tokens as its theme.' : undefined}
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Create & open
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            placeholder="e.g. Customer portal"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && void submit()}
          />
        </Field>
        <div>
          <div className="mb-2 text-sm font-medium text-content">Start from</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {STARTERS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStarter(s.id)}
                aria-pressed={starter === s.id}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
                  starter === s.id
                    ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10'
                    : 'border-edge-default hover:border-edge-strong hover:bg-surface-hover',
                )}
              >
                <div className="text-sm font-medium text-content">{s.label}</div>
                <div className="text-xs text-content-muted">{s.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function RenameDialog({ project, onClose }: { project: ProjectSummary; onClose(): void }) {
  const toast = useToast()
  const save = useSaveProject()
  const [name, setName] = useState(project.name)
  const submit = () => {
    const next = name.trim()
    if (!next || next === project.name) return onClose()
    save.mutate(
      { id: project.id, project: { ...project.project, name: next } },
      {
        onSuccess: () => {
          toast.success('Renamed', { description: next })
          onClose()
        },
        onError: (e) => toast.error('Rename failed', { description: e.message }),
      },
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Rename project"
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={save.isPending}>Rename</Button>
        </>
      }
    >
      <Field label="Name">
        <Input
          autoFocus
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && submit()}
        />
      </Field>
    </Modal>
  )
}

function DeleteDialog({ project, onClose }: { project: ProjectSummary; onClose(): void }) {
  const toast = useToast()
  const remove = useDeleteProject()
  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete “${project.name}”?`}
      description="The project is removed for everyone in this workspace. Anything already committed to a repository stays there."
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(project.id, {
                onSuccess: () => {
                  toast.success('Project deleted', { description: project.name })
                  onClose()
                },
                onError: (e) => toast.error('Delete failed', { description: e.message }),
              })}
          >
            Delete
          </Button>
        </>
      }
    >
      <div className="text-sm text-content-muted">This cannot be undone.</div>
    </Modal>
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
      mode="visual"
      docId={`design.wireframe.${doc.id}`}
      docName={doc.name}
      title={title ?? doc.name}
      initialProject={initialProject}
      onSave={save}
      onBack={onBack}
      themes={themes}
      variant="embedded"
      height="calc(100vh - 250px)"
    />
  )
}

/* ───────────────────────────── glyphs ───────────────────────────── */

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}
const PlusGlyph = () => <Glyph><path d="M12 5v14M5 12h14" /></Glyph>
const PencilGlyph = () => <Glyph><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Glyph>
const CopyGlyph = () => <Glyph><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Glyph>
const TrashGlyph = () => <Glyph><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></Glyph>

export default Builder
