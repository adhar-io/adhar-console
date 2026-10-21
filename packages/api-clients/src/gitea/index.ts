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
  created_at: z.string().optional(),
  stars_count: z.number(),
  forks_count: z.number(),
  watchers_count: z.number().optional(),
  open_issues_count: z.number(),
  open_pr_counter: z.number().optional(),
  release_counter: z.number().optional(),
  size: z.number().optional(),
  language: z.string().optional(),
  html_url: z.string().url(),
  clone_url: z.string().optional(),
  ssh_url: z.string().optional(),
  website: z.string().optional(),
  owner: z.object({ login: z.string(), avatar_url: z.string().optional() }).optional(),
  archived: z.boolean().optional(),
  archived_at: z.string().optional(),
  fork: z.boolean().optional(),
  template: z.boolean().optional(),
  mirror: z.boolean().optional(),
  empty: z.boolean().optional(),
  internal: z.boolean().optional(),
  topics: z.array(z.string()).nullable().optional(),
  has_issues: z.boolean().optional(),
  has_pull_requests: z.boolean().optional(),
  has_wiki: z.boolean().optional(),
  has_projects: z.boolean().optional(),
  has_actions: z.boolean().optional(),
  has_packages: z.boolean().optional(),
  has_releases: z.boolean().optional(),
  allow_merge_commits: z.boolean().optional(),
  allow_rebase: z.boolean().optional(),
  allow_rebase_explicit: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  allow_fast_forward_only_merge: z.boolean().optional(),
  default_merge_style: z.string().optional(),
  default_delete_branch_after_merge: z.boolean().optional(),
  permissions: z.object({ admin: z.boolean(), push: z.boolean(), pull: z.boolean() }).optional(),
  parent: z.object({ full_name: z.string(), html_url: z.string().optional() }).nullable().optional(),
})
export type Repo = z.infer<typeof RepoSchema>

/** `POST /orgs/{org}/repos` body. */
export interface CreateRepoBody {
  name: string
  description?: string
  private?: boolean
  auto_init?: boolean
  default_branch?: string
  gitignores?: string
  license?: string
  readme?: string
  template?: boolean
  issue_labels?: string
  trust_model?: 'default' | 'collaborator' | 'committer' | 'collaboratorcommitter'
}

/** `PATCH /repos/{owner}/{repo}` body — every field optional. */
export interface UpdateRepoBody {
  name?: string
  description?: string
  website?: string
  private?: boolean
  template?: boolean
  archived?: boolean
  default_branch?: string
  has_issues?: boolean
  has_pull_requests?: boolean
  has_wiki?: boolean
  has_projects?: boolean
  has_actions?: boolean
  has_packages?: boolean
  has_releases?: boolean
  allow_merge_commits?: boolean
  allow_rebase?: boolean
  allow_rebase_explicit?: boolean
  allow_squash_merge?: boolean
  allow_fast_forward_only_merge?: boolean
  default_merge_style?: string
  default_delete_branch_after_merge?: boolean
}

export const CollaboratorSchema = z.object({
  id: z.number(),
  login: z.string(),
  full_name: z.string().optional(),
  email: z.string().optional(),
  avatar_url: z.string().optional(),
  is_admin: z.boolean().optional(),
})
export type Collaborator = z.infer<typeof CollaboratorSchema>
export type CollaboratorPermission = 'read' | 'write' | 'admin'

export const ReleaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  target_commitish: z.string().optional(),
  name: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  created_at: z.string(),
  published_at: z.string().optional(),
  html_url: z.string().optional(),
  tarball_url: z.string().optional(),
  zipball_url: z.string().optional(),
  author: z.object({ login: z.string(), avatar_url: z.string().optional() }).optional(),
  assets: z.array(z.object({ id: z.number(), name: z.string(), size: z.number().optional(), download_count: z.number().optional(), browser_download_url: z.string().optional() })).optional(),
})
export type Release = z.infer<typeof ReleaseSchema>

export const TagSchema = z.object({
  name: z.string(),
  message: z.string().optional(),
  commit: z.object({ sha: z.string(), url: z.string().optional(), created: z.string().optional() }).optional(),
  zipball_url: z.string().optional(),
  tarball_url: z.string().optional(),
})
export type Tag = z.infer<typeof TagSchema>

export const WebhookSchema = z.object({
  id: z.number(),
  type: z.string(),
  active: z.boolean(),
  events: z.array(z.string()),
  config: z.object({ url: z.string().optional(), content_type: z.string().optional() }).passthrough(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
export type Webhook = z.infer<typeof WebhookSchema>

export interface CreateWebhookBody {
  type: 'gitea' | 'slack' | 'discord' | 'dingtalk' | 'telegram' | 'msteams' | 'feishu' | 'matrix' | 'wechatwork' | 'packagist'
  config: { url: string; content_type: 'json' | 'form'; secret?: string }
  events: string[]
  active: boolean
  branch_filter?: string
}

export const BranchProtectionSchema = z.object({
  rule_name: z.string().optional(),
  branch_name: z.string().optional(),
  enable_push: z.boolean().optional(),
  enable_push_whitelist: z.boolean().optional(),
  push_whitelist_usernames: z.array(z.string()).nullable().optional(),
  required_approvals: z.number().optional(),
  enable_status_check: z.boolean().optional(),
  status_check_contexts: z.array(z.string()).nullable().optional(),
  block_on_rejected_reviews: z.boolean().optional(),
  block_on_outdated_branch: z.boolean().optional(),
  dismiss_stale_approvals: z.boolean().optional(),
  require_signed_commits: z.boolean().optional(),
  protected_file_patterns: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
export type BranchProtection = z.infer<typeof BranchProtectionSchema>

export interface CreateBranchProtectionBody {
  /** Gitea ≥ 1.21 uses glob rule names; older versions use `branch_name`. We send both. */
  rule_name: string
  branch_name?: string
  enable_push?: boolean
  required_approvals?: number
  block_on_rejected_reviews?: boolean
  block_on_outdated_branch?: boolean
  dismiss_stale_approvals?: boolean
  require_signed_commits?: boolean
  enable_status_check?: boolean
  status_check_contexts?: string[]
}

export const LabelSchema = z.object({
  id: z.number(),
  name: z.string(),
  color: z.string(),
  description: z.string().optional(),
})
export type Label = z.infer<typeof LabelSchema>

export const PullRequestSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().optional(),
  state: z.enum(['open', 'closed']),
  user: z.object({ login: z.string(), avatar_url: z.string().url() }),
  head: z.object({ ref: z.string(), sha: z.string().optional() }).optional(),
  base: z.object({ ref: z.string(), sha: z.string().optional() }).optional(),
  labels: z.array(z.object({ id: z.number().optional(), name: z.string(), color: z.string() })).nullable().optional(),
  assignees: z.array(z.object({ login: z.string(), avatar_url: z.string().optional() })).nullable().optional(),
  requested_reviewers: z.array(z.object({ login: z.string(), avatar_url: z.string().optional() })).nullable().optional(),
  merged_by: z.object({ login: z.string(), avatar_url: z.string().optional() }).nullable().optional(),
  draft: z.boolean().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  closed_at: z.string().nullable().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
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
  labels: z.array(z.object({ id: z.number().optional(), name: z.string(), color: z.string() })),
  assignees: z.array(z.object({ login: z.string(), avatar_url: z.string().optional() })).nullable().optional(),
  milestone: z.object({ id: z.number(), title: z.string() }).nullable().optional(),
  comments: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  closed_at: z.string().nullable().optional(),
  html_url: z.string().optional(),
})
export type Issue = z.infer<typeof IssueSchema>

/** A comment on an issue or pull request (Gitea shares the endpoint). */
export const CommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  user: z.object({ login: z.string(), avatar_url: z.string().optional() }),
  created_at: z.string(),
  updated_at: z.string().optional(),
})
export type Comment = z.infer<typeof CommentSchema>

export type ReviewState = 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT' | 'PENDING' | 'REQUEST_REVIEW'
export const ReviewSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string(), avatar_url: z.string().optional() }).nullable(),
  state: z.string(),
  body: z.string().optional(),
  submitted_at: z.string().optional(),
  stale: z.boolean().optional(),
  dismissed: z.boolean().optional(),
})
export type Review = z.infer<typeof ReviewSchema>

