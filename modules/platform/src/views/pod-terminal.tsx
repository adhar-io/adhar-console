import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { execPod, type PodExecSession } from '@adhar-console/api-clients/k8s'
import { Button, getResolvedMode, StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { loadXterm } from '../components/xterm-loader.ts'

/**
 * Interactive pod-exec terminal backed by xterm.js — a professional, Kubernetes
 * grade in-browser terminal.
 *
 * xterm and its addon suite are bundled and loaded lazily (see
 * `xterm-loader.ts`), then wired to the `execPod` WebSocket session: keystrokes
 * flow `term -> session.write`, container output flows `session.onData ->
 * term.write`, and terminal resizes are relayed to the remote TTY via
 * `session.resize`.
 *
 * On top of the raw wiring it adds: a theme-aware color scheme (tracks the
 * console's light/dark mode live), an icon-only toolbar (search / copy / paste /
 * clear / font-size / download / fullscreen / reconnect), the full addon suite
 * (search, web-links, clipboard, unicode11, webgl with graceful degradation),
 * robust resize (ResizeObserver + window resize) and an auto-reconnect
 * affordance when the channel drops.
 *
 * The chrome is deliberately minimal: a terminal is the content, not a panel
 * beside it, so every row of toolbar is a row the shell does not get. The
 * toolbar is therefore ONE fixed-height row that never wraps (labels became
 * icons with `title`/`aria-label`), and in `fill` mode it drops the status
 * badge and target — a workbench already shows both in its own status bar, so
 * repeating them here only steals width from the actions.
 */

export type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
type Status = TerminalStatus

/** Imperative handle so a workbench can drive a terminal (broadcast, snippets, focus). */
export interface PodTerminalHandle {
  /** Write raw text to the remote TTY (include `\n` to execute). */
  write(text: string): void
  focus(): void
  clear(): void
  fit(): void
  reconnect(): void
  status(): TerminalStatus
  geometry(): { cols: number; rows: number } | null
}

/** A one-click action rendered in the toolbar; `send` is written to the TTY. */
export interface TerminalAction {
  label: string
  /** Raw text sent to the shell (include a trailing `\n` to execute). */
  send: string
  title?: string
}

/* ── Terminal color themes (raw hex is allowed here — this is the xterm theme) ── */

const DARK_THEME = {
  background: '#0f172a',
  foreground: '#e2e8f0',
  cursor: '#e2e8f0',
  cursorAccent: '#0f172a',
  selectionBackground: '#33415580',
  black: '#1e293b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#475569',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
}

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1e293b',
  cursor: '#1e293b',
  cursorAccent: '#ffffff',
  selectionBackground: '#94a3b855',
  black: '#1e293b',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#f1f5f9',
}

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const MIN_FONT = 10
const MAX_FONT = 22

const STATUS_KIND: Record<Status, StatusKind> = {
  connecting: 'progressing',
  connected: 'healthy',
  disconnected: 'unknown',
  error: 'failed',
}

/** One-cell state indicator for `fill` mode, where a full badge is too wide. */
const STATUS_DOT: Record<Status, string> = {
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-500',
  disconnected: 'bg-slate-400',
  error: 'bg-rose-500',
}

export interface PodTerminalProps {
  namespace: string
  pod: string
  container?: string
  /** Optional exec command (e.g. `['/bin/bash']`). Passed through to `execPod`. */
  command?: string[]
  /** Optional one-click toolbar actions (e.g. "Launch k9s"). */
  actions?: TerminalAction[]
  /** Gateway cluster name (undefined = default cluster). */
  cluster?: string
  /** Fill the parent's height instead of a fixed 50vh surface. */
  fill?: boolean
  /** Starting font size (the toolbar can still change it). */
  defaultFontSize?: number
  /** Called whenever the connection status changes. */
  onStatus?(status: TerminalStatus): void
  /**
   * Keep the terminal dark regardless of the console's light/dark mode.
   *
   * A terminal is conventionally dark, and the Cloud Shell is a terminal the user
   * sits in rather than a panel they glance at: following a light console theme
   * put dark-background ANSI output — which almost every CLI here emits (k9s,
   * coloured kubectl, helm) — on a pale surface, where bright-on-white is
   * unreadable. Panels that are genuinely part of the page leave this off and keep
   * tracking the app theme.
   */
  alwaysDark?: boolean
}

