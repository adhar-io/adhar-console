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

export const THEME_LIGHT = 'adhar-console-light'
export const THEME_DARK = 'adhar-console-dark'

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
  monaco.editor.defineTheme(THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'type', foreground: '1d4ed8', fontStyle: 'bold' },
      { token: 'string', foreground: '047857' },
      { token: 'number', foreground: 'b45309' },
      { token: 'keyword', foreground: '7c3aed', fontStyle: 'bold' },
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'tag', foreground: 'be185d' },
      { token: 'operators', foreground: '374151' },
      { token: 'delimiter', foreground: '374151' },
    ],
    colors: {
      'editor.background': '#f8fafc',
      'editorLineNumber.foreground': '#94a3b8',
      'editorLineNumber.activeForeground': '#334155',
      'editor.lineHighlightBackground': '#f1f5f9',
      'editorIndentGuide.background1': '#e2e8f0',
    },
  })
  monaco.editor.defineTheme(THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'type', foreground: '93c5fd', fontStyle: 'bold' },
      { token: 'string', foreground: '6ee7b7' },
      { token: 'number', foreground: 'fcd34d' },
      { token: 'keyword', foreground: 'c4b5fd', fontStyle: 'bold' },
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'tag', foreground: 'f9a8d4' },
      { token: 'operators', foreground: 'cbd5e1' },
      { token: 'delimiter', foreground: 'cbd5e1' },
    ],
    colors: {
      'editor.background': '#0b1220',
      'editorLineNumber.foreground': '#475569',
      'editorLineNumber.activeForeground': '#cbd5e1',
      'editor.lineHighlightBackground': '#111a2e',
      'editorIndentGuide.background1': '#1e293b',
    },
  })
}

/** The theme matching the console's light/dark class on `<html>`. */
export function consoleMonacoTheme(): string {
  if (typeof document === 'undefined') return THEME_LIGHT
  return document.documentElement.classList.contains('dark') ? THEME_DARK : THEME_LIGHT
}
