import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { consoleAliases, findWorkspaceRoot, resolveAdharUiPath } from '@adhar/build-config/paths'

/**
 * Launch site — a plain Vite SPA on the same foundation as the console.
 *
 * Deliberately NOT a Module Federation host: this is a public marketing
 * surface (coming-soon + maintenance), so it must stay small, static and
 * independent of the platform remotes. It shares the console's design
 * tokens (`styles.css` imports the console stylesheet), the shell-ui
 * primitives and the adhar-ui aliases, so a change to the brand lands here
 * on the next build without copy-paste.
 *
 * Deep shell-ui aliases: importing the shell-ui barrel would drag the AI
 * assistant, the k8s clients and every nav store into a page that needs a
 * logo, a button and a toast. Each alias points at one source file.
 */
const appDir = import.meta.dirname!
const workspaceRoot = findWorkspaceRoot(appDir)
const adharUiPath = resolveAdharUiPath(appDir)
const shell = (file: string) => resolve(workspaceRoot, 'packages/shell-ui/src', file)

export default defineConfig({
  resolve: {
    alias: {
      '@adhar/shell-ui/brand': shell('brand.tsx'),
      '@adhar/shell-ui/brand-icons': shell('brand-icons.tsx'),
      '@adhar/shell-ui/button': shell('button.tsx'),
      '@adhar/shell-ui/primitives': shell('primitives.tsx'),
      '@adhar/shell-ui/toast': shell('toast.tsx'),
      '@adhar/shell-ui/theme': shell('theme.ts'),
      '@adhar/shell-ui/mode-toggle': shell('mode-toggle.tsx'),
      ...consoleAliases(workspaceRoot),
      '~': resolve(appDir, 'app'),
      '@adhar-ui/react': resolve(adharUiPath, 'packages/react/src/index.ts'),
      '@adhar-ui/tokens': resolve(adharUiPath, 'packages/tokens/src/index.ts'),
      '@adhar-ui/tailwind-preset': resolve(adharUiPath, 'packages/tailwind-preset/src/index.ts'),
      '@adhar-ui/icons': resolve(adharUiPath, 'packages/icons/src/index.ts'),
      '@adhar-ui/utils': resolve(adharUiPath, 'packages/utils/src/index.ts'),
      '@adhar-ui/a11y': resolve(adharUiPath, 'packages/a11y/src/index.ts'),
    },
    mainFields: ['browser', 'module', 'jsnext:main', 'main'],
    conditions: ['browser', 'module', 'import', 'default'],
  },
  server: {
    port: 5200,
    fs: { allow: ['..', adharUiPath] },
    // The interest-registration API lives in server.ts (`deno task dev:server`,
    // :5199). Override the target with LAUNCH_API_URL.
    proxy: {
      '/api': {
        target: process.env.LAUNCH_API_URL ?? 'http://127.0.0.1:5199',
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        // three + fiber are ~600 KB of code the page below the fold never
        // needs before first paint; keep them in a chunk the hero lazy-loads.
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
        },
      },
    },
  },
  plugins: [tailwind(), react()],
})
