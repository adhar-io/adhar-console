import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'develop',
  port: 5103,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
    './RepoList': './src/views/repo-list.tsx',
    './PullRequestList': './src/views/pr-list.tsx',
    './WorkflowList': './src/views/workflow-list.tsx',
  },
})
