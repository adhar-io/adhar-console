import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import monacoCss from 'monaco-editor/min/vs/editor/editor.main.css?inline'

/**
 * Monaco-backed source editor for the Design tools (Mermaid, OpenAPI YAML /
 * JSON, Markdown). Bundled and worker-free: `editor.api` + the Monarch
 * grammars tokenise on the main thread, so it works on an air-gapped install.
 * Lazy — the chunk only loads the first time an editor mounts.
 *
 * Adds what the views need on top of a plain editor:
 *   • a Mermaid grammar,
 *   • diagnostics as inline markers (`markers`),
 *   • `reveal` to jump to a line (e.g. clicking a validation issue),
 *   • ⌘S → `onSave`, and theme sync with the console's `.dark` class.
 * Falls back to a textarea if Monaco cannot load, so content is never hidden.
 */

type MonacoApi = typeof Monaco
type Editor = Monaco.editor.IStandaloneCodeEditor

declare global {
  // eslint-disable-next-line no-var
  var __adharDesignMonaco: Promise<MonacoApi> | undefined
}

export type SourceLanguage = 'mermaid' | 'yaml' | 'json' | 'markdown' | 'plaintext'

export interface SourceMarker {
  line: number
  column?: number
  message: string
  severity?: 'error' | 'warning' | 'info'
}

function loadMonaco(): Promise<MonacoApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Monaco requires a browser'))
  if (typeof document !== 'undefined' && !document.getElementById('adhar-monaco-css')) {
    const el = document.createElement('style')
    el.id = 'adhar-monaco-css'
    el.textContent = monacoCss
    document.head.appendChild(el)
  }
  if (globalThis.__adharDesignMonaco) return globalThis.__adharDesignMonaco
  globalThis.__adharDesignMonaco = Promise.all([
    import('monaco-editor/esm/vs/editor/editor.api'),
    import('monaco-editor/esm/vs/basic-languages/monaco.contribution'),
  ])
    .then(([api]) => {
      const m = api as unknown as MonacoApi
      registerExtras(m)
      return m
    })
    .catch((err) => {
      globalThis.__adharDesignMonaco = undefined
      throw err instanceof Error ? err : new Error(String(err))
    })
  return globalThis.__adharDesignMonaco
}

