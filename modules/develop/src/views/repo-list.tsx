import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  Tabs,
} from '@adhar-console/shell-ui';
import { formatRelative } from '@adhar-console/utils';
import type { gitea } from '@adhar-console/api-clients';
import { useBranches, useCommits, useIssues, usePullRequests, useRepos } from '../data/git.ts';
import { RepoMark } from '../components/repo-picker.tsx';
import { FileBrowser } from '../components/file-browser.tsx';

/**
 * Repository grid with a detail drawer that aggregates branches, commits,
 * PRs and issues for the chosen repo.
 */
export function RepoList() {
  const q = useRepos();
  const [search, setSearch] = useState('');
  const [openName, setOpenName] = useState<string | null>(null);

  if (q.isLoading) {
    return (
      <div className='flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm'>
        <Spinner size={14} /> Loading repos…
      </div>
    );
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Gitea"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
      />
    );
  }

  const all = q.data ?? [];
  const f = search.trim().toLowerCase();
  const list = f
    ? all.filter(
      (r) =>
        r.name.toLowerCase().includes(f) ||
        (r.description ?? '').toLowerCase().includes(f) ||
        (r.language ?? '').toLowerCase().includes(f),
    )
    : all;
  const open = all.find((r) => r.name === openName) ?? null;

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='text-[11px] text-content-muted'>
          {all.length} repositor{all.length === 1 ? 'y' : 'ies'} in this org
        </div>
        <div className='ml-auto'>
          <SearchInput value={search} onChange={setSearch} placeholder='Search repos…' />
        </div>
      </div>

      {list.length === 0
        ? (
          <EmptyState
            title={all.length === 0 ? 'No repositories' : 'No matches'}
            description={all.length === 0
              ? 'Connect a Gitea org in Settings → Integrations to populate this list.'
              : 'Try a different search term.'}
          />
        )
        : (
          <div className='grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3'>
            {list.map((r) => <RepoCard key={r.id} repo={r} onOpen={() => setOpenName(r.name)} />)}
          </div>
        )}

      {open ? <RepoDetail repo={open} onClose={() => setOpenName(null)} /> : null}
    </div>
  );
}

function RepoCard({ repo: r, onOpen }: { repo: gitea.Repo; onOpen(): void }) {
  return (
    <Card interactive>
      <button type='button' onClick={onOpen} className='block w-full p-5 text-left'>
        <div className='flex items-start gap-3'>
          <RepoMark name={r.name} />
          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-2'>
              <span className='truncate text-sm font-semibold text-content'>{r.name}</span>
              {r.private
                ? <StatusBadge kind='unknown'>private</StatusBadge>
                : <StatusBadge kind='info'>public</StatusBadge>}
            </div>
            <div className='mt-0.5 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-content-subtle'>
              <span className='rounded-md bg-surface-sunken px-1.5 py-0.5'>{r.default_branch}</span>
              {r.language ? <span>· {r.language}</span> : null}
            </div>
            {r.description
              ? (
                <p className='mt-2 line-clamp-2 text-xs leading-relaxed text-content-muted'>
                  {r.description}
                </p>
              )
              : null}
          </div>
        </div>
        <div className='mt-4 grid grid-cols-3 gap-2 text-center'>
          <Stat
            label='Issues'
            value={r.open_issues_count}
            accent={r.open_issues_count > 0 ? 'amber' : 'emerald'}
          />
          <Stat label='Stars' value={r.stars_count} accent='brand' />
          <Stat label='Forks' value={r.forks_count} />
        </div>
        <div className='mt-3 flex items-center justify-between gap-3 border-t border-edge-subtle pt-3 text-[11px] text-content-muted'>
          <span>Updated {formatRelative(r.updated_at)}</span>
          <span className='truncate'>{r.full_name}</span>
        </div>
      </button>
    </Card>
  );
}

function Stat({
  label,
  value,
  accent = 'slate',
}: {
  label: string;
  value: number;
  accent?: 'slate' | 'brand' | 'amber' | 'emerald';
}) {
  const tone = {
    slate: 'text-content',
    brand: 'text-brand-700',
    amber: 'text-amber-700',
    emerald: 'text-emerald-700',
  }[accent];
  return (
    <div className='rounded-md border border-edge-subtle bg-surface-sunken/40 p-2'>
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
        {label}
      </div>
    </div>
  );
}

