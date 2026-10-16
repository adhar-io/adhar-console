import { useCallback, useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * One URL param (`?doc=<id>`) for the Design pages that open a document in
 * place — the Visual Builder and Wireframes — so refresh and shared links land
 * on the open project. Same mechanics as Develop's nav.ts: the host router
 * when present, `history` otherwise; opening pushes (Back returns to the
 * library), closing replaces.
 */

function readParam(key: string): string | undefined {
  if (typeof location === 'undefined') return undefined
  return new URLSearchParams(location.search).get(key) ?? undefined
}

export function useUrlParam(key: string): [string | undefined, (value: string | undefined, opts?: { replace?: boolean }) => void] {
  const router = useRouter({ warn: false })
  const [value, setValue] = useState(() => readParam(key))

  useEffect(() => {
    const sync = () => setValue(readParam(key))
    sync()
    globalThis.addEventListener('popstate', sync)
    const unsubscribe = router?.history?.subscribe?.(sync)
    return () => {
      globalThis.removeEventListener('popstate', sync)
      unsubscribe?.()
    }
  }, [router, key])

  const set = useCallback(
    (next: string | undefined, opts?: { replace?: boolean }) => {
      const replace = opts?.replace ?? next === undefined
      setValue(next)
      if (router) {
        void router.navigate({
          to: location.pathname,
          search: ((prev: Record<string, unknown>) => {
            const out: Record<string, unknown> = { ...prev }
            if (next === undefined) delete out[key]
            else out[key] = next
            return out
          }) as never,
          replace,
        })
        return
      }
      const qs = new URLSearchParams(location.search)
      if (next === undefined) qs.delete(key)
      else qs.set(key, next)
      const url = `${location.pathname}${qs.toString() ? `?${qs}` : ''}`
      if (replace) history.replaceState(history.state, '', url)
      else history.pushState(history.state, '', url)
      globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
    },
    [router, key],
  )
  return [value, set]
}
