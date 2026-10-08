import { useEffect, useRef, useState } from 'react'
import { loadMonaco, type MonacoEditorInstance } from './monaco-loader.ts'

/**
 * A manifest, shown as YAML in a real editor.
 *
 * Read-only on purpose. This sits in the provisioning dialog, where the form
 * is the input and this is the artefact — what will be sent, exactly as sent,
 * so it can be read before it is applied and copied into a GitOps repository
 * instead of applied at all.
 *
 * Making it writable would mean parsing YAML back, and this platform has no
 * YAML dependency (see `manifest-yaml.ts`). A hand-rolled parser deciding
 * what infrastructure gets provisioned is a worse trade than a read-only
 * view: a subtle mis-parse there is a wrong database, not a wrong pixel.
 */
/** Monaco ships its own themes; this picks the one matching the console. */
function monacoTheme(): 'vs' | 'vs-dark' {
  if (typeof document === 'undefined') return 'vs'
  return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'
}

export function YamlView({ value, ariaLabel }: { value: string; ariaLabel: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const monacoRef = useRef<Awaited<ReturnType<typeof loadMonaco>> | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Follow the console's theme.
   *
   * Monaco defaults to `vs`, which is white. Left alone it renders a white
   * slab inside a dark dialog — the editor was the brightest thing on the
   * screen and the only part of the console not in the theme the user chose.
   * The class on `<html>` is what the rest of the app switches on, so this
   * watches that rather than the media query, which would miss an explicit
   * override.
   */
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const apply = () => monacoRef.current?.editor.setTheme(monacoTheme())
    const ob = new MutationObserver(apply)
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => ob.disconnect()
  }, [])

  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((m) => {
        if (disposed || !hostRef.current) return
        monacoRef.current = m
        editorRef.current = m.editor.create(hostRef.current, {
          value: '',
          language: 'yaml',
          theme: monacoTheme(),
          readOnly: true,
          // No gutter furniture it cannot use: nothing here folds or breaks.
          minimap: { enabled: false },
          automaticLayout: true,
          fontSize: 12,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          tabSize: 2,
          wordWrap: 'on',
          padding: { top: 10, bottom: 10 },
        })
        setReady(true)
      })
      .catch((e) => setError((e as Error).message))
    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [])

  // The form is the source; every keystroke in it lands here.
  useEffect(() => {
    if (ready && editorRef.current && editorRef.current.getValue() !== value) {
      editorRef.current.setValue(value)
    }
  }, [ready, value])

  if (error) {
    return (
      <pre className="max-h-[46vh] overflow-auto rounded-lg border border-edge-default bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-content">
        {value}
      </pre>
    )
  }

  return (
    <div
      ref={hostRef}
      role="group"
      aria-label={ariaLabel}
      className="h-[46vh] min-h-[220px] overflow-hidden rounded-lg border border-edge-default"
    />
  )
}
