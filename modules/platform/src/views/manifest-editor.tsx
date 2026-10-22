import { useEffect, useRef, useState } from 'react'
import { Button, canResource, Spinner, useAccessReview, useToast } from '@adhar/shell-ui'
import { kube } from '@adhar/api-clients/k8s'
import type { GatewayGVR as GVR, KubeObject } from '@adhar/api-clients/k8s'
import { loadMonaco, type MonacoEditorInstance } from '../components/monaco-loader.ts'

interface Props {
  gvr: GVR
  namespace?: string
  name: string
  onClose?(): void
}

/**
 * Live manifest editor. Loads the object via `kube.get`, strips
 * `metadata.managedFields`, and edits the pretty-printed JSON in Monaco.
 * JSON (not YAML) keeps us dependency-free and apiserver-compatible — a YAML
 * mode can layer on later. Dry-run / Apply go through server-side apply —
 * a PATCH, so both are shown only when RBAC allows `patch` on the object
 * (hidden while that is being asked); the editor stays read-only otherwise.
 */
export function ManifestEditor({ gvr, namespace, name, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const [ready, setReady] = useState(false)
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const toast = useToast()
  const [busy, setBusy] = useState<'dry' | 'apply' | null>(null)

  const access = useAccessReview(canResource(gvr, 'patch', { namespace, name }))
  const canApply = access.allowed
  const readOnly = !canApply
  // Say "read-only" only once RBAC has definitely said no — not while asking.
  const denied = !access.loading && !access.unknown && access.results[0] === false

  // Fetch the object and stash the pretty-printed manifest.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
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
      toast.error('Invalid JSON', { description: (e as Error).message })
      return null
    }
  }

  async function onDryRun() {
    const manifest = parseCurrent()
    if (!manifest) return
    setBusy('dry')
    try {
      await kube.apply(manifest, { dryRun: true })
      toast.success('Dry-run passed', { description: 'The apiserver accepted the manifest.' })
    } catch (e) {
      toast.error('Dry-run failed', { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  async function onApply() {
    const manifest = parseCurrent()
    if (!manifest) return
    setBusy('apply')
    try {
      const applied = await kube.apply<KubeObject>(manifest, { force: true })
      const pretty = prettyManifest(applied)
      setOriginal(pretty)
      editorRef.current?.setValue(pretty)
      toast.success(`${name} applied`)
    } catch (e) {
      toast.error(`Couldn't apply ${name}`, { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  function onReset() {
    editorRef.current?.setValue(original)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge-default px-3 py-2">
        <div className="mr-2 flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-sm font-semibold text-content">Manifest (JSON)</span>
          <code className="min-w-0 truncate font-mono text-[11px] text-content-muted" title={`${gvr.group ? `${gvr.group}/` : ''}${gvr.version}/${gvr.resource}${namespace ? ` · ${namespace}` : ''} / ${name}`}>
            {gvr.group ? `${gvr.group}/` : ''}
            {gvr.version}/{gvr.resource}
            {namespace ? ` · ${namespace}` : ''} / {name}
          </code>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {denied ? (
            <span
              className="rounded-md bg-surface-sunken px-2 py-1 text-[11px] font-medium text-content-subtle"
              title={`Your RBAC doesn't allow patch ${gvr.resource}${namespace ? ` in ${namespace}` : ''}`}
            >
              Read only
            </span>
          ) : null}
          {canApply ? (
            <>
              <Button size="xs" variant="secondary" onClick={onDryRun} loading={busy === 'dry'} disabled={!ready || loading}>
                Dry-run
              </Button>
              <Button
                size="xs"
                variant="primary"
                onClick={onApply}
                loading={busy === 'apply'}
                disabled={!ready || loading}
              >
                Apply
              </Button>
              <Button size="xs" variant="ghost" onClick={onReset} disabled={!ready || loading}>
                Reset
              </Button>
            </>
          ) : null}
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
