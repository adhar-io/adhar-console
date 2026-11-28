import { useEffect, useRef, useState } from 'react'
import { cn } from '@adhar/utils'
import type { MonacoApi, MonacoEditorInstance } from '../../components/monaco-loader.ts'
import type { WfDoc } from '../model/doc.ts'
import { pathAt, rangeOf } from '../model/doc.ts'
import type { Diagnostic } from '../model/validate.ts'

/**
 * The YAML panel (design 0026 §6.5 "two-way editing"): the same document as
 * the canvas, in Monaco. Typing is reported 400 ms after the last key; a
 * canvas edit replaces the text and keeps the cursor on the same FIELD
 * (`rangeOf(next, pathAt(prev, offset))`), not the same character offset,
 * which an edit above it would have moved. Diagnostics with a range are
 * Monaco markers.
 *
 * Until Monaco loads — and wherever it cannot (no CDN, a test renderer) — the
 * panel is a plain text area with the same contract, so the YAML is never
 * hidden and never read-only by accident.
 */

export const TYPING_DEBOUNCE_MS = 400

export interface YamlPanelProps {
  doc: WfDoc
  diagnostics: readonly Diagnostic[]
  onText(text: string): void
  /** Bump `nonce` to move the cursor to `range` (a diagnostic clicked in the bar). */
  reveal?: { range: NonNullable<Diagnostic['range']>; nonce: number }
  readOnly?: boolean
  className?: string
}

type Severity = 8 | 4 | 2

export function markersOf(diagnostics: readonly Diagnostic[]): Array<{ severity: Severity; message: string; startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; source: string }> {
  return diagnostics.filter((d) => d.range).map((d) => ({
    severity: d.level === 'error' ? 8 : d.level === 'warning' ? 4 : 2,
    message: d.message,
    startLineNumber: d.range!.startLine,
    startColumn: d.range!.startCol,
    endLineNumber: d.range!.endLine,
    endColumn: d.range!.endCol,
    source: d.code,
  }))
}

export function YamlPanel({ doc, diagnostics, onText, reveal, readOnly, className }: YamlPanelProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const editor = useRef<MonacoEditorInstance | null>(null)
  const monaco = useRef<MonacoApi | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [plain, setPlain] = useState(doc.source)
  const prev = useRef(doc)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const emit = useRef(onText)
  emit.current = onText

  const schedule = (text: string) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => emit.current(text), TYPING_DEBOUNCE_MS)
  }

  useEffect(() => {
    let gone = false
    // Loaded on first open, not with the page: Monaco is large, and its stylesheet is a build-time import.
    import('../../components/monaco-loader.ts').then((mod) => mod.loadMonaco()).then((m) => {
      if (gone || !host.current) return
      monaco.current = m
      const ed = m.editor.create(host.current, {
        value: prev.current.source,
        language: 'yaml',
        readOnly,
        automaticLayout: true,
        fontSize: 12,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
        padding: { top: 8, bottom: 8 },
        scrollbar: { alwaysConsumeMouseWheel: false },
        ariaLabel: 'Workflow YAML',
      })
      editor.current = ed
      ed.onDidChangeModelContent((e) => {
        // A change we pushed in (`isFlush`) is not typing.
        if (!e.isFlush) schedule(ed.getValue())
      })
      setReady(true)
    }).catch(() => setFailed(true))
    return () => {
      gone = true
      clearTimeout(timer.current)
      editor.current?.dispose()
      editor.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The document changed from outside (canvas, undo): replace the text, keep the cursor on its field.
  useEffect(() => {
    const before = prev.current
    prev.current = doc
    setPlain((p) => (p === doc.source ? p : doc.source))
    const ed = editor.current
    if (!ready || !ed || ed.getValue() === doc.source) return
    const model = ed.getModel()
    const pos = ed.getPosition()
    let target: { lineNumber: number; column: number } | undefined
    if (model && pos) {
      const path = pathAt(before, model.getOffsetAt(pos))
      const r = path.length ? rangeOf(doc, path) : undefined
      if (r) target = { lineNumber: r.startLine, column: r.startCol }
    }
    const scroll = ed.getScrollTop()
    clearTimeout(timer.current)
    ed.setValue(doc.source)
    ed.setScrollTop(scroll)
    if (target) ed.setPosition(target)
  }, [doc, ready])

  useEffect(() => {
    const ed = editor.current
    const m = monaco.current
    const model = ed?.getModel()
    if (!ready || !m || !model) return
    m.editor.setModelMarkers(model, 'adhar-designer', markersOf(diagnostics) as never)
  }, [diagnostics, ready])

  useEffect(() => {
    if (!reveal) return
    const ed = editor.current
    if (ed) {
      ed.revealLineInCenter(reveal.range.startLine)
      ed.setPosition({ lineNumber: reveal.range.startLine, column: reveal.range.startCol })
      ed.focus()
    }
  }, [reveal?.nonce])

  useEffect(() => {
    editor.current?.updateOptions({ readOnly })
  }, [readOnly])

  return (
    <div className={cn('relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised', className)}>
      <div ref={host} className={cn('min-h-0 flex-1', (!ready || failed) && 'hidden')} />
      {!ready || failed ? (
        <textarea
          aria-label="Workflow YAML"
          value={plain}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(e) => {
            setPlain(e.currentTarget.value)
            schedule(e.currentTarget.value)
          }}
          className="min-h-0 w-full flex-1 resize-none bg-transparent p-3 font-mono text-xs text-content focus:outline-none"
        />
      ) : null}
    </div>
  )
}
