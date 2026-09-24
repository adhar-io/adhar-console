import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  useClickOutside,
  useToast,
} from '@adhar-console/shell-ui';
import { cn, formatRelative } from '@adhar-console/utils';
import type { gitea } from '@adhar-console/api-clients';
import {
  useAllOpenPullRequests,
  useCreateRepo,
  useDeleteRepo,
  useRepos,
  useUpdateRepo,
} from '../data/git.ts';
import { RepoMark } from '../components/repo-picker.tsx';
import { RepoDrawer } from '../components/repo-drawer.tsx';
import { CloudEnvLaunch } from '../components/cloud-env-launch.tsx';
import { copy, fmtKb, IconGrid, IconList, IconMore, IconPlus, IconRefresh, IconSearch, langColor, RepoBadges } from '../components/repo-bits.tsx';

/**
 * Repository management — the full Gitea surface for the active org.
 *
 * The page is a browser first: a stats strip that doubles as one-click
 * filters, a search box, a Filters popover (visibility, state, language,
 * topic, activity), a sort menu with direction, three layouts (grid, table,
 * compact list) and sortable column headers in the table. Every active
 * filter shows as a removable chip, so the state of the list is never a
 * mystery. Layout and sort are remembered per browser.
 *
 * Actions on a repository live in one ⋯ menu shared by every layout, so the
 * table no longer needs a row of four buttons that overflowed the viewport.
 */

type Visibility = 'all' | 'public' | 'private';
type State = 'all' | 'active' | 'archived' | 'template' | 'fork' | 'mirror' | 'empty';
type Activity = 'any' | 'issues' | 'prs' | 'recent' | 'stale';
type SortKey = 'updated' | 'name' | 'stars' | 'issues' | 'prs' | 'created' | 'size';
type Dir = 'asc' | 'desc';
type Layout = 'grid' | 'table' | 'compact';

interface Prefs {
  layout: Layout;
  sort: SortKey;
  dir: Dir;
}
const PREFS_KEY = 'adhar.develop.repos.prefs.v3';
const DEFAULT_PREFS: Prefs = { layout: 'table', sort: 'updated', dir: 'desc' };
function loadPrefs(): Prefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch { /* ignore */ }
  return DEFAULT_PREFS;
}

const SORTS: Array<{ key: SortKey; label: string; defaultDir: Dir }> = [
  { key: 'updated', label: 'Recently updated', defaultDir: 'desc' },
  { key: 'created', label: 'Newest', defaultDir: 'desc' },
  { key: 'name', label: 'Name', defaultDir: 'asc' },
  { key: 'stars', label: 'Stars', defaultDir: 'desc' },
  { key: 'issues', label: 'Open issues', defaultDir: 'desc' },
  { key: 'prs', label: 'Open PRs', defaultDir: 'desc' },
  { key: 'size', label: 'Size', defaultDir: 'desc' },
];

const STATE_LABEL: Record<State, string> = {
  all: 'All states', active: 'Active', archived: 'Archived', template: 'Templates', fork: 'Forks', mirror: 'Mirrors', empty: 'Empty',
};
const ACTIVITY_LABEL: Record<Activity, string> = {
  any: 'Any activity', issues: 'Has open issues', prs: 'Has open PRs', recent: 'Updated this week', stale: 'Quiet for 90+ days',
};

const WEEK_MS = 7 * 86_400_000;
const STALE_MS = 90 * 86_400_000;

