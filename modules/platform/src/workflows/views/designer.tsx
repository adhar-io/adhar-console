import { type KeyboardEvent, lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Kbd, Modal, useOptionalUser } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { type Capabilities, getTemplate, lintManifest, testRunDraft, WorkflowsApiError } from '../data/api.ts'
import type { CatalogEntry } from '../data/catalog.ts'
import { draftAt, type DraftData, draftId, objectToYaml, prepareTestRun, staleDraft, testRunTargets, useDraftAutosave, useMyDrafts } from '../data/drafts.ts'
import { type Scope, useTemplates, useWorkflowCluster } from '../data/hooks.ts'
import { toJS } from '../model/doc.ts'
import { catalogueSteps, type CatalogueStep } from '../model/kinds.ts'
import { applyOp, OpError } from '../model/ops.ts'
import * as S from '../model/session.ts'
import { instantiate, starters } from '../model/starters.ts'
import type { Diagnostic } from '../model/validate.ts'
import type { CanvasCommands } from '../canvas/designer-canvas.tsx'
import { type Action, copyText, type DesignerState, designerDiagnostics, designerPalette, emptyWorkflow, init, NUDGE, NUDGE_FAR, reduce, testRunBlocker } from '../canvas/designer-state.ts'
import { DiagnosticsBar, summarise } from '../canvas/diagnostics-bar.tsx'
import { Inspector } from '../canvas/inspector.tsx'
import { type Command, commandIn, KEYMAP } from '../canvas/keys.ts'
import { Palette } from '../canvas/palette.tsx'
import { type LocalTemplate, TemplatePicker } from '../canvas/template-picker.tsx'
import { Toolbar } from '../canvas/toolbar.tsx'
import { YamlPanel } from '../canvas/yaml-panel.tsx'
import { ErrorNote, Loading } from './common.tsx'
import { TestRunDialog } from './test-run-dialog.tsx'

/**
 * Workflows → Designer (`?section=workflow-designer`, design 0026 §6.5–§6.9;
 * W2-C2/C3). Opens a template from the cluster (`ns` + `q` [+ `view` = kind]),
 * a starter, or an empty canvas; the person's unsaved work autosaves to the
 * console database and is offered back when they return.
 *
 * The canvas is the one part that needs React Flow and is loaded on demand
 * (`chunks_test.ts`): this page, the palette, the inspector and the YAML
 * panel carry no @xyflow.
 */

const DesignerCanvas = lazy(() => import('../canvas/designer-canvas.tsx'))

const DNS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

export interface DesignerViewProps {
  scope: Scope
  caps: Capabilities
  /** `ns` + `q` name a template to open; `view` its kind. */
  ns?: string
  name?: string
  kind?: string
  onParams(p: { ns?: string; q?: string; view?: string }): void
  onOpenRun(run: { namespace: string; name: string }): void
}

type Opened = { text: string; namespace: string; name: string; origin: DraftData['origin']; restored?: string }

