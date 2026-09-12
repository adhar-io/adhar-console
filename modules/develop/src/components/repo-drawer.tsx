import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
  useToast,
} from '@adhar-console/shell-ui';
import { cn, formatRelative } from '@adhar-console/utils';
import type { gitea } from '@adhar-console/api-clients';
import {
  useAddCollaborator,
  useBranchProtections,
  useBranches,
  useCollaborators,
  useCommits,
  useCreateBranch,
  useCreateRelease,
  useCreateTag,
  useCreateWebhook,
  useDeleteBranch,
  useDeleteRelease,
  useDeleteRepo,
  useDeleteTag,
  useDeleteWebhook,
  useIssues,
  useProtectBranch,
  usePullRequests,
  useReadme,
  useReleases,
  useRemoveCollaborator,
  useRepoLanguages,
  useRepoTopics,
  useSetTopics,
  useTags,
  useTestWebhook,
  useUnprotectBranch,
  useUpdateRepo,
  useUpdateWebhook,
  useUserSearch,
  useWebhooks,
} from '../data/git.ts';
import { RepoMark } from './repo-picker.tsx';
import { FileBrowser } from './file-browser.tsx';
import { CloudEnvLaunch } from './cloud-env-launch.tsx'
import { copy, fmtKb, IconBranch, IconClose, IconCopy, IconExternal, IconPlus, IconShield, IconTag, IconTrash, IconUsers, IconWebhook, langColor, RepoBadges } from './repo-bits.tsx';

type TabId = 'overview' | 'files' | 'branches' | 'commits' | 'pulls' | 'issues' | 'releases' | 'people' | 'hooks' | 'settings';

/**
 * Right-hand repository drawer — every Gitea management surface for one repo
 * behind tabs. Mutations toast; nothing is rendered inline as status text.
 */
export function RepoDrawer({ repo: r, onClose, onDeleted }: { repo: gitea.Repo; onClose(): void; onDeleted(): void }) {
  const [tab, setTab] = useState<TabId>('overview');
  const branches = useBranches(r.name);
  const prs = usePullRequests(r.name, 'open');
  const issues = useIssues(r.name, 'open');
  const releases = useReleases(r.name);
  const hooks = useWebhooks(r.name);
  const people = useCollaborators(r.name);
  const toast = useToast();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const cloneUrl = r.clone_url ?? `${r.html_url}.git`;

  return createPortal(
    <div className='fixed inset-0 z-50 flex justify-end' role='dialog' aria-modal='true'>
      <button type='button' aria-label='Close' className='absolute inset-0 bg-scrim/40 backdrop-blur-[2px]' onClick={onClose} />
      <aside className='relative flex h-full w-full max-w-4xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl'>
        <header className='flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4'>
          <div className='flex min-w-0 items-start gap-3'>
            <RepoMark name={r.name} />
            <div className='min-w-0'>
              <div className='flex flex-wrap items-center gap-1.5'>
                <h2 className='truncate text-lg font-semibold tracking-tight text-content'>{r.full_name}</h2>
                <RepoBadges repo={r} />
              </div>
              <div className='mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted'>
                <span className='font-mono'>{r.default_branch}</span>
                {r.language ? <span className='flex items-center gap-1'><i className='h-2 w-2 rounded-full' style={{ background: langColor(r.language) }} />{r.language}</span> : null}
                <span title={r.updated_at}>updated {formatRelative(r.updated_at)}</span>
                {r.created_at ? <span title={r.created_at}>created {formatRelative(r.created_at)}</span> : null}
                {r.size !== undefined ? <span>{fmtKb(r.size)}</span> : null}
              </div>
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-1.5'>
            <CloudEnvLaunch repo={r.name} cloneUrl={cloneUrl} />
            <Button size='sm' variant='secondary' onClick={() => copy(cloneUrl, toast)} title={cloneUrl}>
              <IconCopy /> Clone
            </Button>
            <a
              href={r.html_url}
              target='_blank'
              rel='noopener'
              className='inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700'
            >
              Gitea <IconExternal />
            </a>
            <button type='button' onClick={onClose} aria-label='Close' className='flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'>
              <IconClose />
            </button>
          </div>
        </header>

        <div className='flex-1 overflow-y-auto px-6 py-4'>
          <Tabs<TabId>
            ariaLabel='Repository'
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'files', label: 'Files' },
              { id: 'branches', label: 'Branches', badge: branches.data?.length ? { kind: 'unknown', value: branches.data.length } : undefined },
              { id: 'commits', label: 'Commits' },
              { id: 'pulls', label: 'PRs', badge: prs.data?.length ? { kind: 'info', value: prs.data.length } : undefined },
              { id: 'issues', label: 'Issues', badge: issues.data?.length ? { kind: 'degraded', value: issues.data.length } : undefined },
              { id: 'releases', label: 'Releases', badge: releases.data?.length ? { kind: 'unknown', value: releases.data.length } : undefined },
              { id: 'people', label: 'People', badge: people.data?.length ? { kind: 'unknown', value: people.data.length } : undefined },
              { id: 'hooks', label: 'Webhooks', badge: hooks.data?.length ? { kind: 'unknown', value: hooks.data.length } : undefined },
              { id: 'settings', label: 'Settings' },
            ]}
          >
            {(active) => (
              <div className='pt-4'>
                {active === 'overview' && <OverviewTab repo={r} prs={prs.data?.length ?? 0} onGo={setTab} />}
                {active === 'files' && <FileBrowser repo={r} />}
                {active === 'branches' && <BranchesTab repo={r} />}
                {active === 'commits' && <CommitsTab repo={r} />}
                {active === 'pulls' && <PullsTab repo={r} />}
                {active === 'issues' && <IssuesTab repo={r} />}
                {active === 'releases' && <ReleasesTab repo={r} />}
                {active === 'people' && <PeopleTab repo={r} />}
                {active === 'hooks' && <HooksTab repo={r} />}
                {active === 'settings' && <SettingsTab repo={r} onDeleted={onDeleted} />}
              </div>
            )}
          </Tabs>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/* ─────────── helpers ─────────── */

function useAct() {
  const toast = useToast();
  return async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn();
      toast.success(label);
      after?.();
    } catch (e) {
      toast.error(label, { description: e instanceof Error ? e.message : String(e) });
    }
  };
}

