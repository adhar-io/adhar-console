import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { consoleAliases } from '../packages/build-config/src/paths.ts'
export default defineConfig({
  root: import.meta.dirname, base: './',
  plugins: [react(), tailwind(), { name: 'stub', enforce: 'pre', transform(code, id) {
    if (id.includes('base/factory')) return code.replace(/const real = mode !== 'stub'/, 'const real = false')
    if (id.includes('k8s/client')) return code.replace(/const real = opts.mode !== 'stub'/, 'const real = false')
  } }],
  resolve: { alias: consoleAliases('/Users/tapas-pc/Documents/Work/Anication/AdharWS/adhar-console') },
  build: { outDir: 'dist', chunkSizeWarningLimit: 99999 },
})
