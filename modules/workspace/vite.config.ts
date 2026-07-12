import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'workspace',
  port: 5108,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
    './Organization': './src/views/organization.tsx',
    './Members': './src/views/members.tsx',
    './Projects': './src/views/projects.tsx',
    './Tokens': './src/views/tokens.tsx',
    './Audit': './src/views/audit-log.tsx',
    './Plan': './src/views/plan.tsx',
  },
})
