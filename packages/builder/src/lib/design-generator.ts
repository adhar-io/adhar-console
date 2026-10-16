// Multi-variant design generator.
// Given a prompt, returns 3 design variants (different visual styles)
// with realistic content populated from the content library.

import type { CanvasNode, DesignVariant } from './builder-types.ts';
import { genId } from './builder-types.ts';
import { CONTENT, STYLE_PRESETS, pick, type StyleKey } from './design-content.ts';

// ─── Node builder helpers ────────────────────────────────────────────────────
type N = CanvasNode;
const node = (type: string, className: string, children: N[] = [], extra: Record<string, any> = {}): N => ({
  id: genId(),
  type,
  props: { className, ...extra },
  children,
  style: {},
});
const text = (type: string, className: string, children: string, extra: Record<string, unknown> = {}): N => ({
  id: genId(),
  type,
  props: { className, children, ...extra },
  children: [],
  style: {},
});

// ─── Category detection ──────────────────────────────────────────────────────
export type DesignCategory =
  | 'saas-landing' | 'ecommerce' | 'dashboard' | 'portfolio'
  | 'blog' | 'app-shell' | 'pricing' | 'auth' | 'generic';

export function detectCategory(prompt: string): DesignCategory {
  const p = prompt.toLowerCase();
  if (/pricing|tier|subscribe|plan/.test(p)) return 'pricing';
  if (/sign ?in|log ?in|sign ?up|auth|password/.test(p)) return 'auth';
  if (/dashboard|admin|analytic|metric|kpi|stats/.test(p)) return 'dashboard';
  if (/shop|store|ecommerce|e-commerce|product|retail/.test(p)) return 'ecommerce';
  if (/portfolio|personal site|about me/.test(p)) return 'portfolio';
  if (/blog|article|publication|cms|news/.test(p)) return 'blog';
  if (/app shell|sidebar|workspace/.test(p)) return 'app-shell';
  if (/saas|landing|hero|marketing/.test(p)) return 'saas-landing';
  return 'generic';
}

// ─── Nav bar (shared across variants) ────────────────────────────────────────
function navBar(style: StyleKey, brandName: string, navItems: string[]): N {
  const s = STYLE_PRESETS[style];
  const isEditorial = style === 'editorial';
  return node('nav', `flex items-center justify-between px-8 py-5 border-b border-border/60 ${style === 'bold' ? 'border-foreground' : ''}`, [
    text('span', `${isEditorial ? 'font-serif text-2xl' : 'text-xl font-bold'} tracking-tight`, brandName),
    node('flex', 'flex items-center gap-7', [
      ...navItems.map((n) => text('span', 'text-sm text-muted-foreground hover:text-foreground cursor-pointer transition-colors', n)),
      text('button', s.buttonSecondary + ' !py-2 !px-4 !text-sm', 'Sign in'),
      text('button', s.button + ' !py-2 !px-4 !text-sm', 'Get started'),
    ]),
  ]);
}

