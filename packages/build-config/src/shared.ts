/**
 * The federation share scope — one definition for the host and every remote,
 * so a library can't be a singleton on one side and a private copy on the
 * other.
 *
 * - React / ReactDOM: two copies on a page break hooks outright.
 * - The router must be THE router: a remote with its own copy gets an empty
 *   router context, so useNavigate / useSearch crash with "Cannot read
 *   properties of null (reading 'stores')".
 * - React Query: one QueryClient context, one cache.
 *
 * No `eager` flag: `@module-federation/vite` (1.14) has no eager mode — it
 * reads only `singleton`, `requiredVersion`, `strictVersion` and `import`, so
 * the `eager: true` that used to sit here was silently ignored (and failed
 * type-checking). Shared modules load through the async `loadShare` wrapper
 * whatever is set; see host.ts for the top-level-await deadlock that implies.
 */
export const FEDERATION_SHARED = {
  react: { singleton: true, requiredVersion: '^19.2.0' },
  'react-dom': { singleton: true, requiredVersion: '^19.2.0' },
  '@tanstack/react-router': { singleton: true },
  '@tanstack/react-query': { singleton: true },
}

/**
 * `loaded-first`, on the host AND every remote (the strategy is recorded on
 * each share-scope entry, so both sides must agree).
 *
 * Why not the default `version-first`: when two containers provide the same
 * version of a package (every build bundles React 19.2.5), the MF runtime's
 * `initializeSharing → register()` (runtime-core 2.3 `shared/index.js`)
 * replaces the existing entry unless it is already `loaded`, tie-breaking on
 * container NAME: `hostName > versions[version].from`. The host is
 * `__mfe_internal__adhar_console_host`; every remote (`…platform`,
 * `…workspace`, …) sorts after it. Under version-first the host also fetches
 * and inits all eight remoteEntries on its first `loadShare`, while its
 * concurrent `loadShare` calls for react / react-dom / router / query each
 * grab whatever entry is registered at that instant. Remotes registering
 * mid-way overwrite the host's still-`loading` entries, so on ~1 in 3 loads the
 * host renders with its own React while a remote's component (or a shared
 * router/query copy) resolves `react` to e.g. WORKSPACE's bundled copy, whose
 * dispatcher is null → "Cannot read properties of null (reading 'useEffect')".
 * It also pulled remote-provided copies of the router (and their buggy
 * with-selector chunk, see mf-fixes.ts) onto signed-out pages.
 *
 * Under `loaded-first`, `register()` never replaces an entry whose strategy is
 * `loaded-first`, so the first provider — the host, which registers its share
 * scope in hostInit before any remote entry is fetched — stays THE provider of
 * every singleton, and remoteEntries are only fetched when a remote module is
 * actually imported. (It was tried once before, on 2026-10-21, and reverted
 * because federated pages hung in a test harness — but they hung the same way
 * with version-first: that was the since-fixed hoistTransitiveImports
 * top-level-await deadlock in host.ts, not the strategy.)
 */
export const FEDERATION_SHARE_STRATEGY = 'loaded-first' as const
