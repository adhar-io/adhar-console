import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { Button, Field, Input, Modal, Select, Spinner, useToast } from '@adhar/shell-ui'
import type { BuilderController, GeneratedFile } from '../types.ts'
import { joinPath } from './encoding.ts'
import { useBuilderBranches, useBuilderRepos, useCommitBuilderFiles, useOpenBuilderProject } from './gitea-sync.ts'

/**
 * Page-header actions that round-trip a builder project through Gitea:
 * "Open from repo" and "Commit to repo" — Design → Visual Designer.
 */

// Shared with Develop's repository pages, so the builder offers the repo the
// user was last looking at.
const REPO_KEY = 'adhar.develop.activeRepo'
function readStoredRepo(): string {
  try {
    return localStorage.getItem(REPO_KEY) ?? ''
  } catch {
    return ''
  }
}
function writeStoredRepo(name: string) {
  try {
    localStorage.setItem(REPO_KEY, name)
  } catch {
    /* storage blocked — a convenience only */
  }
}

export function RepoActions({ ctl, commitMessage }: { ctl: BuilderController; commitMessage?: string }) {
  const [dialog, setDialog] = useState<null | 'commit' | 'open'>(null)
  return (
    <>
      <Button size="sm" onClick={() => setDialog('open')} leading={<FolderGlyph />}>
        Open from repo
      </Button>
      <Button size="sm" onClick={() => setDialog('commit')} disabled={!ctl.project} leading={<CommitGlyph />}>
        Commit to repo
      </Button>
      {dialog === 'commit' ? <CommitDialog ctl={ctl} defaultMessage={commitMessage} onClose={() => setDialog(null)} /> : null}
      {dialog === 'open' ? <OpenDialog ctl={ctl} onClose={() => setDialog(null)} /> : null}
    </>
  )
}

/* ─────────── repo + branch picker ─────────── */

function useRepoBranch() {
  const repos = useBuilderRepos()
  const [repo, setRepo] = useState<string>(() => readStoredRepo())
  const branches = useBuilderBranches(repo || undefined)
  const [branch, setBranch] = useState('')

  const list = useMemo(() => (repos.data ?? []).filter((r) => !r.archived && !r.mirror), [repos.data])

  // Fall back to the first repo when nothing (or a vanished repo) is remembered.
  useEffect(() => {
    if (!list.length) return
    if (!repo || !list.some((r) => r.name === repo)) setRepo(list[0].name)
  }, [list, repo])

  // Default branch of the chosen repo.
  useEffect(() => {
    const r = list.find((x) => x.name === repo)
    setBranch(r?.default_branch ?? '')
  }, [repo, list])

  return {
    repos,
    list,
    repo,
    setRepo: (name: string) => {
      setRepo(name)
      writeStoredRepo(name)
    },
    branches,
    branch,
    setBranch,
  }
}

function RepoBranchFields({ rb, folder, setFolder }: {
  rb: ReturnType<typeof useRepoBranch>
  folder: string
  setFolder(v: string): void
}) {
  if (rb.repos.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-content-muted">
        <Spinner size={14} /> Loading repositories…
      </div>
    )
  }
  if (rb.repos.error) {
    return <div className="text-sm text-rose-600">Could not load repositories: {String((rb.repos.error as Error).message)}</div>
  }
  if (!rb.list.length) {
    return <div className="text-sm text-content-muted">No writable repositories in this organization yet.</div>
  }
  const branchOptions = (rb.branches.data ?? []).map((b) => ({ value: b.name, label: b.name }))
  if (rb.branch && !branchOptions.some((o) => o.value === rb.branch)) branchOptions.unshift({ value: rb.branch, label: rb.branch })
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Repository">
        <Select value={rb.repo} onChange={(e: ChangeEvent<HTMLSelectElement>) => rb.setRepo(e.target.value)} options={rb.list.map((r) => ({ value: r.name, label: r.name }))} />
      </Field>
      <Field label="Branch">
        <Select value={rb.branch} onChange={(e: ChangeEvent<HTMLSelectElement>) => rb.setBranch(e.target.value)} options={branchOptions} disabled={!rb.repo} />
      </Field>
      <Field label="Folder" hint="Optional — inside the repository" className="sm:col-span-2">
        <Input value={folder} onChange={(e: ChangeEvent<HTMLInputElement>) => setFolder(e.target.value)} placeholder="e.g. apps/web" />
      </Field>
    </div>
  )
}