export function RepoList() {
  const q = useRepos();
  const prs = useAllOpenPullRequests();
  const toast = useToast();
  const update = useUpdateRepo();
  const del = useDeleteRepo();
  const [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('all');
  const [state, setState] = useState<State>('active');
  const [language, setLanguage] = useState<string>('all');
  const [topic, setTopic] = useState<string>('all');
  const [activity, setActivity] = useState<Activity>('any');
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [openName, setOpenName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<gitea.Repo | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* ignore */ }
  }, [prefs]);

  // `/` focuses search, like the catalog. Skipped while typing elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, []);

  const all = useMemo(() => q.data ?? [], [q.data]);
  const prCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of prs.data ?? []) m.set(p.repo, (m.get(p.repo) ?? 0) + 1);
    return m;
  }, [prs.data]);

  const languages = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of all) if (r.language) m.set(r.language, (m.get(r.language) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);
  const topics = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of all) for (const t of r.topics ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
  }, [all]);

  const now = Date.now();
  const list = useMemo(() => {
    const f = search.trim().toLowerCase();
    let out = all.filter((r) => {
      if (visibility === 'public' && r.private) return false;
      if (visibility === 'private' && !r.private) return false;
      if (state === 'active' && r.archived) return false;
      if (state === 'archived' && !r.archived) return false;
      if (state === 'template' && !r.template) return false;
      if (state === 'fork' && !r.fork) return false;
      if (state === 'mirror' && !r.mirror) return false;
      if (state === 'empty' && !r.empty) return false;
      if (language !== 'all' && r.language !== language) return false;
      if (topic !== 'all' && !(r.topics ?? []).includes(topic)) return false;
      if (activity === 'issues' && r.open_issues_count === 0) return false;
      if (activity === 'prs' && !(prCount.get(r.name) ?? 0)) return false;
      if (activity === 'recent' && now - Date.parse(r.updated_at) > WEEK_MS) return false;
      if (activity === 'stale' && now - Date.parse(r.updated_at) < STALE_MS) return false;
      return true;
    });
    if (f) {
      out = out.filter((r) =>
        r.name.toLowerCase().includes(f) ||
        (r.description ?? '').toLowerCase().includes(f) ||
        (r.language ?? '').toLowerCase().includes(f) ||
        (r.topics ?? []).some((t) => t.toLowerCase().includes(f))
      );
    }
    const sign = prefs.dir === 'asc' ? 1 : -1;
    const cmp = (a: gitea.Repo, b: gitea.Repo): number => {
      switch (prefs.sort) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'stars':
          return a.stars_count - b.stars_count;
        case 'issues':
          return a.open_issues_count - b.open_issues_count;
        case 'prs':
          return (prCount.get(a.name) ?? 0) - (prCount.get(b.name) ?? 0);
        case 'created':
          return (a.created_at ?? '').localeCompare(b.created_at ?? '');
        case 'size':
          return (a.size ?? 0) - (b.size ?? 0);
        default:
          return a.updated_at.localeCompare(b.updated_at);
      }
    };
    out.sort((a, b) => sign * cmp(a, b) || a.name.localeCompare(b.name));
    return out;
  }, [all, search, visibility, state, language, topic, activity, prefs.sort, prefs.dir, prCount, now]);

  const open = all.find((r) => r.name === openName) ?? null;

  const stats = useMemo(() => {
    const active = all.filter((r) => !r.archived);
    return {
      total: all.length,
      active: active.length,
      priv: all.filter((r) => r.private).length,
      pub: all.filter((r) => !r.private).length,
      archived: all.filter((r) => r.archived).length,
      templates: all.filter((r) => r.template).length,
      forks: all.filter((r) => r.fork).length,
      issues: active.reduce((s, r) => s + r.open_issues_count, 0),
      prs: [...prCount.values()].reduce((s, n) => s + n, 0),
      stars: all.reduce((s, r) => s + r.stars_count, 0),
      size: all.reduce((s, r) => s + (r.size ?? 0), 0),
      recent: all.filter((r) => now - Date.parse(r.updated_at) <= WEEK_MS).length,
    };
  }, [all, prCount, now]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast.success(label);
    } catch (e) {
      toast.error(label, { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const setSort = (key: SortKey, dir?: Dir) =>
    setPrefs((p) => ({
      ...p,
      sort: key,
      dir: dir ?? (p.sort === key ? (p.dir === 'asc' ? 'desc' : 'asc') : SORTS.find((s) => s.key === key)!.defaultDir),
    }));

  const activeChips: Array<{ key: string; label: string; clear(): void }> = [
    visibility !== 'all' ? { key: 'vis', label: visibility === 'private' ? 'Private' : 'Public', clear: () => setVisibility('all') } : null,
    state !== 'active' ? { key: 'state', label: STATE_LABEL[state], clear: () => setState('active') } : null,
    language !== 'all' ? { key: 'lang', label: language, clear: () => setLanguage('all') } : null,
    topic !== 'all' ? { key: 'topic', label: `#${topic}`, clear: () => setTopic('all') } : null,
    activity !== 'any' ? { key: 'act', label: ACTIVITY_LABEL[activity], clear: () => setActivity('any') } : null,
  ].filter(Boolean) as Array<{ key: string; label: string; clear(): void }>;
  const clearAll = () => {
    setSearch('');
    setVisibility('all');
    setState('active');
    setLanguage('all');
    setTopic('all');
    setActivity('any');
  };

  const menuFor = (r: gitea.Repo) => ({
    onOpen: () => setOpenName(r.name),
    onArchive: () => act(r.archived ? `Unarchived ${r.name}` : `Archived ${r.name}`, () => update.mutateAsync({ repo: r.name, body: { archived: !r.archived } })),
    onDelete: () => setConfirmDelete(r),
  });

  if (q.isLoading) {
    return (
      <div className='flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm'>
        <Spinner size={14} /> Loading repositories…
      </div>
    );
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Gitea"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
        action={<Button size='sm' variant='secondary' onClick={() => q.refetch()}>Retry</Button>}
      />
    );
  }

  const sortDef = SORTS.find((s) => s.key === prefs.sort) ?? SORTS[0];

  return (
    <div className='space-y-4'>
      {/* ── stats strip: each tile is a one-click filter ── */}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8'>
        <StatTile label='Repositories' value={stats.total} hint={`${stats.active} active`} on={state === 'all' && visibility === 'all' && activity === 'any'} onClick={() => { setState('all'); setVisibility('all'); setActivity('any'); }} />
        <StatTile label='Private' value={stats.priv} tone='slate' on={visibility === 'private'} onClick={() => setVisibility(visibility === 'private' ? 'all' : 'private')} />
        <StatTile label='Public' value={stats.pub} tone='info' on={visibility === 'public'} onClick={() => setVisibility(visibility === 'public' ? 'all' : 'public')} />
        <StatTile label='Open issues' value={stats.issues} tone={stats.issues > 0 ? 'amber' : 'emerald'} on={activity === 'issues'} hint={activity === 'issues' ? 'showing those' : 'click to show'} onClick={() => setActivity(activity === 'issues' ? 'any' : 'issues')} />
        <StatTile label='Open PRs' value={prs.isLoading ? '…' : stats.prs} tone={stats.prs > 0 ? 'brand' : 'slate'} on={activity === 'prs'} hint={activity === 'prs' ? 'showing those' : 'across the org'} onClick={() => setActivity(activity === 'prs' ? 'any' : 'prs')} />
        <StatTile label='Active this week' value={stats.recent} tone='emerald' on={activity === 'recent'} hint='updated in 7 days' onClick={() => setActivity(activity === 'recent' ? 'any' : 'recent')} />
        <StatTile label='Templates' value={stats.templates} tone='violet' on={state === 'template'} hint={`${stats.archived} archived`} onClick={() => setState(state === 'template' ? 'active' : 'template')} />
        <StatTile label='Storage' value={fmtKb(stats.size)} hint={`${stats.stars} stars · ${stats.forks} forks`} />
      </div>

      {/* ── toolbar ── */}
      <div className='rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm'>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative min-w-0 flex-1 basis-64'>
            <span className='pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-content-subtle'>
              <IconSearch />
            </span>
            <input
              ref={searchRef}
              type='search'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search repositories, descriptions, topics, languages…'
              aria-label='Search repositories'
              className='block h-9 w-full rounded-lg border border-edge-default bg-surface-app pl-8 pr-14 text-[13px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'
            />
            <span className='pointer-events-none absolute inset-y-0 right-2.5 hidden items-center gap-1 sm:flex'>
              {search ? null : <kbd className='rounded border border-edge-default bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-subtle'>/</kbd>}
            </span>
            {search ? (
              <button type='button' onClick={() => setSearch('')} aria-label='Clear search' className='absolute inset-y-0 right-2 flex items-center text-[11px] font-medium text-content-subtle hover:text-content'>clear</button>
            ) : null}
          </div>

          <FiltersMenu
            count={activeChips.length}
            visibility={visibility} onVisibility={setVisibility}
            state={state} onState={setState}
            language={language} languages={languages} onLanguage={setLanguage}
            topic={topic} topics={topics} onTopic={setTopic}
            activity={activity} onActivity={setActivity}
            onClear={clearAll}
          />

          <SortMenu sort={prefs.sort} dir={prefs.dir} onSort={setSort} onDir={(d) => setPrefs((p) => ({ ...p, dir: d }))} label={sortDef.label} />

          <div className='flex items-center rounded-lg border border-edge-default bg-surface-app p-0.5' role='radiogroup' aria-label='Layout'>
            <LayoutBtn on={prefs.layout === 'grid'} onClick={() => setPrefs((p) => ({ ...p, layout: 'grid' }))} title='Grid'><IconGrid /></LayoutBtn>
            <LayoutBtn on={prefs.layout === 'table'} onClick={() => setPrefs((p) => ({ ...p, layout: 'table' }))} title='Table'><IconList /></LayoutBtn>
            <LayoutBtn on={prefs.layout === 'compact'} onClick={() => setPrefs((p) => ({ ...p, layout: 'compact' }))} title='Compact list'><IconRows /></LayoutBtn>
          </div>

          <div className='ml-auto flex items-center gap-1.5'>
            <Button size='sm' variant='secondary' onClick={() => { q.refetch(); prs.refetch(); }} title='Refresh' aria-label='Refresh'>
              <IconRefresh />
            </Button>
            <Button size='sm' variant='primary' onClick={() => setCreating(true)}>
              <IconPlus /> New repository
            </Button>
          </div>
        </div>

        {/* Active filters as chips, plus the count — the state of the list, in words. */}
        <div className='mt-2 flex flex-wrap items-center gap-1.5 px-0.5 text-[11.5px] text-content-subtle'>
          <span className='tabular-nums'>
            {list.length === all.length ? `${all.length} ${all.length === 1 ? 'repository' : 'repositories'}` : `${list.length} of ${all.length}`}
          </span>
          {search ? <Chip onClear={() => setSearch('')}>“{search}”</Chip> : null}
          {activeChips.map((c) => <Chip key={c.key} onClear={c.clear}>{c.label}</Chip>)}
          {activeChips.length || search ? (
            <button type='button' onClick={clearAll} className='ml-1 font-medium text-content-muted underline-offset-2 hover:text-content hover:underline'>Clear all</button>
          ) : (
            <span>· sorted by {sortDef.label.toLowerCase()} {prefs.dir === 'asc' ? '↑' : '↓'}</span>
          )}
        </div>
      </div>

      {/* ── list ── */}
      {list.length === 0
        ? (
          <EmptyState
            title={all.length === 0 ? 'No repositories yet' : 'No matches'}
            description={all.length === 0
              ? 'Create the first repository in this org, or push one with git.'
              : 'Try a different search or clear the filters.'}
            action={all.length === 0
              ? <Button size='sm' onClick={() => setCreating(true)}><IconPlus /> New repository</Button>
              : <Button size='sm' variant='secondary' onClick={clearAll}>Clear filters</Button>}
          />
        )
        : prefs.layout === 'grid'
        ? (
          <div className='grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'>
            {list.map((r) => (
              <RepoCard key={r.id} repo={r} prs={prCount.get(r.name) ?? 0} {...menuFor(r)} />
            ))}
          </div>
        )
        : prefs.layout === 'compact'
        ? (
          <div className='divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised'>
            {list.map((r) => (
              <RepoRow key={r.id} repo={r} prs={prCount.get(r.name) ?? 0} {...menuFor(r)} />
            ))}
          </div>
        )
        : (
          <RepoTable rows={list} prCount={prCount} sort={prefs.sort} dir={prefs.dir} onSort={setSort} menuFor={menuFor} />
        )}

      {open ? <RepoDrawer repo={open} onClose={() => setOpenName(null)} onDeleted={() => setOpenName(null)} /> : null}

      <CreateRepoModal open={creating} onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setOpenName(r.name); }} />

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        description='This permanently removes the repository, its issues, pull requests, releases and wiki from Gitea. This cannot be undone.'
        width='sm'
        footer={
          <div className='flex justify-end gap-2'>
            <Button variant='secondary' size='sm' onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant='danger'
              size='sm'
              disabled={del.isPending}
              onClick={() => {
                const r = confirmDelete!;
                act(`Deleted ${r.name}`, () => del.mutateAsync(r.name)).then(() => {
                  setConfirmDelete(null);
                  if (openName === r.name) setOpenName(null);
                });
              }}
            >
              {del.isPending ? <Spinner size={12} /> : null} Delete repository
            </Button>
          </div>
        }
      >
        <DeleteHint repo={confirmDelete} />
      </Modal>
    </div>
  );
}

