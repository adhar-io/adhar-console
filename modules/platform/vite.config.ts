import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'platform',
  port: 5107,
  moduleDir: import.meta.dirname!,
  exposes: {
    // Only the top-level Home is federated. Internal views (ClusterView,
    // PodsView, PodDrawer, etc.) are bundled as part of Home's chunk since
    // the host never imports them directly.
    './Home': './src/home.tsx',
  },
})
