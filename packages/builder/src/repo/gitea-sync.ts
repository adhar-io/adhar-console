import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { gitea } from '@adhar/api-clients'
import { useGiteaOrg } from '@adhar/shell-ui'
import { BUILDER_MANIFEST, type BuilderProject, type GeneratedFile } from '../types.ts'
import { normalizeProject } from '../lib/project.ts'
import { b64, joinPath, unb64 } from './encoding.ts'

/**
 * Visual Designer ⇄ Gitea.
 *
 * "Commit to repo" writes the generated project — a runnable React + Tailwind
 * app, diagrams, workflows with their Argo YAML, and `.adhar/builder.json` — as ONE
 * commit through Gitea's multi-file contents API, via the console's
 * `/api/svc/gitea` proxy. "Open from repo" reads the manifest back.
 *
 * Query keys match Develop's git hooks (`['gitea', part, org, repo]`) so a
 * commit made here refreshes Develop's repository views too.
 */

const client = gitea.GiteaClient.auto({ tool: 'gitea' })
const STALE = 30_000

export function useBuilderRepos() {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'repos', org],
    queryFn: () => client.listRepos(org),
    staleTime: STALE,
  })
}

export function useBuilderBranches(repo?: string) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'branches', org, repo],
    queryFn: () => client.listBranches(org, repo!),
    enabled: !!repo,
    staleTime: STALE,
  })
}

async function shaOf(org: string, repo: string, ref: string, path: string): Promise<string | undefined> {
  try {
    return (await client.getFile(org, repo, ref, path)).sha
  } catch {
    return undefined
  }
}

export interface CommitInput {
  repo: string
  branch: string
  message: string
  files: GeneratedFile[]
}

export function useCommitBuilderFiles() {
  const org = useGiteaOrg()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ repo, branch, message, files }: CommitInput) => {
      if (!files.length) throw new Error('Nothing to commit.')
      const shas = await Promise.all(files.map((f) => shaOf(org, repo, branch, f.path)))
      const res = await client.changeFiles(org, repo, branch, {
        message,
        files: files.map((f, i) => ({
          operation: shas[i] ? 'update' as const : 'create' as const,
          path: f.path,
          content: b64(f.content),
          ...(shas[i] ? { sha: shas[i] } : {}),
        })),
      })
      return { sha: res.commit?.sha, created: shas.filter((s) => !s).length, updated: shas.filter(Boolean).length }
    },
    onSuccess: (_d, v) => {
      for (const part of ['commits', 'tree', 'file']) qc.invalidateQueries({ queryKey: ['gitea', part, org, v.repo] })
    },
  })
}

export function useOpenBuilderProject() {
  const org = useGiteaOrg()
  return useMutation({
    mutationFn: async ({ repo, branch, folder }: { repo: string; branch: string; folder: string }): Promise<BuilderProject> => {
      const path = joinPath(folder, BUILDER_MANIFEST)
      let file
      try {
        file = await client.getFile(org, repo, branch, path)
      } catch {
        throw new Error(`No builder project at ${repo}@${branch}:/${path}`)
      }
      const text = file.encoding === 'base64' ? unb64(file.content) : file.content
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`${path} is not valid JSON.`)
      }
      const project = normalizeProject(parsed, repo)
      if (!project) throw new Error(`${path} is not a builder project.`)
      return project
    },
  })
}
