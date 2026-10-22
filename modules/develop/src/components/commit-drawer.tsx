import { Button, useToast } from '@adhar/shell-ui';
import { formatRelative } from '@adhar/utils';
import { useCommit, useCommitDiff } from '../data/git.ts';
import { copy, IconCopy, IconExternal } from './repo-bits.tsx';
import { Avatar, CloseButton, DiffStat, Drawer, GiteaError, IconCommit, ItemSkeleton } from './list-kit.tsx';
import { DiffView } from './diff-view.tsx';

/**
 * One commit: full message, author and committer, parents (each opens in
 * place), totals and the complete diff against the first parent.
 */
export function CommitDrawer({ repo, sha, onClose, onOpenSha }: { repo: string; sha: string; onClose(): void; onOpenSha?(sha: string): void }) {
  const q = useCommit(repo, sha);
  const diff = useCommitDiff(repo, sha);
  const toast = useToast();
  const c = q.data;
  const [subject, ...rest] = (c?.message ?? '').split('\n');
  const body = rest.join('\n').trim();

  return (
    <Drawer
      onClose={onClose}
      widthId='develop.commit'
      header={
        <div className='flex items-start justify-between gap-4'>
          <div className='min-w-0'>
            <div className='flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
              <IconCommit /> Commit · {repo}
            </div>
            <h2 className='mt-1 text-lg font-semibold leading-snug tracking-tight text-content'>
              {q.isLoading ? <span aria-hidden className='skeleton-shimmer mt-1 block h-5 w-72 max-w-full rounded' /> : subject || sha.slice(0, 10)}
            </h2>
            {c
              ? (
                <div className='mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-content-muted'>
                  <Avatar login={c.author.login} url={c.author.avatar_url} size={18} />
                  <span className='font-medium text-content'>{c.author_name ?? c.author.login}</span>
                  <span title={c.created}>committed {formatRelative(c.created)}</span>
                  {c.committer_name && c.committer_name !== c.author_name ? <span>· via {c.committer_name}</span> : null}
                  {c.stats ? <DiffStat add={c.stats.additions} del={c.stats.deletions} /> : null}
                </div>
              )
              : null}
          </div>
          <div className='flex shrink-0 items-center gap-1.5'>
            {c?.html_url
              ? (
                <a href={c.html_url} target='_blank' rel='noopener noreferrer' className='inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700 dark:hover:text-brand-300'>
                  Gitea <IconExternal />
                </a>
              )
              : null}
            <CloseButton onClick={onClose} />
          </div>
        </div>
      }
    >
      {q.isError && !c
        ? <GiteaError compact what={`commit ${sha.slice(0, 10)}`} error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
        : q.isLoading
        ? <ItemSkeleton label='Loading commit' />
        : c
        ? (
          <div className='space-y-4'>
            <dl className='grid grid-cols-1 gap-2 rounded-lg border border-edge-default bg-surface-raised p-3 text-[12px] sm:grid-cols-2'>
              <div className='flex min-w-0 items-center gap-2'>
                <dt className='w-14 shrink-0 text-content-subtle'>SHA</dt>
                <dd className='flex min-w-0 items-center gap-1'>
                  <code className='truncate font-mono text-content'>{c.sha}</code>
                  <Button size='xs' variant='ghost' onClick={() => copy(c.sha, toast)} aria-label='Copy SHA'><IconCopy /></Button>
                </dd>
              </div>
              <div className='flex min-w-0 items-center gap-2'>
                <dt className='w-14 shrink-0 text-content-subtle'>Parent{c.parents.length === 1 ? '' : 's'}</dt>
                <dd className='flex min-w-0 flex-wrap gap-1'>
                  {c.parents.length === 0 ? <span className='text-content-subtle'>root commit</span> : c.parents.map((p) => (
                    <button
                      key={p}
                      type='button'
                      disabled={!onOpenSha}
                      onClick={() => onOpenSha?.(p)}
                      className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-brand-700 hover:underline disabled:text-content-muted disabled:no-underline dark:text-brand-300'
                    >
                      {p.slice(0, 7)}
                    </button>
                  ))}
                </dd>
              </div>
              {c.author_email
                ? (
                  <div className='flex min-w-0 items-center gap-2'>
                    <dt className='w-14 shrink-0 text-content-subtle'>Author</dt>
                    <dd className='truncate text-content'>{c.author_name} &lt;{c.author_email}&gt;</dd>
                  </div>
                )
                : null}
              <div className='flex min-w-0 items-center gap-2'>
                <dt className='w-14 shrink-0 text-content-subtle'>Date</dt>
                <dd className='truncate text-content'>{new Date(c.created).toLocaleString()}</dd>
              </div>
            </dl>

            {body
              ? <pre className='whitespace-pre-wrap rounded-lg border border-edge-default bg-surface-raised p-3 font-sans text-[13px] leading-relaxed text-content'>{body}</pre>
              : null}

            <DiffView files={diff.data} loading={diff.isLoading} error={diff.error} />
          </div>
        )
        : null}
    </Drawer>
  );
}
