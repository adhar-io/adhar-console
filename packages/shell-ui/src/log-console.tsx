import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar-console/utils'
import { Spinner } from './primitives.tsx'
import {
  buildMatcher,
  type Matcher,
  renderSegments,
  SEVERITY_TONE,
  type Severity,
  stripAnsi,
} from './log-format.tsx'

/**
 * The log surface every console in the product renders through — the pipeline
 * step console, the Logs page, the pod/workload drawer tabs, and the cloud
 * development environment build log.
 *
 * It is deliberately **presentational**: it renders the `lines` it is handed and
 * fetches nothing. Kubernetes log streaming lives in
 * `modules/platform/src/components/log-console.tsx` (`useLogStream`); Coder
 * provisioner logs arrive over a different transport entirely. Both feed the
 * same surface, which is the point — there used to be four separate
 * implementations of "show me some log lines" and they had all drifted apart.
 */

/** One rendered log line. */
export interface LogLine {
  /** RFC3339 timestamp, when the source provided one. */
  ts?: string
  text: string
  /** Gutter prefix — set when several sources are merged into one view. */
  source?: string
  severity: Severity
}

/** Connection state, reported by whatever transport is feeding the console. */
export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'paused'
  | 'empty'
  | 'error'
  | 'forbidden'
  | 'notfound'

/* ──────────────────────────────── surface ──────────────────────────────── */

export interface LogConsoleProps {
  lines: LogLine[]
  status: StreamStatus
  error?: string
  reconnect?: { attempt: number; message?: string }
  /** Left-hand caption in the toolbar (step name, pod, workload…). */
  label?: ReactNode
  /** Shows the pulsing "live" pip. */
  live?: boolean
  /** Base name for the downloaded file. */
  filename?: string
  /** Height when not fullscreen. Ignored in fullscreen. */
  height?: string
  /** Extra controls, rendered before the built-in toggles. */
  toolbar?: ReactNode
  /** Follow is lifted when the caller wants to pause the stream itself. */
  follow?: boolean
  onFollowChange?(follow: boolean): void
  timestamps?: boolean
  onTimestampsChange?(on: boolean): void
  /** Replaces the built-in "nothing here" copy. */
  emptyMessage?: ReactNode
}

/**
 * The log surface: a dark console with a toolbar, line numbers, severity tone,
 * ANSI colour, find-with-highlight (plain or regex) and fullscreen.
 *
 * It renders `lines` and nothing else — no fetching — so the same component
 * serves a finished Tekton step, a live pod tail, and a merged multi-pod
 * stream. Severity, ANSI and highlighting all come from `log-format.tsx`, which
 * both of the previous implementations already shared.
 */
