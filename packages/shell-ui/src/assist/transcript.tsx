import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import { assistStore, useAssist, type ChatEntry, type RunState, type ToolCallView } from '../agui/store.ts'
import { GenerativeBlock } from '../agui/generative.tsx'
import { useToast } from '../toast.tsx'
import { Markdown } from './markdown.tsx'
import { pretty, safeArgs, toolLabel } from './tool-label.ts'
import { Dots, IconBook, IconCheck, IconChevronDown, IconCopy, IconRefresh, IconReturn, IconSave, IconThumbDown, IconThumbUp, IconTool, SparkIcon } from './icons.tsx'

/**
 * The conversation.
 *
 * A turn is one AG-UI run rendered in the order its events arrived: the tools
 * it ran (collapsed into a timeline once there are several, because a wall of
 * chips buries the answer), the answer, the components it chose, what it was
 * grounded on, and the operator's verdict on that grounding. Everything an
 * operator can act on lives on the turn — copy, regenerate, keep as knowledge,
 * vote — so nothing about an answer requires leaving it.
 */
export function Transcript({
  messages,
  busy,
  run,
  agentName,
  accent,
  onAsk,
  onCanvas,
  onSend,
}: {
  messages: ChatEntry[]
  busy: boolean
  run: RunState | null
  agentName?: string
  accent?: string
  /** Put text in the composer (a question about a block, a source, …). */
  onAsk(prompt: string): void
  /** Open the canvas board. */
  onCanvas(): void
  /** Send a follow-up immediately. */
  onSend(prompt: string): void
}) {
  const { pendingAsk } = useAssist()
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const showWorking = busy && !pendingAsk
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 pb-4">
      {messages.map((m, i) => (
        <Turn
          key={m.id}
          entry={m}
          agentName={agentName}
          accent={accent}
          isLast={m.id === lastAssistant?.id}
          busy={busy}
          previousUser={m.role === 'assistant' ? messages[i - 1] : undefined}
          onAsk={onAsk}
          onCanvas={onCanvas}
          onSend={onSend}
        />
      ))}
      {pendingAsk ? <AskCard /> : null}
      {showWorking ? <WorkingCard run={run} entry={lastAssistant?.streaming ? lastAssistant : undefined} /> : null}
    </div>
  )
}

/* ─────────────────────────────── a turn ─────────────────────────────── */

function Turn({
  entry,
  agentName,
  accent,
  isLast,
  busy,
  previousUser,
  onAsk,
  onCanvas,
  onSend,
}: {
  entry: ChatEntry
  agentName?: string
  accent?: string
  isLast: boolean
  busy: boolean
  previousUser?: ChatEntry
  onAsk(prompt: string): void
  onCanvas(): void
  onSend(prompt: string): void
}) {
  if (entry.role === 'user') {
    return (
      <div className="rise-in flex justify-end">
        <div className="max-w-[82%] rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-[13.5px] leading-relaxed text-white shadow-sm shadow-brand-600/20">
          <div className="whitespace-pre-wrap break-words">{entry.content}</div>
        </div>
      </div>
    )
  }

  const hasBody = Boolean(entry.content) || entry.ui.length > 0 || Boolean(entry.error)
  return (
    <div className="rise-in group/turn flex gap-3">
      <Avatar accent={accent} streaming={Boolean(entry.streaming)} />
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex items-baseline gap-2 pl-0.5 text-[11px] text-content-subtle">
          <span className="font-semibold text-content-muted">{agentName ?? 'Adhar AI'}</span>
          <span>{clock(entry.at)}</span>
        </div>

        {entry.toolCalls.length ? <ToolTimeline calls={entry.toolCalls} streaming={Boolean(entry.streaming)} /> : null}

        {entry.content ? (
          <div className="rounded-2xl rounded-tl-md border border-edge-subtle bg-surface-raised px-4 py-3 text-[13.5px] leading-relaxed text-content shadow-sm shadow-black/3">
            <Markdown text={entry.content} />
            {entry.streaming ? <span className="ml-0.5 inline-block h-4 w-[3px] animate-pulse rounded-sm bg-brand-500 align-middle" /> : null}
          </div>
        ) : entry.streaming && !entry.toolCalls.length ? (
          <div className="flex items-center gap-2 py-1.5 text-[13px] text-content-subtle"><Dots /> thinking…</div>
        ) : null}

        {entry.ui.map((block) => (
          <GenerativeBlock key={block.id} block={block} onAsk={onAsk} onCanvas={onCanvas} animate={Boolean(entry.streaming)} />
        ))}

        {entry.error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">
            {entry.error}
          </div>
        ) : null}

        {!entry.streaming && hasBody ? (
          <TurnFooter entry={entry} isLast={isLast} busy={busy} question={previousUser?.content} />
        ) : null}

        {!entry.streaming && isLast && !busy && entry.followups?.length ? (
          <Followups items={entry.followups} onSend={onSend} />
        ) : null}
      </div>
    </div>
  )
}

