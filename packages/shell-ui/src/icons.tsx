import type { SVGProps } from 'react'

/**
 * Line-icon library — 18×18 by default, 24×24 viewBox, 1.75 stroke.
 *
 * Every icon is a plain SVG component so callers can pass `className`,
 * `style`, `aria-label`, etc. Stroke uses `currentColor` so color comes
 * from parent text color — matches the NavItem's active/hover states.
 */

type Props = SVGProps<SVGSVGElement>

const DEFAULTS: Props = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

const Svg = ({ children, ...p }: Props & { children: React.ReactNode }) => (
  <svg {...DEFAULTS} {...p}>
    {children}
  </svg>
)

/* ─── Lifecycle (6D + Overview) ──────────────────────────────────────── */

export const IconHome = (p: Props) => (
  <Svg {...p}>
    <path d="M3 12 12 3l9 9" />
    <path d="M5 10v10h4v-6h6v6h4V10" />
  </Svg>
)

export const IconTarget = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5.5" />
    <circle cx="12" cy="12" r="2" />
  </Svg>
)

export const IconCompass = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m14.5 9.5-2 5-5 2 2-5 5-2z" />
  </Svg>
)

export const IconCode = (p: Props) => (
  <Svg {...p}>
    <path d="m8 6-6 6 6 6" />
    <path d="m16 6 6 6-6 6" />
    <path d="m14 4-4 16" />
  </Svg>
)

export const IconRocket = (p: Props) => (
  <Svg {...p}>
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </Svg>
)

export const IconActivity = (p: Props) => (
  <Svg {...p}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </Svg>
)

export const IconBarChart = (p: Props) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <rect x="7" y="12" width="3" height="6" />
    <rect x="12" y="8" width="3" height="10" />
    <rect x="17" y="5" width="3" height="13" />
  </Svg>
)

export const IconServer = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M6.5 7.5h.01M6.5 16.5h.01" />
    <path d="M11 7.5h4M11 16.5h4" />
  </Svg>
)

/* ─── Workspace ──────────────────────────────────────────────────────── */

export const IconUsers = (p: Props) => (
  <Svg {...p}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
)

export const IconFolder = (p: Props) => (
  <Svg {...p}>
    <path d="M20 19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h7a2 2 0 0 1 2 2z" />
  </Svg>
)

export const IconCloud = (p: Props) => (
  <Svg {...p}>
    <path d="M17.5 19a4.5 4.5 0 1 0-1.25-8.82A6 6 0 0 0 5 11.5a4.5 4.5 0 0 0-.5 9z" />
  </Svg>
)

export const IconPlug = (p: Props) => (
  <Svg {...p}>
    <path d="M9 2v5M15 2v5" />
    <path d="M6 7h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V7z" />
    <path d="M12 17v5" />
  </Svg>
)

export const IconKey = (p: Props) => (
  <Svg {...p}>
    <circle cx="7" cy="15" r="4" />
    <path d="m10 12 11-11 3 3" />
    <path d="m16 6 3 3" />
  </Svg>
)

export const IconWebhook = (p: Props) => (
  <Svg {...p}>
    <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
    <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
    <path d="m12 6 3.13 5.73c.53.97 1.6 1.44 2.7 1.44a4 4 0 1 1-3.95 4.69" />
  </Svg>
)

export const IconShield = (p: Props) => (
  <Svg {...p}>
    <path d="M12 2 4 5v7c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
)

export const IconCreditCard = (p: Props) => (
  <Svg {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
    <path d="M6 15h4" />
  </Svg>
)

export const IconGauge = (p: Props) => (
  <Svg {...p}>
    <path d="M22 12a10 10 0 1 0-20 0" />
    <path d="m12 12 4-4" />
    <circle cx="12" cy="12" r="1.5" />
  </Svg>
)

/* ─── Resources ──────────────────────────────────────────────────────── */

export const IconHeartPulse = (p: Props) => (
  <Svg {...p}>
    <path d="M19 14c1.5-1.45 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z" />
    <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
  </Svg>
)

export const IconSparkle = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="m5.5 5.5 2.5 2.5M16 16l2.5 2.5M5.5 18.5 8 16M16 8l2.5-2.5" />
  </Svg>
)

