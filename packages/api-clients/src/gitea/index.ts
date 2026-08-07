import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Gitea v1 API client for the Develop module.
 *
 * Coverage: repos, branches, commits, pull requests, issues, file tree,
 * file contents (read + edit).
 *
 * Stub implementation seeds realistic data so the entire Develop UI
 * (browser IDE, repo cards, PR drawers, branch picker) renders end-to-end
 * without a live Gitea behind it.
 */

export const RepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  description: z.string().optional(),
  private: z.boolean(),
  default_branch: z.string(),
  updated_at: z.string(),
  stars_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  size: z.number().optional(),
  language: z.string().optional(),
  html_url: z.string().url(),
})
export type Repo = z.infer<typeof RepoSchema>

export const PullRequestSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().optional(),
  state: z.enum(['open', 'closed']),
  user: z.object({ login: z.string(), avatar_url: z.string().url() }),
  head: z.object({ ref: z.string(), sha: z.string().optional() }).optional(),
  base: z.object({ ref: z.string() }).optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  merged: z.boolean().optional(),
  mergeable: z.boolean().optional(),
  comments: z.number().optional(),
  review_comments: z.number().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changed_files: z.number().optional(),
  html_url: z.string().url(),
})
export type PullRequest = z.infer<typeof PullRequestSchema>

export const BranchSchema = z.object({
  name: z.string(),
  commit: z.object({
    id: z.string(),
    message: z.string(),
    author: z.object({ name: z.string(), email: z.string().optional() }),
    timestamp: z.string(),
  }),
  protected: z.boolean().optional(),
})
export type Branch = z.infer<typeof BranchSchema>

export const CommitSchema = z.object({
  sha: z.string(),
  short_sha: z.string(),
  message: z.string(),
  author: z.object({
    login: z.string(),
    avatar_url: z.string().url().optional(),
  }),
  created: z.string(),
  stats: z.object({ additions: z.number(), deletions: z.number() }).optional(),
})
export type Commit = z.infer<typeof CommitSchema>

export const IssueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().optional(),
  state: z.enum(['open', 'closed']),
  user: z.object({ login: z.string(), avatar_url: z.string().url().optional() }),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  assignees: z.array(z.object({ login: z.string() })).optional(),
  comments: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
})
export type Issue = z.infer<typeof IssueSchema>

export const TreeEntrySchema = z.object({
  path: z.string(),
  type: z.enum(['blob', 'tree']),
  size: z.number().optional(),
  sha: z.string().optional(),
})
export type TreeEntry = z.infer<typeof TreeEntrySchema>

export const FileContentsSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf-8', 'base64']),
  size: z.number(),
  sha: z.string(),
})
export type FileContents = z.infer<typeof FileContentsSchema>

