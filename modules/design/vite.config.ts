import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'design',
  port: 5102,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
  },
})