/** One commit with its parents, totals and touched files. */
export interface CommitDetail extends Commit {
  author_name?: string
  author_email?: string
  committer_name?: string
  parents: string[]
  files: Array<{ filename: string; status: string }>
  html_url?: string
}

/** `GET /compare/{base}...{head}` — what `head` has that `base` lacks. */
export interface CompareResult {
  total_commits: number
  commits: Commit[]
}

export type MergeStyle = 'merge' | 'rebase' | 'rebase-merge' | 'squash' | 'fast-forward-only'

export interface CreatePullBody {
  head: string
  base: string
  title: string
  body?: string
  assignees?: string[]
  labels?: number[]
}
export interface UpdatePullBody {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  base?: string
  assignees?: string[]
  labels?: number[]
}
export interface CreateIssueBody {
  title: string
  body?: string
  assignees?: string[]
  labels?: number[]
}
export interface UpdateIssueBody {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  assignees?: string[]
}

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

export interface SearchIssuesOptions {
  owner: string
  type: 'issues' | 'pulls'
  state: 'open' | 'closed' | 'all'
  page?: number
  /** Gitea caps a page at its MAX_RESPONSE_ITEMS (50 by default). */
  limit?: number
}

/** An issue search hit — an issue (or a PR's issue) plus the repository it lives in. */
export type SearchedIssue = Issue & {
  repository?: { id?: number; name: string; owner?: string; full_name?: string }
  pull_request?: { merged?: boolean; merged_at?: string | null; draft?: boolean } | null
}