export const IconWand = (p: Props) => (
  <Svg {...p}>
    <path d="M15 4V2" />
    <path d="M15 16v-2" />
    <path d="M8 9h2" />
    <path d="M20 9h2" />
    <path d="m17.8 11.8 1.2 1.2" />
    <path d="m17.8 6.2 1.2-1.2" />
    <path d="m3 21 9-9" />
    <path d="m12.2 6.2-1.2-1.2" />
  </Svg>
)

export const IconPenRuler = (p: Props) => (
  <Svg {...p}>
    <path d="M13 7 8.7 2.7a2.4 2.4 0 0 0-3.4 0L2.7 5.3a2.4 2.4 0 0 0 0 3.4L7 13" />
    <path d="m8 6 2-2" />
    <path d="m18 16 2-2" />
    <path d="m17 7 5 5L12 22l-5-5L17 7Z" />
  </Svg>
)

export const IconLayers = (p: Props) => (
  <Svg {...p}>
    <path d="M12 2 2 7l10 5 10-5-10-5z" />
    <path d="m2 17 10 5 10-5" />
    <path d="m2 12 10 5 10-5" />
  </Svg>
)

export const IconDesign = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="0.5" />
    <circle cx="17.5" cy="6.5" r="3.5" />
    <polygon points="12 14 8 22 16 22" />
  </Svg>
)

export const IconPlusCircle = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v8" />
    <path d="M8 12h8" />
  </Svg>
)

export const IconPalette = (p: Props) => (
  <Svg {...p}>
    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.7 1.5-1.5 0-.39-.15-.74-.4-1-.23-.27-.4-.62-.4-1 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.5-4.5-10-10-10z" />
  </Svg>
)

export const IconHelp = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </Svg>
)

export const IconCatalog = (p: Props) => (
  <Svg {...p}>
    <path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z" />
    <path d="M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z" />
  </Svg>
)

/* ─── Adhar Crossplane composites (XRs) ──────────────────────────────── */

export const IconAppBox = (p: Props) => (
  <Svg {...p}>
    <path d="M12 2 2 7l10 5 10-5z" />
    <path d="m2 17 10 5 10-5" />
    <path d="m2 12 10 5 10-5" />
  </Svg>
)

export const IconDatabase = (p: Props) => (
  <Svg {...p}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v6a9 3 0 0 0 18 0V5" />
    <path d="M3 11v6a9 3 0 0 0 18 0v-6" />
  </Svg>
)

export const IconDataFlow = (p: Props) => (
  <Svg {...p}>
    <rect x="2" y="4" width="6" height="6" rx="1" />
    <rect x="16" y="4" width="6" height="6" rx="1" />
    <rect x="9" y="14" width="6" height="6" rx="1" />
    <path d="M5 10v2a2 2 0 0 0 2 2h2" />
    <path d="M19 10v2a2 2 0 0 1-2 2h-2" />
  </Svg>
)

export const IconPipeline = (p: Props) => (
  <Svg {...p}>
    <circle cx="5" cy="6" r="2.5" />
    <circle cx="5" cy="18" r="2.5" />
    <circle cx="19" cy="12" r="2.5" />
    <path d="M7.5 6h4a4 4 0 0 1 4 4v0M7.5 18h4a4 4 0 0 0 4-4v0" />
  </Svg>
)

export const IconRoute = (p: Props) => (
  <Svg {...p}>
    <circle cx="6" cy="19" r="2.5" />
    <circle cx="18" cy="5" r="2.5" />
    <path d="M8.5 19h5a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.5" />
  </Svg>
)

/* ─── Generic utility ────────────────────────────────────────────────── */

export const IconSearch = (p: Props) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.35-4.35" />
  </Svg>
)
