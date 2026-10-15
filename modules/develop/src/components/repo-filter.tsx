import { useCallback, useEffect, useState } from 'react';
import { cn } from '@adhar/utils';
import { useRepos } from '../data/git.ts';
import { Popover, ToolbarBtn } from './list-kit.tsx';

/** "All repositories" / one-repo scope picker for the org-wide tracker lists. */
export function RepoFilter({ value, onChange }: { value?: string; onChange(repo: string | undefined): void }) {
  const repos = useRepos();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const close = useCallback(() => setOpen(false), []);
  const list = (repos.data ?? []).filter((r) => !r.archived && r.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className='relative'>
      <ToolbarBtn on={open || !!value} onClick={() => setOpen((o) => !o)} title='Repository'>
        <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' aria-hidden><path d='M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z' /><path d='M4 16a4 4 0 0 1 4-4h12' /></svg>
        <span className='max-w-[9rem] truncate'>{value ?? 'All repositories'}</span>
      </ToolbarBtn>
      <Popover open={open} onClose={close} width='w-72'>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Filter repositories…'
          className='mb-1 block h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none'
        />
        <ul className='max-h-72 overflow-y-auto'>
          <li>
            <button type='button' onClick={() => { onChange(undefined); close(); }} className={cn('w-full rounded-md px-2 py-1.5 text-left text-[12px]', !value ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted hover:bg-surface-sunken')}>
              All repositories
            </button>
          </li>
          {list.map((r) => (
            <li key={r.id}>
              <button type='button' onClick={() => { onChange(r.name); close(); }} className={cn('w-full truncate rounded-md px-2 py-1.5 text-left text-[12px]', value === r.name ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}>
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}

export function tally(xs: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** `/` focuses the page search unless the user is typing somewhere. */
export function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return;
      e.preventDefault();
      ref.current?.focus();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [ref]);
}

