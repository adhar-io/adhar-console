import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Full screen for the Visual Designer.
 *
 * The designer fills the whole window (a fixed layer above the console chrome)
 * and the PAGE — not the designer element — enters the browser's full screen.
 * Making the designer element itself the fullscreen element would hide every
 * dialog, menu and toast that is portalled to <body>; going full screen on the
 * document keeps them all working.
 *
 * Leaving: the toolbar button, ⌃⌘F, or Esc. When the browser's full screen is
 * active, Esc is the browser's to handle and `fullscreenchange` brings the
 * designer back; when the API is unavailable or refused (iframes, Safari on
 * iOS) the window-filling layer still works and Esc leaves it.
 */

interface FullscreenState {
  full: boolean
  toggle(): void
  exit(): void
}

const Ctx = createContext<FullscreenState>({ full: false, toggle() {}, exit() {} })

export function useBuilderFullscreen(): FullscreenState {
  return useContext(Ctx)
}

function docFullscreen(): Element | null {
  return typeof document === 'undefined' ? null : document.fullscreenElement
}

export function BuilderFullscreenProvider({ children }: { children(full: boolean): ReactNode }) {
  const [full, setFull] = useState(false)

  const enter = useCallback(() => {
    setFull(true)
    const el = typeof document === 'undefined' ? null : document.documentElement
    if (el?.requestFullscreen && !docFullscreen()) {
      el.requestFullscreen().catch(() => {
        // Refused or unsupported: the window-filling layer is enough.
      })
    }
  }, [])

  const exit = useCallback(() => {
    setFull(false)
    if (docFullscreen() && document.exitFullscreen) document.exitFullscreen().catch(() => {})
  }, [])

  const toggle = useCallback(() => (full ? exit() : enter()), [full, enter, exit])

  useEffect(() => {
    if (!full) return
    // The browser left full screen (its own Esc, F11): follow it.
    const onChange = () => {
      if (!docFullscreen()) setFull(false)
    }
    // Esc when the browser's full screen isn't active, and ⌃⌘F either way —
    // but never while a dialog is open or the user is typing.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest?.('.monaco-editor'))
      if (e.key === 'f' && e.ctrlKey && e.metaKey) {
        e.preventDefault()
        exit()
        return
      }
      if (e.key !== 'Escape' || typing || docFullscreen()) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      exit()
    }
    document.addEventListener('fullscreenchange', onChange)
    globalThis.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      globalThis.removeEventListener('keydown', onKey)
    }
  }, [full, exit])

  // Leaving the page while full screen must not strand the browser there.
  useEffect(() => () => {
    if (docFullscreen() && document.exitFullscreen) document.exitFullscreen().catch(() => {})
  }, [])

  // ⌃⌘F to enter as well.
  useEffect(() => {
    if (full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' && e.ctrlKey && e.metaKey) {
        e.preventDefault()
        enter()
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [full, enter])

  // The designer renders into one host element that MOVES: inside the page
  // normally, onto <body> in full screen. In the page it sits in the console's
  // content column, an isolated stacking context, so no z-index there can rise
  // above the sidebar and top bar — they covered the "full screen" designer.
  // On <body> its fixed layer is above them. Moving the host does not remount
  // anything (the portal target never changes), so editor state, undo history
  // and scroll survive the switch.
  const placeholder = useRef<HTMLDivElement>(null)
  const [host] = useState(() => {
    if (typeof document === 'undefined') return null
    const el = document.createElement('div')
    el.style.display = 'contents'
    el.dataset.builderHost = ''
    return el
  })
  useLayoutEffect(() => {
    if (!host) return
    const target = full ? document.body : placeholder.current
    if (target && host.parentNode !== target) target.appendChild(host)
  }, [full, host])
  useEffect(() => () => host?.remove(), [host])

  const content = <Ctx.Provider value={{ full, toggle, exit }}>{children(full)}</Ctx.Provider>
  if (!host) return content
  return (
    <>
      <div ref={placeholder} style={{ display: 'contents' }} />
      {createPortal(content, host)}
    </>
  )
}
