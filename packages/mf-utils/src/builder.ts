import { init, loadRemote } from '@module-federation/runtime'

/**
 * Direct runtime API loader for the external Adhar Builder remote.
 *
 * The repo originally relied on `import('builder/BuilderApp')` and the
 * `@module-federation/vite` plugin's static-import-rewrite to fetch the
 * remote — but inside a federated *remote* module (Develop, Design) the
 * plugin doesn't always register the resolver in time, so Vite's
 * import-analysis fails with "Failed to resolve import 'builder/...'".
 *
 * This helper bypasses the static rewrite entirely:
 *   1. Initialize the MF runtime once (idempotent), registering the
 *      builder remote with its entry URL.
 *   2. Use the runtime's `loadRemote(...)` to fetch the federated module
 *      at call time. Same effect as the rewritten dynamic import, but
 *      independent of plugin ordering.
 *
 * Each consumer module only pays the registration cost once (a Set guards
 * the init), and the actual remote chunk is only fetched on first use.
 */

const FALLBACK_HOST = 'http://localhost:5174'
const DEFAULT_ENTRY_PATH = '/mf/remoteEntry.js'

function readEnv(key: string): string | undefined {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env
    if (env?.[key]) return env[key]
  } catch {
    /* import.meta.env not available */
  }
  if (typeof globalThis !== 'undefined') {
    const w = globalThis as Record<string, unknown>
    const v = w[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function readBuilderHost(): string {
  return readEnv('VITE_ADHAR_BUILDER_URL') ?? readEnv('ADHAR_BUILDER_URL') ?? FALLBACK_HOST
}

/**
 * Resolves the full URL that the MF runtime will fetch.
 *
 *   - `VITE_ADHAR_BUILDER_ENTRY` overrides everything (full URL, e.g.
 *     `http://localhost:5174/remoteEntry.js`). Use this when your builder
 *     app serves the entry at a non-standard path.
 *   - Otherwise we use `${VITE_ADHAR_BUILDER_URL}${entry-path}` where
 *     entry-path defaults to `/mf/remoteEntry.js` (matching this repo's
 *     `defineRemoteConfig`).
 */
function readBuilderEntry(): string {
  const explicit =
    readEnv('VITE_ADHAR_BUILDER_ENTRY') ?? readEnv('ADHAR_BUILDER_ENTRY')
  if (explicit) return explicit
  const host = readBuilderHost().replace(/\/$/, '')
  return `${host}${DEFAULT_ENTRY_PATH}`
}

let initialized = false

/*
 * Picks a stable consumer name per tab. The MF runtime requires a name; if
 * two consumer modules pass *the same* name, the runtime treats subsequent
 * `init()` calls as overrides (which is fine because we register the same
 * remote). We derive the name from the URL pathname so dev tools can tell
 * which page is loading the builder.
 */
function consumerName(): string {
  if (typeof globalThis === 'undefined') return 'adhar_console_consumer'
  const w = globalThis as { location?: Location }
  const path = w.location?.pathname?.replace(/[^a-z0-9]+/gi, '_') ?? ''
  return `adhar_console_consumer${path || ''}`
}

function ensureInit(): void {
  if (initialized) return
  init({
    name: consumerName(),
    remotes: [
      {
        name: 'builder',
        alias: 'builder',
        entry: readBuilderEntry(),
      },
    ],
  })
  initialized = true
}

export function getBuilderHost(): string {
  return readBuilderHost()
}

export function getBuilderEntry(): string {
  return readBuilderEntry()
}

/**
 * Load the federated `BuilderApp` component. Returns a `{ default }` shape
 * so it plugs straight into `React.lazy()` and the existing
 * `<RemoteModule loader={...}>` helper.
 */
export async function loadBuilderApp<P>(): Promise<{
  default: React.ComponentType<P>
}> {
  ensureInit()
  let mod:
    | { default: React.ComponentType<P> }
    | React.ComponentType<P>
    | null
    | undefined
  try {
    mod = (await loadRemote('builder/BuilderApp')) as typeof mod
  } catch (cause) {
    // Re-throw with a diagnostic body so the React ErrorBoundary in
    // `<RemoteModule>` shows something actionable instead of the bare
    // RUNTIME-008 from MF.
    const entry = readBuilderEntry()
    const msg =
      `Adhar Builder federated module could not be loaded.\n\n` +
      `Tried: ${entry}\n\n` +
      `Check that:\n` +
      `  1. The Adhar Builder dev server is running at ${readBuilderHost()}.\n` +
      `  2. It serves a Module Federation entry at the URL above. If it serves\n` +
      `     the entry at a different path (e.g. /remoteEntry.js), set\n` +
      `     VITE_ADHAR_BUILDER_ENTRY=<full URL> instead of just\n` +
      `     VITE_ADHAR_BUILDER_URL.\n` +
      `  3. The dev server has CORS enabled (server.cors: true in its vite.config),\n` +
      `     or set Access-Control-Allow-Origin: * on the entry response.\n` +
      `  4. The builder exposes ./BuilderApp via @module-federation/vite as\n` +
      `     name: 'builder'.`
    const err = new Error(msg)
    ;(err as { cause?: unknown }).cause = cause
    throw err
  }
  if (!mod) {
    throw new Error(
      'Adhar Builder loaded but exported no module — confirm the app at ' +
        `${readBuilderHost()} exposes ./BuilderApp via Module Federation.`,
    )
  }
  if (typeof mod === 'function' || (typeof mod === 'object' && 'render' in mod)) {
    return { default: mod as React.ComponentType<P> }
  }
  return mod as { default: React.ComponentType<P> }
}
