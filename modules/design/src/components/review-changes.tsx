import { useMemo, useState, type ChangeEvent } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Button, Field, Input, Modal, Spinner, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { BuilderProject } from '@adhar/builder/project'
import {
  computeChanges, designerBranch, diffLines, diffStats, findConflicts, hunks, pullRequestsBlocked, writesBlocked,
  type FileChange, type ParseFn, type RepoApi, type RepoSession,
} from '@adhar/builder/code'
import { encode, giteaClient } from '../data/designer-repos.ts'

/**
 * Review → commit / pull request.
 *
 * Shows every file the designer would change with a line diff, then either
 * commits to the open branch or (default) to a new branch with a pull request.
 * Before writing, each file's blob is re-checked against what was opened: if
 * someone changed it upstream, nothing is written and the user is told.
 */

export interface CommitResult {
  /** Branch the commit landed on. */
  branch: string
  pr?: number
}

interface RepoFlags {
  name: string
  mirror?: boolean
  archived?: boolean
  empty?: boolean
  has_pull_requests?: boolean
}

export function ReviewChanges({ owner, repo, branch, session, project, parse, api, onClose, onCommitted, onReload }: {
  owner: string
  repo: RepoFlags
  branch: string
  session: RepoSession
  project: BuilderProject
  parse: ParseFn
  api: RepoApi
  onClose(): void
  onCommitted(result: CommitResult): void
  onReload(): void
}) {
  const toast = useToast()
  const router = useRouter({ warn: false })
  const { changes, warnings } = useMemo(() => computeChanges(session, project, parse), [session, project, parse])
  const blocked = writesBlocked(repo)
  const prBlocked = pullRequestsBlocked(repo)
  const [mode, setMode] = useState<'pr' | 'direct'>(prBlocked ? 'direct' : 'pr')
  const [newBranch, setNewBranch] = useState(() => designerBranch())
  const [message, setMessage] = useState(() => defaultMessage(changes))
  const [selected, setSelected] = useState(changes[0]?.path ?? '')
  const [busy, setBusy] = useState(false)
  const [conflicts, setConflicts] = useState<string[] | null>(null)
  const current = changes.find((c) => c.path === selected) ?? changes[0]

  const submit = async () => {
    setBusy(true)
    try {
      const stale = await findConflicts(api, changes, branch)
      if (stale.length) {
        setConflicts(stale)
        return
      }
      const target = mode === 'pr' ? newBranch.trim() : branch
      await giteaClient.changeFiles(owner, repo.name, branch, {
        message: message.trim() || 'design: update pages',
        files: changes.map((c) => ({
          operation: c.sha ? 'update' as const : 'create' as const,
          path: c.path,
          content: encode(c.after),
          ...(c.sha ? { sha: c.sha } : {}),
        })),
        ...(mode === 'pr' ? { new_branch: target } : {}),
      })
      let pr: number | undefined
      if (mode === 'pr') {
        let created: { number: number }
        try {
          created = await giteaClient.createPullRequest(owner, repo.name, {
            head: target,
            base: branch,
            title: message.trim().split('\n')[0] || 'Design changes',
            body: prBody(changes, warnings),
          })
        } catch (e) {
          // The commit already landed on the new branch: retrying here would fail on
          // "branch exists", so move the editor onto that branch and say what is left.
          toast.error(`Changes pushed to ${target}, but the pull request could not be opened`, {
            description: `${e instanceof Error ? e.message : String(e)} — open it from Develop → Pull requests.`,
          })
          onCommitted({ branch: target })
          return
        }
        pr = created.number
        toast.success(`Pull request #${pr} opened`, {
          description: `${repo.name}: ${target} → ${branch}`,
          action: {
            label: 'View pull request',
            onClick: () => {
              const search = { section: 'prs', pr: `${repo.name}/${pr}` }
              if (router) void router.navigate({ to: '/develop', search: search as never })
              else location.assign(`/develop?section=prs&pr=${encodeURIComponent(`${repo.name}/${pr}`)}`)
            },
          },
          duration: 10_000,
        })
      } else {
        toast.success(`Committed to ${branch}`, { description: `${changes.length} file${changes.length === 1 ? '' : 's'} in ${repo.name}` })
      }
      onCommitted({ branch: target, pr })
    } catch (e) {
      toast.error(mode === 'pr' ? 'Could not open the pull request' : 'Commit failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (conflicts) {
    return (
      <Modal open onClose={onClose} title='Changed upstream' description={`Someone changed ${conflicts.length === 1 ? 'this file' : 'these files'} on ${branch} since you opened it. Nothing was written.`}
        footer={<><Button onClick={onClose}>Keep editing</Button><Button variant='danger' onClick={onReload}>Reload from {branch}</Button></>}>
        <ul className='space-y-1 font-mono text-xs text-content'>{conflicts.map((p) => <li key={p}>{p}</li>)}</ul>
        <p className='mt-3 text-sm text-content-muted'>Reloading discards your unsaved designer edits on this branch. To keep them, copy what you need first — or keep editing and merge in code.</p>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} width='xl' title='Review changes'
      description={changes.length ? `${changes.length} file${changes.length === 1 ? '' : 's'} in ${repo.name} · from ${branch}` : 'No file changes'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant='primary' onClick={() => void submit()} loading={busy} disabled={!changes.length || !!blocked || (mode === 'pr' && !newBranch.trim())}>
            {mode === 'pr' ? 'Open pull request' : `Commit to ${branch}`}
          </Button>
        </>
      }>
      {!changes.length ? (
        <p className='text-sm text-content-muted'>The pages match the repository — there is nothing to commit.</p>
      ) : (
        <div className='space-y-4'>
          {blocked && <Callout tone='rose'>{blocked}</Callout>}
          {warnings.map((w) => <Callout key={w} tone='amber'>{w}</Callout>)}

          <div className='grid gap-3 lg:grid-cols-[16rem_1fr]'>
            <ul className='max-h-72 overflow-auto rounded-lg border border-edge-default'>
              {changes.map((c) => {
                const st = diffStats(diffLines(c.before ?? '', c.after))
                return (
                  <li key={c.path}>
                    <button type='button' onClick={() => setSelected(c.path)}
                      className={cn('flex w-full flex-col items-start gap-0.5 border-b border-edge-subtle px-3 py-2 text-left last:border-b-0', c.path === current?.path ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-hover')}>
                      <span className='w-full truncate font-mono text-[11px] text-content'>{c.path}</span>
                      <span className='text-[11px] text-content-muted'>
                        {c.reason} · <span className='text-emerald-600 dark:text-emerald-400'>+{st.added}</span> <span className='text-rose-600 dark:text-rose-400'>−{st.removed}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {current && <DiffView change={current} />}
          </div>

          <Field label='Commit message'>
            <Input value={message} onChange={(e: ChangeEvent<HTMLInputElement>) => setMessage(e.target.value)} />
          </Field>

          <fieldset className='space-y-2'>
            <legend className='mb-1 text-sm font-medium text-content'>Where</legend>
            <label className={cn('flex items-start gap-2 text-sm', prBlocked && 'opacity-60')}>
              <input type='radio' name='target' checked={mode === 'pr'} disabled={!!prBlocked} onChange={() => setMode('pr')} className='mt-1' />
              <span className='flex-1'>
                <span className='font-medium text-content'>New branch and pull request</span>
                <span className='block text-xs text-content-muted'>{prBlocked ?? `Review and merge into ${branch} in Develop → Pull requests.`}</span>
                {mode === 'pr' && (
                  <Input className='mt-2 font-mono text-xs' value={newBranch} onChange={(e: ChangeEvent<HTMLInputElement>) => setNewBranch(e.target.value.replace(/\s+/g, '-'))} />
                )}
              </span>
            </label>
            <label className='flex items-start gap-2 text-sm'>
              <input type='radio' name='target' checked={mode === 'direct'} onChange={() => setMode('direct')} className='mt-1' />
              <span>
                <span className='font-medium text-content'>Commit directly to {branch}</span>
                <span className='block text-xs text-content-muted'>No review — fine for your own feature branch.</span>
              </span>
            </label>
          </fieldset>
          {busy && <div className='flex items-center gap-2 text-sm text-content-muted'><Spinner size={14} /> Checking for upstream changes and writing…</div>}
        </div>
      )}
    </Modal>
  )
}

function DiffView({ change }: { change: FileChange }) {
  const blocks = useMemo(() => hunks(diffLines(change.before ?? '', change.after)), [change])
  const MAX = 500
  let shown = 0
  return (
    <div className='max-h-72 overflow-auto rounded-lg border border-edge-default bg-code font-mono text-[11px] leading-[1.6] text-code-fg'>
      {change.before === null && <div className='border-b border-code-edge px-3 py-1 text-[10px] uppercase tracking-wide text-emerald-400'>New file</div>}
      {blocks.map((h, i) => (
        <div key={i} className='border-b border-code-edge last:border-b-0'>
          {h.lines.map((l, j) => {
            if (shown++ > MAX) return null
            return (
              <div key={j} className={cn('flex whitespace-pre', l.kind === 'add' && 'bg-emerald-500/15', l.kind === 'del' && 'bg-rose-500/15')}>
                <span className='w-10 shrink-0 select-none pr-2 text-right opacity-40'>{l.kind === 'add' ? '' : l.a}</span>
                <span className='w-10 shrink-0 select-none pr-2 text-right opacity-40'>{l.kind === 'del' ? '' : l.b}</span>
                <span className='w-4 shrink-0 select-none opacity-60'>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                <span className='pr-3'>{l.text}</span>
              </div>
            )
          })}
        </div>
      ))}
      {shown > MAX && <div className='px-3 py-1 text-[10px] opacity-60'>Diff truncated — the full file is committed.</div>}
    </div>
  )
}

function Callout({ tone, children }: { tone: 'amber' | 'rose'; children: string }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2 text-sm',
      tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
        : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300')}>
      {children}
    </div>
  )
}

function defaultMessage(changes: FileChange[]): string {
  const pages = changes.filter((c) => /page|Page/.test(c.reason)).map((c) => c.path.split('/').pop()!.replace(/\.\w+$/, ''))
  return pages.length ? `design: update ${pages.slice(0, 3).join(', ')}${pages.length > 3 ? '…' : ''}` : 'design: update pages'
}

function prBody(changes: FileChange[], warnings: string[]): string {
  return [
    'Changes made in the Adhar Visual Designer.',
    '',
    ...changes.map((c) => `- \`${c.path}\` — ${c.reason}`),
    ...(warnings.length ? ['', '**Notes**', ...warnings.map((w) => `- ${w}`)] : []),
  ].join('\n')
}