function Section({ title, count, loading, actions, children }: { title: string; count?: number; loading?: boolean; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div className='flex items-center justify-between gap-2'>
          <div className='flex items-center gap-2 text-sm font-semibold text-content'>
            {title}
            {count !== undefined ? <span className='rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted'>{count}</span> : null}
            {loading ? <Spinner size={10} /> : null}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function Tile({ label, value, onClick }: { label: string; value: string | number; onClick?(): void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={cn('rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3 text-left', onClick && 'hover:border-brand-300')}>
      <div className='truncate text-base font-semibold tabular-nums text-content'>{value}</div>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</div>
    </Tag>
  );
}

/* ─────────── overview ─────────── */

function OverviewTab({ repo: r, prs, onGo }: { repo: gitea.Repo; prs: number; onGo(t: TabId): void }) {
  const langs = useRepoLanguages(r.name);
  const topics = useRepoTopics(r.name);
  const readme = useReadme(r.name, r.default_branch);
  const setTopics = useSetTopics();
  const act = useAct();
  const toast = useToast();
  const [editingTopics, setEditingTopics] = useState<string | null>(null);

  const langTotal = Object.values(langs.data ?? {}).reduce((s, n) => s + n, 0);
  const langRows = Object.entries(langs.data ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
        <Tile label='Open issues' value={r.open_issues_count} onClick={() => onGo('issues')} />
        <Tile label='Open PRs' value={prs} onClick={() => onGo('pulls')} />
        <Tile label='Releases' value={r.release_counter ?? '—'} onClick={() => onGo('releases')} />
        <Tile label='Stars · forks · watch' value={`${r.stars_count} · ${r.forks_count} · ${r.watchers_count ?? 0}`} />
      </div>

      <div className='grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]'>
        <Section title={readme.data ? readme.data.path : 'README'} loading={readme.isLoading}>
          {readme.data
            ? <Markdown text={readme.data.text} />
            : readme.isLoading
            ? null
            : (
              <EmptyState
                compact
                title='No README'
                description={r.empty ? 'The repository is empty — push a first commit to get started.' : 'Add a README.md at the repo root to show it here.'}
                action={<Button size='sm' variant='secondary' onClick={() => onGo('files')}>Browse files</Button>}
              />
            )}
        </Section>

        <div className='space-y-4'>
          <Section
            title='Topics'
            actions={<Button size='xs' variant='ghost' onClick={() => setEditingTopics((topics.data ?? []).join(', '))}>Edit</Button>}
          >
            {editingTopics !== null
              ? (
                <div className='space-y-2'>
                  <Textarea rows={3} value={editingTopics} onChange={(e) => setEditingTopics(e.target.value)} placeholder='comma, separated, topics' />
                  <div className='flex justify-end gap-1.5'>
                    <Button size='xs' variant='secondary' onClick={() => setEditingTopics(null)}>Cancel</Button>
                    <Button
                      size='xs'
                      disabled={setTopics.isPending}
                      onClick={() => {
                        const list = [...new Set(editingTopics.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 25);
                        act('Topics updated', () => setTopics.mutateAsync({ repo: r.name, topics: list }), () => setEditingTopics(null));
                      }}
                    >
                      Save
                    </Button>
                  </div>
                  <p className='text-[10.5px] text-content-subtle'>Lowercase, up to 25 topics, 35 chars each.</p>
                </div>
              )
              : (topics.data?.length
                ? (
                  <div className='flex flex-wrap gap-1'>
                    {topics.data.map((t) => <span key={t} className='rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'>{t}</span>)}
                  </div>
                )
                : <p className='text-xs text-content-subtle'>No topics yet.</p>)}
          </Section>

          <Section title='Languages' loading={langs.isLoading}>
            {langRows.length
              ? (
                <div className='space-y-2'>
                  <div className='flex h-2 overflow-hidden rounded-full bg-surface-sunken'>
                    {langRows.map(([l, n]) => <div key={l} style={{ width: `${(n / langTotal) * 100}%`, background: langColor(l) }} title={l} />)}
                  </div>
                  <ul className='space-y-1'>
                    {langRows.map(([l, n]) => (
                      <li key={l} className='flex items-center gap-2 text-[11px]'>
                        <i className='h-2 w-2 rounded-full' style={{ background: langColor(l) }} />
                        <span className='text-content'>{l}</span>
                        <span className='ml-auto tabular-nums text-content-subtle'>{((n / langTotal) * 100).toFixed(1)}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : <p className='text-xs text-content-subtle'>No language data.</p>}
          </Section>

          <Section title='Clone'>
            <div className='space-y-1.5'>
              <CloneRow label='HTTPS' value={r.clone_url ?? `${r.html_url}.git`} onCopy={(v) => copy(v, toast)} />
              {r.ssh_url ? <CloneRow label='SSH' value={r.ssh_url} onCopy={(v) => copy(v, toast)} /> : null}
            </div>
            {r.website ? <a href={r.website} target='_blank' rel='noopener' className='mt-2 block truncate text-[11px] text-brand-700 hover:underline dark:text-brand-300'>{r.website}</a> : null}
          </Section>
        </div>
      </div>
    </div>
  );
}

function CloneRow({ label, value, onCopy }: { label: string; value: string; onCopy(v: string): void }) {
  return (
    <div className='flex items-center gap-1.5'>
      <span className='w-10 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</span>
      <code className='min-w-0 flex-1 truncate rounded-md bg-surface-sunken px-2 py-1 font-mono text-[10.5px] text-content' title={value}>{value}</code>
      <button type='button' onClick={() => onCopy(value)} aria-label={`Copy ${label} URL`} className='flex h-6 w-6 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'>
        <IconCopy />
      </button>
    </div>
  );
}

/* ─────────── branches ─────────── */

function BranchesTab({ repo: r }: { repo: gitea.Repo }) {
  const branches = useBranches(r.name);
  const protections = useBranchProtections(r.name);
  const create = useCreateBranch();
  const del = useDeleteBranch();
  const protect = useProtectBranch();
  const unprotect = useUnprotectBranch();
  const update = useUpdateRepo();
  const act = useAct();
  const [newName, setNewName] = useState('');
  const [from, setFrom] = useState(r.default_branch);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [protecting, setProtecting] = useState<string | null>(null);
  const [approvals, setApprovals] = useState(1);
  const [blockPush, setBlockPush] = useState(true);

  const rules = protections.data ?? [];
  const ruleFor = (name: string) => rules.find((p) => (p.rule_name ?? p.branch_name) === name);
  const list = useMemo(() => [...(branches.data ?? [])].sort((a, b) => (a.name === r.default_branch ? -1 : b.name === r.default_branch ? 1 : b.commit.timestamp.localeCompare(a.commit.timestamp))), [branches.data, r.default_branch]);

  return (
    <div className='space-y-4'>
      <Section title='Create branch'>
        <div className='flex flex-wrap items-end gap-2'>
          <Field label='Name' className='min-w-48 flex-1'>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder='feat/my-change' />
          </Field>
          <Field label='From'>
            <Select value={from} onChange={(e) => setFrom(e.target.value)} options={list.map((b) => ({ value: b.name, label: b.name }))} />
          </Field>
          <Button
            size='sm'
            disabled={!newName.trim() || create.isPending}
            onClick={() => act(`Created ${newName}`, () => create.mutateAsync({ repo: r.name, name: newName.trim(), from }), () => setNewName(''))}
          >
            <IconPlus /> Create
          </Button>
        </div>
      </Section>

      <Section title='Branches' count={list.length} loading={branches.isLoading || protections.isLoading}>
        {list.length
          ? (
            <ul className='divide-y divide-edge-subtle'>
              {list.map((b) => {
                const rule = ruleFor(b.name);
                const isDefault = b.name === r.default_branch;
                return (
                  <li key={b.name} className='flex flex-wrap items-center gap-2 py-2 text-sm'>
                    <IconBranch />
                    <code className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content'>{b.name}</code>
                    {isDefault ? <StatusBadge kind='info'>default</StatusBadge> : null}
                    {rule || b.protected ? <StatusBadge kind='healthy'><IconShield /> protected{rule?.required_approvals ? ` · ${rule.required_approvals} approval${rule.required_approvals === 1 ? '' : 's'}` : ''}</StatusBadge> : null}
                    <span className='min-w-0 flex-1 truncate text-[11px] text-content-subtle'>{b.commit.message.split('\n')[0]}</span>
                    <span className='text-[11px] text-content-muted' title={b.commit.timestamp}>{b.commit.author.name} · {formatRelative(b.commit.timestamp)}</span>
                    <div className='flex items-center gap-1'>
                      {!isDefault
                        ? (
                          <Button size='xs' variant='ghost' disabled={update.isPending} onClick={() => act(`Default branch → ${b.name}`, () => update.mutateAsync({ repo: r.name, body: { default_branch: b.name } }))}>
                            Set default
                          </Button>
                        )
                        : null}
                      {rule
                        ? <Button size='xs' variant='ghost' disabled={unprotect.isPending} onClick={() => act(`Unprotected ${b.name}`, () => unprotect.mutateAsync({ repo: r.name, ruleName: rule.rule_name ?? rule.branch_name ?? b.name }))}>Unprotect</Button>
                        : <Button size='xs' variant='ghost' onClick={() => setProtecting(b.name)}>Protect</Button>}
                      {!isDefault ? <Button size='xs' variant='ghost' className='text-rose-700 dark:text-rose-300' onClick={() => setConfirm(b.name)}>Delete</Button> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )
          : <EmptyState compact title='No branches' description='Push a commit to create the first branch.' />}
      </Section>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Delete branch ${confirm ?? ''}?`}
        description='Unmerged commits on this branch are lost unless another branch or tag points at them.'
        width='sm'
        footer={
          <div className='flex justify-end gap-2'>
            <Button size='sm' variant='secondary' onClick={() => setConfirm(null)}>Cancel</Button>
            <Button size='sm' variant='danger' disabled={del.isPending} onClick={() => act(`Deleted ${confirm}`, () => del.mutateAsync({ repo: r.name, name: confirm! }), () => setConfirm(null))}>Delete branch</Button>
          </div>
        }
      >
        <span />
      </Modal>

      <Modal
        open={!!protecting}
        onClose={() => setProtecting(null)}
        title={`Protect ${protecting ?? ''}`}
        description='Direct pushes are blocked; changes land through pull requests.'
        width='sm'
        footer={
          <div className='flex justify-end gap-2'>
            <Button size='sm' variant='secondary' onClick={() => setProtecting(null)}>Cancel</Button>
            <Button
              size='sm'
              disabled={protect.isPending}
              onClick={() =>
                act(`Protected ${protecting}`, () =>
                  protect.mutateAsync({
                    repo: r.name,
                    body: { rule_name: protecting!, enable_push: !blockPush, required_approvals: approvals, block_on_rejected_reviews: true, dismiss_stale_approvals: true },
                  }), () => setProtecting(null))}
            >
              Protect branch
            </Button>
          </div>
        }
      >
        <div className='space-y-3'>
          <Checkbox label='Block direct pushes' description='Only merges through pull requests.' checked={blockPush} onChange={(e) => setBlockPush(e.target.checked)} />
          <Field label='Required approvals'>
            <Input type='number' min={0} max={10} value={approvals} onChange={(e) => setApprovals(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/* ─────────── commits ─────────── */

function CommitsTab({ repo: r }: { repo: gitea.Repo }) {
  const branches = useBranches(r.name);
  const [ref, setRef] = useState(r.default_branch);
  const [limit, setLimit] = useState(30);
  const commits = useCommits(r.name, ref, limit);
  const toast = useToast();
  return (
    <Section
      title='Commits'
      count={commits.data?.length}
      loading={commits.isLoading}
      actions={
        <select value={ref} onChange={(e) => setRef(e.target.value)} aria-label='Branch' className='h-7 rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-[11px] text-content focus:outline-none'>
          {(branches.data ?? [{ name: r.default_branch }]).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
      }
    >
      {commits.data?.length
        ? (
          <>
            <ul className='divide-y divide-edge-subtle'>
              {commits.data.map((c) => (
                <li key={c.sha} className='flex items-start gap-2 py-2 text-sm'>
                  <button type='button' onClick={() => copy(c.sha, toast)} title='Copy full SHA' className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted hover:text-content'>{c.short_sha}</button>
                  <div className='min-w-0 flex-1'>
                    <div className='truncate text-content'>{c.message.split('\n')[0]}</div>
                    <div className='text-[11px] text-content-subtle'>{c.author.login} · {formatRelative(c.created)}</div>
                  </div>
                  {c.stats
                    ? (
                      <span className='shrink-0 font-mono text-[11px]'>
                        <span className='text-emerald-700 dark:text-emerald-300'>+{c.stats.additions}</span> <span className='text-rose-700 dark:text-rose-300'>-{c.stats.deletions}</span>
                      </span>
                    )
                    : null}
                </li>
              ))}
            </ul>
            {commits.data.length >= limit ? <Button size='xs' variant='ghost' className='mt-2' onClick={() => setLimit((n) => n + 30)}>Load more</Button> : null}
          </>
        )
        : commits.isLoading
        ? <div className='flex items-center gap-2 py-6 text-xs text-content-muted'><Spinner size={12} /> Loading history…</div>
        : <EmptyState compact title='No commits' />}
    </Section>
  );
}

/* ─────────── pulls / issues ─────────── */

function PullsTab({ repo: r }: { repo: gitea.Repo }) {
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const prs = usePullRequests(r.name, state);
  return (
    <Section title='Pull requests' count={prs.data?.length} loading={prs.isLoading} actions={<StateSwitch value={state} onChange={setState} />}>
      {prs.data?.length
        ? (
          <ul className='divide-y divide-edge-subtle'>
            {prs.data.map((p) => (
              <li key={p.id} className='flex items-center gap-2 py-2 text-sm'>
                <code className='font-mono text-[10px] text-content-muted'>#{p.number}</code>
                <a href={p.html_url} target='_blank' rel='noopener' className='min-w-0 flex-1 truncate text-content hover:text-brand-700 hover:underline dark:hover:text-brand-300'>{p.title}</a>
                {p.merged ? <StatusBadge kind='healthy'>merged</StatusBadge> : p.state === 'closed' ? <StatusBadge kind='unknown'>closed</StatusBadge> : p.mergeable === false ? <StatusBadge kind='degraded'>conflicts</StatusBadge> : null}
                {p.head ? <span className='hidden font-mono text-[10px] text-content-subtle sm:inline'>{p.head.ref} → {p.base?.ref ?? r.default_branch}</span> : null}
                <span className='text-[11px] text-content-subtle'>{formatRelative(p.updated_at ?? p.created_at)}</span>
                <img src={p.user.avatar_url} alt='' className='h-5 w-5 rounded-full ring-1 ring-edge-subtle' />
              </li>
            ))}
          </ul>
        )
        : <EmptyState compact title={`No ${state === 'all' ? '' : state} pull requests`} />}
    </Section>
  );
}

function IssuesTab({ repo: r }: { repo: gitea.Repo }) {
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const issues = useIssues(r.name, state);
  return (
    <Section
      title='Issues'
      count={issues.data?.length}
      loading={issues.isLoading}
      actions={
        <div className='flex items-center gap-1.5'>
          <StateSwitch value={state} onChange={setState} />
          <a href={`${r.html_url}/issues/new`} target='_blank' rel='noopener' className='inline-flex h-7 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] font-medium text-content hover:border-brand-400'>
            <IconPlus size={12} /> New
          </a>
        </div>
      }
    >
      {issues.data?.length
        ? (
          <ul className='divide-y divide-edge-subtle'>
            {issues.data.map((it) => (
              <li key={it.id} className='flex items-center gap-2 py-2 text-sm'>
                <code className='font-mono text-[10px] text-content-muted'>#{it.number}</code>
                <a href={`${r.html_url}/issues/${it.number}`} target='_blank' rel='noopener' className='min-w-0 flex-1 truncate text-content hover:text-brand-700 hover:underline dark:hover:text-brand-300'>{it.title}</a>
                <div className='flex flex-wrap gap-1'>
                  {it.labels.map((l) => (
                    <span key={l.name} className='rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset' style={{ color: `#${l.color}`, borderColor: `#${l.color}66` }}>{l.name}</span>
                  ))}
                </div>
                {it.state === 'closed' ? <StatusBadge kind='unknown'>closed</StatusBadge> : null}
                <span className='text-[11px] text-content-subtle'>{it.user.login} · {formatRelative(it.created_at)}</span>
              </li>
            ))}
          </ul>
        )
        : <EmptyState compact title={`No ${state === 'all' ? '' : state} issues`} />}
    </Section>
  );
}

function StateSwitch({ value, onChange }: { value: 'open' | 'closed' | 'all'; onChange(v: 'open' | 'closed' | 'all'): void }) {
  return (
    <div className='flex items-center rounded-lg border border-edge-default bg-surface-raised p-0.5 text-[11px]'>
      {(['open', 'closed', 'all'] as const).map((s) => (
        <button key={s} type='button' onClick={() => onChange(s)} aria-pressed={value === s} className={cn('rounded-md px-2 py-0.5 capitalize', value === s ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:text-content')}>
          {s}
        </button>
      ))}
    </div>
  );
}

/* ─────────── releases + tags ─────────── */

function ReleasesTab({ repo: r }: { repo: gitea.Repo }) {
  const releases = useReleases(r.name);
  const tags = useTags(r.name);
  const branches = useBranches(r.name);
  const createRel = useCreateRelease();
  const delRel = useDeleteRelease();
  const createTag = useCreateTag();
  const delTag = useDeleteTag();
  const act = useAct();
  const [creating, setCreating] = useState<null | 'release' | 'tag'>(null);
  const [tagName, setTagName] = useState('');
  const [target, setTarget] = useState(r.default_branch);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [prerelease, setPrerelease] = useState(false);
  const [draft, setDraft] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'release'; id: number; label: string } | { kind: 'tag'; tag: string } | null>(null);

  const reset = () => {
    setCreating(null);
    setTagName('');
    setTitle('');
    setNotes('');
    setPrerelease(false);
    setDraft(false);
  };
  const releasedTags = new Set((releases.data ?? []).map((x) => x.tag_name));

  return (
    <div className='space-y-4'>
      <Section
        title='Releases'
        count={releases.data?.length}
        loading={releases.isLoading}
        actions={<Button size='xs' onClick={() => setCreating('release')}><IconPlus size={12} /> New release</Button>}
      >
        {releases.data?.length
          ? (
            <ul className='divide-y divide-edge-subtle'>
              {releases.data.map((rel) => (
                <li key={rel.id} className='py-3'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <IconTag />
                    <a href={rel.html_url ?? `${r.html_url}/releases/tag/${rel.tag_name}`} target='_blank' rel='noopener' className='text-sm font-semibold text-content hover:text-brand-700 hover:underline dark:hover:text-brand-300'>{rel.name || rel.tag_name}</a>
                    <code className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted'>{rel.tag_name}</code>
                    {rel.draft ? <StatusBadge kind='unknown'>draft</StatusBadge> : null}
                    {rel.prerelease ? <StatusBadge kind='degraded'>pre-release</StatusBadge> : null}
                    <span className='ml-auto text-[11px] text-content-subtle'>{rel.author?.login ? `${rel.author.login} · ` : ''}{formatRelative(rel.published_at ?? rel.created_at)}</span>
                    <Button size='xs' variant='ghost' className='text-rose-700 dark:text-rose-300' onClick={() => setConfirm({ kind: 'release', id: rel.id, label: rel.name || rel.tag_name })}><IconTrash /></Button>
                  </div>
                  {rel.body ? <p className='mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-content-muted'>{rel.body}</p> : null}
                  {rel.assets?.length
                    ? (
                      <div className='mt-1.5 flex flex-wrap gap-1.5'>
                        {rel.assets.map((a) => (
                          <a key={a.id} href={a.browser_download_url} className='rounded-md border border-edge-subtle bg-surface-sunken/40 px-1.5 py-0.5 text-[10.5px] text-content-muted hover:text-content'>
                            {a.name}{a.download_count !== undefined ? ` · ${a.download_count}↓` : ''}
                          </a>
                        ))}
                      </div>
                    )
                    : null}
                </li>
              ))}
            </ul>
          )
          : <EmptyState compact title='No releases' description='Cut a release from a tag or a branch to publish artefacts and notes.' />}
      </Section>

      <Section
        title='Tags'
        count={tags.data?.length}
        loading={tags.isLoading}
        actions={<Button size='xs' variant='secondary' onClick={() => setCreating('tag')}><IconPlus size={12} /> New tag</Button>}
      >
        {tags.data?.length
          ? (
            <ul className='divide-y divide-edge-subtle'>
              {tags.data.map((t) => (
                <li key={t.name} className='flex items-center gap-2 py-1.5 text-sm'>
                  <code className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content'>{t.name}</code>
                  {releasedTags.has(t.name) ? <StatusBadge kind='healthy'>released</StatusBadge> : null}
                  <span className='min-w-0 flex-1 truncate text-[11px] text-content-subtle'>{t.message?.split('\n')[0] ?? ''}</span>
                  {t.commit ? <code className='font-mono text-[10px] text-content-subtle'>{t.commit.sha.slice(0, 7)}</code> : null}
                  {t.commit?.created ? <span className='text-[11px] text-content-subtle'>{formatRelative(t.commit.created)}</span> : null}
                  <Button size='xs' variant='ghost' className='text-rose-700 dark:text-rose-300' onClick={() => setConfirm({ kind: 'tag', tag: t.name })}><IconTrash /></Button>
                </li>
              ))}
            </ul>
          )
          : <EmptyState compact title='No tags' />}
      </Section>

      <Modal
        open={creating !== null}
        onClose={reset}
        title={creating === 'tag' ? 'New tag' : 'New release'}
        description={creating === 'tag' ? 'Creates a lightweight or annotated tag at the target.' : 'Creates the tag if it does not exist and publishes release notes.'}
        branded
        footer={
          <div className='flex justify-end gap-2'>
            <Button size='sm' variant='secondary' onClick={reset}>Cancel</Button>
            <Button
              size='sm'
              disabled={!tagName.trim() || createRel.isPending || createTag.isPending}
              onClick={() =>
                creating === 'tag'
                  ? act(`Tagged ${tagName}`, () => createTag.mutateAsync({ repo: r.name, body: { tag_name: tagName.trim(), target, message: notes || undefined } }), reset)
                  : act(`Released ${tagName}`, () => createRel.mutateAsync({ repo: r.name, body: { tag_name: tagName.trim(), target_commitish: target, name: title || tagName.trim(), body: notes || undefined, prerelease, draft } }), reset)}
            >
              {creating === 'tag' ? 'Create tag' : draft ? 'Save draft' : 'Publish release'}
            </Button>
          </div>
        }
      >
        <div className='space-y-3'>
          <div className='grid grid-cols-2 gap-3'>
            <Field label='Tag' required>
              <Input value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder='v1.2.0' autoFocus />
            </Field>
            <Field label='Target'>
              <Select value={target} onChange={(e) => setTarget(e.target.value)} options={(branches.data ?? [{ name: r.default_branch }]).map((b) => ({ value: b.name, label: b.name }))} />
            </Field>
          </div>
          {creating === 'release'
            ? (
              <Field label='Title'>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tagName || 'Release title'} />
              </Field>
            )
            : null}
          <Field label={creating === 'tag' ? 'Message (annotated tag)' : 'Release notes'}>
            <Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={creating === 'tag' ? 'Optional' : 'What changed? Markdown supported.'} />
          </Field>
          {creating === 'release'
            ? (
              <div className='flex flex-wrap gap-4'>
                <Checkbox label='Pre-release' checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} />
                <Checkbox label='Draft' checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              </div>
            )
            : null}
        </div>
      </Modal>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'tag' ? `Delete tag ${confirm.tag}?` : `Delete release ${confirm?.kind === 'release' ? confirm.label : ''}?`}
        description={confirm?.kind === 'tag' ? 'Also deletes any release attached to the tag.' : 'The tag stays; only the release entry and its attachments are removed.'}
        width='sm'
        footer={
          <div className='flex justify-end gap-2'>
            <Button size='sm' variant='secondary' onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              size='sm'
              variant='danger'
              disabled={delRel.isPending || delTag.isPending}
              onClick={() =>
                confirm?.kind === 'tag'
                  ? act(`Deleted tag ${confirm.tag}`, () => delTag.mutateAsync({ repo: r.name, tag: confirm.tag }), () => setConfirm(null))
                  : act(`Deleted release`, () => delRel.mutateAsync({ repo: r.name, id: (confirm as { id: number }).id }), () => setConfirm(null))}
            >
              Delete
            </Button>
          </div>
        }
      >
        <span />
      </Modal>
    </div>
  );
}

/* ─────────── collaborators ─────────── */

const PERMS: Array<[gitea.CollaboratorPermission, string]> = [['read', 'Read'], ['write', 'Write'], ['admin', 'Admin']];

function PeopleTab({ repo: r }: { repo: gitea.Repo }) {
  const people = useCollaborators(r.name);
  const add = useAddCollaborator();
  const remove = useRemoveCollaborator();
  const act = useAct();
  const [q, setQ] = useState('');
  const [perm, setPerm] = useState<gitea.CollaboratorPermission>('write');
  const search = useUserSearch(q);
  const existing = new Set((people.data ?? []).map((c) => c.login));
  const candidates = (search.data ?? []).filter((u) => !existing.has(u.login));

  return (
    <div className='space-y-4'>
      <Section title='Add collaborator'>
        <div className='flex flex-wrap items-end gap-2'>
          <Field label='User' className='min-w-56 flex-1' hint={q.trim().length < 2 ? 'type 2+ characters' : search.isLoading ? 'searching…' : undefined}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder='username' />
          </Field>
          <Field label='Permission'>
            <Select value={perm} onChange={(e) => setPerm(e.target.value as gitea.CollaboratorPermission)} options={PERMS.map(([v, l]) => ({ value: v, label: l }))} />
          </Field>
          <Button size='sm' disabled={!q.trim() || add.isPending} onClick={() => act(`Added ${q.trim()}`, () => add.mutateAsync({ repo: r.name, user: q.trim(), permission: perm }), () => setQ(''))}>
            <IconPlus /> Add
          </Button>
        </div>
        {candidates.length
          ? (
            <div className='mt-2 flex flex-wrap gap-1.5'>
              {candidates.map((u) => (
                <button key={u.id} type='button' onClick={() => setQ(u.login)} className='flex items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised px-2 py-0.5 text-[11px] text-content hover:border-brand-400'>
                  {u.avatar_url ? <img src={u.avatar_url} alt='' className='h-4 w-4 rounded-full' /> : null}
                  {u.login}{u.full_name ? <span className='text-content-subtle'>· {u.full_name}</span> : null}
                </button>
              ))}
            </div>
          )
          : null}
      </Section>

      <Section title='Collaborators' count={people.data?.length} loading={people.isLoading}>
        {people.data?.length
          ? (
            <ul className='divide-y divide-edge-subtle'>
              {people.data.map((c) => (
                <li key={c.id} className='flex items-center gap-2 py-2 text-sm'>
                  {c.avatar_url ? <img src={c.avatar_url} alt='' className='h-6 w-6 rounded-full ring-1 ring-edge-subtle' /> : <IconUsers />}
                  <span className='font-medium text-content'>{c.login}</span>
                  {c.full_name ? <span className='text-[11px] text-content-subtle'>{c.full_name}</span> : null}
                  {c.is_admin ? <StatusBadge kind='info'>site admin</StatusBadge> : null}
                  <div className='ml-auto flex items-center gap-1'>
                    <select
                      aria-label={`Permission for ${c.login}`}
                      defaultValue='write'
                      onChange={(e) => act(`${c.login} → ${e.target.value}`, () => add.mutateAsync({ repo: r.name, user: c.login, permission: e.target.value as gitea.CollaboratorPermission }))}
                      className='h-7 rounded-md border border-edge-default bg-surface-raised px-1.5 text-[11px] text-content focus:outline-none'
                    >
                      {PERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <Button size='xs' variant='ghost' className='text-rose-700 dark:text-rose-300' disabled={remove.isPending} onClick={() => act(`Removed ${c.login}`, () => remove.mutateAsync({ repo: r.name, user: c.login }))}>Remove</Button>
                  </div>
                </li>
              ))}
            </ul>
          )
          : <EmptyState compact title='No direct collaborators' description='Org members inherit access through teams; add people here for per-repo access.' />}
      </Section>
    </div>
  );
}

/* ─────────── webhooks ─────────── */

const HOOK_EVENTS = ['push', 'create', 'delete', 'pull_request', 'pull_request_review', 'issues', 'issue_comment', 'release', 'repository', 'wiki'];

function HooksTab({ repo: r }: { repo: gitea.Repo }) {
  const hooks = useWebhooks(r.name);
  const create = useCreateWebhook();
  const update = useUpdateWebhook();
  const del = useDeleteWebhook();
  const test = useTestWebhook();
  const act = useAct();
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [type, setType] = useState<gitea.CreateWebhookBody['type']>('gitea');
  const [events, setEvents] = useState<string[]>(['push']);
  const [branchFilter, setBranchFilter] = useState('');
  const [confirm, setConfirm] = useState<gitea.Webhook | null>(null);
  const reset = () => {
    setCreating(false);
    setUrl('');
    setSecret('');
    setEvents(['push']);
    setBranchFilter('');
  };

  return (
    <div className='space-y-4'>
      <Section
        title='Webhooks'
        count={hooks.data?.length}
        loading={hooks.isLoading}
        actions={<Button size='xs' onClick={() => setCreating(true)}><IconPlus size={12} /> Add webhook</Button>}
      >
        {hooks.data?.length
          ? (
            <ul className='divide-y divide-edge-subtle'>
              {hooks.data.map((h) => (
                <li key={h.id} className='flex flex-wrap items-center gap-2 py-2 text-sm'>
                  <IconWebhook />
                  <code className='min-w-0 flex-1 truncate rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content' title={h.config.url}>{h.config.url ?? '—'}</code>
                  <StatusBadge kind={h.active ? 'healthy' : 'unknown'}>{h.active ? 'active' : 'paused'}</StatusBadge>
                  <span className='text-[10.5px] text-content-subtle'>{h.type} · {h.events.length ? h.events.join(', ') : 'all events'}</span>
                  <div className='flex items-center gap-1'>
                    <Button size='xs' variant='ghost' disabled={test.isPending} onClick={() => act('Test delivery sent', () => test.mutateAsync({ repo: r.name, id: h.id }))}>Test</Button>
                    <Button size='xs' variant='ghost' disabled={update.isPending} onClick={() => act(h.active ? 'Webhook paused' : 'Webhook resumed', () => update.mutateAsync({ repo: r.name, id: h.id, body: { active: !h.active } }))}>{h.active ? 'Pause' : 'Resume'}</Button>
                    <Button size='xs' variant='ghost' className='text-rose-700 dark:text-rose-300' onClick={() => setConfirm(h)}><IconTrash /></Button>
                  </div>
                </li>
              ))}
            </ul>
          )
          : <EmptyState compact title='No webhooks' description='Trigger CI (Tekton, Argo Workflows) or chat notifications on repository events.' />}
      </Section>

      <Modal
        open={creating}
        onClose={reset}
        title='Add webhook'
        description='Gitea POSTs a JSON payload to the URL on the selected events.'
        branded
        footer={
          <div className='flex justify-end gap-2'>
            <Button size='sm' variant='secondary' onClick={reset}>Cancel</Button>
            <Button
              size='sm'
              disabled={!/^https?:\/\//.test(url) || create.isPending}
              onClick={() =>
                act('Webhook added', () =>
                  create.mutateAsync({
                    repo: r.name,
                    body: { type, config: { url, content_type: 'json', ...(secret ? { secret } : {}) }, events, active: true, ...(branchFilter ? { branch_filter: branchFilter } : {}) },
                  }), reset)}
            >
              Add webhook
            </Button>
          </div>
        }
      >
        <div className='space-y-3'>
          <Field label='Payload URL' required>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder='https://el-listener.tekton.svc/…' autoFocus />
          </Field>
          <div className='grid grid-cols-2 gap-3'>
            <Field label='Type'>
              <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} options={['gitea', 'slack', 'discord', 'msteams', 'telegram', 'matrix'].map((t) => ({ value: t, label: t }))} />
            </Field>
            <Field label='Secret' hint='optional'>
              <Input type='password' value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete='off' />
            </Field>
          </div>
          <Field label='Branch filter' hint='glob, e.g. main or release/*'>
            <Input value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} placeholder='*' />
          </Field>
          <Field label='Events'>
            <div className='grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3'>
              {HOOK_EVENTS.map((ev) => (
                <Checkbox key={ev} label={ev} checked={events.includes(ev)} onChange={(e) => setEvents((list) => (e.target.checked ? [...list, ev] : list.filter((x) => x !== ev)))} />
              ))}
            </div>
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title='Delete webhook?'
        description={confirm?.config.url}
        width='sm'
        footer={
          <div className='flex justify-end gap-2'>
            <Button size='sm' variant='secondary' onClick={() => setConfirm(null)}>Cancel</Button>
            <Button size='sm' variant='danger' disabled={del.isPending} onClick={() => act('Webhook deleted', () => del.mutateAsync({ repo: r.name, id: confirm!.id }), () => setConfirm(null))}>Delete</Button>
          </div>
        }
      >
        <span />
      </Modal>
    </div>
  );
}

/* ─────────── settings ─────────── */

function SettingsTab({ repo: r, onDeleted }: { repo: gitea.Repo; onDeleted(): void }) {
  const update = useUpdateRepo();
  const del = useDeleteRepo();
  const act = useAct();
  const [name, setName] = useState(r.name);
  const [description, setDescription] = useState(r.description ?? '');
  const [website, setWebsite] = useState(r.website ?? '');
  const [priv, setPriv] = useState(r.private);
  const [template, setTemplate] = useState(!!r.template);
  const [features, setFeatures] = useState({
    has_issues: r.has_issues ?? true,
    has_pull_requests: r.has_pull_requests ?? true,
    has_wiki: r.has_wiki ?? false,
    has_projects: r.has_projects ?? false,
    has_actions: r.has_actions ?? false,
    has_packages: r.has_packages ?? true,
    has_releases: r.has_releases ?? true,
  });
  const [merge, setMerge] = useState({
    allow_merge_commits: r.allow_merge_commits ?? true,
    allow_rebase: r.allow_rebase ?? true,
    allow_rebase_explicit: r.allow_rebase_explicit ?? true,
    allow_squash_merge: r.allow_squash_merge ?? true,
    allow_fast_forward_only_merge: r.allow_fast_forward_only_merge ?? false,
    default_merge_style: r.default_merge_style ?? 'merge',
    default_delete_branch_after_merge: r.default_delete_branch_after_merge ?? false,
  });
  const [confirmDelete, setConfirmDelete] = useState('');

  useEffect(() => {
    setName(r.name);
    setDescription(r.description ?? '');
    setWebsite(r.website ?? '');
    setPriv(r.private);
    setTemplate(!!r.template);
  }, [r]);

  const dirtyGeneral = name !== r.name || description !== (r.description ?? '') || website !== (r.website ?? '') || priv !== r.private || template !== !!r.template;

  const saveGeneral = () =>
    act('Settings saved', () =>
      update.mutateAsync({
        repo: r.name,
        body: { ...(name !== r.name ? { name } : {}), description, website, private: priv, template },
      }));
  const saveFeatures = () => act('Features saved', () => update.mutateAsync({ repo: r.name, body: features }));
  const saveMerge = () => act('Merge settings saved', () => update.mutateAsync({ repo: r.name, body: merge }));

  const FEATURES: Array<[keyof typeof features, string, string]> = [
    ['has_issues', 'Issues', 'Built-in issue tracker.'],
    ['has_pull_requests', 'Pull requests', 'Code review + merge queue.'],
    ['has_releases', 'Releases', 'Tagged releases with attachments.'],
    ['has_packages', 'Packages', 'Container / npm / Maven registry.'],
    ['has_wiki', 'Wiki', 'Repository wiki pages.'],
    ['has_projects', 'Projects', 'Kanban boards.'],
    ['has_actions', 'Actions', 'Gitea Actions CI runners.'],
  ];

  return (
    <div className='space-y-4'>
      <Section title='General' actions={<Button size='xs' disabled={!dirtyGeneral || update.isPending} onClick={saveGeneral}>Save</Button>}>
        <div className='space-y-3'>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
            <Field label='Name'>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label='Website'>
              <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder='https://' />
            </Field>
          </div>
          <Field label='Description'>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className='flex flex-wrap gap-4'>
            <Checkbox label='Private' description='Only members and collaborators can see it.' checked={priv} onChange={(e) => setPriv(e.target.checked)} />
            <Checkbox label='Template' description='Generate new repositories from it.' checked={template} onChange={(e) => setTemplate(e.target.checked)} />
          </div>
        </div>
      </Section>

      <Section title='Features' actions={<Button size='xs' disabled={update.isPending} onClick={saveFeatures}>Save</Button>}>
        <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
          {FEATURES.map(([k, label, desc]) => (
            <Checkbox key={k} label={label} description={desc} checked={features[k]} onChange={(e) => setFeatures((f) => ({ ...f, [k]: e.target.checked }))} />
          ))}
        </div>
      </Section>

      <Section title='Pull request merges' actions={<Button size='xs' disabled={update.isPending} onClick={saveMerge}>Save</Button>}>
        <div className='space-y-3'>
          <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
            <Checkbox label='Merge commits' checked={merge.allow_merge_commits} onChange={(e) => setMerge((m) => ({ ...m, allow_merge_commits: e.target.checked }))} />
            <Checkbox label='Rebase then fast-forward' checked={merge.allow_rebase} onChange={(e) => setMerge((m) => ({ ...m, allow_rebase: e.target.checked }))} />
            <Checkbox label='Rebase then merge commit' checked={merge.allow_rebase_explicit} onChange={(e) => setMerge((m) => ({ ...m, allow_rebase_explicit: e.target.checked }))} />
            <Checkbox label='Squash merge' checked={merge.allow_squash_merge} onChange={(e) => setMerge((m) => ({ ...m, allow_squash_merge: e.target.checked }))} />
            <Checkbox label='Fast-forward only' checked={merge.allow_fast_forward_only_merge} onChange={(e) => setMerge((m) => ({ ...m, allow_fast_forward_only_merge: e.target.checked }))} />
            <Checkbox label='Delete branch after merge by default' checked={merge.default_delete_branch_after_merge} onChange={(e) => setMerge((m) => ({ ...m, default_delete_branch_after_merge: e.target.checked }))} />
          </div>
          <Field label='Default merge style' className='max-w-xs'>
            <Select value={merge.default_merge_style} onChange={(e) => setMerge((m) => ({ ...m, default_merge_style: e.target.value }))} options={[['merge', 'Merge commit'], ['rebase', 'Rebase'], ['rebase-merge', 'Rebase + merge commit'], ['squash', 'Squash'], ['fast-forward-only', 'Fast-forward only']].map(([v, l]) => ({ value: v, label: l }))} />
          </Field>
        </div>
      </Section>

      <Card className='border-rose-200/70 dark:border-rose-500/30'>
        <CardHeader>
          <div className='text-sm font-semibold text-rose-700 dark:text-rose-300'>Danger zone</div>
        </CardHeader>
        <CardBody className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div>
              <div className='text-sm font-medium text-content'>{r.archived ? 'Unarchive repository' : 'Archive repository'}</div>
              <div className='text-xs text-content-muted'>{r.archived ? 'Makes it writable again.' : 'Read-only for everyone; issues and PRs are frozen.'}</div>
            </div>
            <Button size='sm' variant='secondary' disabled={update.isPending} onClick={() => act(r.archived ? 'Unarchived' : 'Archived', () => update.mutateAsync({ repo: r.name, body: { archived: !r.archived } }))}>
              {r.archived ? 'Unarchive' : 'Archive'}
            </Button>
          </div>
          <div className='border-t border-edge-subtle pt-3'>
            <div className='text-sm font-medium text-content'>Delete repository</div>
            <div className='text-xs text-content-muted'>Type <code className='font-mono'>{r.name}</code> to confirm. This cannot be undone.</div>
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              <Input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={r.name} className='max-w-xs' />
              <Button size='sm' variant='danger' disabled={confirmDelete !== r.name || del.isPending} onClick={() => act(`Deleted ${r.name}`, () => del.mutateAsync(r.name), onDeleted)}>
                {del.isPending ? <Spinner size={12} /> : <IconTrash />} Delete
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/* ─────────── tiny markdown ─────────── */

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inline(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code class="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[11px]">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" class="inline-block max-h-6 align-middle" />')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-brand-700 hover:underline dark:text-brand-300">$1</a>');
}

/** Minimal, safe markdown → HTML for README previews (headings, lists, code, links). */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const out: string[] = [];
    const lines = text.split(/\r?\n/);
    let i = 0;
    let para: string[] = [];
    const flush = () => {
      if (para.length) out.push(`<p class="my-2 text-[12.5px] leading-relaxed text-content-muted">${inline(para.join(' '))}</p>`);
      para = [];
    };
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) {
        flush();
        const buf: string[] = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre class="my-2 overflow-x-auto rounded-lg bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-content">${esc(buf.join('\n'))}</pre>`);
        continue;
      }
      const h = l.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flush();
        const lvl = h[1].length;
        const cls = lvl === 1 ? 'mt-1 text-base font-semibold' : lvl === 2 ? 'mt-4 text-sm font-semibold' : 'mt-3 text-[13px] font-semibold';
        out.push(`<h${lvl} class="${cls} text-content">${inline(h[2].replace(/\s#+$/, ''))}</h${lvl}>`);
        i++;
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
        flush();
        const items: string[] = [];
        const ordered = /^\s*\d+\./.test(l);
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        out.push(`<${ordered ? 'ol' : 'ul'} class="my-2 ml-5 ${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 text-[12.5px] text-content-muted">${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^\s*>\s?/.test(l)) {
        flush();
        const buf: string[] = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote class="my-2 border-l-2 border-edge-default pl-3 text-[12.5px] italic text-content-muted">${inline(buf.join(' '))}</blockquote>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
        flush();
        out.push('<hr class="my-3 border-edge-subtle" />');
        i++;
        continue;
      }
      if (!l.trim()) {
        flush();
        i++;
        continue;
      }
      para.push(l.trim());
      i++;
    }
    flush();
    return out.join('');
  }, [text]);
  return <div className='max-w-none' dangerouslySetInnerHTML={{ __html: html }} />;
}
