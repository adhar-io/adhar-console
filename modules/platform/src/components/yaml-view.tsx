import { useEffect, useRef, useState } from 'react'
import { loadMonaco, type MonacoEditorInstance } from './monaco-loader.ts'

/**
 * A manifest, shown as YAML in a real editor — and, when `onChange` is given,
 * edited there.
 *
 * This was read-only, on the argument that writing meant parsing YAML back and
 * "a subtle mis-parse there is a wrong database, not a wrong pixel". That
 * argument was right and is now answered rather than ignored:
 *
 *   • The reader is `tryParseYaml` from `@adhar/utils` — the same one
 *     that reads the platform's own template documents, not a second parser
 *     written for this dialog.
 *   • `manifest-roundtrip_test.ts` holds the property the trade depends on:
 *     for everything `toYaml` can emit, parsing it back yields the object it
 *     started from — including the scalars that quietly change type in YAML
 *     1.1 (`on`, `no`, `1.10`, `1:30`).
 *   • A document that cannot be read stops the apply and says which line is
 *     wrong, instead of arriving at the cluster as `null`.
 *   • A server-side dry run still validates against the real apiserver. That
 *     is the second line of defence, not the first.
 */
/** Monaco ships its own themes; this picks the one matching the console. */
function monacoTheme(): 'vs' | 'vs-dark' {
  if (typeof document === 'undefined') return 'vs'
  return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'
}

export function YamlView({
  value,
  ariaLabel,
  onChange,
}: {
  value: string
  ariaLabel: string
  /** Omit for a read-only view; supply it to let the manifest be edited. */
  onChange?(next: string): void
}) {
  // Monaco's listener is attached once, so it must not close over a stale
  // callback — the dialog re-renders on every keystroke it reports.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  /**
   * True while WE are writing into the editor.
   *
   * `onDidChangeModelContent` does not distinguish a keystroke from a
   * programmatic `setValue`, so pushing the form's preview in fired the same
   * event a user edit does. The dialog read that as "the human took over" and
   * detached the YAML the instant the pane was opened — before anything had
   * been typed. This marks our own writes so they are not reported back.
   */
  const writingRef = useRef(false)
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
          readOnly: !onChange,
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
        editorRef.current.onDidChangeModelContent(() => {
          if (writingRef.current) return
          const cb = onChangeRef.current
          if (cb && editorRef.current) cb(editorRef.current.getValue())
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

  /**
   * Push the parent's value in only when it actually differs.
   *
   * While the form drives, every keystroke there lands here. While the YAML
   * drives, the parent echoes back exactly what `onChange` reported, so this
   * compares equal and does nothing — which is what keeps `setValue` from
   * firing mid-edit and throwing the cursor to the top of the document.
   */
  useEffect(() => {
    if (ready && editorRef.current && editorRef.current.getValue() !== value) {
      writingRef.current = true
      try {
        editorRef.current.setValue(value)
      } finally {
        writingRef.current = false
      }
    }
  }, [ready, value])

  /*
   * Monaco failed to load — offline, or the chunk 404'd. A read-only view can
   * fall back to a `<pre>`, but an EDITABLE one must still be editable, or the
   * pane silently loses the ability the dialog is offering.
   */
  if (error) {
    return onChange ? (
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-[46vh] min-h-[220px] w-full resize-none overflow-auto rounded-lg border border-edge-default bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-content outline-none focus:border-brand-400"
      />
    ) : (
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
