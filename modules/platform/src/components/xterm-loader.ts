/**
 * Lazy xterm.js loader (+ addon suite).
 *
 * xterm and its addons ship as UMD bundles that expect to attach to `window`,
 * so rather than pull them through Vite/MF we inject plain `<script>` tags
 * (plus the core stylesheet) from jsDelivr at runtime. Each UMD build registers
 * a global whose shape is `window.<Name>.<Name>` (e.g. `window.FitAddon.FitAddon`).
 *
 * The core terminal + fit addon are **required**; the remaining addons (search,
 * web-links, clipboard, unicode11, webgl) are **best-effort** — if one fails to
 * load from the CDN we simply omit it, so the terminal always comes up.
 *
 * The resolved API is cached on `window.__adharXterm` so every terminal
 * instance reuses the same runtime and we only touch the CDN once.
 */

const CDN = 'https://cdn.jsdelivr.net/npm/@xterm'

const XTERM_JS = `${CDN}/xterm@5.5.0/lib/xterm.js`
const XTERM_CSS = `${CDN}/xterm@5.5.0/css/xterm.css`
const FIT_JS = `${CDN}/addon-fit@0.10.0/lib/addon-fit.js`
const SEARCH_JS = `${CDN}/addon-search@0.15.0/lib/addon-search.js`
const WEBLINKS_JS = `${CDN}/addon-web-links@0.11.0/lib/addon-web-links.js`
const CLIPBOARD_JS = `${CDN}/addon-clipboard@0.1.0/lib/addon-clipboard.js`
const UNICODE11_JS = `${CDN}/addon-unicode11@0.8.0/lib/addon-unicode11.js`
const WEBGL_JS = `${CDN}/addon-webgl@0.18.0/lib/addon-webgl.js`

export interface XtermApi {
  Terminal: any
  FitAddon: any
  /** Optional addons — present only if their CDN script loaded successfully. */
  SearchAddon?: any
  WebLinksAddon?: any
  ClipboardAddon?: any
  Unicode11Addon?: any
  WebglAddon?: any
}

declare global {
  interface Window {
    Terminal?: any
    FitAddon?: { FitAddon: any }
    SearchAddon?: { SearchAddon: any }
    WebLinksAddon?: { WebLinksAddon: any }
    ClipboardAddon?: { ClipboardAddon: any }
    Unicode11Addon?: { Unicode11Addon: any }
    WebglAddon?: { WebglAddon: any }
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

/** Load an optional addon script; never rejects — resolves to whether it loaded. */
async function loadOptional(src: string, key: string): Promise<boolean> {
  try {
    await loadScript(src, key)
    return true
  } catch {
    return false
  }
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
    // The addons reference the core, so load xterm first.
    await loadScript(XTERM_JS, 'core')
    // Fit is required for sane geometry; load it up front.
    await loadScript(FIT_JS, 'fit')

    const Terminal = window.Terminal
    const FitAddon = window.FitAddon?.FitAddon
    if (!Terminal) throw new Error('xterm loaded but window.Terminal is undefined')
    if (!FitAddon) throw new Error('fit addon loaded but window.FitAddon.FitAddon is undefined')

    // Best-effort addons — load in parallel; a failure just omits the addon.
    const [search, weblinks, clipboard, unicode11, webgl] = await Promise.all([
      loadOptional(SEARCH_JS, 'search'),
      loadOptional(WEBLINKS_JS, 'weblinks'),
      loadOptional(CLIPBOARD_JS, 'clipboard'),
      loadOptional(UNICODE11_JS, 'unicode11'),
      loadOptional(WEBGL_JS, 'webgl'),
    ])

    return {
      Terminal,
      FitAddon,
      SearchAddon: search ? window.SearchAddon?.SearchAddon : undefined,
      WebLinksAddon: weblinks ? window.WebLinksAddon?.WebLinksAddon : undefined,
      ClipboardAddon: clipboard ? window.ClipboardAddon?.ClipboardAddon : undefined,
      Unicode11Addon: unicode11 ? window.Unicode11Addon?.Unicode11Addon : undefined,
      WebglAddon: webgl ? window.WebglAddon?.WebglAddon : undefined,
    }
  })()

  return window.__adharXterm
}
