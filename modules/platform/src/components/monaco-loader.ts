/**
 * Monaco, bundled — no network at runtime.
 *
 * This used to inject a `<script>` from jsDelivr and drive Monaco's AMD
 * loader, with a `data:` worker shim to get the language services past the
 * cross-origin Worker rule. That is a lot of machinery for something that
 * cannot work at all on an air-gapped install, which is the normal shape of
 * the platform this console ships with: the editor simply never appeared, and
 * the only clue was a blocked request.
 *
 * Monaco is an ordinary npm package with an ESM entry point, so it is a
 * dependency now and Vite bundles it. The dynamic `import()` keeps it out of
 * the initial payload — it is ~3 MB, and most sessions never open a file — so
 * it arrives as its own chunk, from this origin, the first time an editor
 * mounts. Cached on `globalThis` so later editors reuse the one runtime.
 *
 * Workers are bundled the same way. Monaco builds its worker URL from the
 * origin it was loaded from, and a browser refuses to construct a Worker
 * cross-origin; served from our own origin that problem does not arise, and
 * `?worker` lets Vite emit the worker as a local asset.
 */

import type * as Monaco from 'monaco-editor'

export type MonacoApi = typeof Monaco
export type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor

declare global {
  // eslint-disable-next-line no-var
  var __adharMonaco: Promise<MonacoApi> | undefined
}

/**
 * Give Monaco its worker.
 *
 * Only the base editor worker is wired up. The language services (TypeScript,
 * JSON, CSS, HTML) are separate workers that add IntelliSense and validation;
 * this console renders repository files read-only, where what matters is
 * tokenising, folding and search — all of which run without them. Pulling in
 * four more workers would cost megabytes to power a feature a viewer does not
 * expose.
 */
function installWorkerEnvironment(): void {
  const g = globalThis as typeof globalThis & {
    MonacoEnvironment?: { getWorker?(workerId: string, label: string): Worker }
  }
  if (g.MonacoEnvironment?.getWorker) return
  g.MonacoEnvironment = {
    getWorker: () =>
      new Worker(
        new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
        { type: 'module' },
      ),
  }
}

export function loadMonaco(): Promise<MonacoApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Monaco requires a browser'))
  }
  if (globalThis.__adharMonaco) return globalThis.__adharMonaco

  // Must be set before the module initialises, or Monaco captures the default
  // worker URL and every language service fails on construction.
  installWorkerEnvironment()

  globalThis.__adharMonaco = import('monaco-editor')
    .then((m) => m as unknown as MonacoApi)
    .catch((err) => {
      // Let the next mount try again rather than caching the failure forever.
      globalThis.__adharMonaco = undefined
      throw err instanceof Error ? err : new Error(String(err))
    })

  return globalThis.__adharMonaco
}