export const PodTerminal = forwardRef<PodTerminalHandle, PodTerminalProps>(function PodTerminal(
  {
    namespace,
    pod,
    container,
    command,
    actions,
    cluster,
    fill = false,
    defaultFontSize = 13,
    onStatus,
    alwaysDark = false,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Live handles kept in refs so toolbar handlers can reach them without
  // re-running the (heavy) connect effect.
  const termRef = useRef<any>(null)
  const fitRef = useRef<any>(null)
  const searchRef = useRef<any>(null)
  const sessionRef = useRef<PodExecSession | null>(null)

  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [renderer, setRenderer] = useState<'webgl' | 'dom'>('dom')
  // Bumped by Reconnect to re-run the connect effect.
  const [attempt, setAttempt] = useState(0)
  const [fontSize, setFontSize] = useState(defaultFontSize)
  const [fullscreen, setFullscreen] = useState(false)
  const [resolvedMode, setResolvedMode] = useState<'light' | 'dark'>(() => getResolvedMode())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')

  const statusRef = useRef<Status>('connecting')
  statusRef.current = status
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  useEffect(() => {
    onStatusRef.current?.(status)
  }, [status])

  // Keep `command` accessible in the effect without making the array identity a
  // dependency (a fresh array each render would reconnect on every render).
  // The key joins on NUL (written as an escape so this file stays plain text —
  // a raw NUL byte here made git treat the whole file as binary and undiffable):
  // it is the one byte that cannot occur inside an argv entry, so no two
  // distinct commands can collide on the same key.
  const commandRef = useRef(command)
  commandRef.current = command
  const commandKey = useMemo(() => (command ? command.join('\u0000') : ''), [command])

  /** Fit the terminal to its host and relay the new geometry to the TTY. */
  const refit = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    const session = sessionRef.current
    try {
      fit?.fit()
      if (term && session) session.resize(term.cols, term.rows)
    } catch {
      /* not measurable yet */
    }
  }, [])

  /* ── connect + wire the terminal ── */
  useEffect(() => {
    let disposed = false
    let term: any = null
    let session: PodExecSession | null = null
    let resizeObserver: ResizeObserver | null = null
    let onWinResize: (() => void) | null = null

    setStatus('connecting')
    setError(null)

    ;(async () => {
      let api: Awaited<ReturnType<typeof loadXterm>>
      try {
        api = await loadXterm()
      } catch (e) {
        if (disposed) return
        setStatus('error')
        setError(
          `Could not load the terminal runtime. The console's terminal chunk failed to load — reload the page; if it persists after a fresh deploy, check the browser console. (${
            e instanceof Error ? e.message : String(e)
          })`,
        )
        return
      }
      if (disposed || !hostRef.current) return

      const { Terminal, FitAddon } = api
      const mode = getResolvedMode()
      term = new Terminal({
        cursorBlink: true,
        fontFamily: FONT_FAMILY,
        fontSize,
        scrollback: 5000,
        allowProposedApi: true,
        macOptionIsMeta: true,
        theme: alwaysDark || mode === 'dark' ? DARK_THEME : LIGHT_THEME,
      })
      termRef.current = term

      const fit = new FitAddon()
      term.loadAddon(fit)
      fitRef.current = fit

      // Optional addons — each guarded so a missing/failed one never crashes.
      if (api.SearchAddon) {
        try {
          const search = new api.SearchAddon()
          term.loadAddon(search)
          searchRef.current = search
        } catch {
          searchRef.current = null
        }
      }
      if (api.WebLinksAddon) {
        try {
          term.loadAddon(new api.WebLinksAddon())
        } catch {
          /* links are cosmetic */
        }
      }
      if (api.ClipboardAddon) {
        try {
          term.loadAddon(new api.ClipboardAddon())
        } catch {
          /* OSC-52 clipboard is best-effort */
        }
      }
      if (api.Unicode11Addon) {
        try {
          term.loadAddon(new api.Unicode11Addon())
          term.unicode.activeVersion = '11'
        } catch {
          /* fall back to built-in width tables */
        }
      }

      term.open(hostRef.current)

      // WebGL renderer with graceful degradation to the built-in DOM renderer.
      let usedWebgl = false
      if (api.WebglAddon) {
        try {
          const webgl = new api.WebglAddon()
          webgl.onContextLoss?.(() => {
            try {
              webgl.dispose()
            } catch {
              /* ignore */
            }
            if (!disposed) setRenderer('dom')
          })
          term.loadAddon(webgl)
          usedWebgl = true
        } catch {
          usedWebgl = false
        }
      }
      if (!disposed) setRenderer(usedWebgl ? 'webgl' : 'dom')

      refit()

      session = execPod({
        namespace,
        pod,
        container,
        command: commandRef.current,
        tty: true,
        cluster,
      })
      sessionRef.current = session

      term.onData((data: string) => sessionRef.current?.write(data))
      session.onData((text) => term?.write(text))

      const socket = session.socket
      const markOpen = () => {
        if (disposed) return
        setStatus('connected')
        refit()
        term?.focus()
      }
      if (socket.readyState === WebSocket.OPEN) markOpen()
      else socket.addEventListener('open', markOpen)

      session.onClose(({ code, reason }) => {
        if (disposed) return
        setStatus('disconnected')
        term?.write(
          `\r\n\x1b[90m* session closed (code ${code}${reason ? `, ${reason}` : ''})\x1b[0m\r\n`,
        )
      })
      session.onError(() => {
        if (disposed) return
        setStatus('error')
        setError('WebSocket error — the exec channel could not be established or was interrupted.')
      })

      // Keep the remote TTY sized to the on-screen terminal.
      resizeObserver = new ResizeObserver(() => refit())
      resizeObserver.observe(hostRef.current)
      onWinResize = () => refit()
      globalThis.addEventListener('resize', onWinResize)

      term.focus()
    })()

    return () => {
      disposed = true
      if (onWinResize) globalThis.removeEventListener('resize', onWinResize)
      resizeObserver?.disconnect()
      session?.close()
      term?.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      sessionRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, pod, container, cluster, commandKey, attempt, refit])

  /* ── live font-size changes (no reconnect) ── */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      term.options.fontSize = fontSize
    } catch {
      /* term disposed */
    }
    const id = requestAnimationFrame(() => refit())
    return () => cancelAnimationFrame(id)
  }, [fontSize, refit])

  /* ── track the console's light/dark mode and re-theme live ── */
  useEffect(() => {
    const apply = () => {
      const mode = getResolvedMode()
      setResolvedMode(mode)
      const term = termRef.current
      if (term) {
        try {
          term.options.theme = alwaysDark || mode === 'dark' ? DARK_THEME : LIGHT_THEME
        } catch {
          /* term disposed */
        }
      }
    }
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-mode', 'data-theme'],
    })
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener('change', apply)
    return () => {
      obs.disconnect()
      mq?.removeEventListener('change', apply)
    }
  }, [attempt, alwaysDark])

  /* ── refit after fullscreen toggle ── */
  useEffect(() => {
    const id = requestAnimationFrame(() => refit())
    return () => cancelAnimationFrame(id)
  }, [fullscreen, refit])

  /* ── Esc exits fullscreen ── */
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [fullscreen])

  /* ── toolbar handlers ── */
  const doCopy = useCallback(async () => {
    const term = termRef.current
    const sel = term?.getSelection?.()
    if (!sel) return
    try {
      await navigator.clipboard.writeText(sel)
    } catch {
      /* clipboard blocked */
    }
  }, [])

  const doPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) sessionRef.current?.write(text)
    } catch {
      /* clipboard blocked */
    }
    termRef.current?.focus()
  }, [])

  const doClear = useCallback(() => {
    termRef.current?.clear()
    termRef.current?.focus()
  }, [])

  const doDownload = useCallback(() => {
    const term = termRef.current
    if (!term) return
    const buf = term.buffer?.active
    let text = ''
    if (buf) {
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        if (line) text += line.translateToString(true) + '\n'
      }
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    a.href = url
    a.download = `${pod}${container ? `-${container}` : ''}-${stamp}.log`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [pod, container])

  const runSearch = useCallback(
    (dir: 'next' | 'prev') => {
      const s = searchRef.current
      if (!s || !searchTerm) return
      const opts = { incremental: false }
      if (dir === 'next') s.findNext(searchTerm, opts)
      else s.findPrevious(searchTerm, opts)
    },
    [searchTerm],
  )

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      const next = !open
      if (!next) {
        searchRef.current?.clearDecorations?.()
        termRef.current?.focus()
      }
      return next
    })
  }, [])

  const sendAction = useCallback((send: string) => {
    if (sessionRef.current && termRef.current) {
      sessionRef.current.write(send)
      termRef.current.focus()
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      write: (text: string) => sessionRef.current?.write(text),
      focus: () => termRef.current?.focus(),
      clear: () => termRef.current?.clear(),
      fit: () => refit(),
      reconnect: () => setAttempt((n) => n + 1),
      status: () => statusRef.current,
      geometry: () => {
        const t = termRef.current
        return t ? { cols: t.cols as number, rows: t.rows as number } : null
      },
    }),
    [refit],
  )

  const searchAvailable = !!searchRef.current
  const dead = status === 'disconnected' || status === 'error'

  return (
    <div
      ref={wrapRef}
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm',
        fullscreen ? 'fixed inset-0 z-50 rounded-none' : 'relative',
        fill && !fullscreen && 'h-full min-h-0',
      )}
    >
      {/* toolbar — one row, icon-only, never wrapping (see the note above) */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-edge-default bg-surface-sunken px-1.5">
        {fill ? (
          <span
            title={`Session ${status}`}
            aria-label={`Session ${status}`}
            className={cn('ml-0.5 mr-1 h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[status])}
          />
        ) : (
          <>
            <StatusBadge kind={STATUS_KIND[status]}>{status}</StatusBadge>
            <span className="mx-1 min-w-0 flex-1 truncate font-mono text-[11px] text-content-muted">
              {pod}
              {container ? ` / ${container}` : ''}
            </span>
          </>
        )}

        {actions?.length ? (
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                title={a.title ?? a.label}
                aria-label={a.title ?? a.label}
                disabled={status !== 'connected'}
                onClick={() => sendAction(a.send)}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-1.5 font-mono text-[10px] text-content-muted transition-colors hover:border-edge-strong hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconPlay />
                {a.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <TermBtn
            label={searchAvailable ? 'Find in scrollback' : 'Search addon unavailable'}
            active={searchOpen}
            disabled={!searchAvailable}
            onClick={toggleSearch}
          >
            <IconSearch />
          </TermBtn>
          <TermBtn label="Copy selection" onClick={doCopy}>
            <IconCopy />
          </TermBtn>
          <TermBtn label="Paste from clipboard" onClick={doPaste}>
            <IconPaste />
          </TermBtn>
          <TermBtn label="Clear the screen" onClick={doClear}>
            <IconEraser />
          </TermBtn>

          {/* font size — A−/A+ stay as glyphs: no icon says "font size" as plainly */}
          <div className="mx-0.5 flex h-6 shrink-0 items-center overflow-hidden rounded-md border border-edge-default bg-surface-raised">
            <button
              type="button"
              className="h-full px-1.5 text-[11px] leading-none text-content-muted transition-colors hover:text-content disabled:opacity-40"
              onClick={() => setFontSize((n) => Math.max(MIN_FONT, n - 1))}
              disabled={fontSize <= MIN_FONT}
              title="Decrease font size"
              aria-label="Decrease font size"
            >
              A−
            </button>
            <span className="min-w-5 text-center text-[10px] tabular-nums text-content-subtle">
              {fontSize}
            </span>
            <button
              type="button"
              className="h-full px-1.5 text-[11px] leading-none text-content-muted transition-colors hover:text-content disabled:opacity-40"
              onClick={() => setFontSize((n) => Math.min(MAX_FONT, n + 1))}
              disabled={fontSize >= MAX_FONT}
              title="Increase font size"
              aria-label="Increase font size"
            >
              A+
            </button>
          </div>

          <TermBtn label="Download session buffer (.log)" onClick={doDownload}>
            <IconDownload />
          </TermBtn>
          <TermBtn
            label={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            active={fullscreen}
            onClick={() => setFullscreen((f) => !f)}
          >
            {fullscreen ? <IconCollapse /> : <IconExpand />}
          </TermBtn>
          <TermBtn label="Reconnect the session" onClick={() => setAttempt((n) => n + 1)}>
            <IconRefresh />
          </TermBtn>
        </div>
      </div>

      {/* find box */}
      {searchOpen ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge-default bg-surface-sunken px-1.5">
          <span className="ml-0.5 text-content-subtle">
            <IconSearch />
          </span>
          <input
            autoFocus
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape') toggleSearch()
            }}
            placeholder="Find in terminal…  (Enter next, Shift+Enter previous)"
            className="h-6 min-w-0 flex-1 rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-[11px] text-content outline-none placeholder:text-content-subtle focus:border-brand-400"
          />
          <TermBtn label="Previous match (Shift+Enter)" onClick={() => runSearch('prev')}>
            <IconChevronUp />
          </TermBtn>
          <TermBtn label="Next match (Enter)" onClick={() => runSearch('next')}>
            <IconChevronDown />
          </TermBtn>
          <TermBtn label="Close find (Esc)" onClick={toggleSearch}>
            <IconX />
          </TermBtn>
        </div>
      ) : null}

      {error ? (
        <div className="shrink-0 border-b border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-200">
          {error}
        </div>
      ) : null}

      {/* terminal surface */}
      <div
        className={cn('relative w-full', fullscreen || fill ? 'min-h-0 flex-1' : 'h-[50vh]')}
        onPointerDown={() => {
          // Clicking the padding around the canvas must still focus the shell —
          // xterm only focuses when the hit lands on its own element.
          if (!termRef.current?.hasSelection?.()) termRef.current?.focus()
        }}
        style={{ background: resolvedMode === 'dark' ? DARK_THEME.background : LIGHT_THEME.background }}
      >
        {/* Padding is 1 row / 2 columns: enough that glyphs do not touch the
            border, little enough that the shell keeps the surface. */}
        <div ref={hostRef} className="h-full w-full px-1.5 py-1" />
        {/* auto-reconnect affordance when the channel drops */}
        {dead ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-edge-default bg-surface-raised/95 px-3 py-2 backdrop-blur">
            <span className="text-xs text-content-muted">
              {status === 'error' ? 'Connection error.' : 'Session ended.'} The shell is no longer live.
            </span>
            <Button size="xs" variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              Reconnect
            </Button>
          </div>
        ) : null}
      </div>

      {fill ? null : (
        <div className="flex shrink-0 items-center justify-between border-t border-edge-default bg-surface-sunken px-2 py-0.5 text-[10px] text-content-subtle">
          <span>renderer: {renderer}</span>
          <span>exec runs as you · process runs as the pod's service account</span>
        </div>
      )}
    </div>
  )
})

