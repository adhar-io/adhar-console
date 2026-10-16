/**
 * Monaco, bundled and worker-free — no CDN at runtime.
 *
 * The standalone builder used `@monaco-editor/react`, whose default loader
 * fetches Monaco from jsDelivr. That never works on an air-gapped install,
 * which is the normal shape of the platform. This mirrors the console's own
 * loader (`modules/develop/src/components/monaco-loader.ts`):
 *
 *   • `editor.api` + `basic-languages` — Monarch grammars that tokenise on the
 *     main thread, no language-service workers (those need `crypto.hash` in
 *     Vite's worker plugin, which the pinned Deno in the image lacks).
 *   • A dynamic `import()`, so Monaco is its own chunk fetched the first time
 *     an editor mounts — never part of the builder's initial payload.
 *   • Cached on `globalThis` under the same key the Develop module uses, so a
 *     session that already opened a file viewer reuses that runtime.
 */

import type * as Monaco from 'monaco-editor'
// A federated remote's CSS file is never loaded by the host — inline it.
import monacoCss from 'monaco-editor/min/vs/editor/editor.main.css?inline'
import { ensureStyle } from './inject-style.ts'

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
  ensureStyle('adhar-monaco-css', monacoCss)
  if (globalThis.__adharMonaco) return globalThis.__adharMonaco

  globalThis.__adharMonaco = Promise.all([
    import('monaco-editor/esm/vs/editor/editor.api'),
    import('monaco-editor/esm/vs/basic-languages/monaco.contribution'),
  ])
    .then(([api]) => api as unknown as MonacoApi)
    .catch((err) => {
      globalThis.__adharMonaco = undefined
      throw err instanceof Error ? err : new Error(String(err))
    })

  return globalThis.__adharMonaco
}