// ─── 1. SaaS LANDING PAGE ────────────────────────────────────────────────────
function saasLanding(style: StyleKey, opts: { brand: string; headline: string; subhead: string; offset: number }): N[] {
  const s = STYLE_PRESETS[style];
  const features = pick(CONTENT.features, 3, opts.offset);
  const testimonials = pick(CONTENT.testimonials, 2, opts.offset);
  const pricing = CONTENT.pricing;

  return [
    // Nav
    navBar(style, opts.brand, ['Product', 'Customers', 'Pricing', 'Docs']),

    // Hero
    node('section', `${s.section} flex flex-col items-center text-center gap-6 max-w-5xl mx-auto`, [
      text('span', s.accent, '✨ New — AI-assisted templates'),
      text('h1', s.heading, opts.headline),
      text('p', `${s.subheading} max-w-2xl`, opts.subhead),
      node('flex', 'flex items-center gap-3 mt-2', [
        text('button', s.button, 'Start free trial'),
        text('button', s.buttonSecondary, 'Book a demo'),
      ]),
      node('flex', 'flex items-center gap-6 mt-8 opacity-60', [
        text('span', 'text-xs uppercase tracking-widest text-muted-foreground', 'Trusted by'),
        ...['Linear', 'Vercel', 'Retool', 'Framer', 'Figma'].map((b) => text('span', 'text-sm font-semibold text-muted-foreground', b)),
      ]),
    ]),

    // Features
    node('section', `${s.section} max-w-6xl mx-auto`, [
      node('flex-col', 'flex flex-col items-center text-center gap-3 mb-14', [
        text('span', s.accent, 'FEATURES'),
        text('h2', `${style === 'bold' ? 'text-5xl font-black uppercase' : style === 'editorial' ? 'font-serif text-4xl' : 'text-4xl font-semibold'} tracking-tight`, 'Everything you need. Nothing you don\'t.'),
        text('p', `${s.subheading} max-w-2xl`, 'A thoughtfully curated feature set, not a bloated product.'),
      ]),
      node('grid', 'grid grid-cols-3 gap-6', features.map((f) => (
        node('card', `${s.card} p-7 flex flex-col gap-3`, [
          text('div', `w-11 h-11 ${s.radius} bg-primary/10 flex items-center justify-center text-xl`, f.icon),
          text('h3', 'text-lg font-semibold', f.title),
          text('p', 'text-sm text-muted-foreground leading-relaxed', f.desc),
        ])
      ))),
    ]),

    // Testimonials
    node('section', `${s.section} bg-muted/30 max-w-6xl mx-auto ${s.radiusLg}`, [
      node('grid', 'grid grid-cols-2 gap-8', testimonials.map((t) => (
        node('card', `${s.card} p-8 flex flex-col gap-5`, [
          text('p', `${style === 'editorial' ? 'font-serif italic' : 'font-medium'} text-xl leading-relaxed`, `"${t.quote}"`),
          node('flex', 'flex items-center gap-3', [
            text('div', 'w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center font-bold text-primary text-sm', t.author.split(' ').map((n) => n[0]).join('')),
            node('flex-col', 'flex flex-col', [
              text('span', 'text-sm font-semibold', t.author),
              text('span', 'text-xs text-muted-foreground', t.role),
            ]),
          ]),
        ])
      ))),
    ]),

    // Pricing preview
    node('section', `${s.section} max-w-6xl mx-auto`, [
      node('flex-col', 'flex flex-col items-center text-center gap-3 mb-12', [
        text('h2', `${style === 'bold' ? 'text-5xl font-black uppercase' : style === 'editorial' ? 'font-serif text-4xl' : 'text-4xl font-semibold'} tracking-tight`, 'Pricing that scales with you'),
      ]),
      node('grid', 'grid grid-cols-3 gap-5', pricing.map((tier) => (
        node('card', `${s.card} p-7 flex flex-col gap-5 ${tier.popular ? 'ring-2 ring-primary relative' : ''}`, [
          ...(tier.popular ? [text('span', 'absolute -top-3 left-7 px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold', 'Most popular')] : []),
          node('flex-col', 'flex flex-col gap-1', [
            text('h3', 'text-sm font-semibold text-muted-foreground uppercase tracking-wide', tier.name),
            node('flex', 'flex items-baseline gap-1', [
              text('span', 'text-4xl font-bold tracking-tight', tier.price),
              text('span', 'text-sm text-muted-foreground', tier.period),
            ]),
            text('p', 'text-sm text-muted-foreground', tier.desc),
          ]),
          node('flex-col', 'flex flex-col gap-2 py-3 border-y border-border/50', tier.features.map((f) => (
            node('flex', 'flex items-center gap-2 text-sm', [
              text('span', 'text-primary', '✓'),
              text('span', 'text-foreground/80', f),
            ])
          ))),
          text('button', tier.popular ? s.button : s.buttonSecondary, tier.cta),
        ])
      ))),
    ]),

    // CTA
    node('section', `${s.section} text-center max-w-3xl mx-auto flex flex-col gap-5 items-center`, [
      text('h2', `${style === 'bold' ? 'text-5xl font-black uppercase' : style === 'editorial' ? 'font-serif text-4xl' : 'text-4xl font-semibold'} tracking-tight`, 'Ready to ship faster?'),
      text('p', s.subheading, 'Join thousands of teams already building with us.'),
      node('flex', 'flex gap-3', [
        text('button', s.button, 'Start for free'),
        text('button', s.buttonSecondary, 'Talk to sales'),
      ]),
    ]),
  ];
}