/**
 * Next questions, one click each.
 *
 * Only under the LAST answer: a follow-up three turns back is stale, and a
 * transcript full of suggestion rows reads as the agent talking to itself.
 */
function Followups({ items, onSend }: { items: string[]; onSend(prompt: string): void }) {
  return (
    <div className="rise-in flex flex-wrap items-center gap-1.5 pt-1">
      <span className="mr-0.5 text-[10.5px] font-medium uppercase tracking-wider text-content-subtle">Next</span>
      {items.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => onSend(q)}
          className="group/fu inline-flex max-w-full items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised px-3 py-1 text-left text-[12px] text-content-muted transition-colors hover:border-brand-300 hover:bg-brand-50/60 hover:text-content dark:hover:border-brand-500/40 dark:hover:bg-brand-500/10"
        >
          <span className="truncate">{q}</span>
          <span className="shrink-0 text-content-subtle opacity-0 transition-opacity group-hover/fu:opacity-100"><IconReturn size={10} /></span>
        </button>
      ))}
    </div>
  )
}

function Avatar({ accent, streaming }: { accent?: string; streaming: boolean }) {
  return (
    <span
      className={cn(
        'relative mt-4 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white shadow-sm',
        !accent && 'bg-linear-to-br from-brand-500 to-accent-500',
      )}
      style={accent ? { background: `linear-gradient(135deg, var(--color-${accent}-500), var(--color-${accent}-700))` } : undefined}
    >
      <SparkIcon size={13} />
      {streaming ? <span className="pulse-ring absolute inset-0 rounded-lg ring-2 ring-brand-400/60" aria-hidden /> : null}
    </span>
  )
}

/* ────────────────────────────── footer ────────────────────────────── */

/**
 * Sources and actions, one row.
 *
 * The vote is the important control: it is the operator telling the runtime
 * whether the documents it retrieved were the right ones, and it is what makes
 * retrieval improve. A vote sticks visibly so the same answer is not judged
 * twice, and "kept" is shown only after the runtime confirmed it.
 */
