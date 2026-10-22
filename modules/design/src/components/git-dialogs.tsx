import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, useToast } from '@adhar/shell-ui'
import { useRouter } from '@tanstack/react-router'
import { prHref } from '../data/platform.ts'
import {
  type CommitFile,
  type CommitResult,
  joinPath,
  prBranchName,
  useCommitFiles,
  useGiteaBranches,
  useGiteaFileUrl,
  useGiteaRepos,
  useGiteaTree,
  useReadGiteaFile,
} from '../data/gitea.ts'

/**
 * Gitea dialogs shared by the Design editors: commit generated files to a
 * repo folder, and pick a file from a repo to import. Both go through the
 * console's `/api/svc/gitea` proxy.
 */

export interface GitTarget {
  repo: string
  branch: string
  folder: string
}

const INPUT =
  'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
      {children}
    </span>
  )
}

export function RepoBranchFields({
  repo,
  setRepo,
  branch,
  setBranch,
  open,
}: {
  repo: string
  setRepo(v: string): void
  branch: string
  setBranch(v: string): void
  open: boolean
}) {
  const repos = useGiteaRepos(open)
  const branches = useGiteaBranches(repo || undefined)
  const sorted = useMemo(
    () => [...(repos.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [repos.data],
  )

  // Default the branch to the repo's default branch once known.
  useEffect(() => {
    if (!repo) return
    const r = sorted.find((x) => x.name === repo)
    const names = (branches.data ?? []).map((b) => b.name)
    if (!branch || (names.length && !names.includes(branch))) {
      const def = r?.default_branch ?? names[0]
      if (def) setBranch(def)
    }
  }, [repo, sorted, branches.data, branch, setBranch])

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="block">
        <Label>Repository</Label>
        <select
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value)
            setBranch('')
          }}
          className={`mt-1.5 ${INPUT}`}
          disabled={repos.isLoading}
        >
          <option value="">{repos.isLoading ? 'Loading repositories…' : 'Choose a repository'}</option>
          {sorted.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        {repos.error ? (
          <span className="mt-1 block text-[11px] text-rose-600 dark:text-rose-400">
            Could not list repositories: {repos.error.message}
          </span>
        ) : null}
      </label>
      <label className="block">
        <Label>Branch</Label>
        <select
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className={`mt-1.5 ${INPUT}`}
          disabled={!repo || branches.isLoading}
        >
          {!branch ? <option value="">{branches.isLoading ? 'Loading…' : '—'}</option> : null}
          {(branches.data ?? []).map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

export interface CommittedTarget extends GitTarget {
  sha?: string
  paths: string[]
  /** Blob sha per committed path. */
  blobs: Record<string, string>
  pr?: CommitResult['pr']
}

/**
 * Commit generated files into `<folder>/` of a Gitea repository — by default
 * as a pull request (a new `design/…` branch cut from the chosen branch), or
 * straight onto the branch.
 */
export function CommitToRepoModal({
  open,
  onClose,
  title,
  description,
  initial,
  defaultFolder,
  defaultMessage,
  buildFiles,
  onCommitted,
  prBody,
  defaultMode = 'pr',
  fixedFolder,
}: {
  open: boolean
  onClose(): void
  title: string
  description?: string
  initial?: Partial<GitTarget>
  defaultFolder: string
  defaultMessage: string
  /** Files relative to the chosen folder (may be async — e.g. rendered SVG). */
  buildFiles(): CommitFile[] | Promise<CommitFile[]>
  onCommitted?(target: CommittedTarget): void
  /** Pull request description. */
  prBody?: string
  defaultMode?: 'pr' | 'direct'
  /** Lock the folder (files carry full paths). */
  fixedFolder?: boolean
}) {
  const toast = useToast()
  const router = useRouter({ warn: false })
  const commit = useCommitFiles()
  const fileUrl = useGiteaFileUrl()
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [folder, setFolder] = useState(defaultFolder)
  const [message, setMessage] = useState(defaultMessage)
  const [mode, setMode] = useState<'pr' | 'direct'>(defaultMode)
  const [headBranch, setHeadBranch] = useState('')
  const [files, setFiles] = useState<CommitFile[]>([])
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRepo(initial?.repo ?? '')
    setBranch(initial?.branch ?? '')
    setFolder(initial?.folder ?? defaultFolder)
    setMessage(defaultMessage)
    setMode(defaultMode)
    setHeadBranch(prBranchName(defaultMessage.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '')))
    let alive = true
    setBuilding(true)
    setBuildError(null)
    Promise.resolve()
      .then(() => buildFiles())
      .then((f) => alive && setFiles(f))
      .catch((e: Error) => alive && setBuildError(e.message))
      .finally(() => alive && setBuilding(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const paths = files.map((f) => (fixedFolder ? f.path : joinPath(folder, f.path)))
  const isPr = mode === 'pr'

  const submit = () => {
    if (!repo || !branch || !files.length) return
    const msg = message.trim() || defaultMessage
    commit.mutate(
      {
        repo,
        branch,
        message: msg,
        files: files.map((f, i) => ({ path: paths[i], content: f.content })),
        pr: isPr ? { branch: headBranch.trim() || prBranchName('design'), title: msg.split('\n')[0], body: prBody } : undefined,
      },
      {
        onSuccess: (res) => {
          if (res.pr) {
            const pr = res.pr
            toast.success(`Pull request #${pr.number} opened`, {
              description: `${repo}: ${pr.branch} → ${branch}`,
              action: {
                label: 'View pull request',
                onClick: () => {
                  const href = prHref(repo, pr.number)
                  if (router) void router.navigate({ to: '/develop', search: { section: 'prs', pr: `${repo}/${pr.number}` } as never })
                  else location.assign(href)
                },
              },
              duration: 10_000,
            })
          } else {
            const url = fileUrl(repo, branch, paths[0])
            toast.success(`Committed to ${repo}@${branch}`, {
              description: `${res.created} created, ${res.updated} updated${res.sha ? ` · ${res.sha.slice(0, 7)}` : ''}`,
              action: url ? { label: 'Open in Gitea', onClick: () => globalThis.open(url, '_blank', 'noopener') } : undefined,
            })
          }
          onCommitted?.({ repo, branch, folder, sha: res.sha, paths, blobs: res.blobs, pr: res.pr })
          onClose()
        },
        onError: (e) => toast.error(isPr ? 'Could not open the pull request' : 'Commit failed', { description: e.message }),
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={submit}
            loading={commit.isPending}
            disabled={!repo || !branch || !files.length || commit.isPending || building || (isPr && !headBranch.trim())}
          >
            {isPr ? 'Open pull request' : `Commit ${files.length > 1 ? `${files.length} files` : 'file'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RepoBranchFields repo={repo} setRepo={setRepo} branch={branch} setBranch={setBranch} open={open} />
        <div className="inline-flex rounded-lg border border-edge-default p-0.5" role="radiogroup" aria-label="How to write the change">
          {([['pr', 'Pull request'], ['direct', 'Commit to branch']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              onClick={() => setMode(id)}
              className={`rounded-md px-2.5 py-1 text-[12px] ${mode === id ? 'bg-surface-sunken font-semibold text-content' : 'text-content-muted hover:text-content'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {isPr
          ? (
            <label className="block">
              <Label>New branch</Label>
              <input value={headBranch} onChange={(e) => setHeadBranch(e.target.value)} className={`mt-1.5 font-mono ${INPUT}`} />
              <span className="mt-1 block text-[11px] text-content-subtle">Cut from {branch || 'the selected branch'}; the pull request merges back into it.</span>
            </label>
          )
          : null}
        {fixedFolder ? null : (
          <label className="block">
            <Label>Folder</Label>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} className={`mt-1.5 font-mono ${INPUT}`} />
          </label>
        )}
        <label className="block">
          <Label>{isPr ? 'Title / commit message' : 'Commit message'}</Label>
          <input value={message} onChange={(e) => setMessage(e.target.value)} className={`mt-1.5 ${INPUT}`} />
        </label>
        <div>
          <Label>Files</Label>
          <ul className="mt-1.5 max-h-40 overflow-auto rounded-lg border border-edge-default bg-surface-sunken/60 p-2 font-mono text-[11px] text-content-muted">
            {building ? <li className="py-0.5">Preparing files…</li> : null}
            {buildError ? <li className="py-0.5 text-rose-600 dark:text-rose-400">{buildError}</li> : null}
            {paths.map((p) => (
              <li key={p} className="truncate py-0.5">
                {p}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-content-subtle">
            Existing files are updated in place; new ones are created. All changes land in a single commit.
          </p>
        </div>
      </div>
    </Modal>
  )
}

/** Browse a repo and pick a file to import; resolves with its text. */
export function ImportFromRepoModal({
  open,
  onClose,
  title,
  accept,
  onImport,
}: {
  open: boolean
  onClose(): void
  title: string
  /** File-name filter, e.g. /\.(ya?ml|json)$/i */
  accept?: RegExp
  onImport(file: { repo: string; branch: string; path: string; text: string }): void
}) {
  const toast = useToast()
  const read = useReadGiteaFile()
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [dir, setDir] = useState('')
  const [path, setPath] = useState('')
  const tree = useGiteaTree(open && repo ? repo : undefined, branch || undefined, dir)

  useEffect(() => {
    if (open) {
      setDir('')
      setPath('')
    }
  }, [open, repo])

  const entries = useMemo(() => {
    const list = tree.data ?? []
    return [...list]
      .filter((e) => e.type === 'tree' || !accept || accept.test(e.path))
      .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'tree' ? -1 : 1))
  }, [tree.data, accept])

  const submit = () => {
    if (!repo || !branch || !path) return
    read.mutate(
      { repo, ref: branch, path },
      {
        onSuccess: (text) => {
          onImport({ repo, branch, path, text })
          toast.success('Imported from Gitea', { description: `${repo}/${path}` })
          onClose()
        },
        onError: (e) => toast.error('Could not read file', { description: e.message }),
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={submit}
            loading={read.isPending}
            disabled={!path || read.isPending}
          >
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RepoBranchFields repo={repo} setRepo={setRepo} branch={branch} setBranch={setBranch} open={open} />
        <div>
          <div className="flex items-center justify-between">
            <Label>Browse</Label>
            <span className="font-mono text-[11px] text-content-subtle">/{dir}</span>
          </div>
          <div className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-edge-default">
            {!repo || !branch ? (
              <div className="p-4 text-center text-xs text-content-subtle">Choose a repository and branch.</div>
            ) : tree.isLoading ? (
              <div className="p-4 text-center text-xs text-content-subtle">Loading…</div>
            ) : tree.error ? (
              <div className="p-4 text-center text-xs text-rose-600 dark:text-rose-400">{tree.error.message}</div>
            ) : (
              <ul className="divide-y divide-edge-subtle text-[12px]">
                {dir ? (
                  <li>
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-left text-content-muted hover:bg-surface-sunken"
                      onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))}
                    >
                      ..
                    </button>
                  </li>
                ) : null}
                {entries.map((e) => (
                  <li key={e.path}>
                    <button
                      type="button"
                      onClick={() => (e.type === 'tree' ? setDir(e.path) : setPath(e.path))}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono hover:bg-surface-sunken ${
                        path === e.path ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content'
                      }`}
                    >
                      <span aria-hidden className="w-4 text-content-subtle">{e.type === 'tree' ? '▸' : '·'}</span>
                      {e.path.split('/').pop()}
                    </button>
                  </li>
                ))}
                {entries.length === 0 ? (
                  <li className="p-4 text-center text-xs text-content-subtle">No matching files here.</li>
                ) : null}
              </ul>
            )}
          </div>
        </div>
        <label className="block">
          <Label>File path</Label>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="api/openapi.yaml"
            className={`mt-1.5 font-mono ${INPUT}`}
          />
        </label>
      </div>
    </Modal>
  )
}
