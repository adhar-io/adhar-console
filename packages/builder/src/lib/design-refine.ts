// Iterative refinement engine. Given a prompt like "make it dark" or
// "add a pricing section", applies the requested change to the existing
// node tree without regenerating from scratch.

import type { CanvasNode } from './builder-types.ts';
import { genId } from './builder-types.ts';
import { generateSingleVariant, generateVariants, detectCategory } from './design-generator.ts';
import { STYLE_PRESETS, type StyleKey } from './design-content.ts';

export type RefineOp =
  | { kind: 'append-section'; cat: 'pricing' | 'testimonials' | 'features' | 'cta' | 'footer' | 'hero' | 'contact' | 'faq' }
  | { kind: 'remove-section'; match: string }
  | { kind: 'restyle'; style: StyleKey }
  | { kind: 'replace-text'; from: string; to: string }
  | { kind: 'change-heading'; text: string }
  | { kind: 'change-brand'; text: string }
  | { kind: 'regenerate'; prompt: string }
  | { kind: 'unknown' };

// Parse a natural-language prompt into a structured operation
export function parseRefinePrompt(prompt: string): RefineOp {
  const p = prompt.trim().toLowerCase();

  // Full regenerate
  if (/^(regenerate|redo|start over|try again)/.test(p)) {
    return { kind: 'regenerate', prompt };
  }

  // Style change
  const styleMap: Record<string, StyleKey> = {
    modern: 'modern', minimal: 'minimal', playful: 'playful',
    enterprise: 'enterprise', corporate: 'enterprise',
    bold: 'bold', editorial: 'editorial', magazine: 'editorial', serif: 'editorial',
  };
  for (const [kw, sk] of Object.entries(styleMap)) {
    if (new RegExp(`\\b(make it |more |make the design |style it |change to )${kw}\\b`).test(p) || p === kw || p === `make it ${kw}`) {
      return { kind: 'restyle', style: sk };
    }
  }

  // Add section
  const sectionKeywords = {
    pricing: /add.*pricing|pricing section|include pricing/,
    testimonials: /add.*testimonial|add.*reviews|social proof/,
    features: /add.*feature|feature section|add benefits/,
    cta: /add.*cta|call to action/,
    footer: /add.*footer/,
    hero: /add.*hero/,
    contact: /add.*contact/,
    faq: /add.*faq|add.*questions/,
  } as const;
  for (const [key, rx] of Object.entries(sectionKeywords)) {
    if (rx.test(p)) return { kind: 'append-section', cat: key as any };
  }

  // Remove section
  const removeMatch = p.match(/(remove|delete|drop) (the )?(pricing|testimonials|features|footer|hero|cta|nav|navigation|header)/);
  if (removeMatch) {
    return { kind: 'remove-section', match: removeMatch[3] };
  }

  // Change heading / hero text
  const headlineMatch = prompt.match(/(?:change|set|update)(?: the)? (?:headline|hero|title|h1) to ["'](.+?)["']/i);
  if (headlineMatch) return { kind: 'change-heading', text: headlineMatch[1] };

  // Change brand
  const brandMatch = prompt.match(/(?:rename|change|set)(?: the)? brand(?: name)? to ["']?([\w\s]+?)["']?$/i);
  if (brandMatch) return { kind: 'change-brand', text: brandMatch[1].trim() };

  // Replace text
  const replaceMatch = prompt.match(/(?:replace|change) ["'](.+?)["'] (?:with|to) ["'](.+?)["']/i);
  if (replaceMatch) return { kind: 'replace-text', from: replaceMatch[1], to: replaceMatch[2] };

  // Fallback → regenerate
  return { kind: 'unknown' };
}

// ─── Apply operations to a node tree ─────────────────────────────────────────

function mapNodes(nodes: CanvasNode[], fn: (n: CanvasNode) => CanvasNode): CanvasNode[] {
  return nodes.map((n) => {
    const mapped = fn(n);
    return { ...mapped, children: mapNodes(mapped.children || [], fn) };
  });
}

export function applyRefine(nodes: CanvasNode[], op: RefineOp, fullPrompt: string): CanvasNode[] {
  switch (op.kind) {
    case 'regenerate': {
      const fresh = generateVariants(fullPrompt);
      return fresh[0]?.nodes || nodes;
    }

    case 'restyle': {
      // Heuristic: detect the current category from the existing content and regenerate in the new style
      const category = detectCategory(fullPrompt || 'generic landing');
      const styled = generateSingleVariant(fullPrompt || `${category} page`, op.style);
      return styled.nodes;
    }

    case 'append-section': {
      const newSection = buildSection(op.cat);
      return [...nodes, newSection];
    }

    case 'remove-section': {
      return nodes.filter((n) => {
        const classes = (n.props?.className || '').toLowerCase();
        const text = JSON.stringify(n).toLowerCase();
        return !(classes.includes(op.match) || text.includes(`"${op.match}"`) || n.type === op.match);
      });
    }

    case 'change-heading': {
      let changed = false;
      return mapNodes(nodes, (n) => {
        if (changed) return n;
        if (n.type === 'h1') {
          changed = true;
          return { ...n, props: { ...n.props, children: op.text } };
        }
        return n;
      });
    }

    case 'change-brand': {
      // Brand is typically the first child of <nav>
      let changed = false;
      return mapNodes(nodes, (n) => {
        if (changed) return n;
        if (n.type === 'nav' && n.children[0]) {
          const first = n.children[0];
          if (first.type === 'span' || first.type === 'h1') {
            changed = true;
            const updatedFirst = { ...first, props: { ...first.props, children: op.text } };
            return { ...n, children: [updatedFirst, ...n.children.slice(1)] };
          }
        }
        return n;
      });
    }

    case 'replace-text': {
      return mapNodes(nodes, (n) => {
        const kids = n.props?.children;
        if (typeof kids === 'string' && kids.includes(op.from)) {
          return { ...n, props: { ...n.props, children: kids.split(op.from).join(op.to) } };
        }
        return n;
      });
    }

    case 'unknown':
    default: {
      // Best-effort: generate a fresh single-section block and append
      const newSection = buildSection(inferSectionFromPrompt(fullPrompt));
      return [...nodes, newSection];
    }
  }
}

function inferSectionFromPrompt(prompt: string): 'hero' | 'features' | 'pricing' | 'testimonials' | 'cta' | 'footer' | 'contact' | 'faq' {
  const p = prompt.toLowerCase();
  if (/pricing/.test(p)) return 'pricing';
  if (/testimonial|review/.test(p)) return 'testimonials';
  if (/feature|benefit/.test(p)) return 'features';
  if (/hero|banner/.test(p)) return 'hero';
  if (/footer/.test(p)) return 'footer';
  if (/contact/.test(p)) return 'contact';
  if (/faq|question/.test(p)) return 'faq';
  return 'cta';
}

// ─── Section builders ────────────────────────────────────────────────────────
type N = CanvasNode;
const node = (type: string, className: string, children: N[] = [], extra: Record<string, any> = {}): N => ({
  id: genId(), type, props: { className, ...extra }, children, style: {},
});
const text = (type: string, className: string, children: string, extra: Record<string, unknown> = {}): N => ({
  id: genId(), type, props: { className, children, ...extra }, children: [], style: {},
});

function buildSection(cat: 'hero' | 'features' | 'pricing' | 'testimonials' | 'cta' | 'footer' | 'contact' | 'faq'): N {
  const s = STYLE_PRESETS.modern;

  switch (cat) {
    case 'pricing':
      return node('section', `${s.section} max-w-6xl mx-auto`, [
        text('h2', 'text-4xl font-semibold tracking-tight text-center mb-10', 'Simple pricing'),
        node('grid', 'grid grid-cols-3 gap-5', ['Starter', 'Pro', 'Enterprise'].map((name, i) => (
          node('card', `${s.card} p-7 flex flex-col gap-5 ${i === 1 ? 'ring-2 ring-primary' : ''}`, [
            text('h3', 'text-sm font-semibold text-muted-foreground uppercase tracking-wide', name),
            text('h4', 'text-4xl font-bold', ['Free', '$29', 'Custom'][i]),
            text('p', 'text-sm text-muted-foreground', ['For individuals', 'For growing teams', 'For large orgs'][i]),
            text('button', i === 1 ? s.button + ' w-full' : s.buttonSecondary + ' w-full', ['Start free', 'Get started', 'Contact sales'][i]),
          ])
        ))),
      ]);

    case 'testimonials':
      return node('section', `${s.section} bg-muted/30 max-w-6xl mx-auto ${s.radiusLg}`, [
        text('h2', 'text-4xl font-semibold tracking-tight text-center mb-10', 'Loved by teams'),
        node('grid', 'grid grid-cols-2 gap-6', [
          { q: 'It replaced three tools on our stack.', a: 'Priya Menon', r: 'Linear' },
          { q: 'Finally, design and eng speaking the same language.', a: 'Marcus Chen', r: 'Vercel' },
        ].map((t) => (
          node('card', `${s.card} p-7`, [
            text('p', 'text-lg font-medium leading-relaxed mb-4', `"${t.q}"`),
            node('flex', 'flex items-center gap-3', [
              text('div', 'w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center text-sm font-bold text-primary', t.a.split(' ').map((n) => n[0]).join('')),
              node('flex-col', 'flex flex-col', [
                text('span', 'text-sm font-semibold', t.a),
                text('span', 'text-xs text-muted-foreground', t.r),
              ]),
            ]),
          ])
        ))),
      ]);

    case 'features':
      return node('section', `${s.section} max-w-6xl mx-auto`, [
        text('h2', 'text-4xl font-semibold tracking-tight text-center mb-10', 'Built for every team'),
        node('grid', 'grid grid-cols-3 gap-6', [
          { i: '⚡', t: 'Fast by default', d: 'Ship in minutes, not weeks.' },
          { i: '🔒', t: 'Enterprise-ready', d: 'SOC 2, SSO, and audit logs included.' },
          { i: '✨', t: 'AI-powered', d: 'Smart suggestions throughout.' },
        ].map((f) => (
          node('card', `${s.card} p-7 flex flex-col gap-3`, [
            text('div', 'w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center text-xl', f.i),
            text('h3', 'text-lg font-semibold', f.t),
            text('p', 'text-sm text-muted-foreground leading-relaxed', f.d),
          ])
        ))),
      ]);

    case 'cta':
      return node('section', `${s.section} text-center max-w-3xl mx-auto flex flex-col gap-5 items-center`, [
        text('h2', 'text-4xl font-semibold tracking-tight', 'Ready to get started?'),
        text('p', 'text-lg text-muted-foreground', 'Join thousands already building with us.'),
        node('flex', 'flex gap-3', [
          text('button', s.button, 'Start for free'),
          text('button', s.buttonSecondary, 'Book a demo'),
        ]),
      ]);

    case 'hero':
      return node('section', `${s.section} max-w-5xl mx-auto flex flex-col items-center text-center gap-5`, [
        text('span', s.accent, 'NEW'),
        text('h1', s.heading, 'Build something beautiful.'),
        text('p', s.subheading + ' max-w-2xl', 'A new way to ship your next product.'),
        node('flex', 'flex gap-3 mt-3', [
          text('button', s.button, 'Get started'),
          text('button', s.buttonSecondary, 'Learn more'),
        ]),
      ]);

    case 'footer':
      return node('footer', 'border-t border-border px-8 py-12 mt-16', [
        node('grid', 'grid grid-cols-4 gap-8 max-w-6xl mx-auto', ['Product', 'Company', 'Resources', 'Legal'].map((title) => (
          node('flex-col', 'flex flex-col gap-2', [
            text('h4', 'text-sm font-semibold mb-1', title),
            ...['Overview', 'Features', 'Pricing'].map((l) => text('a', 'text-sm text-muted-foreground hover:text-foreground cursor-pointer', l)),
          ])
        ))),
      ]);

    case 'contact':
      return node('section', `${s.section} max-w-2xl mx-auto`, [
        text('h2', 'text-3xl font-semibold tracking-tight text-center mb-3', 'Get in touch'),
        text('p', 'text-muted-foreground text-center mb-8', 'We typically reply within a few hours.'),
        node('card', `${s.card} p-8 flex flex-col gap-4`, [
          node('flex-col', 'flex flex-col gap-1.5', [
            text('label', 'text-xs font-medium text-muted-foreground', 'Name'),
            text('input', 'rounded-lg px-3 py-2.5 text-sm border border-border bg-background', '', { placeholder: 'Your name' }),
          ]),
          node('flex-col', 'flex flex-col gap-1.5', [
            text('label', 'text-xs font-medium text-muted-foreground', 'Email'),
            text('input', 'rounded-lg px-3 py-2.5 text-sm border border-border bg-background', '', { placeholder: 'you@company.com' }),
          ]),
          node('flex-col', 'flex flex-col gap-1.5', [
            text('label', 'text-xs font-medium text-muted-foreground', 'Message'),
            text('textarea', 'rounded-lg px-3 py-2.5 text-sm border border-border bg-background min-h-[100px]', '', { placeholder: 'How can we help?' }),
          ]),
          text('button', s.button + ' w-full', 'Send message'),
        ]),
      ]);

    case 'faq':
      return node('section', `${s.section} max-w-3xl mx-auto`, [
        text('h2', 'text-4xl font-semibold tracking-tight text-center mb-10', 'Frequently asked'),
        node('flex-col', 'flex flex-col gap-3', [
          { q: 'How does the free trial work?', a: 'Start with 14 days of full access. No credit card required.' },
          { q: 'Can I cancel anytime?', a: 'Yes — cancel anytime from your account settings.' },
          { q: 'Do you offer refunds?', a: 'Full refund within 30 days, no questions asked.' },
          { q: 'Is my data secure?', a: 'SOC 2 Type II certified. Your data is encrypted at rest and in transit.' },
        ].map((item) => (
          node('card', `${s.card} p-5`, [
            text('h3', 'text-base font-semibold mb-2', item.q),
            text('p', 'text-sm text-muted-foreground leading-relaxed', item.a),
          ])
        ))),
      ]);
  }
}
