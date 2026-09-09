import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
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
import { copy, fmtKb, IconGrid, IconList, IconMore, IconPlus, IconRefresh, IconSearch, langColor, RepoBadges } from '../components/repo-bits.tsx';

/**
 * Repository management — the full Gitea surface for the active org:
 * stats strip (filters), search across name/description/topics/language,
 * visibility + state filters, sort, grid/table layouts, create repo, and a
 * detail drawer with files, branches, releases, collaborators, webhooks and
 * settings.
 */

type Visibility = 'all' | 'public' | 'private';
type State = 'all' | 'active' | 'archived' | 'template' | 'fork' | 'mirror' | 'empty';
type Sort = 'updated' | 'name' | 'stars' | 'issues' | 'created' | 'size';
type Layout = 'grid' | 'table';

interface Prefs {
  layout: Layout;
  sort: Sort;
}
const PREFS_KEY = 'adhar.develop.repos.prefs.v1';
function loadPrefs(): Prefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
    if (raw) return { layout: 'grid', sort: 'updated', ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch { /* ignore */ }
  return { layout: 'grid', sort: 'updated' };
}

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
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [openName, setOpenName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<gitea.Repo | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* ignore */ }
  }, [prefs]);

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
    out.sort((a, b) => {
      switch (prefs.sort) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'stars':
          return b.stars_count - a.stars_count || a.name.localeCompare(b.name);
        case 'issues':
          return b.open_issues_count - a.open_issues_count || a.name.localeCompare(b.name);
        case 'created':
          return (b.created_at ?? '').localeCompare(a.created_at ?? '');
        case 'size':
          return (b.size ?? 0) - (a.size ?? 0);
        default:
          return b.updated_at.localeCompare(a.updated_at);
      }
    });
    return out;
  }, [all, search, visibility, state, language, prefs.sort]);

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
    };
  }, [all, prCount]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast.success(label);
    } catch (e) {
      toast.error(label, { description: e instanceof Error ? e.message : String(e) });
    }
  };

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

  return (
    <div className='space-y-4'>
      {/* ── stats strip (click to filter) ── */}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8'>
        <StatTile label='Repositories' value={stats.total} hint={`${stats.active} active`} on={state === 'all' && visibility === 'all'} onClick={() => { setState('all'); setVisibility('all'); }} />
        <StatTile label='Private' value={stats.priv} tone='slate' on={visibility === 'private'} onClick={() => setVisibility(visibility === 'private' ? 'all' : 'private')} />
        <StatTile label='Public' value={stats.pub} tone='info' on={visibility === 'public'} onClick={() => setVisibility(visibility === 'public' ? 'all' : 'public')} />
        <StatTile label='Open issues' value={stats.issues} tone={stats.issues > 0 ? 'amber' : 'emerald'} on={prefs.sort === 'issues'} onClick={() => setPrefs((p) => ({ ...p, sort: p.sort === 'issues' ? 'updated' : 'issues' }))} hint={prefs.sort === 'issues' ? 'sorted by issues' : 'click to sort'} />
        <StatTile label='Open PRs' value={prs.isLoading ? '…' : stats.prs} tone={stats.prs > 0 ? 'brand' : 'slate'} hint='across the org' />
        <StatTile label='Templates' value={stats.templates} tone='violet' on={state === 'template'} onClick={() => setState(state === 'template' ? 'active' : 'template')} />
        <StatTile label='Archived' value={stats.archived} tone='slate' on={state === 'archived'} onClick={() => setState(state === 'archived' ? 'active' : 'archived')} />
        <StatTile label='Storage' value={fmtKb(stats.size)} hint={`${stats.stars} stars · ${stats.forks} forks`} />
      </div>

      {/* ── toolbar ── */}
      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative'>
          <span className='pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle'>
            <IconSearch />
          </span>
          <input
            type='search'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search name, description, topic…'
            className='block h-8 w-56 rounded-lg border border-edge-default bg-surface-raised pl-7 pr-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-72'
          />
        </div>
        <FilterSelect value={visibility} onChange={(v) => setVisibility(v as Visibility)} title='Visibility' options={[['all', 'Any visibility'], ['public', 'Public'], ['private', 'Private']]} />
        <FilterSelect value={state} onChange={(v) => setState(v as State)} title='State' options={[['active', 'Active'], ['all', 'All states'], ['archived', 'Archived'], ['template', 'Templates'], ['fork', 'Forks'], ['mirror', 'Mirrors'], ['empty', 'Empty']]} />
        {languages.length > 0
          ? (
            <FilterSelect value={language} onChange={setLanguage} title='Language' options={[['all', 'Any language'], ...languages.map(([l, n]) => [l, `${l} (${n})`] as [string, string])]} />
          )
          : null}
        <FilterSelect value={prefs.sort} onChange={(v) => setPrefs((p) => ({ ...p, sort: v as Sort }))} title='Sort' options={[['updated', 'Recently updated'], ['created', 'Newest'], ['name', 'Name A→Z'], ['stars', 'Most stars'], ['issues', 'Most issues'], ['size', 'Largest']]} />
        <span className='text-[11px] text-content-subtle'>
          {list.length === all.length ? `${all.length} repos` : `${list.length} of ${all.length}`}
        </span>
        <div className='ml-auto flex items-center gap-1.5'>
          <div className='flex items-center rounded-lg border border-edge-default bg-surface-raised p-0.5'>
            <LayoutBtn on={prefs.layout === 'grid'} onClick={() => setPrefs((p) => ({ ...p, layout: 'grid' }))} title='Grid'><IconGrid /></LayoutBtn>
            <LayoutBtn on={prefs.layout === 'table'} onClick={() => setPrefs((p) => ({ ...p, layout: 'table' }))} title='Table'><IconList /></LayoutBtn>
          </div>
          <Button size='sm' variant='secondary' onClick={() => { q.refetch(); prs.refetch(); }} title='Refresh'>
            <IconRefresh />
          </Button>
          <Button size='sm' variant='primary' onClick={() => setCreating(true)}>
            <IconPlus /> New repository
          </Button>
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
              : <Button size='sm' variant='secondary' onClick={() => { setSearch(''); setVisibility('all'); setState('all'); setLanguage('all'); }}>Clear filters</Button>}
          />
        )
        : prefs.layout === 'grid'
        ? (
          <div className='grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'>
            {list.map((r) => (
              <RepoCard
                key={r.id}
                repo={r}
                prs={prCount.get(r.name) ?? 0}
                onOpen={() => setOpenName(r.name)}
                onArchive={(archived) => act(archived ? `Archived ${r.name}` : `Unarchived ${r.name}`, () => update.mutateAsync({ repo: r.name, body: { archived } }))}
                onDelete={() => setConfirmDelete(r)}
              />
            ))}
          </div>
        )
        : (
          <RepoTable
            rows={list}
            prCount={prCount}
            onOpen={(r) => setOpenName(r.name)}
            onArchive={(r, archived) => act(archived ? `Archived ${r.name}` : `Unarchived ${r.name}`, () => update.mutateAsync({ repo: r.name, body: { archived } }))}
            onDelete={setConfirmDelete}
          />
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

/* ─────────── cards ─────────── */

function RepoCard({ repo: r, prs, onOpen, onArchive, onDelete }: {
  repo: gitea.Repo;
  prs: number;
  onOpen(): void;
  onArchive(archived: boolean): void;
  onDelete(): void;
}) {
  const [menu, setMenu] = useState(false);
  const toast = useToast();
  const topics = (r.topics ?? []).slice(0, 4);
  return (
    <Card className={cn('relative overflow-hidden border', r.archived ? 'border-edge-subtle opacity-80' : 'border-edge-default')} interactive>
      <div className='absolute inset-y-0 left-0 w-1' style={{ background: langColor(r.language) }} aria-hidden />
      <div className='p-4 pl-5'>
        <div className='flex items-start gap-3'>
          <button type='button' onClick={onOpen} className='min-w-0 flex-1 text-left'>
            <div className='flex items-center gap-2'>
              <RepoMark name={r.name} />
              <div className='min-w-0'>
                <div className='flex flex-wrap items-center gap-1.5'>
                  <span className='truncate text-sm font-semibold text-content'>{r.name}</span>
                  <RepoBadges repo={r} />
                </div>
                <div className='mt-0.5 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-content-subtle'>
                  <span className='rounded-md bg-surface-sunken px-1.5 py-0.5 normal-case'>{r.default_branch}</span>
                  {r.language ? <span className='flex items-center gap-1 normal-case'><i className='h-2 w-2 rounded-full' style={{ background: langColor(r.language) }} />{r.language}</span> : null}
                  {r.fork && r.parent ? <span className='normal-case'>forked from {r.parent.full_name}</span> : null}
                </div>
              </div>
            </div>
            <p className={cn('mt-2.5 line-clamp-2 min-h-[2lh] text-xs leading-relaxed', r.description ? 'text-content-muted' : 'italic text-content-subtle')}>
              {r.description || 'No description'}
            </p>
          </button>
          <div className='relative shrink-0'>
            <button
              type='button'
              aria-label='Repository actions'
              onClick={() => setMenu((m) => !m)}
              className='flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'
            >
              <IconMore />
            </button>
            {menu
              ? (
                <>
                  <div className='fixed inset-0 z-30' aria-hidden onClick={() => setMenu(false)} />
                  <div className='absolute right-0 top-full z-40 mt-1 w-48 rounded-xl border border-edge-default bg-surface-raised p-1 shadow-xl'>
                    <MenuItem onClick={() => { setMenu(false); onOpen(); }}>Open details</MenuItem>
                    <MenuItem onClick={() => { setMenu(false); copy(r.clone_url ?? `${r.html_url}.git`, toast); }}>Copy HTTPS clone URL</MenuItem>
                    {r.ssh_url ? <MenuItem onClick={() => { setMenu(false); copy(r.ssh_url!, toast); }}>Copy SSH clone URL</MenuItem> : null}
                    <MenuItem onClick={() => { setMenu(false); window.open(r.html_url, '_blank', 'noopener'); }}>Open in Gitea ↗</MenuItem>
                    <div className='my-1 border-t border-edge-subtle' />
                    <MenuItem onClick={() => { setMenu(false); onArchive(!r.archived); }}>{r.archived ? 'Unarchive' : 'Archive'}</MenuItem>
                    <MenuItem danger onClick={() => { setMenu(false); onDelete(); }}>Delete…</MenuItem>
                  </div>
                </>
              )
              : null}
          </div>
        </div>

        {topics.length
          ? (
            <div className='mt-2 flex flex-wrap gap-1'>
              {topics.map((t) => <span key={t} className='rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'>{t}</span>)}
              {(r.topics?.length ?? 0) > 4 ? <span className='text-[10px] text-content-subtle'>+{r.topics!.length - 4}</span> : null}
            </div>
          )
          : null}

        <div className='mt-3 grid grid-cols-4 gap-1.5 text-center'>
          <Stat label='Issues' value={r.open_issues_count} accent={r.open_issues_count > 0 ? 'amber' : 'emerald'} />
          <Stat label='PRs' value={prs} accent={prs > 0 ? 'brand' : 'slate'} />
          <Stat label='Stars' value={r.stars_count} />
          <Stat label='Forks' value={r.forks_count} />
        </div>
        <div className='mt-3 flex items-center justify-between gap-3 border-t border-edge-subtle pt-2.5 text-[11px] text-content-muted'>
          <span title={r.updated_at}>Updated {formatRelative(r.updated_at)}</span>
          <span className='font-mono text-[10px] text-content-subtle'>{r.size !== undefined ? fmtKb(r.size) : ''}</span>
        </div>
      </div>
    </Card>
  );
}

function RepoTable({ rows, prCount, onOpen, onArchive, onDelete }: {
  rows: gitea.Repo[];
  prCount: Map<string, number>;
  onOpen(r: gitea.Repo): void;
  onArchive(r: gitea.Repo, archived: boolean): void;
  onDelete(r: gitea.Repo): void;
}) {
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default bg-surface-raised'>
      <table className='w-full text-left text-xs'>
        <thead className='bg-surface-sunken/60 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
          <tr>
            <th className='px-3 py-2'>Repository</th>
            <th className='px-3 py-2'>Language</th>
            <th className='px-3 py-2'>Branch</th>
            <th className='px-3 py-2 text-right'>Issues</th>
            <th className='px-3 py-2 text-right'>PRs</th>
            <th className='px-3 py-2 text-right'>Stars</th>
            <th className='px-3 py-2 text-right'>Size</th>
            <th className='px-3 py-2'>Updated</th>
            <th className='px-3 py-2 text-right'>Actions</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {rows.map((r) => (
            <tr key={r.id} className={cn('hover:bg-surface-sunken/40', r.archived && 'opacity-70')}>
              <td className='px-3 py-2'>
                <button type='button' onClick={() => onOpen(r)} className='flex items-center gap-2 text-left'>
                  <RepoMark name={r.name} />
                  <div className='min-w-0'>
                    <div className='flex items-center gap-1.5'>
                      <span className='font-semibold text-content'>{r.name}</span>
                      <RepoBadges repo={r} compact />
                    </div>
                    {r.description ? <div className='max-w-md truncate text-[11px] text-content-muted'>{r.description}</div> : null}
                  </div>
                </button>
              </td>
              <td className='px-3 py-2 text-content-muted'>
                {r.language ? <span className='flex items-center gap-1'><i className='h-2 w-2 rounded-full' style={{ background: langColor(r.language) }} />{r.language}</span> : '—'}
              </td>
              <td className='px-3 py-2 font-mono text-[11px] text-content-muted'>{r.default_branch}</td>
              <td className={cn('px-3 py-2 text-right tabular-nums', r.open_issues_count > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-content-muted')}>{r.open_issues_count}</td>
              <td className='px-3 py-2 text-right tabular-nums text-content-muted'>{prCount.get(r.name) ?? 0}</td>
              <td className='px-3 py-2 text-right tabular-nums text-content-muted'>{r.stars_count}</td>
              <td className='px-3 py-2 text-right font-mono text-[11px] text-content-subtle'>{r.size !== undefined ? fmtKb(r.size) : '—'}</td>
              <td className='px-3 py-2 text-content-muted' title={r.updated_at}>{formatRelative(r.updated_at)}</td>
              <td className='px-3 py-2'>
                <div className='flex justify-end gap-1'>
                  <Button size='xs' variant='ghost' onClick={() => onOpen(r)}>Open</Button>
                  <Button size='xs' variant='ghost' onClick={() => onArchive(r, !r.archived)}>{r.archived ? 'Unarchive' : 'Archive'}</Button>
                  <Button size='xs' variant='ghost' onClick={() => onDelete(r)} className='text-rose-700 dark:text-rose-300'>Delete</Button>
                </div>
              </td>
            </tr>
          ))}
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
        on ? 'border-brand-400 bg-brand-50/60 ring-2 ring-brand-400/20 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised',
        onClick && 'hover:border-brand-300',
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

function FilterSelect({ value, onChange, options, title }: { value: string; onChange(v: string): void; options: Array<[string, string]>; title: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title={title} aria-label={title} className='h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content-muted focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'>
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}

function LayoutBtn({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: React.ReactNode }) {
  return (
    <button type='button' title={title} aria-pressed={on} onClick={onClick} className={cn('flex h-7 w-7 items-center justify-center rounded-md transition-colors', on ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:text-content')}>
      {children}
    </button>
  );
}

function MenuItem({ onClick, children, danger = false }: { onClick(): void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type='button' onClick={onClick} className={cn('flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-sunken', danger ? 'text-rose-700 dark:text-rose-300' : 'text-content-muted hover:text-content')}>
      {children}
    </button>
  );
}

export default RepoList;