let extrasRegistered = false
function registerExtras(m: MonacoApi) {
  if (extrasRegistered) return
  extrasRegistered = true
  m.languages.register({ id: 'mermaid' })
  m.languages.setMonarchTokensProvider('mermaid', {
    keywords: [
      'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'stateDiagram-v2',
      'erDiagram', 'gantt', 'mindmap', 'journey', 'pie', 'timeline', 'gitGraph', 'quadrantChart',
      'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment', 'requirementDiagram',
      'architecture-beta', 'block-beta', 'sankey-beta', 'xychart-beta', 'kanban', 'packet-beta',
      'subgraph', 'end', 'participant', 'actor', 'loop', 'alt', 'else', 'opt', 'par', 'and',
      'critical', 'break', 'rect', 'note', 'Note', 'over', 'activate', 'deactivate', 'autonumber',
      'class', 'classDef', 'style', 'linkStyle', 'click', 'direction', 'state', 'section', 'title',
      'dateFormat', 'axisFormat', 'excludes', 'Person', 'Person_Ext', 'System', 'System_Ext',
      'SystemDb', 'Container', 'ContainerDb', 'Container_Ext', 'Component', 'Rel', 'BiRel',
      'Boundary', 'System_Boundary', 'Container_Boundary', 'Enterprise_Boundary', 'UpdateLayoutConfig',
      'TB', 'TD', 'BT', 'LR', 'RL', 'commit', 'branch', 'checkout', 'merge', 'service', 'group',
      'junction', 'root',
    ],
    tokenizer: {
      root: [
        [/%%.*$/, 'comment'],
        [/"[^"]*"/, 'string'],
        [/\|[^|]*\|/, 'string'],
        [/[-=.]+>+|<-+>|-{2,}|={2,}|\.-+|--[ox]|-\)|--\)|->>|-->>|-x|--x/, 'operator'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/[A-Za-z_][\w-]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/[[\](){}]/, 'delimiter.bracket'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage)
  m.editor.defineTheme('adhar-design-light', {
    base: 'vs',
    inherit: true,
    rules: [{ token: 'keyword', foreground: '4f46e5', fontStyle: 'bold' }],
    colors: { 'editor.background': '#ffffff' },
  })
  m.editor.defineTheme('adhar-design-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: 'keyword', foreground: 'a5b4fc', fontStyle: 'bold' }],
    colors: { 'editor.background': '#0b1120' },
  })
}

function isDark(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

/** Monaco has no JSON grammar without its worker — JS tokenising reads well. */
function monacoLanguage(lang: SourceLanguage): string {
  return lang === 'json' ? 'javascript' : lang
}

export function SourceEditor({
  value,
  onChange,
  language,
  markers,
  reveal,
  onSave,
  readOnly = false,
  className,
  wordWrap = false,
  ariaLabel,
}: {
  value: string
  onChange?(v: string): void
  language: SourceLanguage
  markers?: SourceMarker[]
  /** Change `nonce` to scroll to and select `line`. */
  reveal?: { line: number; nonce: number } | null
  onSave?(): void
  readOnly?: boolean
  className?: string
  wordWrap?: boolean
  ariaLabel?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const edRef = useRef<Editor | null>(null)
  const mRef = useRef<MonacoApi | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((m) => {
        if (disposed || !hostRef.current) return
        mRef.current = m
        m.editor.setTheme(isDark() ? 'adhar-design-dark' : 'adhar-design-light')
        const ed = m.editor.create(hostRef.current, {
          value,
          language: monacoLanguage(language),
          readOnly,
          automaticLayout: true,
          fontSize: 12.5,
          lineHeight: 19,
          minimap: { enabled: false },
          wordWrap: wordWrap ? 'on' : 'off',
          scrollBeyondLastLine: false,
          tabSize: 2,
          folding: true,
          renderLineHighlight: 'line',
          padding: { top: 10, bottom: 10 },
          scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10 },
          fixedOverflowWidgets: true,
          ariaLabel,
        })
        ed.onDidChangeModelContent(() => onChangeRef.current?.(ed.getValue()))
        ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => onSaveRef.current?.())
        edRef.current = ed
        setReady(true)
      })
      .catch((e) => setFailed((e as Error).message))
    return () => {
      disposed = true
      edRef.current?.dispose()
      edRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External value changes (template insert, import) — keep undo stack.
  useEffect(() => {
    const ed = edRef.current
    if (!ready || !ed || ed.getValue() === value) return
    const model = ed.getModel()
    if (!model) return
    ed.pushUndoStop()
    ed.executeEdits('external', [{ range: model.getFullModelRange(), text: value }])
    ed.pushUndoStop()
  }, [ready, value])

  useEffect(() => {
    const ed = edRef.current
    const m = mRef.current
    if (!ready || !ed || !m) return
    const model = ed.getModel()
    if (model) m.editor.setModelLanguage(model, monacoLanguage(language))
  }, [ready, language])

  useEffect(() => {
    if (ready) edRef.current?.updateOptions({ readOnly, wordWrap: wordWrap ? 'on' : 'off' })
  }, [ready, readOnly, wordWrap])

  useEffect(() => {
    const ed = edRef.current
    const m = mRef.current
    if (!ready || !ed || !m) return
    const model = ed.getModel()
    if (!model) return
    const lines = model.getLineCount()
    m.editor.setModelMarkers(
      model,
      'adhar-design',
      (markers ?? []).map((mk) => {
        const line = Math.min(Math.max(1, mk.line), lines)
        return {
          startLineNumber: line,
          endLineNumber: line,
          startColumn: mk.column ?? 1,
          endColumn: model.getLineMaxColumn(line),
          message: mk.message,
          severity: mk.severity === 'warning'
            ? m.MarkerSeverity.Warning
            : mk.severity === 'info'
            ? m.MarkerSeverity.Info
            : m.MarkerSeverity.Error,
        }
      }),
    )
  }, [ready, markers])

  useEffect(() => {
    const ed = edRef.current
    if (!ready || !ed || !reveal) return
    const model = ed.getModel()
    if (!model) return
    const line = Math.min(Math.max(1, reveal.line), model.getLineCount())
    ed.revealLineInCenter(line)
    ed.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) })
    ed.focus()
  }, [ready, reveal])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const obs = new MutationObserver(() =>
      mRef.current?.editor.setTheme(isDark() ? 'adhar-design-dark' : 'adhar-design-light')
    )
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  if (failed) {
    return (
      <div className={`flex flex-col ${className ?? ''}`}>
        <div className="border-b border-edge-default px-3 py-1.5 text-[11px] text-content-muted">
          Editor failed to load ({failed}) — plain text mode.
        </div>
        <textarea
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault()
              onSave?.()
            }
          }}
          spellCheck={false}
          aria-label={ariaLabel}
          className="min-h-0 flex-1 resize-none bg-surface-raised p-3 font-mono text-[12px] leading-relaxed text-content outline-none"
        />
      </div>
    )
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <div ref={hostRef} className="absolute inset-0" />
      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-content-subtle">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-300 border-t-transparent" />
          Loading editor…
        </div>
      ) : null}
    </div>
  )
}
