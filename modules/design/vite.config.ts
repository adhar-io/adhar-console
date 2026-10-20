import { defineRemoteConfig } from '@adhar/build-config/remote'

export default defineRemoteConfig({
  name: 'design',
  port: 5102,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
    // Reusable "Decisions" panel for a catalog entity (ADRs linked to it).
    './Decisions': './src/components/entity-decisions.tsx',
  },
})
