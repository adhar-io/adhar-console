import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { REMOTES } from './registry.ts'
import { consoleAliases, findWorkspaceRoot, resolveAdharUiPath } from './paths.ts'

interface HostOpts {
  /** The host app's own folder — callers pass `import.meta.dirname`. */
  appDir: string
}

/**
 * Host Vite config.
 *
 * ## Dev vs production
 *
 * - **Dev (`pnpm dev`)**: host runs as a pure Vite **SPA**. Entry is
 *   `apps/console/index.html` → `app/main.tsx`. Module Federation is
 *   active; remotes load from their own Vite dev servers. **TanStack
 *   Start's SSR plugin is disabled** in dev because `@module-federation/vite`
 *   v1.14 and TanStack Start v1.167's Vite-7 SSR module runner have a known
 *   incompatibility (MF emits `loadShare` wrappers that mix ESM `import`
 *   with CJS `require()`, which the ESM-only SSR runner can't evaluate).
 *   Consequence: **`createServerFn` BFF handlers are NOT callable in dev.**
 *   Test them via `pnpm build && pnpm preview`.
 *
 * - **Production (`pnpm build`)**: TanStack Start is enabled. SSR + BFF
 *   server functions work. Every remote's `dist/` is staged under
 *   `apps/console/.output/public/mf/<name>/` so one origin serves it all.
 *
 * ## MF URL mapping
 *
 * `remotes[name].entry` is the URL the browser fetches:
 * - Dev:   `http://localhost:<port>/mf/remoteEntry.js` (remote's own server)
 * - Build: `/mf/<name>/remoteEntry.js` (host origin, served from public/)
 */
export function defineHostConfig(opts: HostOpts) {
  return defineConfig(({ command }) => {
    const isBuild = command === 'build'
    const adharUiPath = resolveAdharUiPath(opts.appDir)
    const workspaceRoot = findWorkspaceRoot(opts.appDir)

    const remoteUrl = (name: string, port: number) =>
      isBuild
        ? `/mf/${name}/remoteEntry.js`
        : `http://localhost:${port}/mf/remoteEntry.js`

    const remotes: Record<string, { type: string; name: string; entry: string }> =
      Object.fromEntries(
        REMOTES.map((r) => [
          r.name,
          { type: 'module', name: r.name, entry: remoteUrl(r.name, r.port) },
        ]),
      )

    /*
     * External `builder` remote — the Adhar Builder app powers every canvas
     * surface (Code, Visual/Design, Workflow, Theme) from a single
     * federated component. The console's pages just mount that component
     * with different `mode` props.
     *
     * The remote URL is configured at build/dev time via
     * `VITE_ADHAR_BUILDER_URL`. Default `http://localhost:5174` matches the
     * convention for running the builder locally (`pnpm dev` on its repo
     * binds to that port). Override with:
     *
     *     VITE_ADHAR_BUILDER_URL=https://builder.acme.io pnpm dev
     *
     * The external app must:
     *   1. Expose `./BuilderApp` via @module-federation/vite as `name: 'builder'`.
     *      The exposed component accepts `{ mode, docId?, docName?, onSave? }`.
     *   2. Use the same shared deps with matching versions:
     *      react@^19, react-dom@^19, @tanstack/react-router, @tanstack/react-query.
     *   3. Serve `/mf/remoteEntry.js` with permissive CORS for the console origin.
     */
    const builderHost = (
      process.env.VITE_ADHAR_BUILDER_URL ?? 'http://localhost:5174'
    ).replace(/\/$/, '')
    remotes.builder = {
      type: 'module',
      name: 'builder',
      entry: `${builderHost}/mf/remoteEntry.js`,
    }

    const alias = {
      ...consoleAliases(workspaceRoot),
      '~': resolve(opts.appDir, 'app'),
      '@adhar-ui/react': resolve(adharUiPath, 'packages/react/src/index.ts'),
      '@adhar-ui/tokens': resolve(adharUiPath, 'packages/tokens/src/index.ts'),
      '@adhar-ui/tailwind-preset': resolve(adharUiPath, 'packages/tailwind-preset/src/index.ts'),
      '@adhar-ui/icons': resolve(adharUiPath, 'packages/icons/src/index.ts'),
      '@adhar-ui/utils': resolve(adharUiPath, 'packages/utils/src/index.ts'),
      '@adhar-ui/a11y': resolve(adharUiPath, 'packages/a11y/src/index.ts'),
    }

    const config: UserConfig = {
      resolve: {
        alias,
        // `browser` FIRST — this is a browser bundle. Putting `node` here
        // makes TanStack Router's export-condition-switched `isServer` file
        // resolve to the server variant, so `isServer === true` in the
        // browser, the router never creates `createBrowserHistory()`, and
        // `router.stores` stays undefined → `MatchesInner` crashes reading
        // `firstId`.
        mainFields: ['browser', 'module', 'jsnext:main', 'main'],
        conditions: ['browser', 'module', 'import', 'default'],
      },
      server: {
        port: 5100,
        fs: { allow: ['..', adharUiPath] },
        // Proxy every BFF/API call to the console's Deno server, which `pnpm dev`
        // runs alongside Vite (the `bff` process, default :5099). The server does
        // the real work against the locally-running adhar cluster — OIDC login
        // (/api/auth/*), the per-user Kubernetes gateway (/api/k8s/*, incl. exec
        // over WebSocket), backing-tool proxies (/api/svc/*), and the Postgres
        // document store (/api/store/*). Override the target with ADHAR_BFF_URL.
        proxy: {
          '/api': {
            target: process.env.ADHAR_BFF_URL ?? 'http://127.0.0.1:5099',
            changeOrigin: false,
            ws: true,
          },
        },
      },
      plugins: [
        tailwind(),
        ...federation({
          name: 'adhar_console_host',
          target: 'web',
          remotes,
          dts: false,
          shared: {
            react: { singleton: true, eager: true, requiredVersion: '^19.2.0' },
            'react-dom': { singleton: true, eager: true, requiredVersion: '^19.2.0' },
            '@tanstack/react-router': { singleton: true, eager: true },
            '@tanstack/react-query': { singleton: true, eager: true },
          },
        }),
        // Pure SPA build (index.html → app/main.tsx). The console ships as a
        // client-rendered SPA served by a small standalone Deno server
        // (apps/console/server.ts) that also hosts the BFF API routes. We do
        // NOT use TanStack Start's SSR/Nitro server: the Deno + MF + Vite-7 +
        // Nitro toolchain doesn't converge, and the app is SPA-first anyway
        // (the root gate renders a boot splash until auth resolves client-side,
        // so SSR added no first-paint value). The API handlers are wired
        // framework-agnostically in server.ts.
        react(),
      ],
    }
    return config
  })
}