export interface GiteaClient {
  listRepos(org: string): Promise<Repo[]>
  getRepo(org: string, name: string): Promise<Repo>
  listBranches(org: string, repo: string): Promise<Branch[]>
  listCommits(org: string, repo: string, ref?: string, limit?: number, opts?: { page?: number; path?: string }): Promise<Commit[]>
  listPullRequests(org: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<PullRequest[]>
  getPullRequest(org: string, repo: string, number: number): Promise<PullRequest>
  /** Raw unified diff (`.diff`) text for a pull request. */
  getPullDiff(org: string, repo: string, index: number): Promise<string>
  listIssues(org: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<Issue[]>
  getIssue(org: string, repo: string, index: number): Promise<Issue>
  /**
   * One page of Gitea's cross-repository issue search
   * (`GET /repos/issues/search`), narrowed to an owner. One request answers
   * "which issues / PRs exist across the org" — the alternative is one call
   * per repository. `total` is Gitea's `X-Total-Count`, when it sends one.
   */
  searchIssues(opts: SearchIssuesOptions): Promise<{ items: SearchedIssue[]; total?: number }>
  createIssue(org: string, repo: string, body: CreateIssueBody): Promise<Issue>
  updateIssue(org: string, repo: string, index: number, body: UpdateIssueBody): Promise<Issue>
  /** Replace the issue's (or PR's) labels with these label ids. */
  setIssueLabels(org: string, repo: string, index: number, labels: number[]): Promise<void>
  /** Comments on an issue or a pull request — Gitea serves both from one endpoint. */
  listComments(org: string, repo: string, index: number): Promise<Comment[]>
  createComment(org: string, repo: string, index: number, body: string): Promise<Comment>
  deleteComment(org: string, repo: string, id: number): Promise<void>

  /* ── pull request workflow ── */
  createPullRequest(org: string, repo: string, body: CreatePullBody): Promise<PullRequest>
  updatePullRequest(org: string, repo: string, index: number, body: UpdatePullBody): Promise<PullRequest>
  mergePullRequest(
    org: string,
    repo: string,
    index: number,
    body: { style: MergeStyle; title?: string; message?: string; deleteBranch?: boolean },
  ): Promise<void>
  listPullCommits(org: string, repo: string, index: number): Promise<Commit[]>
  listPullReviews(org: string, repo: string, index: number): Promise<Review[]>
  createPullReview(
    org: string,
    repo: string,
    index: number,
    body: { event: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string },
  ): Promise<Review>

  /* ── commits ── */
  getCommit(org: string, repo: string, sha: string): Promise<CommitDetail>
  /** Raw unified diff (`.diff`) of one commit against its first parent. */
  getCommitDiff(org: string, repo: string, sha: string): Promise<string>
  /** Commits `head` has that `base` does not (Gitea ≥ 1.22). */
  compare(org: string, repo: string, base: string, head: string): Promise<CompareResult>
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
  /**
   * Delete a file. `sha` is the blob sha of the version being removed — Gitea
   * refuses without it, which is what stops a delete racing an edit.
   */
  deleteFile(
    org: string,
    repo: string,
    ref: string,
    path: string,
    body: { message: string; sha: string },
  ): Promise<void>
  /**
   * Write several files in ONE commit (Gitea ≥ 1.20, `POST /contents`).
   * `content` is base64. `update` / `delete` need the current blob `sha`.
   */
  changeFiles(
    org: string,
    repo: string,
    ref: string,
    body: {
      message: string
      files: Array<{ operation: 'create' | 'update' | 'delete'; path: string; content?: string; sha?: string }>
      /** Commit onto a NEW branch created from `ref` instead of `ref` itself. */
      new_branch?: string
    },
  ): Promise<{ commit: { sha: string; html_url?: string } }>
  /**
   * Every blob path (+ blob sha) at `ref`, recursively — one request for the
   * whole repository tree. `truncated` is set when Gitea capped the listing.
   */
  getTreeRecursive(org: string, repo: string, ref: string): Promise<{ entries: Array<{ path: string; sha: string; size?: number }>; truncated: boolean }>

  /* ── repository management ── */
  createRepo(org: string, body: CreateRepoBody): Promise<Repo>
  updateRepo(org: string, repo: string, body: UpdateRepoBody): Promise<Repo>
  deleteRepo(org: string, repo: string): Promise<void>
  forkRepo(org: string, repo: string, targetOrg: string, name?: string): Promise<Repo>
  /** Bytes per language, e.g. `{ TypeScript: 12345, Go: 678 }`. */
  listLanguages(org: string, repo: string): Promise<Record<string, number>>
  listTopics(org: string, repo: string): Promise<string[]>
  setTopics(org: string, repo: string, topics: string[]): Promise<void>

  /* ── branches ── */
  createBranch(org: string, repo: string, name: string, from: string): Promise<Branch>
  deleteBranch(org: string, repo: string, name: string): Promise<void>
  listBranchProtections(org: string, repo: string): Promise<BranchProtection[]>
  createBranchProtection(org: string, repo: string, body: CreateBranchProtectionBody): Promise<BranchProtection>
  deleteBranchProtection(org: string, repo: string, ruleName: string): Promise<void>

  /* ── collaborators ── */
  listCollaborators(org: string, repo: string): Promise<Collaborator[]>
  addCollaborator(org: string, repo: string, user: string, permission: CollaboratorPermission): Promise<void>
  removeCollaborator(org: string, repo: string, user: string): Promise<void>
  /** Users matching a query — for the add-collaborator picker. */
  searchUsers(q: string, limit?: number): Promise<Collaborator[]>

  /* ── releases + tags ── */
  listReleases(org: string, repo: string): Promise<Release[]>
  createRelease(
    org: string,
    repo: string,
    body: { tag_name: string; target_commitish?: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean },
  ): Promise<Release>
  deleteRelease(org: string, repo: string, id: number): Promise<void>
  listTags(org: string, repo: string): Promise<Tag[]>
  createTag(org: string, repo: string, body: { tag_name: string; target?: string; message?: string }): Promise<Tag>
  deleteTag(org: string, repo: string, tag: string): Promise<void>

  /* ── webhooks ── */
  listWebhooks(org: string, repo: string): Promise<Webhook[]>
  createWebhook(org: string, repo: string, body: CreateWebhookBody): Promise<Webhook>
  updateWebhook(org: string, repo: string, id: number, body: Partial<CreateWebhookBody>): Promise<Webhook>
  deleteWebhook(org: string, repo: string, id: number): Promise<void>
  testWebhook(org: string, repo: string, id: number): Promise<void>

  /* ── labels ── */
  listLabels(org: string, repo: string): Promise<Label[]>
}

const PAGE = 50

/** Wire shape of `GET /repos/{o}/{r}/commits` — nested `commit`, nullable `author`. */
interface RawCommit {
  sha: string
  created?: string
  html_url?: string
  commit?: {
    message?: string
    author?: { name?: string; email?: string; date?: string }
    committer?: { name?: string; email?: string; date?: string }
  }
  author?: { login?: string; avatar_url?: string } | null
  committer?: { login?: string; avatar_url?: string } | null
  stats?: { additions?: number; deletions?: number; total?: number } | null
  // Already-flat (stub / older console) shape.
  message?: string
  short_sha?: string
}

function toCommit(c: RawCommit): Commit {
  const login = c.author?.login ?? c.committer?.login ?? c.commit?.author?.name ?? c.commit?.committer?.name ?? 'unknown'
  const avatar = c.author?.avatar_url ?? c.committer?.avatar_url
  return {
    sha: c.sha,
    short_sha: c.short_sha ?? c.sha.slice(0, 7),
    message: c.commit?.message ?? c.message ?? '',
    author: { login, ...(avatar ? { avatar_url: avatar } : {}) },
    created: c.created ?? c.commit?.author?.date ?? c.commit?.committer?.date ?? new Date(0).toISOString(),
    ...(c.stats ? { stats: { additions: c.stats.additions ?? 0, deletions: c.stats.deletions ?? 0 } } : {}),
  }
}

/**
 * Read every page of a Gitea list (up to `maxPages`).
 *
 * Gitea reports the total in `X-Total-Count`, so after the first page the
 * rest are requested together — 150 repositories are two round trips, not
 * four in a row (three full pages and the empty one that proved the end).
 * Without the header (an older Gitea, or a proxy that strips it) it falls
 * back to walking pages until a short one comes back.
 */
async function paginate<T>(http: HttpClient, path: string, maxPages = 20): Promise<T[]> {
  const sep = path.includes('?') ? '&' : '?'
  const url = (page: number) => `${path}${sep}limit=${PAGE}&page=${page}`
  const res = await http.get<Response>(url(1), { response: 'raw' })
  const text = await res.text()
  const first = (text ? JSON.parse(text) : []) as T[]
  if (!Array.isArray(first) || first.length < PAGE || maxPages <= 1) return Array.isArray(first) ? first : []
  const total = Number(res.headers.get('x-total-count'))
  if (res.headers.has('x-total-count') && Number.isFinite(total)) {
    const pages = Math.min(maxPages, Math.ceil(total / PAGE))
    const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => http.get<T[]>(url(i + 2))))
    return [first, ...rest].flat()
  }
  const out: T[] = [...first]
  for (let page = 2; page <= maxPages; page++) {
    const chunk = await http.get<T[]>(url(page))
    out.push(...chunk)
    if (chunk.length < PAGE) break
  }
  return out
}

const enc = encodeURIComponent

