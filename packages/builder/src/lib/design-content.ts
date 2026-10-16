// Realistic content library for generated designs.
// These are curated to feel real — proper names, prices, copy — not "Product 1".

export const CONTENT = {
  brands: ['Northwind', 'Meridian', 'Stellar', 'Vantage', 'Parallel', 'Lumen', 'Orbit', 'Koru', 'Atlas', 'Folio'],
  productNames: [
    'Linen Overshirt', 'Wool Blazer', 'Cashmere Sweater', 'Leather Belt',
    'Suede Loafers', 'Canvas Tote', 'Selvedge Denim', 'Merino Scarf',
    'Oxford Shirt', 'Waxed Jacket', 'Chelsea Boots', 'Knit Cardigan',
  ],
  productPrices: ['$78', '$124', '$210', '$89', '$156', '$45', '$198', '$67', '$112', '$245'],
  productImages: ['🧥', '👔', '🧶', '👖', '👞', '🎒', '🧢', '🧤', '🕶', '👟', '⌚', '💼'],
  headlines: [
    'Designed for how you actually work.',
    'Software that respects your attention.',
    'Everything you need. Nothing you don\'t.',
    'Made for teams that ship.',
    'Your next favorite tool is here.',
    'Beautifully simple. Quietly powerful.',
  ],
  subheads: [
    'Join 12,000+ teams building faster with a single source of truth.',
    'Stop juggling six tabs. Start shipping in one place.',
    'Get from idea to production in minutes, not weeks.',
    'Trusted by companies from seed to IPO.',
  ],
  features: [
    { title: 'Real-time collaboration', desc: 'Multiplayer cursors, live edits, zero merge conflicts.', icon: '👥' },
    { title: 'Built-in analytics', desc: 'Track what matters without piping data to yet another tool.', icon: '📊' },
    { title: 'Ship-ready exports', desc: 'Production code the moment your design feels right.', icon: '🚀' },
    { title: 'Version history', desc: 'Infinite undo across your whole team. Never lose work.', icon: '⏮' },
    { title: 'Smart AI assist', desc: 'Generate, refine, and translate with context-aware AI.', icon: '✨' },
    { title: 'Enterprise-grade security', desc: 'SOC 2, SSO, audit logs, and granular permissions.', icon: '🔒' },
  ],
  testimonials: [
    { quote: 'It replaced three tools on our stack and we haven\'t looked back.', author: 'Priya Menon', role: 'Head of Product, Linear' },
    { quote: 'Finally, design and engineering speaking the same language.', author: 'Marcus Chen', role: 'Staff Engineer, Vercel' },
    { quote: 'We cut our design-to-ship cycle in half. This is the tool.', author: 'Sofia Reyes', role: 'Design Lead, Retool' },
  ],
  pricing: [
    { name: 'Starter', price: '$0', period: '/mo', desc: 'For individuals and small projects.', features: ['Up to 3 projects', 'Community support', 'Basic analytics', 'Core components'], cta: 'Start free', popular: false },
    { name: 'Team', price: '$24', period: '/user/mo', desc: 'For growing teams that ship daily.', features: ['Unlimited projects', 'Priority support', 'Advanced analytics', 'Full component library', 'Collaboration tools', 'Version history'], cta: 'Start 14-day trial', popular: true },
    { name: 'Enterprise', price: 'Custom', period: '', desc: 'For organizations at scale.', features: ['Everything in Team', 'SSO & SAML', 'Audit logs', 'Dedicated success manager', 'Custom SLAs', 'On-prem deployment'], cta: 'Talk to sales', popular: false },
  ],
  stats: [
    { label: 'Monthly revenue', value: '$128,430', change: '+18.2%', trend: 'up' },
    { label: 'Active users', value: '42,180', change: '+12.4%', trend: 'up' },
    { label: 'Conversion rate', value: '4.8%', change: '+0.6pt', trend: 'up' },
    { label: 'Avg. session', value: '6m 42s', change: '-0.3pt', trend: 'down' },
  ],
  teamMembers: [
    { name: 'Priya Menon', role: 'Product Manager', email: 'priya@meridian.co', status: 'active' },
    { name: 'Marcus Chen', role: 'Staff Engineer', email: 'marcus@meridian.co', status: 'active' },
    { name: 'Sofia Reyes', role: 'Design Lead', email: 'sofia@meridian.co', status: 'active' },
    { name: 'David Osei', role: 'QA Engineer', email: 'david@meridian.co', status: 'invited' },
    { name: 'Hiro Tanaka', role: 'Data Analyst', email: 'hiro@meridian.co', status: 'active' },
  ],
  blogPosts: [
    { title: 'How we cut our deploy time from 40 minutes to 4', excerpt: 'A deep dive into our new CI pipeline, caching strategy, and the operational shift that made it possible.', author: 'Marcus Chen', date: 'Mar 18, 2026', readTime: '8 min', tag: 'Engineering' },
    { title: 'Designing for ambiguity: the frameworks that saved us', excerpt: 'When the spec is incomplete and the deadline is fixed, these five principles kept us moving forward.', author: 'Sofia Reyes', date: 'Mar 12, 2026', readTime: '6 min', tag: 'Design' },
    { title: 'What we learned scaling to 1M events per second', excerpt: 'The infrastructure bets that paid off — and the ones we had to undo in production.', author: 'Priya Menon', date: 'Mar 05, 2026', readTime: '12 min', tag: 'Infrastructure' },
  ],
  socialPosts: [
    { author: 'Priya Menon', handle: '@priya', time: '2h', text: 'Just shipped the new onboarding flow. First-time activation jumped from 34% to 58% in A/B — team crushed it this sprint. 🚢' },
    { author: 'Marcus Chen', handle: '@marcusc', time: '5h', text: 'TIL: you can debug React Server Component hydration mismatches by diffing the HTML payload against client render output. Game changer for our team.' },
    { author: 'Sofia Reyes', handle: '@sofiar', time: '1d', text: 'Hot take: most "design systems" fail because they\'re built as libraries, not as products. If no one PMs it, no one uses it correctly.' },
  ],
  tasks: [
    { title: 'Review onboarding redesign mockups', assignee: 'Sofia Reyes', due: 'Today', priority: 'high', status: 'in-progress' },
    { title: 'Fix session token rotation bug', assignee: 'Marcus Chen', due: 'Tomorrow', priority: 'critical', status: 'in-progress' },
    { title: 'Schedule customer research calls', assignee: 'Priya Menon', due: 'Mar 22', priority: 'medium', status: 'todo' },
    { title: 'Audit payment flow for PCI compliance', assignee: 'David Osei', due: 'Mar 25', priority: 'high', status: 'todo' },
    { title: 'Q1 retrospective doc', assignee: 'Hiro Tanaka', due: 'Mar 30', priority: 'low', status: 'done' },
  ],
  footerLinks: {
    Product: ['Overview', 'Features', 'Integrations', 'Changelog', 'Pricing'],
    Company: ['About', 'Careers', 'Blog', 'Press', 'Contact'],
    Resources: ['Docs', 'API Reference', 'Community', 'Support', 'Status'],
    Legal: ['Privacy', 'Terms', 'Security', 'Cookie Policy'],
  },
} as const;

