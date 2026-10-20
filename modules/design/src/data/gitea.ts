import { useCallback } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { gitea } from '@adhar/api-clients'
import { toPublicUrl, useGiteaOrg, usePublicBaseDomain, useToolPublicUrl } from '@adhar/shell-ui'

/**
 * Minimal Gitea access for the Design module — list repos/branches, read a
 * file, and commit a set of files as ONE commit through Gitea's multi-file
 * contents API. Everything goes through the console's `/api/svc/gitea` proxy
 * (the client's `auto` factory), so the browser never talks to Gitea directly
 * and the user's session decides what they can read and write.
 */

export { gitBlobSha, prBranchName } from './gitea-pure.ts'
import { gitBlobSha } from './gitea-pure.ts'

export const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

const STALE = 30_000

/** UTF-8 safe base64 (ADRs and specs contain non-ASCII). */
export function b64(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

/** Decode Gitea's base64 file content back to text. */
export function unb64(s: string): string {
  const bin = atob(s.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/** Join a folder and a file name without doubled or leading slashes. */
export function joinPath(base: string, path: string): string {
  const b = base.replace(/^\/+|\/+$/g, '')
  const p = path.replace(/^\/+/, '')
  return b ? `${b}/${p}` : p
}

export function useGiteaRepos(enabled = true) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'repos', org],
    queryFn: () => giteaClient.listRepos(org),
    enabled,
    staleTime: STALE,
  })
}

export function useGiteaBranches(repo?: string) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'branches', org, repo],
    queryFn: () => giteaClient.listBranches(org, repo!),
    enabled: !!repo,
    staleTime: STALE,
  })
}

export function useGiteaTree(repo?: string, ref?: string, path = '') {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'tree', org, repo, ref, path],
    queryFn: () => giteaClient.listTree(org, repo!, ref!, path),
    enabled: !!repo && !!ref,
    staleTime: STALE,
    retry: false,
  })
}

/** Public (browser-usable) URL of a file in the configured Gitea org. */
export function useGiteaFileUrl(): (repo: string, branch: string, path: string) => string | undefined {
  const org = useGiteaOrg()
  const toolUrl = useToolPublicUrl('gitea')
  const baseDomain = usePublicBaseDomain()
  return useCallback(
    (repo, branch, path) => {
      if (!toolUrl) return undefined
      const raw = `${toolUrl}/${org}/${repo}/src/branch/${encodeURIComponent(branch)}/${path}`
      return toPublicUrl(raw, { toolUrl, tool: 'gitea', baseDomain })
    },
    [org, toolUrl, baseDomain],
  )
}

/** Read one text file from a repo. */
export function useReadGiteaFile() {
  const org = useGiteaOrg()
  return useMutation({
    mutationFn: async ({ repo, ref, path }: { repo: string; ref: string; path: string }) => {
      const f = await giteaClient.getFile(org, repo, ref, path)
      return f.encoding === 'base64' ? unb64(f.content) : f.content
    },
  })
}

export interface CommitFile {
  path: string
  content: string
}

export interface CommitResult {
  sha?: string
  created: number
  updated: number
  /** Blob sha per committed path. */
  blobs: Record<string, string>
  /** Set when the change was opened as a pull request. */
  pr?: { number: number; branch: string; url?: string }
}

/**
 * Commit files (create or update) in one commit. With `pr`, the commit lands
 * on a new branch cut from `branch` and a pull request into `branch` is
 * opened — the reviewable path the console prefers for docs and specs.
 */
export function useCommitFiles() {
  const org = useGiteaOrg()
  return useMutation({
    mutationFn: async (
      { repo, branch, message, files, pr }: {
        repo: string
        branch: string
        message: string
        files: CommitFile[]
        pr?: { branch: string; title: string; body?: string }
      },
    ): Promise<CommitResult> => {
      if (!files.length) throw new Error('Nothing to commit.')
      const shas = await Promise.all(
        files.map(async (f) => {
          try {
            return (await giteaClient.getFile(org, repo, branch, f.path)).sha
          } catch {
            return undefined
          }
        }),
      )
      const res = await giteaClient.changeFiles(org, repo, branch, {
        message,
        files: files.map((f, i) => ({
          operation: shas[i] ? ('update' as const) : ('create' as const),
          path: f.path,
          content: b64(f.content),
          ...(shas[i] ? { sha: shas[i] } : {}),
        })),
        ...(pr ? { new_branch: pr.branch } : {}),
      })
      const blobs: Record<string, string> = {}
      for (const f of files) blobs[f.path] = await gitBlobSha(f.content)
      let opened: CommitResult['pr']
      if (pr) {
        const created = await giteaClient.createPullRequest(org, repo, { head: pr.branch, base: branch, title: pr.title, body: pr.body })
        opened = { number: created.number, branch: pr.branch, url: created.html_url }
      }
      return {
        sha: res.commit?.sha,
        created: shas.filter((s) => !s).length,
        updated: shas.filter(Boolean).length,
        blobs,
        pr: opened,
      }
    },
  })
}
