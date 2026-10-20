import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * Deep links inside the Design module.
 *
 * The host route owns `?section=`; each Design view keeps its own selection
 * next to it (`?section=adrs&adr=adr-123`, `?section=api-schemas&spec=…&op=…`),
 * so a catalog row, a toast or a pasted URL lands on the exact artifact.
 *
 * Adapted from the Develop module's `nav.ts`: when the host router is shared
 * it is used directly; when it is not (standalone remote in dev), the hooks
 * fall back to `location` + the History API and announce changes with
 * `popstate`, which the host router listens to.
 *
 * Values are encoded the way TanStack Router does: a string that would parse
 * as JSON (a number, `true`) is written quoted and read back as the string.
 */

export interface DesignParams {
  /** Open ADR id. */
  adr?: string
  /** ADR pane mode (`edit`). */
  mode?: string
  /** Open diagram id. */
  diagram?: string
  /** Open whiteboard id. */
  board?: string
  /** Open API spec id. */
  spec?: string
  /** Selected operation inside a spec (`GET /users/{id}`). */
  op?: string
  /** Page-level tab inside an editor. */
  tab?: string
  /** `1` — open the section's create flow (Design Dashboard "New" menu). */
  new?: string
}

const KEYS = ['adr', 'mode', 'diagram', 'board', 'spec', 'op', 'tab', 'new'] as const

function clean(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== '') out[k] = String(v)
  }
  return out
}

function decode(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      const v = JSON.parse(raw)
      if (typeof v === 'string') return v
    } catch { /* not JSON — keep raw */ }
  }
  return raw
}

function encode(v: string): string {
  try {
    JSON.parse(v)
    return JSON.stringify(v)
  } catch {
    return v
  }
}

function readSearch(): Record<string, string> {
  if (typeof location === 'undefined') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(location.search)) out[k] = decode(v)
  return out
}

function pick(s: Record<string, unknown>): DesignParams {
  const out: DesignParams = {}
  for (const k of KEYS) if (s[k] != null && s[k] !== '') out[k] = String(s[k])
  return out
}

function writeUrl(path: string, search: Record<string, string>, replace: boolean) {
  const qs = new URLSearchParams(Object.entries(search).map(([k, v]) => [k, encode(v)]))
    .toString()
  const url = `${path}${qs ? `?${qs}` : ''}`
  if (replace) history.replaceState(history.state, '', url)
  else history.pushState(history.state, '', url)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

function currentPath(): string {
  return typeof location !== 'undefined' && location.pathname !== '/'
    ? location.pathname
    : '/design'
}

/** The Design deep-link params on the current URL. */
export function useDesignParams(): DesignParams {
  const router = useRouter({ warn: false })
  const [params, setParams] = useState<DesignParams>(() => pick(readSearch()))
  useEffect(() => {
    const sync = () =>
      setParams((cur) => {
        const next = pick(readSearch())
        return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
      })
    sync()
    globalThis.addEventListener('popstate', sync)
    const unsubscribe = router?.history?.subscribe?.(sync)
    return () => {
      globalThis.removeEventListener('popstate', sync)
      unsubscribe?.()
    }
  }, [router])
  return params
}

/**
 * Patch the params of the current page. `push` adds a history entry (opening
 * an artifact, so Back returns to the list); the default replaces in place.
 */
export function useSetDesignParams() {
  const router = useRouter({ warn: false })
  return useCallback(
    (patch: DesignParams, opts: { push?: boolean } = {}) => {
      const replace = !opts.push
      if (router) {
        void router.navigate({
          to: currentPath(),
          search: ((prev: Record<string, unknown>) => clean({ ...prev, ...patch })) as never,
          replace,
        })
        return
      }
      writeUrl(currentPath(), clean({ ...readSearch(), ...patch }), replace)
    },
    [router],
  )
}

/** Absolute URL of the current page with `patch` applied — for "Copy link". */
export function designLink(patch: DesignParams): string {
  if (typeof location === 'undefined') return ''
  const search = clean({ ...readSearch(), ...patch })
  const qs = new URLSearchParams(Object.entries(search).map(([k, v]) => [k, encode(v)]))
    .toString()
  return `${location.origin}${currentPath()}${qs ? `?${qs}` : ''}`
}

/**
 * Run `open` once when the URL carries `new=1`, then drop the flag so a
 * reload or Back does not reopen the create flow.
 */
export function useNewFlag(open: () => void, ready = true) {
  const params = useDesignParams()
  const setParams = useSetDesignParams()
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!ready || !params.new) return
    setParams({ new: undefined })
    openRef.current()
  }, [ready, params.new, setParams])
}

/**
 * Navigate to another Design section with its own params
 * (`openDesign('diagrams', { diagram: id })`) — through the host router when
 * shared, else the History API.
 */
export function useOpenDesign() {
  const router = useRouter({ warn: false })
  return useCallback(
    (section: string, params: DesignParams = {}) => {
      const search = clean({ section, ...params })
      if (router) {
        void router.navigate({ to: '/design', search: search as never })
        return
      }
      writeUrl('/design', search, false)
    },
    [router],
  )
}

/** Plain href for a Design section deep link (for anchors and notifications). */
export function designHref(section: string, params: DesignParams = {}): string {
  const qs = new URLSearchParams(Object.entries(clean({ section, ...params })).map(([k, v]) => [k, encode(v)])).toString()
  return `/design${qs ? `?${qs}` : ''}`
}
