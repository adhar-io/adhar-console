import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
// Nitro turns the TanStack Start SSR handler into a runnable server that emits
// `.output/server/index.mjs` (+ `.output/public/`). Without it the build only
// produces SSR assets with no HTTP host. Build-only (see the isBuild branch).
import { nitro } from 'nitro/vite'
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
        // Proxy the browser's K8s API calls through kubectl proxy so we can
        // talk to the live cluster in dev without CORS/auth plumbing.
        // Run `kubectl proxy --port=8001` in a separate terminal; the user's
        // current kubeconfig context is used.
        proxy: {
          '/kube-api': {
            target: process.env.ADHAR_K8S_PROXY ?? 'http://127.0.0.1:8001',
            changeOrigin: false,
            ws: true,
            rewrite: (p: string) => p.replace(/^\/kube-api/, ''),
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
        // TanStack Start (SSR + BFF server functions) + Nitro (server host) —
        // production build only. See the block comment at the top of this file.
        // `.flat()` because each plugin factory may return an array.
        ...(isBuild
          ? [
              tanstackStart({ srcDirectory: 'app', server: { entry: 'ssr' } }),
              nitro(),
            ].flat()
          : []),
        react(),
      ],
    }
    return config
  })
}
