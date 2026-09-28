import { cn } from '@adhar-console/utils'
import type { AgentInfo } from '../agui/store.ts'
import type { OperatorFinding, RuntimeInfo } from '../agui/client.ts'
import { useNotifications } from '../notifications.ts'
import type { CommandItem } from './nav.ts'
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
    <div className="relative flex w-full flex-1 flex-col">
      {/* Outside the `max-w-5xl` column and outside the scroll container's own
          padding, so the field spans the whole surface. Inside the column it
          was 1024px of tinted background with plain surface either side of it,
          which draws exactly the panel edge the design is built to avoid. */}
      <Field />

      <div className="@container relative mx-auto w-full max-w-5xl">
      <Hero configured={configured} agents={agents} agent={agent} runtime={runtime} navHint={navHint} />

      {/* `attention`, not `configured`: with nothing to show this used to render
          an empty flex column whose `mt-3` still took 12px under the hero, so
          the landing sat fractionally off where the layout said it would. */}
      {configured && attention ? (
        <div className="mt-3 flex flex-col gap-3 @md:mt-4 @md:gap-4">
          {(
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
          )}
        </div>
      ) : null}
      </div>
    </div>
  )
}

/* ─────────────────────────────── hero ─────────────────────────────── */

/**
 * The landing.
 *
 * There is no panel. The composition sits directly on the surface over an
 * ambient field — a blueprint grid that dissolves before it reaches an edge,
 * two slow colour washes, and a sweep circling the mark. The version before
 * this one put the same content inside a glass card with every fact in its
 * own bordered tile, which turned an empty state into a dashboard: six boxes
 * competing for attention with the composer that is the only thing on this
 * screen you are meant to use.
 *
 * What is left is the mark, one line of type, one sentence, and a status bar.
 * Nothing in the status bar is decorative data — every value is the runtime's
 * own, and when the runtime is unreachable it says so and reports what the
 * console's agents can still do instead of showing empty counters.
 */
function Hero({ configured, agents, agent, runtime, navHint }: { configured: boolean; agents: AgentInfo[]; agent?: AgentInfo; runtime: RuntimeInfo | null; navHint?: CommandItem }) {
  return (
    <section
      aria-labelledby="adhar-ai-landing-heading"
      className="relative flex flex-col items-center px-4 pb-10 pt-6 text-center @md:pb-14 @md:pt-10"
    >
      <Sigil />

      {/* Clipped to a gradient rather than a flat colour: the headline is the
          largest thing here, and a top-to-bottom fade keeps it from sitting
          on the page as a slab of solid ink. `pb-1` because `bg-clip-text`
          crops descenders that overrun the line box. */}
      <h2
        id="adhar-ai-landing-heading"
        className="rise-in mt-6 text-balance bg-linear-to-b from-content to-content-muted bg-clip-text pb-1 text-[30px] font-semibold leading-[1.05] tracking-[-0.035em] text-transparent @md:mt-8 @md:text-[44px] @2xl:text-[52px]"
        style={rise(60)}
      >
        {configured ? 'Ask, investigate, propose.' : 'How may I help you?'}
      </h2>

      <p
        className="rise-in mt-4 max-w-[46ch] text-pretty text-[13px] leading-relaxed text-content-muted @md:mt-5 @md:text-[15px]"
        style={rise(120)}
      >
        {configured
          ? `${agents.length || 'Specialist'} agents read your cluster, delivery, policies and cost with your permissions, cite the platform’s own knowledge, and turn any change into a pull request for you to review.`
          : 'AI isn’t configured on this cluster yet (set AI_BASE_URL / AI_MODEL). Type any page, app or setting to jump straight to it.'}
      </p>

      {!configured && navHint ? (
        <div className="rise-in mt-6 text-[12px] text-content-muted" style={rise(180)}>
          Press <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⏎</kbd> to open{' '}
          <span className="font-medium text-content">{navHint.label}</span>
        </div>
      ) : null}

      {configured ? <StatusBar runtime={runtime} agent={agent} agents={agents} /> : null}
    </section>
  )
}

/**
 * The entrance stagger.
 *
 * The hero used to carry one `rise-in` on the section, so four things arrived
 * as a single slab. Dealing them out in reading order — mark, headline,
 * sentence, then the facts — is what makes the page feel composed rather than
 * merely loaded. The total is under a quarter of a second: any longer and the
 * operator is waiting on an empty state, which is the opposite of the point.
 *
 * Only `animation-delay` is set here. `.rise-in` already declares `both`, so a
 * delayed element holds the `from` frame instead of flashing in at full
 * opacity first, and the reduced-motion block kills the animation outright —
 * which means these delays cannot strand anything invisible.
 */
function rise(ms: number): React.CSSProperties {
  return { animationDelay: `${ms}ms` }
}

/**
 * The field behind the landing — a blueprint grid, and nothing else.
 *
 * It used to carry two drifting colour washes as well. On a page whose whole
 * argument is restraint they were the loudest thing on it: a blue and a teal
 * bloom tinting half the surface, which on a light theme read as the page
 * having a background colour rather than as light falling across it. The grid
 * alone gives the surface a scale without giving it a hue. The only colour
 * left on the page is the mark's own, which is the one place it means
 * something.
 *
 * The negative insets are the scroll container's own padding, cancelled: the
 * field is positioned against a box inside that padding, and without this it
 * stops short of every edge in a way that reads as a border. They cannot
 * overflow the container, because they only reach its border box.
 *
 * Masked to an ellipse so the grid dissolves instead of ending on a line —
 * a grid with an edge is a panel, which is the thing this must never be.
 */
