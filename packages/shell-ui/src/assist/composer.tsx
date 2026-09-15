import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { cn } from '@adhar-console/utils'
import { AUTONOMY_LEVELS, type AgentInfo, type Autonomy } from '../agui/store.ts'
import type { CommandItem } from './nav.ts'
import { IconAt, IconChevronDown, IconMic, IconPin, IconReturn, IconSlash, IconStop, IconX, SparkIcon } from './icons.tsx'
import { accentDot } from './accent.ts'

/**
 * The composer — where every interaction starts.
 *
 * One text field that understands three kinds of input: a question (send),
 * a page name (⌘⏎ opens it), and commands. `/` opens a command menu and `@`
 * an agent menu, both keyboard-driven, because the fastest surface is one
 * whose controls are reachable without leaving the keyboard. The controls
 * that change what a message MEANS — which agent, how much authority, what
 * context rides along — sit in the row directly above the field so they are
 * read before sending, not discovered after.
 */

export interface ContextChip {
  key: string
  label: string
  value: string
}

export interface SlashCommand {
  cmd: string
  hint: string
  /** Takes the remainder of the input; returns what to leave in the field. */
  run(rest: string): string | void
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  configured,
  agents,
  agentId,
  onAgent,
  autonomy,
  onAutonomy,
  chips,
  attachContext,
  onToggleContext,
  navHint,
  onOpenNavHint,
  commands,
  inputRef,
  onArrow,
}: {
  value: string
  onChange(v: string): void
  onSubmit(): void
  onStop(): void
  busy: boolean
  configured: boolean
  agents: AgentInfo[]
  agentId: string
  onAgent(id: string): void
  autonomy: Autonomy
  onAutonomy(a: Autonomy): void
  chips: ContextChip[]
  attachContext: boolean
  onToggleContext(): void
  navHint?: CommandItem
  onOpenNavHint(): void
  commands: SlashCommand[]
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** Arrow keys while the navigate lane has results. */
  onArrow?(dir: 1 | -1): void
}) {
  const agent = agents.find((a) => a.id === agentId)
  const [menu, setMenu] = useState<'slash' | 'agent' | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)

  // Menus follow the first character; a typed space closes them so a sentence
  // that happens to start with "/" or "@" is not trapped.
  useEffect(() => {
    if (/^\/\S*$/.test(value)) setMenu('slash')
    else if (/^@\S*$/.test(value)) setMenu('agent')
    else setMenu(null)
    setMenuIndex(0)
  }, [value])

  const slashMatches = useMemo(() => {
    const q = value.slice(1).toLowerCase()
    return commands.filter((c) => c.cmd.slice(1).startsWith(q))
  }, [commands, value])
  const agentMatches = useMemo(() => {
    const q = value.slice(1).toLowerCase()
    return agents.filter((a) => a.name.toLowerCase().includes(q) || a.id.includes(q))
  }, [agents, value])

  const pickSlash = (c: SlashCommand) => {
    const rest = value.replace(/^\/\S*\s?/, '')
    const left = c.run(rest)
    onChange(typeof left === 'string' ? left : '')
    inputRef.current?.focus()
  }
  const pickAgent = (a: AgentInfo) => {
    onAgent(a.id)
    onChange('')
    inputRef.current?.focus()
  }

  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const menuLen = menu === 'slash' ? slashMatches.length : menu === 'agent' ? agentMatches.length : 0

  return (
    <div className="relative border-t border-edge-subtle bg-surface-raised/80 px-4 pb-3.5 pt-2.5 backdrop-blur">
      {/* ── controls row ── */}
      {configured && agents.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <AgentMenu agents={agents} agentId={agentId} busy={busy} onPick={onAgent} />
          {agent?.delegated ? <AutonomyPicker value={autonomy} busy={busy} onPick={onAutonomy} /> : null}
          <button
            type="button"
            aria-pressed={attachContext}
            onClick={onToggleContext}
            title={attachContext ? 'Context is attached — click to send the question on its own' : 'Attach where you are (cluster, namespace, focused resource) to the question'}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors',
              attachContext ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:bg-surface-sunken hover:text-content',
            )}
          >
            <IconPin size={12} /> Context
          </button>
          {attachContext ? (
            <span className="hidden flex-wrap items-center gap-1 md:flex">
              {chips.map((c) => (
                <span key={c.key} className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-content-muted">
                  <span className="text-content-subtle">{c.label}</span>
                  <span className="max-w-[10rem] truncate font-mono text-content" title={c.value}>{c.value}</span>
                </span>
              ))}
            </span>
          ) : null}
          <span className="ml-auto hidden items-center gap-1 text-[10.5px] text-content-subtle lg:inline-flex">
            <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">/</kbd> commands
            <kbd className="ml-1.5 rounded border border-edge-default bg-surface-sunken px-1 font-mono">@</kbd> agents
          </span>
        </div>
      ) : null}

      {/* ── menus ── */}
      {menu && menuLen ? (
        <div className="pop-in absolute bottom-full left-4 right-4 z-10 mb-1 max-w-md overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl shadow-black/10">
          <div className="border-b border-edge-subtle px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            {menu === 'slash' ? 'Commands' : 'Agents'}
          </div>
          <ul className="max-h-64 overflow-y-auto p-1">
            {menu === 'slash'
              ? slashMatches.map((c, i) => (
                  <li key={c.cmd}>
                    <button type="button" onMouseEnter={() => setMenuIndex(i)} onClick={() => pickSlash(c)} className={cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left', i === menuIndex ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken')}>
                      <span className="w-24 shrink-0 font-mono text-[12px] font-medium text-content">{c.cmd}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-content-muted">{c.hint}</span>
                      {i === menuIndex ? <span className="text-content-subtle"><IconReturn size={11} /></span> : null}
                    </button>
                  </li>
                ))
              : agentMatches.map((a, i) => (
                  <li key={a.id}>
                    <button type="button" onMouseEnter={() => setMenuIndex(i)} onClick={() => pickAgent(a)} className={cn('flex w-full items-start gap-3 rounded-lg px-2.5 py-1.5 text-left', i === menuIndex ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken')}>
                      <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', accentDot(a.accent))} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] font-medium text-content">{a.name}{a.id === agentId ? <span className="ml-1.5 text-[10px] font-normal text-content-subtle">current</span> : null}</span>
                        <span className="block truncate text-[11px] text-content-muted">{a.description}</span>
                      </span>
                    </button>
                  </li>
                ))}
          </ul>
        </div>
      ) : null}

      {/* ── field ── */}
      {/*
        One focus highlight, on the wrapper. The textarea inside opts out of
        the global input ring (`outline-none focus:ring-0`), so the field reads
        as a single control rather than a box inside a box.
      */}
      <div className={cn('flex items-end gap-2 rounded-2xl border bg-surface-app px-3 py-2 transition-[box-shadow,border-color]', busy ? 'border-edge-subtle' : 'border-edge-default focus-within:border-brand-400 focus-within:ring-[3px] focus-within:ring-brand-500/15')}>
        <span className={cn('mb-1.5 text-brand-600 dark:text-brand-400', busy && 'animate-pulse')}><SparkIcon size={16} /></span>
        <textarea
          ref={inputRef}
          value={value}
          rows={1}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onInput={(e) => autosize(e.currentTarget)}
          onKeyDown={(e) => {
            if (menu && menuLen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIndex((i) => Math.min(i + 1, menuLen - 1)); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIndex((i) => Math.max(i - 1, 0)); return }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                if (menu === 'slash') pickSlash(slashMatches[menuIndex])
                else pickAgent(agentMatches[menuIndex])
                return
              }
              if (e.key === 'Escape') { e.preventDefault(); onChange(''); return }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if ((e.metaKey || e.ctrlKey) && navHint) { onOpenNavHint(); return }
              onSubmit()
              requestAnimationFrame(() => { if (inputRef.current) autosize(inputRef.current) })
            } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && onArrow && navHint && value.trim()) {
              e.preventDefault()
              onArrow(e.key === 'ArrowDown' ? 1 : -1)
            }
          }}
          placeholder={configured ? `Ask ${agent?.name ?? 'Adhar AI'} anything — or type a page name and press ⌘⏎` : 'Search pages, apps and settings…'}
          aria-label="Message Adhar AI"
          className="max-h-[200px] min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-6 text-content outline-none placeholder:text-content-subtle focus:outline-none focus:ring-0"
        />
        <VoiceButton disabled={busy} value={value} onChange={onChange} onDone={() => inputRef.current?.focus()} />
        {busy ? (
          <button type="button" onClick={onStop} className="mb-0.5 inline-flex h-8 items-center gap-1.5 rounded-lg bg-surface-sunken px-3 text-[12px] font-semibold text-content-muted transition-colors hover:text-content">
            <IconStop /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={!value.trim()}
            className="mb-0.5 inline-flex h-8 items-center gap-1.5 rounded-lg bg-linear-to-r from-brand-600 to-brand-500 px-3 text-[12px] font-semibold text-white shadow-sm shadow-brand-600/25 transition-[filter] hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
          >
            {configured && !navHint ? 'Send' : navHint && !configured ? 'Go' : 'Send'} <IconReturn />
          </button>
        )}
      </div>

      {/* ── hint line ── */}
      <div className="mt-1.5 flex items-center justify-between px-1 text-[10.5px] text-content-subtle">
        <span>
          {navHint && value.trim() && !menu ? (
            <button type="button" onClick={onOpenNavHint} className="inline-flex items-center gap-1 rounded px-1 hover:bg-surface-sunken hover:text-content">
              <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⌘⏎</kbd> open <span className="font-medium text-content">{navHint.label}</span>
            </button>
          ) : configured ? (
            <span>Reads with your RBAC · changes only ever become a pull request</span>
          ) : (
            <span>AI is not configured — search & navigate still work</span>
          )}
        </span>
        <span className="hidden sm:inline"><kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⇧⏎</kbd> newline</span>
      </div>
    </div>
  )
}

