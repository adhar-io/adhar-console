import { useCallback, useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * Deep links inside the Design module.
 *
 * The host route owns `?section=`; each view keeps its own selection next to
 * it (`?section=personas&persona=persona-priya`), so a dashboard row, a toast
 * or a pasted URL lands on the exact persona, journey, token tab or component.
 *
 * This module is a federated remote. When the host's router is shared it is
 * used directly; when it is not (an older host, a standalone remote in dev),
 * the hooks fall back to `location` + the History API and announce changes
 * with `popstate`, which the host router listens to — so a missing router
 * context degrades to plain URLs instead of crashing the page.
 *
 * Values are encoded the way TanStack Router does: a string that would parse
 * as JSON (a number, `true`) is written quoted, and read back as the string.
 * (Same approach as `modules/develop/src/data/nav.ts`.)
 */

export type DesignSection =
  | 'dashboard'
  | 'adrs'
  | 'diagrams'
  | 'whiteboard'
  | 'personas'
  | 'journeys'
  | 'wireframes'
  | 'tokens'
  | 'api-schemas'
  | 'catalog'
  | 'builder'

export interface DesignParams {
  /** Personas: the open persona. */
  persona?: string
  /** Personas: comma-separated ids in the compare view. */
  compare?: string
  /** Journey Maps: the open journey. */
  journey?: string
  /** Page-level tab of a section (Design Tokens, Component Catalog). */
  tab?: string
  /** Component Catalog: the open component. */
  component?: string
  /** Free-text filter of a list. */
  q?: string
  /** `1` opens the section's "create" dialog (quick-create links). */
  new?: string
  /** Item selections owned by other Design views (ADRs, diagrams, …). */
  adr?: string
  diagram?: string
  board?: string
  spec?: string
  wireframe?: string
  /** Wireframes: the frame open in the editor. */
  doc?: string
  /** Tenancy scope: the Adhar project (slug) the Design pages are narrowed to. */
  project?: string
  /** Visual Designer: repository / branch to open, and the wireframe to start from. */
  repo?: string
  branch?: string
  from?: string
}

const KEYS = [
  'persona',
  'compare',
  'journey',
  'tab',
  'component',
  'q',
  'new',
  'adr',
  'diagram',
  'board',
  'spec',
  'wireframe',
  'doc',
  'project',
  'repo',
  'branch',
  'from',
] as const

function clean(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== '') out[k] = String(v)
  }
  return out
}

/** Decode one search value as TanStack Router wrote it. */
function decode(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      const v = JSON.parse(raw)
      if (typeof v === 'string') return v
    } catch { /* not JSON — keep raw */ }
  }
  return raw
}

/** Encode one value as TanStack Router would, so either side can read it. */
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
  const qs = new URLSearchParams(Object.entries(search).map(([k, v]) => [k, encode(v)])).toString()
  const url = `${path}${qs ? `?${qs}` : ''}`
  if (replace) history.replaceState(history.state, '', url)
  else history.pushState(history.state, '', url)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

function currentPath(): string {
  return typeof location !== 'undefined' && location.pathname !== '/' ? location.pathname : '/design'
}

/** The Design deep-link params on the current URL. */
export function useDesignParams(): DesignParams {
  const router = useRouter({ warn: false })
  // Prefer the router's own location (it may not be the browser's, e.g. a
  // memory history); fall back to `location` when there is no router.
  const read = useCallback(
    (): DesignParams =>
      pick(
        (router?.state?.location?.search as Record<string, unknown> | undefined) ?? readSearch(),
      ),
    [router],
  )
  const [params, setParams] = useState<DesignParams>(read)
  useEffect(() => {
    const sync = () =>
      setParams((cur) => {
        const next = read()
        return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
      })
    sync()
    globalThis.addEventListener('popstate', sync)
    const unsubHistory = router?.history?.subscribe?.(sync)
    const unsubResolved = router?.subscribe?.('onResolved', sync)
    return () => {
      globalThis.removeEventListener('popstate', sync)
      unsubHistory?.()
      unsubResolved?.()
    }
  }, [router, read])
  return params
}

/**
 * Patch the params of the current page in place (no new history entry).
 * `undefined` / `''` removes a key.
 */
export function useSetDesignParams() {
  const router = useRouter({ warn: false })
  return useCallback(
    (patch: DesignParams) => {
      if (router) {
        void router.navigate({
          to: router.state?.location?.pathname || currentPath(),
          search: ((prev: Record<string, unknown>) => clean({ ...prev, ...patch })) as never,
          replace: true,
        })
        return
      }
      writeUrl(currentPath(), clean({ ...readSearch(), ...patch }), true)
    },
    [router],
  )
}

/** Go to another Design section, optionally straight to one item. */
export function useGoDesign() {
  const router = useRouter({ warn: false })
  return useCallback(
    (section: DesignSection, params: DesignParams = {}) => {
      // The project scope follows you between Design sections.
      const carried = 'project' in params ? {} : { project: pick(readSearch()).project }
      const search = clean({ section, ...carried, ...params })
      if (router) {
        void router.navigate({ to: '/design', search: search as never })
        return
      }
      writeUrl('/design', search, false)
    },
    [router],
  )
}

/** A plain href for a Design deep link (for anchors / copy-link). */
export function designHref(section: DesignSection, params: DesignParams = {}): string {
  const qs = new URLSearchParams(
    Object.entries(clean({ section, ...params })).map(([k, v]) => [k, encode(v)]),
  ).toString()
  return `/design?${qs}`
}
