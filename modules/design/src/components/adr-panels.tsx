import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, StatusBadge, type StatusKind, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  type AdrDoc,
  type AdrReviewer,
  adrFileName,
  adrIndexMarkdown,
  adrToMarkdown,
  formatAdrNumber,
  type ReviewVerdict,
  STATUS_LABEL,
} from '../data/adr.ts'
import { defaultAction, fieldsFromParsed, planAdrSync, summarizeReview, SYNC_LABEL, type SyncRow, type SyncState } from '../data/adr-sync.ts'
import { useAdrFolder, useWorkspaceMembers } from '../data/platform.ts'
import { CommitToRepoModal, type CommittedTarget, RepoBranchFields } from './git-dialogs.tsx'

/**
 * ADR panels that talk to the platform: repo sync (docs/adr both ways), the
 * review round (reviewers from the organisation's members), and the
 * request-review / verdict dialogs.
 */

const INPUT =
  'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

const SYNC_KIND: Record<SyncState, StatusKind> = {
  'in-sync': 'healthy',
  'new-in-repo': 'info',
  'local-only': 'paused',
  'local-ahead': 'progressing',
  'repo-ahead': 'info',
  conflict: 'degraded',
  differs: 'degraded',
}

/* ───────────────────────── repo sync ───────────────────────── */

