import { useId } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * The Adhar AI mark.
 *
 * It replaces a flat four-point star sitting on a CSS gradient square. That
 * read as a generic "sparkle = AI" glyph from any of a dozen products, and at
 * 15px the straight-armed star turned into a blob.
 *
 * What is different here, and why:
 *   - The arms are CONCAVE (quadratic curves pulled toward the centre), which
 *     keeps the four points legible at 14px where straight edges merge.
 *   - A second, smaller spark sets up a diagonal, so the mark has a direction
 *     rather than being radially symmetric — that is what stops it reading as
 *     an asterisk.
 *   - The spark sits on a soft radial glow, so it reads as emitting light
 *     rather than as a white cut-out stuck on a coloured tile.
 *   - The gradient lives in the SVG, not on a wrapper div, so the mark can be
 *     dropped anywhere (menus, buttons, a favicon) and keep its identity.
 *   - `busy` turns the surrounding ring into a slow sweep. A spinner next to a
 *     logo says "loading"; a logo that is itself alive says "thinking", which
 *     is the true state while a run streams.
 *
 * Gradient ids come from `useId`. They must be unique per instance — SVG ids
 * are document-global, and two marks sharing one id make the second render
 * with the first's stops — but the previous module-level counter was
 * incremented DURING RENDER. That is not a pure render: the ids changed on
 * every pass, so every re-render threw away and re-created the gradients, and
 * under StrictMode's double-render the markup differed between passes.
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
          className="absolute inset-[-2px] animate-spin rounded-[32%] opacity-70 [animation-duration:2.4s] motion-reduce:animate-none"
          style={{
            background:
              'conic-gradient(from 0deg, transparent 0deg, var(--color-accent-500) 90deg, transparent 200deg)',
            mask: 'radial-gradient(circle, transparent 58%, black 62%)',
            WebkitMask: 'radial-gradient(circle, transparent 58%, black 62%)',
          }}
        />
      ) : null}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        aria-hidden
        className="relative drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.14)]"
      >
        <defs>
          <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-brand-400)" />
            <stop offset="55%" stopColor="var(--color-brand-600)" />
            <stop offset="100%" stopColor="var(--color-accent-500)" />
          </linearGradient>
          {/* A soft top-left highlight so the tile reads as a lit surface
              rather than a flat swatch — the thing that makes a small mark
              look considered at 15px. */}
          <linearGradient id={`${uid}-gloss`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.32" />
            <stop offset="55%" stopColor="white" stopOpacity="0.04" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
          {/* The light the spark sits in. Without it the white shape reads as
              a sticker on the tile; with it the tile looks lit from within. */}
          <radialGradient id={`${uid}-glow`} cx="44%" cy="42%" r="46%">
            <stop offset="0%" stopColor="white" stopOpacity="0.42" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect x="0" y="0" width="32" height="32" rx="10" fill={`url(#${uid}-bg)`} />
        <rect x="0" y="0" width="32" height="32" rx="10" fill={`url(#${uid}-gloss)`} />
        <rect x="0" y="0" width="32" height="32" rx="10" fill={`url(#${uid}-glow)`} />
        <rect
          x="0.6"
          y="0.6"
          width="30.8"
          height="30.8"
          rx="9.5"
          fill="none"
          stroke="white"
          strokeOpacity="0.24"
          strokeWidth="1.1"
        />

        {/* Primary spark. Each arm is two quadratic curves whose control point
            sits at the centre, which is what produces the concave waist. */}
        <path
          d="M14 6 Q15 12.4 20.6 13.4 Q15 14.4 14 20.8 Q13 14.4 7.4 13.4 Q13 12.4 14 6 Z"
          fill="white"
          fillOpacity="0.98"
        />
        {/* Satellite — smaller, offset down-right, sets the diagonal. Kept
            dimmer than the primary so the eye reads one mark with an accent,
            not two competing sparks. */}
        <path
          d="M22.6 18.2 Q23.1 21.2 26 21.7 Q23.1 22.2 22.6 25.2 Q22.1 22.2 19.2 21.7 Q22.1 21.2 22.6 18.2 Z"
          fill="white"
          fillOpacity="0.72"
        />
      </svg>
    </span>
  )
}
