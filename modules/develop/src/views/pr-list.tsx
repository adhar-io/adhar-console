import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
  Tabs,
} from '@adhar-console/shell-ui';
import { formatRelative } from '@adhar-console/utils';
import type { gitea } from '@adhar-console/api-clients';
import { type DiffFile, useAllOpenPullRequests, useCommits, usePullDiff } from '../data/git.ts';

/**
 * Org-wide open pull requests with a detail drawer.
 */
export function PullRequestList() {
  const q = useAllOpenPullRequests();
  const [openId, setOpenId] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  if (q.isLoading) {
    return (
      <div className='flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm'>
        <Spinner size={14} /> Loading PRs…
      </div>
    );
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Gitea"
        description={q.error instanceof Error ? q.error.message : ''}
      />
    );
  }
  const all = q.data ?? [];
  const f = search.trim().toLowerCase();
  const list = f
    ? all.filter(
      (p) =>
        p.title.toLowerCase().includes(f) ||
        p.user.login.toLowerCase().includes(f) ||
        (p.repo ?? '').toLowerCase().includes(f),
    )
    : all;
  const open = all.find((p) => p.id === openId) ?? null;

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='text-[11px] text-content-muted'>{all.length} open</div>
        <div className='ml-auto'>
          <SearchInput value={search} onChange={setSearch} placeholder='Search PRs…' />
        </div>
      </div>
      {list.length === 0
        ? <EmptyState title='No open PRs' description='Nothing to review right now 🎉' />
        : (
          <Card>
            <CardBody className='p-0!'>
              <ul className='divide-y divide-edge-subtle'>
                {list.map((p) => <PrRow key={p.id} pr={p} onOpen={() => setOpenId(p.id)} />)}
              </ul>
            </CardBody>
          </Card>
        )}
      {open ? <PrDetail pr={open} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function PrRow({
  pr,
  onOpen,
}: {
  pr: gitea.PullRequest & { repo?: string };
  onOpen(): void;
}) {
  return (
    <li>
      <button
        type='button'
        onClick={onOpen}
        className='flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-brand-50/40'
      >
        <img
          src={pr.user.avatar_url}
          alt=''
          className='h-8 w-8 shrink-0 rounded-full ring-1 ring-edge-subtle'
        />
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            <code className='font-mono text-[10px] text-content-muted'>#{pr.number}</code>
            {pr.repo
              ? (
                <span className='rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted'>
                  {pr.repo}
                </span>
              )
              : null}
            <span className='truncate text-sm font-medium text-content'>{pr.title}</span>
            {pr.mergeable === false ? <StatusBadge kind='failed'>conflicts</StatusBadge> : null}
          </div>
          <div className='mt-0.5 flex items-center gap-2 text-[11px] text-content-muted'>
            <span>{pr.user.login}</span>
            <span>· opened {formatRelative(pr.created_at)}</span>
            {pr.head ? <span>· {pr.head.ref} → {pr.base?.ref ?? 'main'}</span> : null}
            {pr.comments != null ? <span>· 💬 {pr.comments}</span> : null}
          </div>
        </div>
        {pr.changed_files != null
          ? (
            <div className='hidden text-right text-[11px] sm:block'>
              <div className='font-mono'>
                <span className='text-emerald-700'>+{pr.additions ?? 0}</span>{' '}
                <span className='text-rose-700'>-{pr.deletions ?? 0}</span>
              </div>
              <div className='text-[10px] text-content-subtle'>{pr.changed_files} files</div>
            </div>
          )
          : null}
      </button>
    </li>
  );
}

function PrDetail({
  pr,
  onClose,
}: {
  pr: gitea.PullRequest & { repo?: string };
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className='fixed inset-0 z-50 flex justify-end' role='dialog' aria-modal='true'>
      <button
        type='button'
        aria-label='Close'
        className='absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]'
        onClick={onClose}
      />
      <aside className='relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl'>
        <header className='flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4'>
          <div className='min-w-0'>
            <div className='flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
              <code className='font-mono'>#{pr.number}</code>
              {pr.repo ? <span>· {pr.repo}</span> : null}
            </div>
            <h2 className='mt-0.5 truncate text-lg font-semibold tracking-tight text-content'>
              {pr.title}
            </h2>
            <div className='mt-1 flex items-center gap-2 text-[11px] text-content-muted'>
              <img
                src={pr.user.avatar_url}
                alt=''
                className='h-5 w-5 rounded-full ring-1 ring-edge-subtle'
              />
              <span>{pr.user.login}</span>
              <span>· opened {formatRelative(pr.created_at)}</span>
              {pr.head ? <span>· {pr.head.ref} → {pr.base?.ref ?? 'main'}</span> : null}
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <a
              href={pr.html_url}
              target='_blank'
              rel='noopener'
              className='inline-flex h-8 items-center rounded-md border border-edge-default bg-white px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700'
            >
              Open in Gitea
            </a>
            <button
              type='button'
              onClick={onClose}
              aria-label='Close'
              className='flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className='flex-1 overflow-y-auto px-6 py-5'>
          <Tabs
            ariaLabel='Pull request detail'
            tabs={[
              { id: 'overview', label: 'Overview' },
              {
                id: 'files',
                label: 'Files changed',
                badge: pr.changed_files != null
                  ? { kind: 'info', value: pr.changed_files }
                  : undefined,
              },
              { id: 'commits', label: 'Commits' },
            ]}
          >
            {(active) =>
              active === 'files'
                ? <FilesChanged pr={pr} />
                : active === 'commits'
                ? <PrCommits pr={pr} />
                : (
                  <div className='space-y-5'>
                    <Card>
                      <CardBody className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                        <Tile label='State' value={pr.state} />
                        <Tile
                          label='Mergeable'
                          value={pr.mergeable === undefined ? '—' : pr.mergeable ? 'yes' : 'no'}
                        />
                        <Tile label='+lines' value={pr.additions ?? 0} accent='emerald' />
                        <Tile label='-lines' value={pr.deletions ?? 0} accent='rose' />
                      </CardBody>
                    </Card>

                    {pr.body
                      ? (
                        <Card>
                          <CardHeader>
                            <div className='text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700'>
                              Description
                            </div>
                          </CardHeader>
                          <CardBody>
                            <p className='whitespace-pre-wrap text-sm leading-relaxed text-content'>
                              {pr.body}
                            </p>
                          </CardBody>
                        </Card>
                      )
                      : null}

                    <Card>
                      <CardHeader>
                        <div className='text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700'>
                          Diff summary
                        </div>
                      </CardHeader>
                      <CardBody>
                        <div className='text-sm text-content'>
                          {pr.changed_files ?? 0} file{pr.changed_files === 1 ? '' : 's'} changed
                        </div>
                        {pr.additions != null && pr.deletions != null
                          ? (
                            <div className='mt-2 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken'>
                              <div
                                className='bg-emerald-500'
                                style={{
                                  width: `${
                                    (pr.additions / (pr.additions + pr.deletions || 1)) * 100
                                  }%`,
                                }}
                              />
                              <div
                                className='bg-rose-500'
                                style={{
                                  width: `${
                                    (pr.deletions / (pr.additions + pr.deletions || 1)) * 100
                                  }%`,
                                }}
                              />
                            </div>
                          )
                          : null}
                      </CardBody>
                    </Card>
                  </div>
                )}
          </Tabs>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function FilesChanged({ pr }: { pr: gitea.PullRequest & { repo?: string } }) {
  const diff = usePullDiff(pr.repo, pr.number);

  if (diff.isLoading) {
    return (
      <div className='flex items-center gap-2 text-sm text-content-muted'>
        <Spinner size={12} /> Loading diff…
      </div>
    );
  }
  if (diff.isError || !diff.data?.length) {
    return (
      <EmptyState
        compact
        title='No file changes'
        description='This pull request has no diff to show.'
      />
    );
  }

  return (
    <div className='space-y-4'>
      {diff.data.map((f) => <DiffFileView key={f.path} file={f} />)}
    </div>
  );
}

const STATUS_KIND: Record<DiffFile['status'], StatusKind> = {
  added: 'healthy',
  modified: 'info',
  deleted: 'failed',
  renamed: 'unknown',
};

function DiffFileView({ file }: { file: DiffFile }) {
  return (
    <Card>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <StatusBadge kind={STATUS_KIND[file.status]}>{file.status}</StatusBadge>
          <code className='min-w-0 flex-1 truncate font-mono text-[12px] text-content'>
            {file.oldPath && file.oldPath !== file.path
              ? `${file.oldPath} → ${file.path}`
              : file.path}
          </code>
          <span className='shrink-0 font-mono text-[11px]'>
            <span className='text-emerald-700'>+{file.additions}</span>{' '}
            <span className='text-rose-700'>-{file.deletions}</span>
          </span>
        </div>
      </CardHeader>
      <CardBody className='p-0!'>
        <div className='overflow-x-auto'>
          <table className='w-full border-collapse font-mono text-[12px] leading-[1.55]'>
            <tbody>
              {file.hunks.map((h, hi) => <HunkRows key={hi} hunk={h} />)}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

function HunkRows({ hunk }: { hunk: DiffFile['hunks'][number] }) {
  return (
    <>
      <tr className='bg-brand-50/60 text-brand-700'>
        <td colSpan={2} className='select-none px-2 text-right text-content-subtle' />
        <td className='whitespace-pre px-3 py-0.5 text-[11px]'>{hunk.header}</td>
      </tr>
      {hunk.lines.map((ln, i) => {
        const tint = ln.kind === 'add' ? 'bg-emerald-50' : ln.kind === 'del' ? 'bg-rose-50' : '';
        const marker = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' ';
        const markerTone = ln.kind === 'add'
          ? 'text-emerald-700'
          : ln.kind === 'del'
          ? 'text-rose-700'
          : 'text-content-subtle';
        return (
          <tr key={i} className={`align-top ${tint}`}>
            <td className='w-10 select-none whitespace-nowrap border-r border-edge-subtle px-1.5 text-right text-[11px] text-content-subtle tabular-nums'>
              {ln.oldNo ?? ''}
            </td>
            <td className='w-10 select-none whitespace-nowrap border-r border-edge-subtle px-1.5 text-right text-[11px] text-content-subtle tabular-nums'>
              {ln.newNo ?? ''}
            </td>
            <td className={`whitespace-pre px-3 text-content ${markerTone}`}>
              <span className='select-none'>{marker}</span>
              {ln.text || ' '}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function PrCommits({ pr }: { pr: gitea.PullRequest & { repo?: string } }) {
  const commits = useCommits(pr.repo, pr.head?.ref, 20);

  if (commits.isLoading) {
    return (
      <div className='flex items-center gap-2 text-sm text-content-muted'>
        <Spinner size={12} /> Loading commits…
      </div>
    );
  }
  if (!commits.data?.length) {
    return <EmptyState compact title='No commits' />;
  }

  return (
    <Card>
      <CardBody>
        <ul className='space-y-2'>
          {commits.data.map((c) => (
            <li key={c.sha} className='flex items-start gap-2 text-sm'>
              <code className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted'>
                {c.short_sha}
              </code>
              <div className='min-w-0 flex-1'>
                <div className='truncate text-content'>{c.message}</div>
                <div className='text-[11px] text-content-subtle'>
                  {c.author.login} · {formatRelative(c.created)}
                </div>
              </div>
              {c.stats
                ? (
                  <span className='font-mono text-[11px]'>
                    <span className='text-emerald-700'>+{c.stats.additions}</span>{' '}
                    <span className='text-rose-700'>-{c.stats.deletions}</span>
                  </span>
                )
                : null}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function Tile({
  label,
  value,
  accent = 'slate',
}: {
  label: string;
  value: string | number;
  accent?: 'slate' | 'emerald' | 'rose';
}) {
  const tone = {
    slate: 'text-content',
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
  }[accent];
  return (
    <div className='rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3'>
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
        {label}
      </div>
    </div>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange(v: string): void;
  placeholder: string;
}) {
  return (
    <div className='relative'>
      <span className='pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle'>
        <IconSearch />
      </span>
      <input
        type='search'
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className='block h-9 w-44 rounded-lg border border-edge-default bg-white pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56'
      />
    </div>
  );
}

function IconSearch() {
  return (
    <svg
      width='13'
      height='13'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.25'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      <circle cx='11' cy='11' r='7' />
      <path d='m20 20-3.5-3.5' />
    </svg>
  );
}
function IconClose() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.25'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      <path d='M18 6 6 18' />
      <path d='m6 6 12 12' />
    </svg>
  );
}

export default PullRequestList;
