import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, EmptyState, Field, Input, Modal, PageHeader, Select, useToast } from '@adhar/shell-ui';
import { cn, formatRelative } from '@adhar/utils';
import type { gitea } from '@adhar/api-clients';
import {
  useAheadBehind,
  useBranches,
  useBranchProtections,
  useCreateBranch,
  useDeleteBranch,
  pullRequestsBlocked,
  useOrgPullRequests,
  useProtectBranch,
  useRepos,
  useUnprotectBranch,
} from '../data/git.ts';
import { itemRef, useDevelopParams, useGoDevelop } from '../data/nav.ts';
import { useScopedRepo } from '../components/repo-scope.tsx';
import { RepoPicker } from '../components/repo-picker.tsx';
import { copy, IconPlus, IconRefresh, IconShield } from '../components/repo-bits.tsx';
import {
  GiteaError,
  IconBranchSmall,
  LoadingBlock,
  MenuItem,
  MoreMenu,
  prState,
  PrStateIcon,
  SearchField,
  Segmented,
  type SortDef,
  SortMenu,
  StatTile,
  SwapFrame,
} from '../components/list-kit.tsx';
import { useSlashFocus } from '../components/repo-filter.tsx';
import { useAct } from '../components/tracker-bits.tsx';
import { NewPullModal } from '../components/tracker-modals.tsx';
import { CommitDrawer } from '../components/commit-drawer.tsx';

/**
 * Branches of one repository.
 *
 * The default branch sits on its own above the rest. Every other branch shows
 * how far it has drifted (commits behind / ahead of the default), its last
 * commit, and the pull request it belongs to — and can be compared, opened as
 * a PR, browsed, protected or deleted from its ⋯ menu.
 */

type Filter = 'all' | 'active' | 'stale' | 'protected' | 'pr' | 'nopr';
type SortKey = 'updated' | 'name';

const SORTS: ReadonlyArray<SortDef<SortKey>> = [
  { key: 'updated', label: 'Last commit', defaultDir: 'desc' },
  { key: 'name', label: 'Name', defaultDir: 'asc' },
];

const ACTIVE_MS = 14 * 86_400_000;
const STALE_MS = 90 * 86_400_000;
/** Compares cost two requests each — only the first rows get them. */
const COMPARE_LIMIT = 40;

export function Branches() {
  const { repo, setRepo, repos } = useScopedRepo();
  const [creating, setCreating] = useState<string | null>(null);
  const [newPr, setNewPr] = useState<string | null>(null);
  const go = useGoDevelop();
  const prBlocked = pullRequestsBlocked(repos.data?.find((r) => r.name === repo));

  if (repos.isLoading) return <><PageHeader title='Branches' /><BranchesSkeleton /></>;
  if (repos.isError && !repos.data) return <><PageHeader title='Branches' /><GiteaError what='repositories' error={repos.error} onRetry={() => repos.refetch()} retrying={repos.isFetching} /></>;
  if (!repos.data?.length || !repo) return <><PageHeader title='Branches' /><EmptyState title='No repositories' description='Create a repository first.' /></>;

  return (
    <div className='space-y-4'>
      <PageHeader
        title='Branches'
        badge={<RepoPicker value={repo} onChange={setRepo} />}
        actions={
          <>
            {prBlocked ? null : <Button size='sm' variant='secondary' onClick={() => setNewPr('')}>New pull request</Button>}
            <Button variant='primary' size='sm' onClick={() => setCreating('')}><IconPlus /> New branch</Button>
          </>
        }
      />
      {prBlocked ? (
        <div className='rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
          {prBlocked}
        </div>
      ) : null}
      {/* Not keyed by repo: switching keeps the previous list on screen (dimmed)
          until the new repository's branches arrive, instead of blanking. */}
      <BranchBrowser repo={repo} onNewBranch={(from) => setCreating(from)} onNewPr={prBlocked ? undefined : (head) => setNewPr(head)} />
      <NewBranchModal repo={repo} from={creating} onClose={() => setCreating(null)} />
      <NewPullModal
        open={newPr !== null}
        onClose={() => setNewPr(null)}
        defaults={{ repo, head: newPr || undefined }}
        onCreated={(pr) => {
          setNewPr(null);
          go('prs', { repo: pr.repo, pr: itemRef(pr.repo, pr.number), state: 'open' });
        }}
      />
    </div>
  );
}

