/**
 * Builder Component Palette
 *
 * Auto-discovers all Adhar UI components and makes them available
 * for drag-and-drop in the page builder. Also supports custom components.
 */

export interface PaletteItem {
  type: string;
  label: string;
  icon: string;
  defaultProps: Record<string, any>;
  acceptsChildren?: boolean;
  category?: string;
  custom?: boolean;
}

export interface PaletteCategory {
  id: string;
  label: string;
  icon: string;
  items: PaletteItem[];
  collapsed?: boolean;
}

// ─── Built-in Component Palette ──────────────────────────────────────────────
export const builtinPalette: PaletteCategory[] = [
  {
    id: 'layout',
    label: 'Layout',
    icon: '⊞',
    items: [
      { type: 'div', label: 'Container', icon: '▢', defaultProps: { className: 'p-4' }, acceptsChildren: true },
      { type: 'flex', label: 'Flex Row', icon: '↔', defaultProps: { className: 'flex gap-4' }, acceptsChildren: true },
      { type: 'flex-col', label: 'Flex Col', icon: '↕', defaultProps: { className: 'flex flex-col gap-4' }, acceptsChildren: true },
      { type: 'grid', label: 'Grid 2', icon: '⊞', defaultProps: { className: 'grid grid-cols-2 gap-4' }, acceptsChildren: true },
      { type: 'grid-3', label: 'Grid 3', icon: '⊞', defaultProps: { className: 'grid grid-cols-3 gap-4' }, acceptsChildren: true },
      { type: 'card', label: 'Card', icon: '▣', defaultProps: { className: 'rounded-xl border border-border bg-card p-6 shadow-sm' }, acceptsChildren: true },
      { type: 'section', label: 'Section', icon: '§', defaultProps: { className: 'py-12 px-4' }, acceptsChildren: true },
      { type: 'nav', label: 'Navbar', icon: '☰', defaultProps: { className: 'flex items-center justify-between h-14 px-6 border-b border-border' }, acceptsChildren: true },
      { type: 'footer', label: 'Footer', icon: '▤', defaultProps: { className: 'border-t border-border py-8 px-6' }, acceptsChildren: true },
      { type: 'sidebar', label: 'Sidebar', icon: '▌', defaultProps: { className: 'w-64 border-r border-border p-4 flex flex-col gap-2' }, acceptsChildren: true },
    ],
  },
  {
    id: 'typography',
    label: 'Typography',
    icon: 'T',
    items: [
      { type: 'h1', label: 'H1', icon: 'H1', defaultProps: { className: 'text-4xl font-bold tracking-tight', children: 'Heading' } },
      { type: 'h2', label: 'H2', icon: 'H2', defaultProps: { className: 'text-2xl font-semibold', children: 'Subheading' } },
      { type: 'h3', label: 'H3', icon: 'H3', defaultProps: { className: 'text-lg font-medium', children: 'Title' } },
      { type: 'p', label: 'Paragraph', icon: '¶', defaultProps: { className: 'text-muted-foreground leading-relaxed', children: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.' } },
      { type: 'span', label: 'Span', icon: 'T', defaultProps: { className: 'text-sm', children: 'Text' } },
      { type: 'blockquote', label: 'Quote', icon: '"', defaultProps: { className: 'border-l-4 border-primary/30 pl-4 italic text-muted-foreground', children: 'A meaningful quote.' } },
    ],
  },
  {
    id: 'forms',
    label: 'Forms',
    icon: '⬡',
    items: [
      { type: 'button', label: 'Button', icon: '⬡', defaultProps: { className: 'inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground h-10 px-4 text-sm font-medium shadow-sm hover:bg-primary/90', children: 'Button' } },
      { type: 'btn-secondary', label: 'Secondary', icon: '⬡', defaultProps: { className: 'inline-flex items-center justify-center rounded-md bg-secondary text-secondary-foreground h-10 px-4 text-sm font-medium hover:bg-secondary/80', children: 'Secondary' } },
      { type: 'btn-outline', label: 'Outline', icon: '⬡', defaultProps: { className: 'inline-flex items-center justify-center rounded-md border border-input bg-background h-10 px-4 text-sm font-medium shadow-sm hover:bg-accent', children: 'Outline' } },
      { type: 'btn-destructive', label: 'Danger', icon: '⬡', defaultProps: { className: 'inline-flex items-center justify-center rounded-md bg-destructive text-destructive-foreground h-10 px-4 text-sm font-medium shadow-sm', children: 'Delete' } },
      { type: 'btn-ghost', label: 'Ghost', icon: '⬡', defaultProps: { className: 'inline-flex items-center justify-center rounded-md h-10 px-4 text-sm font-medium hover:bg-accent', children: 'Ghost' } },
      { type: 'input', label: 'Input', icon: '▭', defaultProps: { className: 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring', placeholder: 'Enter text...' } },
      { type: 'textarea', label: 'Textarea', icon: '▭', defaultProps: { className: 'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm', placeholder: 'Write here...' } },
      { type: 'select-trigger', label: 'Select', icon: '▾', defaultProps: { className: 'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm', children: 'Select...' } },
      { type: 'checkbox-row', label: 'Checkbox', icon: '☑', defaultProps: { className: 'flex items-center gap-2.5 cursor-pointer', children: 'Accept terms' } },
      { type: 'switch-row', label: 'Switch', icon: '◉', defaultProps: { className: 'flex items-center justify-between py-2', children: 'Enabled' } },
      { type: 'label-el', label: 'Label', icon: 'L', defaultProps: { className: 'text-sm font-medium', children: 'Label' } },
    ],
  },
  {
    id: 'display',
    label: 'Display',
    icon: '●',
    items: [
      { type: 'badge', label: 'Badge', icon: '●', defaultProps: { className: 'inline-flex items-center rounded-full bg-primary text-primary-foreground px-2.5 py-0.5 text-xs font-semibold', children: 'Badge' } },
      { type: 'badge-outline', label: 'Badge Out', icon: '○', defaultProps: { className: 'inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold', children: 'Tag' } },
      { type: 'avatar', label: 'Avatar', icon: '◐', defaultProps: { className: 'w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-muted-foreground', children: 'AU' } },
      { type: 'separator', label: 'Divider', icon: '—', defaultProps: { className: 'h-px w-full bg-border my-4' } },
      { type: 'img-placeholder', label: 'Image', icon: '◻', defaultProps: { className: 'aspect-video w-full rounded-lg bg-muted flex items-center justify-center text-muted-foreground text-sm', children: 'Image' } },
      { type: 'progress-bar', label: 'Progress', icon: '▰', defaultProps: { className: 'h-2.5 w-full rounded-full bg-secondary overflow-hidden', 'data-value': '66' } },
      { type: 'skeleton-text', label: 'Skeleton', icon: '░', defaultProps: { className: 'h-4 w-3/4 rounded bg-muted animate-pulse' } },
      { type: 'icon-placeholder', label: 'Icon', icon: '★', defaultProps: { className: 'w-5 h-5 text-muted-foreground', children: '★' } },
    ],
  },
  {
    id: 'navigation',
    label: 'Navigation',
    icon: '↗',
    items: [
      { type: 'link', label: 'Link', icon: '↗', defaultProps: { className: 'text-sm text-primary hover:underline cursor-pointer', children: 'Link' } },
      { type: 'breadcrumb', label: 'Breadcrumb', icon: '>', defaultProps: { className: 'flex items-center gap-1.5 text-sm text-muted-foreground', children: 'Home / Page' } },
      { type: 'tab-item', label: 'Tab', icon: '▬', defaultProps: { className: 'px-4 py-2 text-sm font-medium border-b-2 border-primary', children: 'Tab' } },
      { type: 'menu-item', label: 'Menu Item', icon: '▸', defaultProps: { className: 'flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent cursor-pointer', children: 'Menu item' } },
    ],
  },
  {
    id: 'feedback',
    label: 'Alerts',
    icon: 'ℹ',
    items: [
      { type: 'alert-info', label: 'Info', icon: 'ℹ', defaultProps: { className: 'rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 text-sm', children: 'Info message.' } },
      { type: 'alert-success', label: 'Success', icon: '✓', defaultProps: { className: 'rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm', children: 'Success!' } },
      { type: 'alert-warning', label: 'Warning', icon: '⚠', defaultProps: { className: 'rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm', children: 'Warning.' } },
      { type: 'alert-error', label: 'Error', icon: '✕', defaultProps: { className: 'rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700', children: 'Error!' } },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    icon: '▦',
    items: [
      { type: 'stat-card', label: 'Stat Card', icon: '#', defaultProps: { className: 'rounded-xl border border-border bg-card p-5 shadow-sm' }, acceptsChildren: true },
      { type: 'list-item', label: 'List Item', icon: '•', defaultProps: { className: 'flex items-center gap-3 py-3 border-b border-border', children: 'Item' } },
      { type: 'empty-state-el', label: 'Empty', icon: '∅', defaultProps: { className: 'text-center py-12 text-muted-foreground', children: 'No items' } },
    ],
  },
  {
    id: 'composite',
    label: 'Blocks',
    icon: '▣',
    items: [
      { type: 'hero-section', label: 'Hero', icon: '▣', defaultProps: { className: 'py-16 px-4 text-center' }, acceptsChildren: true },
      { type: 'feature-card', label: 'Feature', icon: '▣', defaultProps: { className: 'rounded-xl border border-border bg-card p-6' }, acceptsChildren: true },
      { type: 'pricing-card', label: 'Pricing', icon: '$', defaultProps: { className: 'rounded-xl border border-border bg-card p-6 text-center' }, acceptsChildren: true },
      { type: 'cta-section', label: 'CTA', icon: '▣', defaultProps: { className: 'rounded-xl bg-primary/5 border border-primary/20 p-8 text-center' }, acceptsChildren: true },
      { type: 'login-form', label: 'Login', icon: '▣', defaultProps: { className: 'max-w-sm mx-auto rounded-xl border border-border bg-card p-8' }, acceptsChildren: true },
    ],
  },
  {
    id: 'screens',
    label: 'Screens',
    icon: '📱',
    items: [
      { type: 'screen-mobile', label: 'Mobile', icon: '📱', defaultProps: { className: 'w-[375px] min-h-[812px] bg-background rounded-[2.5rem] border-[3px] border-zinc-800 shadow-2xl relative overflow-hidden', children: '' }, acceptsChildren: true },
      { type: 'screen-tablet', label: 'Tablet', icon: '📲', defaultProps: { className: 'w-[768px] min-h-[1024px] bg-background rounded-[1.5rem] border-[3px] border-zinc-800 shadow-2xl relative overflow-hidden', children: '' }, acceptsChildren: true },
      { type: 'screen-desktop', label: 'Desktop', icon: '🖥', defaultProps: { className: 'w-[1280px] min-h-[800px] bg-background rounded-lg border border-zinc-300 shadow-2xl relative overflow-hidden', children: '' }, acceptsChildren: true },
      { type: 'frame', label: 'Frame', icon: '⬜', defaultProps: { className: 'w-[300px] h-[200px] bg-background rounded-lg border-2 border-dashed border-primary/20 p-3' }, acceptsChildren: true },
    ],
  },
  {
    id: 'architecture',
    label: 'Architecture',
    icon: '🔄',
    items: [
      { type: 'flow-step', label: 'Flow Step', icon: '⬡', defaultProps: { className: 'inline-flex items-center justify-center rounded-lg border-2 border-primary/40 bg-background px-6 py-4 text-sm font-medium', children: 'Step' } },
      { type: 'data-model', label: 'Data Model', icon: '🗄', defaultProps: { className: 'rounded-md border border-border bg-card p-4 text-xs font-mono min-w-[200px]', children: 'Entity\n─────\nid: string\nname: string\ncreatedAt: Date' } },
      { type: 'api-endpoint', label: 'API Endpoint', icon: '🌐', defaultProps: { className: 'rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs font-mono', children: 'GET /api/resource' } },
      { type: 'note', label: 'Sticky Note', icon: '📌', defaultProps: { className: 'w-[200px] min-h-[150px] rounded bg-yellow-100 dark:bg-yellow-900/30 p-3 text-sm shadow-sm', children: 'Add note...' } },
    ],
  },
  {
    id: 'shapes',
    label: 'Shapes',
    icon: '⬜',
    items: [
      { type: 'shape-rect', label: 'Rectangle', icon: '⬜', defaultProps: { className: 'w-[120px] h-[80px] bg-muted' } },
      { type: 'shape-rounded', label: 'Rounded Rect', icon: '⬜', defaultProps: { className: 'w-[120px] h-[80px] bg-muted rounded-xl' } },
      { type: 'shape-circle', label: 'Circle', icon: '⭕', defaultProps: { className: 'w-[80px] h-[80px] bg-muted rounded-full' } },
      { type: 'shape-line', label: 'Line', icon: '—', defaultProps: { className: 'w-[200px] h-[2px] bg-foreground' } },
    ],
  },
];

// ─── Custom Component Storage ────────────────────────────────────────────────
const CUSTOM_COMPONENTS_KEY = 'adhar-builder-custom-components';

export function loadCustomComponents(): PaletteItem[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_COMPONENTS_KEY) || '[]');
  } catch { return []; }
}

export function saveCustomComponent(item: PaletteItem): void {
  const items = loadCustomComponents();
  items.push({ ...item, custom: true });
  localStorage.setItem(CUSTOM_COMPONENTS_KEY, JSON.stringify(items));
}

export function deleteCustomComponent(type: string): void {
  const items = loadCustomComponents().filter((i) => i.type !== type);
  localStorage.setItem(CUSTOM_COMPONENTS_KEY, JSON.stringify(items));
}

// ─── Get full palette including custom ───────────────────────────────────────
export function getFullPalette(): PaletteCategory[] {
  const custom = loadCustomComponents();
  if (custom.length === 0) return builtinPalette;

  return [
    ...builtinPalette,
    {
      id: 'custom',
      label: 'My Components',
      icon: '⚙',
      items: custom,
    },
  ];
}

// ─── Search palette ──────────────────────────────────────────────────────────
export function searchPalette(palette: PaletteCategory[], query: string): PaletteCategory[] {
  if (!query.trim()) return palette;
  const q = query.toLowerCase();
  return palette
    .map((cat) => ({
      ...cat,
      items: cat.items.filter((item) =>
        item.label.toLowerCase().includes(q) || item.type.toLowerCase().includes(q)
      ),
    }))
    .filter((cat) => cat.items.length > 0);
}
