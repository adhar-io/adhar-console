import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { consoleAliases, findWorkspaceRoot, resolveAdharUiPath } from './paths.ts'

interface RemoteOpts {
  /** Module name — matches the `name` in packages/build-config/src/registry.ts. */
  name: string
  /** Vite dev server port. */
  port: number
  /**
   * Module folder on disk. Callers pass `import.meta.dirname` so we can resolve
   * sibling adhar-ui without hard-coding the monorepo layout into every module.
   */
  moduleDir: string
  /** MF `exposes` map: public-name → src path relative to the module's cwd. */
  exposes: Record<string, string>
}

/**
 * Single source of truth for a federated remote's Vite config.
 *
 * The critical correctness note: `base` must match where the built assets will
 * be served from. In dev, each remote runs its own Vite server at
 * `http://localhost:<port>/mf/...`, so `base: '/mf/'` works. In production,
 * every remote's `dist/` is copied under `apps/console/.output/public/mf/<name>/`
 * and served at `/mf/<name>/...`, so the built `base` must be `/mf/<name>/` —
 * otherwise `remoteEntry.js` references its chunks at `/mf/assets/*` which
 * 404s on the host's origin.
 */
export function defineRemoteConfig(opts: RemoteOpts) {
  return defineConfig(({ command }) => {
    const isBuild = command === 'build'
    const adharUiPath = resolveAdharUiPath(opts.moduleDir)
    const workspaceRoot = findWorkspaceRoot(opts.moduleDir)

    const alias = {
      ...consoleAliases(workspaceRoot),
      '@adhar-ui/react': resolve(adharUiPath, 'packages/react/src/index.ts'),
      '@adhar-ui/tokens': resolve(adharUiPath, 'packages/tokens/src/index.ts'),
      '@adhar-ui/tailwind-preset': resolve(adharUiPath, 'packages/tailwind-preset/src/index.ts'),
      '@adhar-ui/icons': resolve(adharUiPath, 'packages/icons/src/index.ts'),
      '@adhar-ui/utils': resolve(adharUiPath, 'packages/utils/src/index.ts'),
      '@adhar-ui/a11y': resolve(adharUiPath, 'packages/a11y/src/index.ts'),
    }

    /*
     * External `builder` remote — same definition as in host.ts so any
     * module that imports `builder/BuilderApp` (e.g. Design's Visual Builder,
     * Develop's Code Builder) can resolve it at build time. Without this
     * the module's @module-federation/vite plugin doesn't know `builder`
     * is a thing and the import-analysis stage fails with
     *   "Failed to resolve import 'builder/BuilderApp'".
     *
     * URL is read from VITE_ADHAR_BUILDER_URL with a localhost dev default.
     */
    const builderHost = (
      process.env.VITE_ADHAR_BUILDER_URL ?? 'http://localhost:5174'
    ).replace(/\/$/, '')

    const config: UserConfig = {
      // Dev: served at /mf/ on the remote's own port.
      // Build: served at /mf/<name>/ on the host's origin.
      base: isBuild ? `/mf/${opts.name}/` : '/mf/',
      resolve: { alias },
      server: {
        port: opts.port,
        cors: true,
        fs: { allow: ['..', adharUiPath] },
      },
      preview: { port: opts.port, cors: true },
      plugins: [
        tailwind(),
        // `@module-federation/vite` returns an array of plugins; the spread
        // is required (the host config does the same — see host.ts). Without
        // the spread, the inner plugins get nested into a single entry which
        // Vite silently treats as a no-op, and `import('builder/...')` fails
        // import-analysis because the federation resolver never registers.
        ...federation({
          name: opts.name,
          filename: 'remoteEntry.js',
          target: 'web',
          exposes: opts.exposes,
          remotes: {
            builder: {
              type: 'module',
              name: 'builder',
              entry: `${builderHost}/mf/remoteEntry.js`,
            },
          },
          dts: false,
          // `eager: true` matches the host's config — see the comment in host.ts.
          shared: {
            react: { singleton: true, eager: true, requiredVersion: '^19.2.0' },
            'react-dom': { singleton: true, eager: true, requiredVersion: '^19.2.0' },
            '@tanstack/react-query': { singleton: true, eager: true },
          },
        }),
        react(),
      ],
      build: {
        target: 'esnext',
        minify: isBuild,
        cssCodeSplit: false,
        sourcemap: true,
        // Vite defaults to clearing dist/ — good for repeatable builds.
        emptyOutDir: true,
        // `@module-federation/vite` falls back to `index.html` as the rollup
        // entry when no `build.rollupOptions.input` is set (see its add-entry
        // plugin: `if (!inputOptions) htmlFilePath = root/index.html`). Remotes
        // have no index.html, so the production build errors with
        // "Could not resolve entry module index.html". Expose the federated
        // modules as named JS inputs — the plugin then builds those + emits
        // remoteEntry.js, with no HTML app entry. Build-only; dev is untouched.
        ...(isBuild
          ? {
              rollupOptions: {
                input: Object.fromEntries(
                  Object.entries(opts.exposes).map(([name, p]) => [
                    name.replace(/^\.\//, '').replace(/[^\w-]/g, '_'),
                    resolve(opts.moduleDir, p),
                  ]),
                ),
              },
            }
          : {}),
      },
    }
    return config
  })
}
