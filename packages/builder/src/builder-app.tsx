import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, docStore, DocStoreError, PageHeader, Spinner, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { BUILDER_CSS } from './builder-styles.ts'
import { ensureStyle } from './lib/inject-style.ts'
import { setExtraThemePresets, type ThemePreset } from './lib/builder-api.ts'
import { VersionsDialog } from './components/versions-dialog.tsx'
import { defaultProjectFor, normalizeProject } from './lib/project.ts'
import type {
  BuilderController,
  BuilderMode,
  BuilderProject,
  BuilderSaveEvent,
  GeneratedFile,
} from './types.ts'

/*
 * The workbench — canvas, panels, generators — is one lazy chunk. Monaco,
 * Mermaid and React Flow are further lazy chunks inside it, fetched only when
 * a surface that needs them opens. Importing `@adhar/builder` costs a host
 * module this file and nothing more.
 */
const Workbench = lazy(() => import('./app.tsx'))

/** docStore collection the builder persists projects in (tenant-scoped Postgres). */
export const BUILDER_STORE_KIND = 'builder.project'

const MODE_LABEL: Record<BuilderMode, string> = {
  visual: 'Visual Designer',
  workflow: 'Workflow Builder',
  theme: 'Theme Builder',
}

export interface BuilderAppProps {
  mode: BuilderMode
  /**
   * Stable id of the document being edited. Persisted under
   * `builder.project/<docId>` unless `onSave` takes over persistence.
   * Defaults to the mode, i.e. one shared scratch project per mode.
   */
  docId?: string
  /** Shown as the page title when `title` is not given. */
  docName?: string
  title?: ReactNode
  /** Seed when nothing is stored yet (e.g. a wireframe being opened). */
  initialProject?: BuilderProject
  /**
   * Take over persistence: called on Save (⌘S) with the full project. When
   * omitted the builder saves to the console document store itself.
   */
  onSave?(doc: BuilderSaveEvent): void | Promise<void>
  /** Renders a Back control before the title. */
  onBack?(): void
  /** Extra page-header actions, rendered left of Save. */
  actions?(ctl: BuilderController): ReactNode
  /** Editor height. Defaults to filling the viewport below the page header. */
  height?: string
  /**
   * `page` (default) renders a PageHeader — the builder IS the page.
   * `embedded` renders a slim title row, for a builder opened inside another
   * page that already has its own header (e.g. a wireframe from the library).
   */
  variant?: 'page' | 'embedded'
  /**
   * Extra design-theme presets offered ahead of the built-ins — e.g. Design's
   * "Workspace" theme derived from the workspace design tokens.
   */
  themes?: ThemePreset[]
  className?: string
}

type LoadState = { status: 'loading' } | { status: 'ready'; project: BuilderProject }

const draftKey = (id: string) => `adhar.builder.draft:${id}`

function readDraft(id: string): { at: number; project: BuilderProject } | null {
  try {
    const raw = localStorage.getItem(draftKey(id))
    if (!raw) return null
    const v = JSON.parse(raw) as { at?: number; project?: unknown }
    const project = normalizeProject(v.project)
    return project && typeof v.at === 'number' ? { at: v.at, project } : null
  } catch {
    return null
  }
}
function writeDraft(id: string, project: BuilderProject) {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify({ at: Date.now(), project }))
  } catch {
    /* storage full / blocked — the draft is a convenience only */
  }
}
function clearDraft(id: string) {
  try {
    localStorage.removeItem(draftKey(id))
  } catch {
    /* ignore */
  }
}

/**
 * The Adhar Visual Designer — the component behind Design → Visual Designer
 * and wireframe editing. A mode only decides what it opens on.
 *
 * Persistence: the console's document store (Postgres, tenant-scoped) by
 * default, or the host's `onSave`. Every edit is also mirrored to a local
 * draft, so a reload or a crash before Save loses nothing; a draft newer than
 * the stored copy is restored with a toast.
 */
