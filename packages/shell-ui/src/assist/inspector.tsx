import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import { assistStore, AUTONOMY_LEVELS, useAssist, type AdharAiRunInfo, type Finding, type PlanStep, type UiBlock } from '../agui/store.ts'
import { GenerativeBlock } from '../agui/generative.tsx'
import type { KnowledgeHit } from '../agui/client.ts'
import type { CommandItem } from './nav.ts'
import { toolDomain } from './tool-label.ts'
import { IconActivity, IconBook, IconCanvas, IconCompass, IconDot, IconReturn, IconSearch, IconServer } from './icons.tsx'
import { accentDot } from './accent.ts'

/**
 * The inspector — everything about the conversation that is not the
 * conversation.
 *
 *   Run        the live agent: plan, findings, tool count, provenance
 *   Knowledge  the platform's memory: search it, see how it is retrieved
 *   Tools      the runtime's real capabilities: MCP servers, tools, operators
 *   Canvas     every visual this thread produced, as a board
 *   Navigate   the command palette lane
 *
 * Tabs, not sections, because each answers a different question and an
 * operator asks one at a time. The Run tab lights up while a run is live so
 * the eye is drawn there without being dragged there.
 */

export type InspectorTab = 'run' | 'knowledge' | 'tools' | 'canvas' | 'navigate'

export function Inspector({
  tab,
  onTab,
  nav,
  canvasBlocks,
  onAskAbout,
}: {
  tab: InspectorTab
  onTab(t: InspectorTab): void
  nav: {
    results: CommandItem[]
    query: string
    active: number
    all: CommandItem[]
    onHover(i: number): void
    onPick(item: CommandItem): void
  }
  canvasBlocks: UiBlock[]
  onAskAbout(text: string): void
}) {
  const { busy, runtime, knowledge } = useAssist()
  const tabs: Array<{ id: InspectorTab; label: string; icon: ReactNode; badge?: ReactNode; live?: boolean }> = [
    { id: 'run', label: 'Run', icon: <IconActivity size={12} />, live: busy },
    { id: 'knowledge', label: 'Knowledge', icon: <IconBook size={12} />, badge: knowledge.hits.length ? knowledge.hits.length : undefined },
    { id: 'tools', label: 'Tools', icon: <IconServer size={12} />, badge: runtime?.tools?.length || undefined },
    { id: 'canvas', label: 'Canvas', icon: <IconCanvas size={12} />, badge: canvasBlocks.length || undefined },
    { id: 'navigate', label: 'Go to', icon: <IconCompass size={12} />, badge: nav.query.trim() ? nav.results.length : undefined },
  ]
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-edge-subtle bg-surface-raised/50">
      <div className="flex items-center gap-0.5 border-b border-edge-subtle p-1.5" role="tablist" aria-label="Inspector">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            title={t.label}
            // The active tab carries its label; the rest are icons with a
            // tooltip. Five labelled tabs do not fit a 340px rail without
            // wrapping, and a wrapped "Go / to" is worse than an icon.
            className={cn(
              'relative flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[11px] font-medium transition-colors',
              tab === t.id ? 'flex-[2] bg-surface-raised px-2 text-content shadow-sm ring-1 ring-edge-default' : 'flex-1 px-1 text-content-muted hover:text-content',
            )}
          >
            {t.icon}
            {tab === t.id ? <span>{t.label}</span> : null}
            {t.badge ? <span className="rounded-full bg-surface-sunken px-1 text-[9.5px] tabular-nums text-content-subtle">{t.badge}</span> : null}
            {t.live && tab !== t.id ? <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {tab === 'run' ? <RunTab /> : null}
        {tab === 'knowledge' ? <KnowledgeTab onAskAbout={onAskAbout} /> : null}
        {tab === 'tools' ? <ToolsTab /> : null}
        {tab === 'canvas' ? <CanvasTab blocks={canvasBlocks} /> : null}
        {tab === 'navigate' ? <NavTab {...nav} /> : null}
      </div>
    </aside>
  )
}