// ─── 2. E-COMMERCE STOREFRONT ────────────────────────────────────────────────
function ecommerce(style: StyleKey, opts: { brand: string; offset: number }): N[] {
  const s = STYLE_PRESETS[style];
  const names = pick(CONTENT.productNames, 8, opts.offset);
  const prices = pick(CONTENT.productPrices, 8, opts.offset);
  const images = pick(CONTENT.productImages, 8, opts.offset);
  const isEditorial = style === 'editorial';

  return [
    navBar(style, opts.brand, ['Shop', 'New arrivals', 'Collections', 'Journal']),

    // Editorial hero
    node('section', `${s.section} max-w-7xl mx-auto`, [
      node('grid', 'grid grid-cols-2 gap-10 items-center', [
        node('flex-col', 'flex flex-col gap-6', [
          text('span', s.accent, 'Spring 2026'),
          text('h1', s.heading, isEditorial ? 'The season of quiet confidence.' : 'New arrivals for how you actually dress.'),
          text('p', `${s.subheading} max-w-md`, 'Twelve new pieces this season. Made slowly, in small runs, from materials we\'d wear ourselves.'),
          node('flex', 'flex gap-3', [
            text('button', s.button, 'Shop the collection'),
            text('button', s.buttonSecondary, 'Read the story'),
          ]),
        ]),
        node('div', `${s.radiusLg} aspect-[4/5] bg-gradient-to-br from-stone-200 to-stone-300 dark:from-stone-700 dark:to-stone-800 flex items-center justify-center text-7xl`, [
          text('span', '', images[0]),
        ]),
      ]),
    ]),

    // Product grid
    node('section', `${s.section} max-w-7xl mx-auto`, [
      node('flex', 'flex items-baseline justify-between mb-10', [
        text('h2', `${isEditorial ? 'font-serif text-4xl' : 'text-3xl font-semibold'} tracking-tight`, 'Featured'),
        text('a', 'text-sm text-muted-foreground hover:text-foreground transition-colors', 'View all →'),
      ]),
      node('grid', 'grid grid-cols-4 gap-6', names.slice(0, 8).map((name, i) => (
        node('card', 'group cursor-pointer flex flex-col gap-3', [
          text('div', `${s.radiusLg} aspect-square bg-gradient-to-br from-stone-100 to-stone-200 dark:from-stone-800 dark:to-stone-900 flex items-center justify-center text-5xl group-hover:scale-[1.02] transition-transform overflow-hidden`, images[i]),
          node('flex-col', 'flex flex-col gap-0.5', [
            text('h3', 'text-sm font-medium', name),
            text('span', 'text-sm text-muted-foreground', prices[i]),
          ]),
        ])
      ))),
    ]),

    // Categories
    node('section', `${s.section} max-w-7xl mx-auto`, [
      text('h2', `${isEditorial ? 'font-serif text-4xl' : 'text-3xl font-semibold'} tracking-tight mb-10`, 'Shop by category'),
      node('grid', 'grid grid-cols-3 gap-5', [
        { name: 'Outerwear', count: '24 items', emoji: '🧥' },
        { name: 'Knitwear', count: '18 items', emoji: '🧶' },
        { name: 'Accessories', count: '32 items', emoji: '🎒' },
      ].map((cat) => (
        node('card', `${s.card} p-0 overflow-hidden aspect-[4/3] flex flex-col justify-end p-6 bg-gradient-to-br from-stone-100 to-stone-200 dark:from-stone-800 dark:to-stone-900 cursor-pointer group`, [
          text('span', 'text-5xl mb-auto', cat.emoji),
          text('h3', 'text-xl font-semibold', cat.name),
          text('span', 'text-sm text-muted-foreground', `${cat.count} · Shop →`),
        ])
      ))),
    ]),
  ];
}

