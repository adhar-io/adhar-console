import { PageHeader } from '@adhar-console/shell-ui'
import { Dashboard } from './views/dashboard.tsx'
import { RepoList } from './views/repo-list.tsx'
import { Ide } from './views/ide.tsx'
import { Branches } from './views/branches.tsx'
import { Commits } from './views/commits.tsx'
import { PullRequestList } from './views/pr-list.tsx'
import { Issues } from './views/issues.tsx'
import { Environments } from './views/environments.tsx'
import { WorkflowList } from './views/workflow-list.tsx'
import { CodeBuilder } from './views/code-builder.tsx'
import { Pipelines } from './views/pipelines.tsx'

type Section =
  | 'dashboard'
  | 'repos'
  | 'ide'
  | 'branches'
  | 'commits'
  | 'prs'
  | 'issues'
  | 'environments'
  | 'workflows'
  | 'pipelines'
  | 'codebuilder'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Develop Dashboard',
    description: 'Engineering pulse — repos, open PRs, CI runs, cloud dev envs at a glance.',
  },
  repos: {
    label: 'Repositories',
    description: 'Every repository in the active org — backed by Gitea.',
  },
  ide: {
    label: 'Visual Studio Code',
    description: 'Full Visual Studio Code in the browser — extensions, terminal, debugger. Backed by code-server (or vscode.dev fallback).',
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
    description: 'Coder workspaces — spin up an IDE, terminal, and preview from any template.',
  },
  workflows: {
    label: 'CI Workflows',
    description: 'Argo Workflows runs across namespaces, live from the apiserver.',
  },
  pipelines: {
    label: 'Data Pipelines',
    description: 'Airbyte source × destination connections — sync schedules, jobs, throughput.',
  },
  codebuilder: {
    label: 'Code Builder',
    description: 'Drag-and-drop code scaffolder — wire components, generate source.',
  },
}

export default function DevelopHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  return (
    <div className="space-y-6">
      <PageHeader title={def.label} description={def.description} />
      {active === 'dashboard' && <Dashboard />}
      {active === 'repos' && <RepoList />}
      {active === 'ide' && <Ide />}
      {active === 'branches' && <Branches />}
      {active === 'commits' && <Commits />}
      {active === 'prs' && <PullRequestList />}
      {active === 'issues' && <Issues />}
      {active === 'environments' && <Environments />}
      {active === 'workflows' && <WorkflowList />}
      {active === 'pipelines' && <Pipelines />}
      {active === 'codebuilder' && <CodeBuilder />}
    </div>
  )
}
