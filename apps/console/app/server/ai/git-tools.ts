import { env } from '@adhar-console/utils'
import { giteaConn, giteaFetcher } from '../gitea-auth.ts'
import type { ToolDef } from './provider.ts'

/**
 * Source-code tools — what the Review and Design agents actually read.
 *
 * Without these a "review agent" can only describe what a review is. These
 * give it the pull requests, the diff, the changed files and the file contents
 * from Gitea, so its findings cite real lines in real files.
 *
 * ---------------------------------------------------------------------------
 * SCOPE, AND WHY IT IS NARROWER THAN IT LOOKS
 * ---------------------------------------------------------------------------
 * Gitea is reached with the console's own service credentials, not the
 * signed-in user's — that is how the console has always read Gitea (Develop →
 * Repositories goes through the same credentials via `/api/svc/gitea`), so
 * these tools grant the agent nothing a user could not already see in the UI.
 *
 * To keep that true rather than merely traditional, every tool here is pinned
 * to the install's configured organisation. A repo outside it cannot be named
 * into scope by the model, however the prompt is worded. The cluster tools
 * keep their stronger property — those still run as the signed-in user.
 *
 * ---------------------------------------------------------------------------
 * SIZE
 * ---------------------------------------------------------------------------
 * A diff is the one tool result that can be arbitrarily large, and a 40k-line
 * refactor would silently eat the model's context and push the actual question
 * out of the window. Everything here is bounded, and truncation is ANNOUNCED
 * in the payload so the model reports "I reviewed the first N lines" instead of
 * confidently reviewing a fragment it believes is the whole change.
 */

/** The organisation every tool in this file is pinned to. */
export function giteaOrg(): string {
  return env('GITEA_ORG') ?? env('GITEA_TEMPLATES_ORG') ?? 'adhar'
}

/** Diff bytes handed to the model in one call. ~80–100k tokens of context is
 *  the practical ceiling; this leaves room for the conversation around it. */
const MAX_DIFF_BYTES = 60_000
const MAX_FILE_BYTES = 40_000

export const GIT_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'git_list_repos',
      description:
        'List repositories in the platform organisation. Use first when the user names a project rather than a repo.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Optional substring filter on the repo name' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_list_prs',
      description: 'List pull requests for a repository, newest first.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository name (without the org prefix)' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: "Defaults to 'open'" },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_pr',
      description:
        'Get one pull request: title, description, author, branches, mergeability and review state. Read this before the diff.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          index: { type: 'number', description: 'Pull request number' },
        },
        required: ['repo', 'index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_pr_files',
      description:
        'List the files a pull request changes, with per-file added/removed line counts. Use this to decide which files are worth reading in full before pulling the whole diff.',
      parameters: {
        type: 'object',
        properties: { repo: { type: 'string' }, index: { type: 'number' } },
        required: ['repo', 'index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_pr_diff',
      description:
        'Read the unified diff of a pull request. Large diffs are truncated — the result says so explicitly; when it does, review the named files individually with git_file instead of assuming you saw everything.',
      parameters: {
        type: 'object',
        properties: { repo: { type: 'string' }, index: { type: 'number' } },
        required: ['repo', 'index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_file',
      description:
        'Read a file from a repository at a branch, tag or commit. Use it to see the code AROUND a diff hunk before judging it.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          path: { type: 'string', description: 'Path within the repository' },
          ref: { type: 'string', description: 'Branch, tag or commit SHA. Defaults to the default branch.' },
        },
        required: ['repo', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commits',
      description: 'Recent commits on a branch, with author, date and message.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          ref: { type: 'string', description: 'Branch or tag. Defaults to the default branch.' },
          limit: { type: 'number', description: 'Max commits (default 20, cap 50)' },
        },
        required: ['repo'],
      },
    },
  },
]

export const GIT_TOOL_NAMES: string[] = GIT_TOOL_DEFS.map((d) => d.function.name)

/* ─────────────────────────── execution ─────────────────────────── */

interface GiteaPull {
  number?: number
  title?: string
  body?: string
  state?: string
  draft?: boolean
  mergeable?: boolean
  merged?: boolean
  user?: { login?: string }
  head?: { label?: string; ref?: string; sha?: string }
  base?: { label?: string; ref?: string }
  created_at?: string
  updated_at?: string
  additions?: number
  deletions?: number
  changed_files?: number
  requested_reviewers?: Array<{ login?: string }>
  labels?: Array<{ name?: string }>
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean; originalLines: number } {
  const originalLines = text.split('\n').length
  if (new TextEncoder().encode(text).length <= maxBytes) {
    return { text, truncated: false, originalLines }
  }
  // Cut on a line boundary so the model never sees half a hunk header.
  const slice = text.slice(0, maxBytes)
  const cut = slice.lastIndexOf('\n')
  return { text: slice.slice(0, cut > 0 ? cut : slice.length), truncated: true, originalLines }
}

/**
 * Run one source tool. Returns a JSON string, never throws.
 *
 * Returns null when `name` is not one of ours, so the caller can fall through
 * to the Kubernetes tools without a second dispatch table.
 */