export function DesignerView({ scope, caps, ns, name, kind, onParams, onOpenRun }: DesignerViewProps) {
  const user = useOptionalUser()
  const { cluster } = useWorkflowCluster()
  const templates = useTemplates(scope)
  const drafts = useMyDrafts(user?.id)
  const [opened, setOpened] = useState<Opened | null>(null)
  const catalogue = useMemo(() => catalogueSteps(templates.data?.cwts.items ?? []), [templates.data?.cwts.items])
  const local = useMemo<LocalTemplate[]>(() => (templates.data?.wts.items ?? [])
    .filter((t) => !ns || t.metadata.namespace === ns)
    .map((t) => ({ name: t.metadata.name, namespace: t.metadata.namespace, templates: ((t.spec as { templates?: Array<{ name?: string }> } | undefined)?.templates ?? []).map((x) => x.name).filter((x): x is string => Boolean(x)) })), [templates.data?.wts.items, ns])

  // A deep link to a template: the person's own unsaved draft of it wins, else the cluster's copy.
  const wanted = ns && name ? `${ns}/${name}` : null
  const source = useQuery({
    queryKey: ['workflows', 'designer', 'source', cluster ?? '', wanted, user?.id ?? ''],
    // Wait for the person's drafts first: their unsaved copy wins over the cluster's.
    enabled: Boolean(wanted) && (!opened || `${opened.namespace}/${opened.name}` !== wanted) && (!user?.id || !drafts.isLoading),
    queryFn: async (): Promise<Opened> => {
      if (user?.id) {
        const saved = draftAt(drafts.data ?? [], ns!, name!)
        if (saved) return { text: saved.text, namespace: saved.namespace, name: saved.name, origin: saved.origin, restored: saved.savedAt }
      }
      const k = (kind === 'CronWorkflow' || kind === 'ClusterWorkflowTemplate' ? kind : 'WorkflowTemplate') as CatalogEntry['kind']
      const obj = await getTemplate(k, ns, name!, cluster)
      if (!obj) return { text: emptyWorkflow(name!, ns), namespace: ns!, name: name!, origin: { from: 'empty' } }
      return { text: objectToYaml(obj as unknown as Record<string, unknown>), namespace: ns!, name: name!, origin: { from: 'template', resourceVersion: (obj.metadata as { resourceVersion?: string }).resourceVersion } }
    },
    retry: false,
    staleTime: Infinity,
  })
  useEffect(() => {
    if (source.data) setOpened(source.data)
  }, [source.data])

  if (!opened) {
    if (wanted && source.isLoading) return <Loading label={`Opening ${wanted}…`} />
    if (wanted && source.error) return <ErrorNote title={`Could not open ${wanted}`} error={source.error} />
    return (
      <Gallery
        scope={scope}
        caps={caps}
        drafts={drafts.data ?? []}
        signedIn={Boolean(user)}
        onOpen={(o) => {
          setOpened(o)
          onParams({ ns: o.namespace, q: o.name, view: undefined })
        }}
      />
    )
  }
  return (
    <DesignerWorkbench
      key={`${opened.namespace}/${opened.name}`}
      opened={opened}
      user={user?.id}
      catalogue={catalogue}
      local={local}
      scope={scope}
      caps={caps}
      onOpenRun={onOpenRun}
      onClose={() => {
        setOpened(null)
        onParams({ ns: undefined, q: undefined, view: undefined })
      }}
    />
  )
}

/* ─────────────────────────── the gallery ─────────────────────────── */

