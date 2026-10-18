/**
 * Monaco for the console host — bundled, worker-free, lazily loaded.
 *
 * The same approach as `modules/platform/src/components/monaco-loader.ts`
 * (read its header for the why): `editor.api` plus the main-thread Monarch
 * grammars, no language-service workers, so it builds on the pinned Deno in
 * the image and runs on air-gapped installs. Differences:
 *
 *   • The host is not a federated remote, so it keeps its OWN runtime on its
 *     own global. The remotes share `__adharMonaco`; mixing their copy of the
 *     API with this bundle's editor contributions would register the find
 *     widget and folding on the wrong instance.
 *   • `editor.api` is the bare editor. A viewer wants find (⌘F), folding,
 *     bracket matching, sticky scroll and the context menu, which live in
 *     `contrib/`; each is imported for its side effect. None needs a worker.
 */

import type * as Monaco from 'monaco-editor'

export type MonacoApi = typeof Monaco
export type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor

declare global {
  // eslint-disable-next-line no-var
  var __adharConsoleMonaco: Promise<MonacoApi> | undefined
}


export function loadMonaco(): Promise<MonacoApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Monaco requires a browser'))
  if (globalThis.__adharConsoleMonaco) return globalThis.__adharConsoleMonaco
  globalThis.__adharConsoleMonaco = Promise.all([
    import('monaco-editor/esm/vs/editor/editor.api'),
    // The stylesheet travels with the editor chunk, not the drawer's bundle.
    import('monaco-editor/min/vs/editor/editor.main.css?inline').then((m) => ensureCss((m as { default: string }).default)),
    import('monaco-editor/esm/vs/basic-languages/yaml/yaml.js'),
    import('monaco-editor/esm/vs/editor/contrib/find/browser/findController.js'),
    import('monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js'),
    import('monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js'),
    import('monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollContribution.js'),
    import('monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js'),
    import('monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js'),
    import('monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js'),
  ])
    .then(([api, , yaml]) => {
      const monaco = api as unknown as MonacoApi
      const grammar = yaml as { conf: Monaco.languages.LanguageConfiguration; language: Monaco.languages.IMonarchLanguage }
      if (!monaco.languages.getLanguages().some((l) => l.id === 'yaml')) {
        monaco.languages.register({ id: 'yaml', extensions: ['.yaml', '.yml'], aliases: ['YAML', 'yaml'] })
      }
      monaco.languages.setMonarchTokensProvider('yaml', grammar.language)
      monaco.languages.setLanguageConfiguration('yaml', grammar.conf)
      registerJson(monaco)
      defineThemes(monaco)
      return monaco
    })
    .catch((err) => {
      globalThis.__adharConsoleMonaco = undefined
      throw err instanceof Error ? err : new Error(String(err))
    })
  return globalThis.__adharConsoleMonaco
}

function ensureCss(monacoCss: string): void {
  if (typeof document === 'undefined' || document.getElementById('adhar-console-monaco-css')) return
  const el = document.createElement('style')
  el.id = 'adhar-console-monaco-css'
  el.textContent = monacoCss
  document.head.appendChild(el)
}

/** JSON highlighting without the JSON language service (which needs a worker). */
function registerJson(monaco: MonacoApi): void {
  if (!monaco.languages.getLanguages().some((l) => l.id === 'json')) {
    monaco.languages.register({ id: 'json', extensions: ['.json'], aliases: ['JSON', 'json'] })
  }
  monaco.languages.setMonarchTokensProvider('json', {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\],:]/, 'delimiter'],
        [/\s+/, 'white'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage)
  monaco.languages.setLanguageConfiguration('json', {
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
    folding: { markers: { start: /^\s*[{[]\s*$/, end: /^\s*[}\]]/ } },
  })
}

function defineThemes(monaco: MonacoApi): void {
  applyConsoleTheme(monaco)
}

/* ───────────────────────── theme from the console's tokens ───────────────────────── */

export const CONSOLE_THEME = 'adhar-console'

/**
 * Resolve any CSS colour — the console's tokens are `oklch(...)`, which
 * Monaco's theme API cannot read — to `#rrggbb` by painting one pixel.
 */
function toHex(css: string, fallback: string): string {
  if (typeof document === 'undefined' || !css) return fallback
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return fallback
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return fallback
  }
}

