import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, PageHeader } from '@adhar/shell-ui';
import { formatRelative } from '@adhar/utils';
import { type RepoIssue, useOrgIssues, useRepos } from '../data/git.ts';
import { itemRef, parseItemRef, useDevelopParams, useGoDevelop, useSetDevelopParams } from '../data/nav.ts';
import { IconPlus, IconRefresh } from '../components/repo-bits.tsx';
import {
  Avatar,
  AvatarStack,
  Chip,
  ChipGroup,
  FilterSection,
  IconComment,
  IconFilter,
  IssueStateIcon,
  LabelPill,
  LoadingBlock,
  Popover,
  SearchField,
  type SortDef,
  SortMenu,
  StatTile,
  ToolbarBtn,
} from '../components/list-kit.tsx';
import { IssueDrawer } from '../components/issue-drawer.tsx';
import { NewIssueModal } from '../components/tracker-modals.tsx';
import { RepoFilter, tally, useSlashFocus } from '../components/repo-filter.tsx';

/**
 * Issues across every repository in the org — the same browser as pull
 * requests: state tiles, search, repo scope, author / assignee / label /
 * milestone filters and sort. The open issue lives in the URL
 * (`?issue=repo/12`) so it can be linked to.
 */

type View = 'open' | 'closed' | 'all';
type SortKey = 'updated' | 'created' | 'comments';
type Quick = 'none' | 'unassigned' | 'stale' | 'unlabelled';

const SORTS: ReadonlyArray<SortDef<SortKey>> = [
  { key: 'updated', label: 'Recently updated', defaultDir: 'desc' },
  { key: 'created', label: 'Newest', defaultDir: 'desc' },
  { key: 'comments', label: 'Most discussed', defaultDir: 'desc' },
];

const STALE_MS = 30 * 86_400_000;

