import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'define',
  port: 5101,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
  },
})
