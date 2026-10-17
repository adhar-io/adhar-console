import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { consoleAliases, resolveAdharUiPath } from '../packages/build-config/src/paths.ts'
const ROOT = resolve(import.meta.dirname, '..')
const ui = resolveAdharUiPath(resolve(ROOT, 'apps/console'))
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwind()],
  resolve: { alias: { ...consoleAliases(ROOT), '~': resolve(ROOT, 'apps/console/app'),
    '@adhar-ui/react': resolve(ui, 'packages/react/src/index.ts'),
    '@adhar-ui/tokens': resolve(ui, 'packages/tokens/src/index.ts'),
    '@adhar-ui/utils': resolve(ui, 'packages/utils/src/index.ts'),
    '@adhar-ui/icons': resolve(ui, 'packages/icons/src/index.ts'),
    '@adhar-ui/a11y': resolve(ui, 'packages/a11y/src/index.ts'),
  } },
  build: { outDir: resolve(import.meta.dirname, 'dist'), emptyOutDir: true },
})
