import { cn } from '@adhar-console/utils'
import { assistStore, useAssist, type AgentInfo } from '../agui/store.ts'
import type { OperatorFinding, RuntimeInfo } from '../agui/client.ts'
import { useNotifications } from '../notifications.ts'
import type { CommandItem } from './nav.ts'
import { IconActivity, IconAt, IconBook, IconReturn, IconServer, IconShield, IconTool, SparkIcon } from './icons.tsx'
import { AdharAiMark } from './mark.tsx'
import { relTime } from './inspector.tsx'
import { accentDot, accentGradient, accentText } from './accent.ts'

/**
 * The empty state — the one moment the operator looks at Adhar AI with
 * nothing else in the way.
 *
 * It is built around the AGENTS, because that is what this surface is: not
 * one chat box but a roster of specialists, each with its own tools and its
 * own opening questions, and operators that keep watching the platform when
 * nobody is asking. So the page reads, top to bottom:
 *
 *   1. the hero band — the mark, one line about how it works, and one line
 *      of what the runtime is made of right now, stated by the runtime
 *      rather than by copy;
 *   2. what the operators noticed unprompted, and notifications that carry a
 *      prompt — each already a question worth asking;
 *   3. the roster — every agent as a card, the one you are talking to
 *      highlighted; picking one changes who answers;
 *   4. that agent's starters as prompt cards, with the conversations you
 *      had recently beside them so you can pick one back up.
 *
 * Container queries, not viewport breakpoints, decide the grid: the same
 * component renders in the ⌘K overlay and on the /ai page, and the overlay
 * is narrow on a wide screen.
 */