/* ─────────────────────────────── voice ─────────────────────────────── */

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}

function recognitionCtor(): (new () => Recognition) | null {
  const g = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null
}

/**
 * Dictate into the composer.
 *
 * The browser's own speech recognition — no audio leaves the page to any
 * service of ours. Words land in the field as they are recognised (interim
 * text is replaced, final text is kept), and NOTHING is sent on the
 * operator's behalf: a spoken question is reviewed and sent with ⏎ like a
 * typed one, because "did it hear me right" is a question worth answering
 * before a run costs tokens. Hidden entirely where the API does not exist,
 * rather than shown and broken.
 */
function VoiceButton({ value, onChange, disabled, onDone }: { value: string; onChange(v: string): void; disabled: boolean; onDone(): void }) {
  const Ctor = useMemo(recognitionCtor, [])
  const [listening, setListening] = useState(false)
  const [denied, setDenied] = useState(false)
  const rec = useRef<Recognition | null>(null)
  const base = useRef('')

  useEffect(() => () => rec.current?.abort(), [])

  if (!Ctor) return null

  const stop = () => {
    rec.current?.stop()
    rec.current = null
    setListening(false)
    onDone()
  }
  const start = () => {
    const r = new Ctor()
    r.lang = globalThis.navigator?.language || 'en-US'
    r.continuous = true
    r.interimResults = true
    base.current = value ? `${value.replace(/\s+$/, '')} ` : ''
    r.onresult = (e) => {
      let finalText = ''
      let interim = ''
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]
        const t = res[0]?.transcript ?? ''
        if (res.isFinal) finalText += t
        else interim += t
      }
      onChange(`${base.current}${finalText}${interim}`.replace(/\s+/g, ' '))
    }
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setDenied(true)
      setListening(false)
      rec.current = null
    }
    r.onend = () => {
      setListening(false)
      rec.current = null
      onDone()
    }
    rec.current = r
    setDenied(false)
    setListening(true)
    r.start()
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={listening ? stop : start}
      aria-pressed={listening}
      title={denied ? 'Microphone access was denied — allow it in the browser to dictate' : listening ? 'Stop dictating' : 'Dictate (speech stays in your browser)'}
      className={cn(
        'mb-0.5 flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40',
        listening
          ? 'bg-rose-50 text-rose-600 ring-1 ring-rose-300 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/40'
          : denied
            ? 'text-content-subtle line-through'
            : 'text-content-subtle hover:bg-surface-sunken hover:text-content',
      )}
    >
      <span className={cn('relative flex', listening && 'animate-pulse')}>
        <IconMic size={15} />
        {listening ? <span className="pulse-ring absolute -inset-1.5 rounded-full ring-2 ring-rose-400/50" aria-hidden /> : null}
      </span>
    </button>
  )
}

