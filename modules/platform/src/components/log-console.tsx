import { useCallback, useEffect, useState } from 'react'
import { kube } from '@adhar-console/api-clients/k8s'
import { detectSeverity, type LogLine, type StreamStatus } from '@adhar-console/shell-ui'

/**
 * Kubernetes log transport for `LogConsole`.
 *
 * The surface itself lives in `packages/shell-ui/src/log-console.tsx` — this
 * module is only the part that knows about pods, containers and the apiserver,
 * so a module with a different log source (Coder provisioner logs, say) can
 * render the same console without dragging the Kubernetes client in with it.
 */

/* ────────────────────────────── transport ────────────────────────────── */

export interface LogSource {
  pod: string
  container?: string
  /** Shown in the gutter when more than one source is merged. */
  label: string
}

export interface UseLogStreamOptions {
  namespace?: string
  sources: LogSource[]
  cluster?: string
  /** Hold the connection open and append. False = one-shot tail. */
  follow?: boolean
  tailLines?: number
  previous?: boolean
  sinceSeconds?: number
  /** Cap on retained lines; the oldest are dropped past this. */
  maxLines?: number
  enabled?: boolean
}

export interface LogStream {
  lines: LogLine[]
  status: StreamStatus
  error?: string
  /** Present while a source is between connections. */
  reconnect?: { attempt: number; message?: string }
  clear(): void
  reload(): void
}

const MAX_LINES_DEFAULT = 20_000

/** `2024-05-01T10:00:00.123456789Z rest of the line` → its two halves. */
function splitTimestamp(line: string): { ts?: string; text: string } {
  const sp = line.indexOf(' ')
  if (sp <= 0) return { text: line }
  const head = line.slice(0, sp)
  // Cheap shape test before the expensive parse: RFC3339 always has these.
  if (head.length < 20 || head[4] !== '-' || head[10] !== 'T') return { text: line }
  if (Number.isNaN(Date.parse(head))) return { text: line }
  return { ts: head, text: line.slice(sp + 1) }
}

/**
 * Stream container logs, and keep streaming them.
 *
 * The reconnect behaviour is the whole point of this hook, so it is worth
 * spelling out what it fixes:
 *
 *  1. **Per-source connections.** Sources are streamed independently. The old
 *     Logs page wrapped every source in one `Promise.all`, so a single pod
 *     ending its stream tore down and restarted *all* of them.
 *
 *  2. **Generation guards.** Each connection attempt captures its own
 *     `AbortController` and generation number. Previously the settle handlers
 *     closed over a mutable `ac` that had already been reassigned, so a stale
 *     promise could schedule another reconnect — and two loops would then run
 *     in parallel, each scheduling more.
 *
 *  3. **Resume, don't re-tail.** A reconnect asks for `sinceTime` at the last
 *     line seen instead of `tailLines` again, so the pane does not fill with
 *     duplicates of what it already shows. `sinceTime` is inclusive, so the
 *     boundary line is dropped explicitly.
 *
 *  4. **Backoff that recovers.** `attempt` resets once a connection actually
 *     delivers, instead of ratcheting to the 15s ceiling and staying there for
 *     the life of the page.
 *
 * Timestamps are always requested upstream, whether or not the caller displays
 * them, because they are what makes (3) possible.
 */