function Gallery({ scope, caps, drafts, signedIn, onOpen }: { scope: Scope; caps: Capabilities; drafts: ReadonlyArray<DraftData & { id: string }>; signedIn: boolean; onOpen(o: Opened): void }) {
  const choices = useMemo(() => [{ id: 'empty', title: 'Empty canvas', description: 'Nothing yet: drag the first step in.' }, ...starters({ batch: caps.batch, gamedays: caps.gamedays })], [caps.batch, caps.gamedays])
  const dev = testRunTargets(scope.namespaces)
  const namespaces = [...dev.dev, ...dev.unknown, ...dev.other.filter((n) => n.role !== 'platform')]
  const [choice, setChoice] = useState<string>('empty')
  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState(namespaces[0]?.namespace ?? '')
  const nameOk = DNS_NAME.test(name) && name.length <= 52
  // A new canvas here would autosave over unsaved work of the same name: offer that back instead.
  const clash = nameOk && namespace ? draftAt(drafts, namespace, name) : undefined
  const start = () => {
    if (!nameOk || !namespace || clash) return
    const starter = starters({ batch: true, gamedays: true }).find((s) => s.id === choice)
    onOpen({ text: starter ? instantiate(starter, { name, namespace }) : emptyWorkflow(name, namespace), namespace, name, origin: starter ? { from: 'starter', starter: starter.id } : { from: 'empty' } })
  }
  return (
    <div className="space-y-6">
      <section aria-label="New workflow" className="space-y-3">
        <h2 className="text-sm font-semibold text-content">Start a workflow</h2>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label="Start from">
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={choice === c.id}
              onClick={() => setChoice(c.id)}
              className={cn('rounded-xl border p-3 text-left transition-colors', choice === c.id ? 'border-brand-500 bg-brand-500/5' : 'border-edge-default bg-surface-raised hover:border-edge-strong')}
            >
              <div className="text-[13px] font-semibold text-content">{c.title}</div>
              <div className="mt-0.5 text-xs text-content-muted">{c.description}</div>
            </button>
          ))}
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            start()
          }}
        >
          <label className="space-y-1 text-xs">
            <span className="block font-medium text-content">Name</span>
            <input aria-label="Workflow name" value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} placeholder="nightly-report" className="h-9 w-56 rounded-lg border border-edge-default bg-surface-raised px-2.5 font-mono text-sm focus:border-brand-500 focus:outline-none" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="block font-medium text-content">Namespace</span>
            <select aria-label="Namespace" value={namespace} onChange={(e) => setNamespace(e.currentTarget.value)} className="h-9 w-56 rounded-lg border border-edge-default bg-surface-raised px-2 text-sm">
              {namespaces.length ? namespaces.map((n) => <option key={n.namespace} value={n.namespace}>{n.namespace}{n.environment ? ` · ${n.environment}` : ''}</option>) : <option value="">No namespace in scope</option>}
            </select>
          </label>
          <Button type="submit" disabled={!nameOk || !namespace || Boolean(clash)}>Open the designer</Button>
          {name && !nameOk ? <span className="text-xs text-rose-600">Lower-case letters, digits and -, at most 52.</span> : null}
          {clash ? (
            <span role="alert" className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
              You have an unsaved draft of {name} in {namespace}. Resume it, or choose another name.
              <Button type="button" size="xs" variant="secondary" onClick={() => onOpen({ text: clash.text, namespace: clash.namespace, name: clash.name, origin: clash.origin, restored: clash.savedAt })}>Resume</Button>
            </span>
          ) : null}
        </form>
      </section>
      <section aria-label="Your unsaved drafts" className="space-y-2">
        <h2 className="text-sm font-semibold text-content">Your unsaved drafts</h2>
        {!signedIn ? <p className="text-xs text-content-subtle">Sign in to keep unsaved work between visits.</p> : drafts.length ? (
          <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-mono text-content">{d.name}</span>
                <span className="text-xs text-content-subtle">{d.namespace}</span>
                <span className="ml-auto text-xs text-content-subtle">{d.savedAt ? formatRelative(d.savedAt) : ''}</span>
                <Button size="xs" variant="secondary" onClick={() => onOpen({ text: d.text, namespace: d.namespace, name: d.name, origin: d.origin, restored: d.savedAt })}>Resume</Button>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-content-subtle">None. Work in the designer is kept here until you publish or discard it.</p>}
        <p className="text-xs text-content-subtle">To change a template that is already on the cluster, open it from the Catalog with “Open in designer”.</p>
      </section>
    </div>
  )
}

/* ─────────────────────────── the workbench ─────────────────────────── */

export interface WorkbenchProps {
  opened: Opened
  user?: string
  catalogue: readonly CatalogueStep[]
  local: readonly LocalTemplate[]
  scope: Scope
  caps: Pick<Capabilities, 'batch' | 'gamedays'>
  onOpenRun(run: { namespace: string; name: string }): void
  onClose(): void
}

/** Validation levels B (admission dry run) and C (argo-server lint), for the text they were run on. */
interface Remote {
  text: string
  diagnostics: Diagnostic[]
}

/**
 * What a refused level-B dry run says about the TEMPLATE. The BFF refuses a
 * namespace that is not dev (`not_dev`) or whose tier it cannot read
 * (`tier_unknown`) before the template is even looked at: that is a fact about
 * where the check ran, not an error in the workflow, and counting it as one
 * made Validate report a valid template as broken for anyone whose only
 * namespace has no tier the console can see.
 */