function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return toHex(v, fallback)
}

export function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

/**
 * Define (or redefine) the editor theme from the console's live tokens —
 * surface, edge, content and brand — so the editor IS the console surface in
 * either mode and under any brand preset, then apply it. Called on load and
 * whenever `<html>`'s class changes.
 */
export function applyConsoleTheme(monaco: MonacoApi): void {
  const dark = isDark()
  const bg = token('--color-surface-raised', dark ? '#111827' : '#ffffff')
  const sunken = token('--color-surface-sunken', dark ? '#0b1220' : '#f1f5f9')
  const edge = token('--color-edge-default', dark ? '#1e293b' : '#e2e8f0')
  const strong = token('--color-edge-strong', dark ? '#334155' : '#cbd5e1')
  const text = token('--color-content', dark ? '#e2e8f0' : '#0f172a')
  const muted = token('--color-content-muted', dark ? '#94a3b8' : '#475569')
  const subtle = token('--color-content-subtle', dark ? '#64748b' : '#94a3b8')
  const brand = token('--color-brand-500', '#3b82f6')
  const strip = (h: string) => h.replace('#', '')
  const rules = dark
    ? [
      { token: 'type', foreground: '93c5fd', fontStyle: 'bold' },
      { token: 'string', foreground: '6ee7b7' },
      { token: 'string.escape', foreground: 'fcd34d' },
      { token: 'number', foreground: 'fcd34d' },
      { token: 'keyword', foreground: 'c4b5fd', fontStyle: 'bold' },
      { token: 'comment', foreground: strip(subtle), fontStyle: 'italic' },
      { token: 'tag', foreground: 'f9a8d4' },
      { token: 'operators', foreground: strip(muted) },
      { token: 'delimiter', foreground: strip(muted) },
    ]
    : [
      { token: 'type', foreground: '1d4ed8', fontStyle: 'bold' },
      { token: 'string', foreground: '047857' },
      { token: 'string.escape', foreground: 'b45309' },
      { token: 'number', foreground: 'b45309' },
      { token: 'keyword', foreground: '7c3aed', fontStyle: 'bold' },
      { token: 'comment', foreground: strip(subtle), fontStyle: 'italic' },
      { token: 'tag', foreground: 'be185d' },
      { token: 'operators', foreground: strip(muted) },
      { token: 'delimiter', foreground: strip(muted) },
    ]
  monaco.editor.defineTheme(CONSOLE_THEME, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [{ token: '', foreground: strip(text) }, ...rules],
    colors: {
      'editor.background': bg,
      'editor.foreground': text,
      'editorGutter.background': bg,
      'editorLineNumber.foreground': subtle,
      'editorLineNumber.activeForeground': text,
      'editor.lineHighlightBackground': sunken,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': brand,
      'editor.selectionBackground': `${brand}40`,
      'editor.inactiveSelectionBackground': `${brand}26`,
      'editor.selectionHighlightBackground': `${brand}1f`,
      'editor.wordHighlightBackground': `${brand}1f`,
      'editor.findMatchBackground': `${brand}66`,
      'editor.findMatchHighlightBackground': `${brand}33`,
      'editorIndentGuide.background1': edge,
      'editorIndentGuide.activeBackground1': strong,
      'editorBracketMatch.background': `${brand}26`,
      'editorBracketMatch.border': `${brand}80`,
      'editorWidget.background': bg,
      'editorWidget.border': edge,
      'editorStickyScroll.background': bg,
      'editorStickyScrollHover.background': sunken,
      'editorStickyScroll.shadow': `${edge}`,
      'input.background': sunken,
      'input.border': edge,
      'input.foreground': text,
      'focusBorder': brand,
      'scrollbarSlider.background': `${strong}66`,
      'scrollbarSlider.hoverBackground': `${strong}99`,
      'scrollbarSlider.activeBackground': `${strong}cc`,
      'scrollbar.shadow': '#00000000',
      'widget.shadow': dark ? '#00000080' : '#0f172a1f',
      'editorOverviewRuler.border': '#00000000',
      'menu.background': bg,
      'menu.foreground': text,
      'menu.selectionBackground': sunken,
      'menu.selectionForeground': text,
      'menu.border': edge,
    },
  })
  monaco.editor.setTheme(CONSOLE_THEME)
}
