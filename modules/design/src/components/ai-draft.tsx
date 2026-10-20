import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@adhar/shell-ui'
import { type AiContextEntry, askAdharAi, draftPrompt, type DraftKind, extractFenced, useAiConfigured } from '../data/ai.ts'

/**
 * "Ask Adhar AI" — draft or improve a design artifact with the console's own
 * agent endpoint. The reply streams into a preview; nothing is written until
 * the user applies it. When AI is not configured on the cluster the dialog
 * says so (and how it gets configured) instead of offering a dead button.
 */

const INPUT =
  'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

export function SparkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4L12 2z" />
    </svg>
  )
}

export function AskAiModal({
  open,
  onClose,
  kind,
  title,
  description,
  placeholder,
  initialRequest = '',
  context = [],
  fence,
  applyLabel = 'Apply',
  onApply,
  renderPreview,
}: {
  open: boolean
  onClose(): void
  kind: DraftKind
  title: string
  description?: string
  placeholder?: string
  initialRequest?: string
  /** Grounding passed as AG-UI context (platform facts, the current document). */
  context?: AiContextEntry[]
  /** Fence language(s) to extract from the reply. */
  fence: string | string[]
  applyLabel?: string
  onApply(text: string): void
  /** Optional rich preview of the extracted text. */
  renderPreview?(text: string): React.ReactNode
}) {
  const configured = useAiConfigured()
  const [request, setRequest] = useState(initialRequest)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setRequest(initialRequest)
      setReply('')
      setError(null)
    } else {
      abort.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const run = async () => {
    if (!request.trim()) return
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setBusy(true)
    setError(null)
    setReply('')
    try {
      const text = await askAdharAi({ prompt: draftPrompt(kind, request), context, signal: ctrl.signal, onDelta: setReply })
      setReply(text)
      if (!text.trim()) setError('Adhar AI returned an empty reply.')
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const extracted = reply ? extractFenced(reply, fence) : ''

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      branded
      width="xl"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          {configured
            ? (
              <>
                <Button size="sm" onClick={run} loading={busy} disabled={busy || !request.trim()} leading={busy ? undefined : <SparkIcon />}>
                  {reply ? 'Regenerate' : 'Generate'}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !extracted.trim()}
                  onClick={() => {
                    onApply(extracted)
                    onClose()
                  }}
                >
                  {applyLabel}
                </Button>
              </>
            )
            : null}
        </>
      }
    >
      {configured === false
        ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <div className="font-semibold">Adhar AI is not configured on this cluster</div>
            <p className="mt-1">
              <code className="font-mono">/api/ai/config</code> reports no model. A platform admin configures one on the console deployment
              (<code className="font-mono">AI_BASE_URL</code> / <code className="font-mono">AI_MODEL</code>); until then, write it by hand — everything else on this page works without AI.
            </p>
          </div>
        )
        : (
          <div className="space-y-3">
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">What should Adhar AI write?</span>
              <textarea
                autoFocus
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void run()}
                rows={3}
                placeholder={placeholder}
                className={`mt-1.5 resize-y ${INPUT}`}
              />
            </label>
            {context.length
              ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-content-subtle">
                  <span>Grounded in:</span>
                  {context.map((c) => (
                    <span key={c.description} className="rounded-full bg-surface-sunken px-2 py-0.5 text-content-muted">{c.description}</span>
                  ))}
                </div>
              )
              : null}
            {error
              ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">{error}</div>
              : null}
            {reply
              ? (
                <div className="space-y-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">{busy ? 'Writing…' : 'Draft'}</span>
                  {renderPreview && !busy && extracted.trim()
                    ? renderPreview(extracted)
                    : (
                      <pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap rounded-lg border border-edge-default bg-surface-sunken/60 p-3 font-mono text-[11.5px] leading-relaxed text-content">
                        {extracted || reply}
                      </pre>
                    )}
                </div>
              )
              : configured === null
              ? <div className="text-[12px] text-content-subtle">Checking Adhar AI…</div>
              : null}
          </div>
        )}
    </Modal>
  )
}
