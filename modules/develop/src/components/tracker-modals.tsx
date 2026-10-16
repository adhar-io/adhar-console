import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, Modal, Select, Textarea } from '@adhar/shell-ui';
import { cn } from '@adhar/utils';
import {
  type RepoIssue,
  type RepoPull,
  useAheadBehind,
  useBranches,
  useCollaborators,
  useCreateIssue,
  useCreatePull,
  pullRequestsBlocked,
  useOrgPullRequests,
  useRepoLabels,
  useRepos,
} from '../data/git.ts';
import { Avatar } from './list-kit.tsx';
import { useAct } from './tracker-bits.tsx';

/**
 * Create flows for the trackers. Both start from the repo the page is scoped
 * to (or the first one), and both hand the created item back so the page can
 * open it straight away.
 */

function RepoSelect({ value, onChange, prs = false }: { value: string; onChange(v: string): void; prs?: boolean }) {
  const repos = useRepos();
  const opts = (repos.data ?? [])
    .filter((r) => r.name === value || (!r.archived && (!prs || !pullRequestsBlocked(r))))
    .map((r) => ({ value: r.name, label: r.full_name }));
  return <Select value={value} onChange={(e) => onChange(e.target.value)} options={opts} aria-label='Repository' />;
}

function PickChips<T extends string | number>({ items, picked, onToggle, render }: {
  items: Array<{ key: T; label: string; color?: string; avatar?: string }>;
  picked: Set<T>;
  onToggle(k: T): void;
  render?: 'avatar' | 'color';
}) {
  if (!items.length) return <p className='text-[12px] text-content-subtle'>None available in this repository.</p>;
  return (
    <div className='flex flex-wrap gap-1'>
      {items.map((it) => {
        const on = picked.has(it.key);
        return (
          <button
            key={String(it.key)}
            type='button'
            aria-pressed={on}
            onClick={() => onToggle(it.key)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-[12px] transition-colors',
              on ? 'border-content bg-content text-surface-raised' : 'border-edge-default bg-surface-app text-content-muted hover:border-edge-strong hover:text-content',
            )}
          >
            {render === 'color' && it.color ? <i className='h-2 w-2 rounded-full' style={{ background: `#${it.color.replace(/^#/, '')}` }} /> : null}
            {render === 'avatar' ? <Avatar login={it.label} url={it.avatar} size={16} /> : null}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function useToggleSet<T>() {
  const [set, setSet] = useState<Set<T>>(new Set());
  const toggle = (k: T) =>
    setSet((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  return [set, toggle, () => setSet(new Set())] as const;
}

/* ─────────── new pull request ─────────── */

export function NewPullModal({ open, onClose, defaults, onCreated }: {
  open: boolean;
  onClose(): void;
  defaults?: { repo?: string; head?: string; base?: string };
  onCreated(pr: RepoPull): void;
}) {
  const repos = useRepos();
  const [repo, setRepo] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [body, setBody] = useState('');
  const [labels, toggleLabel, clearLabels] = useToggleSet<number>();
  const [assignees, toggleAssignee, clearAssignees] = useToggleSet<string>();
  const create = useCreatePull();
  const act = useAct();

  const repoObj = repos.data?.find((r) => r.name === repo);
  const branches = useBranches(repo || undefined);
  const repoLabels = useRepoLabels(repo || undefined);
  const people = useCollaborators(repo || undefined);
  const openPrs = useOrgPullRequests('open', repo || undefined);
  const ab = useAheadBehind(repo || undefined, base || undefined, head || undefined, open);

  // (Re)seed whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setRepo(defaults?.repo ?? repos.data?.find((r) => !pullRequestsBlocked(r))?.name ?? '');
    setBase(defaults?.base ?? '');
    setHead(defaults?.head ?? '');
    setTitle('');
    setTitleTouched(false);
    setBody('');
    clearLabels();
    clearAssignees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Base = the repo default; head = the most recently pushed other branch.
  useEffect(() => {
    if (!branches.data || !repoObj) return;
    const names = new Set(branches.data.map((b) => b.name));
    const b = base && names.has(base) ? base : repoObj.default_branch;
    if (b !== base) setBase(b);
    if (!head || !names.has(head) || head === b) {
      const next = branches.data
        .filter((x) => x.name !== b)
        .sort((x, y) => y.commit.timestamp.localeCompare(x.commit.timestamp))[0]?.name ?? '';
      setHead(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches.data, repoObj?.default_branch]);

  // Title follows the head branch's last commit until the user types one.
  const headBranch = branches.data?.find((b) => b.name === head);
  useEffect(() => {
    if (!titleTouched) setTitle(headBranch?.commit.message.split('\n')[0] ?? '');
  }, [headBranch?.commit.id, titleTouched]);

  const existing = openPrs.data?.find((p) => p.head?.ref === head && p.base?.ref === base);
  const branchOpts = (branches.data ?? []).map((b) => ({ value: b.name, label: b.name }));
  const same = !!head && head === base;
  const nothing = ab.data != null && ab.data.ahead === 0;
  const blocked = pullRequestsBlocked(repoObj);
  const canCreate = !blocked && !!repo && !!head && !!base && !same && !!title.trim() && !existing && !create.isPending;

  const submit = async () => {
    if (!canCreate) return;
    let made: RepoPull | undefined;
    const ok = await act(`Opened pull request in ${repo}`, async () => {
      const pr = await create.mutateAsync({
        repo,
        body: { head, base, title: title.trim(), body: body.trim() || undefined, labels: [...labels], assignees: [...assignees] },
      });
      made = { ...pr, repo };
    });
    if (ok && made) onCreated(made);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title='New pull request'
      description='Propose merging one branch into another. Reviewers can approve, request changes and merge from here.'
      width='lg'
      footer={
        <div className='flex justify-end gap-2'>
          <Button size='sm' variant='secondary' onClick={onClose}>Cancel</Button>
          <Button variant='primary' size='sm' disabled={!canCreate} loading={create.isPending} onClick={submit}>Create pull request</Button>
        </div>
      }
    >
      <div className='space-y-4'>
        <Field label='Repository'>
          <RepoSelect prs value={repo} onChange={(v) => { setRepo(v); setBase(''); setHead(''); clearLabels(); clearAssignees(); }} />
        </Field>
        <div className='grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_auto_1fr]'>
          <Field label='Base (merge into)'>
            <Select value={base} onChange={(e) => setBase(e.target.value)} options={branchOpts} disabled={!branchOpts.length} />
          </Field>
          <span className='hidden pb-2 text-content-subtle sm:block'>←</span>
          <Field label='Compare (from)'>
            <Select value={head} onChange={(e) => setHead(e.target.value)} options={branchOpts} disabled={!branchOpts.length} />
          </Field>
        </div>
        <div className='-mt-2 min-h-5 text-[12px]'>
          {blocked
            ? <span className='text-amber-700 dark:text-amber-300'>{repoObj?.full_name}: {blocked}</span>
            : branches.data && branches.data.length < 2
            ? <span className='text-amber-700 dark:text-amber-300'>This repository has a single branch — push or create another branch first.</span>
            : same
            ? <span className='text-amber-700 dark:text-amber-300'>Pick two different branches.</span>
            : existing
            ? <span className='text-amber-700 dark:text-amber-300'>#{existing.number} already proposes {head} → {base}.</span>
            : nothing
            ? <span className='text-amber-700 dark:text-amber-300'>{head} has no commits that {base} lacks — there is nothing to merge yet.</span>
            : ab.data
            ? (
              <span className='text-content-muted'>
                <b className='text-emerald-700 dark:text-emerald-300'>{ab.data.ahead}</b> commit{ab.data.ahead === 1 ? '' : 's'} ahead
                {ab.data.behind ? <>, <b className='text-amber-700 dark:text-amber-300'>{ab.data.behind}</b> behind</> : null} of {base}
              </span>
            )
            : null}
        </div>
        <Field label='Title' required>
          <Input value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} placeholder='feat: what this change does' />
        </Field>
        <Field label='Description' hint='Markdown supported.'>
          <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder='Why, what changed, how to test…' />
        </Field>
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <Field label='Labels'>
            <PickChips render='color' items={(repoLabels.data ?? []).map((l) => ({ key: l.id, label: l.name, color: l.color }))} picked={labels} onToggle={toggleLabel} />
          </Field>
          <Field label='Assignees'>
            <PickChips render='avatar' items={(people.data ?? []).map((p) => ({ key: p.login, label: p.login, avatar: p.avatar_url }))} picked={assignees} onToggle={toggleAssignee} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ─────────── new issue ─────────── */

export function NewIssueModal({ open, onClose, defaultRepo, onCreated }: {
  open: boolean;
  onClose(): void;
  defaultRepo?: string;
  onCreated(issue: RepoIssue): void;
}) {
  const repos = useRepos();
  const [repo, setRepo] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, toggleLabel, clearLabels] = useToggleSet<number>();
  const [assignees, toggleAssignee, clearAssignees] = useToggleSet<string>();
  const repoLabels = useRepoLabels(repo || undefined);
  const people = useCollaborators(repo || undefined);
  const create = useCreateIssue();
  const act = useAct();

  const issueRepos = useMemo(() => (repos.data ?? []).filter((r) => !r.archived && r.has_issues !== false), [repos.data]);

  useEffect(() => {
    if (!open) return;
    setRepo(defaultRepo && issueRepos.some((r) => r.name === defaultRepo) ? defaultRepo : issueRepos[0]?.name ?? '');
    setTitle('');
    setBody('');
    clearLabels();
    clearAssignees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canCreate = !!repo && !!title.trim() && !create.isPending;
  const submit = async () => {
    if (!canCreate) return;
    let made: RepoIssue | undefined;
    const ok = await act(`Opened issue in ${repo}`, async () => {
      const i = await create.mutateAsync({
        repo,
        body: { title: title.trim(), body: body.trim() || undefined, labels: [...labels], assignees: [...assignees] },
      });
      made = { ...i, repo };
    });
    if (ok && made) onCreated(made);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title='New issue'
      description='Report a bug, propose an enhancement or ask a question.'
      width='lg'
      footer={
        <div className='flex justify-end gap-2'>
          <Button size='sm' variant='secondary' onClick={onClose}>Cancel</Button>
          <Button variant='primary' size='sm' disabled={!canCreate} loading={create.isPending} onClick={submit}>Create issue</Button>
        </div>
      }
    >
      <form className='space-y-4' onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label='Repository'>
          <Select value={repo} onChange={(e) => { setRepo(e.target.value); clearLabels(); clearAssignees(); }} options={issueRepos.map((r) => ({ value: r.name, label: r.full_name }))} />
        </Field>
        <Field label='Title' required>
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Short summary of the problem or idea' />
        </Field>
        <Field label='Description' hint='Markdown supported.'>
          <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder='Steps to reproduce, expected vs actual, context…' />
        </Field>
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <Field label='Labels'>
            <PickChips render='color' items={(repoLabels.data ?? []).map((l) => ({ key: l.id, label: l.name, color: l.color }))} picked={labels} onToggle={toggleLabel} />
          </Field>
          <Field label='Assignees'>
            <PickChips render='avatar' items={(people.data ?? []).map((p) => ({ key: p.login, label: p.login, avatar: p.avatar_url }))} picked={assignees} onToggle={toggleAssignee} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
