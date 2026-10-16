/**
 * The Visual Designer's component palette — app building blocks, not just
 * HTML tags. Composite items (`build`) drop a whole, styled subtree: a form
 * with labelled fields, a data table bound to a data source, a modal with its
 * close button wired, tabs, a sidebar…
 *
 * Styling uses the design-theme vocabulary (bg-card, text-muted-foreground,
 * bg-primary…), so everything follows the project's theme and the workspace
 * design tokens.
 */

import { genId, type CanvasNode } from './builder-types.ts';

export interface Blueprint {
  type: string;
  label: string;
  icon: string;
  /** Searchable extra words. */
  keywords?: string;
  defaultProps?: Record<string, unknown>;
  build?: () => CanvasNode;
}

export interface BlueprintCategory {
  id: string;
  label: string;
  icon: string;
  items: Blueprint[];
}

export function n(type: string, className: string, text?: string, children: CanvasNode[] = [], extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: genId(),
    type,
    props: { className, ...(text !== undefined ? { children: text } : {}), ...extra },
    children,
    style: {},
  };
}

const INPUT = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground';
const BTN = 'inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground h-10 px-4 text-sm font-medium shadow-sm hover:opacity-90';
const BTN_OUT = 'inline-flex items-center justify-center rounded-md border border-input bg-background h-10 px-4 text-sm font-medium hover:bg-accent';
const LABEL = 'text-sm font-medium';

const field = (label: string, input: CanvasNode) => n('flex-col', 'flex flex-col gap-1.5', undefined, [n('label-el', LABEL, label), input]);

export function modalNode(title = 'Dialog title'): CanvasNode {
  const panelId = genId();
  const close = n('btn-outline', BTN_OUT, 'Cancel');
  const panel: CanvasNode = {
    ...n('modal', 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4', undefined, [
      n('card', 'w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl flex flex-col gap-4', undefined, [
        n('h3', 'text-lg font-semibold', title),
        n('p', 'text-sm text-muted-foreground', 'Explain what happens next. Keep it short.'),
        n('flex', 'flex justify-end gap-2', undefined, [close, n('button', BTN, 'Confirm')]),
      ]),
    ]),
    id: panelId,
  };
  close.interactions = [{ trigger: 'click', action: 'toggle-visibility', targetNodeId: panelId }];
  return panel;
}

