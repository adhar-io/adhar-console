/**
 * Lazy Monaco loader (decide-local copy).
 *
 * Monaco is huge (~3 MB) and has its own AMD-style loader that conflicts
 * with bundlers, so we skip Vite/MF entirely and pull it from jsDelivr at
 * runtime via a `<script>` tag. The official `vs/loader.js` defines a
 * global `require()` (AMD), then we ask it to load the editor entry.
 *
 * Result is cached on `window.__adharMonaco` so every editor instance
 * reuses the same runtime. This is a deliberate local duplicate of
 * `modules/platform/src/components/monaco-loader.ts` — remotes must not
 * import each other's internals across the module-federation boundary.
 */

const VS_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs'

interface MonacoApi {
  editor: {
    create(element: HTMLElement, options?: unknown): MonacoEditorInstance
    defineTheme(name: string, theme: unknown): void
    setTheme(name: string): void
    setModelLanguage?(model: unknown, language: string): void
    createModel?(value: string, language?: string): unknown
  }
  languages: {
    typescript?: {
      typescriptDefaults?: { setCompilerOptions(opts: unknown): void; setEagerModelSync(b: boolean): void }
      javascriptDefaults?: { setCompilerOptions(opts: unknown): void }
    }
  }
  KeyMod: Record<string, number>
  KeyCode: Record<string, number>
}

export interface MonacoEditorInstance {
  getValue(): string
  setValue(v: string): void
  getModel(): unknown
  dispose(): void
  layout(): void
  focus(): void
  onDidChangeModelContent(cb: () => void): { dispose(): void }
  addCommand(keybinding: number, handler: () => void): string | null
  updateOptions(opts: Record<string, unknown>): void
  setModel?(model: unknown): void
}

declare global {
  interface Window {
    require?: ((deps: string[], cb: (...mods: unknown[]) => void) => void) & {
      config?(opts: { paths: Record<string, string> }): void
    }
    monaco?: MonacoApi
    __adharMonaco?: Promise<MonacoApi>
  }
}

/**
 * Point Monaco's language workers at the CDN.
 *
 * Monaco runs its language services — JSON schema validation, folding,
 * formatting, hovers — in Web Workers. It builds the worker URL from the same
 * origin it was loaded from, and browsers refuse to construct a Worker from a
 * cross-origin URL. Loading Monaco from jsDelivr therefore gives you an editor
 * that *appears* but whose language services throw on construction: JSON and
 * YAML come up unhighlighted or blank, which is exactly the "editor doesn't
 * load correctly" symptom.
 *
 * The fix is the documented one for CDN-hosted Monaco: hand it a tiny same-origin
 * `data:` worker that sets `baseUrl` and then `importScripts` the real worker
 * from the CDN. `importScripts` is not subject to the worker-origin rule, so the
 * language services start normally.
 */
function installWorkerEnvironment() {
  const g = globalThis as typeof globalThis & {
    MonacoEnvironment?: { getWorkerUrl?(moduleId: string, label: string): string }
  }
  if (g.MonacoEnvironment?.getWorkerUrl) return
  g.MonacoEnvironment = {
    getWorkerUrl() {
      const shim =
        `self.MonacoEnvironment={baseUrl:'${VS_BASE}/'};importScripts('${VS_BASE}/base/worker/workerMain.js');`
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(shim)}`
    },
  }
}

let initialized = false

export function loadMonaco(): Promise<MonacoApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Monaco requires a browser'))
  }
  if (window.__adharMonaco) return window.__adharMonaco

  // Must be set before `editor.main` initialises, or Monaco captures the
  // default (same-origin) worker URL and every language service fails.
  installWorkerEnvironment()

  window.__adharMonaco = new Promise<MonacoApi>((resolve, reject) => {
    if (window.monaco) {
      resolve(window.monaco)
      return
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[data-adhar-monaco="1"]`)
    const onLoaderReady = () => {
      const req = window.require
      if (!req) {
        reject(new Error('Monaco AMD loader did not register window.require'))
        return
      }
      req.config?.({ paths: { vs: VS_BASE } })
      req(['vs/editor/editor.main'], () => {
        if (!window.monaco) {
          reject(new Error('Monaco loaded but window.monaco is undefined'))
          return
        }
        resolve(window.monaco)
      })
    }
    if (existing) {
      // The tag may already have finished loading — its `load` event fired
      // before we attached, and will never fire again, leaving this promise
      // pending forever and the editor permanently blank. `window.require`
      // being present is the signal that the loader is already usable.
      if ((globalThis as { require?: unknown }).require) {
        onLoaderReady()
        return
      }
      existing.addEventListener('load', onLoaderReady)
      existing.addEventListener('error', () => reject(new Error('Failed to load Monaco AMD loader')))
      return
    }
    const s = document.createElement('script')
    s.src = `${VS_BASE}/loader.min.js`
    s.async = true
    s.dataset.adharMonaco = '1'
    s.onload = onLoaderReady
    s.onerror = () => reject(new Error(`Failed to load ${s.src}`))
    document.head.appendChild(s)
  }).then((m) => {
    if (!initialized) {
      // Brand-tinted theme (mirrors Mermaid theme variables).
      m.editor.defineTheme('adhar-light', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#ffffff',
          'editor.foreground': '#0f172a',
          'editor.lineHighlightBackground': '#f8fafc',
          'editor.selectionBackground': '#e0e7ff',
          'editorLineNumber.foreground': '#cbd5e1',
          'editorLineNumber.activeForeground': '#6366f1',
          'editorIndentGuide.background': '#f1f5f9',
          'editorCursor.foreground': '#6366f1',
        },
      })
      m.editor.setTheme('adhar-light')
      initialized = true
    }
    return m
  })

  return window.__adharMonaco
}
