import { createContext, forwardRef, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, DrawerWidenButton, type DrawerWidth, useClickOutside, useDrawerWidth, useOverlayDismiss } from '@adhar/shell-ui';
import { cn } from '@adhar/utils';

/**
 * Toolbar and filter primitives shared by every Develop list — repositories,
 * branches, commits, pull requests and issues — so the pages read as one
 * product: count tiles that double as filters, a Filters popover, chips for
 * every active filter, a sort menu and a ⋯ action menu.
 */

/** A small popover anchored under its trigger; outside click and Escape close it. */
export function Popover({ open, onClose, align = 'left', width = 'w-72', children }: { open: boolean; onClose(): void; align?: 'left' | 'right'; width?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose, open);
  if (!open) return null;
  return (
    <div ref={ref} className={cn('pop-in absolute top-full z-56 mt-1.5 rounded-xl border border-edge-default bg-surface-raised p-2 shadow-xl ring-1 ring-black/5 dark:ring-white/10', align === 'right' ? 'right-0' : 'left-0', width)}>
      {children}
    </div>
  );
}

export function ToolbarBtn({ on, onClick, children, badge, title }: { on?: boolean; onClick(): void; children: ReactNode; badge?: number; title?: string }) {
  return (
    <button
      type='button'
      onClick={onClick}
      title={title}
      aria-expanded={on}
      aria-haspopup='dialog'
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors',
        on ? 'border-edge-strong bg-surface-sunken text-content' : 'border-edge-default bg-surface-app text-content-muted hover:border-edge-strong hover:text-content',
      )}
    >
      {children}
      {badge ? <span className='rounded-full bg-content px-1.5 py-px text-[10px] font-semibold tabular-nums text-surface-raised'>{badge}</span> : null}
    </button>
  );
}


export function FilterSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='mb-2 last:mb-0'>
      <div className='px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{title}</div>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange(v: T): void; options: Array<[T, string]> }) {
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

