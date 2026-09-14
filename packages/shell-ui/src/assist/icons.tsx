import type { ReactNode } from 'react'

/**
 * Icons for the Adhar AI surface. Stroke icons on a 24-grid, sized by the
 * caller, currentColor throughout so they follow text colour in both themes.
 */

export const I = ({ children, size = 14, sw = 2, className }: { children: ReactNode; size?: number; sw?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className ?? 'shrink-0'}>
    {children}
  </svg>
)

export const IconX = ({ size = 16 }: { size?: number }) => <I size={size}><path d="M18 6 6 18M6 6l12 12" /></I>
export const IconPlus = ({ size = 12 }: { size?: number }) => <I size={size} sw={2.5}><path d="M12 5v14M5 12h14" /></I>
export const IconCanvas = ({ size = 13 }: { size?: number }) => <I size={size}><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></I>
export const IconReturn = ({ size = 12 }: { size?: number }) => <I size={size} sw={2.25}><polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></I>
export const IconStop = ({ size = 12 }: { size?: number }) => <I size={size} sw={2.5}><rect x="6" y="6" width="12" height="12" rx="2" /></I>
export const IconRefresh = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></I>
export const IconTool = ({ size = 11 }: { size?: number }) => <I size={size}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.3-.6-.6-2.3 2.1-2.1z" /></I>
export const IconPin = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></I>
export const IconTrash = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></I>
export const IconSearch = ({ size = 13 }: { size?: number }) => <I size={size}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>
export const IconBook = ({ size = 13 }: { size?: number }) => <I size={size}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></I>
export const IconServer = ({ size = 13 }: { size?: number }) => <I size={size}><rect x="2" y="3" width="20" height="7" rx="2" /><rect x="2" y="14" width="20" height="7" rx="2" /><path d="M6 6.5h.01M6 17.5h.01" /></I>
export const IconActivity = ({ size = 13 }: { size?: number }) => <I size={size}><path d="M3 12h4l3-8 4 16 3-8h4" /></I>
export const IconCompass = ({ size = 13 }: { size?: number }) => <I size={size}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></I>
export const IconThumbUp = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M7 10v11" /><path d="M15 5.5 14 10h5.5a2 2 0 0 1 2 2.3l-1.2 6.4a2 2 0 0 1-2 1.6H7V10l4.4-7a2.6 2.6 0 0 1 3.6 2.5z" /></I>
export const IconThumbDown = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M17 14V3" /><path d="M9 18.5 10 14H4.5a2 2 0 0 1-2-2.3l1.2-6.4a2 2 0 0 1 2-1.6H17v10l-4.4 7a2.6 2.6 0 0 1-3.6-2.5z" /></I>
export const IconCopy = ({ size = 12 }: { size?: number }) => <I size={size}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></I>
export const IconCheck = ({ size = 12 }: { size?: number }) => <I size={size} sw={2.5}><path d="m5 12 5 5L20 7" /></I>
export const IconChevronDown = ({ size = 12 }: { size?: number }) => <I size={size}><path d="m6 9 6 6 6-6" /></I>
export const IconChevronRight = ({ size = 12 }: { size?: number }) => <I size={size}><path d="m9 6 6 6-6 6" /></I>
export const IconSidebar = ({ size = 14 }: { size?: number }) => <I size={size}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></I>
export const IconPanelRight = ({ size = 14 }: { size?: number }) => <I size={size}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" /></I>
export const IconBolt = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></I>
export const IconShield = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z" /></I>
export const IconDoc = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h6" /></I>
export const IconSave = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></I>
export const IconSlash = ({ size = 12 }: { size?: number }) => <I size={size}><path d="m16 4-8 16" /></I>
export const IconAt = ({ size = 12 }: { size?: number }) => <I size={size}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></I>
export const IconDot = () => <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden><circle cx="3" cy="3" r="2" fill="currentColor" /></svg>

export function SparkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4L12 2z" />
    </svg>
  )
}

export function Dots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.2s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.1s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400" />
    </span>
  )
}