function DeleteHint({ repo }: { repo: gitea.Repo | null }) {
  if (!repo) return null;
  return (
    <ul className='space-y-1 text-xs text-content-muted'>
      <li>{repo.open_issues_count} open issue{repo.open_issues_count === 1 ? '' : 's'} will be lost.</li>
      <li>{repo.forks_count} fork{repo.forks_count === 1 ? '' : 's'} will be detached.</li>
      {repo.archived ? null : <li>Consider archiving instead — it keeps history read-only.</li>}
    </ul>
  );
}

/* ─────────── toolbar menus ─────────── */

/** A small popover anchored under its trigger; outside click and Escape close it. */
function Popover({ open, onClose, align = 'left', width = 'w-72', children }: { open: boolean; onClose(): void; align?: 'left' | 'right'; width?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose, open);
  if (!open) return null;
  return (
    <div ref={ref} className={cn('pop-in absolute top-full z-56 mt-1.5 rounded-xl border border-edge-default bg-surface-raised p-2 shadow-xl ring-1 ring-black/5 dark:ring-white/10', align === 'right' ? 'right-0' : 'left-0', width)}>
      {children}
    </div>
  );
}

function ToolbarBtn({ on, onClick, children, badge, title }: { on?: boolean; onClick(): void; children: ReactNode; badge?: number; title?: string }) {
  return (
    <button
      type='button'
      onClick={onClick}
      title={title}
      aria-expanded={on}
      aria-haspopup='dialog'
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors',
        on ? 'border-edge-strong bg-surface-sunken text-content' : 'border-edge-default bg-surface-app text-content-muted hover:border-edge-strong hover:text-content',
      )}
    >
      {children}
      {badge ? <span className='rounded-full bg-content px-1.5 py-px text-[10px] font-semibold tabular-nums text-surface-raised'>{badge}</span> : null}
    </button>
  );
}