export function admissionDiagnostic(e: unknown): Diagnostic {
  const message = e instanceof Error ? e.message : String(e)
  if (e instanceof WorkflowsApiError && (e.code === 'not_dev' || e.code === 'tier_unknown')) {
    return { level: 'info', code: 'admission/skipped', message: `Admission check not run: ${message}`, path: [], source: 'admission' }
  }
  return { level: 'error', code: 'admission/refused', message, path: [], source: 'admission' }
}

function commandAction(c: Command): Action | null {
  switch (c) {
    case 'remove':
      return { type: 'remove' }
    case 'undo':
      return { type: 'undo' }
    case 'redo':
      return { type: 'redo' }
    case 'layout':
      return { type: 'layout' }
    case 'deselect':
      return { type: 'select', node: null }
    case 'nudge-left':
      return { type: 'nudge', dx: -NUDGE, dy: 0 }
    case 'nudge-right':
      return { type: 'nudge', dx: NUDGE, dy: 0 }
    case 'nudge-up':
      return { type: 'nudge', dx: 0, dy: -NUDGE }
    case 'nudge-down':
      return { type: 'nudge', dx: 0, dy: NUDGE }
    case 'nudge-left-far':
      return { type: 'nudge', dx: -NUDGE_FAR, dy: 0 }
    case 'nudge-right-far':
      return { type: 'nudge', dx: NUDGE_FAR, dy: 0 }
    case 'nudge-up-far':
      return { type: 'nudge', dx: 0, dy: -NUDGE_FAR }
    case 'nudge-down-far':
      return { type: 'nudge', dx: 0, dy: NUDGE_FAR }
    default:
      return null
  }
}

