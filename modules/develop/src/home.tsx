import { PageHeader } from '@adhar/shell-ui'
import { Dashboard } from './views/dashboard.tsx'
import { RepoList } from './views/repo-list.tsx'
import { Branches } from './views/branches.tsx'
import { Commits } from './views/commits.tsx'
import { PullRequestList } from './views/pr-list.tsx'
import { Issues } from './views/issues.tsx'
import { Environments } from './views/environments.tsx'
import { Pipelines } from './views/pipelines.tsx'
import { Performance } from './views/performance.tsx'
import { Content } from './views/content.tsx'
import { Functions } from './views/functions.tsx'

type Section =
  | 'dashboard'
  | 'repos'
  | 'branches'
  | 'commits'
  | 'prs'
  | 'issues'
  | 'environments'
  | 'pipelines'
  | 'performance'
  | 'content'
  | 'functions'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Develop Dashboard',
    description: 'Engineering pulse — repos, open PRs, CI runs, cloud dev envs at a glance.',
  },
  repos: {
    label: 'Repositories',
    description: 'Every repository in the active org — backed by Gitea.',
  },
  branches: {
    label: 'Branches',
    description: 'Branch list per repo — protection state and last commit.',
  },
  commits: {
    label: 'Commits',
    description: 'Commit history on any branch with diff stats.',
  },
  prs: {
    label: 'Pull Requests',
    description: 'Open pull requests awaiting review, tests, or merge.',
  },
  issues: {
    label: 'Issues',
    description: 'Repository issues — bugs, enhancements, questions.',
  },
  environments: {
    label: 'Cloud Dev Environments',
    description: 'Coder workspaces — code-server, terminal and previews on the cluster, from any template.',
  },
  pipelines: {
    label: 'Pipelines',
    description: 'Airbyte source × destination connections — sync schedules, jobs, throughput.',
  },
  performance: {
    label: 'Performance Center',
    description:
      'k6 load and API performance tests — run them on the cluster, watch the stages, read the thresholds that passed or failed.',
  },
  content: {
    label: 'Content',
    description: 'Strapi headless CMS — content types, entries, drafts and publishing, media, and the API services read.',
  },
  functions: {
    label: 'Functions',
    description: 'Create and manage serverless Function resources with scale-to-zero and on-demand scaling.',
  },
}

/** Views that render their own PageHeader — they put a repo picker or actions in it. */
const SELF_HEADED = new Set<Section>(['branches', 'commits', 'prs', 'issues', 'pipelines', 'performance'])

export default function DevelopHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  return (
    <div className="space-y-6">
      {SELF_HEADED.has(active) ? null : <PageHeader title={def.label} />}
      {active === 'dashboard' && <Dashboard />}
      {active === 'repos' && <RepoList />}
      {active === 'branches' && <Branches />}
      {active === 'commits' && <Commits />}
      {active === 'prs' && <PullRequestList />}
      {active === 'issues' && <Issues />}
      {active === 'environments' && <Environments />}
      {active === 'pipelines' && <Pipelines />}
      {active === 'performance' && <Performance />}
      {active === 'content' && <Content />}
      {active === 'functions' && <Functions />}
    </div>
  )
}
