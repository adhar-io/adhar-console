/**
 * Builder nodes → source, splicing ONLY what changed back into a file.
 *
 *   • A node whose fingerprint matches its import (`unchanged`) prints as its
 *     original source text, byte for byte — formatting, comments and anything
 *     the designer doesn't understand survive untouched.
 *   • A changed element is re-emitted (its tag line + children), with its
 *     untouched children still printed as their original text.
 *   • Opaque `code` nodes always print their original text.
 *   • If nothing in a page changed, the file is returned unchanged.
 *
 * New nodes from the palette are written in the repo's style: Tailwind
 * classes when the repo uses Tailwind, router links via the repo's router,
 * imports for components and data, and a `useNavigate()` hook when a
 * navigation needs one.
 */

import type { CanvasNode } from '../lib/builder-types.ts';
import { nodeToTag } from '../lib/builder-codegen.ts';
import { unchanged, type ComponentRegion } from './jsx-import.ts';
import type { Framework } from './framework.ts';

const isSolid = (f: Framework) => f.id === 'solid' || f.id === 'solid-start';
const isSolidRouter = (f: Framework) => f.router === 'solid-router' || f.router === 'solid-start';

export interface PrintContext {
  /** Original file text (for `unchanged` nodes). Empty for brand-new files. */
  source: string;
  framework: Framework;
  /** Path of the file being printed (for relative imports). */
  filePath: string;
  /** builder page id → route (navigate interactions). */
  routes: Record<string, string>;
  /** builder symbol id → { component name, file path }. */
  symbols: Record<string, { name: string; path: string }>;
  /** data-source file id → { variable name, file path }. */
  data: Record<string, { name: string; path: string }>;
  /** Collected while printing. */
  needs: Needs;
}

export interface Needs {
  imports: Map<string, { default?: string; named: Set<string> }>;
  navigateHook: boolean;
}

export function newNeeds(): Needs {
  return { imports: new Map(), navigateHook: false };
}

function need(ctx: PrintContext, source: string, opts: { default?: string; named?: string }) {
  const cur = ctx.needs.imports.get(source) ?? { named: new Set<string>() };
  if (opts.default) cur.default = opts.default;
  if (opts.named) cur.named.add(opts.named);
  ctx.needs.imports.set(source, cur);
}

/** `src/pages/A.tsx` → `src/components/B.tsx` ⇒ `../components/B`. */
export function relativeImport(from: string, to: string, keepExt = false): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  const rest = b.slice(i).join('/');
  const path = (up === 0 ? './' : '../'.repeat(up)) + rest;
  return keepExt ? path : path.replace(/\.(tsx|ts|jsx|js)$/, '');
}

const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'area', 'col', 'embed', 'source', 'track', 'wbr']);