export function Welcome({
  configured,
  agent,
  agents,
  onPick,
  onAgent,
  navHint,
  findings,
  runtime,
}: {
  configured: boolean
  agent?: AgentInfo
  agents: AgentInfo[]
  onPick(prompt: string): void
  onAgent(id: string): void
  navHint?: CommandItem
  findings: OperatorFinding[]
  runtime: RuntimeInfo | null
}) {
  const notif = useNotifications()
  const { history } = useAssist()
  const insights = notif.items.filter((n) => !n.read && n.prompt).slice(0, 4)
  const starters = agent?.starters?.length ? agent.starters : FALLBACK_STARTERS
  const attention = findings.length + insights.length
  const recent = history.filter((t) => t.messages.length > 0).slice(0, 5)

  return (
    <div className="@container mx-auto w-full max-w-5xl pt-1">
      <Hero configured={configured} agents={agents} agent={agent} runtime={runtime} navHint={navHint} />

      {configured ? (
        <div className="mt-3 flex flex-col gap-3 @md:mt-4 @md:gap-4">
          {attention ? (
            <div className={cn('grid gap-3', findings.length && insights.length ? '@2xl:grid-cols-2' : '')}>
              {findings.length ? <OperatorFindings items={findings} onAsk={onPick} /> : null}
              {insights.length ? (
                <Card title={`Needs attention · ${insights.length}`} hint="from your notifications" tone="violet">
                  {insights.map((n) => (
                    <Row
                      key={n.id}
                      onClick={() => {
                        notif.markRead(n.id)
                        onPick(n.prompt!)
                      }}
                      dot={n.kind === 'error' ? 'bg-rose-500' : n.kind === 'warning' ? 'bg-amber-500' : 'bg-violet-500'}
                      title={n.title}
                      cta="Ask"
                    />
                  ))}
                </Card>
              ) : null}
            </div>
          ) : null}

          {/* The roster. On a phone it is a picker, not a directory: name,
              accent and tool count, two across — the descriptions that make it
              a reading exercise wait for a wider screen. It also sits BELOW the
              prompts there, because the prompts are what a person came to tap. */}
          {agents.length > 1 ? (
            <section className="rise-in order-2 @md:order-none">
              <SectionHead title="Your agents" hint="pick who answers · or mention one with @" />
              <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
                {agents.map((a) => (
                  <AgentCard key={a.id} agent={a} active={a.id === agent?.id} onSelect={() => onAgent(a.id)} />
                ))}
              </div>
            </section>
          ) : null}

          {/* starters for whoever is answering, and the conversations worth picking back up */}
          <div className={cn('grid gap-3', recent.length ? '@5xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]' : '')}>
            <section className="rise-in min-w-0">
              <SectionHead
                title={agent ? `Start with ${agent.name}` : 'Start here'}
                hint={agent?.description}
                accent={agent?.accent}
              />
              <div className={cn('grid grid-cols-1 gap-2', recent.length ? '' : '@xl:grid-cols-2')}>
                {starters.map((s, i) => (
                  <StarterCard key={s.label} index={i} label={s.label} prompt={s.prompt} agent={agent} onPick={() => onPick(s.prompt)} />
                ))}
              </div>
            </section>

            {recent.length ? (
              <section className="rise-in min-w-0">
                <SectionHead title="Pick up where you left off" hint="kept in this browser" />
                <div className="rounded-2xl border border-edge-default bg-surface-raised p-1.5">
                  {recent.map((t) => {
                    const who = agents.find((a) => a.id === t.agentId)
                    const last = [...t.messages].reverse().find((m) => m.role === 'assistant' && m.content)
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => assistStore.openThread(t.id)}
                        className="group flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-surface-sunken/70"
                      >
                        <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', accentDot(who?.accent))} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium text-content">{t.title}</span>
                          {last ? <span className="mt-0.5 line-clamp-1 text-[11px] text-content-subtle">{plainText(last.content)}</span> : null}
                          <span className="mt-0.5 block text-[10.5px] text-content-subtle">
                            {who?.name ? `${who.name} · ` : ''}{relTime(t.updatedAt)} · {t.messages.length} turn{t.messages.length === 1 ? '' : 's'}
                          </span>
                        </span>
                        <span className="mt-1 shrink-0 text-[11px] font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-brand-300">Resume →</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────────────────────────── hero ─────────────────────────────── */

/**
 * The band at the top: the mark, one line, and one row of facts. Everything
 * here is either the runtime stating what it is made of right now, or the
 * one sentence a person needs before they type. The three-step explainer and
 * the grid of counters that used to sit here were more to read than the
 * agents beneath, which is the wrong way round on an empty page.
 */
function Hero({ configured, agents, agent, runtime, navHint }: { configured: boolean; agents: AgentInfo[]; agent?: AgentInfo; runtime: RuntimeInfo | null; navHint?: CommandItem }) {
  return (
    <section className="rise-in relative overflow-hidden rounded-3xl border border-edge-default bg-surface-raised">
      <div aria-hidden className="pointer-events-none absolute -left-24 -top-32 h-72 w-72 rounded-full bg-brand-500/12 blur-3xl dark:bg-brand-500/15" />
      <div aria-hidden className="pointer-events-none absolute -right-20 -bottom-28 h-64 w-64 rounded-full bg-accent-500/10 blur-3xl dark:bg-accent-500/12" />
      <div className="relative flex flex-col gap-3 p-4 @md:gap-4 @md:p-5 @2xl:flex-row @2xl:items-center @2xl:gap-6 @2xl:p-6">
        <AdharAiMark size={48} className="shrink-0 @md:hidden" />
        <AdharAiMark size={64} className="hidden shrink-0 @md:inline-flex" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[21px] font-semibold leading-tight tracking-tight text-content @md:text-[24px] @2xl:text-[26px]">
              {configured ? 'Ask, investigate, propose.' : 'Where would you like to go?'}
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-edge-subtle bg-surface-app/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
              <SparkIcon size={9} /> Adhar AI
            </span>
          </div>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-content-muted">
            {configured
              ? `${agents.length || 'Specialist'} agents read your cluster, delivery, policies and cost with your permissions, cite the platform’s own knowledge, and turn any change into a pull request for you to review.`
              : 'AI isn’t configured on this cluster yet (set AI_BASE_URL / AI_MODEL). Type any page, app or setting to jump straight to it.'}
          </p>
          {!configured && navHint ? (
            <div className="mt-3 text-[12px] text-content-muted">
              Press <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⏎</kbd> to open{' '}
              <span className="font-medium text-content">{navHint.label}</span>
            </div>
          ) : null}
          {configured ? <FactsLine runtime={runtime} agent={agent} agents={agents} /> : null}
        </div>
      </div>
    </section>
  )
}

/**
 * What the assistant is made of, right now, as one line of facts. Every
 * number is live from the runtime; when it is not configured the line says
 * what the console's own agents can do instead of showing empty counters.
 */
function FactsLine({ runtime, agent, agents }: { runtime: RuntimeInfo | null; agent?: AgentInfo; agents: AgentInfo[] }) {
  const consoleTools = agents.reduce((n, a) => n + (a.delegated ? 0 : a.tools), 0) || agent?.tools || 0
  const live = Boolean(runtime?.configured && runtime.reachable)
  const down = runtime?.configured && runtime.reachable === false
  const bad = Object.keys(runtime?.mcp?.unreachable ?? {}).length
  const facts: Array<{ icon: React.ReactNode; text: string; tone?: 'ok' | 'bad' }> = live
    ? [
        { icon: <IconServer size={11} />, text: `${runtime!.mcp?.connected.length ?? 0} MCP servers${bad ? ` · ${bad} down` : ''}`, tone: bad ? 'bad' : 'ok' },
        { icon: <IconTool size={11} />, text: `${runtime!.tools?.length ?? 0} tools` },
        // The runtime can report a long sentence here ("lexical over pgvector
        // (no embeddings configured)"); the line is a glance, not a log.
        { icon: <IconBook size={11} />, text: runtime!.rag ? `grounded · ${runtime!.rag.split(/[(,]/)[0].trim()}` : 'grounded in platform knowledge' },
        { icon: <IconShield size={11} />, text: 'changes become pull requests' },
      ]
    : down
      ? [
          { icon: <IconServer size={11} />, text: 'runtime unreachable — console agents still answer', tone: 'bad' },
          { icon: <IconTool size={11} />, text: `${consoleTools} console tools` },
          { icon: <IconShield size={11} />, text: 'reads with your RBAC · proposals only' },
        ]
      : [
          { icon: <IconTool size={11} />, text: `${consoleTools} console tools · ${agents.length} agents` },
          { icon: <IconShield size={11} />, text: 'reads with your RBAC · proposals only' },
        ]
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-content-muted">
      <span className={cn('inline-flex items-center gap-1.5 font-medium', live ? 'text-emerald-700 dark:text-emerald-300' : down ? 'text-rose-700 dark:text-rose-300' : 'text-content')}>
        <span className="relative flex h-1.5 w-1.5">
          {live ? <span aria-hidden className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /> : null}
          <span className={cn('relative h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-500' : down ? 'bg-rose-500' : 'bg-content-subtle')} />
        </span>
        {live ? 'Runtime live' : down ? 'Runtime down' : 'Console agents'}
      </span>
      {facts.map((f, i) => (
        <span key={i} className={cn('inline-flex items-center gap-1.5', f.tone === 'bad' && 'text-rose-700 dark:text-rose-300')}>
          <span className={cn(f.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-content-subtle')}>{f.icon}</span>
          {f.text}
        </span>
      ))}
    </div>
  )
}

/* ─────────────────────────────── roster ─────────────────────────────── */

/**
 * One agent on the roster. The tile is the agent's accent as a gradient with
 * its icon (or initial) in it; the footer says how many tools it has and
 * whether the external runtime handles it. Active = the one the composer
 * will send to, marked by a hairline of its accent along the top.
 */
function AgentCard({ agent, active, onSelect }: { agent: AgentInfo; active: boolean; onSelect(): void }) {
  const glyph = agent.icon && agent.icon.length <= 2 ? agent.icon : agent.name.slice(0, 1).toUpperCase()
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      title={active ? `${agent.name} is answering` : `Ask ${agent.name}`}
      className={cn(
        'group relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-2xl border p-2.5 pt-3 text-left transition-[border-color,box-shadow,transform] duration-150 @md:gap-2 @md:p-3 @md:pt-3.5',
        active
          ? 'border-brand-400 bg-surface-raised shadow-md shadow-brand-600/10 ring-1 ring-brand-400 dark:border-brand-500/60 dark:ring-brand-500/60'
          : 'border-edge-default bg-surface-raised hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md',
      )}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-0.5 bg-linear-to-r transition-opacity', accentGradient(agent.accent), active ? 'opacity-100' : 'opacity-0 group-hover:opacity-60')} />
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br text-[12px] font-semibold text-white shadow-sm @md:h-9 @md:w-9 @md:rounded-xl @md:text-[13px]',
            accentGradient(agent.accent),
          )}
        >
          {glyph}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-content">{agent.name}</span>
          <span className={cn('block text-[10px] font-medium uppercase tracking-wider', active ? accentText(agent.accent) : 'text-content-subtle')}>
            {active ? 'answering' : agent.delegated ? 'runtime agent' : 'console agent'}
          </span>
        </span>
      </div>
      <p className="hidden min-h-[2.6em] line-clamp-2 text-[11.5px] leading-snug text-content-muted @md:block">{agent.description}</p>
      <div className="flex items-center gap-2 text-[10.5px] text-content-subtle">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <IconTool size={10} /> {agent.tools} {agent.tools === 1 ? 'tool' : 'tools'}
        </span>
        <span className="hidden min-w-0 items-center gap-1 truncate font-mono @lg:inline-flex">
          <IconAt size={9} />{agent.id}
        </span>
        <span className={cn('ml-auto text-[10.5px] font-medium transition-opacity', active ? cn('opacity-100', accentText(agent.accent)) : 'text-brand-600 opacity-0 group-hover:opacity-100 dark:text-brand-300')}>
          {active ? 'selected' : 'Ask →'}
        </span>
      </div>
    </button>
  )
}

/* ─────────────────────────────── starters ─────────────────────────────── */

/** One opening question as a card: the label is the question, the prompt is what will be sent. */
function StarterCard({ index, label, prompt, agent, onPick }: { index: number; label: string; prompt: string; agent?: AgentInfo; onPick(): void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="group relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-2xl border border-edge-default bg-surface-raised p-3.5 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md dark:hover:border-brand-500/40"
    >
      <span className="flex items-center gap-2">
        <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-linear-to-br text-[10px] font-semibold text-white', accentGradient(agent?.accent))}>
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-content">{label}</span>
      </span>
      <span className="line-clamp-2 text-[11.5px] leading-snug text-content-subtle">{prompt}</span>
      <span className="mt-auto flex items-center justify-between pt-1 text-[10.5px] text-content-subtle">
        <span className="inline-flex items-center gap-1"><IconActivity size={10} /> {agent ? `Asks ${agent.name}` : 'Ask'}</span>
        <span className="inline-flex items-center gap-1 text-brand-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-brand-300">
          Send <IconReturn size={10} />
        </span>
      </span>
    </button>
  )
}

/* ─────────────────────────────── attention ─────────────────────────────── */

/**
 * What the platform's operators concluded while nobody was watching — the
 * proactive half of the agentic platform, surfaced where an operator is
 * already looking for what to ask.
 */
function OperatorFindings({ items, onAsk }: { items: OperatorFinding[]; onAsk(prompt: string): void }) {
  const dot = (f: OperatorFinding) => {
    const s = (f.severity ?? '').toLowerCase()
    return s === 'critical' || s === 'error' ? 'bg-rose-500' : s === 'warning' || s === 'warn' ? 'bg-amber-500' : 'bg-sky-500'
  }
  return (
    <Card title={`Adhar AI noticed · ${items.length}`} hint="from the platform operators, unprompted">
      {items.slice(0, 6).map((f, i) => {
        const title = f.title ?? f.summary ?? 'Finding'
        return (
          <Row
            key={f.id ?? i}
            dot={dot(f)}
            title={title}
            meta={f.operator}
            cta="Investigate"
            onClick={() => onAsk(`Investigate this finding from the ${f.operator ?? 'platform'} operator and tell me what to do about it: ${title}${f.summary && f.summary !== title ? ` — ${f.summary}` : ''}`)}
          />
        )
      })}
    </Card>
  )
}

/* ─────────────────────────────── primitives ─────────────────────────────── */

function SectionHead({ title, hint, accent }: { title: string; hint?: string; accent?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
      <h3 className="inline-flex shrink-0 items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle">
        {accent ? <span className={cn('h-1.5 w-1.5 rounded-full', accentDot(accent))} /> : null}
        {title}
      </h3>
      {hint ? <span className="min-w-0 truncate text-[11px] text-content-subtle" title={hint}>{hint}</span> : null}
    </div>
  )
}

function Card({
  title,
  hint,
  tone,
  accent,
  children,
}: {
  title: string
  hint?: string
  tone?: 'violet'
  /** An agent accent: draws the card's eyebrow dot in it. */
  accent?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('rise-in rounded-2xl border p-2.5', tone === 'violet' ? 'border-violet-200 bg-violet-50/50 dark:border-violet-500/30 dark:bg-violet-500/10' : 'border-edge-default bg-surface-raised')}>
      <div className={cn('mb-1 flex items-baseline justify-between gap-2 px-2 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wider', tone === 'violet' ? 'text-violet-700 dark:text-violet-300' : 'text-content-subtle')}>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          {accent ? <span className={cn('h-1.5 w-1.5 rounded-full', accentDot(accent))} /> : null}
          {title}
        </span>
        {hint ? <span className="min-w-0 truncate font-normal normal-case tracking-normal text-content-subtle" title={hint}>{hint}</span> : null}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function Row({ dot, title, meta, cta, onClick }: { dot: string; title: string; meta?: string; cta: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-sunken/70">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-content">{title}</span>
      {meta ? <span className="hidden shrink-0 font-mono text-[10px] text-content-subtle sm:inline">{meta}</span> : null}
      <span className="shrink-0 text-[11px] text-brand-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-brand-300">{cta} →</span>
    </button>
  )
}

/** Markdown → one line of plain text: drop heading/emphasis/code marks and list bullets, keep hyphens inside words. */
export function plainText(md: string, max = 160): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

const FALLBACK_STARTERS = [
  { label: 'What needs my attention right now?', prompt: 'Scan the cluster for Warning events and unhealthy workloads, then tell me what needs attention first.' },
  { label: 'Why is a pod crash-looping?', prompt: 'Find pods in CrashLoopBackOff or ImagePullBackOff, diagnose the worst one and explain the root cause.' },
  { label: 'What is out of sync in Argo CD?', prompt: 'List Argo CD applications that are OutOfSync or Degraded and explain the most likely cause for each.' },
  { label: 'Where is the money going?', prompt: 'Show the namespaces with the highest resource requests versus actual usage and suggest right-sizing.' },
]