function RepoDetail({ repo: r, onClose }: { repo: gitea.Repo; onClose(): void }) {
  const branches = useBranches(r.name);
  const commits = useCommits(r.name, r.default_branch, 8);
  const prs = usePullRequests(r.name, 'open');
  const issues = useIssues(r.name, 'open');

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
          <div className='flex min-w-0 items-start gap-3'>
            <RepoMark name={r.name} />
            <div className='min-w-0'>
              <div className='text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
                Repository
              </div>
              <h2 className='mt-0.5 truncate text-lg font-semibold tracking-tight text-content'>
                {r.full_name}
              </h2>
              {r.description
                ? <p className='mt-1 max-w-2xl text-xs text-content-muted'>{r.description}</p>
                : null}
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <a
              href={`?ide&repo=${encodeURIComponent(r.name)}`}
              className='inline-flex h-8 items-center rounded-md border border-edge-default bg-white px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700'
            >
              Open in IDE
            </a>
            <a
              href={r.html_url}
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
            ariaLabel='Repository detail'
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'files', label: 'Files' },
            ]}
          >
            {(active) =>
              active === 'files' ? <FileBrowser repo={r} /> : (
                <div className='space-y-5'>
                  <Card>
                    <CardBody className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                      <Tile label='Default branch' value={r.default_branch} />
                      <Tile label='Open issues' value={r.open_issues_count} />
                      <Tile label='Stars' value={r.stars_count} />
                      <Tile label='Forks' value={r.forks_count} />
                    </CardBody>
                  </Card>

                  <Detail
                    title={`Branches · ${branches.data?.length ?? 0}`}
                    loading={branches.isLoading}
                  >
                    {branches.data?.length
                      ? (
                        <ul className='divide-y divide-edge-subtle'>
                          {branches.data.map((b) => (
                            <li key={b.name} className='flex items-center gap-2 py-2 text-sm'>
                              <code className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content'>
                                {b.name}
                              </code>
                              {b.protected
                                ? <StatusBadge kind='info'>protected</StatusBadge>
                                : null}
                              <span className='ml-auto truncate text-[11px] text-content-subtle'>
                                {b.commit.message}
                              </span>
                              <span className='ml-3 text-[11px] text-content-muted'>
                                {formatRelative(b.commit.timestamp)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )
                      : <EmptyState compact title='No branches' />}
                  </Detail>

                  <Detail
                    title={`Recent commits · ${commits.data?.length ?? 0}`}
                    loading={commits.isLoading}
                  >
                    {commits.data?.length
                      ? (
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
                                  <span className='text-[11px] font-mono'>
                                    <span className='text-emerald-700'>+{c.stats.additions}</span>
                                    {' '}
                                    <span className='text-rose-700'>-{c.stats.deletions}</span>
                                  </span>
                                )
                                : null}
                            </li>
                          ))}
                        </ul>
                      )
                      : <EmptyState compact title='No commits yet' />}
                  </Detail>

                  <Detail title={`Open PRs · ${prs.data?.length ?? 0}`} loading={prs.isLoading}>
                    {prs.data?.length
                      ? (
                        <ul className='divide-y divide-edge-subtle'>
                          {prs.data.map((p) => (
                            <li key={p.id} className='flex items-center gap-2 py-2 text-sm'>
                              <code className='font-mono text-[10px] text-content-muted'>
                                #{p.number}
                              </code>
                              <span className='min-w-0 flex-1 truncate text-content'>
                                {p.title}
                              </span>
                              {p.head
                                ? (
                                  <span className='hidden font-mono text-[10px] text-content-subtle sm:inline'>
                                    {p.head.ref} → {p.base?.ref ?? 'main'}
                                  </span>
                                )
                                : null}
                              <img
                                src={p.user.avatar_url}
                                alt=''
                                className='h-5 w-5 rounded-full ring-1 ring-edge-subtle'
                              />
                            </li>
                          ))}
                        </ul>
                      )
                      : <EmptyState compact title='No open PRs' />}
                  </Detail>

                  <Detail
                    title={`Open issues · ${issues.data?.length ?? 0}`}
                    loading={issues.isLoading}
                  >
                    {issues.data?.length
                      ? (
                        <ul className='divide-y divide-edge-subtle'>
                          {issues.data.map((it) => (
                            <li key={it.id} className='flex items-center gap-2 py-2 text-sm'>
                              <code className='font-mono text-[10px] text-content-muted'>
                                #{it.number}
                              </code>
                              <span className='min-w-0 flex-1 truncate text-content'>
                                {it.title}
                              </span>
                              <div className='flex flex-wrap gap-1'>
                                {it.labels.map((l) => (
                                  <span
                                    key={l.name}
                                    className='rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset'
                                    style={{ color: `#${l.color}`, borderColor: `#${l.color}66` }}
                                  >
                                    {l.name}
                                  </span>
                                ))}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )
                      : <EmptyState compact title='No open issues' />}
                  </Detail>
                </div>
              )}
          </Tabs>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function Detail({
  title,
  loading,
  children,
}: {
  title: string;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className='flex items-center justify-between'>
          <div className='text-sm font-semibold text-content'>{title}</div>
          {loading ? <Spinner size={10} /> : null}
        </div>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className='rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3'>
      <div className='text-base font-semibold tabular-nums text-content'>{value}</div>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
        {label}
      </div>
    </div>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
}: {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
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

export default RepoList;