export const BLUEPRINTS: BlueprintCategory[] = [
  {
    id: 'layout', label: 'Layout', icon: '⊞', items: [
      { type: 'section', label: 'Section', icon: '§', defaultProps: { className: 'py-12 px-6' } },
      { type: 'div', label: 'Container', icon: '▢', defaultProps: { className: 'mx-auto max-w-6xl px-6' } },
      { type: 'flex-col', label: 'Stack', icon: '↕', keywords: 'vertical column', defaultProps: { className: 'flex flex-col gap-4' } },
      { type: 'flex', label: 'Row', icon: '↔', keywords: 'horizontal inline', defaultProps: { className: 'flex items-center gap-4' } },
      { type: 'grid', label: 'Grid', icon: '⊞', defaultProps: { className: 'grid grid-cols-3 gap-6' } },
      { type: 'columns', label: 'Two columns', icon: '◫', keywords: 'split', build: () => n('grid', 'grid grid-cols-2 gap-8', undefined, [n('flex-col', 'flex flex-col gap-3'), n('flex-col', 'flex flex-col gap-3')]) },
      { type: 'card', label: 'Card', icon: '▣', build: () => n('card', 'rounded-xl border border-border bg-card p-6 shadow-sm flex flex-col gap-2', undefined, [n('h3', 'font-semibold', 'Card title'), n('p', 'text-sm text-muted-foreground', 'Supporting text for this card.')]) },
      { type: 'separator', label: 'Divider', icon: '—', defaultProps: { className: 'h-px w-full bg-border my-4' } },
    ],
  },
  {
    id: 'text', label: 'Text', icon: 'T', items: [
      { type: 'h1', label: 'Heading 1', icon: 'H1', defaultProps: { className: 'text-4xl font-bold tracking-tight', children: 'Page title' } },
      { type: 'h2', label: 'Heading 2', icon: 'H2', defaultProps: { className: 'text-2xl font-semibold', children: 'Section title' } },
      { type: 'h3', label: 'Heading 3', icon: 'H3', defaultProps: { className: 'text-lg font-semibold', children: 'Title' } },
      { type: 'p', label: 'Paragraph', icon: '¶', defaultProps: { className: 'text-muted-foreground leading-relaxed', children: 'Write something people will actually read.' } },
      { type: 'span', label: 'Text', icon: 'T', defaultProps: { className: 'text-sm', children: 'Text' } },
      { type: 'link', label: 'Link', icon: '↗', defaultProps: { className: 'text-sm font-medium text-primary hover:underline cursor-pointer', children: 'Learn more' } },
    ],
  },
  {
    id: 'forms', label: 'Forms', icon: '⬡', items: [
      { type: 'button', label: 'Button', icon: '⬡', defaultProps: { className: BTN, children: 'Continue' } },
      { type: 'btn-outline', label: 'Button (outline)', icon: '⬡', defaultProps: { className: BTN_OUT, children: 'Cancel' } },
      { type: 'input', label: 'Text input', icon: '▭', keywords: 'field email', defaultProps: { className: INPUT, placeholder: 'you@company.com' } },
      { type: 'textarea', label: 'Textarea', icon: '▤', defaultProps: { className: `${INPUT} min-h-[96px]`, placeholder: 'Tell us more…' } },
      { type: 'select', label: 'Select', icon: '▾', keywords: 'dropdown', defaultProps: { className: INPUT, options: ['Option one', 'Option two', 'Option three'] } },
      { type: 'date-input', label: 'Date', icon: '📅', keywords: 'calendar', defaultProps: { className: INPUT } },
      { type: 'checkbox', label: 'Checkbox', icon: '☑', defaultProps: { className: 'flex items-center gap-2 text-sm', children: 'Remember me' } },
      { type: 'radio', label: 'Radio', icon: '◉', defaultProps: { className: 'flex items-center gap-2 text-sm', children: 'Monthly', name: 'choice' } },
      { type: 'switch', label: 'Switch', icon: '⏻', keywords: 'toggle', defaultProps: { className: 'flex items-center gap-2 text-sm', children: 'Email notifications' } },
      {
        type: 'form', label: 'Form', icon: '▦', keywords: 'validation fields submit',
        build: () => n('form', 'flex flex-col gap-4 max-w-md', undefined, [
          field('Full name', n('input', INPUT, undefined, [], { placeholder: 'Ada Lovelace', required: true })),
          field('Email', n('input', INPUT, undefined, [], { placeholder: 'ada@example.com', inputType: 'email', required: true })),
          field('Role', n('select', INPUT, undefined, [], { options: ['Engineer', 'Designer', 'Manager'] })),
          n('checkbox', 'flex items-center gap-2 text-sm', 'I agree to the terms'),
          n('flex', 'flex justify-end gap-2', undefined, [n('btn-outline', BTN_OUT, 'Cancel'), n('button', BTN, 'Save')]),
        ]),
      },
    ],
  },
  {
    id: 'data', label: 'Data', icon: '▦', items: [
      {
        type: 'stat', label: 'Stat', icon: '#', keywords: 'metric kpi',
        build: () => n('card', 'rounded-xl border border-border bg-card p-5 flex flex-col gap-1', undefined, [
          n('p', 'text-sm text-muted-foreground', 'Monthly revenue'),
          n('h3', 'text-2xl font-bold', '$48,210'),
          n('span', 'text-xs font-medium text-primary', '+12.4% vs last month'),
        ]),
      },
      {
        type: 'data-table', label: 'Table', icon: '▦', keywords: 'grid rows list data repeater',
        build: () => n('card', 'rounded-xl border border-border bg-card overflow-hidden', undefined, [
          n('grid', 'grid grid-cols-3 gap-4 px-4 py-2.5 bg-muted text-xs font-semibold uppercase tracking-wide text-muted-foreground', undefined, [
            n('span', '', 'Name'), n('span', '', 'Email'), n('span', '', 'Status'),
          ]),
          n('flex-col', 'flex flex-col divide-y divide-border', undefined, [
            n('grid', 'grid grid-cols-3 gap-4 px-4 py-3 text-sm', undefined, [
              n('span', 'font-medium', '{{name}}'), n('span', 'text-muted-foreground', '{{email}}'),
              n('badge', 'inline-flex w-fit items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium', '{{status}}'),
            ]),
          ], { 'data-repeater': true }),
        ]),
      },
      {
        type: 'list', label: 'List', icon: '☰', keywords: 'repeater items',
        build: () => n('flex-col', 'flex flex-col divide-y divide-border rounded-xl border border-border bg-card', undefined, [
          n('flex', 'flex items-center gap-3 px-4 py-3', undefined, [
            n('avatar', 'w-9 h-9 rounded-full bg-muted flex items-center justify-center text-xs font-semibold', 'AL'),
            n('flex-col', 'flex flex-col', undefined, [n('span', 'text-sm font-medium', '{{name}}'), n('span', 'text-xs text-muted-foreground', '{{email}}')]),
          ]),
        ], { 'data-repeater': true }),
      },
      {
        type: 'chart', label: 'Bar chart', icon: '▥', keywords: 'graph',
        build: () => n('card', 'rounded-xl border border-border bg-card p-5 flex flex-col gap-3', undefined, [
          n('h3', 'text-sm font-semibold', 'Weekly signups'),
          // Literal classes: Tailwind only emits what it can read in source.
          n('flex', 'flex items-end gap-2 h-32', undefined, ['h-[40%]', 'h-[65%]', 'h-[52%]', 'h-[80%]', 'h-[72%]', 'h-[95%]', 'h-[60%]'].map((h) => n('div', `flex-1 rounded-t-md bg-primary/80 ${h}`))),
        ]),
      },
      { type: 'badge', label: 'Badge', icon: '●', keywords: 'tag status', defaultProps: { className: 'inline-flex items-center rounded-full bg-primary/10 text-primary px-2.5 py-0.5 text-xs font-semibold', children: 'Active' } },
      { type: 'avatar', label: 'Avatar', icon: '◐', defaultProps: { className: 'w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground', children: 'AL' } },
      { type: 'progress-bar', label: 'Progress', icon: '▰', defaultProps: { className: 'h-2 w-full rounded-full bg-secondary overflow-hidden', 'data-value': '60' } },
    ],
  },
  {
    id: 'navigation', label: 'Navigation', icon: '↗', items: [
      {
        type: 'navbar', label: 'Navbar', icon: '☰', keywords: 'header top bar',
        build: () => n('nav', 'flex items-center justify-between h-16 px-6 border-b border-border bg-background', undefined, [
          n('span', 'text-lg font-bold', 'Acme'),
          n('flex', 'flex items-center gap-6', undefined, [n('link', 'text-sm text-muted-foreground hover:text-foreground cursor-pointer', 'Product'), n('link', 'text-sm text-muted-foreground hover:text-foreground cursor-pointer', 'Pricing'), n('button', BTN, 'Sign in')]),
        ]),
      },
      {
        type: 'sidebar', label: 'Sidebar', icon: '▌', keywords: 'side nav menu',
        build: () => n('sidebar', 'w-60 min-h-[480px] border-r border-border bg-card p-4 flex flex-col gap-1', undefined, [
          n('span', 'px-3 pb-3 text-base font-bold', 'Acme'),
          ...['Dashboard', 'Customers', 'Orders', 'Settings'].map((l, i) => n('menu-item', `flex items-center rounded-md px-3 py-2 text-sm ${i === 0 ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent'} cursor-pointer`, l)),
        ]),
      },
      {
        type: 'tabs', label: 'Tabs', icon: '▬',
        build: () => n('flex', 'flex gap-1 border-b border-border', undefined, ['Overview', 'Activity', 'Settings'].map((t, i) => n('tab-item', `px-4 py-2 text-sm font-medium border-b-2 ${i === 0 ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'} cursor-pointer`, t))),
      },
      {
        type: 'breadcrumb', label: 'Breadcrumb', icon: '›',
        build: () => n('flex', 'flex items-center gap-1.5 text-sm text-muted-foreground', undefined, [n('link', 'hover:text-foreground cursor-pointer', 'Home'), n('span', '', '/'), n('link', 'hover:text-foreground cursor-pointer', 'Customers'), n('span', '', '/'), n('span', 'text-foreground font-medium', 'Ada Lovelace')]),
      },
      {
        type: 'footer', label: 'Footer', icon: '▤',
        build: () => n('footer', 'border-t border-border px-6 py-8 flex items-center justify-between text-sm text-muted-foreground', undefined, [n('span', '', '© 2026 Acme'), n('flex', 'flex gap-4', undefined, [n('link', 'hover:text-foreground cursor-pointer', 'Privacy'), n('link', 'hover:text-foreground cursor-pointer', 'Terms')])]),
      },
    ],
  },
  {
    id: 'feedback', label: 'Feedback', icon: 'ℹ', items: [
      { type: 'alert', label: 'Alert', icon: 'ℹ', build: () => n('div', 'rounded-lg border border-primary/30 bg-primary/5 p-4 flex flex-col gap-1', undefined, [n('span', 'text-sm font-semibold', 'Heads up'), n('p', 'text-sm text-muted-foreground', 'Something worth knowing before you continue.')]) },
      { type: 'modal', label: 'Modal', icon: '◳', keywords: 'dialog popup overlay', build: () => modalNode() },
      { type: 'toast', label: 'Toast', icon: '◪', keywords: 'notification snackbar', build: () => n('flex', 'flex items-start gap-3 w-80 rounded-lg border border-border bg-card p-4 shadow-lg', undefined, [n('span', 'text-primary', '✓'), n('flex-col', 'flex flex-col', undefined, [n('span', 'text-sm font-semibold', 'Saved'), n('span', 'text-xs text-muted-foreground', 'Your changes are live.')])]) },
      { type: 'empty-state', label: 'Empty state', icon: '∅', build: () => n('flex-col', 'flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-12 text-center', undefined, [n('h3', 'font-semibold', 'Nothing here yet'), n('p', 'text-sm text-muted-foreground', 'Create your first item to get started.'), n('button', BTN, 'Create')]) },
      { type: 'skeleton-text', label: 'Skeleton', icon: '░', defaultProps: { className: 'h-4 w-3/4 rounded bg-muted animate-pulse' } },
    ],
  },
  {
    id: 'media', label: 'Media', icon: '◻', items: [
      { type: 'img-placeholder', label: 'Image', icon: '◻', defaultProps: { className: 'aspect-video w-full rounded-lg bg-muted flex items-center justify-center text-muted-foreground text-sm', children: 'Image' } },
      { type: 'video', label: 'Video', icon: '▶', build: () => n('img-placeholder', 'aspect-video w-full rounded-lg bg-foreground/90 flex items-center justify-center text-background text-3xl', '▶') },
      { type: 'icon-placeholder', label: 'Icon', icon: '★', defaultProps: { className: 'w-6 h-6 text-primary', children: '★' } },
    ],
  },
];

/** Search blueprints by label, type or keywords. */
export function searchBlueprints(cats: BlueprintCategory[], query: string): BlueprintCategory[] {
  const q = query.trim().toLowerCase();
  if (!q) return cats;
  return cats
    .map((c) => ({ ...c, items: c.items.filter((i) => `${i.label} ${i.type} ${i.keywords ?? ''}`.toLowerCase().includes(q)) }))
    .filter((c) => c.items.length > 0);
}

export function findBlueprint(type: string): Blueprint | undefined {
  for (const c of BLUEPRINTS) {
    const hit = c.items.find((i) => i.type === type);
    if (hit) return hit;
  }
  return undefined;
}

/** A fresh node for a blueprint (composite subtree, or a single styled node). */
export function instantiate(bp: Blueprint): CanvasNode {
  if (bp.build) return bp.build();
  return { id: genId(), type: bp.type, props: { ...(bp.defaultProps ?? {}) }, children: [], style: {} };
}
