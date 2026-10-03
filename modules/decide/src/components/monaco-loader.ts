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
  if (globalThis.__adharMonaco) return globalThis.__adharMonaco

  globalThis.__adharMonaco = Promise.all([
    import('monaco-editor/esm/vs/editor/editor.api'),
    // Registers the Monarch grammars. Imported for its side effect; the module
    // itself exports nothing we call.
    import('monaco-editor/esm/vs/basic-languages/monaco.contribution'),
  ])
    .then(([api]) => api as unknown as MonacoApi)
    .catch((err) => {
      // Do not cache the failure — let the next mount try again.
      globalThis.__adharMonaco = undefined
      throw err instanceof Error ? err : new Error(String(err))
    })

  return globalThis.__adharMonaco
}