export function ChipGroup<T extends string>({ value, onChange, options, swatch }: { value: T; onChange(v: T): void; options: Array<[T, string]>; swatch?(v: T): string | undefined }) {
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
              'inline-flex h-6.5 items-center gap-1.5 rounded-full border px-2 text-[11px] transition-colors',
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

export function Chip({ children, onClear }: { children: ReactNode; onClear(): void }) {
  return (
    <span className='inline-flex items-center gap-1 rounded-full border border-edge-default bg-surface-app py-0.5 pl-2 pr-1 text-[11px] font-medium text-content'>
      {children}
      <button type='button' onClick={onClear} aria-label='Remove filter' className='flex h-4 w-4 items-center justify-center rounded-full text-content-subtle hover:bg-surface-sunken hover:text-content'>×</button>
    </span>
  );
}


export type Tone = 'slate' | 'brand' | 'amber' | 'emerald' | 'info' | 'violet';

export function StatTile({ label, value, hint, tone = 'slate', on = false, onClick }: {
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
      {hint ? <span className='truncate text-[10px] text-content-subtle'>{hint}</span> : <span className='text-[10px]'>&nbsp;</span>}
    </Tag>
  );
}


export function LayoutBtn({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: ReactNode }) {
  return (
    <button type='button' title={title} aria-label={title} role='radio' aria-checked={on} onClick={onClick} className={cn('flex h-8 w-8 items-center justify-center rounded-md transition-colors', on ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-subtle hover:text-content')}>
      {children}
    </button>
  );
}

export function MenuItem({ onClick, children, danger = false }: { onClick(): void; children: ReactNode; danger?: boolean }) {
  return (
    <button type='button' role='menuitem' onClick={onClick} className={cn('flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors', danger ? 'text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}>
      {children}
    </button>
  );
}

export const I = ({ children, size = 13 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>{children}</svg>
);
export const IconFilter = () => <I><path d='M3 5h18l-7 8v6l-4 2v-8z' /></I>;
export const IconSort = () => <I><path d='M4 7h10M4 12h7M4 17h4M17 6v12m0 0 3-3m-3 3-3-3' /></I>;
export const IconRows = () => <I size={14}><rect x='3' y='4' width='18' height='4' rx='1' /><rect x='3' y='10' width='18' height='4' rx='1' /><rect x='3' y='16' width='18' height='4' rx='1' /></I>;


/* ─────────── search ─────────── */

export const SearchField = forwardRef<HTMLInputElement, {
  value: string;
  onChange(v: string): void;
  placeholder: string;
  /** Show the `/` shortcut hint while empty. */
  slashHint?: boolean;
}>(function SearchField({ value, onChange, placeholder, slashHint = false }, ref) {
  return (
    <div className='relative min-w-0 flex-1 basis-64'>
      <span className='pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-content-subtle'>
        <I><circle cx='11' cy='11' r='7' /><path d='m20 20-3.5-3.5' /></I>
      </span>
      <input
        ref={ref}
        type='search'
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className='block h-9 w-full rounded-lg border border-edge-default bg-surface-app pl-8 pr-14 text-[13px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'
      />
      {value
        ? (
          <button type='button' onClick={() => onChange('')} aria-label='Clear search' className='absolute inset-y-0 right-2 flex items-center text-[11px] font-medium text-content-subtle hover:text-content'>
            clear
          </button>
        )
        : slashHint
        ? (
          <span className='pointer-events-none absolute inset-y-0 right-2.5 hidden items-center sm:flex'>
            <kbd className='rounded border border-edge-default bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-subtle'>/</kbd>
          </span>
        )
        : null}
    </div>
  );
});

/* ─────────── sort ─────────── */

export type Dir = 'asc' | 'desc';
export interface SortDef<K extends string> {
  key: K;
  label: string;
  defaultDir: Dir;
}

export function SortMenu<K extends string>({ sorts, sort, dir, onSort }: { sorts: ReadonlyArray<SortDef<K>>; sort: K; dir: Dir; onSort(k: K, d: Dir): void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const label = sorts.find((s) => s.key === sort)?.label ?? 'Sort';
  return (
    <div className='relative'>
      <ToolbarBtn on={open} onClick={() => setOpen((o) => !o)} title='Sort'>
        <IconSort /> <span className='hidden sm:inline'>{label}</span><span className='sm:hidden'>Sort</span>
        <span className='text-content-subtle'>{dir === 'asc' ? '↑' : '↓'}</span>
      </ToolbarBtn>
      <Popover open={open} onClose={close} width='w-56' align='right'>
        <div className='px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>Sort by</div>
        {sorts.map((s) => (
          <button
            key={s.key}
            type='button'
            onClick={() => onSort(s.key, s.key === sort ? (dir === 'asc' ? 'desc' : 'asc') : s.defaultDir)}
            className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] transition-colors', s.key === sort ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}
          >
            {s.label}
            {s.key === sort ? <span className='text-content-subtle'>{dir === 'asc' ? '↑' : '↓'}</span> : null}
          </button>
        ))}
        <div className='mt-1 border-t border-edge-subtle px-1 pt-1.5'>
          <Segmented value={dir} onChange={(d) => onSort(sort, d)} options={[['desc', 'Descending'], ['asc', 'Ascending']]} />
        </div>
      </Popover>
    </div>
  );
}

/* ─────────── ⋯ menu ─────────── */

export function MoreMenu({ label, children, width = 'w-52' }: { label: string; children(close: () => void): ReactNode; width?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className='relative shrink-0' onClick={(e) => e.stopPropagation()}>
      <button
        type='button'
        aria-label={label}
        aria-haspopup='menu'
        aria-expanded={open}
        onClick={() => setOpen((m) => !m)}
        className={cn('flex h-7 w-7 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content', open && 'bg-surface-sunken text-content')}
      >
        <svg width='14' height='14' viewBox='0 0 24 24' fill='currentColor' aria-hidden>
          <circle cx='5' cy='12' r='2' /><circle cx='12' cy='12' r='2' /><circle cx='19' cy='12' r='2' />
        </svg>
      </button>
      <Popover open={open} onClose={close} align='right' width={width}>
        <div role='menu'>{children(close)}</div>
      </Popover>
    </div>
  );
}

/* ─────────── people + labels ─────────── */

export function Avatar({ login, url, size = 28 }: { login: string; url?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    let h = 0;
    for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) % 360;
    return (
      <span
        title={login}
        className='flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-1 ring-edge-subtle'
        style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4), background: `oklch(0.62 0.12 ${h})` }}
      >
        {login.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=''
      title={login}
      onError={() => setBroken(true)}
      className='shrink-0 rounded-full ring-1 ring-edge-subtle'
      style={{ width: size, height: size }}
    />
  );
}

export function AvatarStack({ people, max = 3, size = 20 }: { people: Array<{ login: string; avatar_url?: string }>; max?: number; size?: number }) {
  if (!people.length) return null;
  return (
    <span className='flex -space-x-1.5' title={people.map((p) => p.login).join(', ')}>
      {people.slice(0, max).map((p) => <Avatar key={p.login} login={p.login} url={p.avatar_url} size={size} />)}
      {people.length > max
        ? <span className='flex items-center justify-center rounded-full bg-surface-sunken text-[9px] font-semibold text-content-muted ring-1 ring-edge-subtle' style={{ width: size, height: size }}>+{people.length - max}</span>
        : null}
    </span>
  );
}

/** A Gitea label — its own colour as dot + tinted ring, legible in both themes. */
export function LabelPill({ name, color, onClick, on }: { name: string; color: string; onClick?(): void; on?: boolean }) {
  const hex = `#${color.replace(/^#/, '')}`;
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium text-content',
        onClick && 'transition-colors hover:bg-surface-sunken',
        on && 'bg-surface-sunken',
      )}
      style={{ borderColor: `color-mix(in oklch, ${hex} 45%, transparent)` }}
    >
      <i className='h-1.5 w-1.5 rounded-full' style={{ background: hex }} />
      {name}
    </Tag>
  );
}

/* ─────────── states ─────────── */

/**
 * First-load placeholder for a Develop list: skeleton rows shaped like the
 * real rows (state icon, title, meta line, avatar), so the page keeps its
 * layout while Gitea answers. `label` is announced to screen readers.
 */
export function LoadingBlock({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <div role='status' aria-busy='true' aria-label={label} className='overflow-hidden rounded-xl border border-edge-default bg-surface-raised'>
      <ListSkeleton rows={rows} />
      <span className='sr-only'>{label}</span>
    </div>
  );
}

const SKELETON_WIDTHS = ['72%', '54%', '64%', '47%', '68%', '58%', '42%', '61%'];

/** Skeleton rows without a frame — for inside cards and drawer sections. */
export function ListSkeleton({ rows = 5, avatar = true, dense = false }: { rows?: number; avatar?: boolean; dense?: boolean }) {
  return (
    <ul aria-hidden className='divide-y divide-edge-subtle'>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className={cn('flex items-start gap-3', dense ? 'px-0 py-2.5' : 'px-4 py-3')}>
          <span className='skeleton-shimmer mt-0.5 h-4 w-4 shrink-0 rounded-full' style={{ animationDelay: `${i * 60}ms` }} />
          <div className='min-w-0 flex-1 space-y-2'>
            <span className='skeleton-shimmer block h-3.5 rounded' style={{ width: SKELETON_WIDTHS[i % SKELETON_WIDTHS.length], animationDelay: `${i * 60}ms` }} />
            <span className='skeleton-shimmer block h-2.5 w-1/3 rounded' style={{ animationDelay: `${i * 60 + 30}ms` }} />
          </div>
          {avatar ? <span className='skeleton-shimmer hidden h-5 w-5 shrink-0 rounded-full sm:block' style={{ animationDelay: `${i * 60}ms` }} /> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Thin indeterminate bar pinned to the top of its (relative) container — the
 * signal that newer data is on its way while the current content stays put.
 */
export function PendingBar({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div data-pending aria-hidden className='pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 overflow-hidden rounded-full'>
      <div className='nav-progress-sweep h-full w-full bg-linear-to-r from-brand-500 via-accent-500 to-brand-500' />
    </div>
  );
}

/**
 * Stale-while-revalidate frame: while `pending` (a new repo, branch or state
 * is loading over the previous one) the previous content stays visible but
 * dimmed and inert, under a {@link PendingBar} — instead of blanking to a
 * spinner on every switch.
 */
export function SwapFrame({ pending, streaming = false, children, className }: {
  pending: boolean;
  /** First rows are shown and more detail is on its way: bar only, no dimming. */
  streaming?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className='relative' aria-busy={pending || streaming || undefined}>
      <PendingBar active={pending || streaming} />
      <div className={cn('transition-opacity duration-150', pending && 'pointer-events-none opacity-55', className)}>{children}</div>
    </div>
  );
}

/**
 * A tracker item (PR, issue, commit) that is still loading: title, meta line
 * and a conversation of skeleton cards — the drawer's own shape.
 */
export function ItemSkeleton({ label }: { label: string }) {
  return (
    <div role='status' aria-busy='true' aria-label={label} className='space-y-5'>
      <div className='space-y-2.5'>
        <span className='skeleton-shimmer block h-6 w-2/3 rounded' />
        <div className='flex flex-wrap items-center gap-2'>
          <span className='skeleton-shimmer block h-5 w-16 rounded-full' />
          <span className='skeleton-shimmer block h-3 w-24 rounded' />
          <span className='skeleton-shimmer block h-3 w-32 rounded' />
        </div>
      </div>
      {[0, 1].map((i) => (
        <div key={i} className='flex gap-3'>
          <span className='skeleton-shimmer block h-8 w-8 shrink-0 rounded-full' style={{ animationDelay: `${i * 120}ms` }} />
          <div className='min-w-0 flex-1 space-y-2 rounded-xl border border-edge-default bg-surface-raised p-4'>
            <span className='skeleton-shimmer block h-3 w-1/4 rounded' />
            <span className='skeleton-shimmer block h-2.5 w-full rounded' />
            <span className='skeleton-shimmer block h-2.5 w-11/12 rounded' />
            <span className='skeleton-shimmer block h-2.5 w-3/5 rounded' />
          </div>
        </div>
      ))}
      <span className='sr-only'>{label}</span>
    </div>
  );
}

/**
 * An honest load failure: names Gitea and what could not be read, shows the
 * reason, and retries in place.
 */
export function GiteaError({ what, error, onRetry, retrying = false, compact = false }: {
  what: string;
  error: unknown;
  onRetry(): void;
  retrying?: boolean;
  compact?: boolean;
}) {
  const reason = error instanceof Error ? error.message : error ? String(error) : 'Gitea did not answer.';
  return (
    <div role='alert' className={cn('flex flex-col items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/60 text-left dark:border-rose-500/30 dark:bg-rose-500/10', compact ? 'p-3' : 'p-5')}>
      <div className='text-sm font-semibold text-rose-800 dark:text-rose-200'>Couldn't load {what} from Gitea</div>
      <p className='max-w-prose break-words text-[12px] text-rose-900/80 dark:text-rose-200/80'>{reason}</p>
      <Button size='xs' variant='secondary' loading={retrying} onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function DiffStat({ add, del }: { add?: number; del?: number }) {
  return (
    <span className='whitespace-nowrap font-mono text-[11px] tabular-nums'>
      <span className='text-emerald-700 dark:text-emerald-300'>+{add ?? 0}</span>{' '}
      <span className='text-rose-700 dark:text-rose-300'>−{del ?? 0}</span>
    </span>
  );
}

/** Five-block GitHub-style size bar for a change of `add`/`del` lines. */
export function DiffBar({ add = 0, del = 0 }: { add?: number; del?: number }) {
  const total = add + del;
  const blocks = 5;
  const green = total ? Math.round((add / total) * blocks) : 0;
  const red = total ? blocks - green : 0;
  return (
    <span className='inline-flex gap-px' aria-hidden>
      {Array.from({ length: blocks }, (_, i) => (
        <i
          key={i}
          className={cn('h-2 w-2 rounded-[2px]', i < green ? 'bg-emerald-500' : i < green + red ? 'bg-rose-500' : 'bg-surface-sunken')}
        />
      ))}
    </span>
  );
}

/* ─────────── drawer ─────────── */

/**
 * Right-hand detail drawer shared by the PR, issue and commit views.
 * Escape and the scrim close it; the body scrolls, header and footer stay.
 */
/** The drawer's wide-mode state, so the header's CloseButton can put the widen toggle beside it. */
const DrawerWidthCtx = createContext<DrawerWidth | null>(null);

export function Drawer({ onClose, header, footer, children, width = 'max-w-4xl', widthId = 'develop.drawer' }: {
  onClose(): void;
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** The standard max width (`max-w-*`, no lg+ breakpoints). */
  width?: string;
  /** Key the remembered wide-mode preference is stored under. */
  widthId?: string;
}) {
  useOverlayDismiss(true, onClose);
  const wide = useDrawerWidth(widthId, { base: width });
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className='fixed inset-0 z-[60] flex justify-end' role='dialog' aria-modal='true'>
      <button type='button' aria-label='Close' className='absolute inset-0 bg-scrim/40 backdrop-blur-[2px]' onClick={onClose} />
      <aside className={cn('relative flex h-full w-full flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl', wide.className)}>
        <DrawerWidthCtx.Provider value={wide}>
          <header className='border-b border-edge-default bg-surface-raised px-5 py-4 sm:px-6'>{header}</header>
        </DrawerWidthCtx.Provider>
        <div className='flex-1 overflow-y-auto px-5 py-4 sm:px-6'>{children}</div>
        {footer ? <footer className='border-t border-edge-default bg-surface-raised px-5 py-3 sm:px-6'>{footer}</footer> : null}
      </aside>
    </div>,
    document.body,
  );
}

/**
 * The drawer header's Close. Inside a `Drawer` header it brings the widen
 * toggle with it, so every Develop drawer ends [widen] [close].
 */
export function CloseButton({ onClick }: { onClick(): void }) {
  const wide = useContext(DrawerWidthCtx);
  const close = (
    <button type='button' onClick={onClick} aria-label='Close' className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'>
      <I size={14}><path d='M18 6 6 18' /><path d='m6 6 12 12' /></I>
    </button>
  );
  if (!wide) return close;
  return (
    <span className='flex shrink-0 items-center gap-1'>
      <DrawerWidenButton wide={wide.wide} onToggle={wide.toggle} />
      {close}
    </span>
  );
}

/* ─────────── state icons ─────────── */

export type PrState = 'open' | 'merged' | 'closed' | 'draft';
export function prState(p: { state: string; merged?: boolean; merged_at?: string | null; draft?: boolean; title?: string }): PrState {
  if (p.merged || p.merged_at) return 'merged';
  if (p.state === 'closed') return 'closed';
  if (p.draft || /^(wip|draft)[:\s\]]/i.test(p.title ?? '') || /^\[(wip|draft)\]/i.test(p.title ?? '')) return 'draft';
  return 'open';
}

const PR_TONE: Record<PrState, string> = {
  open: 'text-emerald-600 dark:text-emerald-400',
  draft: 'text-content-subtle',
  merged: 'text-violet-600 dark:text-violet-400',
  closed: 'text-rose-600 dark:text-rose-400',
};

export function PrStateIcon({ state, size = 16 }: { state: PrState; size?: number }) {
  return (
    <span className={cn('shrink-0', PR_TONE[state])} title={state}>
      {state === 'merged'
        ? <I size={size}><circle cx='6' cy='5' r='2.5' /><circle cx='6' cy='19' r='2.5' /><circle cx='18' cy='13' r='2.5' /><path d='M6 7.5v9' /><path d='M6 7.5c0 3 2 5.5 9.5 5.5' /></I>
        : state === 'closed'
        ? <I size={size}><circle cx='6' cy='5' r='2.5' /><circle cx='6' cy='19' r='2.5' /><path d='M6 7.5v9' /><path d='m15 4 5 5m0-5-5 5' /><path d='M18 13v3.5' /><circle cx='18' cy='19' r='2.5' /></I>
        : <I size={size}><circle cx='6' cy='5' r='2.5' /><circle cx='6' cy='19' r='2.5' /><circle cx='18' cy='19' r='2.5' /><path d='M6 7.5v9' /><path d='M18 16.5V9a3 3 0 0 0-3-3h-4' /><path d='m13 3-3 3 3 3' /></I>}
    </span>
  );
}

export function PrStateBadge({ state }: { state: PrState }) {
  const cls = {
    open: 'bg-emerald-600 text-white',
    draft: 'bg-slate-500 text-white',
    merged: 'bg-violet-600 text-white',
    closed: 'bg-rose-600 text-white',
  }[state];
  return (
    <span className={cn('inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-semibold capitalize', cls)}>
      <span className='text-white'><PrStateIconRaw state={state} /></span>
      {state}
    </span>
  );
}
function PrStateIconRaw({ state }: { state: PrState }) {
  return <span className='[&_span]:text-white'><PrStateIcon state={state} size={12} /></span>;
}

export function IssueStateIcon({ state, size = 16 }: { state: 'open' | 'closed'; size?: number }) {
  return state === 'open'
    ? <span className='shrink-0 text-emerald-600 dark:text-emerald-400' title='open'><I size={size}><circle cx='12' cy='12' r='9' /><circle cx='12' cy='12' r='1.5' fill='currentColor' /></I></span>
    : <span className='shrink-0 text-violet-600 dark:text-violet-400' title='closed'><I size={size}><circle cx='12' cy='12' r='9' /><path d='m8.5 12 2.5 2.5 4.5-5' /></I></span>;
}

export function IssueStateBadge({ state }: { state: 'open' | 'closed' }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-semibold capitalize text-white', state === 'open' ? 'bg-emerald-600' : 'bg-violet-600')}>
      <span className='[&_span]:text-white'><IssueStateIcon state={state} size={12} /></span>
      {state}
    </span>
  );
}

export const IconComment = () => <I size={12}><path d='M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z' /></I>;
export const IconCommit = ({ size = 13 }: { size?: number }) => <I size={size}><circle cx='12' cy='12' r='3.5' /><path d='M3 12h5.5M15.5 12H21' /></I>;
export const IconBranchSmall = () => <I size={12}><circle cx='6' cy='6' r='2.5' /><circle cx='6' cy='18' r='2.5' /><circle cx='18' cy='8' r='2.5' /><path d='M6 8.5v7' /><path d='M18 10.5c0 3-3 4-6 4.5s-6 1.5-6 3' /></I>;
export const IconArrowRight = () => <I size={11}><path d='M5 12h14' /><path d='m12 5 7 7-7 7' /></I>;
