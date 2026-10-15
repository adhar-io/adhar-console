import { useState } from 'react';
import { EmptyState, Spinner, StatusBadge, type StatusKind } from '@adhar/shell-ui';
import { cn } from '@adhar/utils';
import type { DiffFile } from '../data/git.ts';
import { DiffBar, DiffStat } from './list-kit.tsx';

/**
 * Unified diff — a file list to jump from, then one collapsible card per file
 * with old/new line numbers and tinted add/delete rows. Shared by the pull
 * request and commit drawers.
 */
export function DiffView({ files, loading, error }: { files?: DiffFile[]; loading?: boolean; error?: unknown }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (loading) {
    return (
      <div className='flex items-center gap-2 py-6 text-sm text-content-muted'>
        <Spinner size={12} /> Loading diff…
      </div>
    );
  }
  if (error) {
    return <EmptyState compact title="Couldn't load the diff" description={error instanceof Error ? error.message : String(error)} />;
  }
  if (!files?.length) {
    return <EmptyState compact title='No file changes' description='There is no diff to show.' />;
  }

  const add = files.reduce((s, f) => s + f.additions, 0);
  const del = files.reduce((s, f) => s + f.deletions, 0);
  const toggle = (p: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const allCollapsed = collapsed.size === files.length;

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-3 text-[12px] text-content-muted'>
        <span>
          <b className='font-semibold text-content'>{files.length}</b> file{files.length === 1 ? '' : 's'} changed
        </span>
        <DiffStat add={add} del={del} />
        <DiffBar add={add} del={del} />
        <button
          type='button'
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((f) => f.path)))}
          className='ml-auto text-[11px] font-medium text-content-muted hover:text-content'
        >
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
      </div>

      {files.length > 1
        ? (
          <ul className='divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-default bg-surface-raised'>
            {files.map((f) => (
              <li key={f.path}>
                <a
                  href={`#diff-${encodeURIComponent(f.path)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    if (collapsed.has(f.path)) toggle(f.path);
                    document.getElementById(`diff-${f.path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className='flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-surface-sunken'
                >
                  <FileStatusDot status={f.status} />
                  <code className='min-w-0 flex-1 truncate font-mono text-content'>{f.path}</code>
                  <DiffStat add={f.additions} del={f.deletions} />
                </a>
              </li>
            ))}
          </ul>
        )
        : null}

      {files.map((f) => (
        <DiffFileView key={f.path} file={f} collapsed={collapsed.has(f.path)} onToggle={() => toggle(f.path)} />
      ))}
    </div>
  );
}

const STATUS_KIND: Record<DiffFile['status'], StatusKind> = {
  added: 'healthy',
  modified: 'info',
  deleted: 'failed',
  renamed: 'unknown',
};

function FileStatusDot({ status }: { status: DiffFile['status'] }) {
  const cls = { added: 'bg-emerald-500', modified: 'bg-sky-500', deleted: 'bg-rose-500', renamed: 'bg-slate-400' }[status];
  return <i className={cn('h-2 w-2 shrink-0 rounded-full', cls)} title={status} />;
}

function DiffFileView({ file, collapsed, onToggle }: { file: DiffFile; collapsed: boolean; onToggle(): void }) {
  return (
    <section id={`diff-${file.path}`} className='scroll-mt-4 overflow-hidden rounded-lg border border-edge-default bg-surface-raised'>
      <button
        type='button'
        onClick={onToggle}
        aria-expanded={!collapsed}
        className='flex w-full items-center gap-2 border-b border-edge-subtle bg-surface-sunken/50 px-3 py-2 text-left'
      >
        <span className={cn('text-content-subtle transition-transform', collapsed ? '-rotate-90' : '')}>
          <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.25' aria-hidden><path d='m6 9 6 6 6-6' /></svg>
        </span>
        <StatusBadge kind={STATUS_KIND[file.status]}>{file.status}</StatusBadge>
        <code className='min-w-0 flex-1 truncate font-mono text-[12px] text-content'>
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        </code>
        <DiffStat add={file.additions} del={file.deletions} />
      </button>
      {collapsed ? null : file.hunks.length === 0
        ? <div className='px-3 py-3 text-[12px] text-content-subtle'>Binary file or mode change — no text diff.</div>
        : (
          <div className='overflow-x-auto'>
            <table className='w-full border-collapse font-mono text-[12px] leading-[1.55]'>
              <tbody>
                {file.hunks.map((h, hi) => <HunkRows key={hi} hunk={h} />)}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function HunkRows({ hunk }: { hunk: DiffFile['hunks'][number] }) {
  return (
    <>
      <tr className='bg-brand-50/60 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'>
        <td colSpan={2} className='select-none px-2' />
        <td className='whitespace-pre px-3 py-0.5 text-[11px]'>{hunk.header}</td>
      </tr>
      {hunk.lines.map((ln, i) => {
        const tint = ln.kind === 'add' ? 'bg-emerald-50 dark:bg-emerald-500/10' : ln.kind === 'del' ? 'bg-rose-50 dark:bg-rose-500/10' : '';
        const marker = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' ';
        const markerTone = ln.kind === 'add' ? 'text-emerald-700 dark:text-emerald-300' : ln.kind === 'del' ? 'text-rose-700 dark:text-rose-300' : 'text-content-subtle';
        return (
          <tr key={i} className={cn('align-top', tint)}>
            <td className='w-10 select-none whitespace-nowrap border-r border-edge-subtle px-1.5 text-right text-[11px] tabular-nums text-content-subtle'>{ln.oldNo ?? ''}</td>
            <td className='w-10 select-none whitespace-nowrap border-r border-edge-subtle px-1.5 text-right text-[11px] tabular-nums text-content-subtle'>{ln.newNo ?? ''}</td>
            <td className='whitespace-pre px-3 text-content'>
              <span className={cn('select-none', markerTone)}>{marker}</span>
              {ln.text || ' '}
            </td>
          </tr>
        );
      })}
    </>
  );
}