function build(http: HttpClient): GiteaClient {
  return {
    listRepos: (org) => paginate<Repo>(http, `/api/v1/orgs/${org}/repos`),
    getRepo: (org, name) => http.get<Repo>(`/api/v1/repos/${org}/${name}`),
    listBranches: (org, repo) => paginate<Branch>(http, `/api/v1/repos/${org}/${repo}/branches`, 6),
    // Gitea nests the message under `commit` and leaves `author` null for
    // commits whose email isn't a Gitea user — flatten to the UI's Commit.
    listCommits: async (org, repo, ref = '', limit = 50, opts = {}) => {
      const raw = await http.get<RawCommit[]>(
        `/api/v1/repos/${org}/${repo}/commits?limit=${limit}&files=false&verification=false${ref ? `&sha=${enc(ref)}` : ''}${
          opts.page ? `&page=${opts.page}` : ''
        }${opts.path ? `&path=${enc(opts.path)}` : ''}`,
      )
      return raw.map(toCommit)
    },
    // Open lists are walked to the end; closed history stops after a few
    // pages — it only grows, and the views show the recent end of it.
    listPullRequests: (org, repo, state = 'open') =>
      paginate<PullRequest>(http, `/api/v1/repos/${org}/${repo}/pulls?state=${state}&sort=recentupdate`, state === 'open' ? 10 : 2),
    getPullRequest: (org, repo, number) =>
      http.get<PullRequest>(`/api/v1/repos/${org}/${repo}/pulls/${number}`),
    getPullDiff: (org, repo, index) =>
      http.get<string>(`/api/v1/repos/${org}/${repo}/pulls/${index}.diff`, {
        response: 'text',
        headers: { accept: 'text/plain' },
      }),
    listIssues: (org, repo, state = 'open') =>
      paginate<Issue>(http, `/api/v1/repos/${org}/${repo}/issues?type=issues&state=${state}`, state === 'open' ? 10 : 2),
    getIssue: (org, repo, index) => http.get<Issue>(`/api/v1/repos/${org}/${repo}/issues/${index}`),
    searchIssues: async ({ owner, type, state, page = 1, limit = PAGE }) => {
      const res = await http.get<Response>(
        `/api/v1/repos/issues/search?owner=${enc(owner)}&type=${type}&state=${state}&page=${page}&limit=${limit}`,
        { response: 'raw' },
      )
      const items = ((await res.json()) ?? []) as SearchedIssue[]
      const total = Number(res.headers.get('x-total-count'))
      return { items, total: Number.isFinite(total) && res.headers.has('x-total-count') ? total : undefined }
    },
    createIssue: (org, repo, body) => http.post<Issue>(`/api/v1/repos/${org}/${repo}/issues`, body),
    updateIssue: (org, repo, index, body) => http.patch<Issue>(`/api/v1/repos/${org}/${repo}/issues/${index}`, body),
    setIssueLabels: async (org, repo, index, labels) => {
      await http.put(`/api/v1/repos/${org}/${repo}/issues/${index}/labels`, { labels }, { response: 'raw' })
    },
    listComments: (org, repo, index) => paginate<Comment>(http, `/api/v1/repos/${org}/${repo}/issues/${index}/comments`, 4),
    createComment: (org, repo, index, body) =>
      http.post<Comment>(`/api/v1/repos/${org}/${repo}/issues/${index}/comments`, { body }),
    deleteComment: async (org, repo, id) => {
      await http.delete(`/api/v1/repos/${org}/${repo}/issues/comments/${id}`, { response: 'raw' })
    },

    createPullRequest: (org, repo, body) => http.post<PullRequest>(`/api/v1/repos/${org}/${repo}/pulls`, body),
    updatePullRequest: (org, repo, index, body) => http.patch<PullRequest>(`/api/v1/repos/${org}/${repo}/pulls/${index}`, body),
    // Gitea's merge form keeps its Go field names (`Do`, `MergeTitleField`).
    mergePullRequest: async (org, repo, index, body) => {
      await http.post(
        `/api/v1/repos/${org}/${repo}/pulls/${index}/merge`,
        {
          Do: body.style,
          ...(body.title ? { MergeTitleField: body.title } : {}),
          ...(body.message ? { MergeMessageField: body.message } : {}),
          delete_branch_after_merge: !!body.deleteBranch,
        },
        { response: 'raw' },
      )
    },
    listPullCommits: async (org, repo, index) => {
      const raw = await paginate<RawCommit>(http, `/api/v1/repos/${org}/${repo}/pulls/${index}/commits?files=false&verification=false`, 4)
      return raw.map(toCommit)
    },
    listPullReviews: (org, repo, index) => paginate<Review>(http, `/api/v1/repos/${org}/${repo}/pulls/${index}/reviews`, 2),
    createPullReview: (org, repo, index, body) =>
      http.post<Review>(`/api/v1/repos/${org}/${repo}/pulls/${index}/reviews`, { event: body.event, body: body.body ?? '' }),

    getCommit: async (org, repo, sha) => {
      const raw = await http.get<RawCommit & { parents?: Array<{ sha: string }>; files?: Array<{ filename: string; status: string }> }>(
        `/api/v1/repos/${org}/${repo}/git/commits/${enc(sha)}?stat=true&verification=false`,
      )
      return {
        ...toCommit(raw),
        author_name: raw.commit?.author?.name,
        author_email: raw.commit?.author?.email,
        committer_name: raw.commit?.committer?.name,
        parents: (raw.parents ?? []).map((p) => p.sha),
        files: raw.files ?? [],
        html_url: raw.html_url,
      }
    },
    getCommitDiff: (org, repo, sha) =>
      http.get<string>(`/api/v1/repos/${org}/${repo}/git/commits/${enc(sha)}.diff`, {
        response: 'text',
        headers: { accept: 'text/plain' },
      }),
    compare: async (org, repo, base, head) => {
      const raw = await http.get<{ total_commits?: number; commits?: RawCommit[] }>(
        `/api/v1/repos/${org}/${repo}/compare/${enc(base)}...${enc(head)}`,
      )
      const commits = (raw.commits ?? []).map(toCommit)
      return { total_commits: raw.total_commits ?? commits.length, commits }
    },
    // Gitea's contents API reports `file | dir | symlink | submodule`; the UI
    // speaks git's `blob | tree`, so normalise here (a bare `file` would render
    // every folder as a leaf).
    listTree: async (org, repo, ref, path = '') => {
      const raw = await http.get<Array<{ path: string; type: string; size?: number; sha?: string }>>(
        `/api/v1/repos/${org}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      )
      return raw.map((e) => ({
        path: e.path,
        type: e.type === 'dir' || e.type === 'tree' ? 'tree' : 'blob',
        size: e.size,
        sha: e.sha,
      }))
    },
    getFile: (org, repo, ref, path) =>
      http.get<FileContents>(
        `/api/v1/repos/${org}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}&raw=false`,
      ),
    saveFile: (org, repo, ref, path, body) =>
      http.put<{ commit: { sha: string } }>(
        `/api/v1/repos/${org}/${repo}/contents/${path}`,
        { ...body, branch: ref },
      ),
    deleteFile: async (org, repo, ref, path, body) => {
      await http.delete(`/api/v1/repos/${org}/${repo}/contents/${path}`, {
        body: { ...body, branch: ref },
        response: 'raw',
      })
    },
    getTreeRecursive: async (org, repo, ref) => {
      const raw = await http.get<{ tree?: Array<{ path: string; type: string; sha: string; size?: number }>; truncated?: boolean }>(
        `/api/v1/repos/${org}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=true&per_page=10000`,
      )
      return {
        entries: (raw.tree ?? []).filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size })),
        truncated: !!raw.truncated,
      }
    },
    changeFiles: (org, repo, ref, body) =>
      http.post<{ commit: { sha: string; html_url?: string } }>(
        `/api/v1/repos/${org}/${repo}/contents`,
        { ...body, branch: ref },
      ),

    createRepo: (org, body) => http.post<Repo>(`/api/v1/orgs/${org}/repos`, body),
    updateRepo: (org, repo, body) => http.patch<Repo>(`/api/v1/repos/${org}/${repo}`, body),
    deleteRepo: async (org, repo) => {
      await http.delete(`/api/v1/repos/${org}/${repo}`, { response: 'raw' })
    },
    forkRepo: (org, repo, targetOrg, name) =>
      http.post<Repo>(`/api/v1/repos/${org}/${repo}/forks`, { organization: targetOrg, ...(name ? { name } : {}) }),
    listLanguages: (org, repo) => http.get<Record<string, number>>(`/api/v1/repos/${org}/${repo}/languages`),
    listTopics: async (org, repo) => {
      const r = await http.get<{ topics: string[] | null }>(`/api/v1/repos/${org}/${repo}/topics`)
      return r.topics ?? []
    },
    setTopics: async (org, repo, topics) => {
      await http.put(`/api/v1/repos/${org}/${repo}/topics`, { topics }, { response: 'raw' })
    },

    createBranch: (org, repo, name, from) =>
      http.post<Branch>(`/api/v1/repos/${org}/${repo}/branches`, { new_branch_name: name, old_branch_name: from }),
    deleteBranch: async (org, repo, name) => {
      await http.delete(`/api/v1/repos/${org}/${repo}/branches/${enc(name)}`, { response: 'raw' })
    },
    listBranchProtections: (org, repo) =>
      http.get<BranchProtection[]>(`/api/v1/repos/${org}/${repo}/branch_protections`),
    createBranchProtection: (org, repo, body) =>
      http.post<BranchProtection>(`/api/v1/repos/${org}/${repo}/branch_protections`, {
        branch_name: body.rule_name,
        ...body,
      }),
    deleteBranchProtection: async (org, repo, ruleName) => {
      await http.delete(`/api/v1/repos/${org}/${repo}/branch_protections/${enc(ruleName)}`, { response: 'raw' })
    },

    listCollaborators: (org, repo) => paginate<Collaborator>(http, `/api/v1/repos/${org}/${repo}/collaborators`),
    addCollaborator: async (org, repo, user, permission) => {
      await http.put(`/api/v1/repos/${org}/${repo}/collaborators/${enc(user)}`, { permission }, { response: 'raw' })
    },
    removeCollaborator: async (org, repo, user) => {
      await http.delete(`/api/v1/repos/${org}/${repo}/collaborators/${enc(user)}`, { response: 'raw' })
    },
    searchUsers: async (q, limit = 10) => {
      const r = await http.get<{ data: Collaborator[] }>(`/api/v1/users/search?q=${enc(q)}&limit=${limit}`)
      return r.data ?? []
    },

    listReleases: (org, repo) => paginate<Release>(http, `/api/v1/repos/${org}/${repo}/releases`, 4),
    createRelease: (org, repo, body) => http.post<Release>(`/api/v1/repos/${org}/${repo}/releases`, body),
    deleteRelease: async (org, repo, id) => {
      await http.delete(`/api/v1/repos/${org}/${repo}/releases/${id}`, { response: 'raw' })
    },
    listTags: (org, repo) => paginate<Tag>(http, `/api/v1/repos/${org}/${repo}/tags`, 4),
    createTag: (org, repo, body) => http.post<Tag>(`/api/v1/repos/${org}/${repo}/tags`, body),
    deleteTag: async (org, repo, tag) => {
      await http.delete(`/api/v1/repos/${org}/${repo}/tags/${enc(tag)}`, { response: 'raw' })
    },

    listWebhooks: (org, repo) => paginate<Webhook>(http, `/api/v1/repos/${org}/${repo}/hooks`, 2),
    createWebhook: (org, repo, body) => http.post<Webhook>(`/api/v1/repos/${org}/${repo}/hooks`, body),
    updateWebhook: (org, repo, id, body) => http.patch<Webhook>(`/api/v1/repos/${org}/${repo}/hooks/${id}`, body),
    deleteWebhook: async (org, repo, id) => {
      await http.delete(`/api/v1/repos/${org}/${repo}/hooks/${id}`, { response: 'raw' })
    },
    testWebhook: async (org, repo, id) => {
      await http.post(`/api/v1/repos/${org}/${repo}/hooks/${id}/tests`, undefined, { response: 'raw' })
    },

    listLabels: (org, repo) => paginate<Label>(http, `/api/v1/repos/${org}/${repo}/labels`, 2),
  }
}

/* ─────────── stub data ─────────── */

const STUB_REPOS: Repo[] = [
  {
    id: 1,
    name: 'adhar-console',
    full_name: 'adhar/adhar-console',
    description: 'Enterprise console for the Adhar platform',
    private: false,
    default_branch: 'main',
    updated_at: '2026-04-23T14:22:00Z',
    stars_count: 12,
    forks_count: 3,
    open_issues_count: 4,
    size: 14820,
    language: 'TypeScript',
    html_url: 'https://gitea.adhar.local/adhar/adhar-console',
  },
  {
    id: 2,
    name: 'billing-service',
    full_name: 'adhar/billing-service',
    description: 'Subscription + invoicing microservice',
    private: true,
    default_branch: 'main',
    updated_at: '2026-04-22T09:11:00Z',
    stars_count: 2,
    forks_count: 0,
    open_issues_count: 7,
    size: 5240,
    language: 'Go',
    html_url: 'https://gitea.adhar.local/adhar/billing-service',
  },
  {
    id: 3,
    name: 'customer-portal',
    full_name: 'adhar/customer-portal',
    description: 'Next-gen customer self-service portal',
    private: false,
    default_branch: 'develop',
    updated_at: '2026-04-24T06:04:00Z',
    stars_count: 5,
    forks_count: 1,
    open_issues_count: 12,
    size: 8910,
    language: 'TypeScript',
    html_url: 'https://gitea.adhar.local/adhar/customer-portal',
  },
  {
    id: 4,
    name: 'platform-bff',
    full_name: 'adhar/platform-bff',
    description: 'Deno BFF aggregating Gitea, Plane, ArgoCD, Harbor',
    private: true,
    default_branch: 'main',
    updated_at: '2026-04-21T17:42:00Z',
    stars_count: 8,
    forks_count: 1,
    open_issues_count: 3,
    size: 3120,
    language: 'TypeScript',
    html_url: 'https://gitea.adhar.local/adhar/platform-bff',
  },
  {
    id: 5,
    name: 'adhar-ui',
    full_name: 'adhar/adhar-ui',
    description: 'Design system & component catalog',
    private: false,
    default_branch: 'main',
    updated_at: '2026-04-20T11:08:00Z',
    stars_count: 18,
    forks_count: 5,
    open_issues_count: 9,
    size: 6420,
    language: 'TypeScript',
    html_url: 'https://gitea.adhar.local/adhar/adhar-ui',
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
      html_url: 'https://gitea.adhar.local/adhar/adhar-console/pulls/42',
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
      html_url: 'https://gitea.adhar.local/adhar/adhar-console/pulls/43',
    },
  ],
  'billing-service': [
    {
      id: 202,
      number: 15,
      title: 'feat: proration on plan downgrade',
      state: 'closed',
      merged: true,
      merged_at: '2026-04-18T16:20:00Z',
      closed_at: '2026-04-18T16:20:00Z',
      merged_by: { login: 'priya' },
      user: { login: 'maya', avatar_url: 'https://i.pravatar.cc/64?u=maya' },
      head: { ref: 'feat/proration' },
      base: { ref: 'main' },
      labels: [{ id: 2, name: 'enhancement', color: '10b981' }],
      created_at: '2026-04-15T08:00:00Z',
      updated_at: '2026-04-18T16:20:00Z',
      comments: 3,
      additions: 220,
      deletions: 41,
      changed_files: 6,
      html_url: 'https://gitea.adhar.local/adhar/billing-service/pulls/15',
    },
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
      html_url: 'https://gitea.adhar.local/adhar/billing-service/pulls/17',
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
        { id: 1, name: 'bug', color: 'e11d48' },
        { id: 3, name: 'a11y', color: '8b5cf6' },
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
      labels: [{ id: 2, name: 'enhancement', color: '10b981' }],
      comments: 0,
      created_at: '2026-04-22T11:00:00Z',
    },
    {
      id: 5003,
      number: 89,
      title: 'Roadmap "past due" group shows future quarter items by mistake',
      state: 'open',
      user: { login: 'priya', avatar_url: 'https://i.pravatar.cc/64?u=priya' },
      labels: [{ id: 1, name: 'bug', color: 'e11d48' }],
      comments: 4,
      created_at: '2026-04-19T07:42:00Z',
    },
    {
      id: 5004,
      number: 80,
      title: 'Sidebar collapses on narrow tablets',
      state: 'closed',
      user: { login: 'maya', avatar_url: 'https://i.pravatar.cc/64?u=maya' },
      labels: [{ id: 1, name: 'bug', color: 'e11d48' }],
      assignees: [{ login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' }],
      comments: 1,
      created_at: '2026-04-10T07:42:00Z',
      closed_at: '2026-04-12T09:00:00Z',
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
  listCommits: async (_, repo, _ref, _limit, opts) =>
    (opts?.page ?? 1) > 1 ? [] : STUB_COMMITS[repo] ?? STUB_COMMITS['adhar-console'].slice(0, 1),
  listPullRequests: async (_, repo, state = 'open') =>
    (STUB_PRS[repo] ?? []).filter((p) => state === 'all' || p.state === state),
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
  listIssues: async (_, repo, state = 'open') =>
    (STUB_ISSUES[repo] ?? []).filter((i) => state === 'all' || i.state === state),
  searchIssues: ({ owner, type, state, page = 1, limit = PAGE }) => {
    const src: Record<string, Array<Issue | PullRequest>> = type === 'pulls' ? STUB_PRS : STUB_ISSUES
    const all = Object.entries(src).flatMap(([repo, list]) =>
      list
        .filter((x) => state === 'all' || x.state === state)
        .map((x) => ({ ...(x as Issue), labels: x.labels ?? [], repository: { name: repo, owner, full_name: `${owner}/${repo}` } }))
    )
    return Promise.resolve({ items: all.slice((page - 1) * limit, page * limit), total: all.length })
  },
  getIssue: async (_, repo, index) => {
    const i = (STUB_ISSUES[repo] ?? []).find((x) => x.number === index)
    if (!i) throw new Error(`Stub: issue ${index} not found`)
    return i
  },
  createIssue: async (_, repo, body) => {
    const labels = await stubLabels()
    const i: Issue = {
      id: Date.now(),
      number: stubNextIndex(repo),
      title: body.title,
      body: body.body,
      state: 'open',
      user: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      labels: labels.filter((l) => body.labels?.includes(l.id)),
      assignees: (body.assignees ?? []).map((login) => ({ login })),
      comments: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    STUB_ISSUES[repo] = [i, ...(STUB_ISSUES[repo] ?? [])]
    return i
  },
  updateIssue: async (_, repo, index, body) => {
    const i = (STUB_ISSUES[repo] ?? []).find((x) => x.number === index)
    if (!i) throw new Error(`Stub: issue ${index} not found`)
    const { assignees, ...rest } = body
    Object.assign(i, rest, { updated_at: new Date().toISOString() })
    if (assignees) i.assignees = assignees.map((login) => ({ login }))
    if (body.state === 'closed') i.closed_at = new Date().toISOString()
    return i
  },
  setIssueLabels: async (_, repo, index, ids) => {
    const labels = await stubLabels()
    const picked = labels.filter((l) => ids.includes(l.id))
    const i = (STUB_ISSUES[repo] ?? []).find((x) => x.number === index)
    if (i) i.labels = picked
    const p = (STUB_PRS[repo] ?? []).find((x) => x.number === index)
    if (p) p.labels = picked
  },
  listComments: async (_, repo, index) => STUB_COMMENTS[`${repo}#${index}`] ?? [],
  createComment: async (_, repo, index, body) => {
    const c: Comment = {
      id: Date.now(),
      body,
      user: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      created_at: new Date().toISOString(),
    }
    const key = `${repo}#${index}`
    STUB_COMMENTS[key] = [...(STUB_COMMENTS[key] ?? []), c]
    const target = [...(STUB_ISSUES[repo] ?? []), ...(STUB_PRS[repo] ?? [])].find((x) => x.number === index)
    if (target) target.comments = (target.comments ?? 0) + 1
    return c
  },
  deleteComment: async (_, repo, id) => {
    for (const key of Object.keys(STUB_COMMENTS)) {
      if (key.startsWith(`${repo}#`)) STUB_COMMENTS[key] = STUB_COMMENTS[key].filter((c) => c.id !== id)
    }
  },

  createPullRequest: async (org, repo, body) => {
    const labels = await stubLabels()
    const number = stubNextIndex(repo)
    const p: PullRequest = {
      id: Date.now(),
      number,
      title: body.title,
      body: body.body,
      state: 'open',
      user: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      head: { ref: body.head },
      base: { ref: body.base },
      labels: labels.filter((l) => body.labels?.includes(l.id)),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      mergeable: true,
      comments: 0,
      additions: 0,
      deletions: 0,
      changed_files: 0,
      html_url: `https://gitea.adhar.local/${org}/${repo}/pulls/${number}`,
    }
    STUB_PRS[repo] = [p, ...(STUB_PRS[repo] ?? [])]
    return p
  },
  updatePullRequest: async (_, repo, index, body) => {
    const p = (STUB_PRS[repo] ?? []).find((x) => x.number === index)
    if (!p) throw new Error(`Stub: PR ${index} not found`)
    const { assignees: _a, labels: _l, base, ...rest } = body
    Object.assign(p, rest, { updated_at: new Date().toISOString() })
    if (base) p.base = { ref: base }
    if (body.state === 'closed') p.closed_at = new Date().toISOString()
    if (body.state === 'open') p.closed_at = null
    return p
  },
  mergePullRequest: async (_, repo, index) => {
    const p = (STUB_PRS[repo] ?? []).find((x) => x.number === index)
    if (!p) throw new Error(`Stub: PR ${index} not found`)
    if (p.mergeable === false) throw new Error('Merge conflicts — rebase the branch first.')
    const now = new Date().toISOString()
    Object.assign(p, { state: 'closed', merged: true, merged_at: now, closed_at: now, merged_by: { login: 'tapas' } })
  },
  listPullCommits: async (_, repo) => (STUB_COMMITS[repo] ?? []).slice(0, 2),
  listPullReviews: async (_, repo, index) => STUB_REVIEWS[`${repo}#${index}`] ?? [],
  createPullReview: async (_, repo, index, body) => {
    const r: Review = {
      id: Date.now(),
      user: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' },
      state: body.event,
      body: body.body,
      submitted_at: new Date().toISOString(),
    }
    const key = `${repo}#${index}`
    STUB_REVIEWS[key] = [...(STUB_REVIEWS[key] ?? []), r]
    return r
  },

  getCommit: async (org, repo, sha) => {
    const all = Object.values(STUB_COMMITS).flat()
    const c = all.find((x) => x.sha === sha || x.short_sha === sha) ?? all[0]
    return {
      ...c,
      author_name: c.author.login,
      author_email: `${c.author.login}@adhar.local`,
      committer_name: c.author.login,
      parents: [all[all.indexOf(c) + 1]?.sha ?? '0000000000000000'],
      files: [{ filename: 'CHANGELOG.md', status: 'modified' }],
      html_url: `https://gitea.adhar.local/${org}/${repo}/commit/${c.sha}`,
    }
  },
  getCommitDiff: async (_, _repo, sha) =>
    `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,3 +1,4 @@
 # Changelog

+- ${sha.slice(0, 7)}: stub diff (offline / test mode).
 ## 1.0.0
`,
  compare: async (_, repo, base, head) => {
    if (base === head) return { total_commits: 0, commits: [] }
    const list = (STUB_COMMITS[repo] ?? []).slice(0, (head.length + base.length) % 3)
    return { total_commits: list.length, commits: list }
  },
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
  deleteFile: async (_, _repo, _ref, path) => {
    delete STUB_FILES[path]
  },
  getTreeRecursive: (_, _repo, _ref) =>
    Promise.resolve({
      entries: Object.keys(STUB_FILES).map((path) => ({ path, sha: 'stub-' + path.replace(/\W/g, '').slice(0, 16) })),
      truncated: false,
    }),
  changeFiles: (_, _repo, _ref, body) => {
    for (const f of body.files) {
      if (f.operation === 'delete') delete STUB_FILES[f.path]
      else STUB_FILES[f.path] = f.content ?? ''
    }
    return Promise.resolve({ commit: { sha: 'stub-' + Date.now().toString(36) } })
  },

  createRepo: async (org, body) => {
    const r: Repo = {
      id: Date.now(),
      name: body.name,
      full_name: `${org}/${body.name}`,
      description: body.description,
      private: !!body.private,
      default_branch: body.default_branch || 'main',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      stars_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      empty: !body.auto_init,
      template: !!body.template,
      html_url: `https://gitea.adhar.local/${org}/${body.name}`,
    }
    STUB_REPOS.push(r)
    return r
  },
  updateRepo: async (_, repo, body) => {
    const r = STUB_REPOS.find((x) => x.name === repo)
    if (!r) throw new Error(`Stub: repo ${repo} not found`)
    Object.assign(r, body, { updated_at: new Date().toISOString() })
    return r
  },
  deleteRepo: async (_, repo) => {
    const i = STUB_REPOS.findIndex((x) => x.name === repo)
    if (i >= 0) STUB_REPOS.splice(i, 1)
  },
  forkRepo: async (org, repo, targetOrg, name) => {
    const src = STUB_REPOS.find((x) => x.name === repo)
    if (!src) throw new Error(`Stub: repo ${repo} not found`)
    return { ...src, id: Date.now(), name: name ?? src.name, full_name: `${targetOrg}/${name ?? src.name}`, fork: true, parent: { full_name: `${org}/${repo}` } }
  },
  listLanguages: async (_, repo) => {
    const r = STUB_REPOS.find((x) => x.name === repo)
    return r?.language ? { [r.language]: 100_000, Shell: 4_000 } : {}
  },
  listTopics: async (_, repo) => STUB_TOPICS[repo] ?? [],
  setTopics: async (_, repo, topics) => {
    STUB_TOPICS[repo] = topics
  },

  createBranch: async (_, repo, name, from) => {
    const base = (STUB_BRANCHES[repo] ?? []).find((b) => b.name === from) ?? STUB_BRANCHES['adhar-console'][0]
    const b: Branch = { name, commit: base.commit }
    STUB_BRANCHES[repo] = [...(STUB_BRANCHES[repo] ?? []), b]
    return b
  },
  deleteBranch: async (_, repo, name) => {
    STUB_BRANCHES[repo] = (STUB_BRANCHES[repo] ?? []).filter((b) => b.name !== name)
  },
  listBranchProtections: async (_, repo) => STUB_PROTECTIONS[repo] ?? [],
  createBranchProtection: async (_, repo, body) => {
    const p: BranchProtection = { ...body, branch_name: body.rule_name, created_at: new Date().toISOString() }
    STUB_PROTECTIONS[repo] = [...(STUB_PROTECTIONS[repo] ?? []), p]
    return p
  },
  deleteBranchProtection: async (_, repo, ruleName) => {
    STUB_PROTECTIONS[repo] = (STUB_PROTECTIONS[repo] ?? []).filter((p) => p.rule_name !== ruleName)
  },

  listCollaborators: async (_, repo) => STUB_COLLABORATORS[repo] ?? [],
  addCollaborator: async (_, repo, user) => {
    const list = STUB_COLLABORATORS[repo] ?? []
    if (!list.some((c) => c.login === user)) {
      STUB_COLLABORATORS[repo] = [...list, { id: Date.now(), login: user, avatar_url: `https://i.pravatar.cc/64?u=${user}` }]
    }
  },
  removeCollaborator: async (_, repo, user) => {
    STUB_COLLABORATORS[repo] = (STUB_COLLABORATORS[repo] ?? []).filter((c) => c.login !== user)
  },
  searchUsers: async (q) =>
    ['tapas', 'maya', 'priya', 'release-bot']
      .filter((u) => u.includes(q.toLowerCase()))
      .map((u, i) => ({ id: i + 1, login: u, avatar_url: `https://i.pravatar.cc/64?u=${u}` })),

  listReleases: async (_, repo) => STUB_RELEASES[repo] ?? [],
  createRelease: async (_, repo, body) => {
    const r: Release = { id: Date.now(), ...body, created_at: new Date().toISOString(), published_at: new Date().toISOString(), author: { login: 'tapas' } }
    STUB_RELEASES[repo] = [r, ...(STUB_RELEASES[repo] ?? [])]
    return r
  },
  deleteRelease: async (_, repo, id) => {
    STUB_RELEASES[repo] = (STUB_RELEASES[repo] ?? []).filter((r) => r.id !== id)
  },
  listTags: async (_, repo) => STUB_TAGS[repo] ?? [],
  createTag: async (_, repo, body) => {
    const t: Tag = { name: body.tag_name, message: body.message, commit: { sha: 'a1b2c3d4e5f60718', created: new Date().toISOString() } }
    STUB_TAGS[repo] = [t, ...(STUB_TAGS[repo] ?? [])]
    return t
  },
  deleteTag: async (_, repo, tag) => {
    STUB_TAGS[repo] = (STUB_TAGS[repo] ?? []).filter((t) => t.name !== tag)
  },

  listWebhooks: async (_, repo) => STUB_HOOKS[repo] ?? [],
  createWebhook: async (_, repo, body) => {
    const h: Webhook = { id: Date.now(), type: body.type, active: body.active, events: body.events, config: { url: body.config.url, content_type: body.config.content_type }, created_at: new Date().toISOString() }
    STUB_HOOKS[repo] = [...(STUB_HOOKS[repo] ?? []), h]
    return h
  },
  updateWebhook: async (_, repo, id, body) => {
    const h = (STUB_HOOKS[repo] ?? []).find((x) => x.id === id)
    if (!h) throw new Error(`Stub: hook ${id} not found`)
    if (body.active !== undefined) h.active = body.active
    if (body.events) h.events = body.events
    return h
  },
  deleteWebhook: async (_, repo, id) => {
    STUB_HOOKS[repo] = (STUB_HOOKS[repo] ?? []).filter((h) => h.id !== id)
  },
  testWebhook: async () => {},

  listLabels: () => stubLabels(),
}))