// ─── 3. DASHBOARD ────────────────────────────────────────────────────────────
function dashboard(style: StyleKey, opts: { brand: string; offset: number }): N[] {
  const s = STYLE_PRESETS[style];
  const stats = CONTENT.stats;
  const team = pick(CONTENT.teamMembers, 4, opts.offset);
  const tasks = pick(CONTENT.tasks, 4, opts.offset);

  return [
    // Top bar
    node('nav', `flex items-center justify-between px-6 py-3 border-b border-border`, [
      node('flex', 'flex items-center gap-4', [
        text('span', 'text-lg font-bold tracking-tight', opts.brand),
        text('span', 'text-xs text-muted-foreground px-2 py-0.5 rounded-md bg-muted', 'Production'),
      ]),
      node('flex', 'flex items-center gap-3', [
        text('input', `${s.radius} px-3 py-1.5 text-sm border border-border bg-background w-64`, ''),
        text('button', s.buttonSecondary + ' !py-1.5 !px-3 !text-xs', '🔔'),
        text('div', 'w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center text-sm font-bold text-primary', 'PM'),
      ]),
    ]),

    // Page content
    node('div', 'flex-1 px-8 py-6 flex flex-col gap-6', [
      node('flex', 'flex items-baseline justify-between', [
        node('flex-col', 'flex flex-col gap-1', [
          text('h1', 'text-2xl font-semibold tracking-tight', 'Good morning, Priya'),
          text('p', 'text-sm text-muted-foreground', 'Here\'s what\'s happening across your projects today.'),
        ]),
        node('flex', 'flex items-center gap-2', [
          text('button', s.buttonSecondary + ' !py-1.5 !px-3 !text-xs', 'Last 30 days ▼'),
          text('button', s.button + ' !py-1.5 !px-3 !text-xs', '+ New project'),
        ]),
      ]),

      // KPI Cards
      node('grid', 'grid grid-cols-4 gap-4', stats.map((st) => (
        node('card', `${s.card} p-5 flex flex-col gap-2`, [
          text('span', 'text-xs text-muted-foreground font-medium', st.label),
          text('h3', 'text-2xl font-bold tracking-tight', st.value),
          node('flex', 'flex items-center gap-1.5', [
            text('span', `text-xs font-medium ${st.trend === 'up' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`, `${st.trend === 'up' ? '↑' : '↓'} ${st.change}`),
            text('span', 'text-xs text-muted-foreground', 'vs last month'),
          ]),
        ])
      ))),

      // Two-column: chart + activity
      node('grid', 'grid grid-cols-3 gap-4', [
        node('card', `${s.card} p-6 col-span-2`, [
          node('flex', 'flex items-center justify-between mb-5', [
            text('h3', 'text-sm font-semibold', 'Revenue'),
            node('flex', 'flex items-center gap-1 text-xs', [
              text('span', 'px-2 py-0.5 rounded-md bg-primary/10 text-primary', 'Week'),
              text('span', 'px-2 py-0.5 rounded-md hover:bg-muted text-muted-foreground cursor-pointer', 'Month'),
              text('span', 'px-2 py-0.5 rounded-md hover:bg-muted text-muted-foreground cursor-pointer', 'Year'),
            ]),
          ]),
          // Fake chart — horizontal bars
          node('flex-col', 'flex flex-col gap-2.5', [
            { l: 'Mon', v: 65 }, { l: 'Tue', v: 82 }, { l: 'Wed', v: 71 },
            { l: 'Thu', v: 94 }, { l: 'Fri', v: 88 }, { l: 'Sat', v: 45 }, { l: 'Sun', v: 52 },
          ].map((d) => (
            node('flex', 'flex items-center gap-3', [
              text('span', 'text-xs text-muted-foreground w-8', d.l),
              node('div', 'flex-1 h-6 rounded bg-muted/40 relative overflow-hidden', [
                node('div', `h-full ${s.radius} bg-primary`, [], { style: `width:${d.v}%` }),
              ]),
              text('span', 'text-xs font-mono text-muted-foreground w-12 text-right', `$${(d.v * 120).toLocaleString()}`),
            ])
          ))),
        ]),
        node('card', `${s.card} p-6`, [
          text('h3', 'text-sm font-semibold mb-4', 'Team activity'),
          node('flex-col', 'flex flex-col gap-4', team.map((m) => (
            node('flex', 'flex items-start gap-3', [
              text('div', 'w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center text-xs font-bold text-primary shrink-0', m.name.split(' ').map((n) => n[0]).join('')),
              node('flex-col', 'flex flex-col gap-0.5 flex-1 min-w-0', [
                text('span', 'text-xs font-medium truncate', m.name),
                text('span', 'text-xs text-muted-foreground', m.role),
              ]),
              text('span', `text-[10px] px-1.5 py-0.5 rounded-full ${m.status === 'active' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`, m.status),
            ])
          ))),
        ]),
      ]),

      // Tasks
      node('card', `${s.card} overflow-hidden`, [
        node('flex', 'flex items-center justify-between px-6 py-4 border-b border-border', [
          text('h3', 'text-sm font-semibold', 'My tasks'),
          text('button', 'text-xs text-primary hover:underline', 'View all →'),
        ]),
        node('flex-col', 'flex flex-col', tasks.map((t) => (
          node('flex', 'flex items-center gap-4 px-6 py-3 border-b border-border last:border-0 hover:bg-accent/30 transition-colors', [
            text('div', `w-4 h-4 ${s.radius} border-2 ${t.status === 'done' ? 'bg-primary border-primary' : 'border-border'} shrink-0`, ''),
            node('flex-col', 'flex flex-col gap-0.5 flex-1 min-w-0', [
              text('span', `text-sm ${t.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'} font-medium truncate`, t.title),
              text('span', 'text-xs text-muted-foreground', `${t.assignee} · Due ${t.due}`),
            ]),
            text('span', `text-[10px] px-2 py-0.5 rounded-full font-medium ${
              t.priority === 'critical' ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' :
              t.priority === 'high' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
              t.priority === 'medium' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' :
              'bg-muted text-muted-foreground'
            }`, t.priority),
          ])
        ))),
      ]),
    ]),
  ];
}

