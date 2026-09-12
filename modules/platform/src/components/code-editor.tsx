import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar-console/utils'
import { useOverlayDismiss } from '@adhar-console/shell-ui'
import { loadMonaco, type MonacoEditorInstance } from './monaco-loader.ts'

/**
 * Shared, enterprise-grade code editor — a single Monaco-backed component used
 * everywhere the console shows or edits code, YAML, or JSON (resource manifests,
 * ConfigMaps/Secrets, Helm values, pipeline specs, raw entities…). It replaces
 * the ad-hoc `<pre>` / `<textarea>` blocks that were scattered across views so
 * every surface gets the same feature set:
 *
 *   • Syntax highlighting for YAML / JSON / many languages, bracket matching,
 *     code folding, minimap, word-wrap, find & replace (⌘F), multi-cursor.
 *   • Theme-aware (light / dark, following the app theme).
 *   • A compact toolbar: copy, download, format (JSON/YAML), wrap & minimap
 *     toggles, and fullscreen.
 *   • Read-only "viewer" mode (default) and an editable mode with ⌘S to save.
 *   • Honest graceful degradation: if Monaco can't load from the CDN we fall
 *     back to a plain, still-copyable text area so content is never hidden.
 *
 * Monaco itself is pulled lazily from jsDelivr by `monaco-loader.ts`; this
 * component just wraps it with the console's chrome and lifecycle handling.
 */

export type CodeLanguage =
  | 'yaml'
  | 'json'
  | 'shell'
  | 'dockerfile'
  | 'hcl'
  | 'ini'
  | 'markdown'
  | 'javascript'
  | 'typescript'
  | 'go'
  | 'python'
  | 'sql'
  | 'plaintext'

interface RichMonaco {
  editor: {
    create(el: HTMLElement, opts?: unknown): MonacoEditorInstance
    setTheme(name: string): void
    setModelLanguage?(model: unknown, language: string): void
  }
  KeyMod: Record<string, number>
  KeyCode: Record<string, number>
}

/** Resolve the Monaco theme from the app's current theme setting. */
function themeName(): string {
  if (typeof document === 'undefined') return 'adhar-light'
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark') return 'vs-dark'
  if (attr === 'light') return 'adhar-light'
  const prefersDark =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-color-scheme: dark)').matches
  return prefersDark ? 'vs-dark' : 'adhar-light'
}

/** Pretty-print JSON / YAML-ish content for the Format action (best-effort). */
function tryFormat(value: string, language: CodeLanguage): string {
  if (language === 'json') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return value
}

const EXT: Partial<Record<CodeLanguage, string>> = {
  yaml: 'yaml',
  json: 'json',
  shell: 'sh',
  dockerfile: 'Dockerfile',
  hcl: 'tf',
  ini: 'ini',
  markdown: 'md',
  javascript: 'js',
  typescript: 'ts',
  go: 'go',
  python: 'py',
  sql: 'sql',
  plaintext: 'txt',
}

export interface CodeEditorProps {
  value: string
  language?: CodeLanguage
  /** Read-only viewer (default) vs editable. */
  readOnly?: boolean
  onChange?(value: string): void
  onSave?(): void
  /** Filename used by the Download action (extension derived from language). */
  filename?: string
  /** Optional heading shown on the left of the toolbar. */
  title?: React.ReactNode
  /** Extra toolbar controls (e.g. Edit/Save buttons) rendered on the right. */
  actions?: React.ReactNode
  /** Fixed pixel height. Defaults to 320. Ignored while fullscreen. */
  height?: number
  minimap?: boolean
  wordWrap?: boolean
  /** Hide the toolbar entirely (rare — embedded contexts). */
  hideToolbar?: boolean
  className?: string
}