export function DesignerWorkbench({ opened, user, catalogue, local, scope, caps, onOpenRun, onClose }: WorkbenchProps) {
  const { cluster } = useWorkflowCluster()
  const opts = useMemo(() => ({ catalogue }), [catalogue])
  const [state, dispatch] = useReducer(reduce, undefined, () => init(opened.text, opts))
  const firstOpts = useRef(opts)
  useEffect(() => {
    if (firstOpts.current === opts) return
    firstOpts.current = opts
    dispatch({ type: 'catalogue', opts })
  }, [opts])
  const s = state.session
  const text = S.text(s)
  const dirty = S.isDirty(s) || Boolean(opened.restored)
  const id = useMemo(() => (user ? draftId(user, opened.namespace, opened.name) : null), [user, opened.namespace, opened.name])
  const autosave = useDraftAutosave(id, user ? { text, namespace: opened.namespace, name: opened.name, origin: opened.origin, user, savedAt: '' } : null, S.isDirty(s))
  const palette = useMemo(() => designerPalette(catalogue, { batch: caps.batch, gamedays: caps.gamedays }), [catalogue, caps.batch, caps.gamedays])
  // A resumed draft of a cluster template: has the template changed since the draft began?
  const originKind = useRef(s.graph.resource.kind)
  const upstream = useQuery({
    queryKey: ['workflows', 'designer', 'upstream', cluster ?? '', opened.namespace, opened.name, opened.origin.resourceVersion ?? ''],
    enabled: Boolean(opened.restored && opened.origin.from === 'template' && opened.origin.resourceVersion),
    queryFn: async () => {
      const k = (originKind.current === 'CronWorkflow' || originKind.current === 'ClusterWorkflowTemplate' ? originKind.current : 'WorkflowTemplate') as CatalogEntry['kind']
      const obj = await getTemplate(k, opened.namespace, opened.name, cluster).catch(() => null)
      return (obj?.metadata as { resourceVersion?: string } | undefined)?.resourceVersion ?? null
    },
    retry: false,
    staleTime: 60_000,
  })
  const stale = staleDraft(opened.origin, upstream.data)

  const [yamlOpen, setYamlOpen] = useState(false)
  const [help, setHelp] = useState(false)
  const [testing, setTesting] = useState(false)
  const [converting, setConverting] = useState(false)
  const [reveal, setReveal] = useState<{ range: NonNullable<Diagnostic['range']>; nonce: number } | undefined>()
  const [remote, setRemote] = useState<Remote | null>(null)
  const [validating, setValidating] = useState(false)
  const commands = useRef<CanvasCommands>({})
  const search = useRef<HTMLInputElement | null>(null)
  const inspector = useRef<HTMLDivElement | null>(null)

  const diagnostics = useMemo(() => [...designerDiagnostics(state), ...(remote && remote.text === text ? remote.diagnostics : [])], [state, remote, text])
  const counts = summarise(diagnostics)
  const blocker = testRunBlocker(state)
  const devTarget = testRunTargets(scope.namespaces)

  const validate = useCallback(async () => {
    setValidating(true)
    const out: Diagnostic[] = []
    const ns = devTarget.dev.find((n) => n.namespace === opened.namespace)?.namespace ?? devTarget.dev[0]?.namespace ?? devTarget.unknown[0]?.namespace
    try {
      if (ns && s.graph.resource.kind === 'WorkflowTemplate' && !s.frozen) {
        // Level B: the draft's apply as a dry run — RBAC, the CRD and Kyverno answer.
        const prepared = prepareTestRun(text, new Date(), ns)
        if (prepared.ok) {
          await testRunDraft(ns, { yaml: prepared.yaml, dryRun: true }, cluster).catch((e) => out.push(admissionDiagnostic(e)))
        }
      }
      // Level C: argo-server's own validation (template resolution, expressions, templateRef existence).
      if (!s.frozen && s.graph.resource.kind) {
        const r = await lintManifest({ namespace: s.graph.resource.namespace ?? opened.namespace, kind: s.graph.resource.kind, manifest: toJS(s.doc) as Record<string, unknown> }, cluster).catch((e) => ({ valid: false, message: e instanceof Error ? e.message : String(e) }))
        if (!r.valid) out.push({ level: 'error', code: 'lint/invalid', message: r.message ?? 'argo-server refused the workflow.', path: [], source: 'lint' })
      }
    } finally {
      setRemote({ text, diagnostics: out })
      setValidating(false)
    }
  }, [cluster, devTarget.dev, devTarget.unknown, opened.namespace, s, text])

  // Warn before leaving with work the database has not got.
  useEffect(() => {
    if (!S.isDirty(s) || autosave.status.state === 'saved') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    globalThis.addEventListener('beforeunload', warn)
    return () => globalThis.removeEventListener('beforeunload', warn)
  }, [s, autosave.status.state])

  const run = (c: Command) => {
    switch (c) {
      case 'fit':
        return commands.current.fit?.()
      case 'search':
        return search.current?.focus()
      case 'inspect':
        return inspector.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus()
      case 'copy': {
        const clip = copyText(state)
        if (clip) void navigator.clipboard?.writeText(clip).then(() => dispatch({ type: 'status', status: { tone: 'info', text: 'Copied the step as YAML' } }))
        return
      }
      case 'paste':
        void navigator.clipboard?.readText().then((t) => dispatch({ type: 'paste', text: t })).catch(() => dispatch({ type: 'status', status: { tone: 'error', text: 'The browser did not allow reading the clipboard.' } }))
        return
      case 'save':
        return void autosave.flush()
      case 'test-run':
        if (!blocker) setTesting(true)
        return
      default: {
        const a = commandAction(c)
        if (a) dispatch(a)
      }
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Scoped: not from a dialog's portal, and step edits only from the canvas (keys.ts commandIn).
    const c = commandIn(e, e.target as HTMLElement, e.currentTarget as HTMLElement)
    if (!c) return
    e.preventDefault()
    run(c)
  }

  const preview = useMemo(() => {
    if (!converting) return null
    try {
      return applyOp(s.doc, { op: s.graph.readOnly === 'steps' ? 'convertStepsToDag' : 'wrapEntry' }, opts).changes
    } catch (e) {
      return [e instanceof OpError ? e.message : String(e)]
    }
  }, [converting, s.doc, s.graph.readOnly, opts])

  const saveLabel = autosave.status.state === 'saving' ? 'Saving…' : autosave.status.state === 'saved' ? `Draft saved ${formatRelative(autosave.status.at)}` : !user ? 'Not saved (signed out)' : S.isDirty(s) ? 'Save draft' : 'Saved'
  const live = state.status?.text ?? ''

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="text-xs text-content-muted hover:text-content hover:underline" onClick={onClose}>← All drafts and starters</button>
        <h2 className="font-mono text-sm font-semibold text-content">{opened.name}</h2>
        <span className="text-xs text-content-subtle">{s.graph.resource.kind ?? ''} · {opened.namespace}</span>
        {dirty ? <span className="rounded bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">unpublished</span> : null}
        {opened.restored ? <span className="text-xs text-content-subtle">restored your draft from {formatRelative(opened.restored)}</span> : null}
        {opened.restored ? (
          <button type="button" className="text-xs text-rose-600 hover:underline" onClick={() => void autosave.discard().then(onClose)}>Discard draft</button>
        ) : null}
      </div>
      <Toolbar
        canUndo={s.undo.length > 0}
        canRedo={s.redo.length > 0}
        editable={s.graph.editable && !s.frozen}
        yamlOpen={yamlOpen}
        problems={counts}
        validating={validating}
        testRunBlocked={blocker}
        save={{ label: saveLabel, disabled: !user || !S.isDirty(s) }}
        repair={s.graph.readOnly === 'steps' ? { label: 'Convert to DAG', onClick: () => setConverting(true) } : s.graph.readOnly === 'leaf-entry' ? { label: 'Wrap in a DAG', onClick: () => setConverting(true) } : undefined}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        onLayout={() => dispatch({ type: 'layout' })}
        onFit={() => commands.current.fit?.()}
        onZoomIn={() => commands.current.zoomIn?.()}
        onZoomOut={() => commands.current.zoomOut?.()}
        onValidate={() => void validate()}
        onToggleYaml={() => setYamlOpen((o) => !o)}
        onSave={() => void autosave.flush()}
        onTestRun={() => setTesting(true)}
        onHelp={() => setHelp(true)}
      />
      {s.frozen ? (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          YAML has errors. The canvas shows the last version that parsed and takes no edits until the YAML is fixed; nothing is fixed for you.
        </p>
      ) : s.graph.readOnly && s.graph.readOnly !== 'steps' && s.graph.readOnly !== 'leaf-entry' ? (
        <p role="status" className="rounded-lg border border-edge-default bg-surface-sunken px-3 py-2 text-xs text-content-muted">{READ_ONLY[s.graph.readOnly] ?? 'This document is shown read-only.'}</p>
      ) : s.graph.readOnly === 'steps' ? (
        <p role="status" className="rounded-lg border border-edge-default bg-surface-sunken px-3 py-2 text-xs text-content-muted">The entry is a steps template: shown as columns, read-only. Convert it to a DAG to edit it on the canvas.</p>
      ) : null}
      {stale ? (
        <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {opened.name} has changed on the cluster since this draft was started. Your draft is shown as you left it; publishing it would replace those changes. Discard the draft to start from the current version.
        </p>
      ) : null}
      {autosave.status.state === 'unavailable' || autosave.status.state === 'error' ? (
        <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">{autosave.status.detail}</p>
      ) : null}
      {converting && preview ? (
        <div role="dialog" aria-label="Review the conversion" className="space-y-2 rounded-xl border border-brand-500/40 bg-surface-raised p-3 text-xs">
          <div className="font-semibold text-content">{s.graph.readOnly === 'steps' ? 'Convert to DAG' : 'Wrap in a DAG'}: what changes</div>
          <ul className="list-disc space-y-0.5 pl-5 text-content-muted">{preview.map((c) => <li key={c}>{c}</li>)}</ul>
          <div className="flex gap-2">
            <Button size="xs" onClick={() => {
              dispatch({ type: s.graph.readOnly === 'steps' ? 'convert' : 'wrap' })
              setConverting(false)
            }}>Apply</Button>
            <Button size="xs" variant="ghost" onClick={() => setConverting(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      <div className="grid min-h-[560px] gap-3 lg:grid-cols-[15rem_minmax(0,1fr)_20rem]">
        <div className="order-2 space-y-3 lg:order-1">
          <Palette ref={search} entries={palette} disabled={!s.graph.editable || s.frozen} onAdd={(entry) => dispatch({ type: 'drop', entry })} className="h-[560px]" />
        </div>
        <div className="order-1 flex min-w-0 flex-col gap-3 lg:order-2">
          {state.picking ? <TemplatePicker catalogue={catalogue} local={local} onPick={(ref) => dispatch({ type: 'pick', ref })} onCancel={() => dispatch({ type: 'cancel-pick' })} /> : null}
          <div className={cn('grid min-h-0 flex-1 gap-3', yamlOpen && 'xl:grid-cols-2')}>
            <div className="h-[560px] overflow-hidden rounded-xl border border-edge-default">
              <Suspense fallback={<Loading label="Loading the canvas…" />}>
                <DesignerCanvas graph={s.graph} doc={s.doc} frozen={s.frozen} selected={state.selected} dispatch={dispatch} commands={commands} />
              </Suspense>
            </div>
            {yamlOpen ? <YamlPanel doc={s.doc} diagnostics={diagnostics} reveal={reveal} onText={(t) => dispatch({ type: 'text', text: t })} className="h-[560px]" /> : null}
          </div>
        </div>
        <div ref={inspector} className="order-3 rounded-xl border border-edge-default bg-surface-raised p-3">
          <Inspector graph={s.graph} doc={s.doc} frozen={s.frozen} selected={state.selected} catalogue={catalogue} palette={palette} diagnostics={diagnostics} dispatch={dispatch} className="h-[536px]" />
        </div>
      </div>
      <DiagnosticsBar
        diagnostics={diagnostics}
        onSelect={(uid) => dispatch({ type: 'select', node: uid })}
        onReveal={(d) => {
          if (!d.range) return
          setYamlOpen(true)
          setReveal({ range: d.range, nonce: Date.now() })
        }}
      />
      {state.status ? (
        <p className={cn('text-xs', state.status.tone === 'error' ? 'text-rose-600' : 'text-content-muted')}>{state.status.text}</p>
      ) : null}
      {/* Validation and edits are announced (§6.8). */}
      <div className="sr-only" aria-live="polite" role="status">
        {`${live}${live ? '. ' : ''}${counts.errors} errors, ${counts.warnings} warnings.`}
      </div>
      {testing ? (
        <TestRunDialog
          name={opened.name}
          namespaces={scope.namespaces}
          params={s.graph.params}
          text={text}
          preferred={opened.namespace}
          onCancel={() => setTesting(false)}
          onStarted={(r) => {
            setTesting(false)
            dispatch({ type: 'status', status: { tone: 'info', text: `Started ${r.name} in ${r.namespace}` } })
            onOpenRun(r)
          }}
        />
      ) : null}
      {help ? (
        <Modal open onClose={() => setHelp(false)} title="Keyboard" description="Every shortcut also has a button.">
          <table className="w-full text-sm">
            <tbody>
              {KEYMAP.map((k) => (
                <tr key={k.keys} className="border-b border-edge-subtle last:border-0">
                  <td className="py-1.5 pr-3"><Kbd>{k.keys}</Kbd></td>
                  <td className="py-1.5 text-content-muted">{k.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      ) : null}
    </div>
  )
}

const READ_ONLY: Partial<Record<NonNullable<DesignerState['session']['graph']['readOnly']>, string>> = {
  'not-a-workflow': 'This is not an Argo workflow document: edit it in the YAML panel.',
  'no-entry': 'This template has no entrypoint (a step library): its steps are called from other workflows.',
  'missing-entry': 'The entrypoint names a template that is not in this document.',
}