// ─── 4. PORTFOLIO ────────────────────────────────────────────────────────────
function portfolio(style: StyleKey, opts: { brand: string; offset: number }): N[] {
  const s = STYLE_PRESETS[style];
  const isEditorial = style === 'editorial';
  return [
    navBar(style, opts.brand, ['Work', 'About', 'Writing', 'Contact']),
    node('section', `${s.section} max-w-4xl mx-auto flex flex-col gap-6`, [
      text('span', s.accent, 'DESIGNER · WRITER · ENGINEER'),
      text('h1', s.heading, 'I design software that feels obvious in hindsight.'),
      text('p', `${s.subheading} max-w-2xl`, 'Fifteen years building product for teams from seed to IPO. Currently designing systems at Meridian. Previously Linear, Vercel, and a handful of places you\'ve never heard of.'),
      node('flex', 'flex gap-3 mt-4', [
        text('button', s.button, 'See my work'),
        text('button', s.buttonSecondary, 'Get in touch'),
      ]),
    ]),
    node('section', `${s.section} max-w-5xl mx-auto`, [
      text('h2', `${isEditorial ? 'font-serif text-3xl' : 'text-2xl font-semibold'} tracking-tight mb-10`, 'Selected work'),
      node('flex-col', 'flex flex-col gap-8', [
        { year: '2026', title: 'Meridian — design systems at scale', desc: 'Led the design system rebuild that cut time-to-ship by 40% across 6 product teams.', tags: ['Design Systems', 'Strategy'] },
        { year: '2024', title: 'Linear — the issue view, rethought', desc: 'Redesigned the core canvas that millions of users interact with daily. A two-year effort.', tags: ['Product Design', 'Interaction'] },
        { year: '2022', title: 'Vercel — the onboarding funnel', desc: 'Shipped the activation flow that took first-deploy from 18 minutes to under 4.', tags: ['Onboarding', 'Growth'] },
      ].map((p) => (
        node('card', `${s.card} p-8 flex gap-8 group cursor-pointer hover:border-primary/40 transition-colors`, [
          text('span', 'text-xs text-muted-foreground font-mono w-16 shrink-0 pt-1', p.year),
          node('flex-col', 'flex flex-col gap-2 flex-1', [
            text('h3', 'text-xl font-semibold group-hover:text-primary transition-colors', p.title),
            text('p', 'text-sm text-muted-foreground leading-relaxed', p.desc),
            node('flex', 'flex gap-2 mt-2', p.tags.map((t) => (
              text('span', 'text-[10px] px-2 py-0.5 rounded-md bg-muted text-muted-foreground font-medium', t)
            ))),
          ]),
          text('span', 'text-muted-foreground group-hover:text-primary transition-colors self-center text-xl', '→'),
        ])
      ))),
    ]),
  ];
}

