import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'decide',
  port: 5106,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
    './DoraSummary': './src/views/dora.tsx',
  },
})