function FiltersMenu(p: {
  count: number;
  visibility: Visibility; onVisibility(v: Visibility): void;
  state: State; onState(s: State): void;
  language: string; languages: Array<[string, number]>; onLanguage(l: string): void;
  topic: string; topics: Array<[string, number]>; onTopic(t: string): void;
  activity: Activity; onActivity(a: Activity): void;
  onClear(): void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className='relative'>
      <ToolbarBtn on={open} onClick={() => setOpen((o) => !o)} badge={p.count} title='Filters'>
        <IconFilter /> Filters
      </ToolbarBtn>
      {/* The popover is wrapped so the trigger counts as "inside": a click on
          it toggles instead of closing and reopening. */}
      <Popover open={open} onClose={close} width='w-[22rem] max-w-[calc(100vw-2rem)]'>
        <Section title='Visibility'>
          <Segmented value={p.visibility} onChange={p.onVisibility} options={[['all', 'Any'], ['public', 'Public'], ['private', 'Private']]} />
        </Section>
        <Section title='State'>
          <ChipGroup value={p.state} onChange={p.onState} options={(Object.keys(STATE_LABEL) as State[]).map((k) => [k, STATE_LABEL[k]])} />
        </Section>
        <Section title='Activity'>
          <ChipGroup value={p.activity} onChange={p.onActivity} options={(Object.keys(ACTIVITY_LABEL) as Activity[]).map((k) => [k, ACTIVITY_LABEL[k]])} />
        </Section>
        {p.languages.length ? (
          <Section title='Language'>
            <ChipGroup value={p.language} onChange={p.onLanguage} options={[['all', 'Any'], ...p.languages.map(([l, n]) => [l, `${l} · ${n}`] as [string, string])]} swatch={(v) => (v === 'all' ? undefined : langColor(v))} />
          </Section>
        ) : null}
        {p.topics.length ? (
          <Section title='Topic'>
            <ChipGroup value={p.topic} onChange={p.onTopic} options={[['all', 'Any'], ...p.topics.map(([t, n]) => [t, `${t} · ${n}`] as [string, string])]} />
          </Section>
        ) : null}
        <div className='mt-1 flex items-center justify-between border-t border-edge-subtle px-1 pt-2'>
          <button type='button' onClick={p.onClear} className='text-[11.5px] font-medium text-content-muted hover:text-content'>Reset</button>
          <button type='button' onClick={close} className='rounded-md bg-surface-sunken px-2.5 py-1 text-[11.5px] font-medium text-content hover:bg-edge-subtle'>Done</button>
        </div>
      </Popover>
    </div>
  );
}