/* ───────────────────────────────── Run ───────────────────────────────── */

const SEVERITY_DOT: Record<Finding['severity'], string> = {
  critical: 'bg-rose-500',
  warning: 'bg-amber-500',
  info: 'bg-sky-500',
  ok: 'bg-emerald-500',
}

function Section({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </section>
  )
}

function RunTab() {
  const { run, agents, agentId, busy, thread } = useAssist()
  const agent = agents.find((a) => a.id === agentId)
  if (!run && !busy) {
    return (
      <div className="space-y-3">
        {agent ? (
          <div className="rounded-xl border border-edge-subtle bg-surface-raised p-3">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-content">
              <span className={cn('h-2 w-2 rounded-full', accentDot(agent.accent))} />
              {agent.name}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-content-muted">{agent.description}</p>
            <div className="mt-2 text-[10.5px] text-content-subtle">
              {agent.delegated ? 'Runs on the adhar-ai runtime · MCP tools · knowledge-grounded' : `${agent.tools} console tools · reads with your RBAC`}
            </div>
          </div>
        ) : null}
        <p className="px-1 text-[11.5px] leading-relaxed text-content-subtle">
          {thread.messages.length ? 'The last run has finished. Ask something and its plan, findings and provenance appear here as it works.' : 'While an agent works, its plan, findings and audit trail appear here.'}
        </p>
      </div>
    )
  }
  const plan = run?.plan ?? []
  const findings = run?.findings ?? []
  const phase = run?.phase ?? (busy ? 'working' : 'idle')
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-edge-subtle bg-surface-raised px-3 py-2">
        <span className="flex items-center gap-2 text-[12.5px] font-semibold text-content">
          {run?.agent ? <span className={cn('h-2 w-2 rounded-full', accentDot(run.agent.accent))} /> : null}
          {run?.agent?.name ?? agent?.name ?? 'Agent'}
        </span>
        <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium capitalize', phase === 'error' ? 'text-rose-600 dark:text-rose-400' : phase === 'done' ? 'text-emerald-600 dark:text-emerald-400' : 'text-brand-600 dark:text-brand-400')}>
          {busy && phase !== 'done' && phase !== 'error' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
          {phase.replace('-', ' ')}
        </span>
      </div>

      {plan.length ? (
        <Section title="Plan" right={<span className="tabular-nums">{plan.filter((s) => s.status === 'done').length}/{plan.length}</span>}>
          <ol className="space-y-1 rounded-xl border border-edge-subtle bg-surface-raised p-2">
            {plan.map((s) => <PlanRow key={s.id} step={s} />)}
          </ol>
        </Section>
      ) : null}

      {findings.length ? (
        <Section title={`Findings · ${findings.length}`}>
          <ul className="space-y-1">
            {findings.map((f) => (
              <li key={f.id} className="rounded-xl border border-edge-subtle bg-surface-raised p-2.5">
                <div className="flex items-start gap-2">
                  <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[f.severity] ?? 'bg-slate-400')} />
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium leading-snug text-content">{f.title}</div>
                    {f.detail ? <div className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-content-muted">{f.detail}</div> : null}
                    {f.resource?.name ? (
                      <div className="mt-1 truncate font-mono text-[10px] text-content-subtle">
                        {f.resource.kind}/{f.resource.name}{f.resource.namespace ? ` · ${f.resource.namespace}` : ''}
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {run?.tools?.called ? (
        <div className="px-1 text-[11px] text-content-subtle">
          {run.tools.called} tool call{run.tools.called === 1 ? '' : 's'}
          {run.tools.failed ? <span className="text-rose-600 dark:text-rose-400"> · {run.tools.failed} failed</span> : null}
          {run.tools.last ? <span> · last <span className="font-mono">{run.tools.last}</span></span> : null}
        </div>
      ) : null}

      {run?.adharAi ? <Provenance info={run.adharAi} /> : null}
    </div>
  )
}

function PlanRow({ step }: { step: PlanStep }) {
  const icon = step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'active' ? '' : '○'
  return (
    <li className="flex items-start gap-2 px-1 text-[12px]">
      <span className={cn('mt-px w-3 shrink-0 text-center font-semibold', step.status === 'done' ? 'text-emerald-600 dark:text-emerald-400' : step.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-content-subtle')} aria-hidden>
        {step.status === 'active' ? <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : icon}
      </span>
      <span className={cn('min-w-0 leading-snug', step.status === 'done' ? 'text-content-muted line-through decoration-content-subtle/40' : step.status === 'active' ? 'font-medium text-content' : 'text-content-muted')}>
        {step.label}
      </span>
    </li>
  )
}

/**
 * What a delegated run actually did — the audit trail.
 *
 * Every field is reported by the runtime, not assumed. `autonomy` is what was
 * GRANTED; when that is less than asked for, saying so is the difference
 * between "the agent decided not to" and "the agent was not allowed to".
 */
function Provenance({ info }: { info: AdharAiRunInfo }) {
  const downgraded = info.requested && info.requested !== info.autonomy
  const level = AUTONOMY_LEVELS.find((l) => l.id === info.autonomy)
  const rows: Array<[string, ReactNode]> = []
  if (info.autonomy) rows.push(['Autonomy granted', level?.label ?? info.autonomy])
  if (info.steps !== undefined) rows.push(['Steps', <span className="tabular-nums">{info.steps}</span>])
  if (info.grounded) rows.push(['Grounded on', <span className="tabular-nums">{info.grounded} document{info.grounded === 1 ? '' : 's'}</span>])
  if (info.pullRequests) rows.push(['Pull requests', <span className="tabular-nums">{info.pullRequests}</span>])
  rows.push(['Identity', info.authenticated ? (info.writeAllowed ? 'you · write allowed' : 'you · read only') : 'anonymous'])
  return (
    <Section title="Provenance">
      <div className="space-y-1 rounded-xl border border-edge-subtle bg-surface-raised px-3 py-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="text-content-subtle">{k}</span>
            <span className="truncate text-right text-content">{v}</span>
          </div>
        ))}
        {downgraded ? (
          <p className="pt-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
            You asked for {AUTONOMY_LEVELS.find((l) => l.id === info.requested)?.label ?? info.requested}; the runtime granted less for your identity.
          </p>
        ) : null}
        {info.kind === 'budget_exhausted' ? <p className="pt-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">Stopped at its step budget before finishing.</p> : null}
        {info.auditId ? (
          <button type="button" title="Copy the audit id" onClick={() => void globalThis.navigator?.clipboard?.writeText(info.auditId ?? '')} className="w-full truncate pt-1 text-left font-mono text-[10px] text-content-subtle transition-colors hover:text-content">
            audit {info.auditId}
          </button>
        ) : null}
      </div>
    </Section>
  )
}

/* ─────────────────────────────── Knowledge ─────────────────────────────── */

const KIND_TONE: Record<string, string> = {
  runbook: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  incident: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
  finding: 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300',
  adr: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300',
  tool: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  package: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  resource: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
}

/**
 * Search the platform's memory directly.
 *
 * Retrieval without an agent run answers "what does the platform know about
 * X" for a fraction of a run's cost, and it is how an operator checks what the
 * agent WOULD have been given when an answer disappoints. Debounced so typing
 * does not hammer the runtime; the store drops stale responses.
 */
function KnowledgeTab({ onAskAbout }: { onAskAbout(text: string): void }) {
  const { knowledge, runtime } = useAssist()
  const [q, setQ] = useState(knowledge.query)
  useEffect(() => {
    const t = setTimeout(() => void assistStore.searchKnowledge(q), 260)
    return () => clearTimeout(t)
  }, [q])
  const stats = knowledge.stats
  const mode = knowledge.mode ?? stats?.mode ?? runtime?.rag
  const configured = runtime?.configured !== false
  return (
    <div className="space-y-3">
      <label className="flex h-9 items-center gap-2 rounded-xl border border-edge-default bg-surface-raised px-2.5 focus-within:border-brand-400">
        <span className="text-content-subtle"><IconSearch size={13} /></span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="What does the platform know about…"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-content outline-none placeholder:text-content-subtle focus:ring-0 focus-visible:shadow-none"
        />
        {knowledge.searching ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" /> : null}
      </label>

      {!configured ? (
        <p className="px-1 text-[11.5px] leading-relaxed text-content-subtle">The adhar-ai runtime is not configured on this install, so there is no knowledge base to search.</p>
      ) : null}

      {knowledge.error ? <p className="px-1 text-[11.5px] text-rose-600 dark:text-rose-400">{knowledge.error}</p> : null}

      {knowledge.hits.length ? (
        <ul className="space-y-1.5">
          {knowledge.hits.map((h) => <HitRow key={h.chunk_id} hit={h} onAskAbout={onAskAbout} />)}
        </ul>
      ) : knowledge.query && !knowledge.searching ? (
        <p className="px-1 text-[11.5px] text-content-subtle">Nothing retrieved for “{knowledge.query}”.</p>
      ) : null}

      {configured && !knowledge.query ? (
        <div className="space-y-2">
          <div className="rounded-xl border border-edge-subtle bg-surface-raised p-3 text-[11.5px] leading-relaxed text-content-muted">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              <span>Knowledge base</span>
              {mode ? <span className="rounded bg-surface-sunken px-1.5 py-px font-mono normal-case tracking-normal text-content-muted">{mode}</span> : null}
            </div>
            {stats ? (
              <ul className="space-y-0.5">
                {typeof stats.documents === 'number' ? <li><span className="tabular-nums text-content">{stats.documents}</span> documents</li> : null}
                {typeof stats.chunks === 'number' ? <li><span className="tabular-nums text-content">{stats.chunks}</span> chunks indexed</li> : null}
                {stats.sources?.length ? <li>Sources: <span className="text-content">{stats.sources.join(', ')}</span></li> : null}
                {stats.lastRefresh ? <li>Refreshed {relTime(String(stats.lastRefresh))}</li> : null}
              </ul>
            ) : (
              <p>Documentation, the tool inventory, the package catalogue, live cluster state, operator findings and human notes — retrieved to ground every answer.</p>
            )}
          </div>
          <p className="px-1 text-[11px] leading-relaxed text-content-subtle">
            Answers cite what they were grounded on. Vote on those sources under an answer, or keep an answer as knowledge, and retrieval learns.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function HitRow({ hit, onAskAbout }: { hit: KnowledgeHit; onAskAbout(text: string): void }) {
  const [open, setOpen] = useState(false)
  const pct = Math.max(4, Math.min(100, Math.round(hit.score * 100)))
  return (
    <li className="rounded-xl border border-edge-subtle bg-surface-raised p-2.5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2 text-left">
        <span className={cn('mt-px shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider', KIND_TONE[hit.kind] ?? 'bg-surface-sunken text-content-muted')}>{hit.kind}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-content" title={hit.source}>{hit.source}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-content-subtle">
            <span className="font-mono">{hit.origin}</span>
            <span>·</span>
            <span>{hit.retrieval}</span>
            <span className="ml-auto h-1 w-12 overflow-hidden rounded-full bg-surface-sunken"><span className="block h-full rounded-full bg-brand-500/70" style={{ width: `${pct}%` }} /></span>
          </span>
        </span>
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-content-muted">{hit.text}</p>
          <button type="button" onClick={() => onAskAbout(`Using "${hit.source}", explain: `)} className="inline-flex h-6 items-center gap-1 rounded-md bg-brand-50 px-2 text-[11px] font-medium text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/15">
            Ask about this <IconReturn size={10} />
          </button>
        </div>
      ) : null}
    </li>
  )
}

/* ─────────────────────────────── Tools ─────────────────────────────── */

const DOMAIN_LABEL: Record<string, string> = {
  cluster: 'Cluster',
  gitops: 'GitOps',
  observability: 'Observability',
  security: 'Security',
  cost: 'Cost',
  provision: 'Provisioning',
  catalog: 'Catalog',
  console: 'Console',
}

/**
 * What the runtime can actually do, from the runtime.
 *
 * MCP servers as they are RIGHT NOW (live sessions, so a dead server shows as
 * unreachable rather than as connected-and-failing), the tools they expose
 * grouped by domain, and the operators watching the platform unprompted. It
 * comes from `/healthz` and `/config`, never from a list in this file.
 */
function ToolsTab() {
  const { runtime, agents, agentId } = useAssist()
  const agent = agents.find((a) => a.id === agentId)
  const groups = useMemo(() => {
    const out = new Map<string, string[]>()
    for (const t of runtime?.tools ?? []) {
      const d = toolDomain(t)
      out.set(d, [...(out.get(d) ?? []), t])
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [runtime?.tools])

  if (!runtime) return <p className="px-1 text-[11.5px] text-content-subtle">Loading the runtime's capabilities…</p>
  if (!runtime.configured) {
    return (
      <div className="space-y-2">
        <p className="px-1 text-[11.5px] leading-relaxed text-content-subtle">The adhar-ai runtime is not configured, so the {agent?.name ?? 'current'} agent runs the console's own read-only cluster tools.</p>
        {agent ? <div className="rounded-xl border border-edge-subtle bg-surface-raised p-3 text-[11.5px] text-content-muted">{agent.tools} console tools · reads with your RBAC</div> : null}
      </div>
    )
  }
  if (!runtime.reachable) {
    return <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[11.5px] text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">The runtime is configured but unreachable: {runtime.error}</div>
  }
  const connected = runtime.mcp?.connected ?? []
  const unreachable = Object.entries(runtime.mcp?.unreachable ?? {})
  const operators = Object.entries(runtime.operators ?? {})
  return (
    <div className="space-y-4">
      <Section title={`MCP servers · ${connected.length + unreachable.length}`} right={runtime.rag ? <span className="font-mono normal-case tracking-normal">rag: {runtime.rag}</span> : undefined}>
        <ul className="grid grid-cols-2 gap-1">
          {connected.map((s) => (
            <li key={s} className="flex items-center gap-1.5 rounded-lg border border-edge-subtle bg-surface-raised px-2 py-1.5 text-[11.5px] text-content">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {DOMAIN_LABEL[s] ?? s}
            </li>
          ))}
          {unreachable.map(([s, why]) => (
            <li key={s} title={why} className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50/60 px-2 py-1.5 text-[11.5px] text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> {DOMAIN_LABEL[s] ?? s}
            </li>
          ))}
        </ul>
      </Section>

      {groups.length ? (
        <Section title={`Tools · ${runtime.tools?.length ?? 0}`}>
          <div className="space-y-1.5">
            {groups.map(([domain, tools]) => <ToolGroup key={domain} domain={domain} tools={tools} />)}
          </div>
        </Section>
      ) : null}

      {operators.length ? (
        <Section title={`Operators · ${operators.length}`} right={runtime.findingsHeld ? <span className="tabular-nums normal-case tracking-normal">{runtime.findingsHeld} findings</span> : undefined}>
          <ul className="space-y-1">
            {operators.map(([name, op]) => (
              <li key={name} className="rounded-lg border border-edge-subtle bg-surface-raised px-2.5 py-1.5">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-medium text-content">{name.replace(/[-_]/g, ' ')}</span>
                  {op.autonomy ? <span className="rounded bg-surface-sunken px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wider text-content-subtle">{op.autonomy}</span> : null}
                </div>
                {op.trigger ? <div className="mt-0.5 text-[10.5px] text-content-subtle">on <span className="font-mono">{op.trigger}</span></div> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {runtime.limits || runtime.writePolicy ? (
        <Section title="Guardrails">
          <div className="space-y-1 rounded-xl border border-edge-subtle bg-surface-raised px-3 py-2 text-[11px]">
            {runtime.autonomyDefault ? <Row k="Default autonomy" v={runtime.autonomyDefault} /> : null}
            {runtime.limits?.maxSteps ? <Row k="Max steps per run" v={runtime.limits.maxSteps} /> : null}
            {runtime.limits?.maxToolCallsPerOp ? <Row k="Max tool calls" v={runtime.limits.maxToolCallsPerOp} /> : null}
            {runtime.writePolicy?.allowedRepos?.length ? <Row k="Writes allowed to" v={runtime.writePolicy.allowedRepos.join(', ')} /> : null}
            <p className="pt-1 text-[10.5px] leading-snug text-content-subtle">Read tools read. Write tools open a pull request. Nothing applies to a cluster.</p>
          </div>
        </Section>
      ) : null}
    </div>
  )
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-content-subtle">{k}</span>
      <span className="truncate text-right text-content">{v}</span>
    </div>
  )
}

function ToolGroup({ domain, tools }: { domain: string; tools: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-raised">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px]">
        <span className="font-medium text-content">{DOMAIN_LABEL[domain] ?? domain}</span>
        <span className="text-[10.5px] tabular-nums text-content-subtle">{tools.length} · {open ? 'hide' : 'show'}</span>
      </button>
      {open ? (
        <ul className="border-t border-edge-subtle px-2.5 py-1.5">
          {tools.map((t) => <li key={t} className="truncate py-0.5 font-mono text-[10.5px] text-content-muted">{t}</li>)}
        </ul>
      ) : null}
    </div>
  )
}

/* ─────────────────────────────── Canvas ─────────────────────────────── */

function CanvasTab({ blocks }: { blocks: UiBlock[] }) {
  if (!blocks.length) return <p className="px-1 text-[11.5px] leading-relaxed text-content-subtle">Charts, tables and diagrams the agent renders collect here — and the Canvas button in the header lays them out side by side.</p>
  return (
    <div className="space-y-2.5">
      {blocks.map((b) => <GenerativeBlock key={b.id} block={b} />)}
    </div>
  )
}

/* ─────────────────────────────── Navigate ─────────────────────────────── */

function NavTab({ results, query, active, onHover, onPick, all }: { results: CommandItem[]; query: string; active: number; onHover(i: number): void; onPick(i: CommandItem): void; all: CommandItem[] }) {
  const list = query.trim() ? results : all.slice(0, 14)
  let lastGroup: string | undefined
  return (
    <div>
      <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{query.trim() ? `Matches · ${results.length}` : 'Go to'}</div>
      {list.length === 0 ? <p className="px-2 py-3 text-[11.5px] text-content-subtle">No page matches “{query}” — send it as a question instead.</p> : null}
      <div className="space-y-px">
        {list.map((item, i) => {
          const header = item.group && item.group !== lastGroup && !query.trim() ? item.group : null
          lastGroup = item.group
          const isActive = query.trim() ? i === active : false
          return (
            <div key={item.id}>
              {header ? <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{header}</div> : null}
              <button
                type="button"
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(item)}
                className={cn('group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors', isActive ? 'bg-brand-50 text-content ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-content-subtle [&>svg]:h-4 [&>svg]:w-4">{item.icon ?? <IconDot />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{item.label}</span>
                  {item.description ? <span className="block truncate text-[10.5px] text-content-subtle">{item.description}</span> : null}
                </span>
                {query.trim() && item.group ? <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-content-subtle">{item.group}</span> : null}
                <span className={cn('shrink-0 text-content-subtle transition-opacity', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}><IconReturn /></span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
