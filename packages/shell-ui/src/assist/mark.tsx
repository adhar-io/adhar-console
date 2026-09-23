import { useId } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * The Adhar AI mark — the platform, with an agent in orbit around it.
 *
 * The Adhar symbol (see `AdharSymbol` in brand.tsx) is a pointy-top hexagon
 * in the blue→violet brand ramp with a white arrowhead. Here it is drawn
 * clean and slightly smaller, and a tilted orbit passes around it carrying
 * one bright body. That is the whole idea of the surface in one shape: the
 * platform is the thing at the centre, and the agents are what move around
 * it, watching it, acting on it. The previous mark lit the hexagon's face —
 * a nicer material, but it said "AI" only by being shiny.
 *
 * How it is built, bottom to top:
 *   1. `bloom`  — a faint radial wash so the mark sits in its own light.
 *   2. back arc — the orbit's far half, drawn under the hexagon at low
 *                 opacity so it reads as passing BEHIND.
 *   3. hexagon  — the brand ramp, a top-down rim highlight, and a directional
 *                 edge stroke so it reads as a solid.
 *   4. arrow    — the logo's arrowhead at the logo's proportions, lit.
 *   5. front arc — the orbit's near half, a cyan→magenta stroke over the
 *                 hexagon, clipped to the half-plane below the orbit's axis.
 *   6. body     — the agent: a white dot with a small glow, on the front arc.
 *
 * No drop shadow. The mark is a transparent silhouette in a square box, so a
 * box-shadow draws the BOX.
 *
 * `busy` turns the surrounding ring into a slow sweep — a logo that is itself
 * alive says "thinking", which is the true state while a run streams.
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
  // Hexagon of radius 11 about (16,16) — smaller than the brand mark's 14.4
  // so the orbit has room to pass in front and behind.
  const HEX = '16,5 25.5,10.5 25.5,21.5 16,27 6.5,21.5 6.5,10.5'
  // The orbit: an ellipse tilted 30° anticlockwise about the centre.
  const ORBIT = { cx: 16, cy: 16, rx: 15.2, ry: 6.2, tilt: -30 }
  // The body sits at the orbit's nearest point (t = 90° in the ellipse's own
  // frame), rotated into place: (0, ry) → (ry·sin30, ry·cos30).
  const body = {
    x: ORBIT.cx + ORBIT.ry * Math.sin(Math.PI / 6),
    y: ORBIT.cy + ORBIT.ry * Math.cos(Math.PI / 6),
  }
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
            x1="6"
            y1="5"
            x2="26"
            y2="27"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#3B82F6" />
            <stop offset="0.55" stopColor="#6366F1" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
          <radialGradient id={`${id}-bloom`} cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#818CF8" stopOpacity="0.45" />
            <stop offset="1" stopColor="#818CF8" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.5" />
            <stop offset="0.45" stopColor="#FFFFFF" stopOpacity="0.06" />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
          <linearGradient
            id={`${id}-edge`}
            x1="6"
            y1="5"
            x2="26"
            y2="27"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.7" />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient
            id={`${id}-orbit`}
            x1="1"
            y1="16"
            x2="31"
            y2="16"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#22D3EE" />
            <stop offset="0.5" stopColor="#A5B4FC" />
            <stop offset="1" stopColor="#E879F9" />
          </linearGradient>
          <linearGradient id={`${id}-arrow`} x1="0" y1="0.1" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" />
            <stop offset="1" stopColor="#DBEAFE" />
          </linearGradient>
          <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.9" />
            <stop offset="0.45" stopColor="#67E8F9" stopOpacity="0.5" />
            <stop offset="1" stopColor="#67E8F9" stopOpacity="0" />
          </radialGradient>
          {/* The half-plane below the orbit's axis, in the orbit's own frame —
              what is "in front" of the hexagon. */}
          <clipPath id={`${id}-front`}>
            <rect
              x="-8"
              y="16"
              width="48"
              height="28"
              transform={`rotate(${ORBIT.tilt} ${ORBIT.cx} ${ORBIT.cy})`}
            />
          </clipPath>
        </defs>

        <circle cx="16" cy="16" r="15.5" fill={`url(#${id}-bloom)`} />

        {/* The orbit's far half, behind the hexagon. */}
        <ellipse
          cx={ORBIT.cx}
          cy={ORBIT.cy}
          rx={ORBIT.rx}
          ry={ORBIT.ry}
          transform={`rotate(${ORBIT.tilt} ${ORBIT.cx} ${ORBIT.cy})`}
          fill="none"
          stroke={`url(#${id}-orbit)`}
          strokeWidth="1.1"
          opacity="0.35"
        />

        <polygon points={HEX} fill={`url(#${id}-base)`} />
        <polygon points={HEX} fill={`url(#${id}-rim)`} />
        <polygon
          points={HEX}
          fill="none"
          stroke={`url(#${id}-edge)`}
          strokeWidth="1"
          strokeLinejoin="round"
        />

        {/* The arrowhead, at the logo's proportions scaled to this hexagon. */}
        <path d="M16 10.05 L20.13 21.8 L16 19.05 L11.87 21.8 Z" fill={`url(#${id}-arrow)`} />

        {/* The orbit's near half, over the hexagon. */}
        <ellipse
          cx={ORBIT.cx}
          cy={ORBIT.cy}
          rx={ORBIT.rx}
          ry={ORBIT.ry}
          transform={`rotate(${ORBIT.tilt} ${ORBIT.cx} ${ORBIT.cy})`}
          fill="none"
          stroke={`url(#${id}-orbit)`}
          strokeWidth="1.4"
          strokeLinecap="round"
          clipPath={`url(#${id}-front)`}
        />

        {/* The agent. */}
        <circle cx={body.x} cy={body.y} r="4.2" fill={`url(#${id}-glow)`} />
        <circle cx={body.x} cy={body.y} r="1.9" fill="#FFFFFF" />
      </svg>
    </span>
  )
}
