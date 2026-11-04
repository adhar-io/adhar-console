import type { NodeKind } from '../data/live-flows.ts'

/**
 * One glyph per node kind, drawn in `currentColor` on a 24-unit grid so they
 * work inside the SVG canvas (nested <svg>) and in HTML lists alike.
 */
export function KindGlyph({ kind, size = 16 }: { kind: NodeKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[kind] ?? PATHS.workload}
    </svg>
  )
}

const PATHS: Record<NodeKind, React.ReactNode> = {
  // a box — a running workload
  workload: (
    <>
      <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z" />
      <path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v13c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-13" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </>
  ),
  // a bolt — fast in-memory
  cache: <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13z" />,
  // stacked bars — a log / queue
  queue: (
    <>
      <rect x="3.5" y="4" width="17" height="4" rx="1.2" />
      <rect x="3.5" y="10" width="17" height="4" rx="1.2" />
      <rect x="3.5" y="16" width="17" height="4" rx="1.2" />
    </>
  ),
  dns: (
    <>
      <path d="M12 3v18" />
      <path d="M5 6h11l3 2.5L16 11H5z" />
      <path d="M19 13H8l-3 2.5L8 18h11z" />
    </>
  ),
  world: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
    </>
  ),
  // an arched gate with an arrow in
  ingress: (
    <>
      <path d="M4 21V9a8 8 0 0 1 16 0v12" />
      <path d="M8 15h8M13 12l3 3-3 3" />
    </>
  ),
  host: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  // Kubernetes-ish helm wheel
  apiserver: (
    <>
      <path d="M12 2.5 20.2 6.6 22 15.5 16.3 22H7.7L2 15.5 3.8 6.6z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 6v3M12 15v3M6.5 9.5l2.8 1.3M14.7 13.2l2.8 1.3M6.5 14.5l2.8-1.3M14.7 10.8l2.8-1.3" />
    </>
  ),
  unmanaged: (
    <>
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" />
    </>
  ),
  restricted: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </>
  ),
  namespace: (
    <>
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" />
    </>
  ),
}
