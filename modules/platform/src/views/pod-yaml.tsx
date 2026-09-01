import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Spinner } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { k8s } from '@adhar-console/api-clients'
import { client, LOCAL_CLUSTER } from '../data/client.ts'
import { useHasK8sPermission, type K8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'
import { loadMonaco, type MonacoEditorInstance } from '../components/monaco-loader.ts'

/**
 * Full-featured, Lens/OpenShift-grade YAML view/edit panel — Monaco-backed.
 *
 * View mode:  read-only Monaco with YAML colouring, line numbers, minimap +
 *             word-wrap toggles, find/replace (⌘F built-in) and a lock badge
 *             when the user lacks write.
 * Edit mode:  editable Monaco with live YAML validation surfaced as real error
 *             markers + a status line, Format (round-trip through
 *             `toYaml(parseYaml(…))`), a side-by-side Diff against the live
 *             cluster manifest, Reload-from-cluster, Copy, Download, and
 *             Apply (⌘S) gated on `writePerm` with the apiserver's 403/error
 *             surfaced verbatim.
 *
 * A "hide managedFields/status" toggle filters those server-managed keys from
 * the view for readability *without* mutating the object that Apply sends
 * (server-side apply owns those fields regardless).
 *
 * Editing mutable K8s fields is restricted by the server; we surface the
 * apiserver's rejection message verbatim so the user knows why.
 */

const POD_GVR: k8s.GVR = { group: '', version: 'v1', resource: 'pods', namespaced: true }

/* ───── richer Monaco surface (diff editor + markers) ─────
 * The shared loader (`components/monaco-loader.ts`) types only the subset the
 * JSON manifest editor needed. We cast the same runtime to the richer surface
 * we use here (diff editor, models, markers) — no second Monaco is loaded. */
interface MonacoModel {
  getValue(): string
  setValue(v: string): void
  dispose(): void
}
interface MonacoMarker {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  message: string
  severity: number
}
interface MonacoDiffEditor {
  setModel(m: { original: MonacoModel; modified: MonacoModel }): void
  layout(): void
  dispose(): void
}
interface RichMonaco {
  editor: {
    create(el: HTMLElement, opts?: unknown): MonacoEditorInstance
    createDiffEditor(el: HTMLElement, opts?: unknown): MonacoDiffEditor
    createModel(value: string, language?: string): MonacoModel
    setModelMarkers(model: unknown, owner: string, markers: MonacoMarker[]): void
    setTheme(name: string): void
  }
  MarkerSeverity: { Error: number; Warning: number; Info: number; Hint: number }
  KeyMod: Record<string, number>
  KeyCode: Record<string, number>
}

interface YamlIssue {
  line: number
  column: number
  message: string
}

/**
 * The panel defaults to a Pod (the original use), but any caller — the workload
 * drawers, say — can point it at a different object by passing that object's
 * `gvr` and the write permission to gate Apply on. Everything else (serialize,
 * validate, diff, apply → `replaceGeneric`, cache-nudge) is kind-agnostic.
 */
export function PodYamlPanel({
  pod,
  gvr = POD_GVR,
  writePerm = 'pods.write',
}: {
  pod: k8s.Pod | { metadata: { name: string; namespace?: string } } | undefined
  gvr?: k8s.GVR
  writePerm?: K8sPermission
}) {
  const qc = useQueryClient()
  const canWrite = useHasK8sPermission(writePerm)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [hideNoise, setHideNoise] = useState(true)
  const [minimap, setMinimap] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [issues, setIssues] = useState<YamlIssue[]>([])

  // Filtered manifest (server-managed noise hidden for readability). Apply always
  // sends the buffer verbatim — server-side apply owns managedFields/status.
  const skip = useMemo(
    () => (hideNoise ? new Set(['managedFields', 'status']) : new Set(['managedFields'])),
    [hideNoise],
  )
  const base = useMemo(() => (pod ? toYaml(pod, skip) : ''), [pod, skip])
  const dirty = editing && draft !== base

  // Seed draft whenever the underlying manifest updates and we're not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(base)
  }, [base, editing])

  const value = editing ? draft : base

  const startEdit = () => {
    setDraft(base)
    setEditing(true)
    setError(null)
    setSuccess(false)
  }
  const cancel = () => {
    setDraft(base)
    setEditing(false)
    setShowDiff(false)
    setError(null)
  }
  const copy = () => navigator.clipboard?.writeText(value)

  const download = () => {
    if (!pod) return
    try {
      const blob = new Blob([value], { type: 'text/yaml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${pod.metadata.name}.yaml`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      // Some sandboxes block programmatic downloads — degrade to clipboard so
      // the manifest is still recoverable.
      navigator.clipboard?.writeText(value)
      setError('Download is blocked in this sandbox — copied the manifest to the clipboard instead.')
    }
  }

  const reload = () => {
    setError(null)
    setSuccess(false)
    setDraft(base)
    if (pod) {
      qc.invalidateQueries({ queryKey: ['k8s', 'pod', pod.metadata.namespace, pod.metadata.name] })
      qc.invalidateQueries({ queryKey: ['k8s'] })
    }
  }

  const format = () => {
    setError(null)
    try {
      const trimmed = draft.trimStart()
      const parsed = trimmed.startsWith('{') || trimmed.startsWith('[')
        ? JSON.parse(draft)
        : parseYaml(draft)
      setDraft(toYaml(parsed, skip))
    } catch (e) {
      setError(`Cannot format — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const apply = async () => {
    if (!pod) return
    setError(null)
    setSuccess(false)
    let parsed: unknown
    try {
      // Accept either format — power users may paste raw JSON into the editor.
      const trimmed = draft.trimStart()
      parsed = trimmed.startsWith('{') || trimmed.startsWith('[')
        ? JSON.parse(draft)
        : parseYaml(draft)
    } catch (e) {
      setError(`Parse error: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setApplying(true)
    try {
      await client.replaceGeneric(
        LOCAL_CLUSTER,
        gvr,
        pod.metadata.namespace ?? '',
        pod.metadata.name,
        parsed,
      )
      setSuccess(true)
      setEditing(false)
      setShowDiff(false)
      // Nudge any open queries so the drawer's other tabs refresh too.
      qc.invalidateQueries({ queryKey: ['k8s', 'pod', pod.metadata.namespace, pod.metadata.name] })
      qc.invalidateQueries({ queryKey: ['k8s'] })
    } catch (e) {
      // K8s API errors carry body.message which is usually the useful bit.
      const status = (e as { status?: number }).status
      const body = (e as { body?: { message?: string } }).body
      setError(
        `${status ? `HTTP ${status} · ` : ''}${
          body?.message ?? (e instanceof Error ? e.message : String(e))
        }`,
      )
    } finally {
      setApplying(false)
    }
  }

  // Keep the ⌘S handler pointing at the freshest closure without re-mounting.
  const applyRef = useRef(apply)
  applyRef.current = apply

  if (!pod) {
    return <div className="p-8 text-sm text-content-muted">Loading…</div>
  }

  const errorCount = issues.length

  return (
    <div className="space-y-3">
      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken p-2">
        <span className="text-[11px] font-medium text-content-subtle">
          {editing
            ? dirty
              ? 'Editing · Apply PUTs the buffer to the apiserver'
              : 'Editing · no changes yet'
            : canWrite
              ? 'Live manifest · click Edit to modify'
              : 'Live manifest · read-only'}
        </span>

        <Toggle active={hideNoise} onClick={() => setHideNoise((v) => !v)} title="Hide server-managed managedFields + status for readability (not sent to the apiserver either way)">
          {hideNoise ? 'Noise hidden' : 'Show all fields'}
        </Toggle>
        <Toggle active={minimap} onClick={() => setMinimap((v) => !v)} title="Toggle the Monaco minimap">
          Minimap
        </Toggle>
        <Toggle active={wordWrap} onClick={() => setWordWrap((v) => !v)} title="Toggle soft word-wrap">
          Wrap
        </Toggle>
        {editing ? (
          <Toggle
            active={showDiff}
            disabled={!dirty}
            onClick={() => setShowDiff((v) => !v)}
            title={dirty ? 'Diff the buffer against the live cluster manifest' : 'No changes to diff'}
          >
            <span className="font-mono">±</span> Diff
          </Toggle>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={copy}>Copy</Button>
          <Button size="sm" variant="secondary" onClick={download}>Download</Button>
          {editing ? (
            <>
              <Button size="sm" variant="secondary" onClick={reload} disabled={applying} title="Discard local edits and reload the manifest from the cluster">
                Reload
              </Button>
              <Button size="sm" variant="secondary" onClick={format} disabled={applying} title="Prettify — round-trip the buffer through the YAML serializer">
                Format
              </Button>
              <Button size="sm" variant="secondary" onClick={cancel} disabled={applying}>Cancel</Button>
              <Button
                size="sm"
                onClick={apply}
                disabled={applying || !dirty || !canWrite || errorCount > 0}
                title={
                  !canWrite
                    ? 'Apply requires the Tenant Admin or Platform Admin role'
                    : errorCount > 0
                      ? 'Fix the YAML errors before applying'
                      : !dirty
                        ? 'No changes to apply'
                        : 'Apply (⌘S)'
                }
              >
                {applying ? 'Applying…' : 'Apply'}
              </Button>
            </>
          ) : canWrite ? (
            <Button size="sm" variant="secondary" onClick={reload} title="Reload the manifest from the cluster">
              Reload
            </Button>
          ) : null}
          {!editing && canWrite ? (
            <Button size="sm" onClick={startEdit}>Edit</Button>
          ) : null}
          {!canWrite ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] text-content-muted"
              title="Editing requires the Tenant Admin or Platform Admin role"
            >
              <LockIcon /> read-only
              <K8sRolePill perm={writePerm} />
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">
          <strong className="font-semibold">Apply failed:</strong> {error}
        </div>
      ) : null}
      {success && !editing ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
          <strong className="font-semibold">Applied.</strong> apiserver accepted the update.
        </div>
      ) : null}

      {/* ── editor ── */}
      {showDiff && editing && dirty ? (
        <MonacoDiff original={base} modified={draft} />
      ) : (
        <MonacoYaml
          value={value}
          readOnly={!editing}
          minimap={minimap}
          wordWrap={wordWrap}
          onChange={editing ? setDraft : undefined}
          onValidate={setIssues}
          onSave={() => {
            if (editing && canWrite) applyRef.current()
          }}
        />
      )}

      {/* ── status line ── */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {errorCount === 0 ? (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Valid YAML
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            {errorCount} YAML {errorCount === 1 ? 'error' : 'errors'}
            <span className="text-content-muted">
              · line {issues[0].line}: {issues[0].message}
            </span>
          </span>
        )}
        <span className="ml-auto font-mono text-content-subtle">
          {gvr.group ? `${gvr.group}/` : ''}{gvr.version}/{gvr.resource}
          {value ? ` · ${value.split('\n').length} lines` : ''}
        </span>
      </div>
    </div>
  )
}

/* ───── toolbar bits ───── */

function Toggle({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick(): void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/25 dark:bg-brand-500/10 dark:text-brand-300'
          : 'border-edge-default bg-surface-raised text-content-muted hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

/* ───── Monaco YAML editor ───── */

function themeName(): string {
  if (typeof document === 'undefined') return 'adhar-light'
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark') return 'vs-dark'
  if (attr === 'light') return 'adhar-light'
  const prefersDark = typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-color-scheme: dark)').matches
  return prefersDark ? 'vs-dark' : 'adhar-light'
}

function MonacoYaml({
  value,
  readOnly,
  minimap,
  wordWrap,
  onChange,
  onValidate,
  onSave,
}: {
  value: string
  readOnly: boolean
  minimap: boolean
  wordWrap: boolean
  onChange?(v: string): void
  onValidate?(issues: YamlIssue[]): void
  onSave?(): void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const monacoRef = useRef<RichMonaco | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  // Latest callbacks via refs so the once-mounted editor always calls fresh ones.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onValidateRef = useRef(onValidate)
  onValidateRef.current = onValidate
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const runValidate = (text: string) => {
    if (!onValidateRef.current) return
    const issues = validateYaml(text)
    onValidateRef.current(issues)
    const m = monacoRef.current
    const model = editorRef.current?.getModel()
    if (m && model) {
      m.editor.setModelMarkers(model, 'adhar-yaml', issues.map((i) => ({
        startLineNumber: i.line,
        startColumn: i.column,
        endLineNumber: i.line,
        endColumn: i.column + 1,
        message: i.message,
        severity: m.MarkerSeverity.Error,
      })))
    }
  }

  // Mount once.
  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((raw) => {
        if (disposed || !hostRef.current) return
        const m = raw as unknown as RichMonaco
        monacoRef.current = m
        m.editor.setTheme(themeName())
        editorRef.current = m.editor.create(hostRef.current, {
          value,
          language: 'yaml',
          readOnly,
          minimap: { enabled: minimap },
          wordWrap: wordWrap ? 'on' : 'off',
          automaticLayout: true,
          fontSize: 12,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          tabSize: 2,
          bracketPairColorization: { enabled: true },
          matchBrackets: 'always',
          smoothScrolling: true,
        })
        editorRef.current.onDidChangeModelContent(() => {
          const text = editorRef.current?.getValue() ?? ''
          onChangeRef.current?.(text)
          runValidate(text)
        })
        editorRef.current.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => onSaveRef.current?.())
        runValidate(value)
        setReady(true)
      })
      .catch((e) => setFailed((e as Error).message))
    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push external value changes (format / reload / toggle / refetch) into Monaco
  // without clobbering in-flight typing (only when they truly differ).
  useEffect(() => {
    const ed = editorRef.current
    if (ready && ed && ed.getValue() !== value) {
      ed.setValue(value)
      runValidate(value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, value])

  useEffect(() => {
    if (ready) {
      editorRef.current?.updateOptions({
        readOnly,
        minimap: { enabled: minimap },
        wordWrap: wordWrap ? 'on' : 'off',
      })
    }
  }, [ready, readOnly, minimap, wordWrap])

  if (failed) {
    // Honest degrade — Monaco (jsDelivr) couldn't load; fall back to a plain,
    // read-only pre so the manifest is still viewable/copyable.
    return (
      <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-sunken">
        <div className="border-b border-edge-default px-3 py-1.5 text-[11px] text-content-muted">
          Editor failed to load ({failed}) — showing plain text.
        </div>
        <pre className="max-h-[55vh] overflow-auto p-3 font-mono text-[12px] leading-[1.55] text-content whitespace-pre">
          {value}
        </pre>
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      {!ready ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface-raised/70 text-sm text-content-muted">
          <Spinner size={16} /> Loading editor…
        </div>
      ) : null}
      <div ref={hostRef} className="h-[55vh] w-full" />
    </div>
  )
}

/* ───── Monaco diff (cluster vs buffer) ───── */

function MonacoDiff({ original, modified }: { original: string; modified: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const diffRef = useRef<MonacoDiffEditor | null>(null)
  const modelsRef = useRef<{ original: MonacoModel; modified: MonacoModel } | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((raw) => {
        if (disposed || !hostRef.current) return
        const m = raw as unknown as RichMonaco
        m.editor.setTheme(themeName())
        const originalModel = m.editor.createModel(original, 'yaml')
        const modifiedModel = m.editor.createModel(modified, 'yaml')
        modelsRef.current = { original: originalModel, modified: modifiedModel }
        diffRef.current = m.editor.createDiffEditor(hostRef.current, {
          readOnly: true,
          renderSideBySide: true,
          automaticLayout: true,
          fontSize: 12,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          ignoreTrimWhitespace: false,
        })
        diffRef.current.setModel({ original: originalModel, modified: modifiedModel })
        setReady(true)
      })
      .catch((e) => setFailed((e as Error).message))
    return () => {
      disposed = true
      diffRef.current?.dispose()
      modelsRef.current?.original.dispose()
      modelsRef.current?.modified.dispose()
      diffRef.current = null
      modelsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the diff models in sync as the buffer edits.
  useEffect(() => {
    if (ready && modelsRef.current) {
      if (modelsRef.current.original.getValue() !== original) modelsRef.current.original.setValue(original)
      if (modelsRef.current.modified.getValue() !== modified) modelsRef.current.modified.setValue(modified)
    }
  }, [ready, original, modified])

  if (failed) {
    return (
      <div className="rounded-xl border border-edge-default bg-surface-sunken p-4 text-xs text-content-muted">
        Diff view failed to load ({failed}).
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex items-center justify-between border-b border-edge-default px-3 py-1.5 text-[11px] text-content-muted">
        <span className="font-mono uppercase tracking-wider">Diff · cluster (left) → buffer (right)</span>
        <span className="text-content-subtle">what Apply will change</span>
      </div>
      <div className="relative">
        {!ready ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface-raised/70 text-sm text-content-muted">
            <Spinner size={16} /> Loading diff…
          </div>
        ) : null}
        <div ref={hostRef} className="h-[50vh] w-full" />
      </div>
    </div>
  )
}

/* ───── YAML validation ─────
 * Real, line-accurate syntax checks: YAML forbids tab indentation, and the
 * repo parser rejects malformed structure. Cheap and honest — good enough to
 * catch the mistakes hand-editing introduces before an Apply round-trip. */
function validateYaml(text: string): YamlIssue[] {
  const issues: YamlIssue[] = []
  const trimmed = text.trimStart()
  // JSON buffers are valid input too — validate them as JSON.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(text)
    } catch (e) {
      issues.push({ line: 1, column: 1, message: e instanceof Error ? e.message : 'Invalid JSON' })
    }
    return issues
  }
  const lines = text.split('\n')
  lines.forEach((l, idx) => {
    const indentMatch = l.match(/^([ \t]*)/)
    const indent = indentMatch ? indentMatch[1] : ''
    if (indent.includes('\t')) {
      issues.push({
        line: idx + 1,
        column: indent.indexOf('\t') + 1,
        message: 'Tabs are not allowed for YAML indentation — use spaces',
      })
    }
  })
  if (issues.length === 0) {
    try {
      parseYaml(text)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const lineMatch = msg.match(/line (\d+)/i)
      issues.push({
        line: lineMatch ? parseInt(lineMatch[1], 10) : 1,
        column: 1,
        message: msg,
      })
    }
  }
  return issues
}

/* ───── YAML serialize + parse ───── */

const DEFAULT_SKIP = new Set(['managedFields'])

export function toYaml(value: unknown, skip: Set<string> = DEFAULT_SKIP): string {
  const emit = (v: unknown, indent: number, inList: boolean): string => {
    const pad = '  '.repeat(indent)
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') {
      if (v.includes('\n')) {
        return `|\n${v
          .split('\n')
          .map((l) => `${pad}${l}`)
          .join('\n')}`
      }
      return /^[-:#?&*!{}[\]|>'"%@`,]/.test(v) || /^(true|false|null|\d)/.test(v)
        ? JSON.stringify(v)
        : v
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]'
      return v
        .map((item) => {
          const body = emit(item, indent + 1, true)
          if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            return `${pad}- ${body.trimStart()}`
          }
          return `${pad}- ${body}`
        })
        .join('\n')
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([k]) => !skip.has(k))
      if (entries.length === 0) return '{}'
      return entries
        .map(([k, val], i) => {
          const inlinePad = inList && i === 0 ? '' : pad
          if (
            val !== null &&
            typeof val === 'object' &&
            (Array.isArray(val) ? val.length > 0 : Object.keys(val).length > 0)
          ) {
            return `${inlinePad}${k}:\n${emit(val, indent + 1, false)}`
          }
          return `${inlinePad}${k}: ${emit(val, indent + 1, false)}`
        })
        .join('\n')
    }
    return String(v)
  }
  return emit(value, 0, false)
}

/**
 * Minimal YAML parser for the shapes K8s objects round-trip through. Handles
 * nested maps, lists of scalars, and lists of maps at 2-space indentation.
 * Not a general-purpose YAML parser — good enough for the edit flow where we
 * serialise the same way we parse.
 */
export function parseYaml(text: string): unknown {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  let i = 0

  const indentOf = (l: string) => {
    let n = 0
    while (n < l.length && l[n] === ' ') n++
    return n
  }
  const isBlank = (l: string) => !l.trim() || l.trim().startsWith('#')

  const parseScalar = (v: string): unknown => {
    if (v === '' || v === 'null' || v === '~') return null
    if (v === 'true') return true
    if (v === 'false') return false
    if (/^-?\d+$/.test(v)) return parseInt(v, 10)
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v)
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return JSON.parse(v.replace(/^'|'$/g, '"'))
    }
    return v
  }

  const parseBlock = (indent: number): unknown => {
    // Peek at first non-blank line to decide map vs list.
    while (i < lines.length && isBlank(lines[i])) i++
    if (i >= lines.length) return null
    const first = lines[i]
    if (indentOf(first) < indent) return null

    if (first.trim().startsWith('- ')) return parseList(indent)
    return parseMap(indent)
  }

  const parseMap = (indent: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    while (i < lines.length) {
      const line = lines[i]
      if (isBlank(line)) { i++; continue }
      const lineIndent = indentOf(line)
      if (lineIndent < indent) break
      if (lineIndent > indent) break // shouldn't happen at map level

      const m = line.slice(indent).match(/^([^\s:][^:]*):\s*(.*)$/)
      if (!m) break
      const [, key, rest] = m
      i++
      if (rest === '' || rest === undefined) {
        // Look ahead — nested block.
        const next = lines[i]
        if (next && !isBlank(next) && indentOf(next) > indent) {
          out[key] = parseBlock(indent + 2)
        } else {
          out[key] = null
        }
      } else if (rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')) {
        // Block scalar.
        const lines2: string[] = []
        while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) > indent)) {
          lines2.push(lines[i].slice(indent + 2))
          i++
        }
        out[key] = lines2.join('\n').replace(/\n+$/, '')
      } else if (rest === '{}') {
        out[key] = {}
      } else if (rest === '[]') {
        out[key] = []
      } else {
        out[key] = parseScalar(rest)
      }
    }
    return out
  }

  const parseList = (indent: number): unknown[] => {
    const out: unknown[] = []
    while (i < lines.length) {
      const line = lines[i]
      if (isBlank(line)) { i++; continue }
      const lineIndent = indentOf(line)
      if (lineIndent < indent) break
      if (lineIndent > indent) break
      const trimmed = line.slice(indent)
      if (!trimmed.startsWith('- ')) break
      const rest = trimmed.slice(2)
      i++
      if (!rest) {
        // Block follows.
        const next = lines[i]
        if (next && !isBlank(next) && indentOf(next) > indent) {
          out.push(parseBlock(indent + 2))
        } else {
          out.push(null)
        }
      } else if (rest.includes(':') && !rest.startsWith('"') && !rest.startsWith("'")) {
        // Inline map item — synthesize a pseudo-line and parse as map at
        // indent + 2, back-paddng so the key aligns.
        const inlineLines: string[] = []
        const base = '  '.repeat((indent + 2) / 2)
        inlineLines.push(base + rest)
        // Consume subsequent deeper-indented lines as part of this map item.
        while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) > indent)) {
          inlineLines.push(lines[i])
          i++
        }
        // Parse the inline block by resetting the line cursor temporarily.
        const savedLines = lines
        const savedIdx = i
        ;(lines as unknown as string[]).length = 0
        for (const l of inlineLines) (lines as unknown as string[]).push(l)
        i = 0
        const parsed = parseMap(indent + 2)
        ;(lines as unknown as string[]).length = 0
        for (const l of savedLines) (lines as unknown as string[]).push(l)
        i = savedIdx
        out.push(parsed)
      } else {
        out.push(parseScalar(rest))
      }
    }
    return out
  }

  const result = parseBlock(0)
  return result
}