// Helper: pick N items from an array, offset to vary between variants
export function pick<T>(arr: readonly T[], count: number, offset = 0): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(arr[(i + offset) % arr.length]);
  return out;
}

// Style presets: each maps to tailwind class tokens used by the generator
export type StyleKey = 'modern' | 'minimal' | 'playful' | 'enterprise' | 'bold' | 'editorial';

export const STYLE_PRESETS: Record<StyleKey, {
  label: string;
  description: string;
  radius: string;            // rounded-*
  radiusLg: string;
  button: string;            // primary button classes
  buttonSecondary: string;   // secondary button
  card: string;              // card shell
  heading: string;           // h1 classes
  subheading: string;
  section: string;           // section wrapper
  accent: string;            // feature badge
  surface: string;           // page background
}> = {
  modern: {
    label: 'Modern',
    description: 'Soft shadows, generous spacing, rounded corners',
    radius: 'rounded-xl',
    radiusLg: 'rounded-2xl',
    button: 'px-6 py-3 rounded-xl bg-primary text-primary-foreground font-semibold shadow-sm hover:shadow-md transition-shadow',
    buttonSecondary: 'px-6 py-3 rounded-xl border border-border bg-card hover:bg-accent font-semibold transition-colors',
    card: 'rounded-2xl border border-border/60 bg-card shadow-sm',
    heading: 'text-5xl md:text-6xl font-semibold tracking-tight leading-[1.05]',
    subheading: 'text-lg text-muted-foreground leading-relaxed',
    section: 'py-20 px-8',
    accent: 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium',
    surface: 'bg-background',
  },
  minimal: {
    label: 'Minimal',
    description: 'Flat surfaces, tight spacing, monospace accents',
    radius: 'rounded-md',
    radiusLg: 'rounded-lg',
    button: 'px-5 py-2.5 rounded-md bg-foreground text-background font-medium hover:opacity-90 transition-opacity',
    buttonSecondary: 'px-5 py-2.5 rounded-md border border-border hover:bg-accent/50 font-medium transition-colors',
    card: 'rounded-lg border border-border bg-card',
    heading: 'text-4xl md:text-5xl font-medium tracking-tight leading-tight',
    subheading: 'text-base text-muted-foreground leading-relaxed',
    section: 'py-16 px-6',
    accent: 'inline-block font-mono text-[10px] uppercase tracking-widest text-muted-foreground',
    surface: 'bg-background',
  },
  playful: {
    label: 'Playful',
    description: 'Bright accents, bouncy radii, expressive',
    radius: 'rounded-2xl',
    radiusLg: 'rounded-3xl',
    button: 'px-7 py-3.5 rounded-full bg-primary text-primary-foreground font-bold hover:scale-105 transition-transform shadow-lg shadow-primary/20',
    buttonSecondary: 'px-7 py-3.5 rounded-full border-2 border-primary text-primary font-bold hover:bg-primary/5 transition-colors',
    card: 'rounded-3xl border-2 border-border bg-card hover:shadow-xl transition-shadow',
    heading: 'text-5xl md:text-6xl font-black tracking-tight leading-[1.05]',
    subheading: 'text-lg text-muted-foreground leading-relaxed',
    section: 'py-20 px-8',
    accent: 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-400/20 text-amber-600 dark:text-amber-400 text-xs font-semibold',
    surface: 'bg-gradient-to-b from-background to-primary/5',
  },
  enterprise: {
    label: 'Enterprise',
    description: 'Dense information, structured grids, authoritative',
    radius: 'rounded-md',
    radiusLg: 'rounded-lg',
    button: 'px-5 py-2.5 rounded-md bg-primary text-primary-foreground font-semibold shadow-sm hover:shadow-md transition-shadow',
    buttonSecondary: 'px-5 py-2.5 rounded-md border border-border bg-card hover:bg-accent font-semibold transition-colors',
    card: 'rounded-lg border border-border bg-card',
    heading: 'text-4xl md:text-5xl font-bold tracking-tight leading-tight',
    subheading: 'text-base text-muted-foreground leading-relaxed',
    section: 'py-14 px-6',
    accent: 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-primary/10 text-primary text-[10px] font-semibold uppercase tracking-wider',
    surface: 'bg-background',
  },
  bold: {
    label: 'Bold',
    description: 'Massive type, high contrast, confident',
    radius: 'rounded-none',
    radiusLg: 'rounded-sm',
    button: 'px-8 py-4 rounded-none bg-foreground text-background font-bold uppercase tracking-wider hover:opacity-90 transition-opacity',
    buttonSecondary: 'px-8 py-4 rounded-none border-2 border-foreground font-bold uppercase tracking-wider hover:bg-foreground hover:text-background transition-colors',
    card: 'rounded-none border-2 border-foreground bg-card',
    heading: 'text-6xl md:text-7xl font-black uppercase tracking-tight leading-[0.95]',
    subheading: 'text-xl text-muted-foreground leading-relaxed',
    section: 'py-24 px-8',
    accent: 'inline-block px-2 py-0.5 bg-foreground text-background text-[10px] font-bold uppercase tracking-widest',
    surface: 'bg-background',
  },
  editorial: {
    label: 'Editorial',
    description: 'Serif headlines, print-inspired, considered',
    radius: 'rounded-md',
    radiusLg: 'rounded-lg',
    button: 'px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:shadow-md transition-shadow',
    buttonSecondary: 'px-6 py-3 rounded-md border border-border bg-card hover:bg-accent font-medium transition-colors',
    card: 'rounded-md border border-border bg-card',
    heading: 'text-5xl md:text-6xl font-serif font-normal tracking-tight leading-[1.08]',
    subheading: 'text-lg font-serif italic text-muted-foreground leading-relaxed',
    section: 'py-20 px-8',
    accent: 'inline-block font-serif italic text-sm text-muted-foreground',
    surface: 'bg-background',
  },
};

