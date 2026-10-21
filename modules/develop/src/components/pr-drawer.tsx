import { useState } from 'react';
import { Button, Checkbox, EmptyState, Field, Input, Select, Tabs, Textarea, useToast } from '@adhar/shell-ui';
import { cn, formatRelative } from '@adhar/utils';
import type { gitea } from '@adhar/api-clients';
import {
  type RepoPull,
  useCreateComment,
  useCreateReview,
  useMergePull,
  usePullCommits,
  usePullDiff,
  usePullRequest,
  usePullReviews,
  useRepo,
  useSetLabels,
  useUpdatePull,
} from '../data/git.ts';
import { copy, IconCopy, IconExternal } from './repo-bits.tsx';
import {
  Avatar,
  CloseButton,
  DiffStat,
  Drawer,
  IconBranchSmall,
  IconCommit,
  ItemSkeleton,
  LoadingBlock,
  prState,
  PrStateBadge,
  PrStateIcon,
} from './list-kit.tsx';
import { DiffView } from './diff-view.tsx';
import {
  AssigneesEditor,
  Conversation,
  EditableTitle,
  LabelsEditor,
  SideSection,
  TimelineEvent,
  type TimelineExtra,
  useAct,
} from './tracker-bits.tsx';

type TabId = 'conversation' | 'commits' | 'files';

/**
 * A pull request, end to end: the conversation (description, comments and
 * reviews in one thread), review and merge actions, the commits and the full
 * diff. The list row seeds the drawer; the PR is re-read so the merge state
 * and counters are current.
 */
export function PrDrawer({ seed, repo, index, onClose, onOpenCommit }: {
  seed?: RepoPull;
  repo: string;
  index: number;
  onClose(): void;
  onOpenCommit(sha: string): void;
}) {
  const q = usePullRequest(repo, index);
  const pr = q.data ?? seed;
  const commits = usePullCommits(repo, index);
  const [tab, setTab] = useState<TabId>('conversation');
  const update = useUpdatePull();
  const act = useAct();
  const toast = useToast();

  if (!pr) {
    return (
      <Drawer onClose={onClose} widthId='develop.pr' header={<div className='flex justify-between'><span className='text-sm text-content-muted'>{repo} #{index}</span><CloseButton onClick={onClose} /></div>}>
        {q.isError
          ? <EmptyState compact title='Pull request not found' description={q.error instanceof Error ? q.error.message : ''} />
          : <ItemSkeleton label='Loading pull request' />}
      </Drawer>
    );
  }

  const state = prState(pr);
  const head = pr.head?.ref ?? '?';
  const base = pr.base?.ref ?? '?';

  return (
    <Drawer
      onClose={onClose}
      widthId='develop.pr'
      width='max-w-5xl'
      header={
        <div className='flex items-start justify-between gap-4'>
          <div className='min-w-0 flex-1'>
            <div className='mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
              <span>{repo}</span>
              <span>· #{pr.number}</span>
            </div>
            <EditableTitle
              title={pr.title}
              saving={update.isPending}
              onSave={(t) => act('Title updated', () => update.mutateAsync({ repo, index, body: { title: t } }))}
            />
            <div className='mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-content-muted'>
              <PrStateBadge state={state} />
              <span className='font-medium text-content'>{pr.user.login}</span>
              {state === 'merged'
                ? <span>merged {pr.merged_by ? `by ${pr.merged_by.login} ` : ''}{pr.merged_at ? formatRelative(pr.merged_at) : ''}</span>
                : <span>wants to merge into</span>}
              <BranchChip name={base} />
              <span>from</span>
              <BranchChip name={head} onCopy={() => copy(head, toast)} />
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-1.5'>
            <a href={pr.html_url} target='_blank' rel='noopener' className='inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700'>
              Gitea <IconExternal />
            </a>
            <CloseButton onClick={onClose} />
          </div>
        </div>
      }
    >
      <Tabs<TabId>
        ariaLabel='Pull request'
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'conversation', label: 'Conversation', badge: pr.comments ? { kind: 'unknown', value: pr.comments } : undefined },
          { id: 'commits', label: 'Commits', badge: commits.data?.length ? { kind: 'unknown', value: commits.data.length } : undefined },
          { id: 'files', label: 'Files changed', badge: pr.changed_files != null ? { kind: 'info', value: pr.changed_files } : undefined },
        ]}
        actions={<DiffStat add={pr.additions} del={pr.deletions} />}
      >
        {(active) =>
          active === 'files'
            ? <PrFiles repo={repo} index={index} />
            : active === 'commits'
            ? <PrCommits commits={commits.data} loading={commits.isLoading} onOpen={onOpenCommit} />
            : <PrConversation pr={pr} repo={repo} index={index} state={state} />}
      </Tabs>
    </Drawer>
  );
}

