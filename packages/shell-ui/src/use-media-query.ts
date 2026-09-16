import { useSyncExternalStore } from 'react'

/**
 * `matchMedia` as a hook, SSR-safe.
 *
 * Layout decisions that CSS cannot make — which component tree to mount, not
 * how to style one — need the breakpoint in JavaScript: a rail that is a
 * column on a laptop and a slide-over on a phone is two different trees.
 * The server snapshot answers `false`, so markup is always the mobile-first
 * shape until the client measures.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof globalThis.matchMedia !== 'function') return () => {}
      const mq = globalThis.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(query).matches : false),
    () => false,
  )
}

/**
 * Tailwind's `lg` — where the console's sidebar becomes permanent, and the
 * same line past which a three-column surface has room to be three columns.
 * A tablet in portrait (768–1023px) still gets the phone tree: side rails as
 * sheets, one conversation column. Three columns at 768px left the
 * conversation 170px wide.
 */
export const useIsWide = () => useMediaQuery('(min-width: 1024px)')