/* ─────────── commit ─────────── */

function CommitDialog({ ctl, defaultMessage, onClose }: { ctl: BuilderController; defaultMessage?: string; onClose(): void }) {
  const toast = useToast()
  const rb = useRepoBranch()
  const commit = useCommitBuilderFiles()
  const [folder, setFolder] = useState('')
  const [message, setMessage] = useState(defaultMessage ?? 'feat(builder): update generated project')
  const [files, setFiles] = useState<GeneratedFile[] | null>(null)

  useEffect(() => {
    let live = true
    void ctl.generateFiles().then((f) => live && setFiles(f))
    return () => {
      live = false
    }
  }, [ctl])

  const paths = (files ?? []).map((f) => joinPath(folder, f.path))

  const submit = () => {
    if (!files || !rb.repo || !rb.branch) return
    commit.mutate(
      { repo: rb.repo, branch: rb.branch, message: message.trim() || 'Update builder project', files: files.map((f) => ({ ...f, path: joinPath(folder, f.path) })) },
      {
        onSuccess: (r) => {
          toast.success(`Committed to ${rb.repo}@${rb.branch}`, {
            description: `${r.created} added · ${r.updated} updated${r.sha ? ` · ${r.sha.slice(0, 8)}` : ''}`,
          })
          onClose()
        },
        onError: (e) => toast.error('Commit failed', { description: e instanceof Error ? e.message : String(e) }),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Commit to repository"
      description="Writes the generated project as a single commit."
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={commit.isPending} disabled={!files || !rb.repo || !rb.branch}>
            Commit {files ? `${files.length} files` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RepoBranchFields rb={rb} folder={folder} setFolder={setFolder} />
        <Field label="Commit message">
          <Input value={message} onChange={(e: ChangeEvent<HTMLInputElement>) => setMessage(e.target.value)} />
        </Field>
        <div>
          <div className="mb-1.5 text-sm font-medium text-content">Files</div>
          {files === null ? (
            <div className="flex items-center gap-2 text-sm text-content-muted">
              <Spinner size={14} /> Generating…
            </div>
          ) : (
            <ul className="max-h-48 overflow-auto rounded-md border border-edge-default bg-surface-sunken px-3 py-2 font-mono text-[11px] text-content-muted">
              {paths.map((p) => (
                <li key={p} className="truncate">{p}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ─────────── open ─────────── */

function OpenDialog({ ctl, onClose }: { ctl: BuilderController; onClose(): void }) {
  const toast = useToast()
  const rb = useRepoBranch()
  const open = useOpenBuilderProject()
  const [folder, setFolder] = useState('')

  const submit = () => {
    if (!rb.repo || !rb.branch) return
    open.mutate(
      { repo: rb.repo, branch: rb.branch, folder },
      {
        onSuccess: (project) => {
          ctl.loadProject(project, { dirty: true })
          toast.success(`Opened ${project.name}`, { description: `${rb.repo}@${rb.branch} — save to keep it here.` })
          onClose()
        },
        onError: (e) => toast.error('Could not open the project', { description: e instanceof Error ? e.message : String(e) }),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Open from repository"
      description="Loads a project committed from the builder (.adhar/builder.json). Unsaved changes here are replaced."
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={open.isPending} disabled={!rb.repo || !rb.branch}>
            Open
          </Button>
        </>
      }
    >
      <RepoBranchFields rb={rb} folder={folder} setFolder={setFolder} />
    </Modal>
  )
}

/* ─────────── glyphs ─────────── */

function CommitGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6M15 12h6" />
    </svg>
  )
}

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}