export function useLogStream(opts: UseLogStreamOptions): LogStream {
  const {
    namespace,
    sources,
    cluster,
    follow = true,
    tailLines = 1000,
    previous,
    sinceSeconds,
    maxLines = MAX_LINES_DEFAULT,
    enabled = true,
  } = opts

  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState<string | undefined>()
  const [reconnect, setReconnect] = useState<{ attempt: number; message?: string } | undefined>()
  const [nonce, setNonce] = useState(0)

  // Identity of the source set, so the effect re-runs when it really changes
  // rather than on every render that rebuilds the array.
  const sourceKey = sources.map((s) => `${s.pod}/${s.container ?? ''}`).join('|')

  const clear = useCallback(() => {
    setLines([])
    setError(undefined)
  }, [])
  const reload = useCallback(() => {
    setLines([])
    setError(undefined)
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!enabled || !namespace || sources.length === 0) {
      setStatus('idle')
      return
    }

    let disposed = false
    const controllers = new Set<AbortController>()
    const timers = new Set<number>()
    const multi = sources.length > 1
    let delivered = false

    // Per-source continuation state.
    const lastTs = new Map<string, string>()
    const lastText = new Map<string, string>()
    const pending = new Map<string, string>()

    const key = (s: LogSource) => `${s.pod}/${s.container ?? ''}`

    const push = (s: LogSource, raw: string) => {
      const k = key(s)
      const combined = (pending.get(k) ?? '') + raw
      const parts = combined.split('\n')
      pending.set(k, parts.pop() ?? '')
      if (!parts.length) return

      const add: LogLine[] = []
      for (const part of parts) {
        if (!part) continue
        const { ts, text } = splitTimestamp(part)
        // `sinceTime` is inclusive: the first line after a resume is usually the
        // last line we already have. Drop that exact repeat, nothing else.
        if (ts && ts === lastTs.get(k) && text === lastText.get(k)) continue
        if (ts) lastTs.set(k, ts)
        lastText.set(k, text)
        add.push({ ts, text, source: multi ? s.label : undefined, severity: detectSeverity(text) })
      }
      if (!add.length) return

      delivered = true
      setStatus('streaming')
      setReconnect(undefined)
      setLines((prev) => {
        const next = prev.concat(add)
        return next.length > maxLines ? next.slice(next.length - maxLines) : next
      })
    }

    /** Terminal failures — retrying cannot help, so stop and say why. */
    const terminal = (e: unknown): StreamStatus | null => {
      const s = e as { status?: number; reason?: string }
      if (s?.status === 403 || s?.reason === 'Forbidden') return 'forbidden'
      if (s?.status === 404 || s?.reason === 'NotFound') return 'notfound'
      return null
    }

    const connect = (s: LogSource, attempt: number) => {
      if (disposed) return
      const k = key(s)
      const ac = new AbortController()
      controllers.add(ac)
      // This attempt's own signal — never read a shared, reassigned controller.
      const mine = ac.signal
      const resumeFrom = lastTs.get(k)

      kube
        .logStream(
          namespace,
          s.pod,
          {
            container: s.container,
            follow,
            // On a resume, sinceTime replaces tailLines (the client drops it).
            tailLines: resumeFrom ? undefined : tailLines,
            sinceTime: resumeFrom,
            sinceSeconds: resumeFrom ? undefined : sinceSeconds,
            previous,
            timestamps: true,
            cluster,
            signal: mine,
          },
          (chunk) => {
            if (disposed || mine.aborted) return
            push(s, chunk)
          },
        )
        .then((full) => {
          if (disposed || mine.aborted) return
          // A non-follow read resolves with the whole body when no chunks came.
          if (!follow) {
            if (full && !delivered) push(s, full.endsWith('\n') ? full : `${full}\n`)
            const tail = pending.get(k)
            if (tail) {
              push(s, '\n')
              pending.set(k, '')
            }
            setStatus((st) => (st === 'streaming' ? 'paused' : delivered ? 'paused' : 'empty'))
            return
          }
          // A follow stream resolving means the server closed it — the pod
          // ended, or the log rotated. Reconnect; the pod may come back.
          schedule(s, attempt, undefined)
        })
        .catch((e) => {
          if (disposed || mine.aborted) return
          const t = terminal(e)
          if (t) {
            setError(e instanceof Error ? e.message : String(e))
            setStatus(t)
            return
          }
          if (!follow) {
            setError(e instanceof Error ? e.message : String(e))
            setStatus('error')
            return
          }
          schedule(s, attempt, e)
        })
        .finally(() => controllers.delete(ac))
    }

    const schedule = (s: LogSource, attempt: number, err: unknown) => {
      if (disposed) return
      // A connection that delivered anything is proof the source is healthy, so
      // the next drop starts from a short delay rather than the last ceiling.
      const next = delivered ? 1 : attempt + 1
      delivered = false
      setReconnect({ attempt: next, message: err instanceof Error ? err.message : undefined })
      setStatus((st) => (st === 'forbidden' || st === 'notfound' ? st : 'reconnecting'))
      const delay = Math.min(15_000, 500 * 2 ** Math.min(next - 1, 5))
      const t = globalThis.setTimeout(() => {
        timers.delete(t)
        connect(s, next)
      }, delay) as unknown as number
      timers.add(t)
    }

    setStatus('connecting')
    setError(undefined)
    setReconnect(undefined)
    for (const s of sources) connect(s, 0)

    return () => {
      disposed = true
      for (const t of timers) clearTimeout(t)
      for (const c of controllers) c.abort()
    }
    // `sourceKey` stands in for `sources`; every other value is read directly.
  }, [
    namespace,
    sourceKey,
    cluster,
    follow,
    tailLines,
    previous,
    sinceSeconds,
    maxLines,
    enabled,
    nonce,
  ])

  const resolved: StreamStatus = status === 'streaming' && lines.length === 0 ? 'empty' : status

  return { lines, status: resolved, error, reconnect, clear, reload }
}

/* The surface lives in shell-ui so modules other than `platform` can render it
   (the cloud-environment build log does). Re-exported here so platform call
   sites can keep importing the console and its transport from one place. */
export { ConsoleBtn, LogConsole } from '@adhar-console/shell-ui'
export type { LogConsoleProps, LogLine, StreamStatus } from '@adhar-console/shell-ui'
