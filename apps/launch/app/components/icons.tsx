import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>
const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export const IconArrowRight = (p: P) => (
  <svg {...base} {...p}>
    <path d='M5 12h14M13 6l6 6-6 6' />
  </svg>
)
export const IconArrowLeft = (p: P) => (
  <svg {...base} {...p}>
    <path d='M19 12H5M11 6l-6 6 6 6' />
  </svg>
)
export const IconCheck = (p: P) => (
  <svg {...base} {...p}>
    <path d='M5 12.5l4.2 4.2L19 7' />
  </svg>
)
export const IconWrench = (p: P) => (
  <svg {...base} {...p}>
    <path d='M14.7 6.3a4 4 0 0 0 5 5L13 18a2.8 2.8 0 0 1-4-4l6.7-6.7Z' />
    <path d='M3 21l5-5' />
  </svg>
)
export const IconSparkles = (p: P) => (
  <svg {...base} {...p}>
    <path d='M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z' />
    <path d='M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z' />
  </svg>
)
export const IconGithub = (p: P) => (
  <svg {...base} fill='currentColor' stroke='none' {...p}>
    <path d='M12 .5A12 12 0 0 0 8.2 23.9c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.2 5 18.2 5.3 18.2 5.3c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z' />
  </svg>
)
export const IconClock = (p: P) => (
  <svg {...base} {...p}>
    <circle cx='12' cy='12' r='9' />
    <path d='M12 7v5l3 2' />
  </svg>
)
export const IconShield = (p: P) => (
  <svg {...base} {...p}>
    <path d='M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z' />
    <path d='M9 12l2 2 4-4' />
  </svg>
)
export const IconLayers = (p: P) => (
  <svg {...base} {...p}>
    <path d='M12 3l9 5-9 5-9-5 9-5Z' />
    <path d='M3 12l9 5 9-5M3 16l9 5 9-5' />
  </svg>
)
export const IconRoute = (p: P) => (
  <svg {...base} {...p}>
    <circle cx='6' cy='19' r='2.5' />
    <circle cx='18' cy='5' r='2.5' />
    <path d='M8.5 19H14a3 3 0 0 0 0-6H10a3 3 0 0 1 0-6h5.5' />
  </svg>
)
export const IconHardHat = (p: P) => (
  <svg {...base} {...p}>
    <path d='M3 17h18' />
    <path d='M5 17v-2a7 7 0 0 1 14 0v2' />
    <path d='M10 8V5h4v3' />
  </svg>
)
