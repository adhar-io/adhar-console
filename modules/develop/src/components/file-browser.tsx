import { useMemo, useState } from 'react';
import { EmptyState, Markdown, Spinner, useGiteaOrg } from '@adhar/shell-ui';
import { dirOf, resolveReadmeImage } from '../data/readme-assets.ts';
import type { gitea } from '@adhar/api-clients';
import { useBranches, useFile, useTree } from '../data/git.ts';
import { CodeEditor } from './code-editor.tsx';
import {
  displayTypeFor,
  isBinaryPath,
  isImagePath,
  languageForFilename,
  looksBinary,
  MAX_EDITOR_BYTES,
} from '../data/file-language.ts';

/**
 * Repository file browser + viewer.
 *
 * Left: a lazily-loaded, expandable file tree for the selected repo + branch
 * (backed by `useTree` — subtrees only fetch when a folder is opened).
 * Right: the selected file in Monaco, the editor VS Code is built on, so the
 * viewer has real grammar-aware highlighting, folding, bracket matching,
 * minimap and ⌘F search rather than being monospace text in a table.
 * README.md at the repo root is shown by default.
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
      <div className='rounded-lg border border-edge-default bg-surface-raised'>
        <div className='flex items-center gap-2 border-b border-edge-subtle px-3 py-2'>
          <IconBranch />
          <select
            value={branch}
            onChange={(e) => onBranchChange(e.target.value)}
            className='h-7 min-w-0 flex-1 rounded-md border border-edge-default bg-surface-raised px-1.5 font-mono text-[11px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'
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
      <div className='rounded-lg border border-edge-default bg-surface-raised'>
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
      <div className='flex items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-4 text-sm text-content-muted'>
        <Spinner size={12} /> Loading {path}…
      </div>
    );
  }
  if (f.isError || !f.data) {
    return (
      <div className='rounded-lg border border-edge-default bg-surface-raised'>
        <EmptyState compact title="Couldn't load file" description={path} />
      </div>
    );
  }

  return <FileContents data={f.data} path={path} repo={repo} branch={branch} />;
}

/**
 * One file, rendered as whatever it actually is.
 *
 * Four cases, in the order they have to be checked: an image is shown, bytes
 * are refused before anything tries to decode them as text, a file too large
 * for Monaco to tokenise without freezing the tab falls back to plain text,
 * and everything else goes to the editor.
 */
function FileContents(
  { data, path, repo, branch }: {
    data: gitea.FileContent;
    path: string;
    repo: string;
    branch: string;
  },
) {
  const decoded = useMemo(
    () => (data.encoding === 'base64' ? safeAtob(data.content) : data.content),
    [data],
  );
  const language = useMemo(() => languageForFilename(path), [path]);
  const name = path.split('/').pop() ?? path;
  const isMarkdown = language === 'markdown';
  // A README's images are written relative to the file. Pointed at Gitea's raw
  // endpoint through the console's own proxy they just load — including in a
  // private repository, and with no call to anyone else's CDN.
  const org = useGiteaOrg();
  const imageCtx = useMemo(
    () => ({ owner: org, repo, ref: branch, dir: dirOf(path) }),
    [org, repo, branch, path],
  );
  // Markdown opens rendered, the way every forge shows a README. The source is
  // one click away, because this is still a file browser.
  const [raw, setRaw] = useState(false);

  if (isImagePath(path) && data.encoding === 'base64') {
    return (
      <Shell path={path} meta='image'>
        <div className='flex items-center justify-center bg-surface-sunken/40 p-6'>
          <img
            src={`data:${mimeForPath(path)};base64,${data.content}`}
            alt={name}
            className='max-h-[60vh] max-w-full rounded-md object-contain shadow-sm'
          />
        </div>
      </Shell>
    );
  }

  if (isBinaryPath(path) || looksBinary(decoded)) {
    return (
      <Shell path={path} meta='binary'>
        <EmptyState
          compact
          title='Binary file'
          description={`${name} is not text, so there is nothing to show here. Open it in Gitea to download it.`}
        />
      </Shell>
    );
  }

  if (isMarkdown && !raw) {
    return (
      <Shell
        path={path}
        meta='rendered'
        action={
          <button
            type='button'
            onClick={() => setRaw(true)}
            className='rounded-md border border-edge-default bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-content-muted transition-colors hover:border-edge-strong hover:text-content'
          >
            View source
          </button>
        }
      >
        <div className='max-h-[62vh] overflow-auto px-5 py-4'>
          <Markdown
            text={decoded}
            className='text-[13px] leading-relaxed'
            images='show'
            resolveSrc={(src) => resolveReadmeImage(src, imageCtx)}
          />
        </div>
      </Shell>
    );
  }

  const lines = decoded.replace(/\n$/, '').split('\n');

  // Monaco tokenises the whole buffer up front, so a very large file would
  // hang the tab. Plain text has no such cost and is still readable.
  if (decoded.length > MAX_EDITOR_BYTES) {
    return (
      <Shell path={path} meta={`${lines.length} lines · shown as plain text`}>
        <pre className='max-h-[60vh] overflow-auto whitespace-pre px-3 py-2 font-mono text-[12px] leading-[1.55] text-content'>
          {decoded}
        </pre>
      </Shell>
    );
  }

  return (
    <CodeEditor
      // Remount on path change: a new file is a new document, and reusing the
      // model would carry the previous file's folds and cursor into it.
      key={path}
      value={decoded}
      language={language}
      filename={name}
      title={<code className='truncate font-mono text-[11px] text-content'>{path}</code>}
      badge={displayTypeFor(path)}
      actions={isMarkdown
        ? (
          <button
            type='button'
            onClick={() => setRaw(false)}
            className='rounded-md border border-edge-default bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-content-muted transition-colors hover:border-edge-strong hover:text-content'
          >
            Rendered
          </button>
        )
        : undefined}
      readOnly
      minimap
      // The drawer is nearly the height of the window; 520px left most of it
      // empty under a file that had more to show.
      height={680}
    />
  );
}

/** The bordered frame the non-editor cases share with the editor's own. */
function Shell(
  { path, meta, action, children }: {
    path: string;
    meta: string;
    action?: React.ReactNode;
    children: React.ReactNode;
  },
) {
  return (
    <div className='flex min-w-0 flex-col overflow-hidden rounded-lg border border-edge-default bg-surface-raised'>
      <div className='flex items-center justify-between gap-2 border-b border-edge-subtle bg-surface-sunken/40 px-3 py-2'>
        <code className='truncate font-mono text-[11px] text-content'>{path}</code>
        <div className='flex shrink-0 items-center gap-2'>
          <span className='text-[10px] text-content-subtle'>{meta}</span>
          {action}
        </div>
      </div>
      {children}
    </div>
  );
}

/** Enough of a MIME map to put an image in a data URL. */
function mimeForPath(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'ico') return 'image/x-icon';
  return `image/${ext || 'png'}`;
}

/** Base64 → UTF-8 text (plain `atob` yields Latin-1 mojibake for emoji / box-drawing). */
function safeAtob(s: string): string {
  try {
    if (typeof atob !== 'function') return s;
    const bin = atob(s.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
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
