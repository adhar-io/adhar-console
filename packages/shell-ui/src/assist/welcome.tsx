import { cn } from '@adhar-console/utils'
import type { AgentInfo } from '../agui/store.ts'
import type { OperatorFinding, RuntimeInfo } from '../agui/client.ts'
import { useNotifications } from '../notifications.ts'
import type { CommandItem } from './nav.ts'
import { IconBook, IconReturn, IconServer, IconShield, SparkIcon } from './icons.tsx'
import { AdharAiMark } from './mark.tsx'
import { accentDot } from './accent.ts'

/**
 * The empty state — the one moment the operator looks at Adhar AI with
 * nothing else in the way.
 *
 * It leads with what needs attention (operator findings, then notifications
 * that carry a prompt), because each of those is a question already worth
 * asking. Below that, the agent's starters and a strip that states plainly
 * what the runtime is made of right now — MCP servers, tools, how grounding
 * works — so "what can you do" is answered by the runtime, not by copy.
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
    <div className="mx-auto w-full max-w-3xl pt-2">
      {/* hero */}
      <div className="rise-in flex flex-col items-center pb-6 pt-4 text-center">
        <AdharAiMark size={58} className="shadow-lg shadow-brand-600/25" />
        <h2 className="mt-4 text-[22px] font-semibold tracking-tight text-content">
          {configured ? 'What would you like to know?' : 'Where would you like to go?'}
        </h2>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-content-muted">
          {configured
            ? 'I investigate your cluster, delivery, policies and cost with your permissions, ground what I say in the platform’s own knowledge, show evidence as live components — and any change I make becomes a pull request for you to review.'
            : 'AI isn’t configured on this cluster yet (set AI_BASE_URL / AI_MODEL). Type any page, app or setting to jump straight to it.'}
        </p>
        {!configured && navHint ? (
          <div className="mt-4 text-[12px] text-content-muted">Press <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⏎</kbd> to open <span className="font-medium text-content">{navHint.label}</span></div>
        ) : null}
      </div>

      {configured ? (
        <div className={cn('grid gap-4', attention ? 'lg:grid-cols-[1.1fr_1fr]' : '')}>
          {attention ? (
            <div className="min-w-0 space-y-3">
              {findings.length ? <OperatorFindings items={findings} onAsk={onPick} /> : null}
              {insights.length ? (
                <Card title={`Needs attention · ${insights.length}`} hint="from your notifications" tone="violet">
                  {insights.map((n) => (
                    <Row key={n.id} onClick={() => { notif.markRead(n.id); onPick(n.prompt!) }} dot={n.kind === 'error' ? 'bg-rose-500' : n.kind === 'warning' ? 'bg-amber-500' : 'bg-violet-500'} title={n.title} cta="Ask" />
                  ))}
                </Card>
              ) : null}
            </div>
          ) : null}

          <div className="min-w-0 space-y-3">
            <Card title={agent ? `Start with ${agent.name}` : 'Start here'} hint={agent?.description}>
              {starters.map((s) => (
                <button key={s.label} type="button" onClick={() => onPick(s.prompt)} className="group flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-brand-50/60 dark:hover:bg-brand-500/10">
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium text-content">{s.label}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-content-subtle">{s.prompt}</span>
                  </span>
                  <span className="mt-1 shrink-0 text-content-subtle opacity-0 transition-opacity group-hover:opacity-100"><IconReturn size={11} /></span>
                </button>
              ))}
            </Card>

            {agents.length > 1 ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1 px-1 text-[11px] text-content-subtle">
                <span className="mr-1">Or ask</span>
                {agents.filter((a) => a.id !== agent?.id).map((a) => (
                  <button key={a.id} type="button" onClick={() => onAgent(a.id)} title={a.description} className="inline-flex items-center gap-1.5 rounded-md border border-edge-subtle bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-content-muted transition-colors hover:border-edge-default hover:text-content">
                    <span className={cn('h-1.5 w-1.5 rounded-full', accentDot(a.accent))} /> {a.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {configured ? <CapabilityStrip runtime={runtime} agent={agent} /> : null}
    </div>
  )
}

/**
 * What the assistant is made of, right now.
 *
 * Every number here is live from the runtime — MCP servers with sessions open,
 * tools they expose, how grounding is retrieved. When the runtime is not
 * configured it says what the console's own agents can do instead, rather
 * than showing empty counters.
 */
function CapabilityStrip({ runtime, agent }: { runtime: RuntimeInfo | null; agent?: AgentInfo }) {
  const items: Array<{ icon: React.ReactNode; label: string; value: string; tone?: 'ok' | 'bad' }> = []
  if (runtime?.configured && runtime.reachable) {
    const bad = Object.keys(runtime.mcp?.unreachable ?? {}).length
    items.push({ icon: <IconServer size={12} />, label: 'MCP servers', value: `${runtime.mcp?.connected.length ?? 0} live${bad ? ` · ${bad} down` : ''}`, tone: bad ? 'bad' : 'ok' })
    items.push({ icon: <SparkIcon size={12} />, label: 'Tools', value: `${runtime.tools?.length ?? 0} across ${new Set((runtime.tools ?? []).map((t) => t.split('_')[0])).size} domains` })
    items.push({ icon: <IconBook size={12} />, label: 'Knowledge', value: runtime.rag ? `grounded · ${runtime.rag}` : 'grounded' })
    items.push({ icon: <IconShield size={12} />, label: 'Writes', value: 'pull requests only' })
  } else if (runtime?.configured && runtime.reachable === false) {
    items.push({ icon: <IconServer size={12} />, label: 'Runtime', value: 'unreachable', tone: 'bad' })
  } else {
    items.push({ icon: <SparkIcon size={12} />, label: 'Tools', value: `${agent?.tools ?? 0} console tools` })
    items.push({ icon: <IconShield size={12} />, label: 'Access', value: 'reads with your RBAC' })
    items.push({ icon: <IconShield size={12} />, label: 'Writes', value: 'proposals only' })
  }
  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 border-t border-edge-subtle pt-4 text-[11px] text-content-subtle">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className={cn(it.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : it.tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : 'text-content-subtle')}>{it.icon}</span>
          <span>{it.label}</span>
          <span className="font-medium text-content-muted">{it.value}</span>
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

function Card({ title, hint, tone, children }: { title: string; hint?: string; tone?: 'violet'; children: React.ReactNode }) {
  return (
    <div className={cn('rise-in rounded-2xl border p-2.5', tone === 'violet' ? 'border-violet-200 bg-violet-50/50 dark:border-violet-500/30 dark:bg-violet-500/10' : 'border-edge-default bg-surface-raised')}>
      <div className={cn('mb-1 flex items-baseline justify-between gap-2 px-2 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wider', tone === 'violet' ? 'text-violet-700 dark:text-violet-300' : 'text-content-subtle')}>
        <span className="shrink-0">{title}</span>
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