function Field() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute -inset-x-3 -inset-y-4 -z-10 overflow-hidden sm:-inset-x-5 sm:-inset-y-5 md:-inset-x-8 [mask-image:radial-gradient(ellipse_85%_70%_at_50%_26%,black_35%,transparent_100%)]"
    >
      <div className="absolute inset-0 opacity-45 dark:opacity-30 [background-image:linear-gradient(var(--color-edge-strong)_1px,transparent_1px),linear-gradient(90deg,var(--color-edge-strong)_1px,transparent_1px)] [background-size:56px_56px]" />
    </div>
  )
}

/**
 * The mark: a bloom under it, a hairline ring around it, and one arc of brand
 * colour travelling that ring.
 *
 * The span is sized to the ring, not to the mark. It used to be an
 * `inline-flex` that the mark sized — 56px — while the ring it draws is 92px,
 * so the element's layout box was 36px smaller than the thing on screen. The
 * margin under it was therefore measured from the wrong edge, and by a
 * different amount at each breakpoint, which is why the gap below the mark
 * never matched the number in the class. It also made the span report as
 * overflowing in every layout check.
 *
 * One mark at one size, rather than a pair with `@md:hidden` on each: two
 * marks means two SVGs mounted and two `useId` gradient sets for one glyph,
 * and the ring around it is what should grow with the container anyway.
 *
 * The bloom is wider than this box and is meant to be. A glow that stopped at
 * a boundary would have an edge, and the whole point of it is that it does
 * not; only the ring is a real boundary, so only the ring sets the size that
 * the margin below is measured from.
 */
function Sigil() {
  return (
    <span className="rise-in relative flex h-[92px] w-[92px] items-center justify-center @md:h-[108px] @md:w-[108px]">
      <span aria-hidden className="absolute h-32 w-32 rounded-full bg-brand-500/14 blur-[40px] dark:bg-brand-500/25 @md:h-40 @md:w-40" />
      <span aria-hidden className="absolute inset-0 rounded-full border border-edge-subtle" />
      <span aria-hidden className="ai-sweep absolute inset-0 rounded-full" />
      <AdharAiMark size={60} className="relative" />
    </span>
  )
}

/**
 * What the assistant is made of, right now — one line, not a grid of tiles.
 *
 * Label and value sit side by side, small caps against monospace, the way a
 * status bar reads: scannable left to right, reflowing to as many lines as
 * the width needs without ever leaving a hole — which is what a fixed column
 * count did when the number of facts changed with the runtime's state.
 *
 * The pairs are separated by space alone. A hairline rule between them looks
 * right on one line and wrong the moment the bar wraps, because the rule
 * belonging to the first pair on the second line is then dangling at the
 * start of it, and no selector can know which pair began a line. A rule above
 * the whole bar went the same way for a duller reason: at edge contrast over
 * 672px it is invisible, and at anything darker it draws a box lid.
 */
function StatusBar({ runtime, agent, agents }: { runtime: RuntimeInfo | null; agent?: AgentInfo; agents: AgentInfo[] }) {
  const consoleTools = agents.reduce((n, a) => n + (a.delegated ? 0 : a.tools), 0) || agent?.tools || 0
  const live = Boolean(runtime?.configured && runtime.reachable)
  const down = runtime?.configured && runtime.reachable === false
  const bad = Object.keys(runtime?.mcp?.unreachable ?? {}).length

  const cells: Array<{ label: string; value: string; tone?: 'bad'; title?: string }> = live
    ? [
      { label: 'MCP', value: `${runtime!.mcp?.connected.length ?? 0}${bad ? ` · ${bad} down` : ''}`, tone: bad ? 'bad' : undefined },
      { label: 'Tools', value: String(runtime!.tools?.length ?? 0) },
      // The runtime can report a whole sentence here ("lexical over pgvector
      // (no embeddings configured)"); a status bar is a glance, not a log.
      // The trimmed value is the glance; `title` keeps the runtime's full
      // sentence ("lexical over pgvector (no embeddings configured)")
      // reachable, since the split throws away the part that says why.
      { label: 'Grounding', value: runtime!.rag ? runtime!.rag.split(/[(,]/)[0].trim() : 'platform knowledge', title: runtime!.rag ?? undefined },
      { label: 'Writes', value: 'pull requests' },
    ]
    : down
    ? [
      { label: 'Runtime', value: 'unreachable', tone: 'bad' },
      { label: 'Console tools', value: String(consoleTools) },
      { label: 'Writes', value: 'proposals only' },
    ]
    : [
      { label: 'Console tools', value: String(consoleTools) },
      { label: 'Agents', value: String(agents.length) },
      { label: 'Writes', value: 'proposals only' },
    ]

  return (
    <div className="rise-in mt-10 flex w-full max-w-2xl flex-col items-center @md:mt-12" style={rise(180)}>
      <dl className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[11px] @md:gap-x-7">
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5">
            {live ? <span aria-hidden className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" /> : null}
            <span className={cn('relative h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-500' : down ? 'bg-rose-500' : 'bg-content-subtle')} />
          </span>
          <span className={cn('font-sans font-semibold uppercase tracking-[0.14em]', live ? 'text-emerald-700 dark:text-emerald-300' : down ? 'text-rose-700 dark:text-rose-300' : 'text-content-muted')}>
            {live ? 'Live' : down ? 'Down' : 'Local'}
          </span>
        </div>

        {cells.map((c) => (
          <div key={c.label} className="flex items-center gap-1.5" title={c.title}>
            <dt className="font-sans uppercase tracking-[0.1em] text-content-subtle">{c.label}</dt>
            <dd className={cn('tabular-nums', c.tone === 'bad' ? 'text-rose-700 dark:text-rose-300' : 'text-content')}>{c.value}</dd>
          </div>
        ))}
      </dl>
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

