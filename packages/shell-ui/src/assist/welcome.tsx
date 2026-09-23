import { cn } from '@adhar-console/utils'
import type { AgentInfo } from '../agui/store.ts'
import type { OperatorFinding, RuntimeInfo } from '../agui/client.ts'
import { useNotifications } from '../notifications.ts'
import type { CommandItem } from './nav.ts'
import { IconBook, IconReturn, IconServer, IconShield, IconTool, SparkIcon } from './icons.tsx'
import { AdharAiMark } from './mark.tsx'
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
 *   1. the mark and one line about how it works, with the runtime's live
 *      facts (servers, tools, grounding, write policy) as a strip of pills —
 *      what it is made of, stated by the runtime rather than by copy;
 *   2. what the operators noticed unprompted, and notifications that carry a
 *      prompt — each already a question worth asking;
 *   3. the roster — every agent as a card, the one you are talking to
 *      highlighted; picking one changes who answers;
 *   4. that agent's starters, as two columns of prompts.
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
  const insights = notif.items.filter((n) => !n.read && n.prompt).slice(0, 4)
  const starters = agent?.starters?.length ? agent.starters : FALLBACK_STARTERS
  const attention = findings.length + insights.length

  return (
    <div className="@container mx-auto w-full max-w-4xl pt-2">
      {/* hero */}
      <div className="rise-in flex flex-col items-center pb-5 pt-2 text-center">
        <AdharAiMark size={64} />
        <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-edge-subtle bg-surface-raised/70 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
          <SparkIcon size={10} /> Adhar AI
        </div>
        <h2 className="mt-2.5 text-[24px] font-semibold tracking-tight text-content">
          {configured ? 'Ask, investigate, propose.' : 'Where would you like to go?'}
        </h2>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-content-muted">
          {configured
            ? `${agents.length || 'Your'} specialist agents read the cluster, delivery, policies and cost with your permissions, ground what they say in the platform’s own knowledge, and turn any change into a pull request for you to review.`
            : 'AI isn’t configured on this cluster yet (set AI_BASE_URL / AI_MODEL). Type any page, app or setting to jump straight to it.'}
        </p>
        {!configured && navHint ? (
          <div className="mt-4 text-[12px] text-content-muted">
            Press <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⏎</kbd> to open{' '}
            <span className="font-medium text-content">{navHint.label}</span>
          </div>
        ) : null}
        {configured ? <CapabilityStrip runtime={runtime} agent={agent} /> : null}
      </div>

      {configured ? (
        <div className="space-y-4">
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

          {/* the roster */}
          {agents.length > 1 ? (
            <section className="rise-in">
              <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
                <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle">
                  Your agents
                </h3>
                <span className="text-[11px] text-content-subtle">pick who answers · or mention one with @</span>
              </div>
              <div className="grid grid-cols-1 gap-2 @md:grid-cols-2 @3xl:grid-cols-4">
                {agents.map((a) => (
                  <AgentCard key={a.id} agent={a} active={a.id === agent?.id} onSelect={() => onAgent(a.id)} />
                ))}
              </div>
            </section>
          ) : null}

          {/* starters for whoever is answering */}
          <Card
            title={agent ? `Start with ${agent.name}` : 'Start here'}
            hint={agent?.description}
            accent={agent?.accent}
          >
            <div className="grid grid-cols-1 gap-0.5 @2xl:grid-cols-2">
              {starters.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => onPick(s.prompt)}
                  className="group flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-brand-50/60 dark:hover:bg-brand-500/10"
                >
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium text-content">{s.label}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-content-subtle">{s.prompt}</span>
                  </span>
                  <span className="mt-1 shrink-0 text-content-subtle opacity-0 transition-opacity group-hover:opacity-100">
                    <IconReturn size={11} />
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One agent on the roster. The tile is the agent's accent as a gradient with
 * its icon (or initial) in it; the footer says how many tools it has and
 * whether the external runtime handles it. Active = the one the composer
 * will send to.
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
        'group relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-xl border p-3 text-left transition-[border-color,box-shadow,transform] duration-150',
        active
          ? 'border-brand-400 bg-surface-raised shadow-md shadow-brand-600/10 ring-1 ring-brand-400 dark:border-brand-500/60 dark:ring-brand-500/60'
          : 'border-edge-default bg-surface-raised hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br text-[13px] font-semibold text-white shadow-sm',
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
      <p className="line-clamp-2 min-h-[2.6em] text-[11.5px] leading-snug text-content-muted">{agent.description}</p>
      <div className="flex items-center gap-2 text-[10.5px] text-content-subtle">
        <span className="inline-flex items-center gap-1">
          <IconTool size={10} /> {agent.tools} {agent.tools === 1 ? 'tool' : 'tools'}
        </span>
        <span className={cn('ml-auto h-1.5 w-1.5 rounded-full', accentDot(agent.accent))} />
      </div>
    </button>
  )
}

/**
 * What the assistant is made of, right now — as pills under the headline.
 *
 * Every number here is live from the runtime: MCP servers with sessions open,
 * tools they expose, how grounding is retrieved, what a write turns into.
 * When the runtime is not configured it says what the console's own agents
 * can do instead, rather than showing empty counters.
 */
function CapabilityStrip({ runtime, agent }: { runtime: RuntimeInfo | null; agent?: AgentInfo }) {
  const items: Array<{ icon: React.ReactNode; label: string; value: string; tone?: 'ok' | 'bad' }> = []
  if (runtime?.configured && runtime.reachable) {
    const bad = Object.keys(runtime.mcp?.unreachable ?? {}).length
    items.push({ icon: <IconServer size={11} />, label: 'MCP servers', value: `${runtime.mcp?.connected.length ?? 0} live${bad ? ` · ${bad} down` : ''}`, tone: bad ? 'bad' : 'ok' })
    items.push({ icon: <SparkIcon size={11} />, label: 'Tools', value: `${runtime.tools?.length ?? 0} across ${new Set((runtime.tools ?? []).map((t) => t.split('_')[0])).size} domains` })
    items.push({ icon: <IconBook size={11} />, label: 'Knowledge', value: runtime.rag ? `grounded · ${runtime.rag}` : 'grounded' })
    items.push({ icon: <IconShield size={11} />, label: 'Writes', value: 'pull requests only' })
  } else if (runtime?.configured && runtime.reachable === false) {
    items.push({ icon: <IconServer size={11} />, label: 'Runtime', value: 'unreachable', tone: 'bad' })
    items.push({ icon: <IconShield size={11} />, label: 'Access', value: 'reads with your RBAC' })
  } else {
    items.push({ icon: <SparkIcon size={11} />, label: 'Tools', value: `${agent?.tools ?? 0} console tools` })
    items.push({ icon: <IconShield size={11} />, label: 'Access', value: 'reads with your RBAC' })
    items.push({ icon: <IconShield size={11} />, label: 'Writes', value: 'proposals only' })
  }
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
      {items.map((it) => (
        <span
          key={it.label}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
            it.tone === 'bad'
              ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300'
              : 'border-edge-subtle bg-surface-raised/70 text-content-muted',
          )}
        >
          <span className={cn(it.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : it.tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : 'text-content-subtle')}>{it.icon}</span>
          <span className="text-content-subtle">{it.label}</span>
          <span className="font-medium text-content">{it.value}</span>
        </span>
      ))}
    </div>
  )
}

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

const FALLBACK_STARTERS = [
  { label: 'What needs my attention right now?', prompt: 'Scan the cluster for Warning events and unhealthy workloads, then tell me what needs attention first.' },
  { label: 'Why is a pod crash-looping?', prompt: 'Find pods in CrashLoopBackOff or ImagePullBackOff, diagnose the worst one and explain the root cause.' },
  { label: 'What is out of sync in Argo CD?', prompt: 'List Argo CD applications that are OutOfSync or Degraded and explain the most likely cause for each.' },
  { label: 'Where is the money going?', prompt: 'Show the namespaces with the highest resource requests versus actual usage and suggest right-sizing.' },
]