function TurnFooter({ entry, isLast, busy, question }: { entry: ChatEntry; isLast: boolean; busy: boolean; question?: string }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const g = entry.grounding

  const copy = () => {
    void navigator.clipboard?.writeText(entry.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  const vote = async (v: 'up' | 'down') => {
    const ok = await assistStore.feedback(entry.id, v)
    if (ok) toast.success(v === 'up' ? 'Thanks — the runtime will favour these sources.' : 'Noted — these sources will rank lower.')
    else toast.error('Could not record feedback — the runtime did not accept it.')
  }
  const remember = async () => {
    if (!entry.content.trim()) return
    setSaving(true)
    const title = (question ?? 'Assistant answer').trim().slice(0, 120)
    const ok = await assistStore.saveNote({ title, body: `Q: ${question ?? ''}\n\nA:\n${entry.content}`, kind: 'note', tags: ['assistant'] })
    setSaving(false)
    if (ok) toast.success('Kept as platform knowledge — askable from now on.')
    else toast.error('Could not save to the knowledge base.')
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1 pl-0.5">
        {g && (g.sources.length || g.chunkIds.length) ? (
          <>
            <button
              type="button"
              onClick={() => setSourcesOpen((o) => !o)}
              aria-expanded={sourcesOpen}
              className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
            >
              <IconBook size={12} /> Grounded on {g.sources.length || g.chunkIds.length} source{(g.sources.length || g.chunkIds.length) === 1 ? '' : 's'}
              <span className={cn('transition-transform', sourcesOpen && 'rotate-180')}><IconChevronDown size={11} /></span>
            </button>
            <span className="inline-flex items-center rounded-md bg-surface-sunken/70 p-0.5">
              <FooterIcon title="These sources helped" active={g.vote === 'up'} activeClass="text-emerald-600 dark:text-emerald-400" onClick={() => void vote('up')} disabled={busy}>
                <IconThumbUp size={12} />
              </FooterIcon>
              <FooterIcon title="These sources were wrong or unhelpful" active={g.vote === 'down'} activeClass="text-rose-600 dark:text-rose-400" onClick={() => void vote('down')} disabled={busy}>
                <IconThumbDown size={12} />
              </FooterIcon>
            </span>
            <span className="mx-1 h-3.5 w-px bg-edge-subtle" aria-hidden />
          </>
        ) : null}
        <FooterBtn onClick={copy} title="Copy the answer">{copied ? <IconCheck size={12} /> : <IconCopy size={12} />} {copied ? 'Copied' : 'Copy'}</FooterBtn>
        {entry.content ? (
          <FooterBtn onClick={() => void remember()} title="Keep this answer in the platform's knowledge base so future answers can cite it" disabled={saving}>
            <IconSave size={12} /> {saving ? 'Keeping…' : 'Keep as knowledge'}
          </FooterBtn>
        ) : null}
        {isLast && !busy ? (
          <FooterBtn onClick={() => assistStore.regenerate()} title="Run the last question again"><IconRefresh size={12} /> Regenerate</FooterBtn>
        ) : null}
      </div>
      {sourcesOpen && g ? (
        <ol className="ml-0.5 space-y-0.5 rounded-lg border border-edge-subtle bg-surface-sunken/40 px-3 py-2 text-[12px] leading-relaxed text-content-muted">
          {g.sources.length ? g.sources.map((s, i) => (
            <li key={i} className="flex gap-2"><span className="tabular-nums text-content-subtle">{i + 1}.</span><span className="min-w-0 break-words">{s}</span></li>
          )) : <li className="text-content-subtle">{g.chunkIds.length} knowledge chunks (titles not reported).</li>}
        </ol>
      ) : null}
    </div>
  )
}

function FooterBtn({ children, onClick, title, disabled }: { children: ReactNode; onClick(): void; title: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} disabled={disabled} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-50">
      {children}
    </button>
  )
}

function FooterIcon({ children, onClick, title, active, activeClass, disabled }: { children: ReactNode; onClick(): void; title: string; active: boolean; activeClass: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={active} disabled={disabled} className={cn('flex h-5 w-6 items-center justify-center rounded transition-colors disabled:opacity-50', active ? cn('bg-surface-raised shadow-sm', activeClass) : 'text-content-subtle hover:text-content')}>
      {children}
    </button>
  )
}

/* ───────────────────────────── tool timeline ───────────────────────────── */

/**
 * What the agent did to get its answer.
 *
 * Up to three calls show as chips; more collapse into one line ("Ran 7 tools ·
 * 1 failed") that opens into a vertical timeline. Each step opens to its
 * arguments and result — the evidence, kept one click away rather than in the
 * reader's way.
 */
function ToolTimeline({ calls, streaming }: { calls: ToolCallView[]; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const running = calls.filter((c) => c.status === 'running').length
  const failed = calls.filter((c) => c.status === 'error').length
  const collapsed = calls.length > 3 && !open

  if (collapsed) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-lg border border-edge-subtle bg-surface-raised/70 px-2.5 py-1.5 text-[11.5px] text-content-muted transition-colors hover:border-edge-default hover:text-content">
        {running ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : <IconTool size={11} />}
        <span>{running ? `Running ${calls.length} tool${calls.length === 1 ? '' : 's'}` : `Ran ${calls.length} tools`}</span>
        {failed ? <span className="text-rose-600 dark:text-rose-400">· {failed} failed</span> : null}
        <span className="text-content-subtle"><IconChevronDown size={11} /></span>
      </button>
    )
  }
  if (calls.length <= 3 && !open) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {calls.map((c) => <ToolChip key={c.id} call={c} />)}
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-edge-subtle bg-surface-raised/70 p-2">
      <div className="flex items-center justify-between px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle">
        <span>Tools · {calls.length}{failed ? ` · ${failed} failed` : ''}{streaming && running ? ' · running' : ''}</span>
        <button type="button" onClick={() => setOpen(false)} className="font-medium normal-case tracking-normal hover:text-content">collapse</button>
      </div>
      <ol className="relative ml-2 space-y-0.5 border-l border-edge-subtle pl-3">
        {calls.map((c) => <ToolRow key={c.id} call={c} />)}
      </ol>
    </div>
  )
}

