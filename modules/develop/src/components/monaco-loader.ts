/**
 * Lazy Monaco loader.
 *
 * Monaco is huge (~3 MB) and has its own AMD-style loader that conflicts
 * with bundlers, so we skip Vite/MF entirely and pull it from jsDelivr at
 * runtime via a `<script>` tag. The official `vs/loader.js` defines a
 * global `require()` (AMD), then we ask it to load the editor entry.
 *
 * Result is cached on `window.__adharMonaco` so every editor instance
 * reuses the same runtime.
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

let initialized = false

export function loadMonaco(): Promise<MonacoApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Monaco requires a browser'))
  }
  if (window.__adharMonaco) return window.__adharMonaco

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
      // Permissive TS so seeded files don't produce noise from missing deps.
      m.languages.typescript?.typescriptDefaults?.setCompilerOptions?.({
        target: 99, // ESNext
        module: 99, // ESNext
        moduleResolution: 2, // NodeJs
        jsx: 4, // react-jsx
        allowNonTsExtensions: true,
        allowJs: true,
        noEmit: true,
        strict: false,
        skipLibCheck: true,
      })
      initialized = true
    }
    return m
  })

  return window.__adharMonaco
}

/** Best-effort language id from a file extension. */
export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'go':
      return 'go'
    case 'py':
      return 'python'
    case 'rs':
      return 'rust'
    case 'sh':
      return 'shell'
    case 'sql':
      return 'sql'
    default:
      return 'plaintext'
  }
}
