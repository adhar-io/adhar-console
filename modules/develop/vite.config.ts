import { defineRemoteConfig } from '@adhar/build-config/remote'

export default defineRemoteConfig({
  name: 'develop',
  port: 5103,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
    './RepoList': './src/views/repo-list.tsx',
    './PullRequestList': './src/views/pr-list.tsx',
    // Rendered under Deliver (/deliver?section=performance); see src/performance-entry.tsx.
    './Performance': './src/performance-entry.tsx',
    // Rendered under Deliver (/deliver?section=functions) in delivery mode; see src/functions-entry.tsx.
    './Functions': './src/functions-entry.tsx',
  },
})
