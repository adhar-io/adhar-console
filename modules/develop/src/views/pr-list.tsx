import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, PageHeader } from '@adhar/shell-ui';
import { formatRelative } from '@adhar/utils';
import { type RepoPull, useOrgPullRequests, useRepos } from '../data/git.ts';
import { itemRef, parseItemRef, useDevelopParams, useGoDevelop, useSetDevelopParams } from '../data/nav.ts';
import { IconPlus, IconRefresh } from '../components/repo-bits.tsx';
import {
  AvatarStack,
  Avatar,
  Chip,
  ChipGroup,
  DiffBar,
  DiffStat,
  FilterSection,
  IconComment,
  IconFilter,
  LabelPill,
  LoadingBlock,
  Popover,
  prState,
  type PrState,
  PrStateIcon,
  SearchField,
  Segmented,
  type SortDef,
  SortMenu,
  StatTile,
  ToolbarBtn,
} from '../components/list-kit.tsx';
import { PrDrawer } from '../components/pr-drawer.tsx';
import { CommitDrawer } from '../components/commit-drawer.tsx';
import { NewPullModal } from '../components/tracker-modals.tsx';
import { RepoFilter, tally, useSlashFocus } from '../components/repo-filter.tsx';

/**
 * Pull requests across every repository in the org.
 *
 * Count tiles double as state filters; search, repo, author, label and size
 * filters narrow the list; sort covers age, activity and size. A row opens
 * the PR drawer (conversation, review, merge, commits, diff) and the open PR
 * is kept in the URL (`?pr=repo/42`), so links from the dashboard, the repo
 * drawer or a chat land on it directly.
 */

type View = 'open' | 'merged' | 'closed' | 'all';
type SortKey = 'updated' | 'created' | 'comments' | 'size';
type Size = 'any' | 'xs' | 's' | 'm' | 'l';

const SORTS: ReadonlyArray<SortDef<SortKey>> = [
  { key: 'updated', label: 'Recently updated', defaultDir: 'desc' },
  { key: 'created', label: 'Newest', defaultDir: 'desc' },
  { key: 'comments', label: 'Most discussed', defaultDir: 'desc' },
  { key: 'size', label: 'Largest change', defaultDir: 'desc' },
];

const SIZE: Record<Exclude<Size, 'any'>, { label: string; max: number }> = {
  xs: { label: 'XS · < 10 lines', max: 10 },
  s: { label: 'S · < 100', max: 100 },
  m: { label: 'M · < 500', max: 500 },
  l: { label: 'L · 500+', max: Infinity },
};
function sizeOf(p: RepoPull): Exclude<Size, 'any'> {
  const n = (p.additions ?? 0) + (p.deletions ?? 0);
  return n < 10 ? 'xs' : n < 100 ? 's' : n < 500 ? 'm' : 'l';
}