export interface GiteaClient {
  listRepos(org: string): Promise<Repo[]>
  getRepo(org: string, name: string): Promise<Repo>
  listBranches(org: string, repo: string): Promise<Branch[]>
  listCommits(org: string, repo: string, ref?: string, limit?: number): Promise<Commit[]>
  listPullRequests(org: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<PullRequest[]>
  getPullRequest(org: string, repo: string, number: number): Promise<PullRequest>
  /** Raw unified diff (`.diff`) text for a pull request. */
  getPullDiff(org: string, repo: string, index: number): Promise<string>
  listIssues(org: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<Issue[]>
  /** List files at a path. Empty path = repo root. */
  listTree(org: string, repo: string, ref: string, path?: string): Promise<TreeEntry[]>
  getFile(org: string, repo: string, ref: string, path: string): Promise<FileContents>
  saveFile(
    org: string,
    repo: string,
    ref: string,
    path: string,
    body: { content: string; message: string; sha?: string },
  ): Promise<{ commit: { sha: string } }>
}

function build(http: HttpClient): GiteaClient {
  return {
    listRepos: (org) => http.get<Repo[]>(`/api/v1/orgs/${org}/repos`),
    getRepo: (org, name) => http.get<Repo>(`/api/v1/repos/${org}/${name}`),
    listBranches: (org, repo) => http.get<Branch[]>(`/api/v1/repos/${org}/${repo}/branches`),
    listCommits: (org, repo, ref = '', limit = 50) =>
      http.get<Commit[]>(
        `/api/v1/repos/${org}/${repo}/commits?limit=${limit}${ref ? `&sha=${ref}` : ''}`,
      ),
    listPullRequests: (org, repo, state = 'open') =>
      http.get<PullRequest[]>(`/api/v1/repos/${org}/${repo}/pulls?state=${state}`),
    getPullRequest: (org, repo, number) =>
      http.get<PullRequest>(`/api/v1/repos/${org}/${repo}/pulls/${number}`),
    getPullDiff: (org, repo, index) =>
      http.get<string>(`/api/v1/repos/${org}/${repo}/pulls/${index}.diff`, {
        response: 'text',
        headers: { accept: 'text/plain' },
      }),
    listIssues: (org, repo, state = 'open') =>
      http.get<Issue[]>(`/api/v1/repos/${org}/${repo}/issues?type=issues&state=${state}`),
    listTree: (org, repo, ref, path = '') =>
      http.get<TreeEntry[]>(
        `/api/v1/repos/${org}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      ),
    getFile: (org, repo, ref, path) =>
      http.get<FileContents>(
        `/api/v1/repos/${org}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}&raw=false`,
      ),
    saveFile: (org, repo, ref, path, body) =>
      http.put<{ commit: { sha: string } }>(
        `/api/v1/repos/${org}/${repo}/contents/${path}`,
        { ...body, branch: ref },
      ),
  }
}

/* ─────────── stub data ─────────── */

const STUB_REPOS: Repo[] = [
  {
    id: 1,
    name: 'adhar-console',
    full_name: 'acme/adhar-console',
    description: 'Enterprise console for the Adhar platform',
    private: false,
    default_branch: 'main',
    updated_at: '2026-04-23T14:22:00Z',
    stars_count: 12,
    forks_count: 3,
    open_issues_count: 4,
    size: 14820,
    language: 'TypeScript',
    html_url: 'https://gitea.adhar.local/acme/adhar-console',
  },
  {
    id: 2,
    name: 'billing-service',
    full_name: 'acme/billing-service',
    description: 'Subscription + invoicing microservice',
    private: true,
    default_branch: 'main',
    updated_at: '2026-04-22T09:11:00Z',
    stars_count: 2,
    forks_count: 0,
    open_issues_count: 7,
    size: 5240,
    language: 'Go',
    html_url: 'https://gitea.adhar.local/acme/billing-service',
  },
  {
    id: 3,
    name: 'customer-portal',
    full_name: 'acme/customer-portal',
    description: 'Next-gen customer self-service portal',
    private: false,
    default_branch: 'develop',
    updated_at: '2026-04-24T06:04:00Z',
    stars_count: 5,
    forks_count: 1,
    open_issues_count: 12,
    size: 8910,
    language: 'TypeScript',
    html_url: 'https://gitea.adhar.local/acme/customer-portal',
  },
  {
    id: 4,
    name: 'platform-bff',
    full_name: 'acme/platform-bff',
    description: 'Deno BFF aggregating Gitea, Plane, ArgoCD, Harbor',
    private: true,
    default_branch: 'main',
    updated_at: '2026-04-21T17:42:00Z',
    stars_count: 8,
    forks_count: 1,
    open_issues_count: 3,
    size: 3120,
    language: 'TypeScript',
    html_url: 'https://gitea.adhar.local/acme/platform-bff',
  },
  {
    id: 5,
    name: 'adhar-ui',
    full_name: 'acme/adhar-ui',
    description: 'Design system & component catalog',
    private: false,
    default_branch: 'main',
    updated_at: '2026-04-20T11:08:00Z',
    stars_count: 18,
    forks_count: 5,
    open_issues_count: 9,
    size: 6420,
    language: 'TypeScript',
    html_url: 'https://gitea.adhar.local/acme/adhar-ui',
  },
]

const STUB_PRS: Record<string, PullRequest[]> = {
  'adhar-console': [
    {
      id: 101,
      number: 42,
      title: 'feat: add OIDC support to BFF',
      body: 'Wires Keycloak with the standard OIDC discovery endpoint.\n\nFollow-up: rotate signing keys via Vault sidecar.',
      state: 'open',
      user: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      head: { ref: 'feat/oidc' },
      base: { ref: 'main' },
      created_at: '2026-04-22T10:00:00Z',
      updated_at: '2026-04-23T11:14:00Z',
      mergeable: true,
      comments: 4,
      review_comments: 7,
      additions: 312,
      deletions: 68,
      changed_files: 11,
      html_url: 'https://gitea.adhar.local/acme/adhar-console/pulls/42',
    },
    {
      id: 102,
      number: 43,
      title: 'chore: bump @adhar-ui/react to 0.2.0',
      body: 'Pulls in the new tokens + radial progress component.',
      state: 'open',
      user: { login: 'maya', avatar_url: 'https://i.pravatar.cc/64?u=maya' },
      head: { ref: 'chore/ui-bump' },
      base: { ref: 'main' },
      created_at: '2026-04-23T03:15:00Z',
      mergeable: true,
      comments: 1,
      review_comments: 0,
      additions: 24,
      deletions: 24,
      changed_files: 3,
      html_url: 'https://gitea.adhar.local/acme/adhar-console/pulls/43',
    },
  ],
  'billing-service': [
    {
      id: 201,
      number: 17,
      title: 'fix: VAT rounding for EU customers',
      state: 'open',
      user: { login: 'priya', avatar_url: 'https://i.pravatar.cc/64?u=priya' },
      head: { ref: 'fix/vat-round' },
      base: { ref: 'main' },
      created_at: '2026-04-22T08:42:00Z',
      mergeable: false,
      comments: 6,
      additions: 18,
      deletions: 12,
      changed_files: 2,
      html_url: 'https://gitea.adhar.local/acme/billing-service/pulls/17',
    },
  ],
}

const STUB_BRANCHES: Record<string, Branch[]> = {
  'adhar-console': [
    {
      name: 'main',
      commit: {
        id: 'a1b2c3d4e5f6',
        message: 'feat(define): polish project cards & graphs',
        author: { name: 'tapas', email: 'tapas@adhar.local' },
        timestamp: '2026-04-23T14:22:00Z',
      },
      protected: true,
    },
    {
      name: 'feat/oidc',
      commit: {
        id: 'b2c3d4e5f6a1',
        message: 'feat: wire keycloak discovery',
        author: { name: 'tapas' },
        timestamp: '2026-04-22T10:00:00Z',
      },
    },
    {
      name: 'chore/ui-bump',
      commit: {
        id: 'c3d4e5f6a1b2',
        message: 'chore: bump @adhar-ui/react',
        author: { name: 'maya' },
        timestamp: '2026-04-23T03:15:00Z',
      },
    },
  ],
  'billing-service': [
    {
      name: 'main',
      commit: {
        id: 'd4e5f6a1b2c3',
        message: 'feat(invoice): pdf export',
        author: { name: 'priya' },
        timestamp: '2026-04-22T09:11:00Z',
      },
      protected: true,
    },
    {
      name: 'fix/vat-round',
      commit: {
        id: 'e5f6a1b2c3d4',
        message: 'fix: VAT rounding for DE/FR',
        author: { name: 'priya' },
        timestamp: '2026-04-22T08:42:00Z',
      },
    },
  ],
  'customer-portal': [
    {
      name: 'develop',
      commit: {
        id: 'f6a1b2c3d4e5',
        message: 'wip: payment success screen',
        author: { name: 'maya' },
        timestamp: '2026-04-24T06:04:00Z',
      },
    },
    {
      name: 'main',
      commit: {
        id: '1a2b3c4d5e6f',
        message: 'release: 2.4.0',
        author: { name: 'release-bot' },
        timestamp: '2026-04-15T12:00:00Z',
      },
      protected: true,
    },
  ],
}

const STUB_COMMITS: Record<string, Commit[]> = {
  'adhar-console': [
    {
      sha: 'a1b2c3d4e5f60718',
      short_sha: 'a1b2c3d',
      message: 'feat(define): polish project cards & graphs',
      author: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      created: '2026-04-23T14:22:00Z',
      stats: { additions: 412, deletions: 88 },
    },
    {
      sha: 'b2c3d4e5f6a17182',
      short_sha: 'b2c3d4e',
      message: 'feat(design): inline visual builder + 28 block types',
      author: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      created: '2026-04-22T19:08:00Z',
      stats: { additions: 1840, deletions: 320 },
    },
    {
      sha: 'c3d4e5f6a1b27283',
      short_sha: 'c3d4e5f',
      message: 'fix(define): drawer z-index escapes main stacking context',
      author: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      created: '2026-04-21T10:14:00Z',
      stats: { additions: 96, deletions: 42 },
    },
    {
      sha: 'd4e5f6a1b2c37384',
      short_sha: 'd4e5f6a',
      message: 'chore(deps): bump tanstack/router to v1.2',
      author: { login: 'maya', avatar_url: 'https://i.pravatar.cc/64?u=maya' },
      created: '2026-04-20T08:30:00Z',
      stats: { additions: 12, deletions: 12 },
    },
  ],
  'billing-service': [
    {
      sha: 'd4e5f6a1b2c34850',
      short_sha: 'd4e5f6a',
      message: 'feat(invoice): pdf export',
      author: { login: 'priya', avatar_url: 'https://i.pravatar.cc/64?u=priya' },
      created: '2026-04-22T09:11:00Z',
      stats: { additions: 220, deletions: 18 },
    },
  ],
}

const STUB_ISSUES: Record<string, Issue[]> = {
  'adhar-console': [
    {
      id: 5001,
      number: 87,
      title: 'Brand-tinted dotted grid behind diagram previews looks washed out on dark mode',
      state: 'open',
      user: { login: 'maya', avatar_url: 'https://i.pravatar.cc/64?u=maya' },
      labels: [
        { name: 'bug', color: 'e11d48' },
        { name: 'a11y', color: '8b5cf6' },
      ],
      comments: 2,
      created_at: '2026-04-21T15:08:00Z',
    },
    {
      id: 5002,
      number: 88,
      title: 'Add SVG export to journey maps (parity with diagrams)',
      state: 'open',
      user: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      labels: [{ name: 'enhancement', color: '10b981' }],
      comments: 0,
      created_at: '2026-04-22T11:00:00Z',
    },
    {
      id: 5003,
      number: 89,
      title: 'Roadmap "past due" group shows future quarter items by mistake',
      state: 'open',
      user: { login: 'priya', avatar_url: 'https://i.pravatar.cc/64?u=priya' },
      labels: [{ name: 'bug', color: 'e11d48' }],
      comments: 4,
      created_at: '2026-04-19T07:42:00Z',
    },
  ],
}

// Realistic file tree for the IDE preview. Three nested folders + a few files.
const STUB_TREE: Record<string, TreeEntry[]> = {
  '': [
    { path: 'README.md', type: 'blob', size: 1024 },
    { path: 'package.json', type: 'blob', size: 512 },
    { path: 'tsconfig.json', type: 'blob', size: 220 },
    { path: 'src', type: 'tree' },
    { path: 'apps', type: 'tree' },
    { path: 'modules', type: 'tree' },
    { path: 'packages', type: 'tree' },
  ],
  src: [
    { path: 'src/main.ts', type: 'blob', size: 312 },
    { path: 'src/router.ts', type: 'blob', size: 880 },
  ],
  apps: [
    { path: 'apps/console', type: 'tree' },
    { path: 'apps/builder', type: 'tree' },
  ],
  'apps/console': [
    { path: 'apps/console/app.tsx', type: 'blob', size: 412 },
    { path: 'apps/console/index.html', type: 'blob', size: 280 },
  ],
  'apps/builder': [
    { path: 'apps/builder/main.tsx', type: 'blob', size: 320 },
  ],
  modules: [
    { path: 'modules/define', type: 'tree' },
    { path: 'modules/design', type: 'tree' },
    { path: 'modules/develop', type: 'tree' },
  ],
  'modules/develop': [
    { path: 'modules/develop/home.tsx', type: 'blob', size: 720 },
    { path: 'modules/develop/views', type: 'tree' },
  ],
  packages: [
    { path: 'packages/api-clients', type: 'tree' },
    { path: 'packages/shell-ui', type: 'tree' },
  ],
}

const STUB_FILES: Record<string, string> = {
  'README.md': `# adhar-console

Enterprise console for the Adhar platform.

## Stack

- TanStack Start + Module Federation
- Tailwind v4
- Deno BFF

## Getting started

\`\`\`bash
deno task dev
\`\`\`
`,
  'package.json': `{
  "name": "adhar-console",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["apps/*", "modules/*", "packages/*"]
}
`,
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true
  }
}
`,
  'src/main.ts': `import { router } from './router.ts'

export function bootstrap() {
  return router.start()
}

bootstrap()
`,
  'src/router.ts': `import { createRouter } from '@tanstack/react-router'

export const router = createRouter({
  routeTree: () => null,
  defaultPreload: 'intent',
})
`,
  'apps/console/app.tsx': `import { RouterProvider } from '@tanstack/react-router'
import { router } from '../../src/router.ts'

export function App() {
  return <RouterProvider router={router} />
}
`,
  'apps/console/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Adhar Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/app.tsx"></script>
  </body>
</html>
`,
  'apps/builder/main.tsx': `// Visual builder entry — runs at localhost:5174 in dev
import { Builder } from './builder.tsx'

export default Builder
`,
  'modules/develop/home.tsx': `// Develop module — repos, IDE, environments, CI
export { default } from './develop-home.tsx'
`,
}

/* ─────────── factory ─────────── */

export const GiteaClient = defineClient<GiteaClient>(build, () => ({
  listRepos: async () => STUB_REPOS,
  getRepo: async (_, name) => {
    const r = STUB_REPOS.find((x) => x.name === name)
    if (!r) throw new Error(`Stub: repo ${name} not found`)
    return r
  },
  listBranches: async (_, repo) => STUB_BRANCHES[repo] ?? [],
  listCommits: async (_, repo) => STUB_COMMITS[repo] ?? STUB_COMMITS['adhar-console'].slice(0, 1),
  listPullRequests: async (_, repo) => STUB_PRS[repo] ?? [],
  getPullRequest: async (_, repo, number) => {
    const p = (STUB_PRS[repo] ?? []).find((x) => x.number === number)
    if (!p) throw new Error(`Stub: PR ${number} not found`)
    return p
  },
  getPullDiff: async (_, repo, index) =>
    `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,4 +1,6 @@
 # Changelog

+## Unreleased — ${repo} #${index}
+- Stub diff (offline / test mode).

 ## 1.0.0
`,
  listIssues: async (_, repo) => STUB_ISSUES[repo] ?? [],
  listTree: async (_, _repo, _ref, path = '') => STUB_TREE[path] ?? [],
  getFile: async (_, _repo, _ref, path) => {
    const content = STUB_FILES[path] ?? `// ${path}\n// File contents not yet seeded.\n`
    return {
      path,
      content,
      encoding: 'utf-8' as const,
      size: content.length,
      sha: 'stub-' + path.replace(/\W/g, '').slice(0, 16),
    }
  },
  saveFile: async (_, _repo, _ref, path, body) => {
    STUB_FILES[path] = body.content
    return { commit: { sha: 'stub-' + Date.now().toString(36) } }
  },
}))
