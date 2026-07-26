import { useId, type CSSProperties, type SVGProps } from 'react'

/**
 * Official Adhar brand marks.
 *
 * The symbol is inlined SVG (crisp, gradient, background-agnostic). The
 * wordmark is HTML gradient text so it always uses the app's own font, never
 * clips against a fixed viewBox when a fallback font is wider, and
 * baseline-aligns naturally with the symbol.
 *
 * Source of truth: adhar/docs/images/branding.
 */

const GRADIENT = 'linear-gradient(105deg, #3B82F6 0%, #6366F1 50%, #8B5CF6 100%)'

/** The Adhar hex symbol. Gradient IDs are unique per instance (`useId`). */
export function AdharSymbol({
  size = 32,
  title = 'Adhar',
  ...props
}: { size?: number; title?: string } & SVGProps<SVGSVGElement>) {
  const gid = useId()
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      // Tight viewBox around the artwork (+ stroke) so the mark fills its box
      // with no dead padding — keeps it balanced next to the wordmark.
      viewBox="117 47 246 246"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      {...props}
    >
      <defs>
        <linearGradient id={gid} x1="120" y1="47" x2="360" y2="293" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3B82F6" />
          <stop offset="0.5" stopColor="#6366F1" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gid})`} stroke={`url(#${gid})`} strokeWidth="6" strokeLinejoin="round">
        <polygon points="240,50 297.16,83 297.16,149 240,182 182.84,149 182.84,83" />
        <polygon points="177.65,158 234.81,191 234.81,257 177.65,290 120.49,257 120.49,191" />
        <polygon points="302.35,158 359.51,191 359.51,257 302.35,290 245.19,257 245.19,191" />
      </g>
      <path
        d="M 240,102 L 281,219 L 240,192 L 199,219 Z"
        fill="#FFFFFF"
        stroke="#FFFFFF"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The "ADHAR" wordmark as gradient text — sized by `fontSize` (px). */
export function AdharWordmark({
  fontSize = 22,
  className,
  style,
}: {
  fontSize?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      className={className}
      aria-label="ADHAR"
      role="img"
      style={{
        display: 'block',
        fontSize,
        lineHeight: 1,
        fontWeight: 800,
        letterSpacing: '-0.01em',
        backgroundImage: GRADIENT,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        whiteSpace: 'nowrap',
        width: 'fit-content',
        ...style,
      }}
    >
      ADHAR
    </span>
  )
}

/**
 * Wordmark + a subtitle whose letters are spread to exactly match the ADHAR
 * width (the classic "ADHAR / C O N S O L E" lockup). The column hugs the
 * wordmark width and the subtitle justifies its glyphs across that width.
 */
export function AdharWordmarkStack({
  fontSize = 20,
  subtitle,
  className,
}: {
  fontSize?: number
  subtitle?: string
  className?: string
}) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', flexDirection: 'column', width: 'fit-content' }}
    >
      <AdharWordmark fontSize={fontSize} style={{ width: '100%' }} />
      {subtitle ? (
        <span
          aria-label={subtitle}
          className="text-content-subtle"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            width: '100%',
            marginTop: fontSize * 0.16,
            fontSize: Math.max(8, fontSize * 0.38),
            fontWeight: 600,
            lineHeight: 1,
            textTransform: 'uppercase',
          }}
        >
          {subtitle.split('').map((ch, i) => (
            <span key={i} aria-hidden>
              {ch}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Symbol + wordmark lockup. The subtitle (if any) spans the wordmark width.
 * The same lockup is used on the auth pages and in the sidebar header.
 */
export function AdharLogo({
  symbolSize = 34,
  wordmarkSize,
  subtitle,
  className,
}: {
  symbolSize?: number
  /** Wordmark font-size in px. Defaults to ~64% of the symbol size. */
  wordmarkSize?: number
  subtitle?: string
  className?: string
}) {
  const wm = wordmarkSize ?? Math.round(symbolSize * 0.64)
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: symbolSize * 0.26 }}
    >
      <AdharSymbol size={symbolSize} style={{ flex: 'none' }} />
      <AdharWordmarkStack fontSize={wm} subtitle={subtitle} />
    </span>
  )
}