// ─── 5. BLOG ─────────────────────────────────────────────────────────────────
function blog(style: StyleKey, opts: { brand: string; offset: number }): N[] {
  const s = STYLE_PRESETS[style];
  const posts = pick(CONTENT.blogPosts, 3, opts.offset);
  const isEditorial = style === 'editorial';
  return [
    navBar(style, opts.brand, ['Engineering', 'Design', 'Product', 'Careers']),
    node('section', `${s.section} max-w-5xl mx-auto`, [
      text('span', s.accent, 'FEATURED'),
      text('h1', `${s.heading} mt-3 mb-4 cursor-pointer hover:text-primary transition-colors`, posts[0].title),
      text('p', `${s.subheading} max-w-3xl mb-6`, posts[0].excerpt),
      node('flex', 'flex items-center gap-3 text-sm text-muted-foreground', [
        text('div', 'w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center text-[10px] font-bold text-primary', posts[0].author.split(' ').map((n) => n[0]).join('')),
        text('span', '', posts[0].author),
        text('span', '', '·'),
        text('span', '', posts[0].date),
        text('span', '', '·'),
        text('span', '', posts[0].readTime + ' read'),
      ]),
    ]),
    node('section', `${s.section} max-w-6xl mx-auto`, [
      text('h2', `${isEditorial ? 'font-serif text-3xl' : 'text-2xl font-semibold'} tracking-tight mb-8`, 'Recent articles'),
      node('grid', 'grid grid-cols-3 gap-6', posts.map((p) => (
        node('card', `${s.card} overflow-hidden group cursor-pointer`, [
          text('div', 'aspect-video bg-gradient-to-br from-primary/10 via-primary/5 to-transparent', ''),
          node('div', 'p-5 flex flex-col gap-2', [
            text('span', s.accent, p.tag),
            text('h3', 'text-lg font-semibold leading-snug group-hover:text-primary transition-colors', p.title),
            text('p', 'text-sm text-muted-foreground leading-relaxed line-clamp-2', p.excerpt),
            node('flex', 'flex items-center gap-2 text-xs text-muted-foreground mt-2 pt-3 border-t border-border', [
              text('span', '', p.author),
              text('span', '', '·'),
              text('span', '', p.readTime),
            ]),
          ]),
        ])
      ))),
    ]),
  ];
}

// ─── 6. APP SHELL ────────────────────────────────────────────────────────────
function appShell(style: StyleKey, opts: { brand: string }): N[] {
  const s = STYLE_PRESETS[style];
  return [
    node('flex', 'flex h-full', [
      // Sidebar
      node('div', 'w-60 border-r border-border flex flex-col bg-card/50', [
        node('flex', 'flex items-center gap-2 px-4 py-4 border-b border-border', [
          text('div', 'w-7 h-7 rounded-lg bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold', opts.brand[0]),
          text('span', 'text-sm font-semibold', opts.brand),
        ]),
        node('flex-col', 'flex flex-col gap-0.5 p-2 flex-1', [
          { label: 'Home', icon: '🏠', active: true },
          { label: 'Projects', icon: '📁', active: false },
          { label: 'Team', icon: '👥', active: false },
          { label: 'Analytics', icon: '📊', active: false },
          { label: 'Integrations', icon: '🔌', active: false },
          { label: 'Settings', icon: '⚙', active: false },
        ].map((item) => (
          node('flex', `flex items-center gap-3 px-3 py-2 ${s.radius} ${item.active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'} cursor-pointer text-sm transition-colors`, [
            text('span', 'text-sm', item.icon),
            text('span', '', item.label),
          ])
        ))),
        node('div', 'p-3 border-t border-border', [
          node('flex', 'flex items-center gap-2 px-2 py-2', [
            text('div', 'w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center text-[10px] font-bold text-primary', 'PM'),
            node('flex-col', 'flex flex-col gap-0 flex-1 min-w-0', [
              text('span', 'text-xs font-medium truncate', 'Priya Menon'),
              text('span', 'text-[10px] text-muted-foreground truncate', 'priya@meridian.co'),
            ]),
          ]),
        ]),
      ]),

      // Main
      node('flex-col', 'flex flex-col flex-1', [
        node('nav', 'flex items-center justify-between px-6 py-3 border-b border-border', [
          text('h1', 'text-sm font-semibold', 'Home'),
          text('button', s.button + ' !py-1.5 !px-3 !text-xs', '+ New'),
        ]),
        node('div', 'flex-1 p-6', [
          text('p', 'text-sm text-muted-foreground', 'Main content area — start dropping components here, or prompt the AI to fill it in.'),
        ]),
      ]),
    ]),
  ];
}