export function AdrSyncModal({
  open,
  onClose,
  adrs,
  lookup,
  initial,
  onImport,
  onExported,
}: {
  open: boolean
  onClose(): void
  adrs: AdrDoc[]
  lookup(id: string): AdrDoc | undefined
  initial?: { repo?: string; branch?: string; folder?: string }
  /** Create (no `adr`) or update decisions from repo files. */
  onImport(rows: SyncRow[], target: { repo: string; branch: string }): Promise<void>
  onExported(adrs: AdrDoc[], t: CommittedTarget): void
}) {
  const toast = useToast()
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [folder, setFolder] = useState('docs/adr')
  const [picked, setPicked] = useState<Record<string, 'import' | 'export' | 'none'>>({})
  const [busy, setBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    setRepo(initial?.repo ?? '')
    setBranch(initial?.branch ?? '')
    setFolder(initial?.folder ?? 'docs/adr')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const remote = useAdrFolder(repo || undefined, branch || undefined, folder, open)
  const notFound = !!remote.error && /404|not.?found/i.test(remote.error.message)
  const rows = useMemo(
    () => (remote.data || notFound ? planAdrSync(adrs, remote.data ?? [], { repo, lookup }) : []),
    [remote.data, notFound, adrs, repo, lookup],
  )
  const keyOf = (r: SyncRow) => r.adr?.id ?? r.file?.path ?? ''
  useEffect(() => {
    const next: Record<string, 'import' | 'export' | 'none'> = {}
    for (const r of rows) next[keyOf(r)] = defaultAction(r.state)
    setPicked(next)
  }, [rows])
  const imports = rows.filter((r) => picked[keyOf(r)] === 'import' && r.file)
  const exports = rows.filter((r) => picked[keyOf(r)] === 'export' && r.adr).map((r) => r.adr!)
  const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.state]: (m[r.state] ?? 0) + 1 }), {})

  const doImport = async () => {
    setBusy(true)
    try {
      await onImport(imports, { repo, branch })
      toast.success(`Imported ${imports.length} decision${imports.length === 1 ? '' : 's'}`, { description: `${repo}/${folder}` })
      void remote.refetch()
    } catch (e) {
      toast.error('Import failed', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        open={open && !exportOpen}
        onClose={onClose}
        title="Sync decisions with a repository"
        description="Compares every ADR here with the MADR files in the repository folder. Import pulls files in; export opens a pull request."
        branded
        width="xl"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
            <Button size="sm" onClick={doImport} loading={busy} disabled={!imports.length || busy}>Import {imports.length || ''}</Button>
            <Button size="sm" variant="primary" onClick={() => setExportOpen(true)} disabled={!exports.length}>Export {exports.length || ''} as PR…</Button>
          </>
        }
      >
        <div className="space-y-3">
          <RepoBranchFields repo={repo} setRepo={setRepo} branch={branch} setBranch={setBranch} open={open} />
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Folder</span>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} className={`mt-1.5 font-mono ${INPUT}`} />
          </label>
          {!repo || !branch
            ? <div className="rounded-lg border border-dashed border-edge-default p-4 text-center text-[12px] text-content-subtle">Choose the repository that keeps your decision records.</div>
            : remote.isLoading
            ? <div className="p-4 text-center text-[12px] text-content-subtle">Reading {folder}…</div>
            : notFound
            ? <div className="rounded-lg border border-dashed border-edge-default p-4 text-[12px] text-content-muted">{folder}/ does not exist in {repo}@{branch} yet — every decision here is “only here”; export opens a PR that creates it.</div>
            : remote.error
            ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">{remote.error.message}</div>
            : null}
          {(remote.data || notFound) && repo && branch
            ? (
              <>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {(Object.keys(SYNC_LABEL) as SyncState[]).filter((s) => counts[s]).map((s) => (
                    <StatusBadge key={s} kind={SYNC_KIND[s]}>{SYNC_LABEL[s]} · {counts[s]}</StatusBadge>
                  ))}
                </div>
                <div className="max-h-[44vh] overflow-auto rounded-lg border border-edge-default">
                  <table className="w-full text-left text-[12px]">
                    <thead className="sticky top-0 bg-surface-sunken text-[10.5px] uppercase tracking-wider text-content-subtle">
                      <tr>
                        <th className="px-3 py-1.5 font-semibold">Decision</th>
                        <th className="px-3 py-1.5 font-semibold">State</th>
                        <th className="px-3 py-1.5 font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-edge-subtle">
                      {rows.map((r) => {
                        const k = keyOf(r)
                        const canImport = !!r.file
                        const canExport = !!r.adr
                        return (
                          <tr key={k}>
                            <td className="px-3 py-1.5">
                              <div className="font-medium text-content">
                                {r.adr ? `${formatAdrNumber(r.adr.number)} ${r.adr.title}` : `${r.parsed?.number ? formatAdrNumber(r.parsed.number) : ''} ${r.parsed?.title ?? r.file?.path}`}
                              </div>
                              {r.file ? <div className="font-mono text-[10.5px] text-content-subtle">{r.file.path}</div> : null}
                            </td>
                            <td className="px-3 py-1.5"><StatusBadge kind={SYNC_KIND[r.state]}>{SYNC_LABEL[r.state]}</StatusBadge></td>
                            <td className="px-3 py-1.5">
                              <select
                                value={picked[k] ?? 'none'}
                                onChange={(e) => setPicked((p) => ({ ...p, [k]: e.target.value as 'import' | 'export' | 'none' }))}
                                aria-label="Action"
                                className="h-7 rounded-md border border-edge-default bg-surface-raised px-1.5 text-[11.5px] text-content"
                              >
                                <option value="none">Skip</option>
                                {canImport ? <option value="import">{r.adr ? 'Take repo version' : 'Import'}</option> : null}
                                {canExport ? <option value="export">{r.file ? 'Push this version' : 'Export'}</option> : null}
                              </select>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )
            : null}
        </div>
      </Modal>
      <CommitToRepoModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title={`Export ${exports.length} decision${exports.length === 1 ? '' : 's'}`}
        description="Writes the selected ADRs as MADR markdown and refreshes the README index."
        initial={{ repo, branch, folder }}
        defaultFolder={folder}
        defaultMessage={`docs(adr): sync ${exports.length} decision${exports.length === 1 ? '' : 's'} from Adhar Console`}
        prBody={`Architecture decisions exported from Adhar Console → Design → ADRs:\n\n${exports.map((a) => `- ${formatAdrNumber(a.number)} ${a.title} (${STATUS_LABEL[a.status]})`).join('\n')}`}
        buildFiles={() => [
          ...exports.map((a) => ({ path: adrFileName(a), content: adrToMarkdown(a, lookup) })),
          { path: 'README.md', content: adrIndexMarkdown(adrs) },
        ]}
        onCommitted={(t) => {
          onExported(exports, t)
          setExportOpen(false)
          onClose()
        }}
      />
    </>
  )
}

/** Build the decision fields for a sync import row. */
export function importFields(row: SyncRow, target: { repo: string; branch: string }): Partial<AdrDoc> {
  const at = new Date().toISOString()
  return {
    ...fieldsFromParsed(row.parsed ?? {}),
    repo: target.repo,
    git: { repo: target.repo, branch: target.branch, path: row.file!.path, blob: row.file!.sha, at },
  }
}

/* ───────────────────────── review ───────────────────────── */

const VERDICT_LABEL: Record<ReviewVerdict, string> = { approve: 'Approved', changes: 'Requested changes', reject: 'Rejected', comment: 'Commented' }
const VERDICT_KIND: Record<ReviewVerdict, StatusKind> = { approve: 'healthy', changes: 'degraded', reject: 'failed', comment: 'info' }

export function ReviewPanel({ adr, onVerdict }: { adr: AdrDoc; onVerdict(v: ReviewVerdict): void }) {
  const s = summarizeReview(adr.review)
  if (!adr.review || !s) return null
  const r = adr.review
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {s.open
          ? <StatusBadge kind={s.approvedByAll ? 'healthy' : s.changes || s.rejects ? 'degraded' : 'progressing'}>{s.approvedByAll ? 'Approved by all' : `${s.approvals}/${r.reviewers.length} approved`}</StatusBadge>
          : <StatusBadge kind={r.outcome === 'accepted' ? 'healthy' : 'failed'}>Closed · {r.outcome}</StatusBadge>}
        <span className="text-[11px] text-content-subtle">requested by {r.requestedBy} · {formatRelative(r.requestedAt)}</span>
      </div>
      <ul className="space-y-1">
        {r.reviewers.map((rv) => {
          const v = s.verdicts.get(rv.id.toLowerCase()) ?? s.verdicts.get(rv.name.toLowerCase())
          return (
            <li key={rv.id} className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate text-content">{rv.name}</span>
              {v ? <StatusBadge kind={VERDICT_KIND[v.verdict]}>{VERDICT_LABEL[v.verdict]}</StatusBadge> : <span className="text-[11px] text-content-subtle">pending</span>}
            </li>
          )
        })}
      </ul>
      {r.entries.some((e) => e.comment)
        ? (
          <ol className="space-y-1.5 border-l border-edge-default pl-3">
            {r.entries.filter((e) => e.comment).slice(0, 8).map((e, i) => (
              <li key={`${e.at}-${i}`} className="text-[12px]">
                <div className="text-content-muted"><span className="font-medium text-content">{e.by}</span> · {VERDICT_LABEL[e.verdict].toLowerCase()} · {formatRelative(e.at)}</div>
                <div className="whitespace-pre-wrap text-content">{e.comment}</div>
              </li>
            ))}
          </ol>
        )
        : null}
      {s.open
        ? (
          <div className="flex flex-wrap gap-1">
            <Button size="xs" onClick={() => onVerdict('approve')}>Approve</Button>
            <Button size="xs" onClick={() => onVerdict('changes')}>Request changes</Button>
            <Button size="xs" variant="ghost" onClick={() => onVerdict('comment')}>Comment</Button>
          </div>
        )
        : null}
    </div>
  )
}

export function RequestReviewModal({
  open,
  onClose,
  adr,
  onRequest,
}: {
  open: boolean
  onClose(): void
  adr: AdrDoc
  onRequest(reviewers: AdrReviewer[], note: string): Promise<unknown>
}) {
  const members = useWorkspaceMembers(open)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setSel(new Set((adr.review?.reviewers ?? []).map((r) => r.id)))
      setNote('')
      setQ('')
    }
  }, [open, adr.review])
  const list = (members.data ?? []).filter((m) => !q.trim() || `${m.name ?? ''} ${m.email}`.toLowerCase().includes(q.toLowerCase()))
  const chosen = (members.data ?? []).filter((m) => sel.has(m.userId)).map((m) => ({ id: m.userId, name: m.name || m.email, email: m.email }))
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Request review · ${formatAdrNumber(adr.number)}`}
      description="Reviewers come from your organisation's members (Keycloak-backed). The request is posted to the organisation's notification feed."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!chosen.length || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onRequest(chosen, note.trim())
                onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            Request review ({chosen.length})
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" aria-label="Search people" className={INPUT} />
        <ul className="max-h-[36vh] divide-y divide-edge-subtle overflow-auto rounded-lg border border-edge-default">
          {members.isLoading
            ? <li className="p-4 text-center text-[12px] text-content-subtle">Loading members…</li>
            : members.error
            ? <li className="p-4 text-center text-[12px] text-rose-600 dark:text-rose-400">Could not list members: {members.error.message}</li>
            : list.length === 0
            ? <li className="p-4 text-center text-[12px] text-content-subtle">No members match.</li>
            : list.map((m) => (
              <li key={m.userId}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-surface-sunken/60">
                  <input
                    type="checkbox"
                    checked={sel.has(m.userId)}
                    onChange={() =>
                      setSel((s) => {
                        const n = new Set(s)
                        if (n.has(m.userId)) n.delete(m.userId)
                        else n.add(m.userId)
                        return n
                      })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-content">{m.name || m.email}</span>
                    <span className="block truncate text-[11px] text-content-subtle">{m.email}{m.teams.length ? ` · ${m.teams.join(', ')}` : ''}</span>
                  </span>
                  {m.role ? <span className="text-[10.5px] uppercase tracking-wider text-content-subtle">{m.role}</span> : null}
                </label>
              </li>
            ))}
        </ul>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Note to reviewers</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`mt-1.5 ${INPUT}`} placeholder="What should reviewers focus on?" />
        </label>
      </div>
    </Modal>
  )
}

export function VerdictModal({
  open,
  onClose,
  verdict,
  adr,
  onSubmit,
}: {
  open: boolean
  onClose(): void
  verdict: ReviewVerdict | 'accept' | 'decline'
  adr: AdrDoc
  onSubmit(comment: string): Promise<unknown>
}) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setComment('')
  }, [open])
  const label = verdict === 'accept'
    ? 'Accept decision'
    : verdict === 'decline'
    ? 'Reject decision'
    : verdict === 'approve'
    ? 'Approve'
    : verdict === 'changes'
    ? 'Request changes'
    : verdict === 'reject'
    ? 'Reject'
    : 'Comment'
  const needsComment = verdict === 'changes' || verdict === 'comment' || verdict === 'decline' || verdict === 'reject'
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${label} · ${formatAdrNumber(adr.number)}`}
      description={verdict === 'accept' || verdict === 'decline' ? 'Closes the review round and records the outcome in the decision history.' : 'Recorded on the decision for everyone to see.'}
      width="md"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            variant={verdict === 'decline' || verdict === 'reject' ? 'danger' : 'primary'}
            loading={busy}
            disabled={busy || (needsComment && !comment.trim())}
            onClick={async () => {
              setBusy(true)
              try {
                await onSubmit(comment.trim())
                onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            {label}
          </Button>
        </>
      }
    >
      <textarea
        autoFocus
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={4}
        className={INPUT}
        placeholder={needsComment ? 'Explain your reasoning (required)' : 'Optional comment'}
      />
    </Modal>
  )
}
