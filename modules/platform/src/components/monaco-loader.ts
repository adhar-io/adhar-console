/**
 * Monaco, bundled and worker-free — no network at runtime.
 *
 * This used to inject a `<script>` from jsDelivr and drive Monaco's AMD
 * loader, with a `data:` worker shim to get its language services past the
 * cross-origin Worker rule. None of that can work on an air-gapped install,
 * which is the normal shape of the platform this console ships with: the
 * editor simply never appeared, and the only clue was a blocked request.
 *
 * Two deliberate choices in what is imported.
 *
 * `editor.api` rather than `editor.main`: the `main` entry pulls in the
 * TypeScript, JSON, CSS and HTML *language services*, which run in Web
 * Workers. Bundling those means `new Worker(new URL(…))`, which Vite's
 * worker plugin handles by hashing the output with `crypto.hash` — a Node
 * 20.12+ API that the pinned Deno 2.1.4 in the container image does not
 * provide. The build failed there while passing locally on a newer Deno.
 *
 * `basic-languages` instead: 78 Monarch grammars — Go, Rust, Python, YAML,
 * SQL, Dockerfile, shell, TypeScript and the rest — that tokenise on the main
 * thread and need no worker at all. For a read-only file viewer that is the
 * whole requirement; the services only add IntelliSense and validation, which
 * a viewer does not expose. It is also several megabytes smaller.
 *
 * The dynamic `import()` keeps it out of the initial payload — most sessions
 * never open a file — so it arrives as its own chunk, from this origin, the
 * first time an editor mounts. Cached on `globalThis` so later editors reuse
 * the one runtime.
 */

import type * as Monaco from 'monaco-editor'
// Monaco's own stylesheet, as a string. This module is a federated remote and
// the console host never loads a remote's CSS file, so the editor mounted with
// all of its DOM and none of its layout — every line stacked at the top and the
// raw-object viewer looked empty. Injected once, the first time it loads.
import monacoCss from 'monaco-editor/min/vs/editor/editor.main.css?inline'

export type MonacoApi = typeof Monaco
export type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor

declare global {
  // eslint-disable-next-line no-var
  var __adharMonaco: Promise<MonacoApi> | undefined
}

export function loadMonaco(): Promise<MonacoApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Monaco requires a browser'))
  }
  // Styles and this module's grammars/themes are applied on EVERY call: the
  // runtime is shared on globalThis, so Develop or Decide may have loaded it
  // first, without them. All three steps are idempotent.
  ensureMonacoCss()
  if (globalThis.__adharMonaco) {
    return globalThis.__adharMonaco.then((m) => {
      registerJson(m)
      defineAdharThemes(m)
      return m
    })
  }

  globalThis.__adharMonaco = Promise.all([
    import('monaco-editor/esm/vs/editor/editor.api'),
    // Registers the Monarch grammars. Imported for its side effect; the module
    // itself exports nothing we call.
    import('monaco-editor/esm/vs/basic-languages/monaco.contribution'),
    // YAML's grammar, imported DIRECTLY rather than left to the contribution's
    // lazy loader. The contribution registers each language with
    // `loader: () => import('./yaml/yaml.js')`, a chunk this federated remote
    // resolves relative to its own base URL — when that misses, Monaco still
    // mounts and edits, and highlights nothing: the editor reads as a plain
    // textarea with line numbers. YAML is this console's main surface, so its
    // tokenizer travels with the editor.
    import('monaco-editor/esm/vs/basic-languages/yaml/yaml.js'),
  ])
    .then(([api, , yaml]) => {
      const monaco = api as unknown as MonacoApi
      const grammar = yaml as {
        conf: Monaco.languages.LanguageConfiguration
        language: Monaco.languages.IMonarchLanguage
      }
      if (!monaco.languages.getLanguages().some((l) => l.id === 'yaml')) {
        monaco.languages.register({ id: 'yaml', extensions: ['.yaml', '.yml'], aliases: ['YAML', 'yaml'] })
      }
      monaco.languages.setMonarchTokensProvider('yaml', grammar.language)
      monaco.languages.setLanguageConfiguration('yaml', grammar.conf)
      registerJson(monaco)
      defineAdharThemes(monaco)
      return monaco
    })
    .catch((err) => {
      // Do not cache the failure — let the next mount try again.
      globalThis.__adharMonaco = undefined
      throw err instanceof Error ? err : new Error(String(err))
    })

  return globalThis.__adharMonaco
}

function ensureMonacoCss(): void {
  if (typeof document === 'undefined' || document.getElementById('adhar-monaco-css')) return
  const el = document.createElement('style')
  el.id = 'adhar-monaco-css'
  el.textContent = monacoCss
  document.head.appendChild(el)
}

/**
 * JSON highlighting without the JSON language service (which needs a worker —
 * see the header). Raw Kubernetes objects are JSON, and without a grammar they
 * read as one colour. Keys use the `type` token so they match YAML keys.
 */
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
  })
}

/**
 * The console's editor themes. `vs` / `vs-dark` give YAML keys and strings
 * nearly the same tone, which reads as "no highlighting". These extend them
 * with a rule for every token the YAML grammar emits — keys (`type`), strings,
 * numbers, booleans and null (`keyword`), comments, tags/anchors/aliases, and
 * the structural punctuation — on the console's own surfaces.
 */
export const ADHAR_THEME_LIGHT = 'adhar-light'
export const ADHAR_THEME_DARK = 'adhar-dark'

function defineAdharThemes(monaco: MonacoApi): void {
  monaco.editor.defineTheme(ADHAR_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'type', foreground: '1d4ed8', fontStyle: 'bold' },
      { token: 'string', foreground: '047857' },
      { token: 'string.escape', foreground: 'b45309' },
      { token: 'number', foreground: 'b45309' },
      { token: 'keyword', foreground: '7c3aed', fontStyle: 'bold' },
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'tag', foreground: 'be185d' },
      { token: 'namespace', foreground: 'be185d' },
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
  monaco.editor.defineTheme(ADHAR_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'type', foreground: '93c5fd', fontStyle: 'bold' },
      { token: 'string', foreground: '6ee7b7' },
      { token: 'string.escape', foreground: 'fcd34d' },
      { token: 'number', foreground: 'fcd34d' },
      { token: 'keyword', foreground: 'c4b5fd', fontStyle: 'bold' },
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'tag', foreground: 'f9a8d4' },
      { token: 'namespace', foreground: 'f9a8d4' },
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

/** The console theme matching the current light/dark setting. */
export function adharMonacoTheme(): string {
  if (typeof document === 'undefined') return ADHAR_THEME_LIGHT
  return document.documentElement.classList.contains('dark') ? ADHAR_THEME_DARK : ADHAR_THEME_LIGHT
}