function BranchBrowser({ repo, onNewBranch, onNewPr }: { repo: string; onNewBranch(from: string): void; onNewPr?(head: string): void }) {
  const repos = useRepos();
  const r = repos.data?.find((x) => x.name === repo);
  const q = useBranches(repo);
  const prs = useOrgPullRequests('all', repo);
  const prot = useBranchProtections(repo);
  const go = useGoDevelop();
  const params = useDevelopParams();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'updated', dir: 'desc' });
  const [confirmDel, setConfirmDel] = useState<gitea.Branch | null>(null);
  const [protecting, setProtecting] = useState<string | null>(null);
  const [commit, setCommit] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  // A different repository: drop the per-branch overlays of the previous one.
  const [shownRepo, setShownRepo] = useState(repo);
  if (shownRepo !== repo) {
    setShownRepo(repo);
    setConfirmDel(null);
    setProtecting(null);
    setCommit(null);
  }

  const del = useDeleteBranch();
  const unprotect = useUnprotectBranch();
  const act = useAct();
  const toast = useToast();
  const now = Date.now();

  const def = r?.default_branch;
  const all = q.data ?? [];
  const defBranch = all.find((b) => b.name === def);

  // Newest PR per head branch.
  const prByBranch = useMemo(() => {
    const m = new Map<string, (typeof prs.data & object)[number]>();
    for (const p of (prs.data ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at))) if (p.head?.ref) m.set(p.head.ref, p);
    return m;
  }, [prs.data]);

  const others = all.filter((b) => b.name !== def);
  const age = (b: gitea.Branch) => now - Date.parse(b.commit.timestamp);
  const counts = {
    total: all.length,
    protected: all.filter((b) => b.protected).length,
    active: others.filter((b) => age(b) <= ACTIVE_MS).length,
    stale: others.filter((b) => age(b) > STALE_MS).length,
    pr: others.filter((b) => prByBranch.get(b.name)?.state === 'open').length,
  };

  const list = useMemo(() => {
    const f = search.trim().toLowerCase();
    const out = others.filter((b) => {
      if (filter === 'active' && age(b) > ACTIVE_MS) return false;
      if (filter === 'stale' && age(b) <= STALE_MS) return false;
      if (filter === 'protected' && !b.protected) return false;
      if (filter === 'pr' && prByBranch.get(b.name)?.state !== 'open') return false;
      if (filter === 'nopr' && prByBranch.has(b.name)) return false;
      if (f && !`${b.name} ${b.commit.message} ${b.commit.author.name}`.toLowerCase().includes(f)) return false;
      return true;
    });
    const sign = sort.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => sort.key === 'name' ? sign * a.name.localeCompare(b.name) : sign * a.commit.timestamp.localeCompare(b.commit.timestamp));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others, search, filter, sort, prByBranch]);

  if (q.isLoading) return <BranchesSkeleton />;
  if (q.isError && !q.data) return <GiteaError what={`branches of ${repo}`} error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />;
  if (!all.length) {
    return <EmptyState title='No branches yet' description={`${repo} is empty — push a first commit, or initialise it with a README from the repository settings.`} />;
  }

  const unprotectBranch = (name: string) => {
    const rule = prot.data?.find((p) => p.rule_name === name || p.branch_name === name);
    if (!rule) {
      toast.info(`${name} is protected by a pattern rule`, { description: 'Edit it from the repository’s Branches tab.' });
      return;
    }
    act(`Removed protection from ${name}`, () => unprotect.mutateAsync({ repo, ruleName: rule.rule_name ?? rule.branch_name ?? name }));
  };

  const menu = (b: gitea.Branch, isDefault = false) => (
    <MoreMenu label={`Actions for ${b.name}`}>
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); go('commits', { repo, branch: b.name }); }}>View commits</MenuItem>
          {!isDefault && onNewPr ? <MenuItem onClick={() => { close(); onNewPr(b.name); }}>Open pull request…</MenuItem> : null}
          <MenuItem onClick={() => { close(); onNewBranch(b.name); }}>New branch from here…</MenuItem>
          <MenuItem onClick={() => { close(); copy(b.name, toast); }}>Copy name</MenuItem>
          <MenuItem onClick={() => { close(); copy(`git fetch origin && git switch ${b.name}`, toast); }}>Copy checkout command</MenuItem>
          <div className='my-1 border-t border-edge-subtle' />
          {b.protected
            ? <MenuItem onClick={() => { close(); unprotectBranch(b.name); }}>Remove protection</MenuItem>
            : <MenuItem onClick={() => { close(); setProtecting(b.name); }}>Protect…</MenuItem>}
          {!isDefault && !b.protected ? <MenuItem danger onClick={() => { close(); setConfirmDel(b); }}>Delete…</MenuItem> : null}
        </>
      )}
    </MoreMenu>
  );

  return (
    <SwapFrame pending={q.isPlaceholderData} className='space-y-4'>
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
        <StatTile label='Branches' value={counts.total} on={filter === 'all'} onClick={() => setFilter('all')} hint={def ? `default ${def}` : undefined} />
        <StatTile label='Active' value={counts.active} tone='emerald' hint='commits in 14 days' on={filter === 'active'} onClick={() => setFilter(filter === 'active' ? 'all' : 'active')} />
        <StatTile label='With open PR' value={prs.isLoading ? '…' : counts.pr} tone='brand' hint='under review' on={filter === 'pr'} onClick={() => setFilter(filter === 'pr' ? 'all' : 'pr')} />
        <StatTile label='Stale' value={counts.stale} tone={counts.stale ? 'amber' : 'slate'} hint='quiet 90+ days' on={filter === 'stale'} onClick={() => setFilter(filter === 'stale' ? 'all' : 'stale')} />
        <StatTile label='Protected' value={counts.protected} tone='violet' hint={`${prot.data?.length ?? 0} rule${prot.data?.length === 1 ? '' : 's'}`} on={filter === 'protected'} onClick={() => setFilter(filter === 'protected' ? 'all' : 'protected')} />
      </div>

      {defBranch
        ? (
          <section>
            <h2 className='mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>Default branch</h2>
            <div className='overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
              <BranchRow repo={repo} branch={defBranch} isDefault onCommit={setCommit} menu={menu(defBranch, true)} />
            </div>
          </section>
        )
        : null}

      <section className='space-y-2'>
        <div className='rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm'>
          <div className='flex flex-wrap items-center gap-2'>
            <SearchField ref={searchRef} value={search} onChange={setSearch} placeholder='Search branches, commit messages, authors…' slashHint />
            <div className='min-w-[18rem]'>
              <Segmented<Filter>
                value={filter === 'protected' ? 'all' : filter}
                onChange={setFilter}
                options={[['all', 'All'], ['active', 'Active'], ['stale', 'Stale'], ['pr', 'In review'], ['nopr', 'No PR']]}
              />
            </div>
            <SortMenu sorts={SORTS} sort={sort.key} dir={sort.dir} onSort={(key, dir) => setSort({ key, dir })} />
            <RefreshButton onRefresh={() => Promise.all([q.refetch(), prs.refetch()])} />
          </div>
          <div className='mt-2 px-0.5 text-[11px] text-content-subtle'>
            {list.length === others.length ? `${others.length} other branch${others.length === 1 ? '' : 'es'}` : `${list.length} of ${others.length}`}
            {def ? <> · compared with <code className='font-mono'>{def}</code></> : null}
          </div>
        </div>

        {list.length === 0
          ? <EmptyState compact title={others.length ? 'No matches' : 'Only the default branch'} description={others.length ? 'Try a different search or filter.' : 'Create a branch to start a change.'} />
          : (
            <ul className='divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
              {list.map((b, i) => (
                <li key={b.name}>
                  <BranchRow
                    repo={repo}
                    branch={b}
                    base={def}
                    compare={i < COMPARE_LIMIT}
                    pr={prByBranch.get(b.name)}
                    onPr={(p) => go('prs', { repo, pr: itemRef(repo, p.number), state: 'all' })}
                    onNewPr={onNewPr ? () => onNewPr(b.name) : undefined}
                    onCommit={setCommit}
                    menu={menu(b)}
                    highlight={params.branch === b.name}
                  />
                </li>
              ))}
            </ul>
          )}
      </section>

      {commit ? <CommitDrawer repo={repo} sha={commit} onClose={() => setCommit(null)} onOpenSha={setCommit} /> : null}

      <ProtectModal repo={repo} branch={protecting} onClose={() => setProtecting(null)} />

      <Modal
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        title={`Delete ${confirmDel?.name ?? ''}?`}
        description={prByBranch.get(confirmDel?.name ?? '')?.state === 'open'
          ? 'This branch has an open pull request — deleting it closes the PR.'
          : 'The branch is removed from Gitea. Its commits stay reachable from any branch they were merged into.'}
        width='sm'
        footer={
          <div className='flex justify-end gap-2'>
            <Button size='sm' variant='secondary' onClick={() => setConfirmDel(null)}>Cancel</Button>
            <Button
              size='sm'
              variant='danger'
              loading={del.isPending}
              onClick={async () => {
                const b = confirmDel!;
                if (await act(`Deleted ${b.name}`, () => del.mutateAsync({ repo, name: b.name }))) setConfirmDel(null);
              }}
            >
              Delete branch
            </Button>
          </div>
        }
      >
        {confirmDel ? <p className='text-[12px] text-content-muted'>Last commit {confirmDel.commit.id.slice(0, 7)} by {confirmDel.commit.author.name}, {formatRelative(confirmDel.commit.timestamp)}.</p> : null}
      </Modal>
    </div>
    </SwapFrame>
  );
}