/* ───────────────────────────── agent menu ───────────────────────────── */

function AgentMenu({ agents, agentId, busy, onPick }: { agents: AgentInfo[]; agentId: string; busy: boolean; onPick(id: string): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const agent = agents.find((a) => a.id === agentId)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose which agent answers"
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised pl-2 pr-1.5 text-[11.5px] font-medium text-content transition-colors hover:border-edge-strong disabled:opacity-50"
      >
        <span className={cn('h-2 w-2 rounded-full', accentDot(agent?.accent))} />
        {agent?.name ?? 'Agent'}
        {agent?.delegated ? <span className="rounded bg-violet-50 px-1 text-[9px] font-semibold uppercase tracking-wider text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">runtime</span> : null}
        <IconChevronDown size={11} />
      </button>
      {open ? (
        <div role="listbox" className="pop-in absolute bottom-full left-0 z-20 mb-1.5 w-80 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl shadow-black/10">
          <ul className="max-h-80 overflow-y-auto p-1">
            {agents.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={a.id === agentId}
                  onClick={() => { onPick(a.id); setOpen(false) }}
                  className={cn('flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors', a.id === agentId ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken')}
                >
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', accentDot(a.accent))} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-content">
                      {a.name}
                      {a.delegated ? <span className="rounded bg-violet-50 px-1 text-[9px] font-semibold uppercase tracking-wider text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">runtime</span> : null}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-content-muted">{a.description}</span>
                    <span className="mt-1 block text-[10px] text-content-subtle">{a.delegated ? 'MCP tools · knowledge-grounded · PR-only writes' : `${a.tools} tools · read-only`}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-1 border-t border-edge-subtle px-3 py-1.5 text-[10.5px] text-content-subtle">
            <IconAt size={11} /> Type <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">@</kbd> in the field to switch faster
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────────────────────── autonomy picker ─────────────────────────── */

/**
 * How much authority this turn gets.
 *
 * A segmented control rather than a menu, because the setting is the safety
 * boundary of the whole feature: it should be readable at a glance without a
 * click, and changing it should not hide what the other options were. It only
 * appears for the delegated agent — the console's own agents are read-only by
 * construction, and a control that cannot change anything is worse than none.
 */
export function AutonomyPicker({ value, busy, onPick }: { value: Autonomy; busy: boolean; onPick(a: Autonomy): void }) {
  return (
    <span className="inline-flex h-7 items-center rounded-md bg-surface-sunken p-0.5" role="group" aria-label="Autonomy">
      {AUTONOMY_LEVELS.map((l) => (
        <button
          key={l.id}
          type="button"
          disabled={busy}
          aria-pressed={value === l.id}
          title={`${l.label} — ${l.hint}`}
          onClick={() => onPick(l.id)}
          className={cn(
            'h-6 rounded px-2 text-[10.5px] font-medium transition-colors disabled:opacity-50',
            value === l.id ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-subtle hover:text-content',
          )}
        >
          {l.label}
        </button>
      ))}
    </span>
  )
}

export const IconSlashHint = IconSlash
export const IconClear = IconX
