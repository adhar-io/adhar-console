/**
 * Persistence for the side drawers' "wide" mode.
 *
 * Every side drawer in the console can be widened for reading (the behaviour
 * the catalog's TechDocs tab pioneered). The choice is remembered per drawer
 * id, so the PipelineRun drawer can stay wide while the audit-event drawer
 * stays narrow. Storage is best-effort: in a private window, a sandboxed
 * preview, or with site data blocked, `localStorage` can throw on access — the
 * preference then lives in memory for the session and the drawer still works.
 *
 * Kept free of React so it can be unit tested on its own; the hook in
 * `drawer-width.tsx` subscribes to it.
 */

export const DRAWER_WIDE_PREFIX = 'adhar.drawer.wide.'

/**
 * The wide width, applied from `lg` up only — below that the drawers are
 * already (nearly) full width and the toggle is hidden. It is a literal so the
 * Tailwind scanner sees it.
 */
export const DRAWER_WIDE_CLASS = 'lg:max-w-[min(100rem,calc(100vw-3rem))]'

/** Animated width change; skipped for people who asked for reduced motion. */
export const DRAWER_TRANSITION_CLASS = 'motion-safe:transition-[max-width] motion-safe:duration-200 motion-safe:ease-out'

/** Minimal storage shape so tests can pass a fake (or a throwing one). */
export interface DrawerStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const memory = new Map<string, boolean>()
const listeners = new Set<() => void>()

function defaultStorage(): DrawerStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}

/** Read the saved preference for a drawer; `undefined` when nothing was saved. */
export function readDrawerWide(id: string, storage: DrawerStorage | undefined = defaultStorage()): boolean | undefined {
  if (memory.has(id)) return memory.get(id)
  try {
    const raw = storage?.getItem(DRAWER_WIDE_PREFIX + id)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* storage unavailable — fall through to "no preference" */
  }
  return undefined
}

/**
 * Save the preference. Always lands in memory (so every open instance agrees
 * for the rest of the session) and in storage when storage works.
 */
export function writeDrawerWide(id: string, wide: boolean, storage: DrawerStorage | undefined = defaultStorage()): void {
  memory.set(id, wide)
  try {
    storage?.setItem(DRAWER_WIDE_PREFIX + id, wide ? '1' : '0')
  } catch {
    /* storage unavailable — the choice lasts for this session only */
  }
  for (const l of [...listeners]) l()
}

export function subscribeDrawerWide(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget the in-memory copies. */
export function resetDrawerWideMemory(): void {
  memory.clear()
}

/**
 * The drawer panel's width classes: its own standard max width, the wide
 * override when on, and the transition. `base` must not carry `lg:` or wider
 * breakpoint max-widths, or they would compete with the wide class.
 */
export function drawerWidthClass(base: string, wide: boolean): string {
  return [base, wide ? DRAWER_WIDE_CLASS : '', DRAWER_TRANSITION_CLASS].filter(Boolean).join(' ')
}

/** True when a keydown came from somewhere typing should win (inputs, editors). */
export function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as (HTMLElement & { isContentEditable?: boolean }) | null
  if (!node || typeof node !== 'object' || !('tagName' in node)) return false
  const tag = String(node.tagName).toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (node.isContentEditable) return true
  // Code editors (CodeMirror/Monaco) put focus on inner nodes with role=textbox.
  return typeof node.closest === 'function' && !!node.closest('[contenteditable="true"],[role="textbox"],.cm-editor,.monaco-editor')
}