/** Refresh that spins while the refresh the user asked for runs — background refetches stay silent. */
function RefreshButton({ onRefresh }: { onRefresh(): Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size='sm'
      variant='secondary'
      loading={busy}
      aria-label='Refresh'
      title='Refresh'
      onClick={() => {
        setBusy(true);
        void onRefresh().finally(() => setBusy(false));
      }}
    >
      {busy ? null : <IconRefresh />}
    </Button>
  );
}

/** First load: the page's tiles, the default-branch card and branch rows, in skeleton. */
function BranchesSkeleton() {
  return (
    <div role='status' aria-busy='true' aria-label='Loading branches' className='space-y-4'>
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className='flex h-[58px] flex-col justify-center gap-1.5 rounded-xl border border-edge-default bg-surface-raised px-3'>
            <span className='skeleton-shimmer block h-2.5 w-16 rounded' />
            <span className='skeleton-shimmer block h-4 w-8 rounded' />
          </div>
        ))}
      </div>
      <div className='space-y-1.5'>
        <span className='skeleton-shimmer block h-2.5 w-24 rounded' />
        <LoadingBlock label='Loading the default branch' rows={1} />
      </div>
      <LoadingBlock label='Loading branches' rows={6} />
    </div>
  );
}

/**
 * True once the element has been on screen. Ahead/behind costs two compare
 * calls per branch; asking only for rows that are actually visible keeps a
 * long branch list from queueing dozens of requests ahead of the next click.
 */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    }, { rootMargin: '120px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

function BranchRow({ repo, branch: b, base, isDefault = false, compare = false, pr, onPr, onNewPr, onCommit, menu, highlight }: {
  repo: string;
  branch: gitea.Branch;
  base?: string;
  isDefault?: boolean;
  compare?: boolean;
  pr?: gitea.PullRequest;
  onPr?(p: gitea.PullRequest): void;
  onNewPr?(): void;
  onCommit(sha: string): void;
  menu: React.ReactNode;
  highlight?: boolean;
}) {
  const [rowRef, seen] = useSeen<HTMLDivElement>();
  const ab = useAheadBehind(repo, base, b.name, compare && !isDefault && seen);
  const toast = useToast();
  const subject = b.commit.message.split('\n')[0];
  return (
    <div ref={rowRef} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap', highlight && 'bg-brand-50/60 dark:bg-brand-500/10')}>
      <div className='min-w-0 flex-1 basis-64'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <span className='text-content-subtle'><IconBranchSmall /></span>
          <button type='button' onClick={() => copy(b.name, toast)} title='Copy branch name' className='truncate font-mono text-[13px] font-semibold text-content hover:text-brand-700 dark:hover:text-brand-300'>
            {b.name}
          </button>
          {isDefault ? <span className='rounded-full bg-brand-50 px-1.5 py-px text-[10px] font-semibold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'>default</span> : null}
          {b.protected ? <span className='inline-flex items-center gap-0.5 rounded-full bg-violet-50 px-1.5 py-px text-[10px] font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'><IconShield /> protected</span> : null}
        </div>
        <button type='button' onClick={() => onCommit(b.commit.id)} className='mt-0.5 flex w-full min-w-0 items-center gap-1.5 text-left text-[12px] text-content-muted hover:text-content'>
          <code className='shrink-0 font-mono text-[11px] text-brand-700 dark:text-brand-300'>{b.commit.id.slice(0, 7)}</code>
          <span className='truncate'>{subject}</span>
        </button>
        <div className='text-[11px] text-content-subtle'>
          {b.commit.author.name} committed <span title={b.commit.timestamp}>{formatRelative(b.commit.timestamp)}</span>
        </div>
      </div>

      {isDefault ? null : <AheadBehind data={ab.data} loading={(ab.isLoading || !seen) && compare} base={base} />}

      {isDefault ? null : (
        <div className='w-36 shrink-0'>
          {pr
            ? (
              <button type='button' onClick={() => onPr?.(pr)} className='inline-flex max-w-full items-center gap-1 rounded-md border border-edge-default px-2 py-1 text-[11px] font-medium text-content hover:border-brand-400'>
                <PrStateIcon state={prState(pr)} size={13} />
                <span>#{pr.number}</span>
                <span className='truncate capitalize text-content-muted'>{prState(pr)}</span>
              </button>
            )
            : onNewPr ? (
              <button type='button' onClick={onNewPr} className='text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300'>
                Open pull request
              </button>
            ) : null}
        </div>
      )}
      {menu}
    </div>
  );
}

/** GitHub-style split bar: commits behind on the left, ahead on the right. */
function AheadBehind({ data, loading, base }: { data?: { ahead: number; behind: number } | null; loading: boolean; base?: string }) {
  if (loading) return <div aria-hidden className='skeleton-shimmer h-8 w-32 shrink-0 rounded' />;
  if (!data) return <div className='w-32 shrink-0' />;
  const max = Math.max(data.ahead, data.behind, 1);
  const w = (n: number) => `${Math.max(n ? 6 : 0, (n / max) * 100)}%`;
  return (
    <div className='w-32 shrink-0' title={`${data.behind} behind, ${data.ahead} ahead of ${base}`}>
      <div className='flex justify-between text-[10px] tabular-nums text-content-muted'>
        <span>{data.behind} behind</span>
        <span>{data.ahead} ahead</span>
      </div>
      <div className='mt-0.5 grid grid-cols-2 gap-px'>
        <div className='flex h-1.5 justify-end overflow-hidden rounded-l-full bg-surface-sunken'><i className='h-full bg-slate-400' style={{ width: w(data.behind) }} /></div>
        <div className='flex h-1.5 overflow-hidden rounded-r-full bg-surface-sunken'><i className='h-full bg-brand-500' style={{ width: w(data.ahead) }} /></div>
      </div>
    </div>
  );
}

function NewBranchModal({ repo, from, onClose }: { repo: string; from: string | null; onClose(): void }) {
  const branches = useBranches(repo);
  const repos = useRepos();
  const create = useCreateBranch();
  const act = useAct();
  const go = useGoDevelop();
  const [name, setName] = useState('');
  const [src, setSrc] = useState('');
  const def = repos.data?.find((r) => r.name === repo)?.default_branch ?? '';
  const open = from !== null;
  const source = src || from || def;
  const exists = branches.data?.some((b) => b.name === name.trim());
  const valid = /^[A-Za-z0-9._/-]+$/.test(name.trim()) && !name.includes('..') && !name.endsWith('/') && !name.startsWith('/');

  const close = () => {
    setName('');
    setSrc('');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title='New branch'
      description={`Create a branch in ${repo}.`}
      width='sm'
      footer={
        <div className='flex justify-end gap-2'>
          <Button size='sm' variant='secondary' onClick={close}>Cancel</Button>
          <Button variant='primary'
            size='sm'
            disabled={!name.trim() || !valid || exists}
            loading={create.isPending}
            onClick={async () => {
              const n = name.trim();
              if (await act(`Created ${n} from ${source}`, () => create.mutateAsync({ repo, name: n, from: source }))) {
                close();
                go('branches', { repo, branch: n });
              }
            }}
          >
            Create branch
          </Button>
        </div>
      }
    >
      <div className='space-y-3'>
        <Field label='Name' required error={name && !valid ? 'Letters, numbers, . _ - and / only.' : exists ? 'A branch with this name already exists.' : undefined} hint='e.g. feat/checkout-retry'>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))} placeholder='feat/my-change' />
        </Field>
        <Field label='From'>
          <Select value={source} onChange={(e) => setSrc(e.target.value)} options={(branches.data ?? []).map((b) => ({ value: b.name, label: b.name === def ? `${b.name} (default)` : b.name }))} />
        </Field>
      </div>
    </Modal>
  );
}