// ─── 7. PRICING (standalone) ─────────────────────────────────────────────────
function pricing(style: StyleKey, opts: { brand: string }): N[] {
  const s = STYLE_PRESETS[style];
  const tiers = CONTENT.pricing;
  return [
    navBar(style, opts.brand, ['Product', 'Pricing', 'Customers', 'Docs']),
    node('section', `${s.section} max-w-6xl mx-auto flex flex-col items-center text-center gap-5`, [
      text('span', s.accent, 'PRICING'),
      text('h1', s.heading, 'Simple, transparent pricing.'),
      text('p', s.subheading, 'No hidden fees. Cancel anytime. Start free.'),
    ]),
    node('section', `px-8 pb-24 max-w-6xl mx-auto`, [
      node('grid', 'grid grid-cols-3 gap-5', tiers.map((tier) => (
        node('card', `${s.card} p-8 flex flex-col gap-6 ${tier.popular ? 'ring-2 ring-primary relative' : ''}`, [
          ...(tier.popular ? [text('span', 'absolute -top-3 left-8 px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold', 'Most popular')] : []),
          node('flex-col', 'flex flex-col gap-2', [
            text('h3', 'text-base font-semibold text-muted-foreground uppercase tracking-wide', tier.name),
            node('flex', 'flex items-baseline gap-1', [
              text('span', 'text-5xl font-bold tracking-tight', tier.price),
              text('span', 'text-base text-muted-foreground', tier.period),
            ]),
            text('p', 'text-sm text-muted-foreground', tier.desc),
          ]),
          node('flex-col', 'flex flex-col gap-3 py-4 border-y border-border/50', tier.features.map((f) => (
            node('flex', 'flex items-center gap-2 text-sm', [
              text('span', 'text-primary', '✓'),
              text('span', 'text-foreground/80', f),
            ])
          ))),
          text('button', tier.popular ? s.button + ' w-full' : s.buttonSecondary + ' w-full', tier.cta),
        ])
      ))),
    ]),
  ];
}

// ─── 8. AUTH ─────────────────────────────────────────────────────────────────
function auth(style: StyleKey, opts: { brand: string }): N[] {
  const s = STYLE_PRESETS[style];
  return [
    node('section', 'flex-1 flex items-center justify-center py-16 px-6', [
      node('card', `${s.card} p-8 w-full max-w-md flex flex-col gap-5`, [
        node('flex-col', 'flex flex-col items-center gap-3 mb-2', [
          text('div', 'w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center text-base font-bold', opts.brand[0]),
          text('h1', 'text-2xl font-semibold tracking-tight', 'Welcome back'),
          text('p', 'text-sm text-muted-foreground', 'Sign in to your account to continue'),
        ]),
        node('flex-col', 'flex flex-col gap-2', [
          text('button', s.buttonSecondary + ' w-full justify-center flex items-center gap-2', '🅖  Continue with Google'),
          text('button', s.buttonSecondary + ' w-full justify-center flex items-center gap-2', '🐙  Continue with GitHub'),
        ]),
        node('flex', 'flex items-center gap-3 my-1', [
          node('div', 'h-px flex-1 bg-border', []),
          text('span', 'text-xs text-muted-foreground', 'or'),
          node('div', 'h-px flex-1 bg-border', []),
        ]),
        node('flex-col', 'flex flex-col gap-3', [
          node('flex-col', 'flex flex-col gap-1.5', [
            text('label', 'text-xs font-medium text-muted-foreground', 'Email'),
            text('input', `${s.radius} px-3 py-2.5 text-sm border border-border bg-background`, '', { placeholder: 'you@company.com' }),
          ]),
          node('flex-col', 'flex flex-col gap-1.5', [
            node('flex', 'flex items-center justify-between', [
              text('label', 'text-xs font-medium text-muted-foreground', 'Password'),
              text('a', 'text-xs text-primary hover:underline', 'Forgot?'),
            ]),
            text('input', `${s.radius} px-3 py-2.5 text-sm border border-border bg-background`, '', { placeholder: '••••••••', type: 'password' }),
          ]),
        ]),
        text('button', s.button + ' w-full', 'Sign in'),
        text('p', 'text-xs text-center text-muted-foreground', 'Don\'t have an account? Sign up'),
      ]),
    ]),
  ];
}