// deno-lint-ignore require-await
async function stubLabels(): Promise<Label[]> {
  return [
    { id: 1, name: 'bug', color: 'e11d48' },
    { id: 2, name: 'enhancement', color: '10b981' },
    { id: 3, name: 'a11y', color: '8b5cf6' },
  ]
}

/** Issues and PRs share one index sequence per repo, as in Gitea. */
function stubNextIndex(repo: string): number {
  const used = [...(STUB_ISSUES[repo] ?? []), ...(STUB_PRS[repo] ?? [])].map((x) => x.number)
  return (used.length ? Math.max(...used) : 0) + 1
}

const STUB_COMMENTS: Record<string, Comment[]> = {
  'adhar-console#42': [
    { id: 7001, body: 'Can we keep the discovery URL configurable per tenant?', user: { login: 'maya', avatar_url: 'https://i.pravatar.cc/64?u=maya' }, created_at: '2026-04-22T12:30:00Z' },
    { id: 7002, body: 'Yes — it reads `OIDC_ISSUER` now. Pushed in the last commit.', user: { login: 'tapas', avatar_url: 'https://i.pravatar.cc/64?u=tapas' }, created_at: '2026-04-23T09:02:00Z' },
  ],
  'adhar-console#87': [
    { id: 7003, body: 'Reproduced on Chrome and Safari with the dark theme.', user: { login: 'priya', avatar_url: 'https://i.pravatar.cc/64?u=priya' }, created_at: '2026-04-21T16:10:00Z' },
  ],
}
const STUB_REVIEWS: Record<string, Review[]> = {
  'adhar-console#42': [
    { id: 8001, user: { login: 'maya', avatar_url: 'https://i.pravatar.cc/64?u=maya' }, state: 'APPROVED', body: 'LGTM once CI is green.', submitted_at: '2026-04-23T10:00:00Z' },
  ],
}

