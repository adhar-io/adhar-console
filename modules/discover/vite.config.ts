import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'discover',
  port: 5105,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
    './Logs': './src/views/logs.tsx',
    './Metrics': './src/views/metrics.tsx',
    './Traces': './src/views/traces.tsx',
    './Dashboards': './src/views/dashboards.tsx',
  },
})