function BranchChip({ name, onCopy }: { name: string; onCopy?(): void }) {
  return (
    <span className='inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 font-mono text-[11px] text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'>
      <IconBranchSmall /> {name}
      {onCopy
        ? <button type='button' onClick={onCopy} aria-label={`Copy ${name}`} className='opacity-60 hover:opacity-100'><IconCopy /></button>
        : null}
    </span>
  );
}

/* ─────────── conversation ─────────── */

const REVIEW_TONE: Record<string, { tone: 'emerald' | 'rose' | 'slate' | 'amber'; verb: string }> = {
  APPROVED: { tone: 'emerald', verb: 'approved these changes' },
  REQUEST_CHANGES: { tone: 'rose', verb: 'requested changes' },
  COMMENT: { tone: 'slate', verb: 'reviewed' },
  PENDING: { tone: 'amber', verb: 'started a review' },
  REQUEST_REVIEW: { tone: 'amber', verb: 'was asked to review' },
};

function PrConversation({ pr, repo, index, state }: { pr: RepoPull; repo: string; index: number; state: ReturnType<typeof prState> }) {
  const reviews = usePullReviews(repo, index);
  const update = useUpdatePull();
  const setLabels = useSetLabels();
  const comment = useCreateComment();
  const act = useAct();

  const extras: TimelineExtra[] = (reviews.data ?? [])
    .filter((r) => r.submitted_at && r.state !== 'PENDING')
    .map((r) => {
      const t = REVIEW_TONE[r.state] ?? REVIEW_TONE.COMMENT;
      return {
        key: `r${r.id}`,
        at: r.submitted_at!,
        node: (
          <TimelineEvent
            tone={t.tone}
            icon={r.state === 'APPROVED' ? <Tick /> : r.state === 'REQUEST_CHANGES' ? <Cross /> : <Eye />}
          >
            <span className='font-semibold text-content'>{r.user?.login ?? 'someone'}</span> {t.verb} {formatRelative(r.submitted_at!)}
            {r.stale ? <span className='ml-1 text-content-subtle'>(stale)</span> : null}
            {r.body ? <p className='mt-1 whitespace-pre-wrap rounded-md border border-edge-subtle bg-surface-raised px-2.5 py-1.5 text-[12px] text-content'>{r.body}</p> : null}
          </TimelineEvent>
        ),
      };
    });
  if (state === 'merged' && pr.merged_at) {
    extras.push({
      key: 'merged',
      at: pr.merged_at,
      node: (
        <TimelineEvent tone='violet' icon={<PrStateIcon state='merged' size={12} />}>
          <span className='font-semibold text-content'>{pr.merged_by?.login ?? 'someone'}</span> merged <code className='font-mono'>{pr.head?.ref}</code> into <code className='font-mono'>{pr.base?.ref}</code> {formatRelative(pr.merged_at)}
        </TimelineEvent>
      ),
    });
  } else if (state === 'closed' && pr.closed_at) {
    extras.push({
      key: 'closed',
      at: pr.closed_at,
      node: <TimelineEvent tone='rose' icon={<PrStateIcon state='closed' size={12} />}>Closed without merging {formatRelative(pr.closed_at)}</TimelineEvent>,
    });
  }

  const latest = new Map<string, gitea.Review>();
  for (const r of reviews.data ?? []) if (r.user && r.state !== 'COMMENT' && r.state !== 'PENDING') latest.set(r.user.login, r);
  const approvals = [...latest.values()].filter((r) => r.state === 'APPROVED' && !r.stale && !r.dismissed).length;
  const changes = [...latest.values()].filter((r) => r.state === 'REQUEST_CHANGES' && !r.dismissed).length;

  const isOpen = pr.state === 'open';

  return (
    <div className='grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]'>
      <div className='min-w-0 space-y-4'>
        <Conversation
          repo={repo}
          index={index}
          author={pr.user}
          opened={pr.created_at}
          body={pr.body}
          extras={extras}
          composerActions={(text, clear) =>
            state === 'merged' ? null : (
              <Button
                size='sm'
                variant='secondary'
                loading={update.isPending}
                onClick={async () => {
                  const next = isOpen ? 'closed' : 'open';
                  const ok = await act(isOpen ? 'Pull request closed' : 'Pull request reopened', async () => {
                    if (text.trim()) await comment.mutateAsync({ repo, index, body: text.trim() });
                    await update.mutateAsync({ repo, index, body: { state: next } });
                  });
                  if (ok && text.trim()) clear();
                }}
              >
                {isOpen ? (text.trim() ? 'Close with comment' : 'Close pull request') : 'Reopen pull request'}
              </Button>
            )}
        />
        {isOpen ? <ReviewBox repo={repo} index={index} /> : null}
        {isOpen ? <MergeBox pr={pr} repo={repo} index={index} approvals={approvals} changes={changes} /> : null}
      </div>

      <aside className='space-y-3'>
        <SideSection title='Reviewers'>
          {reviews.isLoading
            ? <div aria-hidden className='space-y-1.5'><span className='skeleton-shimmer block h-3 w-3/4 rounded' /><span className='skeleton-shimmer block h-3 w-1/2 rounded' /></div>
            : latest.size || pr.requested_reviewers?.length
            ? (
              <ul className='space-y-1'>
                {[...latest.values()].map((r) => (
                  <li key={r.user!.login} className='flex items-center gap-2 text-[12px] text-content'>
                    <Avatar login={r.user!.login} url={r.user!.avatar_url} size={18} />
                    <span className='min-w-0 flex-1 truncate'>{r.user!.login}</span>
                    <span className={cn(r.state === 'APPROVED' ? 'text-emerald-600 dark:text-emerald-400' : r.state === 'REQUEST_CHANGES' ? 'text-rose-600 dark:text-rose-400' : 'text-content-subtle')} title={r.state.toLowerCase()}>
                      {r.state === 'APPROVED' ? <Tick /> : r.state === 'REQUEST_CHANGES' ? <Cross /> : <Eye />}
                    </span>
                  </li>
                ))}
                {(pr.requested_reviewers ?? []).filter((u) => !latest.has(u.login)).map((u) => (
                  <li key={u.login} className='flex items-center gap-2 text-[12px] text-content'>
                    <Avatar login={u.login} url={u.avatar_url} size={18} />
                    <span className='min-w-0 flex-1 truncate'>{u.login}</span>
                    <span className='text-[10px] text-amber-700 dark:text-amber-300'>pending</span>
                  </li>
                ))}
              </ul>
            )
            : <p className='text-[12px] text-content-subtle'>No reviews yet</p>}
        </SideSection>
        <AssigneesEditor
          repo={repo}
          current={pr.assignees ?? []}
          saving={update.isPending}
          onSave={(logins) => act('Assignees updated', () => update.mutateAsync({ repo, index, body: { assignees: logins } }))}
        />
        <LabelsEditor
          repo={repo}
          current={pr.labels ?? []}
          saving={setLabels.isPending}
          onSave={(ids) => act('Labels updated', () => setLabels.mutateAsync({ repo, index, labels: ids }))}
        />
        <SideSection title='Details'>
          <dl className='space-y-1 text-[12px]'>
            <Row k='Opened' v={formatRelative(pr.created_at)} />
            {pr.updated_at ? <Row k='Updated' v={formatRelative(pr.updated_at)} /> : null}
            <Row k='Files' v={pr.changed_files ?? '—'} />
            <Row k='Review comments' v={pr.review_comments ?? 0} />
          </dl>
        </SideSection>
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className='flex justify-between gap-2'>
      <dt className='text-content-subtle'>{k}</dt>
      <dd className='text-right text-content'>{v}</dd>
    </div>
  );
}

