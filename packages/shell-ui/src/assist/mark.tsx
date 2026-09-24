import { useId } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * The Adhar AI mark — a spark on the platform's tile.
 *
 * The console's own logo is the Adhar arrowhead in a hexagon. Adhar AI sits
 * beside it as a sibling, not a variant: the same blue→violet ramp, but on a
 * softly rounded tile, and instead of the arrowhead a four-point spark — the
 * one shape people already read as "AI" at any size, from a 16px favicon to
 * a 64px hero. A second, smaller spark sits high right, so the mark has a
 * direction and is not a symmetric badge. A top-down rim highlight gives the
 * tile a face without a drop shadow: the mark is a silhouette in a square,
 * and a box-shadow would draw the square.
 *
 * `busy` wraps the tile in a slow conic sweep — a mark that is itself moving
 * says "thinking", which is the true state while a run streams.
 *
 * Gradient ids come from `useId`: SVG ids are document-global, and two marks
 * sharing one id make the second render with the first's fills.
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
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      {busy ? (
        <span
          aria-hidden
          className="absolute -inset-1 animate-spin rounded-[30%] opacity-80 [animation-duration:2.2s] motion-reduce:animate-none"
          style={{
            background: 'conic-gradient(from 0deg, transparent 0deg, var(--color-accent-500) 100deg, transparent 220deg)',
            mask: 'radial-gradient(circle, transparent 58%, black 62%)',
            WebkitMask: 'radial-gradient(circle, transparent 58%, black 62%)',
          }}
        />
      ) : null}
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="relative">
        <defs>
          <linearGradient id={`${id}-tile`} x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#3B82F6" />
            <stop offset="0.5" stopColor="#6366F1" />
            <stop offset="1" stopColor="#A855F7" />
          </linearGradient>
          <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.42" />
            <stop offset="0.4" stopColor="#FFFFFF" stopOpacity="0.05" />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${id}-spark`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" />
            <stop offset="1" stopColor="#E0E7FF" />
          </linearGradient>
          <radialGradient id={`${id}-halo`} cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* The tile: a rounded square in the brand ramp, with a top-down rim. */}
        <rect x="3" y="3" width="26" height="26" rx="8" fill={`url(#${id}-tile)`} />
        <rect x="3" y="3" width="26" height="26" rx="8" fill={`url(#${id}-rim)`} />
        <rect x="3.5" y="3.5" width="25" height="25" rx="7.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.22" />

        {/* A soft halo under the spark so it reads as lit, not stamped. */}
        <circle cx="14.5" cy="17.5" r="8" fill={`url(#${id}-halo)`} />

        {/* The spark: four points, pulled in at the waist so the arms taper. */}
        <path
          d="M14.5 8.2 C15.4 13.2 16.6 14.4 21.6 15.3 C16.6 16.2 15.4 17.4 14.5 22.4 C13.6 17.4 12.4 16.2 7.4 15.3 C12.4 14.4 13.6 13.2 14.5 8.2 Z"
          fill={`url(#${id}-spark)`}
        />
        {/* The second spark, smaller and higher — the mark's direction. */}
        <path
          d="M22.6 7.2 C23 9.2 23.5 9.7 25.5 10.1 C23.5 10.5 23 11 22.6 13 C22.2 11 21.7 10.5 19.7 10.1 C21.7 9.7 22.2 9.2 22.6 7.2 Z"
          fill="#FFFFFF"
          fillOpacity="0.95"
        />
      </svg>
    </span>
  )
}
