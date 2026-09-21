import { useId } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * The Adhar AI mark — built from the Adhar symbol, not from a generic sparkle.
 *
 * The brand symbol (see `AdharSymbol` in brand.tsx) is three pointy-top
 * hexagons in a blue→indigo→violet gradient with a white arrowhead rising
 * through the middle. This mark keeps that vocabulary and drops what cannot
 * survive at 15px:
 *
 *   - ONE hexagon, not three. At tile size three hexagons collapse into a
 *     blob; a single one still reads unmistakably as the Adhar unit shape,
 *     and it is the silhouette people actually recognise.
 *   - The arrowhead, kept at the logo's own proportions (≈1.4 tall to wide,
 *     with the notch ≈76% down) so it is the same shape, just scaled.
 *   - The exact brand gradient stops — #3B82F6 → #6366F1 → #8B5CF6 on the
 *     logo's 105° axis. The previous mark mixed `brand-400/600` with
 *     `accent-500`, which is a different palette; beside the real logo it read
 *     as a near-miss rather than a relative.
 *
 * What says "AI" is the spark at the top-right, deliberately small and
 * subordinate: it is an accent on the Adhar mark, not a competing symbol. Its
 * arms are concave (quadratic curves pulled toward its centre) because at this
 * size straight arms merge into a dot.
 *
 * No drop shadow: the mark is a filled silhouette with no tile behind it, so
 * it sits directly on whatever surface it is placed on. A shadow would make it
 * a sticker floating above the page instead of part of it, and it showed as a
 * grey halo on the dark sidebar.
 *
 * `busy` turns the surrounding ring into a slow sweep. A spinner next to a
 * logo says "loading"; a logo that is itself alive says "thinking", which is
 * the true state while a run streams.
 *
 * Gradient ids come from `useId` — SVG ids are document-global, and two marks
 * sharing one id make the second render with the first's stops.
 */
export function AdharAiMark({
  size = 28,
  busy = false,
  className,
}: {
  size?: number
  busy?: boolean
  className?: string
}) {
  const uid = useId().replace(/:/g, '')
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      {busy ? (
        <span
          aria-hidden
          className="absolute -inset-0.75 animate-spin rounded-full opacity-70 [animation-duration:2.4s] motion-reduce:animate-none"
          style={{
            background:
              'conic-gradient(from 0deg, transparent 0deg, var(--color-accent-500) 90deg, transparent 200deg)',
            mask: 'radial-gradient(circle, transparent 60%, black 64%)',
            WebkitMask: 'radial-gradient(circle, transparent 60%, black 64%)',
          }}
        />
      ) : null}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        aria-hidden
        className="relative"
      >
        <defs>
          {/* The logo's own axis and stops, so the two marks are the same blue. */}
          <linearGradient id={`${uid}-hex`} x1="3" y1="1" x2="29" y2="31" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#3B82F6" />
            <stop offset="0.5" stopColor="#6366F1" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
          {/* A top-left highlight so the face reads as lit rather than flat —
              what makes a small mark look considered at 15px. */}
          <linearGradient id={`${uid}-gloss`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.30" />
            <stop offset="55%" stopColor="#FFFFFF" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/*
          One pointy-top hexagon, the Adhar unit shape. Half-height 15,
          half-width 15·(√3/2) ≈ 13 — the same 0.866 ratio the logo's hexagons
          use, so this is that shape scaled rather than an approximation.
          `strokeLinejoin="round"` softens the six corners the way the logo's
          6px stroke does.
        */}
        <polygon
          points="16,1.4 28.5,8.7 28.5,23.3 16,30.6 3.5,23.3 3.5,8.7"
          fill={`url(#${uid}-hex)`}
          stroke={`url(#${uid}-hex)`}
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <polygon
          points="16,1.4 28.5,8.7 28.5,23.3 16,30.6 3.5,23.3 3.5,8.7"
          fill={`url(#${uid}-gloss)`}
        />

        {/*
          The logo's arrowhead: apex, out to the base corners, back up to a
          notch ~76% of the way down. Same proportions as
          `M 240,102 L 281,219 L 240,192 L 199,219 Z`, scaled into the hexagon.
        */}
        <path
          d="M16 7.4 L22 24.4 L16 20.4 L10 24.4 Z"
          fill="#FFFFFF"
          stroke="#FFFFFF"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />

        {/*
          The AI accent. Small and offset so it reads as a mark ON the Adhar
          symbol rather than a second symbol beside it. Concave arms — the
          control point of each quadratic sits at the spark's centre — keep the
          four points distinct where straight edges would merge into a dot.
        */}
        <path
          d="M26.4 2.2 Q27 5.6 30.2 6.2 Q27 6.8 26.4 10.2 Q25.8 6.8 22.6 6.2 Q25.8 5.6 26.4 2.2 Z"
          fill="#FFFFFF"
          stroke={`url(#${uid}-hex)`}
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