function ReviewBox({ repo, index }: { repo: string; index: number }) {
  const review = useCreateReview();
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const submit = async (event: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT') => {
    if (event !== 'APPROVED' && !body.trim()) return;
    const label = event === 'APPROVED' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Changes requested' : 'Review submitted';
    if (await act(label, () => review.mutateAsync({ repo, index, event, body: body.trim() }))) {
      setBody('');
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <div className='flex items-center justify-between gap-3 rounded-lg border border-edge-default bg-surface-raised px-3 py-2.5'>
        <div className='text-[12px] text-content-muted'>Reviewed the changes? Approve them or ask for changes.</div>
        <div className='flex gap-1.5'>
          <Button size='sm' variant='secondary' onClick={() => setOpen(true)}>Review…</Button>
          <Button size='sm' variant='secondary' loading={review.isPending} onClick={() => submit('APPROVED')}><Tick /> Approve</Button>
        </div>
      </div>
    );
  }
  return (
    <div className='rounded-lg border border-edge-default bg-surface-raised p-3'>
      <div className='mb-2 text-[12px] font-semibold text-content'>Submit a review</div>
      <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder='Summary of your review (required to comment or request changes)' />
      <div className='mt-2 flex flex-wrap justify-end gap-1.5'>
        <Button size='sm' variant='ghost' onClick={() => setOpen(false)}>Cancel</Button>
        <Button size='sm' variant='secondary' disabled={!body.trim()} loading={review.isPending} onClick={() => submit('COMMENT')}>Comment</Button>
        <Button size='sm' variant='danger' disabled={!body.trim()} loading={review.isPending} onClick={() => submit('REQUEST_CHANGES')}>Request changes</Button>
        <Button variant='primary' size='sm' loading={review.isPending} onClick={() => submit('APPROVED')}>Approve</Button>
      </div>
    </div>
  );
}

