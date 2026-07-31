/**
 * Lazy xterm.js loader.
 *
 * xterm ships as a UMD bundle that expects to attach to `window`, so rather
 * than pull it through Vite/MF we inject a plain `<script>` (plus its stylesheet
 * and the fit addon) from jsDelivr at runtime. The UMD builds register the
 * globals `window.Terminal` and `window.FitAddon`.
 *
 * The resolved API is cached on `window.__adharXterm` so every terminal
 * instance reuses the same runtime and we only touch the CDN once.
 */

const XTERM_JS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js'
const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css'
const FIT_JS = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js'

export interface XtermApi {
  Terminal: any
  FitAddon: any
}

declare global {
  interface Window {
    Terminal?: any
    FitAddon?: { FitAddon: any }
    __adharXterm?: Promise<XtermApi>
  }
}

/** Inject a `<script>` once (keyed by `data-adhar-xterm`) and resolve on load. */
function loadScript(src: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-adhar-xterm="${key}"]`)
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve()
        return
      }
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)))
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.dataset.adharXterm = key
    s.onload = () => {
      s.dataset.loaded = '1'
      resolve()
    }
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}

/** Inject the xterm stylesheet once. */
function loadStyle(href: string, key: string): void {
  if (document.querySelector(`link[data-adhar-xterm="${key}"]`)) return
  const l = document.createElement('link')
  l.rel = 'stylesheet'
  l.href = href
  l.dataset.adharXterm = key
  document.head.appendChild(l)
}

export function loadXterm(): Promise<XtermApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('xterm requires a browser'))
  }
  if (window.__adharXterm) return window.__adharXterm

  window.__adharXterm = (async () => {
    loadStyle(XTERM_CSS, 'css')
    // The fit addon references the core, so load xterm first.
    await loadScript(XTERM_JS, 'core')
    await loadScript(FIT_JS, 'fit')
    const Terminal = window.Terminal
    const FitAddon = window.FitAddon?.FitAddon
    if (!Terminal) throw new Error('xterm loaded but window.Terminal is undefined')
    if (!FitAddon) throw new Error('fit addon loaded but window.FitAddon.FitAddon is undefined')
    return { Terminal, FitAddon }
  })()

  return window.__adharXterm
}
