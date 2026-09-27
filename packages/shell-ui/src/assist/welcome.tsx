import { cn } from '@adhar-console/utils'
import type { AgentInfo } from '../agui/store.ts'
import type { OperatorFinding, RuntimeInfo } from '../agui/client.ts'
import { useNotifications } from '../notifications.ts'
import type { CommandItem } from './nav.ts'
import { IconBook, IconServer, IconShield, IconTool, SparkIcon } from './icons.tsx'
import { AdharAiMark } from './mark.tsx'
import { accentDot } from './accent.ts'

/**
 * The empty state — the one moment the operator looks at Adhar AI with
 * nothing else in the way, and the moment most worth keeping quiet.
 *
 * It is the mark, one line about how it works, one line of what the runtime
 * is made of right now, and anything the platform's own operators noticed
 * unprompted. Nothing else.
 *
 * It used to carry three more blocks — a card per agent, that agent's
 * starter prompts, and the conversations you had recently. Every one of them
 * duplicated a control that was already on screen: the composer has the
 * agent switcher and @mentions, and ⌘[ opens the conversation rail. What
 * they added instead was height and repetition — eight near-identical boxes
 * and a heading over each — on a page whose whole job is to get out of the
 * way of the composer underneath it.
 *
 * Container queries, not viewport breakpoints: the same component renders in
 * the ⌘K overlay and on the /ai page, and the overlay is narrow on a wide
 * screen.
 */
export function Welcome({
  configured,
  agent,
  agents,
  onPick,
  navHint,
  findings,
  runtime,
}: {
  configured: boolean
  agent?: AgentInfo
  agents: AgentInfo[]
  onPick(prompt: string): void
  navHint?: CommandItem
  findings: OperatorFinding[]
  runtime: RuntimeInfo | null
}) {
  const notif = useNotifications()
  const insights = notif.items.filter((n) => !n.read && n.prompt).slice(0, 4)
  const attention = findings.length + insights.length

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