function SortMenu({ sort, dir, onSort, onDir, label }: { sort: SortKey; dir: Dir; onSort(k: SortKey, d?: Dir): void; onDir(d: Dir): void; label: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className='relative'>
      <ToolbarBtn on={open} onClick={() => setOpen((o) => !o)} title='Sort'>
        <IconSort /> <span className='hidden sm:inline'>{label}</span><span className='sm:hidden'>Sort</span>
        <span className='text-content-subtle'>{dir === 'asc' ? '↑' : '↓'}</span>
      </ToolbarBtn>
      <Popover open={open} onClose={close} width='w-56'>
        <div className='px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>Sort by</div>
        {SORTS.map((s) => (
          <button
            key={s.key}
            type='button'
            onClick={() => { onSort(s.key, s.key === sort ? undefined : s.defaultDir); }}
            className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors', s.key === sort ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}
          >
            {s.label}
            {s.key === sort ? <span className='text-content-subtle'>{dir === 'asc' ? '↑' : '↓'}</span> : null}
          </button>
        ))}
        <div className='mt-1 border-t border-edge-subtle px-1 pt-1.5'>
          <Segmented value={dir} onChange={onDir} options={[['desc', 'Descending'], ['asc', 'Ascending']]} />
        </div>
      </Popover>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='mb-2 last:mb-0'>
      <div className='px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{title}</div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange(v: T): void; options: Array<[T, string]> }) {
  return (
    <div className='grid gap-0.5 rounded-lg bg-surface-sunken p-0.5' style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role='radiogroup'>
      {options.map(([v, label]) => (
        <button
          key={v}
          type='button'
          role='radio'
          aria-checked={v === value}
          onClick={() => onChange(v)}
          className={cn('h-7 rounded-md text-[12px] font-medium transition-colors', v === value ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ChipGroup<T extends string>({ value, onChange, options, swatch }: { value: T; onChange(v: T): void; options: Array<[T, string]>; swatch?(v: T): string | undefined }) {
  return (
    <div className='flex flex-wrap gap-1'>
      {options.map(([v, label]) => {
        const on = v === value;
        const color = swatch?.(v);
        return (
          <button
            key={v}
            type='button'
            aria-pressed={on}
            onClick={() => onChange(v)}
            className={cn(
              'inline-flex h-6.5 items-center gap-1.5 rounded-full border px-2 text-[11.5px] transition-colors',
              on ? 'border-content bg-content text-surface-raised' : 'border-edge-default bg-surface-app text-content-muted hover:border-edge-strong hover:text-content',
            )}
          >
            {color ? <i className='h-2 w-2 rounded-full' style={{ background: color }} /> : null}
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Chip({ children, onClear }: { children: ReactNode; onClear(): void }) {
  return (
    <span className='inline-flex items-center gap-1 rounded-full border border-edge-default bg-surface-app py-0.5 pl-2 pr-1 text-[11px] font-medium text-content'>
      {children}
      <button type='button' onClick={onClear} aria-label='Remove filter' className='flex h-4 w-4 items-center justify-center rounded-full text-content-subtle hover:bg-surface-sunken hover:text-content'>×</button>
    </span>
  );
}

/* ─────────── the ⋯ menu every layout shares ─────────── */

interface RepoActions {
  onOpen(): void;
  onArchive(): void;
  onDelete(): void;
}

function RepoMenu({ repo: r, onOpen, onArchive, onDelete, align = 'right' }: { repo: gitea.Repo; align?: 'left' | 'right' } & RepoActions) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toast = useToast();
  return (
    <div className='relative shrink-0' onClick={(e) => e.stopPropagation()}>
      <button
        type='button'
        aria-label={`Actions for ${r.name}`}
        aria-haspopup='menu'
        aria-expanded={open}
        onClick={() => setOpen((m) => !m)}
        className={cn('flex h-7 w-7 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content', open && 'bg-surface-sunken text-content')}
      >
        <IconMore />
      </button>
      <Popover open={open} onClose={close} align={align} width='w-52'>
        <div role='menu' className='p-0'>
          <MenuItem onClick={() => { close(); onOpen(); }}>Open details</MenuItem>
          <MenuItem onClick={() => { close(); copy(r.clone_url ?? `${r.html_url}.git`, toast); }}>Copy HTTPS clone URL</MenuItem>
          {r.ssh_url ? <MenuItem onClick={() => { close(); copy(r.ssh_url!, toast); }}>Copy SSH clone URL</MenuItem> : null}
          <MenuItem onClick={() => { close(); globalThis.open(r.html_url, '_blank', 'noopener'); }}>Open in Gitea ↗</MenuItem>
          <div className='my-1 border-t border-edge-subtle' />
          <MenuItem onClick={() => { close(); onArchive(); }}>{r.archived ? 'Unarchive' : 'Archive'}</MenuItem>
          <MenuItem danger onClick={() => { close(); onDelete(); }}>Delete…</MenuItem>
        </div>
      </Popover>
    </div>
  );
}

/* ─────────── grid cards ─────────── */

function RepoCard({ repo: r, prs, onOpen, onArchive, onDelete }: { repo: gitea.Repo; prs: number } & RepoActions) {
  const topics = (r.topics ?? []).slice(0, 4);
  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className={cn(
        'group relative flex h-full min-h-56 flex-col overflow-hidden rounded-xl border bg-surface-raised text-left shadow-sm transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        r.archived ? 'border-edge-subtle opacity-80' : 'border-edge-default',
      )}
    >
      <span aria-hidden className='absolute inset-y-0 left-0 w-1' style={{ background: langColor(r.language) }} />
      <div className='flex flex-1 flex-col p-4 pl-5'>
        <div className='flex items-start gap-3'>
          <RepoMark name={r.name} />
          <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-center gap-1.5'>
              <span className='truncate text-[14px] font-semibold text-content'>{r.name}</span>
              <RepoBadges repo={r} compact />
            </div>
            <div className='mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-content-subtle'>
              <span className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono'>{r.default_branch}</span>
              {r.language ? <span className='inline-flex items-center gap-1'><i className='h-2 w-2 rounded-full' style={{ background: langColor(r.language) }} />{r.language}</span> : null}
              {r.fork && r.parent ? <span>forked from {r.parent.full_name}</span> : null}
            </div>
          </div>
          <RepoMenu repo={r} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} />
        </div>

        {/* Three lines are always reserved so the stats sit at the same height on every card. */}
        <p className={cn('mt-2.5 line-clamp-2 min-h-[2lh] text-xs leading-relaxed', r.description ? 'text-content-muted' : 'italic text-content-subtle')}>
          {r.description || 'No description'}
        </p>
        <div className='mt-2 flex min-h-5 flex-wrap gap-1'>
          {topics.map((t) => <span key={t} className='rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-muted'>#{t}</span>)}
          {(r.topics?.length ?? 0) > 4 ? <span className='text-[10px] text-content-subtle'>+{r.topics!.length - 4}</span> : null}
        </div>

        <div className='mt-3 grid grid-cols-4 gap-1.5 text-center'>
          <Stat label='Issues' value={r.open_issues_count} accent={r.open_issues_count > 0 ? 'amber' : 'slate'} />
          <Stat label='PRs' value={prs} accent={prs > 0 ? 'brand' : 'slate'} />
          <Stat label='Stars' value={r.stars_count} />
          <Stat label='Forks' value={r.forks_count} />
        </div>
      </div>
      <div className='mt-auto flex items-center justify-between gap-3 border-t border-edge-subtle bg-surface-sunken/40 px-4 py-2 pl-5 text-[11px] text-content-muted'>
        <span title={r.updated_at}>Updated {formatRelative(r.updated_at)}</span>
        <span className='flex items-center gap-3'>
          <span className='font-mono text-[10px] text-content-subtle'>{r.size !== undefined ? fmtKb(r.size) : ''}</span>
          <span className='translate-x-1 font-mono text-[10px] uppercase tracking-wider text-content-subtle opacity-0 transition-[opacity,transform] group-hover:translate-x-0 group-hover:opacity-100'>open →</span>
        </span>
      </div>
    </div>
  );
}

/* ─────────── compact rows ─────────── */

function RepoRow({ repo: r, prs, onOpen, onArchive, onDelete }: { repo: gitea.Repo; prs: number } & RepoActions) {
  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className={cn('group flex items-center gap-3 px-3 py-2 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-surface-sunken/50', r.archived && 'opacity-70')}
    >
      <RepoMark name={r.name} />
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <span className='text-[13px] font-semibold text-content'>{r.name}</span>
          <RepoBadges repo={r} compact />
          {r.language ? <span className='inline-flex items-center gap-1 text-[11px] text-content-subtle'><i className='h-2 w-2 rounded-full' style={{ background: langColor(r.language) }} />{r.language}</span> : null}
        </div>
        {r.description ? <div className='truncate text-[11.5px] text-content-muted'>{r.description}</div> : null}
      </div>
      <div className='hidden shrink-0 items-center gap-3 text-[11px] tabular-nums text-content-muted md:flex'>
        <span title='Open issues' className={r.open_issues_count > 0 ? 'text-amber-700 dark:text-amber-300' : ''}>{r.open_issues_count} issues</span>
        <span title='Open pull requests' className={prs > 0 ? 'text-brand-700 dark:text-brand-300' : ''}>{prs} PRs</span>
        <span title='Stars'>★ {r.stars_count}</span>
        <span className='w-20 text-right text-content-subtle' title={r.updated_at}>{formatRelative(r.updated_at)}</span>
      </div>
      <RepoMenu repo={r} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} />
    </div>
  );
}

/* ─────────── table ─────────── */

const COLUMNS: Array<{ key: SortKey | 'language' | 'branch'; label: string; sortable: boolean; className?: string; align?: 'right' }> = [
  { key: 'name', label: 'Repository', sortable: true, className: 'min-w-0' },
  { key: 'language', label: 'Language', sortable: false, className: 'hidden md:table-cell w-32' },
  { key: 'branch', label: 'Branch', sortable: false, className: 'hidden xl:table-cell w-24' },
  { key: 'issues', label: 'Issues', sortable: true, className: 'w-20', align: 'right' },
  { key: 'prs', label: 'PRs', sortable: true, className: 'w-16', align: 'right' },
  { key: 'stars', label: 'Stars', sortable: true, className: 'hidden lg:table-cell w-16', align: 'right' },
  { key: 'size', label: 'Size', sortable: true, className: 'hidden lg:table-cell w-20', align: 'right' },
  { key: 'updated', label: 'Updated', sortable: true, className: 'w-28' },
];

function RepoTable({ rows, prCount, sort, dir, onSort, menuFor }: {
  rows: gitea.Repo[];
  prCount: Map<string, number>;
  sort: SortKey;
  dir: Dir;
  onSort(k: SortKey): void;
  menuFor(r: gitea.Repo): RepoActions;
}) {
  return (
    <div className='overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
      <table className='w-full table-fixed text-left text-xs'>
        <thead className='bg-surface-sunken/60 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
          <tr>
            {COLUMNS.map((c) => {
              const on = c.sortable && c.key === sort;
              return (
                <th key={c.key} scope='col' aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : undefined} className={cn('px-3 py-2', c.className, c.align === 'right' && 'text-right')}>
                  {c.sortable ? (
                    <button type='button' onClick={() => onSort(c.key as SortKey)} className={cn('inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-content', on && 'text-content')}>
                      {c.label}
                      <span className={cn('text-[9px]', on ? 'opacity-100' : 'opacity-0')}>{on && dir === 'asc' ? '↑' : '↓'}</span>
                    </button>
                  ) : c.label}
                </th>
              );
            })}
            <th scope='col' className='w-20 px-3 py-2 text-right'><span className='sr-only'>Actions</span></th>
          </tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {rows.map((r) => {
            const a = menuFor(r);
            const prs = prCount.get(r.name) ?? 0;
            return (
              <tr key={r.id} className={cn('group cursor-pointer transition-colors hover:bg-surface-sunken/40', r.archived && 'opacity-70')} onClick={a.onOpen}>
                <td className='px-3 py-2'>
                  <div className='flex items-center gap-2.5'>
                    <RepoMark name={r.name} />
                    <div className='min-w-0'>
                      <div className='flex flex-wrap items-center gap-1.5'>
                        <span className='font-semibold text-content'>{r.name}</span>
                        <RepoBadges repo={r} compact />
                      </div>
                      {r.description ? <div className='truncate text-[11px] text-content-muted'>{r.description}</div> : null}
                    </div>
                  </div>
                </td>
                <td className='hidden px-3 py-2 text-content-muted md:table-cell'>
                  {r.language ? <span className='flex items-center gap-1.5 truncate'><i className='h-2 w-2 shrink-0 rounded-full' style={{ background: langColor(r.language) }} />{r.language}</span> : <span className='text-content-subtle'>—</span>}
                </td>
                <td className='hidden truncate px-3 py-2 font-mono text-[11px] text-content-muted xl:table-cell'>{r.default_branch}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', r.open_issues_count > 0 ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-content-subtle')}>{r.open_issues_count}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', prs > 0 ? 'font-medium text-brand-700 dark:text-brand-300' : 'text-content-subtle')}>{prs}</td>
                <td className='hidden px-3 py-2 text-right tabular-nums text-content-muted lg:table-cell'>{r.stars_count}</td>
                <td className='hidden px-3 py-2 text-right font-mono text-[11px] text-content-subtle lg:table-cell'>{r.size !== undefined ? fmtKb(r.size) : '—'}</td>
                <td className='truncate px-3 py-2 text-content-muted' title={r.updated_at}>{formatRelative(r.updated_at)}</td>
                <td className='px-2 py-2' onClick={(e) => e.stopPropagation()}>
                  <div className='flex items-center justify-end gap-0.5'>
                    <span className='opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'>
                      <CloudEnvLaunch repo={r.name} cloneUrl={r.clone_url ?? `${r.html_url}.git`} compact />
                    </span>
                    <RepoMenu repo={r} {...a} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────── create modal ─────────── */

const GITIGNORES = ['', 'Node', 'Go', 'Java', 'Python', 'Rust', 'Deno', 'Terraform', 'Helm', 'VisualStudioCode'];
const LICENSES = ['', 'Apache-2.0', 'MIT', 'BSD-3-Clause', 'GPL-3.0-only', 'MPL-2.0', 'Unlicense'];

function CreateRepoModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(r: gitea.Repo): void }) {
  const create = useCreateRepo();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priv, setPriv] = useState(true);
  const [init, setInit] = useState(true);
  const [branch, setBranch] = useState('main');
  const [gitignore, setGitignore] = useState('');
  const [license, setLicense] = useState('');
  const [template, setTemplate] = useState(false);
  const valid = /^[a-zA-Z0-9_.-]{1,100}$/.test(name);

  useEffect(() => {
    if (!open) {
      setName('');
      setDescription('');
      setPriv(true);
      setInit(true);
      setBranch('main');
      setGitignore('');
      setLicense('');
      setTemplate(false);
    }
  }, [open]);

  const submit = async () => {
    if (!valid) return;
    try {
      const r = await create.mutateAsync({
        name,
        description: description || undefined,
        private: priv,
        auto_init: init,
        default_branch: branch || 'main',
        gitignores: init && gitignore ? gitignore : undefined,
        license: init && license ? license : undefined,
        readme: init ? 'Default' : undefined,
        template,
      });
      toast.success(`Created ${r.full_name}`);
      onCreated(r);
    } catch (e) {
      toast.error('Could not create repository', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title='New repository'
      description='Creates the repository in the active Gitea org. Initialising adds a README so it can be cloned immediately.'
      branded
      footer={
        <div className='flex justify-end gap-2'>
          <Button variant='secondary' size='sm' onClick={onClose}>Cancel</Button>
          <Button size='sm' disabled={!valid || create.isPending} onClick={submit}>
            {create.isPending ? <Spinner size={12} /> : null} Create repository
          </Button>
        </div>
      }
    >
      <div className='space-y-3'>
        <Field label='Name' required error={name && !valid ? 'Letters, digits, . _ - only' : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='my-service' autoFocus onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        <Field label='Description'>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder='What lives here?' />
        </Field>
        <div className='grid grid-cols-2 gap-3'>
          <Field label='Visibility'>
            <Select value={priv ? 'private' : 'public'} onChange={(e) => setPriv(e.target.value === 'private')} options={[{ value: 'private', label: 'Private' }, { value: 'public', label: 'Public' }]} />
          </Field>
          <Field label='Default branch'>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </Field>
        </div>
        <Checkbox label='Initialise with a README' description='Also lets you pick a .gitignore and licence.' checked={init} onChange={(e) => setInit(e.target.checked)} />
        {init
          ? (
            <div className='grid grid-cols-2 gap-3'>
              <Field label='.gitignore'>
                <Select value={gitignore} onChange={(e) => setGitignore(e.target.value)} options={GITIGNORES.map((g) => ({ value: g, label: g || 'None' }))} />
              </Field>
              <Field label='Licence'>
                <Select value={license} onChange={(e) => setLicense(e.target.value)} options={LICENSES.map((l) => ({ value: l, label: l || 'None' }))} />
              </Field>
            </div>
          )
          : null}
        <Checkbox label='Template repository' description='Others can generate new repos from it.' checked={template} onChange={(e) => setTemplate(e.target.checked)} />
      </div>
    </Modal>
  );
}

/* ─────────── bits ─────────── */

type Tone = 'slate' | 'brand' | 'amber' | 'emerald' | 'info' | 'violet';

function StatTile({ label, value, hint, tone = 'slate', on = false, onClick }: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: Tone;
  on?: boolean;
  onClick?(): void;
}) {
  const color = {
    slate: 'text-content',
    brand: 'text-brand-700 dark:text-brand-300',
    amber: 'text-amber-700 dark:text-amber-300',
    emerald: 'text-emerald-700 dark:text-emerald-300',
    info: 'text-sky-700 dark:text-sky-300',
    violet: 'text-violet-700 dark:text-violet-300',
  }[tone];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? on : undefined}
      className={cn(
        'flex flex-col gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
        on ? 'border-content bg-surface-sunken ring-1 ring-content/10' : 'border-edge-default bg-surface-raised',
        onClick && 'hover:border-edge-strong',
      )}
    >
      <span className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</span>
      <span className={cn('truncate text-lg font-semibold leading-none tracking-tight tabular-nums', color)}>{value}</span>
      {hint ? <span className='truncate text-[10.5px] text-content-subtle'>{hint}</span> : <span className='text-[10.5px]'>&nbsp;</span>}
    </Tag>
  );
}

function Stat({ label, value, accent = 'slate' }: { label: string; value: number; accent?: 'slate' | 'brand' | 'amber' | 'emerald' }) {
  const tone = {
    slate: 'text-content',
    brand: 'text-brand-700 dark:text-brand-300',
    amber: 'text-amber-700 dark:text-amber-300',
    emerald: 'text-emerald-700 dark:text-emerald-300',
  }[accent];
  return (
    <div className='rounded-md border border-edge-subtle bg-surface-sunken/40 px-1 py-1.5'>
      <div className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className='text-[9px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</div>
    </div>
  );
}

function LayoutBtn({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: ReactNode }) {
  return (
    <button type='button' title={title} aria-label={title} role='radio' aria-checked={on} onClick={onClick} className={cn('flex h-8 w-8 items-center justify-center rounded-md transition-colors', on ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-subtle hover:text-content')}>
      {children}
    </button>
  );
}

function MenuItem({ onClick, children, danger = false }: { onClick(): void; children: ReactNode; danger?: boolean }) {
  return (
    <button type='button' role='menuitem' onClick={onClick} className={cn('flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors', danger ? 'text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}>
      {children}
    </button>
  );
}

const I = ({ children, size = 13 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>{children}</svg>
);
const IconFilter = () => <I><path d='M3 5h18l-7 8v6l-4 2v-8z' /></I>;
const IconSort = () => <I><path d='M4 7h10M4 12h7M4 17h4M17 6v12m0 0 3-3m-3 3-3-3' /></I>;
const IconRows = () => <I size={14}><rect x='3' y='4' width='18' height='4' rx='1' /><rect x='3' y='10' width='18' height='4' rx='1' /><rect x='3' y='16' width='18' height='4' rx='1' /></I>;

export default RepoList;