const MERGE_STYLES: Array<{ value: gitea.MergeStyle; label: string; flag: keyof gitea.Repo }> = [
  { value: 'merge', label: 'Create a merge commit', flag: 'allow_merge_commits' },
  { value: 'squash', label: 'Squash and merge', flag: 'allow_squash_merge' },
  { value: 'rebase', label: 'Rebase and merge', flag: 'allow_rebase' },
  { value: 'rebase-merge', label: 'Rebase, then merge commit', flag: 'allow_rebase_explicit' },
  { value: 'fast-forward-only', label: 'Fast-forward only', flag: 'allow_fast_forward_only_merge' as keyof gitea.Repo },
];

function MergeBox({ pr, repo, index, approvals, changes }: { pr: RepoPull; repo: string; index: number; approvals: number; changes: number }) {
  const r = useRepo(repo);
  const merge = useMergePull();
  const act = useAct();
  // Only the styles the repo allows; Gitea omits a flag it does not know, so
  // a missing flag counts as allowed.
  const styles = MERGE_STYLES.filter((s) => r.data?.[s.flag] !== false);
  const preferred = (r.data as { default_merge_style?: gitea.MergeStyle } | undefined)?.default_merge_style;
  const [style, setStyle] = useState<gitea.MergeStyle | undefined>(undefined);
  const chosen = style ?? (styles.some((s) => s.value === preferred) ? preferred! : styles[0]?.value ?? 'merge');
  const [del, setDel] = useState<boolean | undefined>(undefined);
  const deleteBranch = del ?? !!(r.data as { default_delete_branch_after_merge?: boolean } | undefined)?.default_delete_branch_after_merge;
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState(false);

  const conflicts = pr.mergeable === false;
  const tone = conflicts ? 'rose' : changes ? 'amber' : 'emerald';
  const ring = { rose: 'border-rose-300 dark:border-rose-500/40', amber: 'border-amber-300 dark:border-amber-500/40', emerald: 'border-emerald-300 dark:border-emerald-500/40' }[tone];

  return (
    <div className={cn('overflow-hidden rounded-lg border-2 bg-surface-raised', ring)}>
      <ul className='divide-y divide-edge-subtle text-[12px]'>
        <Check ok={!changes} warn={!!changes} text={changes ? `${changes} reviewer${changes === 1 ? '' : 's'} requested changes` : approvals ? `${approvals} approval${approvals === 1 ? '' : 's'}` : 'No reviews yet'} />
        <Check ok={!conflicts} text={conflicts ? 'This branch has conflicts that must be resolved' : pr.mergeable ? 'No conflicts with the base branch' : 'Mergeability is still being checked'} />
      </ul>
      <div className='space-y-2 border-t border-edge-subtle p-3'>
        {expanded
          ? (
            <div className='grid gap-2'>
              <Field label='Merge commit title'>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Merge pull request #${pr.number}: ${pr.title}`} />
              </Field>
              <Field label='Message'>
                <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder='Optional' />
              </Field>
            </div>
          )
          : null}
        <div className='flex flex-wrap items-center gap-2'>
          <Select
            aria-label='Merge style'
            value={chosen}
            onChange={(e) => setStyle(e.target.value as gitea.MergeStyle)}
            options={styles.map((s) => ({ value: s.value, label: s.label }))}
            wrapperClassName='min-w-[12rem]'
          />
          <Checkbox label={`Delete ${pr.head?.ref ?? 'branch'} after merge`} checked={deleteBranch} onChange={(e) => setDel(e.target.checked)} />
          <button type='button' onClick={() => setExpanded((x) => !x)} className='text-[11px] font-medium text-content-muted hover:text-content'>
            {expanded ? 'Hide message' : 'Edit message'}
          </button>
          <Button variant='primary'
            className='ml-auto'
            size='sm'
            disabled={conflicts || merge.isPending}
            loading={merge.isPending}
            onClick={() =>
              act(`Merged #${pr.number}`, () =>
                merge.mutateAsync({ repo, index, style: chosen, title: title.trim() || undefined, message: message.trim() || undefined, deleteBranch }))}
          >
            <PrStateIcon state='merged' size={13} /> Merge pull request
          </Button>
        </div>
      </div>
    </div>
  );
}

