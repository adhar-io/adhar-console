/**
 * Lazy xterm.js loader (+ addon suite) — bundled, not fetched.
 *
 * xterm and its addons are workspace dependencies (see `deno.json`) pulled in
 * with dynamic `import()`, so Vite code-splits them into their own chunk that
 * only the terminal views load. Nothing is fetched from a CDN at runtime and
 * nothing attaches to `window`.
 *
 * Why not the CDN UMD builds: their wrapper takes the AMD branch whenever a
 * global `define.amd` exists — and Monaco's `vs/loader.js` installs exactly
 * that — so once any editor view had loaded, xterm registered itself as an
 * anonymous AMD module and `window.Terminal` stayed undefined. The shell then
 * only worked if it was the first thing opened. Bundling also removes the
 * dependency on jsDelivr reachability and on the deployment's CSP.
 *
 * The core terminal + fit addon are **required**; the remaining addons
 * (search, web-links, clipboard, unicode11, webgl) are **best-effort** — if
 * one fails to import we omit it, so the terminal always comes up.
 *
 * The resolved API is cached module-wide so every terminal instance shares
 * one runtime; a failed load is NOT cached, so the next mount retries.
 *
 * **Why the stylesheet is injected by hand.** This module is built as a Module
 * Federation remote (library output), so Vite hoists any imported CSS into the
 * remote's own `style.css` and expects *the consumer* to include it — but the
 * host never does, because the host has no idea the remote imported CSS. The
 * emitted file ends up orphaned: present in `dist/assets`, referenced by
 * nothing. Without it `.xterm-helper-textarea` loses its absolute
 * off-screen positioning, which is the element xterm focuses and reads
 * keystrokes from — so the terminal renders but you cannot type into it, and
 * the rows are unstyled. Importing the CSS `?inline` gives us the text instead
 * of an emitted file, and we put it in a `<style>` ourselves. That works
 * identically in dev, in a production host build and inside the remote.
 */

export interface XtermApi {
  Terminal: typeof import('@xterm/xterm').Terminal
  FitAddon: typeof import('@xterm/addon-fit').FitAddon
  /** Optional addons — present only if their chunk imported successfully. */
  SearchAddon?: typeof import('@xterm/addon-search').SearchAddon
  WebLinksAddon?: typeof import('@xterm/addon-web-links').WebLinksAddon
  ClipboardAddon?: typeof import('@xterm/addon-clipboard').ClipboardAddon
  Unicode11Addon?: typeof import('@xterm/addon-unicode11').Unicode11Addon
  WebglAddon?: typeof import('@xterm/addon-webgl').WebglAddon
}

const STYLE_ID = 'adhar-xterm-css'

/** Put xterm's stylesheet in the document exactly once. */
function injectStyles(css: string): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = css
  document.head.appendChild(el)
}

let cached: Promise<XtermApi> | null = null

/** Import an optional addon; never rejects — resolves to the export or undefined. */
async function optional<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load()
  } catch {
    return undefined
  }
}

export function loadXterm(): Promise<XtermApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('xterm requires a browser'))
  }
  if (cached) return cached

  cached = (async (): Promise<XtermApi> => {
    // Core + fit are required. The stylesheet comes in as text and is injected
    // by hand — see the note above on Module Federation and orphaned CSS.
    const [{ Terminal }, { FitAddon }, css] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css?inline').then((m) => m.default as string),
    ])
    injectStyles(css)

    // Best-effort addons — in parallel; a failure just omits the addon.
    const [search, weblinks, clipboard, unicode11, webgl] = await Promise.all([
      optional(() => import('@xterm/addon-search').then((m) => m.SearchAddon)),
      optional(() => import('@xterm/addon-web-links').then((m) => m.WebLinksAddon)),
      optional(() => import('@xterm/addon-clipboard').then((m) => m.ClipboardAddon)),
      optional(() => import('@xterm/addon-unicode11').then((m) => m.Unicode11Addon)),
      optional(() => import('@xterm/addon-webgl').then((m) => m.WebglAddon)),
    ])

    return {
      Terminal,
      FitAddon,
      SearchAddon: search,
      WebLinksAddon: weblinks,
      ClipboardAddon: clipboard,
      Unicode11Addon: unicode11,
      WebglAddon: webgl,
    }
  })()

  // Don't pin a failure: a transient chunk-load error (deploy mid-navigation,
  // flaky network) must not break every later terminal until a full reload.
  cached.catch(() => {
    cached = null
  })

  return cached
}
