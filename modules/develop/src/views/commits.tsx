import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, PageHeader, Select, useToast } from '@adhar/shell-ui';
import { cn, formatRelative } from '@adhar/utils';
import type { gitea } from '@adhar/api-clients';
import { useBranches, useCommitHistory, useRepos } from '../data/git.ts';
import { useDevelopParams, useSetDevelopParams } from '../data/nav.ts';
import { useScopedRepo } from '../components/repo-scope.tsx';
import { RepoPicker } from '../components/repo-picker.tsx';
import { copy, IconCopy, IconRefresh } from '../components/repo-bits.tsx';
import { Avatar, ChipGroup, DiffStat, GiteaError, IconCommit, LoadingBlock, SearchField, StatTile, SwapFrame } from '../components/list-kit.tsx';
import { useSlashFocus } from '../components/repo-filter.tsx';
import { CommitDrawer } from '../components/commit-drawer.tsx';

/**
 * Commit history of one branch, newest first, grouped by day. History is
 * paged from Gitea ("Load older commits"); a path narrows it server-side to
 * the commits that touched a file or folder. Search and the author chips
 * filter what is loaded. A commit opens in a drawer with its full diff, and
 * the open commit and branch are in the URL.
 */
export function Commits() {
  const { repo, setRepo, repos } = useScopedRepo();
  if (repos.isLoading) return <><PageHeader title='Commits' /><LoadingBlock label='Loading repositories…' /></>;
  if (repos.isError && !repos.data) return <><PageHeader title='Commits' /><GiteaError what='repositories' error={repos.error} onRetry={() => repos.refetch()} retrying={repos.isFetching} /></>;
  if (!repos.data?.length || !repo) return <><PageHeader title='Commits' /><EmptyState title='No repositories' description='Create a repository first.' /></>;
  // Not keyed by repo: the previous history stays (dimmed) until the new one lands.
  return <CommitBrowser repo={repo} picker={<RepoPicker value={repo} onChange={setRepo} />} />;
}

