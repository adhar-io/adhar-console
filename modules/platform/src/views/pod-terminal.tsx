import { useEffect, useRef, useState } from 'react'
import { execPod, type PodExecSession } from '@adhar-console/api-clients/k8s'
import { Button } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { loadXterm } from '../components/xterm-loader.ts'

/**
 * Interactive pod exec terminal backed by xterm.js.
 *
 * xterm is pulled from a CDN at runtime (see `xterm-loader.ts`), then wired to
 * the `execPod` WebSocket session: keystrokes flow `term -> session.write`,
 * container output flows `session.onData -> term.write`, and terminal resizes
 * are relayed to the remote TTY via `session.resize`.
 */

type Status = 'connecting' | 'connected' | 'disconnected' | 'error'

export function PodTerminal({
  namespace,
  pod,
  container,
}: {
  namespace: string
  pod: string
  container?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  // Bumped by the Reconnect button to re-run the connect effect.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let disposed = false
    let term: any = null
    let session: PodExecSession | null = null
    let resizeObserver: ResizeObserver | null = null
    let onWinResize: (() => void) | null = null

    setStatus('connecting')
    setError(null)

    const doFit = (fit: any) => {
      try {
        fit.fit()
        if (session && term) session.resize(term.cols, term.rows)
      } catch {
        /* terminal not measurable yet */
      }
    }

    ;(async () => {
      let api: { Terminal: any; FitAddon: any }
      try {
        api = await loadXterm()
      } catch (e) {
        if (disposed) return
        setStatus('error')
        setError(
          `Could not load the terminal runtime from the CDN. xterm.js is fetched from jsDelivr at runtime — check your network connection or content-security-policy. (${
            e instanceof Error ? e.message : String(e)
          })`,
        )
        return
      }
      if (disposed || !hostRef.current) return

      const { Terminal, FitAddon } = api
      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        theme: {
          background: '#0f172a',
          foreground: '#e2e8f0',
          cursor: '#e2e8f0',
        },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(hostRef.current)
      doFit(fit)

      session = execPod({
        namespace,
        pod,
        container,
        tty: true,
      })

      term.onData((data: string) => session?.write(data))
      session.onData((text) => term?.write(text))

      const socket = session.socket
      const markOpen = () => {
        if (disposed) return
        setStatus('connected')
        // Push the current geometry once the channel is live.
        doFit(fit)
      }
      if (socket.readyState === WebSocket.OPEN) markOpen()
      else socket.addEventListener('open', markOpen)

      session.onClose(({ code, reason }) => {
        if (disposed) return
        setStatus('disconnected')
        term?.write(`\r\n\x1b[90m* session closed (code ${code}${reason ? `, ${reason}` : ''})\x1b[0m\r\n`)
      })
      session.onError(() => {
        if (disposed) return
        setStatus('error')
        setError('WebSocket error — the exec channel could not be established or was interrupted.')
      })

      // Keep the remote TTY sized to the on-screen terminal.
      resizeObserver = new ResizeObserver(() => doFit(fit))
      resizeObserver.observe(hostRef.current)
      onWinResize = () => doFit(fit)
      globalThis.addEventListener('resize', onWinResize)

      term.focus()
    })()

    return () => {
      disposed = true
      if (onWinResize) globalThis.removeEventListener('resize', onWinResize)
      resizeObserver?.disconnect()
      session?.close()
      term?.dispose()
    }
  }, [namespace, pod, container, attempt])

  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-slate-900 shadow-inner">
      <div className="flex items-center justify-between gap-2 border-b border-edge-default bg-slate-900/80 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-block h-2 w-2 rounded-full',
              status === 'connected'
                ? 'bg-emerald-400'
                : status === 'connecting'
                  ? 'animate-pulse bg-amber-400'
                  : status === 'error'
                    ? 'bg-rose-500'
                    : 'bg-slate-500',
            )}
          />
          <span className="font-mono text-[11px] uppercase tracking-wide text-content-muted">
            {status}
          </span>
          <span className="text-[11px] text-content-muted">
            · {pod}
            {container ? ` / ${container}` : ''}
          </span>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
          Reconnect
        </Button>
      </div>

      {error ? (
        <div className="border-b border-rose-900/60 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-200">
          {error}
        </div>
      ) : null}

      <div ref={hostRef} className="h-[50vh] w-full bg-slate-900 px-2 py-2" />
    </div>
  )
}
