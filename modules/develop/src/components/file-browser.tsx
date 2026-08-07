import { useState } from 'react';
import { EmptyState, Spinner } from '@adhar-console/shell-ui';
import type { gitea } from '@adhar-console/api-clients';
import { useBranches, useFile, useTree } from '../data/git.ts';

/**
 * Repository file browser + viewer.
 *
 * Left: a lazily-loaded, expandable file tree for the selected repo + branch
 * (backed by `useTree` — subtrees only fetch when a folder is opened).
 * Right: the selected file rendered in a monospace, line-numbered viewer
 * (backed by `useFile`). README.md at the repo root is shown by default.
 */
export function FileBrowser({ repo }: { repo: gitea.Repo }) {
  const branches = useBranches(repo.name);
  const [branch, setBranch] = useState(repo.default_branch);
  const [selected, setSelected] = useState<string | null>(null);

  const root = useTree(repo.name, branch, '');
  const rootReadme = root.data?.find((e) => e.path.toLowerCase() === 'readme.md');
  // Default view: the repo-root README rendered as text, until a file is picked.
  const viewPath = selected ?? rootReadme?.path ?? null;

  const onBranchChange = (next: string) => {
    setBranch(next);
    setSelected(null);
  };

  return (
    <div className='grid grid-cols-1 gap-3 lg:grid-cols-[260px_1fr]'>
      <div className='rounded-lg border border-edge-default bg-white'>
        <div className='flex items-center gap-2 border-b border-edge-subtle px-3 py-2'>
          <IconBranch />
          <select
            value={branch}
            onChange={(e) => onBranchChange(e.target.value)}
            className='h-7 min-w-0 flex-1 rounded-md border border-edge-default bg-white px-1.5 font-mono text-[11px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'
          >
            {(branches.data?.length ? branches.data.map((b) => b.name) : [repo.default_branch]).map(
              (name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ),
            )}
          </select>
        </div>
        <div className='max-h-[60vh] overflow-y-auto p-1.5'>
          <Subtree
            repo={repo.name}
            branch={branch}
            path=''
            depth={0}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
      </div>

      <FileView repo={repo.name} branch={branch} path={viewPath} />
    </div>
  );
}

/** Renders the entries at one path; only mounted when its parent folder is open. */
function Subtree({
  repo,
  branch,
  path,
  depth,
  selected,
  onSelect,
}: {
  repo: string;
  branch: string;
  path: string;
  depth: number;
  selected: string | null;
  onSelect(path: string): void;
}) {
  const t = useTree(repo, branch, path);

  if (t.isLoading) {
    return (
      <div className='flex items-center gap-2 px-2 py-1.5 text-[11px] text-content-muted'>
        <Spinner size={10} /> Loading…
      </div>
    );
  }
  if (!t.data?.length) {
    return <div className='px-2 py-1.5 text-[11px] text-content-subtle'>Empty</div>;
  }

  const entries = [...t.data].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return (
    <ul>
      {entries.map((e) => (
        <TreeNode
          key={e.path}
          repo={repo}
          branch={branch}
          entry={e}
          depth={depth}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  repo,
  branch,
  entry,
  depth,
  selected,
  onSelect,
}: {
  repo: string;
  branch: string;
  entry: gitea.TreeEntry;
  depth: number;
  selected: string | null;
  onSelect(path: string): void;
}) {
  const [open, setOpen] = useState(false);
  const name = entry.path.split('/').pop() ?? entry.path;
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  if (entry.type === 'tree') {
    return (
      <li>
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          style={pad}
          className='flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] text-content hover:bg-surface-sunken'
        >
          <IconChevron open={open} />
          <IconFolder open={open} />
          <span className='truncate'>{name}</span>
        </button>
        {open
          ? (
            <Subtree
              repo={repo}
              branch={branch}
              path={entry.path}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          )
          : null}
      </li>
    );
  }

  const isActive = selected === entry.path;
  return (
    <li>
      <button
        type='button'
        onClick={() => onSelect(entry.path)}
        style={pad}
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] hover:bg-surface-sunken ${
          isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-content'
        }`}
      >
        <span className='w-3.5 shrink-0' />
        <IconFile />
        <span className='truncate'>{name}</span>
      </button>
    </li>
  );
}

function FileView({
  repo,
  branch,
  path,
}: {
  repo: string;
  branch: string;
  path: string | null;
}) {
  const f = useFile(repo, branch, path ?? undefined);

  if (!path) {
    return (
      <div className='rounded-lg border border-edge-default bg-white'>
        <EmptyState
          compact
          title='Select a file'
          description='Pick a file from the tree to view its contents.'
        />
      </div>
    );
  }
  if (f.isLoading) {
    return (
      <div className='flex items-center gap-2 rounded-lg border border-edge-default bg-white p-4 text-sm text-content-muted'>
        <Spinner size={12} /> Loading {path}…
      </div>
    );
  }
  if (f.isError || !f.data) {
    return (
      <div className='rounded-lg border border-edge-default bg-white'>
        <EmptyState compact title="Couldn't load file" description={path} />
      </div>
    );
  }

  const decoded = f.data.encoding === 'base64' ? safeAtob(f.data.content) : f.data.content;
  const lines = decoded.replace(/\n$/, '').split('\n');

  return (
    <div className='flex min-w-0 flex-col overflow-hidden rounded-lg border border-edge-default bg-white'>
      <div className='flex items-center justify-between gap-2 border-b border-edge-subtle bg-surface-sunken/40 px-3 py-2'>
        <code className='truncate font-mono text-[11px] text-content'>{path}</code>
        <span className='shrink-0 text-[10px] text-content-subtle'>
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className='max-h-[60vh] overflow-auto'>
        <table className='w-full border-collapse font-mono text-[12px] leading-[1.55]'>
          <tbody>
            {lines.map((ln, i) => (
              <tr key={i} className='align-top hover:bg-brand-50/30'>
                <td className='select-none whitespace-nowrap border-r border-edge-subtle px-2 text-right text-content-subtle tabular-nums'>
                  {i + 1}
                </td>
                <td className='whitespace-pre px-3 text-content'>{ln || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function safeAtob(s: string): string {
  try {
    return typeof atob === 'function' ? atob(s) : s;
  } catch {
    return s;
  }
}

/* ─────────── icons ─────────── */

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width='12'
      height='12'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={`shrink-0 text-content-subtle transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden
    >
      <path d='m9 18 6-6-6-6' />
    </svg>
  );
}
function IconFolder({ open }: { open: boolean }) {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      className='shrink-0 text-amber-500'
      aria-hidden
    >
      {open
        ? (
          <path d='M3 8h18l-2 10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5l2 3h7a1 1 0 0 1 1 1' />
        )
        : <path d='M4 5h5l2 3h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z' />}
    </svg>
  );
}
function IconFile() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      className='shrink-0 text-content-subtle'
      aria-hidden
    >
      <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z' />
      <path d='M14 2v6h6' />
    </svg>
  );
}
function IconBranch() {
  return (
    <svg
      width='13'
      height='13'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      className='shrink-0 text-content-subtle'
      aria-hidden
    >
      <circle cx='6' cy='6' r='2.5' />
      <circle cx='6' cy='18' r='2.5' />
      <circle cx='18' cy='8' r='2.5' />
      <path d='M6 8.5v7' />
      <path d='M18 10.5a6 6 0 0 1-6 6H8.5' />
    </svg>
  );
}
