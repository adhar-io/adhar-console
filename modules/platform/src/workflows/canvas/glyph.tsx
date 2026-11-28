import { cn } from '@adhar/utils'
import type { Glyph, KindLook } from './kind-look.ts'

/** The kind glyphs (§6.8), drawn at 18 px in the kind's tile. No @xyflow: the palette and the inspector use them too. */
export function KindGlyph({ glyph, size = 18 }: { glyph: Glyph; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (glyph) {
    case 'container':
      return <svg {...p}><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></svg>
    case 'script':
      return <svg {...p}><path d="m7 8-4 4 4 4M17 8l4 4-4 4M14 4l-4 16" /></svg>
    case 'resource':
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18" /></svg>
    case 'http':
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
    case 'approval':
      return <svg {...p}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></svg>
    case 'timer':
      return <svg {...p}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M9 2h6" /></svg>
    case 'template':
      return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>
    case 'platform':
      return <svg {...p}><path d="M12 2 3 7l9 5 9-5z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></svg>
    case 'group':
      return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><path d="M10 6.5h4a3 3 0 0 1 3 3V14" /></svg>
    case 'batch':
      return <svg {...p}><rect x="3" y="4" width="18" height="4" rx="1" /><rect x="3" y="10" width="18" height="4" rx="1" /><rect x="3" y="16" width="18" height="4" rx="1" /></svg>
    case 'chaos':
      return <svg {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>
    case 'fan-out':
      return <svg {...p}><circle cx="5" cy="12" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="12" r="2" /><circle cx="19" cy="19" r="2" /><path d="M7 12h10M7 11l10-5M7 13l10 5" /></svg>
    case 'exit':
      return <svg {...p}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>
    default:
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01" /></svg>
  }
}

export function KindTile({ look, size = 40, className }: { look: KindLook; size?: number; className?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-lg', look.tile, className)} style={{ width: size, height: size }} title={look.label}>
      <KindGlyph glyph={look.glyph} size={Math.round(size * 0.45)} />
    </span>
  )
}
