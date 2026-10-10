import { defineRemoteConfig } from '@adhar/build-config/remote'

export default defineRemoteConfig({
  name: 'define',
  port: 5101,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
  },
})
