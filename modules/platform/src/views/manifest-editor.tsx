import { useEffect, useRef, useState } from 'react'
import { Button, Spinner } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { kube } from '@adhar-console/api-clients/k8s'
import type { GatewayGVR as GVR, KubeObject } from '@adhar-console/api-clients/k8s'
import { useAccess } from '../data/live.ts'
import { loadMonaco, type MonacoEditorInstance } from '../components/monaco-loader.ts'

interface Props {
  gvr: GVR
  namespace?: string
  name: string
  onClose?(): void
}

type Note = { tone: 'ok' | 'error'; text: string } | null

/**
 * Live manifest editor. Loads the object via `kube.get`, strips
 * `metadata.managedFields`, and edits the pretty-printed JSON in Monaco.
 * JSON (not YAML) keeps us dependency-free and apiserver-compatible — a YAML
 * mode can layer on later. Dry-run / Apply go through server-side apply.
 */
export function ManifestEditor({ gvr, namespace, name, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const [ready, setReady] = useState(false)
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState<'dry' | 'apply' | null>(null)

  const canUpdate = useAccess({ verb: 'update', group: gvr.group, resource: gvr.resource, namespace, name })
  const readOnly = canUpdate.data === false

  // Fetch the object and stash the pretty-printed manifest.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setNote(null)
    kube
      .get<KubeObject>(gvr, namespace, name)
      .then((obj) => {
        if (cancelled) return
        setOriginal(prettyManifest(obj))
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setLoadError((e as Error).message)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gvr.group, gvr.version, gvr.resource, namespace, name])

  // Mount Monaco once.
  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((m) => {
        if (disposed || !hostRef.current) return
        editorRef.current = m.editor.create(hostRef.current, {
          value: '',
          language: 'json',
          minimap: { enabled: false },
          automaticLayout: true,
          fontSize: 12,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          tabSize: 2,
          readOnly,
        })
        setReady(true)
      })
      .catch((e) => setLoadError((e as Error).message))
    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push the loaded manifest into the editor once both are ready (also drives Reset).
  useEffect(() => {
    if (ready && editorRef.current) editorRef.current.setValue(original)
  }, [ready, original])

  // Reflect access changes onto the editor.
  useEffect(() => {
    if (ready) editorRef.current?.updateOptions({ readOnly })
  }, [ready, readOnly])

  function parseCurrent(): KubeObject | null {
    const text = editorRef.current?.getValue() ?? ''
    try {
      return JSON.parse(text) as KubeObject
    } catch (e) {
      setNote({ tone: 'error', text: `Invalid JSON — ${(e as Error).message}` })
      return null
    }
  }

  async function onDryRun() {
    const manifest = parseCurrent()
    if (!manifest) return
    setBusy('dry')
    setNote(null)
    try {
      await kube.apply(manifest, { dryRun: true })
      setNote({ tone: 'ok', text: '✓ valid' })
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  async function onApply() {
    const manifest = parseCurrent()
    if (!manifest) return
    setBusy('apply')
    setNote(null)
    try {
      const applied = await kube.apply<KubeObject>(manifest, { force: true })
      const pretty = prettyManifest(applied)
      setOriginal(pretty)
      editorRef.current?.setValue(pretty)
      setNote({ tone: 'ok', text: '✓ applied' })
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  function onReset() {
    editorRef.current?.setValue(original)
    setNote(null)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge-default px-3 py-2">
        <div className="mr-2 flex min-w-0 items-baseline gap-2">
          <span className="text-sm font-semibold text-content">Manifest (JSON)</span>
          <code className="truncate font-mono text-[11px] text-content-muted">
            {gvr.group ? `${gvr.group}/` : ''}
            {gvr.version}/{gvr.resource}
            {namespace ? ` · ${namespace}` : ''} / {name}
          </code>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {note ? (
            <span
              className={cn(
                'max-w-[22rem] truncate rounded-md px-2 py-1 text-[11px] font-medium',
                note.tone === 'ok'
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25'
                  : 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/25',
              )}
              title={note.text}
            >
              {note.text}
            </span>
          ) : null}
          {readOnly ? (
            <span className="rounded-md bg-surface-sunken px-2 py-1 text-[11px] font-medium text-content-subtle">
              read-only — no update access
            </span>
          ) : null}
          <Button size="xs" variant="secondary" onClick={onDryRun} loading={busy === 'dry'} disabled={!ready || loading}>
            Dry-run
          </Button>
          <Button
            size="xs"
            variant="primary"
            onClick={onApply}
            loading={busy === 'apply'}
            disabled={!ready || loading || readOnly}
          >
            Apply
          </Button>
          <Button size="xs" variant="ghost" onClick={onReset} disabled={!ready || loading}>
            Reset
          </Button>
          {onClose ? (
            <Button size="xs" variant="ghost" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </div>
      </div>

      <div className="relative">
        {loadError ? (
          <div className="px-4 py-6 text-sm text-rose-700 dark:text-rose-300">Couldn't load manifest — {loadError}</div>
        ) : (
          <>
            {loading || !ready ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface-raised/70 text-sm text-content-muted">
                <Spinner size={16} /> Loading editor…
              </div>
            ) : null}
            <div ref={hostRef} className="h-[420px] w-full" />
          </>
        )}
      </div>
    </div>
  )
}

/** Pretty-printed manifest with `metadata.managedFields` removed. */
function prettyManifest(obj: KubeObject): string {
  const clone = JSON.parse(JSON.stringify(obj)) as KubeObject & {
    metadata?: { managedFields?: unknown }
  }
  if (clone.metadata && 'managedFields' in clone.metadata) delete clone.metadata.managedFields
  return JSON.stringify(clone, null, 2)
}

export default ManifestEditor