function ProtectModal({ repo, branch, onClose }: { repo: string; branch: string | null; onClose(): void }) {
  const protect = useProtectBranch();
  const act = useAct();
  const [approvals, setApprovals] = useState(1);
  const [blockPush, setBlockPush] = useState(true);
  const [blockRejected, setBlockRejected] = useState(true);
  const [dismissStale, setDismissStale] = useState(true);
  const [outdated, setOutdated] = useState(false);
  return (
    <Modal
      open={!!branch}
      onClose={onClose}
      title={`Protect ${branch ?? ''}`}
      description='Changes to a protected branch go through pull requests that meet these rules.'
      width='sm'
      footer={
        <div className='flex justify-end gap-2'>
          <Button size='sm' variant='secondary' onClick={onClose}>Cancel</Button>
          <Button variant='primary'
            size='sm'
            loading={protect.isPending}
            onClick={async () => {
              const ok = await act(`Protected ${branch}`, () =>
                protect.mutateAsync({
                  repo,
                  body: {
                    rule_name: branch!,
                    enable_push: !blockPush,
                    required_approvals: approvals,
                    block_on_rejected_reviews: blockRejected,
                    dismiss_stale_approvals: dismissStale,
                    block_on_outdated_branch: outdated,
                  },
                }));
              if (ok) onClose();
            }}
          >
            Protect branch
          </Button>
        </div>
      }
    >
      <div className='space-y-3'>
        <Field label='Required approvals'>
          <Input type='number' min={0} max={10} value={approvals} onChange={(e) => setApprovals(Math.max(0, Number(e.target.value) || 0))} />
        </Field>
        <Checkbox label='Block direct pushes' description='Only merges from pull requests.' checked={blockPush} onChange={(e) => setBlockPush(e.target.checked)} />
        <Checkbox label='Block merge on requested changes' checked={blockRejected} onChange={(e) => setBlockRejected(e.target.checked)} />
        <Checkbox label='Dismiss stale approvals' description='New commits reset approvals.' checked={dismissStale} onChange={(e) => setDismissStale(e.target.checked)} />
        <Checkbox label='Require the branch to be up to date' checked={outdated} onChange={(e) => setOutdated(e.target.checked)} />
      </div>
    </Modal>
  );
}