export function BuilderApp({
  mode,
  docId,
  docName,
  title,
  initialProject,
  onSave,
  onBack,
  actions,
  height,
  variant = 'page',
  themes,
  className,
}: BuilderAppProps) {
  ensureStyle('adhar-builder-css', BUILDER_CSS)
  // One builder is mounted at a time; idempotent, so safe during render.
  setExtraThemePresets(themes ?? [])
  const toast = useToast()
  const id = docId ?? mode
  const name = docName ?? MODE_LABEL[mode]

  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [revision, setRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const latest = useRef<BuilderProject | null>(null)

  // ── load ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const settle = (project: BuilderProject, isDirty = false) => {
      if (cancelled) return
      latest.current = project
      setDirty(isDirty)
      setLoad({ status: 'ready', project })
      setRevision((r) => r + 1)
    }
    ;(async () => {
      const draft = readDraft(id)
      let stored: { project: BuilderProject; at: number } | null = null
      if (!onSave) {
        try {
          const doc = await docStore.get<Record<string, unknown>>(BUILDER_STORE_KIND, id)
          const project = doc ? normalizeProject(doc.data, name) : null
          if (project) stored = { project, at: Date.parse(doc!.updatedAt) || 0 }
        } catch (e) {
          if (!cancelled) {
            toast.warning('Builder projects cannot be saved right now', {
              description:
                e instanceof DocStoreError && e.code === 'store_unavailable'
                  ? 'The console database is not available. Edits are kept as a local draft in this browser.'
                  : 'Loading the saved project failed. Edits are kept as a local draft in this browser.',
            })
          }
        }
      }
      const base = stored?.project ?? initialProject ?? defaultProjectFor(mode, name)
      if (draft && draft.at > (stored?.at ?? 0)) {
        if (stored || initialProject) toast.info('Restored unsaved changes', { description: 'Save to keep them.' })
        settle(draft.project, true)
      } else {
        settle(base)
      }
    })()
    return () => {
      cancelled = true
    }
    // Reload only when the document identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // ── change / save ─────────────────────────────────────────────────
  const onChange = useCallback(
    (project: BuilderProject) => {
      latest.current = project
      setDirty(true)
      writeDraft(id, project)
    },
    [id],
  )

  const save = useCallback(async () => {
    const project = latest.current
    if (!project || saving) return
    setSaving(true)
    try {
      if (onSave) {
        await onSave({ id, kind: 'builder', name: project.name || name, mode, project })
      } else {
        await docStore.put(BUILDER_STORE_KIND, id, project as unknown as Record<string, unknown>)
      }
      clearDraft(id)
      setDirty(false)
      toast.success('Saved', { description: project.name || name })
    } catch (e) {
      toast.error('Save failed', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSaving(false)
    }
  }, [id, mode, name, onSave, saving, toast])

  const loadProject = useCallback(
    (project: BuilderProject, opts?: { dirty?: boolean }) => {
      latest.current = project
      setLoad({ status: 'ready', project })
      setRevision((r) => r + 1)
      const isDirty = opts?.dirty ?? true
      setDirty(isDirty)
      if (isDirty) writeDraft(id, project)
    },
    [id],
  )

  const generateFiles = useCallback(async (opts?: { basePath?: string }): Promise<GeneratedFile[]> => {
    const project = latest.current
    if (!project) return []
    const { projectToFiles } = await import('./lib/project-export.ts')
    return projectToFiles(project, opts?.basePath)
  }, [])

  const ctl: BuilderController = useMemo(
    () => ({
      project: load.status === 'ready' ? latest.current : null,
      dirty,
      saving,
      save,
      loadProject,
      generateFiles,
    }),
    [load, dirty, saving, save, loadProject, generateFiles],
  )

  const heading = (
    <span className="flex min-w-0 items-center gap-2">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <BackGlyph />
        </button>
      ) : null}
      <span className="truncate">{title ?? name}</span>
    </span>
  )

  const headerActions = (
    <>
      {actions?.(ctl)}
      {/* Snapshots live in the doc store; hosts that persist elsewhere (onSave) skip them. */}
      {!onSave && (
        <Button size="sm" onClick={() => setVersionsOpen(true)} disabled={load.status !== 'ready'} title="Named versions of this project">
          Versions
        </Button>
      )}
      <Button
        variant="primary"
        size="sm"
        onClick={() => void save()}
        loading={saving}
        disabled={load.status !== 'ready'}
        title="Save (⌘S)"
      >
        {dirty ? 'Save' : 'Saved'}
      </Button>
    </>
  )

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {variant === 'page' ? (
        <PageHeader compact title={heading} actions={headerActions} />
      ) : (
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0 text-base font-semibold text-content">{heading}</div>
          <div className="flex shrink-0 items-center gap-2">{headerActions}</div>
        </div>
      )}

      {versionsOpen ? (
        <VersionsDialog docId={id} project={latest.current} onRestore={(p) => loadProject(p, { dirty: true })} onClose={() => setVersionsOpen(false)} />
      ) : null}

      <div
        className="adhar-builder relative min-h-[560px] overflow-hidden rounded-xl border border-edge-default bg-background"
        style={{ height: height ?? 'calc(100vh - 210px)' }}
      >
        {load.status === 'loading' ? (
          <Loading label={`Loading ${name}…`} />
        ) : (
          <Suspense fallback={<Loading label={`Loading ${MODE_LABEL[mode]}…`} />}>
            <Workbench
              key={revision}
              mode={mode}
              project={load.project}
              onChange={onChange}
              onSave={save}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-content-muted">
      <Spinner size={14} />
      <span>{label}</span>
    </div>
  )
}

function BackGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}

export default BuilderApp
