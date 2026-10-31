import { useCallback, useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * URL params for the Design pages that open something in place — the Visual
 * Designer (`?repo=&branch=&page=`) and Wireframes (`?doc=`) — so refresh and
 * shared links land on it. Same mechanics as Develop's nav.ts: the host
 * router when present, `history` otherwise.
 */

function read(keys: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  if (typeof location === 'undefined') return out
  const q = new URLSearchParams(location.search)
  for (const k of keys) out[k] = q.get(k) ?? undefined
  return out
}

export type ParamPatch = Record<string, string | undefined>

export function useUrlParams<K extends string>(keys: readonly K[]): [Record<K, string | undefined>, (patch: Partial<Record<K, string | undefined>>, opts?: { replace?: boolean }) => void] {
  const router = useRouter({ warn: false })
  const keyStr = keys.join(',')
  const [values, setValues] = useState(() => read(keys) as Record<K, string | undefined>)

  useEffect(() => {
    const ks = keyStr.split(',')
    const sync = () => setValues((cur) => {
      const next = read(ks) as Record<K, string | undefined>
      return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
    })
    sync()
    globalThis.addEventListener('popstate', sync)
    // TanStack Router notifies before it writes the URL (`window.history` is
    // updated in a microtask), so reading `location` here would see the
    // previous URL — every drawer one navigation behind. Read after it.
    const unsubscribe = router?.history?.subscribe?.(() => queueMicrotask(sync))
    return () => {
      globalThis.removeEventListener('popstate', sync)
      unsubscribe?.()
    }
  }, [router, keyStr])

  const set = useCallback(
    (patch: Partial<Record<K, string | undefined>>, opts?: { replace?: boolean }) => {
      const replace = opts?.replace ?? false
      setValues((cur) => ({ ...cur, ...patch }))
      const apply = (prev: Record<string, unknown>) => {
        const out: Record<string, unknown> = { ...prev }
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete out[k]
          else out[k] = v
        }
        return out
      }
      if (router) {
        void router.navigate({ to: location.pathname, search: apply as never, replace })
        return
      }
      const q = new URLSearchParams(location.search)
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) q.delete(k)
        else q.set(k, String(v))
      }
      const url = `${location.pathname}${q.toString() ? `?${q}` : ''}`
      if (replace) history.replaceState(history.state, '', url)
      else history.pushState(history.state, '', url)
      globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
    },
    [router],
  )
  return [values, set]
}

/** One param — kept for the pages that only need `?doc=`. */
export function useUrlParam(key: string): [string | undefined, (value: string | undefined, opts?: { replace?: boolean }) => void] {
  const [values, set] = useUrlParams([key] as const)
  const setOne = useCallback((value: string | undefined, opts?: { replace?: boolean }) => set({ [key]: value } as never, { replace: opts?.replace ?? value === undefined }), [set, key])
  return [values[key], setOne]
}
