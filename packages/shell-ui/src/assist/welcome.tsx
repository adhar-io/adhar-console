import { cn } from '@adhar-console/utils'
import type { AgentInfo } from '../agui/store.ts'
import type { RuntimeInfo } from '../agui/client.ts'
import type { CommandItem } from './nav.ts'
import { AdharAiMark } from './mark.tsx'

/**
 * The empty state — the one moment the operator looks at Adhar AI with
 * nothing else in the way, and the moment most worth keeping quiet.
 *
 * It is the mark, one line about how it works, and one line of what the
 * runtime is made of right now. Nothing else.
 *
 * It used to carry five more blocks — a card per agent, that agent's starter
 * prompts, the conversations you had recently, what the platform operators
 * had noticed, and your unread notifications. Every one of them duplicated a
 * control already on screen: the composer has the agent switcher and
 * @mentions, ⌘[ opens the conversation rail, and findings and notifications
 * both have a page of their own behind the bell. What they added here was
 * height and repetition on a page whose whole job is to get out of the way of
 * the composer underneath it.
 *
 * Container queries, not viewport breakpoints: the same component renders in
 * the ⌘K overlay and on the /ai page, and the overlay is narrow on a wide
 * screen.
 */
export function Welcome({
  configured,
  agent,
  agents,
  navHint,
  runtime,
  onPick,
}: {
  configured: boolean
  agent?: AgentInfo
  agents: AgentInfo[]
  navHint?: CommandItem
  runtime: RuntimeInfo | null
  /** Send a starter straight to the composer. */
  onPick(prompt: string): void
}) {
  return (
    <div className="relative flex w-full flex-1 flex-col">
      {/* Outside the `max-w-5xl` column and outside the scroll container's own
          padding, so the field spans the whole surface. Inside the column it
          was 1024px of tinted background with plain surface either side of it,
          which draws exactly the panel edge the design is built to avoid. */}
      <Field />

      <div className="@container relative mx-auto w-full max-w-5xl">
        <Hero configured={configured} agents={agents} agent={agent} runtime={runtime} navHint={navHint} onPick={onPick} />
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
function Hero({ configured, agents, agent, runtime, navHint, onPick }: { configured: boolean; agents: AgentInfo[]; agent?: AgentInfo; runtime: RuntimeInfo | null; navHint?: CommandItem; onPick(prompt: string): void }) {
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

      {configured ? <Starters agent={agent} onPick={onPick} /> : null}

      {configured ? <StatusBar runtime={runtime} agent={agent} agents={agents} /> : null}
    </section>
  )
}

/**
 * The current agent's opening moves.
 *
 * The one thing an empty state owes the reader is a way out of it, and until
 * now this page had none: it described what the agents could do and then left
 * you to phrase the first question yourself. These are the runtime's own
 * `starters` for the selected agent, so they change with the agent and are
 * never invented here.
 *
 * Deliberately a row of lines, not a grid of cards. The version of this that
 * got removed was four tiles with a heading, an icon and a description each —
 * a block of furniture above the composer. A starter only has to be readable
 * and clickable, and at that size the text is the control. The arrow is the
 * only decoration and it only appears under the cursor.
 */
function Starters({ agent, onPick }: { agent?: AgentInfo; onPick(prompt: string): void }) {
  const starters = (agent?.starters ?? []).slice(0, 4)
  if (!starters.length) return null
  return (
    <ul
      className="rise-in mt-8 flex w-full max-w-3xl flex-wrap justify-center gap-2 @md:mt-10"
      style={rise(240)}
    >
      {starters.map((st) => (
        <li key={st.prompt}>
          <button
            type="button"
            onClick={() => onPick(st.prompt)}
            title={st.prompt}
            className={cn(
              'group inline-flex items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised/80 px-3.5 py-2',
              'text-[12.5px] font-medium text-content-muted shadow-xs backdrop-blur-sm',
              'transition-[color,border-color,box-shadow,transform] duration-150',
              'hover:-translate-y-px hover:border-brand-300 hover:text-content hover:shadow-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
              'dark:hover:border-brand-500/60',
            )}
          >
            {st.label}
            <span
              aria-hidden
              className="-ml-0.5 w-0 overflow-hidden text-brand-600 opacity-0 transition-all duration-150 group-hover:ml-0 group-hover:w-3 group-hover:opacity-100 dark:text-brand-300"
            >
              →
            </span>
          </button>
        </li>
      ))}
    </ul>
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
    <div className="rise-in mt-8 flex w-full max-w-2xl flex-col items-center @md:mt-10" style={rise(300)}>
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