const STUB_TOPICS: Record<string, string[]> = {
  'adhar-console': ['platform', 'react', 'deno', 'module-federation'],
  'billing-service': ['go', 'payments'],
  'adhar-ui': ['design-system', 'react'],
}
const STUB_PROTECTIONS: Record<string, BranchProtection[]> = {
  'adhar-console': [{ rule_name: 'main', branch_name: 'main', enable_push: false, required_approvals: 1, block_on_rejected_reviews: true, created_at: '2026-04-01T00:00:00Z' }],
}
const STUB_COLLABORATORS: Record<string, Collaborator[]> = {
  'adhar-console': [
    { id: 2, login: 'maya', full_name: 'Maya R', avatar_url: 'https://i.pravatar.cc/64?u=maya' },
    { id: 3, login: 'priya', full_name: 'Priya S', avatar_url: 'https://i.pravatar.cc/64?u=priya' },
  ],
}
const STUB_RELEASES: Record<string, Release[]> = {
  'adhar-console': [
    { id: 9001, tag_name: 'v0.1.57', target_commitish: 'main', name: 'v0.1.57', body: 'Cluster reachability + overview default layout.', created_at: '2026-09-02T10:00:00Z', published_at: '2026-09-02T10:00:00Z', author: { login: 'tapas' } },
    { id: 9000, tag_name: 'v0.1.56', target_commitish: 'main', name: 'v0.1.56', body: 'Impersonation headers fix.', created_at: '2026-08-30T10:00:00Z', published_at: '2026-08-30T10:00:00Z', author: { login: 'tapas' } },
  ],
}
const STUB_TAGS: Record<string, Tag[]> = {
  'adhar-console': [
    { name: 'v0.1.57', commit: { sha: 'a1b2c3d4e5f60718', created: '2026-09-02T10:00:00Z' } },
    { name: 'v0.1.56', commit: { sha: 'b2c3d4e5f6a17182', created: '2026-08-30T10:00:00Z' } },
  ],
}
const STUB_HOOKS: Record<string, Webhook[]> = {
  'adhar-console': [
    { id: 11, type: 'gitea', active: true, events: ['push', 'pull_request'], config: { url: 'https://tekton.adhar.local/hooks/adhar-console', content_type: 'json' }, created_at: '2026-04-10T00:00:00Z' },
  ],
}