/* ───────────────────────── chrome ───────────────────────── */

/**
 * Square icon button for the terminal toolbar.
 *
 * `label` is the whole affordance — it is the tooltip AND the accessible name,
 * so an icon-only toolbar stays usable by screen readers and by anyone who does
 * not recognise the glyph. Matches the workbench's own `IconBtn` (see
 * `cloud-shell.tsx`) one size down, because this row sits inside that one.
 */
function TermBtn({
  label,
  onClick,
  active,
  disabled = false,
  children,
}: {
  label: string
  onClick(): void
  /**
   * Toggle state. Left undefined for one-shot actions (copy, paste, clear) so
   * `aria-pressed` is absent there — announcing a plain action as an unpressed
   * toggle tells a screen-reader user the button has a state it does not have.
   */
  active?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
          : 'border-transparent text-content-muted hover:border-edge-default hover:bg-surface-raised hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

/* ─── glyphs (14×14, currentColor — same vocabulary as cloud-shell.tsx) ─── */

const I = ({ children, size = 14, sw = 2 }: { children: ReactNode; size?: number; sw?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className="shrink-0"
  >
    {children}
  </svg>
)

const IconSearch = () => <I><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>
const IconCopy = () => <I><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></I>
const IconPaste = () => (
  <I>
    <path d="M16 4h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <rect x="9" y="2" width="6" height="4" rx="1" />
  </I>
)
const IconEraser = () => <I><path d="m5 16 6-6 6 6-3 3H8z" /><path d="m11 10 4-4a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-4 4" /><path d="M8 19h12" /></I>
const IconDownload = () => <I><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></I>
const IconExpand = () => (
  <I>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </I>
)
const IconCollapse = () => (
  <I>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
  </I>
)
const IconRefresh = () => <I><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></I>
const IconPlay = () => <I size={10} sw={2.5}><path d="m6 4 14 8-14 8z" /></I>
const IconChevronUp = () => <I size={13} sw={2.25}><path d="m6 15 6-6 6 6" /></I>
const IconChevronDown = () => <I size={13} sw={2.25}><path d="m6 9 6 6 6-6" /></I>
const IconX = () => <I size={13} sw={2.25}><path d="M18 6 6 18M6 6l12 12" /></I>
