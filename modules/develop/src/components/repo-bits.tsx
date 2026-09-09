import { StatusBadge, type ToastApi } from '@adhar-console/shell-ui';
import type { gitea } from '@adhar-console/api-clients';

/**
 * Small shared pieces for the repository views — language colours (GitHub
 * linguist palette for the common ones) and the inline stroke icons.
 */

export const LANG_COLOR: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Go: '#00add8',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Python: '#3572a5',
  Rust: '#dea584',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#663399',
  SCSS: '#c6538c',
  Dockerfile: '#384d54',
  HCL: '#844fba',
  YAML: '#cb171e',
  Markdown: '#083fa1',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4f5d95',
  Swift: '#f05138',
  Dart: '#00b4ab',
  Scala: '#c22d40',
  Lua: '#000080',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Makefile: '#427819',
  Smarty: '#f0c040',
  Mustache: '#724b3b',
};

export function langColor(lang?: string | null): string {
  if (!lang) return 'var(--color-edge-default, #cbd5e1)';
  if (LANG_COLOR[lang]) return LANG_COLOR[lang];
  let h = 0;
  for (let i = 0; i < lang.length; i++) h = (h * 31 + lang.charCodeAt(i)) % 360;
  return `oklch(0.65 0.14 ${h})`;
}

type IconProps = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function IconSearch() {
  return (
    <svg {...base(13)} strokeWidth={2.25}>
      <circle cx='11' cy='11' r='7' />
      <path d='m20 20-3.5-3.5' />
    </svg>
  );
}
export function IconClose() {
  return (
    <svg {...base(14)} strokeWidth={2.25}>
      <path d='M18 6 6 18' />
      <path d='m6 6 12 12' />
    </svg>
  );
}
export function IconMore() {
  return (
    <svg width='14' height='14' viewBox='0 0 24 24' fill='currentColor' aria-hidden>
      <circle cx='5' cy='12' r='2' />
      <circle cx='12' cy='12' r='2' />
      <circle cx='19' cy='12' r='2' />
    </svg>
  );
}
export function IconGrid() {
  return (
    <svg {...base(14)}>
      <rect x='3' y='3' width='7' height='7' rx='1.5' />
      <rect x='14' y='3' width='7' height='7' rx='1.5' />
      <rect x='3' y='14' width='7' height='7' rx='1.5' />
      <rect x='14' y='14' width='7' height='7' rx='1.5' />
    </svg>
  );
}
export function IconList() {
  return (
    <svg {...base(14)}>
      <path d='M4 6h16M4 12h16M4 18h16' />
    </svg>
  );
}
export function IconRefresh() {
  return (
    <svg {...base(14)}>
      <path d='M21 12a9 9 0 1 1-2.64-6.36L21 8' />
      <path d='M21 3v5h-5' />
    </svg>
  );
}
export function IconPlus({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.25}>
      <path d='M12 5v14M5 12h14' />
    </svg>
  );
}
export function IconTrash() {
  return (
    <svg {...base(14)}>
      <path d='M3 6h18' />
      <path d='M8 6V4h8v2' />
      <path d='M19 6l-1 14H6L5 6' />
      <path d='M10 11v6M14 11v6' />
    </svg>
  );
}
export function IconCopy() {
  return (
    <svg {...base(13)}>
      <rect x='9' y='9' width='11' height='11' rx='2' />
      <path d='M5 15V5a2 2 0 0 1 2-2h10' />
    </svg>
  );
}
export function IconExternal() {
  return (
    <svg {...base(12)}>
      <path d='M14 4h6v6' />
      <path d='M20 4 10 14' />
      <path d='M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6' />
    </svg>
  );
}
export function IconShield() {
  return (
    <svg {...base(12)}>
      <path d='M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z' />
      <path d='m9 12 2 2 4-4' />
    </svg>
  );
}
export function IconBranch() {
  return (
    <svg {...base(13)}>
      <circle cx='6' cy='6' r='2.5' />
      <circle cx='6' cy='18' r='2.5' />
      <circle cx='18' cy='8' r='2.5' />
      <path d='M6 8.5v7' />
      <path d='M18 10.5c0 3-3 4-6 4.5s-6 1.5-6 3' />
    </svg>
  );
}
export function IconTag() {
  return (
    <svg {...base(13)}>
      <path d='M20 12 12 20l-8-8V4h8z' />
      <circle cx='8' cy='8' r='1.5' />
    </svg>
  );
}
export function IconWebhook() {
  return (
    <svg {...base(13)}>
      <path d='M18 16a3 3 0 1 0 3 3' />
      <path d='M9 19a3 3 0 1 0-3-3' />
      <path d='M12 6a3 3 0 1 0 3 3' />
      <path d='m12 9-3.5 6h9' />
      <path d='M15 9l3.5 7' />
    </svg>
  );
}
export function IconUsers() {
  return (
    <svg {...base(13)}>
      <circle cx='9' cy='8' r='3.5' />
      <path d='M2.5 20a6.5 6.5 0 0 1 13 0' />
      <path d='M16 4.5a3.5 3.5 0 0 1 0 7' />
      <path d='M17.5 13.5a6.5 6.5 0 0 1 4 6.5' />
    </svg>
  );
}
export function IconCheck() {
  return (
    <svg {...base(12)} strokeWidth={2.5}>
      <path d='M20 6 9 17l-5-5' />
    </svg>
  );
}

/* ─────────── shared helpers ─────────── */

export function RepoBadges({ repo: r, compact = false }: { repo: gitea.Repo; compact?: boolean }) {
  return (
    <>
      {r.private ? <StatusBadge kind='unknown'>private</StatusBadge> : <StatusBadge kind='info'>public</StatusBadge>}
      {r.archived ? <StatusBadge kind='degraded'>archived</StatusBadge> : null}
      {r.template ? <StatusBadge kind='info'>template</StatusBadge> : null}
      {!compact && r.fork ? <StatusBadge kind='unknown'>fork</StatusBadge> : null}
      {!compact && r.mirror ? <StatusBadge kind='unknown'>mirror</StatusBadge> : null}
      {!compact && r.empty ? <StatusBadge kind='unknown'>empty</StatusBadge> : null}
    </>
  );
}

export function copy(text: string, toast: ToastApi) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success('Copied to clipboard', { description: text }),
    () => toast.error('Clipboard unavailable'),
  );
}

export function fmtKb(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
}