function statusDot(status: ToolCallView['status']) {
  return status === 'running' ? 'bg-brand-500 animate-pulse' : status === 'error' ? 'bg-rose-500' : 'bg-emerald-500'
}

function ToolRow({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="relative">
      <span className={cn('absolute -left-[17px] top-2 h-2 w-2 rounded-full ring-2 ring-surface-raised', statusDot(call.status))} aria-hidden />
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-content-muted transition-colors hover:bg-surface-sunken hover:text-content">
        <span className="min-w-0 flex-1 truncate">{toolLabel(call.name, safeArgs(call.args))}</span>
        <span className="shrink-0 font-mono text-[10px] text-content-subtle">{call.name}</span>
        <span className={cn('shrink-0 text-content-subtle transition-transform', open && 'rotate-180')}><IconChevronDown size={11} /></span>
      </button>
      {open ? <ToolDetail call={call} /> : null}
    </li>
  )
}

function ToolChip({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false)
  const failed = call.status === 'error'
  return (
    <span className="inline-flex max-w-full flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Show the arguments and result"
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
          failed
            ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300'
            : call.status === 'running'
              ? 'border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300'
              : 'border-edge-subtle bg-surface-raised text-content-muted hover:border-edge-default hover:text-content',
        )}
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot(call.status))} />
        <span className="truncate">{toolLabel(call.name, safeArgs(call.args))}</span>
      </button>
      {open ? <ToolDetail call={call} /> : null}
    </span>
  )
}

function ToolDetail({ call }: { call: ToolCallView }) {
  return (
    <div className="mt-1 max-w-2xl overflow-hidden rounded-lg bg-code font-mono text-[10.5px] leading-relaxed text-code-fg">
      <div className="border-b border-code-edge px-2.5 py-1 text-code-fg/50">arguments</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-2.5 py-1.5">{pretty(call.args) || '{}'}</pre>
      {call.result !== undefined ? (
        <>
          <div className="border-y border-code-edge px-2.5 py-1 text-code-fg/50">result</div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap px-2.5 py-1.5">{pretty(call.result).slice(0, 6000)}</pre>
        </>
      ) : null}
    </div>
  )
}

/* ─────────────────────────── thinking / ask ─────────────────────────── */

/**
 * The run, while it runs.
 *
 * Not a spinner. The agent's shared state is streamed as STATE_SNAPSHOT /
 * STATE_DELTA precisely so the operator can watch it think: the phase, the
 * plan step it is on, the tool it is in, how long it has been at it. A
 * ninety-second investigation that shows its work is patience; a ninety-second
 * spinner is a hang.
 */
