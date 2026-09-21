import { useId } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * The Adhar AI mark — the brand hexagon, lit from inside.
 *
 * The Adhar symbol (see `AdharSymbol` in brand.tsx) is pointy-top hexagons in
 * a blue→violet gradient with a white arrowhead. This mark keeps both of those
 * — the silhouette and the arrow are the brand's, at the brand's proportions —
 * and spends its detail on the FACE: a colour mesh that runs cyan through
 * indigo to magenta, a glass rim, and a soft bloom behind. That is what makes
 * it read as the AI surface rather than as a shrunk product logo.
 *
 * Why the face, and not an added glyph: the obvious way to say "AI" is a
 * four-point sparkle, which is the badge a dozen products already wear — it
 * names the category, not this product. Treating the brand shape as a lit
 * material says the same thing without borrowing anyone's mark.
 *
 * How it is built, bottom to top:
 *   1. `bloom`  — a radial wash behind the hexagon so it sits in its own light
 *                 rather than being pasted onto the page.
 *   2. `base`   — the brand ramp, extended one stop to #A855F7 so the mesh has
 *                 somewhere warm to land.
 *   3. mesh A/B — two radial fields (cyan top-left, magenta bottom-right),
 *                 clipped to the hexagon. Two overlapping radials read as a
 *                 mesh gradient; SVG has no conic gradient to do it directly.
 *   4. `rim`    — a top-down white fade, the highlight a glass edge catches.
 *   5. stroke   — a 34% white outline that keeps the silhouette crisp where
 *                 the mesh goes pale against a light background.
 *   6. arrow    — the logo's arrowhead at its real proportions (≈1.43 tall to
 *                 wide, notch ≈76% down), solid white so it survives at 15px.
 *
 * No drop shadow. The mark is a transparent silhouette in a square box, so a
 * box-shadow draws the BOX — it rendered as a dark rounded square floating
 * behind the artwork. The bloom does the job a shadow was reaching for.
 *
 * `busy` turns the surrounding ring into a slow sweep. A spinner next to a
 * logo says "loading"; a logo that is itself alive says "thinking", which is
 * the true state while a run streams.
 *
 * Gradient and clip ids come from `useId` — SVG ids are document-global, and
 * two marks sharing one id make the second render with the first's fills.
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
  const id = useId().replace(/:/g, '')
  const HEX = '16,1.6 28.4,8.8 28.4,23.2 16,30.4 3.6,23.2 3.6,8.8'
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
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="relative">
        <defs>
          <linearGradient
            id={`${id}-base`}
            x1="3"
            y1="2"
            x2="29"
            y2="30"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#3B82F6" />
            <stop offset="0.45" stopColor="#6366F1" />
            <stop offset="0.78" stopColor="#8B5CF6" />
            <stop offset="1" stopColor="#A855F7" />
          </linearGradient>
          <radialGradient id={`${id}-bloom`} cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#818CF8" stopOpacity="0.55" />
            <stop offset="1" stopColor="#818CF8" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-meshA`} cx="22%" cy="18%" r="55%">
            <stop offset="0" stopColor="#22D3EE" stopOpacity="0.85" />
            <stop offset="1" stopColor="#22D3EE" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-meshB`} cx="82%" cy="78%" r="58%">
            <stop offset="0" stopColor="#D946EF" stopOpacity="0.7" />
            <stop offset="1" stopColor="#D946EF" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
            <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.08" />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <polygon points={HEX} />
          </clipPath>
        </defs>

        <circle cx="16" cy="16" r="15.5" fill={`url(#${id}-bloom)`} />

        <g clipPath={`url(#${id}-clip)`}>
          <polygon points={HEX} fill={`url(#${id}-base)`} />
          {/* Full-box rects, clipped to the hexagon — a radial that stopped at
              the polygon's bounds would band at the corners. */}
          <rect x="0" y="0" width="32" height="32" fill={`url(#${id}-meshA)`} />
          <rect x="0" y="0" width="32" height="32" fill={`url(#${id}-meshB)`} />
          <polygon points={HEX} fill={`url(#${id}-rim)`} />
        </g>

        <polygon
          points={HEX}
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.34"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />

        <path d="M16 8.2 L21.4 23.6 L16 20 L10.6 23.6 Z" fill="#FFFFFF" />
      </svg>
    </span>
  )
}
