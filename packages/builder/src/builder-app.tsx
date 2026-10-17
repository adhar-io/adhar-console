import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, PageHeader, Spinner, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { BUILDER_CSS } from './builder-styles.ts'
import { ensureStyle } from './lib/inject-style.ts'
import { setExtraThemePresets, type ThemePreset } from './lib/builder-api.ts'
import { normalizeProject } from './lib/project.ts'
import type { BuilderController, BuilderMode, BuilderProject, BuilderSaveEvent } from './types.ts'

/*
 * The workbench — canvas, panels, generators — is one lazy chunk. Monaco,
 * Mermaid, React Flow and the repo's Tailwind compiler are further lazy
 * chunks inside it. Importing `@adhar/builder` costs a host module this file.
 */
const Workbench = lazy(() => import('./app.tsx'))

const MODE_LABEL: Record<BuilderMode, string> = {
  visual: 'Visual Designer',
  workflow: 'Workflow Builder',
  theme: 'Theme Builder',
}

/** Compiles CSS for the classes in use (the repo's Tailwind, scoped to the canvas). */
export interface CanvasCss {
  build(candidates: string[]): string
}

export interface BuilderAppProps {
  mode: BuilderMode
  /** Key for the local draft (unsaved edits survive a reload in this browser). */
  docId: string
  /** Page title. */
  docName?: string
  title?: ReactNode
  /** The project to edit. */
  initialProject: BuilderProject
  /**
   * Persist on Save (⌘S) — e.g. a wireframe document. Mutually exclusive with
   * `onSaveRequest`.
   */
  onSave?(doc: BuilderSaveEvent): void | Promise<void>
  /**
   * The host runs its own save flow (e.g. review the diff, commit, open a pull
   * request) and calls `ctl.markSaved()` when done.
   */
  onSaveRequest?(ctl: BuilderController): void
  /** Label of the primary header action (default "Save"). */
  saveLabel?: string
  /** Whether a stored draft still applies (e.g. same commit as the branch head). */
  isDraftUsable?(draft: BuilderProject): boolean
  /** Renders a Back control before the title. */
  onBack?(): void
  /** Extra page-header actions, rendered left of Save. */
  actions?(ctl: BuilderController): ReactNode
  /** Something to show next to the title (e.g. a branch picker). */
  titleExtra?: ReactNode
  /** Page to open first (builder file id). */
  initialFileId?: string
  onActiveFileChange?(fileId: string | null): void
  /** The exact code a page would be saved as — shown in the Code view. */
  previewCode?(fileId: string, project: BuilderProject): string | null
  /** The repo's own CSS, compiled on demand for the canvas and the prototype. */
  canvasCss?: CanvasCss | null
  /** Extra design-theme presets offered ahead of the built-ins. */
  themes?: ThemePreset[]
  /** Editor height. Defaults to filling the viewport below the page header. */
  height?: string
  /** `page` renders a PageHeader; `embedded` a slim title row. */
  variant?: 'page' | 'embedded'
  className?: string
}

const draftKey = (id: string) => `adhar.builder.draft:${id}`

function readDraft(id: string): BuilderProject | null {
  try {
    const raw = localStorage.getItem(draftKey(id))
    if (!raw) return null
    const v = JSON.parse(raw) as { project?: unknown; source?: BuilderProject['source'] }
    const p = normalizeProject(v.project)
    return p ? { ...p, source: (v.project as BuilderProject)?.source } : null
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
 * The Adhar Visual Designer — behind Design → Visual Designer (repository
 * apps) and wireframe editing. A mode only decides what it opens on.
 *
 * Every edit is mirrored to a local draft so a reload loses nothing; the host
 * decides whether a draft still applies (`isDraftUsable`).
 */
export function BuilderApp({
  mode,
  docId,
  docName,
  title,
  initialProject,
  onSave,
  onSaveRequest,
  saveLabel = 'Save',
  isDraftUsable,
  onBack,
  actions,
  titleExtra,
  initialFileId,
  onActiveFileChange,
  previewCode,
  canvasCss,
  height,
  variant = 'page',
  themes,
  className,
}: BuilderAppProps) {
  ensureStyle('adhar-builder-css', BUILDER_CSS)
  // One builder is mounted at a time; idempotent, so safe during render.
  setExtraThemePresets(themes ?? [])
  const toast = useToast()
  const name = docName ?? MODE_LABEL[mode]

  const [project, setProject] = useState<BuilderProject | null>(null)
  const [revision, setRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const latest = useRef<BuilderProject | null>(null)

  // ── load: the host's project, or a still-valid local draft of it ──
  useEffect(() => {
    const draft = readDraft(docId)
    const usable = draft && (isDraftUsable ? isDraftUsable(draft) : true)
    if (draft && !usable) clearDraft(docId)
    const start = usable ? draft! : initialProject
    latest.current = start
    setProject(start)
    setDirty(!!usable)
    setRevision((r) => r + 1)
    if (usable) toast.info('Restored unsaved changes', { description: 'They were kept in this browser.' })
    // Reload only when the document identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const onChange = useCallback(
    (p: BuilderProject) => {
      latest.current = p
      setDirty(true)
      writeDraft(docId, p)
    },
    [docId],
  )

  const markSaved = useCallback(() => {
    clearDraft(docId)
    setDirty(false)
  }, [docId])

  const loadProject = useCallback(
    (p: BuilderProject, opts?: { dirty?: boolean }) => {
      latest.current = p
      setProject(p)
      setRevision((r) => r + 1)
      const isDirty = opts?.dirty ?? true
      setDirty(isDirty)
      if (isDirty) writeDraft(docId, p)
      else clearDraft(docId)
    },
    [docId],
  )

  const ctlRef = useRef<BuilderController | null>(null)
  const save = useCallback(async () => {
    const p = latest.current
    if (!p || saving) return
    if (onSaveRequest) {
      if (ctlRef.current) onSaveRequest(ctlRef.current)
      return
    }
    if (!onSave) return
    setSaving(true)
    try {
      await onSave({ id: docId, kind: 'builder', name: p.name || name, mode, project: p })
      markSaved()
      toast.success('Saved', { description: p.name || name })
    } catch (e) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }, [docId, markSaved, mode, name, onSave, onSaveRequest, saving, toast])

  const ctl: BuilderController = useMemo(
    () => ({
      // A getter: the controller is stable across edits but always current.
      get project() {
        return latest.current
      },
      dirty,
      saving,
      save,
      loadProject,
      markSaved,
    }),
    [dirty, saving, save, loadProject, markSaved],
  )
  ctlRef.current = ctl

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
      {titleExtra}
    </span>
  )

  const headerActions = (
    <>
      {actions?.(ctl)}
      <Button variant="primary" size="sm" onClick={() => void save()} loading={saving} disabled={!project} title={`${saveLabel} (⌘S)`}>
        {onSaveRequest ? saveLabel : dirty ? saveLabel : 'Saved'}
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

      <div
        className="adhar-builder relative min-h-140 overflow-hidden rounded-xl border border-edge-default bg-background"
        style={{ height: height ?? 'calc(100vh - 210px)' }}
      >
        {!project ? (
          <Loading label={`Loading ${name}…`} />
        ) : (
          <Suspense fallback={<Loading label={`Loading ${MODE_LABEL[mode]}…`} />}>
            <Workbench
              key={revision}
              mode={mode}
              project={project}
              onChange={onChange}
              onSave={save}
              initialFileId={initialFileId}
              onActiveFileChange={onActiveFileChange}
              previewCode={previewCode}
              canvasCss={canvasCss ?? null}
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
