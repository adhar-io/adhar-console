import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Button, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { hasServerNoise, stripServerNoise, toJson, toYaml } from '~/data/k8s-yaml.ts'
import { consoleMonacoTheme, loadMonaco, type MonacoApi, type MonacoEditorInstance } from './monaco-loader.ts'

/**
 * A read-only object viewer: the value as YAML or JSON in Monaco, with line
 * numbers, folding, find (⌘F / the toolbar), word wrap, copy and download.
 *
 * The text is shown immediately as plain preformatted text and upgraded to the
 * editor when Monaco's chunk arrives, so a slow or blocked chunk never leaves
 * the panel empty. `managedFields` (and the last-applied annotation) are
 * hidden by default — hundreds of lines of bookkeeping above the spec.
 */

export type ViewFormat = 'yaml' | 'json'

export function CodeViewer({
  value,
  filename,
  ariaLabel,
  height = 'min(70vh, 640px)',
  toolbarStart,
  className,
}: {
  value: unknown
  /** Download name without extension. */
  filename: string
  ariaLabel: string
  height?: number | string
  /** Rendered at the toolbar's start (left) — e.g. a source picker. */
  toolbarStart?: ReactNode
  className?: string
}) {
  const toast = useToast()
  const [format, setFormat] = useState<ViewFormat>('yaml')
  const [showManaged, setShowManaged] = useState(false)
  const [wrap, setWrap] = useState(false)
  const noisy = hasServerNoise(value)
  const text = useMemo(() => {
    const v = noisy && !showManaged ? stripServerNoise(value) : value
    try {
      return format === 'yaml' ? toYaml(v) : toJson(v)
    } catch (e) {
      return `# Could not serialise: ${e instanceof Error ? e.message : String(e)}`
    }
  }, [value, format, showManaged, noisy])
  const lines = useMemo(() => text.split('\n').length - 1, [text])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const monacoRef = useRef<MonacoApi | null>(null)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The first text, for the editor's creation; later changes go through setValue.
  const textRef = useRef(text)
  textRef.current = text
  const formatRef = useRef(format)
  formatRef.current = format

  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((monaco) => {
        if (disposed || !hostRef.current) return
        monacoRef.current = monaco
        editorRef.current = monaco.editor.create(hostRef.current, {
          value: textRef.current,
          language: formatRef.current,
          readOnly: true,
          domReadOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          lineNumbers: 'on',
          folding: true,
          foldingStrategy: 'indentation',
          showFoldingControls: 'always',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'line',
          stickyScroll: { enabled: true },
          wordWrap: 'off',
          fontSize: 12.5,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          tabSize: 2,
          contextmenu: true,
          ariaLabel,
          padding: { top: 8, bottom: 8 },
          theme: consoleMonacoTheme(),
          scrollbar: { alwaysConsumeMouseWheel: false },
        })
        setReady(true)
      })
      .catch((e) => {
        if (!disposed) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      disposed = true
      editorRef.current?.getModel()?.dispose()
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // ariaLabel is set at creation; the editor is never re-created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the console theme (the class on <html>, not the media query).
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const ob = new MutationObserver(() => monacoRef.current?.editor.setTheme(consoleMonacoTheme()))
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => ob.disconnect()
  }, [])

  useEffect(() => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!ed || !model || !monacoRef.current) return
    if (model.getValue() !== text) {
      const top = ed.getScrollTop()
      model.setValue(text)
      ed.setScrollTop(top)
    }
    if (model.getLanguageId() !== format) monacoRef.current.editor.setModelLanguage(model, format)
  }, [text, format, ready])

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrap ? 'on' : 'off' })
  }, [wrap, ready])

  const run = (action: string) => {
    const ed = editorRef.current
    if (!ed) return
    ed.focus()
    void ed.getAction(action)?.run()
  }

  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`Copied ${format.toUpperCase()}`, { description: `${lines} lines` }))
      .catch(() => toast.error('Could not copy to the clipboard'))
  }

  const download = () => {
    try {
      const blob = new Blob([text], { type: format === 'yaml' ? 'application/yaml' : 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}.${format === 'yaml' ? 'yaml' : 'json'}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success('Download started', { description: a.download })
    } catch (e) {
      toast.error('Could not download', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div
      className={cn('overflow-hidden rounded-lg border border-edge-default bg-surface-raised', className)}
      // Escape inside the editor closes Monaco's find widget — it must not
      // also reach the drawer's window-level Escape handler and close it.
      onKeyDown={(e) => {
        if (e.key === 'Escape' && ready && hostRef.current?.contains(e.target as Node)) e.stopPropagation()
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-edge-default px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">{toolbarStart}</div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Segmented<ViewFormat>
            value={format}
            onChange={setFormat}
            options={[
              { value: 'yaml', label: 'YAML' },
              { value: 'json', label: 'JSON' },
            ]}
            ariaLabel="Format"
          />
          {noisy ? (
            <ToggleChip on={showManaged} onClick={() => setShowManaged((v) => !v)} title="Show metadata.managedFields and the last-applied annotation">
              managedFields
            </ToggleChip>
          ) : null}
          <ToggleChip on={wrap} onClick={() => setWrap((v) => !v)} title="Wrap long lines">
            Wrap
          </ToggleChip>
          <IconBtn label="Find (⌘F)" onClick={() => run('actions.find')} disabled={!ready}>
            <path d="M11 4a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" />
          </IconBtn>
          <IconBtn label="Fold all" onClick={() => run('editor.foldAll')} disabled={!ready}>
            <path d="M7 4l5 5 5-5H7zm0 16l5-5 5 5H7zM4 11h16v2H4z" />
          </IconBtn>
          <IconBtn label="Unfold all" onClick={() => run('editor.unfoldAll')} disabled={!ready}>
            <path d="M7 9l5-5 5 5H7zm0 6l5 5 5-5H7zM4 11h16v2H4z" />
          </IconBtn>
          <IconBtn label="Copy" onClick={copy}>
            <path d="M8 3h11a2 2 0 0 1 2 2v11h-2V5H8V3zM5 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v10h10V9H5z" />
          </IconBtn>
          <IconBtn label="Download" onClick={download}>
            <path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3zM4 18h16v2H4z" />
          </IconBtn>
        </div>
      </div>
      <div className="relative" style={{ height }}>
        <div ref={hostRef} className={cn('absolute inset-0', ready ? '' : 'invisible')} aria-label={ariaLabel} />
        {!ready ? (
          <pre className="absolute inset-0 overflow-auto bg-surface-sunken p-3 font-mono text-[12px] leading-5 text-content" aria-label={ariaLabel}>
            {text}
          </pre>
        ) : null}
        {loadError ? (
          <div className="absolute bottom-2 right-3 rounded bg-surface-raised px-2 py-1 text-[11px] text-content-subtle ring-1 ring-edge-default">
            Plain view — the editor did not load ({loadError})
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between border-t border-edge-default px-3 py-1 text-[11px] text-content-subtle">
        <span>
          {lines} lines · {format.toUpperCase()}
          {noisy && !showManaged ? ' · managedFields hidden' : ''}
        </span>
        <span className="hidden sm:inline">Read-only · ⌘F to search</span>
      </div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T
  onChange(v: T): void
  options: Array<{ value: T; label: ReactNode; title?: string }>
  ariaLabel: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-md border border-edge-default bg-surface-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-2 py-0.5 text-xs font-medium transition-colors',
            value === o.value ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ToggleChip({ on, onClick, title, children }: { on: boolean; onClick(): void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        'rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
        on
          ? 'bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-400/30'
          : 'text-content-muted ring-edge-default hover:bg-surface-sunken hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

export function IconBtn({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button variant="ghost" size="xs" onClick={onClick} disabled={disabled} aria-label={label} title={label} className="px-1.5!">
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
        {children}
      </svg>
    </Button>
  )
}