export async function executeGitTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (!GIT_TOOL_NAMES.includes(name)) return null

  const conn = giteaConn()
  if (!conn) {
    return JSON.stringify({
      error: 'Gitea is not configured on this install, so source code is unavailable.',
    })
  }
  const api = giteaFetcher(conn)
  const org = giteaOrg()
  // The org is fixed; only the repo name comes from the model, and a name that
  // tries to escape it (`../other-org/repo`) is refused rather than encoded.
  const repoName = String(args.repo ?? '')
  if (name !== 'git_list_repos' && !/^[A-Za-z0-9._-]+$/.test(repoName)) {
    return JSON.stringify({ error: `invalid repository name: ${repoName}` })
  }
  const repo = `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repoName)}`

  const fail = async (res: Response, what: string) =>
    JSON.stringify({ error: `${what} failed (HTTP ${res.status})`, hint: res.status === 404 ? 'Check the repository name with git_list_repos.' : undefined })

  switch (name) {
    case 'git_list_repos': {
      const res = await api(`/orgs/${encodeURIComponent(org)}/repos?limit=100`)
      if (!res.ok) return await fail(res, `list repos in ${org}`)
      const body = (await res.json()) as Array<{ name?: string; description?: string; default_branch?: string; updated_at?: string; archived?: boolean }>
      const q = String(args.query ?? '').toLowerCase()
      const repos = body
        .filter((r) => !q || (r.name ?? '').toLowerCase().includes(q))
        .map((r) => ({ name: r.name, description: r.description, defaultBranch: r.default_branch, updatedAt: r.updated_at, archived: r.archived }))
      return JSON.stringify({ org, count: repos.length, repos })
    }

    case 'git_list_prs': {
      const state = ['open', 'closed', 'all'].includes(String(args.state)) ? String(args.state) : 'open'
      const res = await api(`${repo}/pulls?state=${state}&limit=50&sort=recentupdate`)
      if (!res.ok) return await fail(res, `list pull requests for ${repoName}`)
      const body = (await res.json()) as GiteaPull[]
      return JSON.stringify({
        repo: repoName,
        state,
        count: body.length,
        pulls: body.map((p) => ({
          index: p.number,
          title: p.title,
          author: p.user?.login,
          state: p.state,
          draft: p.draft,
          from: p.head?.ref,
          into: p.base?.ref,
          updatedAt: p.updated_at,
          labels: (p.labels ?? []).map((l) => l.name),
        })),
      })
    }

    case 'git_pr': {
      const res = await api(`${repo}/pulls/${Number(args.index)}`)
      if (!res.ok) return await fail(res, `get pull request ${args.index}`)
      const p = (await res.json()) as GiteaPull
      return JSON.stringify({
        repo: repoName,
        index: p.number,
        title: p.title,
        description: p.body,
        author: p.user?.login,
        state: p.state,
        draft: p.draft,
        merged: p.merged,
        // Gitea reports mergeable as null while it is still computing; saying
        // "not mergeable" then would be wrong.
        mergeable: p.mergeable ?? 'unknown',
        from: p.head?.ref,
        into: p.base?.ref,
        headSha: p.head?.sha,
        additions: p.additions,
        deletions: p.deletions,
        changedFiles: p.changed_files,
        reviewers: (p.requested_reviewers ?? []).map((r) => r.login),
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })
    }

    case 'git_pr_files': {
      const res = await api(`${repo}/pulls/${Number(args.index)}/files?limit=200`)
      if (!res.ok) return await fail(res, `list files for pull request ${args.index}`)
      const body = (await res.json()) as Array<{ filename?: string; status?: string; additions?: number; deletions?: number }>
      return JSON.stringify({
        repo: repoName,
        index: Number(args.index),
        count: body.length,
        files: body.map((f) => ({ path: f.filename, status: f.status, added: f.additions, removed: f.deletions })),
      })
    }

    case 'git_pr_diff': {
      const res = await api(`${repo}/pulls/${Number(args.index)}.diff`)
      if (!res.ok) return await fail(res, `get diff for pull request ${args.index}`)
      const raw = await res.text()
      const { text, truncated, originalLines } = truncate(raw, MAX_DIFF_BYTES)
      return JSON.stringify({
        repo: repoName,
        index: Number(args.index),
        truncated,
        ...(truncated
          ? {
            warning:
              `This diff was truncated: you are seeing roughly the first ${text.split('\n').length} of ${originalLines} lines. ` +
              `Do NOT describe this as a complete review. Use git_pr_files to see every changed file and git_file to read the ones you have not seen.`,
          }
          : {}),
        diff: text,
      })
    }

    case 'git_file': {
      const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : ''
      const path = String(args.path ?? '').replace(/^\/+/, '')
      const res = await api(`${repo}/raw/${path.split('/').map(encodeURIComponent).join('/')}${ref}`)
      if (!res.ok) return await fail(res, `read ${path}`)
      const raw = await res.text()
      const { text, truncated, originalLines } = truncate(raw, MAX_FILE_BYTES)
      return JSON.stringify({
        repo: repoName,
        path,
        ref: args.ref ?? '(default branch)',
        truncated,
        ...(truncated ? { warning: `Truncated — showing the first part of ${originalLines} lines.` } : {}),
        content: text,
      })
    }

    case 'git_commits': {
      const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 50)
      const ref = args.ref ? `&sha=${encodeURIComponent(String(args.ref))}` : ''
      const res = await api(`${repo}/commits?limit=${limit}${ref}`)
      if (!res.ok) return await fail(res, `list commits for ${repoName}`)
      const body = (await res.json()) as Array<{ sha?: string; commit?: { message?: string; author?: { name?: string; date?: string } } }>
      return JSON.stringify({
        repo: repoName,
        count: body.length,
        commits: body.map((c) => ({
          sha: c.sha?.slice(0, 8),
          author: c.commit?.author?.name,
          date: c.commit?.author?.date,
          // First line only: full messages turn a 50-commit list into a wall.
          message: (c.commit?.message ?? '').split('\n')[0],
        })),
      })
    }

    default:
      return JSON.stringify({ error: `unknown source tool ${name}` })
  }
}