function CommitBrowser({ repo, picker }: { repo: string; picker: React.ReactNode }) {
  const params = useDevelopParams();
  const setParams = useSetDevelopParams();
  const repos = useRepos();
  const branches = useBranches(repo);
  const meta = repos.data?.find((r) => r.name === repo);
  const def = meta?.default_branch;
  // Start on the default branch straight from the repo list rather than
  // waiting for the branch list first (repos → branches → commits was three
  // round trips in a row). A `?branch=` is trusted until the list proves it
  // does not exist.
  const branch = params.branch && (!branches.data || branches.isPlaceholderData || branches.data.some((b) => b.name === params.branch))
    ? params.branch
    : def ?? branches.data?.[0]?.name;

  const [pathInput, setPathInput] = useState('');
  const [path, setPath] = useState('');
  useEffect(() => {
    const t = globalThis.setTimeout(() => setPath(pathInput.trim().replace(/^\/+/, '')), 400);
    return () => globalThis.clearTimeout(t);
  }, [pathInput]);

  const q = useCommitHistory(repo, meta?.empty ? undefined : branch, path || undefined);
  const [search, setSearch] = useState('');
  const [author, setAuthor] = useState('all');
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  // Another repository: its authors and paths are not this one's.
  const [shownRepo, setShownRepo] = useState(repo);
  if (shownRepo !== repo) {
    setShownRepo(repo);
    setAuthor('all');
    setPathInput('');
    setPath('');
  }

  const loaded = useMemo(() => q.data?.pages.flat() ?? [], [q.data]);
  const authors = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of loaded) m.set(c.author.login, (m.get(c.author.login) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [loaded]);

  const list = useMemo(() => {
    const f = search.trim().toLowerCase();
    return loaded.filter((c) =>
      (author === 'all' || c.author.login === author) &&
      (!f || c.message.toLowerCase().includes(f) || c.sha.startsWith(f) || c.author.login.toLowerCase().includes(f))
    );
  }, [loaded, search, author]);

  const days = useMemo(() => {
    const groups: Array<{ day: string; items: gitea.Commit[] }> = [];
    for (const c of list) {
      const day = new Date(c.created).toDateString();
      const g = groups[groups.length - 1];
      if (g && g.day === day) g.items.push(c);
      else groups.push({ day, items: [c] });
    }
    return groups;
  }, [list]);

  const totals = useMemo(() => {
    let add = 0, del = 0;
    for (const c of list) {
      add += c.stats?.additions ?? 0;
      del += c.stats?.deletions ?? 0;
    }
    return { add, del };
  }, [list]);

  const week = loaded.filter((c) => Date.now() - Date.parse(c.created) < 7 * 86_400_000).length;

  return (
    <div className='space-y-4'>
      <PageHeader
        title='Commits'
        badge={picker}
        actions={<Button size='sm' variant='secondary' onClick={() => q.refetch()} loading={q.isRefetching && !q.isPlaceholderData && !q.isFetchingNextPage} aria-label='Refresh' title='Refresh'>{q.isRefetching && !q.isPlaceholderData && !q.isFetchingNextPage ? null : <IconRefresh />}</Button>}
      />

      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        <StatTile label='Commits loaded' value={q.isLoading ? '…' : loaded.length} hint={q.hasNextPage ? 'more available' : 'full history'} />
        <StatTile label='This week' value={q.isLoading ? '…' : week} tone='emerald' hint='last 7 days' />
        <StatTile label='Authors' value={authors.length} tone='brand' hint={authors[0] ? `top: ${authors[0][0]}` : undefined} />
        <StatTile label='Lines changed' value={totals.add + totals.del} tone='violet' hint={`+${totals.add} / −${totals.del}`} />
      </div>

      <div className='rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm'>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='w-48'>
            <Select
              aria-label='Branch'
              value={branch ?? ''}
              onChange={(e) => setParams({ branch: e.target.value, sha: undefined })}
              options={(branches.data ?? []).map((b) => ({ value: b.name, label: b.name === def ? `${b.name} (default)` : b.name }))}
              disabled={!branches.data?.length}
            />
          </div>
          <div className='relative w-56'>
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder='Path, e.g. src/api'
              aria-label='Only commits touching this path'
              className='block h-9 w-full rounded-lg border border-edge-default bg-surface-app px-2.5 font-mono text-[12px] text-content placeholder:font-sans placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'
            />
          </div>
          <SearchField ref={searchRef} value={search} onChange={setSearch} placeholder='Search messages, SHAs, authors…' slashHint />
        </div>
        {authors.length > 1
          ? (
            <div className='mt-2 px-0.5'>
              <ChipGroup value={author} onChange={setAuthor} options={[['all', 'All authors'], ...authors.slice(0, 10).map(([a, n]) => [a, `${a} · ${n}`] as [string, string])]} />
            </div>
          )
          : null}
      </div>

      {meta?.empty || (branches.data && !branches.isPlaceholderData && !branches.data.length)
        ? <EmptyState title='No commits yet' description={`${repo} is empty — push a first commit to start its history.`} />
        : q.isLoading || (!branch && branches.isLoading)
        ? <LoadingBlock label='Loading commits…' rows={8} />
        : q.isError && !q.data
        ? <GiteaError what={`commits of ${repo}`} error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
        : list.length === 0
        ? <EmptyState title={loaded.length ? 'No matches' : 'No commits'} description={loaded.length ? 'Try another search or author.' : path ? `Nothing on ${branch} touched ${path}.` : `No commits on ${branch}.`} />
        : (
          <SwapFrame pending={q.isPlaceholderData} className='space-y-4'>
            {days.map((g) => (
              <section key={g.day}>
                <h2 className='mb-1.5 flex items-center gap-2 text-[12px] font-semibold text-content-muted'>
                  <IconCommit /> Commits on {new Date(g.items[0].created).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  <span className='rounded-full bg-surface-sunken px-1.5 text-[10px] tabular-nums'>{g.items.length}</span>
                </h2>
                <ul className='divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
                  {g.items.map((c) => (
                    <CommitRow key={c.sha} commit={c} active={params.sha === c.sha} onOpen={() => setParams({ sha: c.sha })} onAuthor={() => setAuthor(c.author.login)} />
                  ))}
                </ul>
              </section>
            ))}
            <div className='flex justify-center'>
              {q.hasNextPage
                ? <Button size='sm' variant='secondary' loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load older commits</Button>
                : <span className='text-[11px] text-content-subtle'>Beginning of history{path ? ` for ${path}` : ''}.</span>}
            </div>
          </SwapFrame>
        )}

      {params.sha
        ? <CommitDrawer key={params.sha} repo={repo} sha={params.sha} onClose={() => setParams({ sha: undefined })} onOpenSha={(sha) => setParams({ sha })} />
        : null}
    </div>
  );
}

function CommitRow({ commit: c, active, onOpen, onAuthor }: { commit: gitea.Commit; active: boolean; onOpen(): void; onAuthor(): void }) {
  const toast = useToast();
  const [subject, ...rest] = c.message.split('\n');
  const body = rest.join('\n').trim();
  const [expanded, setExpanded] = useState(false);
  return (
    <li
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className={cn('group flex cursor-pointer items-start gap-3 px-4 py-2.5 transition-colors hover:bg-surface-sunken/50 focus-visible:outline-none', active && 'bg-brand-50/60 dark:bg-brand-500/10')}
    >
      <span className='mt-0.5'><Avatar login={c.author.login} url={c.author.avatar_url} size={26} /></span>
      <div className='min-w-0 flex-1'>
        <div className='flex items-center gap-1.5'>
          <span className='truncate text-[13px] font-semibold text-content group-hover:text-brand-700 dark:group-hover:text-brand-300'>{subject}</span>
          {body
            ? (
              <button
                type='button'
                onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }}
                aria-label={expanded ? 'Hide message' : 'Show full message'}
                className='shrink-0 rounded bg-surface-sunken px-1 text-[10px] font-bold leading-4 text-content-muted hover:text-content'
              >
                …
              </button>
            )
            : null}
        </div>
        {expanded ? <pre className='mt-1 whitespace-pre-wrap font-sans text-[12px] text-content-muted'>{body}</pre> : null}
        <div className='mt-0.5 text-[11px] text-content-subtle'>
          <button type='button' onClick={(e) => { e.stopPropagation(); onAuthor(); }} className='font-medium text-content-muted hover:text-content hover:underline'>{c.author.login}</button>
           committed <span title={c.created}>{formatRelative(c.created)}</span>
        </div>
      </div>
      {c.stats ? <span className='mt-0.5 hidden sm:block'><DiffStat add={c.stats.additions} del={c.stats.deletions} /></span> : null}
      <div className='flex shrink-0 items-center overflow-hidden rounded-md border border-edge-default' onClick={(e) => e.stopPropagation()}>
        <button type='button' onClick={() => copy(c.sha, toast)} aria-label='Copy full SHA' title='Copy full SHA' className='flex h-7 w-7 items-center justify-center text-content-subtle hover:bg-surface-sunken hover:text-content'>
          <IconCopy />
        </button>
        <button type='button' onClick={onOpen} className='h-7 border-l border-edge-default px-2 font-mono text-[11px] text-brand-700 hover:bg-surface-sunken dark:text-brand-300'>
          {c.short_sha}
        </button>
      </div>
    </li>
  );
}