function Check({ ok, warn, text }: { ok: boolean; warn?: boolean; text: string }) {
  return (
    <li className='flex items-center gap-2 px-3 py-2'>
      <span className={cn('flex h-5 w-5 items-center justify-center rounded-full', warn ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' : ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300')}>
        {warn ? '!' : ok ? <Tick /> : <Cross />}
      </span>
      <span className='text-content'>{text}</span>
    </li>
  );
}

/* ─────────── commits + files ─────────── */

function PrCommits({ commits, loading, onOpen }: { commits?: gitea.Commit[]; loading: boolean; onOpen(sha: string): void }) {
  if (loading) return <LoadingBlock label='Loading commits' rows={4} />;
  if (!commits?.length) return <EmptyState compact title='No commits' />;
  return (
    <ul className='divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-default bg-surface-raised'>
      {commits.map((c) => (
        <li key={c.sha}>
          <button type='button' onClick={() => onOpen(c.sha)} className='flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-sunken/60'>
            <span className='text-content-subtle'><IconCommit /></span>
            <Avatar login={c.author.login} url={c.author.avatar_url} size={22} />
            <div className='min-w-0 flex-1'>
              <div className='truncate text-[13px] font-medium text-content'>{c.message.split('\n')[0]}</div>
              <div className='text-[11px] text-content-subtle'>{c.author.login} · {formatRelative(c.created)}</div>
            </div>
            {c.stats ? <DiffStat add={c.stats.additions} del={c.stats.deletions} /> : null}
            <code className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted'>{c.short_sha}</code>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PrFiles({ repo, index }: { repo: string; index: number }) {
  const diff = usePullDiff(repo, index);
  return <DiffView files={diff.data} loading={diff.isLoading} error={diff.error} />;
}

/* ─────────── glyphs ─────────── */

const Tick = () => <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.75' strokeLinecap='round' strokeLinejoin='round' aria-hidden><path d='M20 6 9 17l-5-5' /></svg>;
const Cross = () => <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.75' strokeLinecap='round' aria-hidden><path d='M18 6 6 18M6 6l12 12' /></svg>;
const Eye = () => <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.25' strokeLinecap='round' aria-hidden><path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' /><circle cx='12' cy='12' r='3' /></svg>;