/** JSX-safe attribute value. */
const attrValue = (v: string) => (/["\\]/.test(v) || v.includes('\n') ? `{${JSON.stringify(v)}}` : `"${v}"`);
/** JSX-safe text. */
export function jsxText(t: string): string {
  return /[{}<>&]/.test(t) || /^\s|\s$/.test(t) ? `{${JSON.stringify(t)}}` : t;
}

const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;
function textWithTemplates(text: string, itemVar: string | null): string {
  if (!itemVar || !TEMPLATE.test(text)) return jsxText(text);
  TEMPLATE.lastIndex = 0;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TEMPLATE)) {
    out += text.slice(last, m.index) ? jsxText(text.slice(last, m.index)) : '';
    out += `{${itemVar}${m[1].split('.').map((k) => `?.${k}`).join('')}}`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + (text.slice(last) ? jsxText(text.slice(last)) : '');
}

function tagFor(n: CanvasNode): string {
  if (n.type === 'link') return typeof n.props?.linkTag === 'string' ? n.props.linkTag : 'a';
  if (n.type === 'img') return 'img';
  if (n.type === 'separator') return 'hr';
  return nodeToTag(n.type);
}

function navigateAttr(n: CanvasNode, ctx: PrintContext, tag: string): string {
  const it = n.interactions?.find((i) => i.trigger === 'click');
  if (!it) return '';
  const raw = (n.props?.rawAttrs as string[] | undefined) ?? [];
  if (raw.some((a) => /^onClick\b/.test(a))) return '';
  if (it.action === 'open-url' && it.url) return ` onClick={() => window.open(${JSON.stringify(it.url)}, '_blank')}`;
  if (it.action === 'navigate' && it.targetPageId) {
    const route = ctx.routes[it.targetPageId];
    if (!route) return '';
    // Links get a real router link instead (see printElement).
    if (n.type === 'link' && tag !== 'a') return '';
    if (ctx.framework.router === 'react-router' || ctx.framework.router === 'remix' || isSolidRouter(ctx.framework)) {
      ctx.needs.navigateHook = true;
      need(ctx, isSolidRouter(ctx.framework) ? '@solidjs/router' : ctx.framework.router === 'remix' ? '@remix-run/react' : 'react-router-dom', { named: 'useNavigate' });
      return ` onClick={() => navigate(${JSON.stringify(route)})}`;
    }
    return ` onClick={() => window.location.assign(${JSON.stringify(route)})}`;
  }
  return '';
}

export function printNode(n: CanvasNode, ctx: PrintContext, indent: string, itemVar: string | null = null): string {
  if (unchanged(n) && ctx.source) return ctx.source.slice(n.src!.start, n.src!.end);
  switch (n.type) {
    case 'code':
      return String(n.props?.code ?? '');
    case 'text':
      return textWithTemplates(String(n.props?.children ?? ''), itemVar);
    case 'symbol': {
      const sym = ctx.symbols[String(n.props?.symbolId ?? '')];
      if (!sym) return '{/* missing component */}';
      need(ctx, relativeImport(ctx.filePath, sym.path), { default: sym.name });
      return `<${sym.name} />`;
    }
    case 'fragment':
      return wrapChildren('<>', '</>', n.children.map((c) => printNode(c, ctx, indent + '  ', itemVar)), indent);
  }
  return printElement(n, ctx, indent, itemVar);
}

function wrapChildren(open: string, close: string, kids: string[], indent: string): string {
  if (!kids.length) return `${open}${close}`;
  const inner = indent + '  ';
  return `${open}\n${kids.map((k) => inner + k).join('\n')}\n${indent}${close}`;
}

function printElement(n: CanvasNode, ctx: PrintContext, indent: string, itemVar: string | null): string {
  const p = n.props ?? {};
  // Router links: a page target becomes the router's Link; the import is added.
  let tag = tagFor(n);
  const it = n.interactions?.find((i) => i.trigger === 'click' && i.action === 'navigate');
  const linkRoute = n.type === 'link' && it?.targetPageId ? ctx.routes[it.targetPageId] : undefined;
  if (n.type === 'link' && (linkRoute || p.linkTag)) {
    if (ctx.framework.router === 'react-router') { tag = String(p.linkTag ?? 'Link'); need(ctx, 'react-router-dom', { named: tag }); }
    else if (ctx.framework.router === 'remix') { tag = String(p.linkTag ?? 'Link'); need(ctx, '@remix-run/react', { named: tag }); }
    else if (ctx.framework.id === 'next') { tag = 'Link'; need(ctx, 'next/link', { default: 'Link' }); }
    else if (isSolidRouter(ctx.framework)) { tag = String(p.linkTag ?? 'A'); need(ctx, '@solidjs/router', { named: tag }); }
  }
  const classAttr = isSolid(ctx.framework) ? 'class' : 'className';
  let attrs = '';
  if (p.classExpr) attrs += ` ${classAttr}={${p.classExpr}}`;
  else if (typeof p.className === 'string' && p.className.trim()) attrs += ` ${classAttr}=${attrValue(p.className.trim())}`;
  if (tag !== 'a' && n.type === 'link') {
    const attr = ctx.framework.id === 'next' ? 'href' : String(p.linkAttr ?? (isSolid(ctx.framework) ? 'href' : 'to'));
    attrs += ` ${attr}=${attrValue(linkRoute ?? String(p.to ?? '/'))}`;
  } else if (tag === 'a') {
    attrs += ` href=${attrValue(String(p.href ?? (linkRoute ?? '#')))}`;
  }
  if (tag === 'img') attrs += ` src=${attrValue(String(p.src ?? ''))} alt=${attrValue(String(p.alt ?? ''))}`;
  if (n.type === 'input' || n.type === 'date-input') attrs += ` type=${attrValue(n.type === 'date-input' ? 'date' : String(p.inputType ?? 'text'))}`;
  if (p.placeholder) attrs += ` placeholder=${attrValue(String(p.placeholder))}`;
  if (p.required) attrs += ' required';
  for (const raw of (p.rawAttrs as string[] | undefined) ?? []) attrs += ` ${raw}`;
  attrs += navigateAttr(n, ctx, tag);

  // Form widgets the palette models as one node.
  const text = typeof p.children === 'string' ? p.children : '';
  switch (n.type) {
    case 'checkbox':
    case 'radio':
    case 'switch':
      return `<label${attrs}>\n${indent}  <input type="${n.type === 'radio' ? 'radio' : 'checkbox'}"${n.type === 'switch' ? ' role="switch"' : ''}${p.name ? ` name=${attrValue(String(p.name))}` : ''} />\n${indent}  ${textWithTemplates(text, itemVar)}\n${indent}</label>`;
    case 'select': {
      const opts = Array.isArray(p.options) ? (p.options as unknown[]).map(String) : [];
      return wrapChildren(`<select${attrs}>`, '</select>', opts.map((o) => `<option>${jsxText(o)}</option>`), indent);
    }
    case 'progress-bar':
      return `<div${attrs}>\n${indent}  <div ${classAttr}="h-full rounded-full bg-primary" style={{ width: '${Number(p['data-value'] ?? 66)}%' }} />\n${indent}</div>`;
  }

  if (VOID.has(tag)) return `<${tag}${attrs} />`;

  const kids: string[] = [];
  if (text) kids.push(textWithTemplates(text, itemVar));
  if (n.bind) {
    const ds = ctx.data[n.bind.source];
    if (ds) {
      need(ctx, relativeImport(ctx.filePath, ds.path, true), { default: ds.name });
      if (!isSolid(ctx.framework)) need(ctx, 'react', { named: 'Fragment' });
      const path = (n.bind.path ?? '').split('.').filter(Boolean).map((k) => `?.${k}`).join('');
      const list = path ? `((${ds.name} as any)${path} ?? [])` : ctx.framework.typescript ? `(${ds.name} as any[])` : ds.name;
      const item = ctx.framework.typescript ? '(item: any, i: number)' : '(item, i)';
      const inner = n.children.map((c) => printNode(c, ctx, indent + '      ', 'item'));
      if (isSolid(ctx.framework)) {
        // Solid: <For> instead of .map + keyed fragments.
        need(ctx, 'solid-js', { named: 'For' });
        const one = ctx.framework.typescript ? '(item: any)' : '(item)';
        kids.push(`<For each={${list}}>{${one} => (\n${indent}    <>\n${inner.map((k) => `${indent}      ${k}`).join('\n')}\n${indent}    </>\n${indent}  )}</For>`);
      } else kids.push(`{${list}.map(${item} => (\n${indent}    <Fragment key={i}>\n${inner.map((k) => `${indent}      ${k}`).join('\n')}\n${indent}    </Fragment>\n${indent}  ))}`);
    }
  } else {
    for (const c of n.children) kids.push(printNode(c, ctx, indent + '  ', itemVar));
  }
  if (!kids.length) return `<${tag}${attrs} />`;
  if (kids.length === 1 && !kids[0].includes('\n') && (kids[0].length + tag.length * 2 + attrs.length) < 100) return `<${tag}${attrs}>${kids[0]}</${tag}>`;
  return wrapChildren(`<${tag}${attrs}>`, `</${tag}>`, kids, indent);
}

/** Print a page's root list as one JSX expression (wrapping several roots in a fragment). */
export function printRoots(nodes: CanvasNode[], ctx: PrintContext, indent: string): string {
  if (nodes.length === 1) return printNode(nodes[0], ctx, indent);
  if (nodes.length === 0) return '<></>';
  return wrapChildren('<>', '</>', nodes.map((n) => printNode(n, ctx, indent + '  ')), indent);
}

/* ───────────────────────────── splicing ───────────────────────────── */

export interface Edit {
  at: number;
  end: number;
  text: string;
}

function applyEdits(code: string, edits: Edit[]): string {
  let out = code;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return out;
}

/** Import lines for what printing needed and the file doesn't already import. */
export function importLines(needs: Needs, existing: string): string[] {
  const lines: string[] = [];
  for (const [source, spec] of needs.imports) {
    const has = (name: string) => new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s+['"]${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(existing);
    const named = [...spec.named].filter((n) => !has(n));
    const def = spec.default && !has(spec.default) ? spec.default : undefined;
    if (!def && !named.length) continue;
    const parts = [def, named.length ? `{ ${named.join(', ')} }` : ''].filter(Boolean).join(', ');
    lines.push(`import ${parts} from '${source}'`);
  }
  return lines;
}

/** Offset after the last import statement's line (or 0 / after `'use client'`). */
export function afterImports(code: string): number {
  const re = /^import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$|^import\s+['"][^'"]+['"];?[ \t]*$/gm;
  let at = -1;
  for (const m of code.matchAll(re)) at = (m.index ?? 0) + m[0].length;
  if (at >= 0) {
    const nl = code.indexOf('\n', at);
    return nl === -1 ? code.length : nl + 1;
  }
  const directive = code.match(/^\s*(['"])use (client|server)\1;?[ \t]*\n/);
  return directive ? directive[0].length : 0;
}

export interface SplicePlan {
  edits: Edit[];
  needs: Needs;
}

/** The edits one page needs in its file — or none when nothing changed. */
export function planSplice(code: string, region: ComponentRegion, nodes: CanvasNode[], ctx: Omit<PrintContext, 'source' | 'needs'>): SplicePlan {
  const needs = newNeeds();
  const untouched = nodes.length === 1 && unchanged(nodes[0]) && nodes[0].src!.start === region.jsxStart && nodes[0].src!.end === region.jsxEnd;
  if (untouched) return { edits: [], needs };
  const full: PrintContext = { ...ctx, source: code, needs };
  const printed = printRoots(nodes, full, region.indent);
  const edits: Edit[] = [{ at: region.jsxStart, end: region.jsxEnd, text: printed }];
  if (needs.navigateHook && !/\bconst\s+navigate\s*=\s*useNavigate\(/.test(code) && region.bodyStart !== null) {
    edits.push({ at: region.bodyStart, end: region.bodyStart, text: `\n${region.fnIndent}  const navigate = useNavigate()` });
  }
  return { edits, needs };
}

/** Apply several pages' plans to one file, with one merged import block. */
export function applyPlans(code: string, plans: SplicePlan[]): string {
  const edits = plans.flatMap((p) => p.edits);
  if (!edits.length) return code;
  const merged = newNeeds();
  for (const p of plans) {
    for (const [src, spec] of p.needs.imports) {
      const cur = merged.imports.get(src) ?? { named: new Set<string>() };
      if (spec.default) cur.default = spec.default;
      spec.named.forEach((n) => cur.named.add(n));
      merged.imports.set(src, cur);
    }
  }
  const lines = importLines(merged, code);
  if (lines.length) {
    const at = afterImports(code);
    edits.push({ at, end: at, text: lines.join('\n') + '\n' + (at === 0 ? '\n' : '') });
  }
  return applyEdits(code, edits);
}

/**
 * Splice a page's (possibly edited) nodes back into its source. Returns the
 * original text unchanged when nothing changed.
 */
export function splicePage(code: string, region: ComponentRegion, nodes: CanvasNode[], ctx: Omit<PrintContext, 'source' | 'needs'>): string {
  return applyPlans(code, [planSplice(code, region, nodes, ctx)]);
}

/** A complete new component/page module in the repo's style. */
export function newComponentModule(name: string, nodes: CanvasNode[], ctx: Omit<PrintContext, 'source' | 'needs'>): string {
  const full: PrintContext = { ...ctx, source: '', needs: newNeeds() };
  const jsx = printRoots(nodes, full, '    ');
  const imports = importLines(full.needs, '');
  const hook = full.needs.navigateHook ? '  const navigate = useNavigate()\n' : '';
  const head = (ctx.framework.id === 'next' && full.needs.navigateHook) ? `'use client'\n\n` : '';
  return `${head}${imports.length ? imports.join('\n') + '\n\n' : ''}export default function ${name}() {\n${hook}  return (\n    ${jsx}\n  )\n}\n`;
}