export function LogConsole({
  lines,
  status,
  error,
  reconnect,
  label,
  live,
  filename = 'console',
  height = 'h-[26rem]',
  toolbar,
  follow: followProp,
  onFollowChange,
  timestamps: tsProp,
  onTimestampsChange,
  emptyMessage,
}: LogConsoleProps) {
  const [followLocal, setFollowLocal] = useState(true)
  const [tsLocal, setTsLocal] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [search, setSearch] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [filterOnly, setFilterOnly] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [lineNumbers, setLineNumbers] = useState(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const follow = followProp ?? followLocal
  const setFollow = (v: boolean) => (onFollowChange ? onFollowChange(v) : setFollowLocal(v))
  const timestamps = tsProp ?? tsLocal
  const setTimestamps = (v: boolean) => (onTimestampsChange ? onTimestampsChange(v) : setTsLocal(v))

  const matcher: Matcher = useMemo(
    () => buildMatcher(search, { regex, caseSensitive }),
    [search, regex, caseSensitive],
  )

  const shown = useMemo(() => {
    if (!matcher.active || matcher.error || !filterOnly) return lines
    return lines.filter((l) => matcher.test(stripAnsi(l.text)))
  }, [lines, matcher, filterOnly])

  // Rows (within the visible set) that match — the basis for both the counter
  // and prev/next navigation.
  const matchRows = useMemo(() => {
    if (!matcher.active || matcher.error) return [] as number[]
    const out: number[] = []
    shown.forEach((l, i) => {
      if (matcher.test(stripAnsi(l.text))) out.push(i)
    })
    return out
  }, [shown, matcher])
  const matchCount = matchRows.length

  const [cursor, setCursor] = useState(0)
  useEffect(() => setCursor(0), [search, regex, caseSensitive])
  const activeRow = matchRows.length ? matchRows[Math.min(cursor, matchRows.length - 1)] : -1

  /* Stepping through matches scrolls the pane, which would fight auto-follow —
     so jumping to a match stops following, exactly as scrolling by hand does. */
  const stepMatch = (dir: 1 | -1) => {
    if (!matchRows.length) return
    setFollow(false)
    setCursor((c) => {
      const n = matchRows.length
      return ((c + dir) % n + n) % n
    })
  }
  useEffect(() => {
    if (activeRow < 0) return
    scrollRef.current?.querySelector(`[data-row="${activeRow}"]`)?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    })
  }, [activeRow])

  /* Scrolling up is how people read logs, so it turns following OFF rather than
     fighting the user for the scroll position. Everything that arrives while
     they are reading is counted, and the pill offers the way back. */
  const unreadBase = useRef(0)
  const [unread, setUnread] = useState(0)

  // Pin to the tail while following. Reading scrollHeight after paint keeps it
  // correct when a burst of lines arrives in one commit.
  useEffect(() => {
    if (!follow) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    unreadBase.current = lines.length
  }, [shown, follow, fullscreen, lines.length])

  useEffect(() => {
    if (follow) return
    setUnread(Math.max(0, lines.length - unreadBase.current))
  }, [lines.length, follow])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (!atBottom && follow) {
      unreadBase.current = lines.length
      setFollow(false)
    } else if (atBottom && !follow) {
      setFollow(true)
    }
  }

  const jumpToLive = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setFollow(true)
  }

  // ESC leaves fullscreen, matching every other overlay in the console.
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const plain = useMemo(
    () =>
      lines
        .map((l) => (timestamps && l.ts ? `${l.ts} ` : '') + (l.source ? `[${l.source}] ` : '') + stripAnsi(l.text))
        .join('\n'),
    [lines, timestamps],
  )

  const download = () => {
    const blob = new Blob([plain], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}.log`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const copy = () => {
    try {
      navigator.clipboard?.writeText(plain)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — nothing useful to say */
    }
  }

  const body = (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-code',
        fullscreen ? 'h-full rounded-xl shadow-2xl' : cn('rounded-xl border border-code-edge', height),
      )}
    >
      <div className='flex flex-wrap items-center gap-1.5 border-b border-code-edge bg-code-raised px-2 py-1.5'>
        {label ? <span className='mr-1 truncate font-mono text-[11px] text-code-fg/60'>{label}</span> : null}
        {live
          ? (
            <span className='inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300'>
              <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400' /> live
            </span>
          )
          : null}
        {reconnect
          ? (
            <span className='inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300'>
              <Spinner size={10} /> reconnecting{reconnect.attempt > 1 ? ` (${reconnect.attempt})` : ''}
            </span>
          )
          : null}

        {toolbar}

        <div className='relative ml-auto'>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search logs…'
            className={cn(
              'h-6 w-40 rounded border bg-code-raised px-2 text-[11px] text-code-fg placeholder:text-code-fg/45 outline-none focus:border-brand-400',
              matcher.error ? 'border-rose-400' : 'border-code-edge',
            )}
            title={matcher.error ?? undefined}
          />
          {matcher.active && !matcher.error
            ? (
              <span className='absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-code-fg/50'>
                {matchCount ? `${Math.min(cursor + 1, matchCount)}/${matchCount}` : '0/0'}
              </span>
            )
            : null}
        </div>
        {matcher.active
          ? (
            <>
              <ConsoleBtn onClick={() => stepMatch(-1)} label='Previous match'>
                <span className='text-[11px] leading-none'>↑</span>
              </ConsoleBtn>
              <ConsoleBtn onClick={() => stepMatch(1)} label='Next match'>
                <span className='text-[11px] leading-none'>↓</span>
              </ConsoleBtn>
              <ConsoleBtn active={regex} onClick={() => setRegex((r) => !r)} label='Regular expression'>
                <span className='font-mono text-[10px] leading-none'>.*</span>
              </ConsoleBtn>
              <ConsoleBtn
                active={caseSensitive}
                onClick={() => setCaseSensitive((c) => !c)}
                label='Match case'
              >
                <span className='font-mono text-[10px] leading-none'>Aa</span>
              </ConsoleBtn>
              <ConsoleBtn
                active={filterOnly}
                onClick={() => setFilterOnly((f) => !f)}
                label='Show only matching lines'
              >
                <IconFilter />
              </ConsoleBtn>
            </>
          )
          : null}

        <ConsoleBtn active={follow} onClick={() => setFollow(!follow)} label='Follow / auto-scroll'>
          <IconTail />
        </ConsoleBtn>
        <ConsoleBtn active={wrap} onClick={() => setWrap((w) => !w)} label='Wrap lines'>
          <IconWrap />
        </ConsoleBtn>
        <ConsoleBtn active={timestamps} onClick={() => setTimestamps(!timestamps)} label='Timestamps'>
          <IconClock />
        </ConsoleBtn>
        <ConsoleBtn active={lineNumbers} onClick={() => setLineNumbers((n) => !n)} label='Line numbers'>
          <IconHash />
        </ConsoleBtn>
        <ConsoleBtn onClick={copy} label={copied ? 'Copied' : 'Copy'}>
          {copied ? <IconCheck /> : <IconCopy />}
        </ConsoleBtn>
        <ConsoleBtn onClick={download} label='Download log'>
          <IconDownload />
        </ConsoleBtn>
        <ConsoleBtn onClick={() => setFullscreen((f) => !f)} label={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}>
          <IconExpand />
        </ConsoleBtn>
      </div>

      <div className='relative min-h-0 flex-1'>
        {!follow && lines.length > 0
          ? (
            <button
              type='button'
              onClick={jumpToLive}
              className='absolute bottom-3 right-4 z-10 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/60 bg-emerald-500/90 px-3 py-1 text-[11px] font-semibold text-white shadow-lg hover:bg-emerald-500'
            >
              {unread > 0 ? `${unread.toLocaleString()} new` : 'Jump to live'} ↓
            </button>
          )
          : null}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className='h-full overflow-auto px-3 py-2 font-mono text-[11px] leading-[1.55]'
        >
        {status === 'connecting' && lines.length === 0
          ? (
            <div className='flex items-center gap-2 py-4 text-code-fg/70'>
              <Spinner size={14} /> Connecting…
            </div>
          )
          : status === 'forbidden'
          ? <div className='py-4 text-code-fg/60'>Not authorized to read logs for this container.</div>
          : status === 'notfound'
          ? <div className='py-4 text-code-fg/60'>Pod no longer exists — its logs have been cleaned up.</div>
          : status === 'error'
          ? <div className='py-4 text-rose-300'>Couldn’t load logs{error ? `: ${error}` : '.'}</div>
          : lines.length === 0
          ? <div className='py-4 text-code-fg/55'>{emptyMessage ?? 'No log output yet.'}</div>
          : shown.length === 0
          ? <div className='py-4 text-code-fg/55'>No lines match the current search.</div>
          : (
            <table className='w-full border-collapse'>
              <tbody>
                {shown.map((l, i) => (
                  <tr
                    key={i}
                    data-row={i}
                    className={cn(
                      'align-top hover:bg-code-raised/70',
                      i === activeRow && 'bg-amber-400/20',
                    )}
                  >
                    {lineNumbers
                      ? (
                        <td className='select-none pr-3 text-right align-top font-mono text-[10px] text-code-fg/40'>
                          {i + 1}
                        </td>
                      )
                      : null}
                    {timestamps
                      ? (
                        <td className='select-none whitespace-pre pr-3 align-top font-mono text-[10px] text-code-fg/45'>
                          {l.ts ?? ''}
                        </td>
                      )
                      : null}
                    {l.source
                      ? (
                        <td className='select-none whitespace-pre pr-3 align-top font-mono text-[10px] text-code-fg/55'>
                          {l.source}
                        </td>
                      )
                      : null}
                    <td
                      className={cn(
                        SEVERITY_TONE[l.severity],
                        wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
                      )}
                    >
                      {renderSegments(l.text, matcher)}
                    </td>
                  </tr>
                ))}
                </tbody>
              </table>
            )}
        </div>
      </div>
    </div>
  )

  if (!fullscreen) return body
  if (typeof document === 'undefined') return body
  // Portal, because `position: fixed` resolves against any ancestor carrying a
  // transform or backdrop-filter — and these consoles live inside drawers that
  // have both.
  return createPortal(
    <div className='fixed inset-0 z-[60] flex flex-col bg-scrim/40 p-3 backdrop-blur-[2px]'>{body}</div>,
    document.body,
  )
}

/* ──────────────────────────────── chrome ──────────────────────────────── */

export function ConsoleBtn({
  active,
  onClick,
  label,
  children,
}: {
  active?: boolean
  onClick(): void
  label: string
  children: ReactNode
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded border transition-colors',
        active
          ? 'border-brand-400/60 bg-brand-500/20 text-brand-200'
          : 'border-code-edge bg-code-raised text-code-fg/60 hover:text-code-fg',
      )}
    >
      {children}
    </button>
  )
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width='12'
      height='12'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.25'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      {children}
    </svg>
  )
}

const IconTail = () => (
  <Glyph>
    <path d='M12 5v14' />
    <path d='m19 12-7 7-7-7' />
  </Glyph>
)
const IconWrap = () => (
  <Glyph>
    <path d='M3 6h18' />
    <path d='M3 12h13a3 3 0 0 1 0 6h-3' />
    <path d='m16 15-3 3 3 3' />
  </Glyph>
)
const IconClock = () => (
  <Glyph>
    <circle cx='12' cy='12' r='9' />
    <path d='M12 7v5l3 2' />
  </Glyph>
)
const IconHash = () => (
  <Glyph>
    <path d='M4 9h16' />
    <path d='M4 15h16' />
    <path d='M10 3 8 21' />
    <path d='M16 3l-2 18' />
  </Glyph>
)
const IconCopy = () => (
  <Glyph>
    <rect x='9' y='9' width='12' height='12' rx='2' />
    <path d='M5 15V5a2 2 0 0 1 2-2h10' />
  </Glyph>
)
const IconCheck = () => (
  <Glyph>
    <path d='m20 6-11 11-5-5' />
  </Glyph>
)
const IconDownload = () => (
  <Glyph>
    <path d='M12 3v12' />
    <path d='m7 10 5 5 5-5' />
    <path d='M5 21h14' />
  </Glyph>
)
const IconExpand = () => (
  <Glyph>
    <path d='M8 3H5a2 2 0 0 0-2 2v3' />
    <path d='M21 8V5a2 2 0 0 0-2-2h-3' />
    <path d='M3 16v3a2 2 0 0 0 2 2h3' />
    <path d='M16 21h3a2 2 0 0 0 2-2v-3' />
  </Glyph>
)
const IconFilter = () => (
  <Glyph>
    <path d='M3 5h18l-7 8v6l-4 2v-8Z' />
  </Glyph>
)

