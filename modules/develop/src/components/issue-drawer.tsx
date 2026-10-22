import { useState } from 'react';
import { Button, EmptyState, Textarea } from '@adhar/shell-ui';
import { formatRelative } from '@adhar/utils';
import { type RepoIssue, useCreateComment, useIssue, useSetLabels, useUpdateIssue } from '../data/git.ts';
import { IconExternal } from './repo-bits.tsx';
import { CloseButton, Drawer, IssueStateBadge, IssueStateIcon, ItemSkeleton } from './list-kit.tsx';
import { AssigneesEditor, Conversation, EditableTitle, LabelsEditor, SideSection, TimelineEvent, useAct } from './tracker-bits.tsx';

/**
 * One issue: the thread, close / reopen (optionally with a comment), and the
 * title, description, labels and assignees — all editable in place.
 */
export function IssueDrawer({ seed, repo, index, onClose }: { seed?: RepoIssue; repo: string; index: number; onClose(): void }) {
  const q = useIssue(repo, index);
  const issue = q.data ?? seed;
  const update = useUpdateIssue();
  const setLabels = useSetLabels();
  const comment = useCreateComment();
  const act = useAct();
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');

  if (!issue) {
    return (
      <Drawer onClose={onClose} widthId='develop.issue' header={<div className='flex justify-between'><span className='text-sm text-content-muted'>{repo} #{index}</span><CloseButton onClick={onClose} /></div>}>
        {q.isError
          ? <EmptyState compact title='Issue not found' description={q.error instanceof Error ? q.error.message : ''} />
          : <ItemSkeleton label='Loading issue' />}
      </Drawer>
    );
  }

  const open = issue.state === 'open';
  const extras = !open && issue.closed_at
    ? [{
      key: 'closed',
      at: issue.closed_at,
      node: <TimelineEvent tone='violet' icon={<IssueStateIcon state='closed' size={12} />}>Closed {formatRelative(issue.closed_at)}</TimelineEvent>,
    }]
    : [];

  return (
    <Drawer
      onClose={onClose}
      widthId='develop.issue'
      header={
        <div className='flex items-start justify-between gap-4'>
          <div className='min-w-0 flex-1'>
            <div className='mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
              <span>{repo}</span>
              <span>· #{issue.number}</span>
            </div>
            <EditableTitle
              title={issue.title}
              saving={update.isPending}
              onSave={(t) => act('Title updated', () => update.mutateAsync({ repo, index, body: { title: t } }))}
            />
            <div className='mt-2 flex flex-wrap items-center gap-2 text-[12px] text-content-muted'>
              <IssueStateBadge state={issue.state} />
              <span>
                <span className='font-medium text-content'>{issue.user.login}</span> opened {formatRelative(issue.created_at)}
              </span>
              <span>· {issue.comments ?? 0} comment{issue.comments === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-1.5'>
            {issue.html_url
              ? (
                <a href={issue.html_url} target='_blank' rel='noopener noreferrer' className='inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700 dark:hover:text-brand-300'>
                  Gitea <IconExternal />
                </a>
              )
              : null}
            <CloseButton onClick={onClose} />
          </div>
        </div>
      }
    >
      <div className='grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]'>
        <div className='min-w-0'>
          {editingBody
            ? (
              <div className='mb-3 rounded-lg border border-brand-300 bg-surface-raised p-3 dark:border-brand-500/30'>
                <Textarea rows={8} value={bodyDraft} onChange={(e) => setBodyDraft(e.target.value)} aria-label='Description' />
                <div className='mt-2 flex justify-end gap-2'>
                  <Button size='sm' variant='ghost' onClick={() => setEditingBody(false)}>Cancel</Button>
                  <Button variant='primary'
                    size='sm'
                    loading={update.isPending}
                    onClick={async () => {
                      if (await act('Description updated', () => update.mutateAsync({ repo, index, body: { body: bodyDraft } }))) setEditingBody(false);
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            )
            : null}
          <Conversation
            repo={repo}
            index={index}
            author={issue.user}
            opened={issue.created_at}
            body={editingBody ? undefined : issue.body}
            extras={extras}
            composerActions={(text, clear) => (
              <Button
                size='sm'
                variant='secondary'
                loading={update.isPending || comment.isPending}
                onClick={async () => {
                  const ok = await act(open ? 'Issue closed' : 'Issue reopened', async () => {
                    if (text.trim()) await comment.mutateAsync({ repo, index, body: text.trim() });
                    await update.mutateAsync({ repo, index, body: { state: open ? 'closed' : 'open' } });
                  });
                  if (ok) clear();
                }}
              >
                <IssueStateIcon state={open ? 'closed' : 'open'} size={13} />
                {open ? (text.trim() ? 'Close with comment' : 'Close issue') : 'Reopen issue'}
              </Button>
            )}
          />
        </div>

        <aside className='space-y-3'>
          <AssigneesEditor
            repo={repo}
            current={issue.assignees ?? []}
            saving={update.isPending}
            onSave={(logins) => act('Assignees updated', () => update.mutateAsync({ repo, index, body: { assignees: logins } }))}
          />
          <LabelsEditor
            repo={repo}
            current={issue.labels}
            saving={setLabels.isPending}
            onSave={(ids) => act('Labels updated', () => setLabels.mutateAsync({ repo, index, labels: ids }))}
          />
          <SideSection title='Milestone'>
            <p className='text-[12px] text-content'>{issue.milestone?.title ?? <span className='text-content-subtle'>None</span>}</p>
          </SideSection>
          <SideSection title='Description'>
            <button
              type='button'
              onClick={() => { setBodyDraft(issue.body ?? ''); setEditingBody(true); }}
              className='text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300'
            >
              Edit description
            </button>
          </SideSection>
          <SideSection title='Details'>
            <dl className='space-y-1 text-[12px]'>
              <div className='flex justify-between'><dt className='text-content-subtle'>Opened</dt><dd className='text-content'>{formatRelative(issue.created_at)}</dd></div>
              {issue.updated_at ? <div className='flex justify-between'><dt className='text-content-subtle'>Updated</dt><dd className='text-content'>{formatRelative(issue.updated_at)}</dd></div> : null}
              {issue.closed_at ? <div className='flex justify-between'><dt className='text-content-subtle'>Closed</dt><dd className='text-content'>{formatRelative(issue.closed_at)}</dd></div> : null}
            </dl>
          </SideSection>
        </aside>
      </div>
    </Drawer>
  );
}
