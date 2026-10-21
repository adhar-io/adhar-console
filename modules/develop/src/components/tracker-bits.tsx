import { useCallback, useState, type ReactNode } from 'react';
import { Button, Markdown, Spinner, Textarea, useToast } from '@adhar/shell-ui';
import { cn, formatRelative } from '@adhar/utils';
import type { gitea } from '@adhar/api-clients';
import { useCollaborators, useComments, useCreateComment, useDeleteComment, useRepoLabels } from '../data/git.ts';
import { Avatar, LabelPill, Popover } from './list-kit.tsx';

/**
 * Pieces shared by the pull request and issue drawers: the comment timeline
 * with its composer, and the sidebar editors for labels and assignees.
 */

/** Run a mutation and report it as a toast — never as inline text. */
export function useAct() {
  const toast = useToast();
  return useCallback(async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      toast.success(label);
      return true;
    } catch (e) {
      toast.error(`${label} failed`, { description: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, [toast]);
}

/* ─────────── timeline ─────────── */

export interface TimelineExtra {
  key: string;
  at: string;
  node: ReactNode;
}

/**
 * The opening post, every comment, and any `extras` (reviews, merge events)
 * merged into one chronological thread, with a composer underneath.
 */
export function Conversation({ repo, index, author, opened, body, extras = [], composerActions }: {
  repo: string;
  index: number;
  author: { login: string; avatar_url?: string };
  opened: string;
  body?: string;
  extras?: TimelineExtra[];
  /** Extra buttons beside "Comment" (e.g. Close with comment). */
  composerActions?(text: string, clear: () => void): ReactNode;
}) {
  const comments = useComments(repo, index);
  const create = useCreateComment();
  const del = useDeleteComment();
  const act = useAct();
  const [text, setText] = useState('');

  const items: TimelineExtra[] = [
    ...(comments.data ?? []).map((c) => ({
      key: `c${c.id}`,
      at: c.created_at,
      node: (
        <CommentCard
          comment={c}
          onDelete={() => act('Comment deleted', () => del.mutateAsync({ repo, id: c.id }))}
        />
      ),
    })),
    ...extras,
  ].sort((a, b) => a.at.localeCompare(b.at));

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (await act('Comment posted', () => create.mutateAsync({ repo, index, body: t }))) setText('');
  };

  return (
    <div className='space-y-3'>
      <PostCard login={author.login} avatar={author.avatar_url} at={opened} verb='opened this' body={body} empty='No description provided.' />
      {comments.isLoading
        ? (
          <div role='status' aria-busy='true' aria-label='Loading comments' className='flex gap-3'>
            <span className='skeleton-shimmer block h-8 w-8 shrink-0 rounded-full' />
            <div className='min-w-0 flex-1 space-y-2 rounded-lg border border-edge-default bg-surface-raised p-3'>
              <span className='skeleton-shimmer block h-3 w-1/4 rounded' />
              <span className='skeleton-shimmer block h-2.5 w-11/12 rounded' />
              <span className='skeleton-shimmer block h-2.5 w-2/3 rounded' />
            </div>
          </div>
        )
        : null}
      {items.map((it) => <div key={it.key}>{it.node}</div>)}

      <div className='rounded-lg border border-edge-default bg-surface-raised p-3'>
        <Textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder='Leave a comment — Markdown supported. ⌘↵ to post.'
          aria-label='Comment'
        />
        <div className='mt-2 flex flex-wrap items-center justify-end gap-2'>
          {composerActions?.(text, () => setText(''))}
          <Button variant='primary' size='sm' disabled={!text.trim() || create.isPending} loading={create.isPending} onClick={submit}>
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}

function PostCard({ login, avatar, at, verb, body, empty }: { login: string; avatar?: string; at: string; verb: string; body?: string; empty?: string }) {
  return (
    <div className='flex gap-3'>
      <Avatar login={login} url={avatar} size={28} />
      <div className='min-w-0 flex-1 overflow-hidden rounded-lg border border-edge-default bg-surface-raised'>
        <div className='flex items-center gap-1.5 border-b border-edge-subtle bg-surface-sunken/50 px-3 py-1.5 text-[12px] text-content-muted'>
          <span className='font-semibold text-content'>{login}</span> {verb}
          <span title={at}>{formatRelative(at)}</span>
        </div>
        <div className='px-3 py-2.5'>
          {body?.trim() ? <Markdown text={body} className='text-[13px] leading-relaxed text-content' /> : <p className='text-[13px] italic text-content-subtle'>{empty}</p>}
        </div>
      </div>
    </div>
  );
}

function CommentCard({ comment: c, onDelete }: { comment: gitea.Comment; onDelete(): void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className='group flex gap-3'>
      <Avatar login={c.user.login} url={c.user.avatar_url} size={28} />
      <div className='min-w-0 flex-1 overflow-hidden rounded-lg border border-edge-default bg-surface-raised'>
        <div className='flex items-center gap-1.5 border-b border-edge-subtle bg-surface-sunken/50 px-3 py-1.5 text-[12px] text-content-muted'>
          <span className='font-semibold text-content'>{c.user.login}</span> commented
          <span title={c.created_at}>{formatRelative(c.created_at)}</span>
          {c.updated_at && c.updated_at !== c.created_at ? <span className='text-content-subtle'>· edited</span> : null}
          <span className='ml-auto'>
            {confirm
              ? (
                <span className='flex items-center gap-1'>
                  <button type='button' onClick={onDelete} className='rounded px-1.5 text-[11px] font-medium text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10'>Delete</button>
                  <button type='button' onClick={() => setConfirm(false)} className='rounded px-1.5 text-[11px] text-content-muted hover:bg-surface-sunken'>Keep</button>
                </span>
              )
              : (
                <button type='button' onClick={() => setConfirm(true)} className='rounded px-1.5 text-[11px] text-content-subtle opacity-0 transition-opacity hover:bg-surface-sunken hover:text-content group-hover:opacity-100 focus:opacity-100'>
                  Delete
                </button>
              )}
          </span>
        </div>
        <div className='px-3 py-2.5'>
          <Markdown text={c.body} className='text-[13px] leading-relaxed text-content' />
        </div>
      </div>
    </div>
  );
}

/** A one-line event in the thread (merged, review approved, …). */
export function TimelineEvent({ icon, children, tone = 'slate' }: { icon: ReactNode; children: ReactNode; tone?: 'slate' | 'emerald' | 'rose' | 'violet' | 'amber' }) {
  const cls = {
    slate: 'bg-surface-sunken text-content-muted',
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    rose: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
    violet: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  }[tone];
  return (
    <div className='flex items-start gap-3 pl-1'>
      <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', cls)}>{icon}</span>
      <div className='min-w-0 flex-1 pt-0.5 text-[12px] text-content-muted'>{children}</div>
    </div>
  );
}

/* ─────────── sidebar editors ─────────── */

export function SideSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className='border-b border-edge-subtle pb-3 last:border-0'>
      <div className='mb-1.5 flex items-center justify-between'>
        <h3 className='text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function GearBtn({ onClick, label }: { onClick(): void; label: string }) {
  return (
    <button type='button' onClick={onClick} aria-label={label} title={label} className='rounded p-0.5 text-content-subtle hover:bg-surface-sunken hover:text-content'>
      <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' aria-hidden>
        <path d='M4 7h10M18 7h2M4 17h4M12 17h8' /><circle cx='16' cy='7' r='2' /><circle cx='10' cy='17' r='2' />
      </svg>
    </button>
  );
}

/** Labels on an issue or PR, editable from the repo's label set. */
export function LabelsEditor({ repo, current, onSave, saving }: {
  repo: string;
  current: Array<{ id?: number; name: string; color: string }>;
  onSave(ids: number[]): void;
  saving?: boolean;
}) {
  const labels = useRepoLabels(repo);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const close = useCallback(() => setOpen(false), []);
  const start = () => {
    const byName = new Map((labels.data ?? []).map((l) => [l.name, l.id]));
    setPicked(new Set(current.map((l) => l.id ?? byName.get(l.name)).filter((x): x is number => x != null)));
    setOpen(true);
  };
  return (
    <SideSection
      title='Labels'
      action={
        <div className='relative'>
          {saving ? <Spinner size={12} /> : <GearBtn onClick={() => (open ? close() : start())} label='Edit labels' />}
          <Popover open={open} onClose={close} align='right' width='w-64'>
            {labels.isLoading
              ? <div className='p-2 text-[12px] text-content-muted'>Loading…</div>
              : !labels.data?.length
              ? <div className='p-2 text-[12px] text-content-muted'>This repository has no labels yet.</div>
              : (
                <>
                  <ul className='max-h-64 overflow-y-auto'>
                    {labels.data.map((l) => {
                      const on = picked.has(l.id);
                      return (
                        <li key={l.id}>
                          <label className='flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-surface-sunken'>
                            <input
                              type='checkbox'
                              checked={on}
                              onChange={() =>
                                setPicked((cur) => {
                                  const next = new Set(cur);
                                  if (on) next.delete(l.id);
                                  else next.add(l.id);
                                  return next;
                                })}
                            />
                            <i className='h-2.5 w-2.5 rounded-full' style={{ background: `#${l.color.replace(/^#/, '')}` }} />
                            <span className='min-w-0 flex-1 truncate text-content'>{l.name}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <div className='mt-1 flex justify-end gap-1 border-t border-edge-subtle pt-2'>
                    <Button size='xs' variant='ghost' onClick={close}>Cancel</Button>
                    <Button variant='primary' size='xs' onClick={() => { onSave([...picked]); close(); }}>Apply</Button>
                  </div>
                </>
              )}
          </Popover>
        </div>
      }
    >
      {current.length
        ? <div className='flex flex-wrap gap-1'>{current.map((l) => <LabelPill key={l.name} name={l.name} color={l.color} />)}</div>
        : <p className='text-[12px] text-content-subtle'>None yet</p>}
    </SideSection>
  );
}

/** Assignees, picked from the repo's collaborators (plus whoever is already assigned). */
export function AssigneesEditor({ repo, current, onSave, saving }: {
  repo: string;
  current: Array<{ login: string; avatar_url?: string }>;
  onSave(logins: string[]): void;
  saving?: boolean;
}) {
  const people = useCollaborators(repo);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const close = useCallback(() => setOpen(false), []);
  const pool = [...new Map([...current, ...(people.data ?? [])].map((p) => [p.login, p])).values()];
  return (
    <SideSection
      title='Assignees'
      action={
        <div className='relative'>
          {saving ? <Spinner size={12} /> : (
            <GearBtn
              onClick={() => {
                if (open) return close();
                setPicked(new Set(current.map((p) => p.login)));
                setOpen(true);
              }}
              label='Edit assignees'
            />
          )}
          <Popover open={open} onClose={close} align='right' width='w-64'>
            {people.isLoading
              ? <div className='p-2 text-[12px] text-content-muted'>Loading…</div>
              : !pool.length
              ? <div className='p-2 text-[12px] text-content-muted'>No collaborators on this repository. Add people from the repo's People tab.</div>
              : (
                <>
                  <ul className='max-h-64 overflow-y-auto'>
                    {pool.map((p) => {
                      const on = picked.has(p.login);
                      return (
                        <li key={p.login}>
                          <label className='flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-surface-sunken'>
                            <input
                              type='checkbox'
                              checked={on}
                              onChange={() =>
                                setPicked((cur) => {
                                  const next = new Set(cur);
                                  if (on) next.delete(p.login);
                                  else next.add(p.login);
                                  return next;
                                })}
                            />
                            <Avatar login={p.login} url={p.avatar_url} size={18} />
                            <span className='min-w-0 flex-1 truncate text-content'>{p.login}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <div className='mt-1 flex justify-end gap-1 border-t border-edge-subtle pt-2'>
                    <Button size='xs' variant='ghost' onClick={close}>Cancel</Button>
                    <Button variant='primary' size='xs' onClick={() => { onSave([...picked]); close(); }}>Apply</Button>
                  </div>
                </>
              )}
          </Popover>
        </div>
      }
    >
      {current.length
        ? (
          <ul className='space-y-1'>
            {current.map((p) => (
              <li key={p.login} className='flex items-center gap-2 text-[12px] text-content'>
                <Avatar login={p.login} url={p.avatar_url} size={18} /> {p.login}
              </li>
            ))}
          </ul>
        )
        : <p className='text-[12px] text-content-subtle'>No one assigned</p>}
    </SideSection>
  );
}

/** Title that turns into an input on "Edit". */
export function EditableTitle({ title, prefix, onSave, saving }: { title: string; prefix?: ReactNode; onSave(t: string): Promise<unknown> | void; saving?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  if (editing) {
    return (
      <form
        className='flex flex-wrap items-center gap-2'
        onSubmit={async (e) => {
          e.preventDefault();
          const t = draft.trim();
          if (!t || t === title) return setEditing(false);
          await onSave(t);
          setEditing(false);
        }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
            }
          }}
          className='h-9 min-w-0 flex-1 rounded-md border border-edge-default bg-surface-app px-2 text-base font-semibold text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'
        />
        <Button variant='primary' size='sm' type='submit' loading={saving}>Save</Button>
        <Button size='sm' variant='ghost' type='button' onClick={() => setEditing(false)}>Cancel</Button>
      </form>
    );
  }
  return (
    <div className='group flex items-start gap-2'>
      <h2 className='min-w-0 flex-1 text-lg font-semibold leading-snug tracking-tight text-content'>
        {title} {prefix}
      </h2>
      <button
        type='button'
        onClick={() => { setDraft(title); setEditing(true); }}
        className='mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-content-subtle hover:bg-surface-sunken hover:text-content'
      >
        Edit
      </button>
    </div>
  );
}