// ─── 9. GENERIC ──────────────────────────────────────────────────────────────
function generic(style: StyleKey, opts: { prompt: string; brand: string }): N[] {
  const s = STYLE_PRESETS[style];
  return [
    navBar(style, opts.brand, ['Home', 'About', 'Contact']),
    node('section', `${s.section} max-w-4xl mx-auto flex flex-col items-center text-center gap-5`, [
      text('span', s.accent, 'NEW'),
      text('h1', s.heading, 'Your idea, built for you.'),
      text('p', s.subheading, opts.prompt.slice(0, 160) + (opts.prompt.length > 160 ? '…' : '')),
      node('flex', 'flex gap-3 mt-3', [
        text('button', s.button, 'Get started'),
        text('button', s.buttonSecondary, 'Learn more'),
      ]),
    ]),
  ];
}

// ─── Category dispatcher ─────────────────────────────────────────────────────
function buildCategory(cat: DesignCategory, style: StyleKey, opts: { brand: string; headline: string; subhead: string; offset: number; prompt: string }): N[] {
  switch (cat) {
    case 'saas-landing': return saasLanding(style, opts);
    case 'ecommerce': return ecommerce(style, opts);
    case 'dashboard': return dashboard(style, opts);
    case 'portfolio': return portfolio(style, opts);
    case 'blog': return blog(style, opts);
    case 'app-shell': return appShell(style, opts);
    case 'pricing': return pricing(style, opts);
    case 'auth': return auth(style, opts);
    default: return generic(style, { prompt: opts.prompt, brand: opts.brand });
  }
}

// ─── Public: generate a set of variants ──────────────────────────────────────
// Returns 3 variants with different style presets for the same prompt.
export function generateVariants(prompt: string, styleKeys?: StyleKey[]): DesignVariant[] {
  const cat = detectCategory(prompt);
  const styles = styleKeys && styleKeys.length > 0 ? styleKeys : defaultStyleSet(cat);
  const brand = pick(CONTENT.brands, 1, Math.floor(Math.random() * CONTENT.brands.length))[0];
  const headline = pick(CONTENT.headlines, 1, Math.floor(Math.random() * CONTENT.headlines.length))[0];
  const subhead = pick(CONTENT.subheads, 1, Math.floor(Math.random() * CONTENT.subheads.length))[0];
  const now = Date.now();

  return styles.map((style, i) => ({
    id: `v_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    label: STYLE_PRESETS[style].label,
    style,
    prompt,
    timestamp: now,
    nodes: buildCategory(cat, style, { brand, headline, subhead, offset: i * 2, prompt }),
  }));
}

// Pick a flattering 3-style set based on category.
function defaultStyleSet(cat: DesignCategory): StyleKey[] {
  switch (cat) {
    case 'saas-landing': return ['modern', 'bold', 'minimal'];
    case 'ecommerce': return ['editorial', 'modern', 'minimal'];
    case 'dashboard': return ['enterprise', 'modern', 'minimal'];
    case 'portfolio': return ['editorial', 'minimal', 'modern'];
    case 'blog': return ['editorial', 'modern', 'minimal'];
    case 'app-shell': return ['modern', 'enterprise', 'minimal'];
    case 'pricing': return ['modern', 'bold', 'minimal'];
    case 'auth': return ['modern', 'minimal', 'playful'];
    default: return ['modern', 'minimal', 'bold'];
  }
}

// Generate a single variant for a specific style
export function generateSingleVariant(prompt: string, style: StyleKey): DesignVariant {
  return generateVariants(prompt, [style])[0];
}