export function PullRequestList() {
  const params = useDevelopParams();
  const setParams = useSetDevelopParams();
  const go = useGoDevelop();
  const repos = useRepos();
  const view = (['open', 'merged', 'closed', 'all'].includes(params.state ?? '') ? params.state : 'open') as View;
  const repo = params.repo && repos.data?.some((r) => r.name === params.repo) ? params.repo : undefined;

  const openQ = useOrgPullRequests('open', repo);
  // Closed history is only fetched when it is being looked at, or to count it.
  const closedQ = useOrgPullRequests('closed', repo);

  const [search, setSearch] = useState('');
  const [author, setAuthor] = useState('all');
  const [label, setLabel] = useState('all');
  const [size, setSize] = useState<Size>('any');
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'updated', dir: 'desc' });
  const [creating, setCreating] = useState(false);
  const [commit, setCommit] = useState<{ repo: string; sha: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useSlashFocus(searchRef);

  const all = useMemo(() => [...(openQ.data ?? []), ...(closedQ.data ?? [])], [openQ.data, closedQ.data]);
  const counts = useMemo(() => {
    const c = { open: 0, draft: 0, merged: 0, closed: 0, conflicts: 0 };
    for (const p of all) {
      const s = prState(p);
      if (s === 'open' || s === 'draft') c.open++;
      if (s === 'draft') c.draft++;
      if (s === 'merged') c.merged++;
      if (s === 'closed') c.closed++;
      if (p.state === 'open' && p.mergeable === false) c.conflicts++;
    }
    return c;
  }, [all]);

  const inView = useMemo(() =>
    all.filter((p) => {
      const s = prState(p);
      if (view === 'open') return s === 'open' || s === 'draft';
      if (view === 'merged') return s === 'merged';
      if (view === 'closed') return s === 'closed';
      return true;
    }), [all, view]);

  const authors = useMemo(() => tally(inView.map((p) => p.user.login)), [inView]);
  const labels = useMemo(() => {
    const m = new Map<string, { color: string; n: number }>();
    for (const p of inView) for (const l of p.labels ?? []) m.set(l.name, { color: l.color, n: (m.get(l.name)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [inView]);

  const list = useMemo(() => {
    const f = search.trim().toLowerCase();
    const out = inView.filter((p) => {
      if (author !== 'all' && p.user.login !== author) return false;
      if (label !== 'all' && !(p.labels ?? []).some((l) => l.name === label)) return false;
      if (size !== 'any' && sizeOf(p) !== size) return false;
      if (onlyConflicts && !(p.state === 'open' && p.mergeable === false)) return false;
      if (f) {
        const hay = `${p.title} #${p.number} ${p.repo} ${p.user.login} ${p.head?.ref ?? ''} ${p.base?.ref ?? ''}`.toLowerCase();
        if (!hay.includes(f)) return false;
      }
      return true;
    });
    const sign = sort.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      switch (sort.key) {
        case 'created':
          return sign * a.created_at.localeCompare(b.created_at);
        case 'comments':
          return sign * ((a.comments ?? 0) - (b.comments ?? 0));
        case 'size':
          return sign * ((a.additions ?? 0) + (a.deletions ?? 0) - (b.additions ?? 0) - (b.deletions ?? 0));
        default:
          return sign * (a.updated_at ?? a.created_at).localeCompare(b.updated_at ?? b.created_at);
      }
    });
    return out;
  }, [inView, search, author, label, size, onlyConflicts, sort]);

  const ref = parseItemRef(params.pr);
  const openPr = ref ? all.find((p) => p.repo === ref.repo && p.number === ref.index) : undefined;
  const openRow = useCallback((p: RepoPull) => setParams({ pr: itemRef(p.repo, p.number) }), [setParams]);

  const chips = [
    author !== 'all' ? { k: 'author', label: `by ${author}`, clear: () => setAuthor('all') } : null,
    label !== 'all' ? { k: 'label', label: label, clear: () => setLabel('all') } : null,
    size !== 'any' ? { k: 'size', label: `size ${size.toUpperCase()}`, clear: () => setSize('any') } : null,
    onlyConflicts ? { k: 'conf', label: 'has conflicts', clear: () => setOnlyConflicts(false) } : null,
  ].filter(Boolean) as Array<{ k: string; label: string; clear(): void }>;
  const clearAll = () => {
    setSearch('');
    setAuthor('all');
    setLabel('all');
    setSize('any');
    setOnlyConflicts(false);
  };

  const loading = openQ.isLoading || (view !== 'open' && closedQ.isLoading);
  const error = openQ.error ?? (view !== 'open' ? closedQ.error : null);

  return (
    <div className='space-y-4'>
      <PageHeader
        title='Pull Requests'
        actions={
          <>
            <Button size='sm' variant='secondary' onClick={() => { openQ.refetch(); closedQ.refetch(); }} aria-label='Refresh' title='Refresh'>
              <IconRefresh />
            </Button>
            <Button variant='primary' size='sm' onClick={() => setCreating(true)}><IconPlus /> New pull request</Button>
          </>
        }
      />

      <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
        <StatTile label='Open' value={openQ.isLoading ? '…' : counts.open} tone='emerald' hint={counts.draft ? `${counts.draft} draft` : 'ready for review'} on={view === 'open' && !onlyConflicts} onClick={() => { setOnlyConflicts(false); setParams({ state: 'open' }); }} />
        <StatTile label='Conflicts' value={openQ.isLoading ? '…' : counts.conflicts} tone={counts.conflicts ? 'amber' : 'slate'} hint='need a rebase' on={onlyConflicts} onClick={() => { setParams({ state: 'open' }); setOnlyConflicts((x) => !x); }} />
        <StatTile label='Merged' value={closedQ.isLoading ? '…' : counts.merged} tone='violet' hint='recent history' on={view === 'merged'} onClick={() => setParams({ state: 'merged' })} />
        <StatTile label='Closed' value={closedQ.isLoading ? '…' : counts.closed} tone='slate' hint='without merging' on={view === 'closed'} onClick={() => setParams({ state: 'closed' })} />
        <StatTile label='All' value={closedQ.isLoading || openQ.isLoading ? '…' : all.length} hint={repo ? repo : `${repos.data?.filter((r) => !r.archived).length ?? 0} repositories`} on={view === 'all'} onClick={() => setParams({ state: 'all' })} />
      </div>

      <div className='rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm'>
        <div className='flex flex-wrap items-center gap-2'>
          <SearchField ref={searchRef} value={search} onChange={setSearch} placeholder='Search title, number, branch, author…' slashHint />
          <RepoFilter value={repo} onChange={(r) => setParams({ repo: r })} />
          <FiltersPopover
            count={chips.length}
            authors={authors}
            author={author}
            onAuthor={setAuthor}
            labels={labels}
            label={label}
            onLabel={setLabel}
            size={size}
            onSize={setSize}
            onClear={clearAll}
          />
          <SortMenu sorts={SORTS} sort={sort.key} dir={sort.dir} onSort={(key, dir) => setSort({ key, dir })} />
        </div>
        <div className='mt-2 flex flex-wrap items-center gap-1.5 px-0.5 text-[11px] text-content-subtle'>
          <span className='tabular-nums'>{list.length === inView.length ? `${inView.length} pull request${inView.length === 1 ? '' : 's'}` : `${list.length} of ${inView.length}`}</span>
          {repo ? <Chip onClear={() => setParams({ repo: undefined })}>{repo}</Chip> : null}
          {search ? <Chip onClear={() => setSearch('')}>“{search}”</Chip> : null}
          {chips.map((c) => <Chip key={c.k} onClear={c.clear}>{c.label}</Chip>)}
          {chips.length || search ? <button type='button' onClick={clearAll} className='ml-1 font-medium text-content-muted hover:text-content hover:underline'>Clear all</button> : null}
        </div>
      </div>

      {loading
        ? <LoadingBlock label='Loading pull requests…' />
        : error
        ? <EmptyState title="Couldn't reach Gitea" description={error instanceof Error ? error.message : String(error)} action={<Button size='sm' variant='secondary' onClick={() => openQ.refetch()}>Retry</Button>} />
        : list.length === 0
        ? (
          <EmptyState
            title={inView.length ? 'No matches' : view === 'open' ? 'No open pull requests' : `No ${view} pull requests`}
            description={inView.length ? 'Try a different search or clear the filters.' : view === 'open' ? 'Nothing waiting for review. Open one from a branch to start a review.' : 'Nothing here yet.'}
            action={inView.length
              ? <Button size='sm' variant='secondary' onClick={clearAll}>Clear filters</Button>
              : <Button variant='primary' size='sm' onClick={() => setCreating(true)}><IconPlus /> New pull request</Button>}
          />
        )
        : (
          <ul className='divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
            {list.map((p) => (
              <PrRow
                key={`${p.repo}#${p.number}`}
                pr={p}
                showRepo={!repo}
                onOpen={() => openRow(p)}
                onRepo={() => go('repos', { repo: p.repo })}
                onAuthor={() => setAuthor(p.user.login)}
                onLabel={(l) => setLabel(l)}
              />
            ))}
          </ul>
        )}

      {ref
        ? (
          <PrDrawer
            key={params.pr}
            seed={openPr}
            repo={ref.repo}
            index={ref.index}
            onClose={() => setParams({ pr: undefined })}
            onOpenCommit={(sha) => setCommit({ repo: ref.repo, sha })}
          />
        )
        : null}
      {commit ? <CommitDrawer repo={commit.repo} sha={commit.sha} onClose={() => setCommit(null)} onOpenSha={(sha) => setCommit({ ...commit, sha })} /> : null}

      <NewPullModal
        open={creating}
        onClose={() => setCreating(false)}
        defaults={{ repo }}
        onCreated={(pr) => {
          setCreating(false);
          setParams({ state: 'open', pr: itemRef(pr.repo, pr.number) });
        }}
      />
    </div>
  );
}

function PrRow({ pr, showRepo, onOpen, onRepo, onAuthor, onLabel }: {
  pr: RepoPull;
  showRepo: boolean;
  onOpen(): void;
  onRepo(): void;
  onAuthor(): void;
  onLabel(name: string): void;
}) {
  const s: PrState = prState(pr);
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <li
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className='group flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken/50 focus-visible:bg-surface-sunken/50 focus-visible:outline-none'
    >
      <span className='mt-0.5'><PrStateIcon state={s} /></span>
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          {showRepo
            ? <button type='button' onClick={stop(onRepo)} className='text-[12px] font-medium text-content-muted hover:text-brand-700 hover:underline'>{pr.repo}</button>
            : null}
          <span className='text-sm font-semibold text-content group-hover:text-brand-700 dark:group-hover:text-brand-300'>{pr.title}</span>
          {s === 'draft' ? <span className='rounded-full border border-edge-default px-1.5 text-[10px] font-medium text-content-muted'>draft</span> : null}
          {pr.state === 'open' && pr.mergeable === false ? <span className='rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>conflicts</span> : null}
          {(pr.labels ?? []).map((l) => <span key={l.name} onClick={stop(() => onLabel(l.name))}><LabelPill name={l.name} color={l.color} /></span>)}
        </div>
        <div className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-content-muted'>
          <span>#{pr.number}</span>
          <span>
            {s === 'merged' ? `merged ${formatRelative(pr.merged_at!)}` : s === 'closed' ? `closed ${pr.closed_at ? formatRelative(pr.closed_at) : ''}` : `opened ${formatRelative(pr.created_at)}`}
            {' by '}
            <button type='button' onClick={stop(onAuthor)} className='font-medium text-content hover:underline'>{pr.user.login}</button>
          </span>
          {pr.head
            ? (
              <span className='inline-flex items-center gap-1 font-mono text-[10.5px]'>
                <span className='rounded bg-surface-sunken px-1'>{pr.head.ref}</span>→<span className='rounded bg-surface-sunken px-1'>{pr.base?.ref}</span>
              </span>
            )
            : null}
          {pr.updated_at && s !== 'merged' ? <span>· updated {formatRelative(pr.updated_at)}</span> : null}
        </div>
      </div>
      <div className='hidden shrink-0 flex-col items-end gap-1 sm:flex'>
        <div className='flex items-center gap-3'>
          <AvatarStack people={pr.assignees ?? []} />
          {pr.comments ? <span className='flex items-center gap-1 text-[11px] text-content-muted'><IconComment /> {pr.comments}</span> : null}
          <Avatar login={pr.user.login} url={pr.user.avatar_url} size={22} />
        </div>
        {pr.additions != null
          ? (
            <span className='flex items-center gap-1.5'>
              <DiffStat add={pr.additions} del={pr.deletions} />
              <DiffBar add={pr.additions} del={pr.deletions} />
            </span>
          )
          : null}
      </div>
    </li>
  );
}

/* ─────────── filters ─────────── */

function FiltersPopover(p: {
  count: number;
  authors: Array<[string, number]>;
  author: string;
  onAuthor(a: string): void;
  labels: Array<[string, { color: string; n: number }]>;
  label: string;
  onLabel(l: string): void;
  size: Size;
  onSize(s: Size): void;
  onClear(): void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className='relative'>
      <ToolbarBtn on={open} onClick={() => setOpen((o) => !o)} badge={p.count} title='Filters'>
        <IconFilter /> Filters
      </ToolbarBtn>
      <Popover open={open} onClose={close} width='w-[22rem] max-w-[calc(100vw-2rem)]'>
        <FilterSection title='Size'>
          <Segmented<Size> value={p.size} onChange={p.onSize} options={[['any', 'Any'], ['xs', 'XS'], ['s', 'S'], ['m', 'M'], ['l', 'L']]} />
          <div className='mt-1 px-1 text-[10px] text-content-subtle'>{p.size === 'any' ? 'Lines added + removed' : SIZE[p.size].label}</div>
        </FilterSection>
        {p.authors.length
          ? (
            <FilterSection title='Author'>
              <ChipGroup value={p.author} onChange={p.onAuthor} options={[['all', 'Anyone'], ...p.authors.map(([a, n]) => [a, `${a} · ${n}`] as [string, string])]} />
            </FilterSection>
          )
          : null}
        {p.labels.length
          ? (
            <FilterSection title='Label'>
              <ChipGroup
                value={p.label}
                onChange={p.onLabel}
                options={[['all', 'Any'], ...p.labels.map(([l, v]) => [l, `${l} · ${v.n}`] as [string, string])]}
                swatch={(v) => (v === 'all' ? undefined : `#${p.labels.find(([l]) => l === v)?.[1].color}`)}
              />
            </FilterSection>
          )
          : null}
        <div className='mt-1 flex items-center justify-between border-t border-edge-subtle px-1 pt-2'>
          <button type='button' onClick={p.onClear} className='text-[11px] font-medium text-content-muted hover:text-content'>Reset</button>
          <button type='button' onClick={close} className='rounded-md bg-surface-sunken px-2.5 py-1 text-[11px] font-medium text-content hover:bg-edge-subtle'>Done</button>
        </div>
      </Popover>
    </div>
  );
}

export default PullRequestList;