function WorkingCard({ run, entry }: { run: RunState | null; entry?: ChatEntry }) {
  const [t0] = useState(() => Date.now())
  const [now, setNow] = useState(t0)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = Math.max(0, Math.round((now - t0) / 1000))

  const plan = run?.plan ?? []
  const active = plan.find((s) => s.status === 'active')
  const done = plan.filter((s) => s.status === 'done').length
  const phase = run?.phase
  const label = active
    ? active.label
    : run?.tools?.last
      ? `running ${run.tools.last.replace(/_/g, ' ')}`
      : phase === 'planning'
        ? 'planning the investigation'
        : phase === 'thinking'
          ? 'investigating with the runtime'
          : phase === 'answering'
            ? 'writing the answer'
            : 'thinking'
  const calls = entry?.toolCalls.length ?? run?.tools?.called ?? 0

  // Once text is streaming the answer itself is the progress indicator; a
  // status card underneath it would just be noise.
  if (entry?.content) return null

  return (
    <div className="rise-in ml-10 max-w-md overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm shadow-black/3">
      <div className="h-0.5 w-full overflow-hidden bg-surface-sunken">
        <div className="h-full w-1/3 animate-[adhar-nav-progress_1.4s_ease-in-out_infinite] rounded-full bg-linear-to-r from-brand-400 to-accent-500" />
      </div>
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <Dots />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-content">{label}…</span>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-content-subtle">{elapsed}s</span>
      </div>
      {plan.length || calls ? (
        <div className="flex items-center gap-3 border-t border-edge-subtle px-3.5 py-1.5 text-[10.5px] text-content-subtle">
          {plan.length ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex gap-0.5">
                {plan.slice(0, 8).map((s) => (
                  <span key={s.id} className={cn('h-1 w-3 rounded-full', s.status === 'done' ? 'bg-emerald-500' : s.status === 'active' ? 'animate-pulse bg-brand-500' : s.status === 'failed' ? 'bg-rose-500' : 'bg-edge-default')} />
                ))}
              </span>
              <span className="tabular-nums">{done}/{plan.length} steps</span>
            </span>
          ) : null}
          {calls ? <span className="tabular-nums">{calls} tool call{calls === 1 ? '' : 's'}</span> : null}
          {run?.tools?.failed ? <span className="text-rose-600 dark:text-rose-400">{run.tools.failed} failed</span> : null}
        </div>
      ) : null}
    </div>
  )
}

/** Compact variant for hosts that only have room for one line. */
export function Thinking({ run }: { run: RunState | null }) {
  const active = run?.plan?.find((s) => s.status === 'active')
  const label = active ? active.label : run?.tools?.last ? `running ${run.tools.last}` : 'thinking'
  return <div className="flex items-center gap-2.5 pl-10 text-[12.5px] text-content-subtle"><Dots /> <span className="truncate">{label}…</span></div>
}

/** Human-in-the-loop: the agent stopped to ask the operator something. */
export function AskCard() {
  const { pendingAsk } = useAssist()
  const [text, setText] = useState('')
  if (!pendingAsk) return null
  return (
    <div className="rise-in ml-10 rounded-2xl border border-sky-200 bg-sky-50/70 p-3.5 dark:border-sky-500/30 dark:bg-sky-500/10">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300">The agent needs your decision</div>
      <p className="mt-1 text-[13.5px] leading-relaxed text-content">{pendingAsk.question}</p>
      {pendingAsk.options.length ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {pendingAsk.options.map((o) => (
            <button key={o} type="button" onClick={() => assistStore.answerAsk(o)} className="rounded-lg border border-sky-300 bg-surface-raised px-3 py-1.5 text-[12.5px] font-medium text-sky-800 transition-colors hover:bg-sky-100 dark:border-sky-500/40 dark:text-sky-200 dark:hover:bg-sky-500/10">
              {o}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-2.5 flex gap-1.5">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) assistStore.answerAsk(text.trim()) }}
            placeholder="Your answer…"
            className="h-9 flex-1 rounded-lg border border-edge-default bg-surface-raised px-3 text-[13px] text-content focus:border-sky-400 focus:outline-none"
          />
          <button type="button" disabled={!text.trim()} onClick={() => assistStore.answerAsk(text.trim())} className="h-9 rounded-lg bg-sky-600 px-3 text-[12.5px] font-semibold text-white hover:bg-sky-700 disabled:opacity-40">
            Answer
          </button>
        </div>
      )}
    </div>
  )
}

function clock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
