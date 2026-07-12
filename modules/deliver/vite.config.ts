import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'deliver',
  port: 5104,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
    './ArgoApps': './src/views/argo-apps.tsx',
    './KargoStages': './src/views/kargo-stages.tsx',
    './Rollouts': './src/views/rollouts.tsx',
    './Registry': './src/views/registry.tsx',
    './Policy': './src/views/policy.tsx',
  },
})