// Suggestion cards shown on the DesignHero — exemplar prompts
export const DESIGN_SUGGESTIONS = [
  { id: 'saas-landing', label: 'SaaS landing page', icon: '🚀', prompt: 'A modern SaaS landing page for a developer productivity tool, with hero, features, pricing, testimonials, and CTA' },
  { id: 'ecommerce', label: 'E-commerce storefront', icon: '🛍', prompt: 'An elegant e-commerce homepage for a premium apparel brand, with product grid, editorial hero, and category navigation' },
  { id: 'dashboard', label: 'Analytics dashboard', icon: '📊', prompt: 'A data-dense analytics dashboard with KPI cards, charts section, activity feed, and sidebar navigation' },
  { id: 'portfolio', label: 'Personal portfolio', icon: '👤', prompt: 'A minimal portfolio site for a senior designer, with projects grid, about section, and contact' },
  { id: 'blog', label: 'Publication / blog', icon: '📰', prompt: 'A polished blog homepage with featured article, category filters, and article grid' },
  { id: 'app-shell', label: 'App dashboard shell', icon: '🧭', prompt: 'An application shell with left sidebar, top bar, search, and an empty main content canvas' },
  { id: 'pricing', label: 'Pricing page', icon: '💳', prompt: 'A pricing page with three tiers, feature comparison table, and FAQ section' },
  { id: 'auth', label: 'Auth flow', icon: '🔐', prompt: 'Clean sign-in and sign-up forms with social providers and password reset link' },
];