export function Issues() {
  const params = useDevelopParams();
  const setParams = useSetDevelopParams();
  const go = useGoDevelop();
  const repos = useRepos();
  const view = (['open', 'closed', 'all'].includes(params.state ?? '') ? params.state : 'open') as View;
  const repo = params.repo && repos.data?.some((r) => r.name === params.repo) ? params.repo : undefined;

  const openQ = useOrgIssues('open', repo);
  const closedQ = useOrgIssues('closed', repo);

  const [search, setSearch] = useState('');
  const [author, setAuthor] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [label, setLabel] = useState('all');
  const [milestone, setMilestone] = useState('all');
  const [quick, setQuick] = useState<Quick>('none');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'updated', dir: 'desc' });
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);

  const now = Date.now();
  const all = useMemo(() => [...(openQ.data ?? []), ...(closedQ.data ?? [])], [openQ.data, closedQ.data]);
  const open = openQ.data ?? [];
  const counts = {
    open: open.length,
    closed: closedQ.data?.length ?? 0,
    unassigned: open.filter((i) => !i.assignees?.length).length,
    stale: open.filter((i) => now - Date.parse(i.updated_at ?? i.created_at) > STALE_MS).length,
    unlabelled: open.filter((i) => !i.labels.length).length,
  };

  const inView = useMemo(() => (view === 'open' ? openQ.data ?? [] : view === 'closed' ? closedQ.data ?? [] : all), [view, openQ.data, closedQ.data, all]);
  const authors = useMemo(() => tally(inView.map((i) => i.user.login)), [inView]);
  const assignees = useMemo(() => tally(inView.flatMap((i) => (i.assignees ?? []).map((a) => a.login))), [inView]);
  const milestones = useMemo(() => tally(inView.map((i) => i.milestone?.title).filter((x): x is string => !!x)), [inView]);
  const labels = useMemo(() => {
    const m = new Map<string, { color: string; n: number }>();
    for (const i of inView) for (const l of i.labels) m.set(l.name, { color: l.color, n: (m.get(l.name)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [inView]);

  const list = useMemo(() => {
    const f = search.trim().toLowerCase();
    const out = inView.filter((i) => {
      if (author !== 'all' && i.user.login !== author) return false;
      if (assignee === '__none' && i.assignees?.length) return false;
      if (assignee !== 'all' && assignee !== '__none' && !(i.assignees ?? []).some((a) => a.login === assignee)) return false;
      if (label !== 'all' && !i.labels.some((l) => l.name === label)) return false;
      if (milestone !== 'all' && i.milestone?.title !== milestone) return false;
      if (quick === 'unassigned' && i.assignees?.length) return false;
      if (quick === 'stale' && now - Date.parse(i.updated_at ?? i.created_at) <= STALE_MS) return false;
      if (quick === 'unlabelled' && i.labels.length) return false;
      if (f && !`${i.title} #${i.number} ${i.repo} ${i.user.login} ${i.labels.map((l) => l.name).join(' ')}`.toLowerCase().includes(f)) return false;
      return true;
    });
    const sign = sort.dir === 'asc' ? 1 : -1;
    out.sort((a, b) =>
      sort.key === 'created'
        ? sign * a.created_at.localeCompare(b.created_at)
        : sort.key === 'comments'
        ? sign * ((a.comments ?? 0) - (b.comments ?? 0))
        : sign * (a.updated_at ?? a.created_at).localeCompare(b.updated_at ?? b.created_at)
    );
    return out;
  }, [inView, search, author, assignee, label, milestone, quick, sort, now]);

  const ref = parseItemRef(params.issue);
  const seed = ref ? all.find((i) => i.repo === ref.repo && i.number === ref.index) : undefined;

  const setQuickOpen = (q: Quick) => {
    setParams({ state: 'open' });
    setQuick((cur) => (cur === q ? 'none' : q));
  };
  const chips = [
    author !== 'all' ? { k: 'a', label: `by ${author}`, clear: () => setAuthor('all') } : null,
    assignee !== 'all' ? { k: 'as', label: assignee === '__none' ? 'no assignee' : `assigned ${assignee}`, clear: () => setAssignee('all') } : null,
    label !== 'all' ? { k: 'l', label, clear: () => setLabel('all') } : null,
    milestone !== 'all' ? { k: 'm', label: `milestone ${milestone}`, clear: () => setMilestone('all') } : null,
    quick !== 'none' ? { k: 'q', label: quick, clear: () => setQuick('none') } : null,
  ].filter(Boolean) as Array<{ k: string; label: string; clear(): void }>;
  const clearAll = () => {
    setSearch('');
    setAuthor('all');
    setAssignee('all');
    setLabel('all');
    setMilestone('all');
    setQuick('none');
  };

  const loading = openQ.isLoading || (view !== 'open' && closedQ.isLoading);
  const error = openQ.error ?? (view !== 'open' ? closedQ.error : null);

  return (
    <div className='space-y-4'>
      <PageHeader
        title='Issues'
        actions={
          <>
            <Button size='sm' variant='secondary' onClick={() => { openQ.refetch(); closedQ.refetch(); }} aria-label='Refresh' title='Refresh'><IconRefresh /></Button>
            <Button variant='primary' size='sm' onClick={() => setCreating(true)}><IconPlus /> New issue</Button>
          </>
        }
      />

      <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6'>
        <StatTile label='Open' value={openQ.isLoading ? '…' : openQ.isError ? '—' : counts.open} tone='emerald' on={view === 'open' && quick === 'none'} hint='need attention' onClick={() => { setQuick('none'); setParams({ state: 'open' }); }} />
        <StatTile label='Unassigned' value={openQ.isLoading ? '…' : openQ.isError ? '—' : counts.unassigned} tone={counts.unassigned ? 'amber' : 'slate'} on={quick === 'unassigned'} hint='nobody owns these' onClick={() => setQuickOpen('unassigned')} />
        <StatTile label='Stale' value={openQ.isLoading ? '…' : openQ.isError ? '—' : counts.stale} tone={counts.stale ? 'amber' : 'slate'} on={quick === 'stale'} hint='quiet 30+ days' onClick={() => setQuickOpen('stale')} />
        <StatTile label='Unlabelled' value={openQ.isLoading ? '…' : openQ.isError ? '—' : counts.unlabelled} tone='info' on={quick === 'unlabelled'} hint='need triage' onClick={() => setQuickOpen('unlabelled')} />
        <StatTile label='Closed' value={closedQ.isLoading ? '…' : closedQ.isError ? '—' : counts.closed} tone='violet' on={view === 'closed'} hint='recent history' onClick={() => { setQuick('none'); setParams({ state: 'closed' }); }} />
        <StatTile label='All' value={openQ.isLoading || closedQ.isLoading ? '…' : openQ.isError || closedQ.isError ? '—' : all.length} on={view === 'all'} hint={repo ?? 'across the org'} onClick={() => { setQuick('none'); setParams({ state: 'all' }); }} />
      </div>

      <div className='rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm'>
        <div className='flex flex-wrap items-center gap-2'>
          <SearchField ref={searchRef} value={search} onChange={setSearch} placeholder='Search title, number, label, author…' slashHint />
          <RepoFilter value={repo} onChange={(r) => setParams({ repo: r })} />
          <IssueFilters
            count={chips.length - (quick !== 'none' ? 1 : 0)}
            authors={authors}
            author={author}
            onAuthor={setAuthor}
            assignees={assignees}
            assignee={assignee}
            onAssignee={setAssignee}
            labels={labels}
            label={label}
            onLabel={setLabel}
            milestones={milestones}
            milestone={milestone}
            onMilestone={setMilestone}
            onClear={clearAll}
          />
          <SortMenu sorts={SORTS} sort={sort.key} dir={sort.dir} onSort={(key, dir) => setSort({ key, dir })} />
        </div>
        <div className='mt-2 flex flex-wrap items-center gap-1.5 px-0.5 text-[11px] text-content-subtle'>
          <span className='tabular-nums'>{list.length === inView.length ? `${inView.length} issue${inView.length === 1 ? '' : 's'}` : `${list.length} of ${inView.length}`}</span>
          {repo ? <Chip onClear={() => setParams({ repo: undefined })}>{repo}</Chip> : null}
          {search ? <Chip onClear={() => setSearch('')}>“{search}”</Chip> : null}
          {chips.map((c) => <Chip key={c.k} onClear={c.clear}>{c.label}</Chip>)}
          {chips.length || search ? <button type='button' onClick={clearAll} className='ml-1 font-medium text-content-muted hover:text-content hover:underline'>Clear all</button> : null}
        </div>
      </div>

      {loading
        ? <LoadingBlock label='Loading issues…' />
        : error
        ? <EmptyState title="Couldn't reach Gitea" description={error instanceof Error ? error.message : String(error)} action={<Button size='sm' variant='secondary' onClick={() => openQ.refetch()}>Retry</Button>} />
        : list.length === 0
        ? (
          <EmptyState
            title={inView.length ? 'No matches' : view === 'open' ? 'No open issues' : `No ${view} issues`}
            description={inView.length ? 'Try a different search or clear the filters.' : 'Report a bug or propose an enhancement to get started.'}
            action={inView.length
              ? <Button size='sm' variant='secondary' onClick={clearAll}>Clear filters</Button>
              : <Button variant='primary' size='sm' onClick={() => setCreating(true)}><IconPlus /> New issue</Button>}
          />
        )
        : (
          <ul className='divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
            {list.map((i) => (
              <IssueRow
                key={`${i.repo}#${i.number}`}
                issue={i}
                showRepo={!repo}
                onOpen={() => setParams({ issue: itemRef(i.repo, i.number) })}
                onRepo={() => go('repos', { repo: i.repo })}
                onAuthor={() => setAuthor(i.user.login)}
                onLabel={setLabel}
              />
            ))}
          </ul>
        )}

      {ref ? <IssueDrawer key={params.issue} seed={seed} repo={ref.repo} index={ref.index} onClose={() => setParams({ issue: undefined })} /> : null}

      <NewIssueModal
        open={creating}
        onClose={() => setCreating(false)}
        defaultRepo={repo}
        onCreated={(i) => {
          setCreating(false);
          setParams({ state: 'open', issue: itemRef(i.repo, i.number) });
        }}
      />
    </div>
  );
}

function IssueRow({ issue: i, showRepo, onOpen, onRepo, onAuthor, onLabel }: {
  issue: RepoIssue;
  showRepo: boolean;
  onOpen(): void;
  onRepo(): void;
  onAuthor(): void;
  onLabel(l: string): void;
}) {
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
      <span className='mt-0.5'><IssueStateIcon state={i.state} /></span>
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          {showRepo ? <button type='button' onClick={stop(onRepo)} className='text-[12px] font-medium text-content-muted hover:text-brand-700 hover:underline'>{i.repo}</button> : null}
          <span className='text-sm font-semibold text-content group-hover:text-brand-700 dark:group-hover:text-brand-300'>{i.title}</span>
          {i.labels.map((l) => <span key={l.name} onClick={stop(() => onLabel(l.name))}><LabelPill name={l.name} color={l.color} /></span>)}
        </div>
        <div className='mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-content-muted'>
          <span>#{i.number}</span>
          <span>
            {i.state === 'closed' && i.closed_at ? `closed ${formatRelative(i.closed_at)}` : `opened ${formatRelative(i.created_at)}`} by{' '}
            <button type='button' onClick={stop(onAuthor)} className='font-medium text-content hover:underline'>{i.user.login}</button>
          </span>
          {i.milestone ? <span>· {i.milestone.title}</span> : null}
          {i.updated_at && i.state === 'open' ? <span>· updated {formatRelative(i.updated_at)}</span> : null}
        </div>
      </div>
      <div className='hidden shrink-0 items-center gap-3 sm:flex'>
        <AvatarStack people={i.assignees ?? []} />
        {i.comments ? <span className='flex items-center gap-1 text-[11px] text-content-muted'><IconComment /> {i.comments}</span> : null}
        <Avatar login={i.user.login} url={i.user.avatar_url} size={22} />
      </div>
    </li>
  );
}

function IssueFilters(p: {
  count: number;
  authors: Array<[string, number]>;
  author: string;
  onAuthor(v: string): void;
  assignees: Array<[string, number]>;
  assignee: string;
  onAssignee(v: string): void;
  labels: Array<[string, { color: string; n: number }]>;
  label: string;
  onLabel(v: string): void;
  milestones: Array<[string, number]>;
  milestone: string;
  onMilestone(v: string): void;
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
        <FilterSection title='Assignee'>
          <ChipGroup value={p.assignee} onChange={p.onAssignee} options={[['all', 'Anyone'], ['__none', 'Nobody'], ...p.assignees.map(([a, n]) => [a, `${a} · ${n}`] as [string, string])]} />
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
        {p.milestones.length
          ? (
            <FilterSection title='Milestone'>
              <ChipGroup value={p.milestone} onChange={p.onMilestone} options={[['all', 'Any'], ...p.milestones.map(([m, n]) => [m, `${m} · ${n}`] as [string, string])]} />
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