export function CodeEditor({
  value,
  language = 'yaml',
  readOnly = true,
  onChange,
  onSave,
  filename,
  title,
  actions,
  height = 320,
  minimap: minimapInit = false,
  wordWrap: wordWrapInit = false,
  hideToolbar = false,
  className,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const monacoRef = useRef<RichMonaco | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [minimap, setMinimap] = useState(minimapInit)
  const [wordWrap, setWordWrap] = useState(wordWrapInit)
  const [fullscreen, setFullscreen] = useState(false)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const lineCount = useMemo(() => value.split('\n').length, [value])

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
          language,
          readOnly,
          minimap: { enabled: minimap },
          wordWrap: wordWrap ? 'on' : 'off',
          automaticLayout: true,
          fontSize: 12,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          tabSize: 2,
          folding: true,
          bracketPairColorization: { enabled: true },
          matchBrackets: 'always',
          smoothScrolling: true,
          stickyScroll: { enabled: true },
          padding: { top: 8, bottom: 8 },
          scrollbar: { alwaysConsumeMouseWheel: false },
        })
        editorRef.current.onDidChangeModelContent(() => {
          onChangeRef.current?.(editorRef.current?.getValue() ?? '')
        })
        editorRef.current.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => onSaveRef.current?.())
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

  // Push external value changes in without clobbering in-flight typing.
  useEffect(() => {
    const ed = editorRef.current
    if (ready && ed && ed.getValue() !== value) ed.setValue(value)
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

  // Re-layout when toggling fullscreen.
  useEffect(() => {
    if (ready) requestAnimationFrame(() => editorRef.current?.layout())
  }, [ready, fullscreen])

  // Keep the theme in sync with app theme changes.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const obs = new MutationObserver(() => monacoRef.current?.editor.setTheme(themeName()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  const copy = () => {
    try {
      navigator.clipboard?.writeText(editorRef.current?.getValue() ?? value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }

  const download = () => {
    const text = editorRef.current?.getValue() ?? value
    const ext = EXT[language] ?? 'txt'
    const name = filename ?? `download.${ext}`
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name.includes('.') ? name : `${name}.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const format = () => {
    const ed = editorRef.current
    if (!ed) return
    const next = tryFormat(ed.getValue(), language)
    if (next !== ed.getValue()) {
      ed.setValue(next)
      onChangeRef.current?.(next)
    }
  }

  // ESC leaves fullscreen — the same gesture that dismisses every other
  // overlay in the console. Scroll stays unlocked: the editor floats over the
  // page rather than blocking it, and the toolbar's exit button remains.
  useOverlayDismiss(fullscreen, () => setFullscreen(false), { lockScroll: false })

  const shell = (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised',
        fullscreen && 'fixed inset-3 z-[60] shadow-2xl',
        className,
      )}
    >
      {!hideToolbar ? (
        <div className="flex items-center justify-between gap-2 border-b border-edge-default bg-surface-sunken/50 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            {title ? (
              <span className="truncate text-[12px] font-semibold text-content">{title}</span>
            ) : null}
            <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-content-subtle">
              {language}
            </span>
            <span className="hidden font-mono text-[10px] text-content-subtle sm:inline">
              {lineCount} lines
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {actions}
            {language === 'json' && !readOnly ? (
              <ToolBtn label="Format" onClick={format}>
                <IconWand />
              </ToolBtn>
            ) : null}
            <ToolBtn label={wordWrap ? 'Disable wrap' : 'Wrap lines'} active={wordWrap} onClick={() => setWordWrap((w) => !w)}>
              <IconWrap />
            </ToolBtn>
            <ToolBtn label={minimap ? 'Hide minimap' : 'Show minimap'} active={minimap} onClick={() => setMinimap((m) => !m)}>
              <IconMap />
            </ToolBtn>
            <ToolBtn label={copied ? 'Copied' : 'Copy'} onClick={copy}>
              {copied ? <IconCheck /> : <IconCopy />}
            </ToolBtn>
            <ToolBtn label="Download" onClick={download}>
              <IconDownload />
            </ToolBtn>
            <ToolBtn label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => setFullscreen((f) => !f)}>
              {fullscreen ? <IconMinimize /> : <IconMaximize />}
            </ToolBtn>
          </div>
        </div>
      ) : null}

      {failed ? (
        <div className="flex flex-col" style={{ height: fullscreen ? undefined : height }}>
          <div className="border-b border-edge-default px-3 py-1.5 text-[11px] text-content-muted">
            Editor failed to load ({failed}) — showing plain text.
          </div>
          <textarea
            readOnly
            value={value}
            className="flex-1 resize-none bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-content outline-none"
          />
        </div>
      ) : (
        /* Height is set exactly one way at a time, and mixing them is what made
           the editor render as an empty strip.

           `flex-1` is `flex: 1 1 0%`, and in a column flex container the
           flex-basis wins over `height`. The shell's own height is auto, so
           there is no free space for `flex-grow` to distribute: the basis of 0
           stands, Monaco gets a zero-height host, and the toolbar appears above
           nothing. Inline, the fixed height must therefore be the only rule;
           only in fullscreen — where the shell *is* given a definite height —
           does flex sizing make sense. */
        <div
          ref={hostRef}
          className={fullscreen ? 'min-h-0 flex-1' : undefined}
          style={fullscreen ? undefined : { height }}
        />
      )}
    </div>
  )

  // When fullscreen, render a dimmed backdrop behind the floating editor.
  if (fullscreen) {
    return (
      <>
        <div
          className="fixed inset-0 z-[59] bg-scrim/40 backdrop-blur-[2px]"
          onClick={() => setFullscreen(false)}
        />
        {shell}
      </>
    )
  }
  return shell
}

function ToolBtn({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md transition',
        active
          ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300'
          : 'text-content-subtle hover:bg-surface-sunken hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

/* ─── icons (14px) ─── */
const S = ({ children }: { children: React.ReactNode }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
)
const IconCopy = () => (
  <S><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></S>
)
const IconCheck = () => <S><path d="M20 6 9 17l-5-5" /></S>
const IconDownload = () => <S><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></S>
const IconWrap = () => <S><path d="M3 6h18" /><path d="M3 12h15a3 3 0 1 1 0 6h-4" /><path d="m16 16-2 2 2 2" /><path d="M3 18h7" /></S>
const IconMap = () => <S><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" /><path d="M9 4v14" /><path d="M15 6v14" /></S>
const IconWand = () => <S><path d="m3 21 12-12" /><path d="M15 4V2M15 10V8M9 15H7M21 15h-2M18 5l-1.5 1.5M12.5 10.5 11 12" /></S>
const IconMaximize = () => <S><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></S>
const IconMinimize = () => <S><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" /></S>
