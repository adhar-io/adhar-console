/**
 * The template engine for HTML-like page languages — Angular templates, Vue
 * SFC `<template>`s, Svelte components and static HTML pages.
 *
 * Each framework's own parser (lazy-loaded, see `parsers/*`) is adapted to one
 * small intermediate tree (`MNode`, absolute source offsets). From there this
 * module does what `jsx-import.ts` / `jsx-print.ts` do for React, with the same
 * guarantees:
 *
 *   • import    plain elements, static attributes, static text and router links
 *               become EDITABLE nodes; everything dynamic — interpolation,
 *               control-flow blocks, structural directives, bindings, event
 *               handlers, components — is kept verbatim (attributes in
 *               `props.rawAttrs`, the rest as opaque `code` chips with a static
 *               preview of the markup inside).
 *   • splice    only the ranges that changed are rewritten: a changed text
 *               replaces just its text, a changed attribute list just the start
 *               tag, an added / removed / moved child just that child (with the
 *               surrounding whitespace style kept). Untouched pages produce no
 *               edits at all, so their files stay byte-identical.
 *   • print     new nodes are written in the dialect's syntax (escaping, router
 *               links, navigation), using the framework's Adhar UI components
 *               when the app depends on them.
 */

import { genId, type CanvasNode } from '../lib/builder-types.ts';
import { nodeToTag } from '../lib/builder-codegen.ts';
import { fingerprint, lineIndent, summarize, unchanged } from './jsx-import.ts';
import type { Framework } from './framework.ts';

export type Dialect = 'vue' | 'angular' | 'svelte' | 'html';

/* ───────────────────────────── intermediate tree ───────────────────────────── */

export interface MAttr {
  /** Name as written (case kept). */
  name: string;
  start: number;
  end: number;
  /** Decoded static value; null when the attribute has no value or is dynamic. */
  value: string | null;
  /** Bound / templated / directive — never edited, kept verbatim. */
  dynamic: boolean;
  /** For a dynamic `class`: its static parts (canvas display only). */
  staticParts?: string;
}

export interface MElement {
  kind: 'element';
  tag: string;
  start: number;
  end: number;
  /** End of the start tag (just after `>`). */
  openEnd: number;
  /** Start of the end tag (`</x>`); null for void / self-closing / implied ends. */
  closeStart: number | null;
  close: 'tag' | 'self' | 'void' | 'implicit';
  attrs: MAttr[];
  children: MNode[];
  /** The parser says it's a component (Vue component, Svelte `<Card>`, …). */
  component?: boolean;
  /** Opaque for a dialect-specific reason (structural directive, special element…); the label. */
  opaque?: string;
}

export interface MText {
  kind: 'text';
  start: number;
  end: number;
}

export interface MCode {
  kind: 'code';
  start: number;
  end: number;
  label: string;
  /** Markup inside (block bodies…) for a static preview. */
  preview?: MNode[];
  /** Kept but not shown (comments, scripts and styles between markup). */
  hidden?: boolean;
}

export type MNode = MElement | MText | MCode;

/** A parser adapter's result. */
export interface MarkupTree {
  nodes: MNode[];
  errors: string[];
}

/* ───────────────────────────── text helpers ───────────────────────────── */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', times: '×', laquo: '«',
  raquo: '»', larr: '←', rarr: '→', uarr: '↑', darr: '↓', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Source text → what the browser shows (entities decoded, whitespace collapsed). */
export function markupTextValue(raw: string): string {
  return decodeEntities(raw).replace(/[ \t\r\n\f]+/g, ' ');
}

function isWs(s: string): boolean {
  return /^[ \t\r\n\f]*$/.test(s);
}

/** Escape text for a dialect: HTML specials always; template syntax where the dialect reads it. */
export function escapeText(t: string, dialect: Dialect): string {
  let s = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (dialect === 'svelte' || dialect === 'angular') s = s.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
  if (dialect === 'angular') s = s.replace(/@/g, '&#64;');
  if (dialect === 'vue') s = s.replace(/\{\{/g, '&#123;&#123;').replace(/\}\}/g, '&#125;&#125;');
  return s;
}

export function escapeAttr(v: string, dialect: Dialect): string {
  let s = v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  if (dialect === 'svelte') s = s.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
  if (dialect === 'angular' || dialect === 'vue') s = s.replace(/\{\{/g, '&#123;&#123;');
  return s;
}

export function unescapeLiteral(s: string): string {
  return s.replace(/\\([`\\$])/g, '$1');
}

/** Text placed inside a JS template literal (Angular inline `template: \`…\``). */
export function escapeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/* ───────────────────────────── source tracking ───────────────────────────── */

export interface MarkupSrc {
  start: number;
  end: number;
  fp: string;
  /** Fingerprint of the element itself (tag, attributes, interactions) — not its children. */
  attrs?: string;
  /** Tag as written. */
  tag?: string;
  openEnd?: number;
  /** Content range (between the start and end tags). */
  inner?: [number, number];
  /** Original child ranges (non-whitespace), in order. */
  kids?: Array<[number, number]>;
  /** The element's content was one text run (edited as `props.children`). */
  textMode?: boolean;
}

const NON_SOURCE_PROPS = new Set(['preview', 'label', 'children']);

/** The element's own printed identity — everything but its content. */
export function attrsFingerprint(n: CanvasNode): string {
  const props: Record<string, unknown> = {};
  for (const k of Object.keys(n.props ?? {}).sort()) if (!NON_SOURCE_PROPS.has(k)) props[k] = n.props[k];
  let h = 0x811c9dc5;
  const s = JSON.stringify([n.type, props, n.bind ?? null, n.interactions ?? null]);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function track(n: CanvasNode, start: number, end: number, extra: Partial<MarkupSrc> = {}): CanvasNode {
  n.src = { start, end, fp: fingerprint(n), ...extra };
  return n;
}

const src = (n: CanvasNode): MarkupSrc | undefined => n.src;

/* ───────────────────────────── import ───────────────────────────── */

export interface MarkupImportContext {
  /** route → builder page id. */
  routes?: Record<string, string>;
  /** Resolve a link target (as written) to a page id — static HTML resolves relative files. */
  resolveLink?: (href: string) => string | undefined;
  /** Tag → builder symbol id (designer-made components). */
  symbols?: Record<string, string>;
}

const TAG_TO_TYPE: Record<string, string> = { a: 'link', img: 'img', hr: 'separator' };
/** Elements whose layout breaks if the canvas wraps their children: kept as code, previewed statically. */
const OPAQUE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'svg', 'path', 'g', 'iframe', 'video', 'audio', 'canvas', 'script', 'style', 'picture', 'source', 'template', 'slot', 'noscript', 'object', 'math', 'head', 'title', 'meta', 'link', 'base']);

/** Router-link components per dialect (tag → target attribute). */
const LINK_TAGS: Record<Dialect, Record<string, string>> = {
  vue: { RouterLink: 'to', 'router-link': 'to', NuxtLink: 'to', 'nuxt-link': 'to' },
  angular: {},
  svelte: {},
  html: {},
};

/** Attributes that make an element structural (conditionals, loops, slots) → opaque. */
function structural(dialect: Dialect, a: MAttr): boolean {
  const n = a.name;
  if (dialect === 'vue') return /^(v-if|v-else-if|v-else|v-for|v-slot|v-html|v-text|v-pre)$/.test(n) || n.startsWith('v-slot:') || n.startsWith('#');
  if (dialect === 'angular') return n.startsWith('*') || /^\[(innerHTML|outerHTML|innerText|textContent)\]$/.test(n);
  return false;
}

function normaliseRoute(href: string, dialect: Dialect): string {
  let h = href.trim();
  if (dialect === 'svelte' && h.startsWith('#/')) h = h.slice(1);
  if (dialect === 'angular' && !h.startsWith('/')) h = '/' + h;
  return h.replace(/[?#].*$/, '') || '/';
}

class MarkupConverter {
  constructor(private code: string, private dialect: Dialect, private ctx: MarkupImportContext, private literal = false) {}

  slice(s: number, e: number) {
    return this.code.slice(s, e);
  }

  /** Source text → value (inside a JS template literal, `\``, `\\` and `\$` are unescaped first). */
  textValue(raw: string): string {
    return markupTextValue(this.literal ? unescapeLiteral(raw) : raw);
  }

  pageFor(target: string): string | undefined {
    if (this.ctx.resolveLink) return this.ctx.resolveLink(target);
    return this.ctx.routes?.[normaliseRoute(target, this.dialect)];
  }

  list(nodes: MNode[], stat: boolean): CanvasNode[] {
    const out: CanvasNode[] = [];
    for (const n of nodes) {
      const c = this.node(n, stat);
      if (c) out.push(c);
    }
    return out;
  }

  /** Non-whitespace children with their (trimmed) ranges. */
  static kidsOf(code: string, nodes: MNode[]): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const n of nodes) {
      const r = rangeOf(code, n);
      if (r) out.push(r);
    }
    return out;
  }

  node(n: MNode, stat = false): CanvasNode | null {
    if (n.kind === 'text') {
      const r = rangeOf(this.code, n);
      if (!r) return null;
      const node: CanvasNode = { id: genId(), type: 'text', props: { children: this.textValue(this.slice(n.start, n.end)).trim() }, children: [], style: {} };
      return stat ? node : track(node, r[0], r[1]);
    }
    if (n.kind === 'code') return stat ? this.previewOnly(n) : this.chip(n);
    return this.element(n, stat);
  }

  chip(n: MCode | MElement, label?: string): CanvasNode {
    const [s, e] = rangeOf(this.code, n) ?? [n.start, n.end];
    const code = this.slice(s, e);
    const hidden = n.kind === 'code' && n.hidden;
    const node: CanvasNode = {
      id: genId(), type: 'code',
      props: { code, label: hidden ? 'comment' : label ?? (n.kind === 'code' ? n.label : summarizeMarkup(code)) },
      children: [], style: {},
    };
    if (!hidden) {
      const preview = n.kind === 'element' ? this.staticElement(n) : this.list(n.preview ?? [], true);
      const pv = Array.isArray(preview) ? preview : preview ? [preview] : [];
      if (pv.length) node.props.preview = pv;
    }
    return track(node, s, e);
  }

  previewOnly(n: MCode): CanvasNode | null {
    if (n.hidden) return null;
    const p = this.list(n.preview ?? [], true);
    if (!p.length) return { id: genId(), type: 'code', props: { code: this.slice(n.start, n.end), label: n.label }, children: [], style: {} };
    return p.length === 1 ? p[0] : { id: genId(), type: 'fragment', props: {}, children: p, style: {} };
  }

  /** Best-effort static rendering of an opaque element (for previews). */
  staticElement(el: MElement): CanvasNode | null {
    const plain = /^[a-z][a-z0-9]*$/.test(el.tag) && !el.component;
    if (!plain) return { id: genId(), type: 'div', props: { className: '' }, children: this.list(el.children, true), style: {} };
    if (['script', 'style', 'template', 'head', 'title', 'meta', 'link', 'base', 'noscript'].includes(el.tag)) return null;
    const cls = el.attrs.find((a) => a.name.toLowerCase() === 'class');
    const className = cls ? (cls.value ?? cls.staticParts ?? '') : '';
    const kids = this.list(el.children, true);
    const props: Record<string, unknown> = { className };
    const onlyText = kids.length === 1 && kids[0].type === 'text';
    if (onlyText) props.children = kids[0].props.children;
    if (el.tag === 'img') {
      props.src = el.attrs.find((a) => a.name === 'src')?.value ?? '';
      props.alt = el.attrs.find((a) => a.name === 'alt')?.value ?? '';
    }
    const type = TAG_TO_TYPE[el.tag] ?? el.tag;
    return { id: genId(), type, props, children: onlyText ? [] : kids, style: {} };
  }

  element(el: MElement, stat: boolean): CanvasNode | null {
    const d = this.dialect;
    const tag = el.tag;
    if (el.close === 'implicit' || el.opaque || el.attrs.some((a) => structural(d, a))) {
      return stat ? this.staticElement(el) : this.chip(el, el.opaque);
    }
    // Designer-made components used plainly: `<ProductCard />`.
    const symbolId = this.ctx.symbols?.[tag];
    if (symbolId && el.attrs.length === 0 && el.children.every((c) => c.kind === 'text' && isWs(this.slice(c.start, c.end)))) {
      const node: CanvasNode = { id: genId(), type: 'symbol', props: { symbolId }, children: [], style: {} };
      return stat ? node : track(node, el.start, el.end);
    }
    const linkAttrName = LINK_TAGS[d][tag];
    const isPlain = /^[a-z][a-z0-9]*$/.test(tag) && !el.component && !OPAQUE_TAGS.has(tag);
    if (!linkAttrName && !isPlain) return stat ? this.staticElement(el) : this.chip(el);

    const props: Record<string, unknown> = {};
    const rawAttrs: string[] = [];
    let target: string | null = null;
    for (const a of el.attrs) {
      const name = d === 'html' ? a.name.toLowerCase() : a.name;
      const raw = this.slice(a.start, a.end);
      const str = a.dynamic || a.value === null ? null : this.literal ? unescapeLiteral(a.value) : a.value;
      if (name === 'class' && !a.dynamic && str !== null && props.className === undefined) props.className = str;
      else if (name === 'class' && a.dynamic && props.classExpr === undefined) {
        props.classExpr = raw;
        props.className = a.staticParts ?? '';
      } else if (name === 'placeholder' && str !== null) props.placeholder = str;
      else if (name === 'type' && tag === 'input' && str !== null) props.inputType = str;
      else if (name === 'required' && !a.dynamic && (a.value === null || a.value === '' || a.value === 'required' || a.value === 'true')) props.required = true;
      else if ((name === 'src' || name === 'alt') && tag === 'img' && str !== null) props[name] = str;
      else if (linkAttrName && name === linkAttrName && str !== null) {
        props.linkTag = tag;
        props.linkAttr = name;
        props.to = str;
        target = str;
      } else if (tag === 'a' && d === 'angular' && name === 'routerLink' && str !== null) {
        props.linkAttr = 'routerLink';
        props.to = str;
        target = str;
      } else if (tag === 'a' && name === 'href' && str !== null && props.href === undefined) {
        props.href = str;
        if (d === 'svelte' || d === 'html') target = str;
      } else rawAttrs.push(raw);
    }
    if (linkAttrName && target === null) return stat ? this.staticElement(el) : this.chip(el);
    if (rawAttrs.length) props.rawAttrs = rawAttrs;

    let type = linkAttrName ? 'link' : TAG_TO_TYPE[tag] ?? tag;
    if (tag === 'input' && props.inputType === 'date') { type = 'date-input'; delete props.inputType; }

    let children: CanvasNode[] = [];
    let textMode = false;
    const real = el.children.filter((c) => !(c.kind === 'text' && isWs(this.slice(c.start, c.end))));
    if (tag === 'select') {
      const opts = real.filter((c): c is MElement => c.kind === 'element');
      const allStatic = real.length === opts.length && opts.every((o) => o.tag === 'option' && o.attrs.length === 0 && o.children.every((t) => t.kind === 'text'));
      if (!allStatic) return stat ? this.staticElement(el) : this.chip(el);
      props.options = opts.map((o) => this.textValue(o.children.map((t) => this.slice(t.start, t.end)).join('')).trim());
    } else if (real.length === 1 && real[0].kind === 'text') {
      props.children = this.textValue(this.slice(real[0].start, real[0].end)).trim();
      textMode = true;
    } else {
      children = this.list(el.children, stat);
    }

    const node: CanvasNode = { id: genId(), type, props, children, style: {} };
    const pageId = target !== null ? this.pageFor(target) : undefined;
    if (pageId) {
      node.interactions = [{ trigger: 'click', action: 'navigate', targetPageId: pageId }];
      // The page the link pointed at when imported: its target is rewritten only if that changes.
      props.linkPage = pageId;
    }
    if (stat) return node;
    const inner: [number, number] | undefined = el.closeStart !== null ? [el.openEnd, el.closeStart] : undefined;
    return track(node, el.start, el.end, {
      attrs: attrsFingerprint(node),
      tag,
      openEnd: el.openEnd,
      inner,
      kids: inner && tag !== 'select' ? MarkupConverter.kidsOf(this.code, el.children) : undefined,
      textMode,
    });
  }
}

/** A node's range without surrounding whitespace (text) — null for whitespace-only text. */
function rangeOf(code: string, n: MNode): [number, number] | null {
  if (n.kind === 'element' && n.close !== 'implicit') return [n.start, n.end];
  let s = n.start;
  let e = n.end;
  while (s < e && /\s/.test(code[s])) s++;
  while (e > s && /\s/.test(code[e - 1])) e--;
  if (s === e) return null;
  return [s, e];
}

export function summarizeMarkup(code: string): string {
  const one = code.replace(/\s+/g, ' ').trim();
  const m = one.match(/^<([A-Za-z][\w.:-]*)/);
  if (m) return `<${m[1]}${one.endsWith('/>') && one.length < 60 ? ' />' : '>'}`;
  return summarize(one);
}

export interface MarkupRegion {
  kind: 'markup';
  dialect: Dialect;
  /** File that holds the template (the page file, or an Angular `templateUrl`). */
  file: string;
  /** Template content range in `file`. */
  start: number;
  end: number;
  /** Root child ranges. */
  kids: Array<[number, number]>;
  /** Inside an Angular inline template literal: new text is escaped for it. */
  literal?: boolean;
  /** Indentation for root-level nodes when there are none to copy it from. */
  indent?: string;
}

export interface MarkupImported {
  ok: boolean;
  reason?: string;
  region?: MarkupRegion;
  nodes: CanvasNode[];
}

/** Convert a parsed template (roots inside `[start, end]` of `code`) to editable nodes. */
export function importMarkup(code: string, roots: MNode[], region: Omit<MarkupRegion, 'kids' | 'kind'>, ctx: MarkupImportContext = {}): MarkupImported {
  const conv = new MarkupConverter(code, region.dialect, ctx, !!region.literal);
  const nodes = conv.list(roots, false);
  return { ok: true, region: { kind: 'markup', ...region, kids: MarkupConverter.kidsOf(code, roots) }, nodes };
}

/* ───────────────────────────── printing ───────────────────────────── */

export interface Needs {
  /** Script imports: source → default / named. */
  imports: Map<string, { default?: string; named: Set<string> }>;
  /** Angular: classes for the component's `imports: [...]`. */
  ngImports: Set<string>;
  warnings: Set<string>;
}

export function newNeeds(): Needs {
  return { imports: new Map(), ngImports: new Set(), warnings: new Set() };
}

export interface MarkupPrintContext {
  dialect: Dialect;
  framework: Framework;
  /** Original file text (for unchanged nodes). Empty for new files. */
  source: string;
  filePath: string;
  /** builder page id → route (or, for static HTML, the page's file path). */
  routes: Record<string, string>;
  /** builder symbol id → how to use it. */
  symbols: Record<string, { name: string; path: string; tag: string; nodes?: CanvasNode[] }>;
  needs: Needs;
  literal?: boolean;
}

const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'area', 'col', 'embed', 'source', 'track', 'wbr', 'base', 'param']);

/** Adhar UI components the palette maps onto, per node type. */
const ADHAR_UI: Record<string, { comp: string; dir: string }> = {
  button: { comp: 'Button', dir: 'button' },
  input: { comp: 'Input', dir: 'input' },
  textarea: { comp: 'Textarea', dir: 'textarea' },
  badge: { comp: 'Badge', dir: 'badge' },
  'label-el': { comp: 'Label', dir: 'label' },
  separator: { comp: 'Separator', dir: 'separator' },
};

function adharFor(n: CanvasNode, ctx: MarkupPrintContext): { comp: string; dir: string } | null {
  if (!ctx.framework.adharUi || n.src) return null;
  if (n.type.startsWith('btn-')) return ADHAR_UI.button;
  return ADHAR_UI[n.type] ?? null;
}

const ADHAR_EXT: Record<Dialect, string> = { vue: 'vue', svelte: 'svelte', angular: 'ts', html: '' };

function needImport(ctx: MarkupPrintContext, source: string, spec: { default?: string; named?: string }) {
  const cur = ctx.needs.imports.get(source) ?? { named: new Set<string>() };
  if (spec.default) cur.default = spec.default;
  if (spec.named) cur.named.add(spec.named);
  ctx.needs.imports.set(source, cur);
}

/** `src/pages/a.html` → `src/about/index.html` ⇒ `../about/index.html`. */
export function relativePath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return '../'.repeat(a.length - i) + b.slice(i).join('/');
}

function text(t: string, ctx: MarkupPrintContext): string {
  const s = escapeText(t, ctx.dialect);
  return ctx.literal ? escapeLiteral(s) : s;
}

function attrVal(v: string, ctx: MarkupPrintContext): string {
  const s = escapeAttr(v, ctx.dialect);
  return ctx.literal ? escapeLiteral(s) : s;
}

/** Route (as the app serves it) of a page id; static HTML: the href from this file. */
function hrefFor(pageId: string, ctx: MarkupPrintContext): string | undefined {
  const r = ctx.routes[pageId];
  if (r === undefined) return undefined;
  if (ctx.dialect === 'html') return relativePath(ctx.filePath, r);
  return r;
}

function linkTagFor(n: CanvasNode, ctx: MarkupPrintContext, toPage: boolean): string {
  if (typeof n.props?.linkTag === 'string') return n.props.linkTag;
  if (ctx.dialect === 'vue' && toPage) return ctx.framework.id === 'nuxt' ? 'NuxtLink' : ctx.framework.router === 'vue-router' ? 'RouterLink' : 'a';
  return 'a';
}

export function tagOf(n: CanvasNode, ctx: MarkupPrintContext): string {
  // An imported element keeps its tag (the palette maps e.g. `section` to a div for NEW nodes only).
  const s = src(n);
  if (s?.tag && n.type !== 'link') {
    const imported = s.tag === 'input' && n.type === 'date-input' ? 'date-input' : TAG_TO_TYPE[s.tag] ?? s.tag;
    if (imported === n.type) return s.tag;
  }
  if (n.type === 'link') {
    const it = n.interactions?.find((i) => i.trigger === 'click' && i.action === 'navigate');
    return linkTagFor(n, ctx, !!(it?.targetPageId && ctx.routes[it.targetPageId] !== undefined));
  }
  if (n.type === 'img') return 'img';
  if (n.type === 'separator') return 'hr';
  const a = adharFor(n, ctx);
  if (a) return ctx.dialect === 'angular' ? `adhar-${a.dir}` : a.comp;
  return nodeToTag(n.type);
}

function navAttr(n: CanvasNode, ctx: MarkupPrintContext, tag: string): string {
  const it = n.interactions?.find((i) => i.trigger === 'click');
  if (!it) return '';
  const raw = (n.props?.rawAttrs as string[] | undefined) ?? [];
  if (raw.some((a) => /^(@click|v-on:click|\(click\)|on:click|onclick|routerLink|\[routerLink\])\b/i.test(a))) return '';
  if (n.type === 'link' && tag !== 'button') return '';
  const d = ctx.dialect;
  if (it.action === 'open-url' && it.url && /^https?:\/\//.test(it.url)) {
    const js = `window.open(${JSON.stringify(it.url).replace(/"/g, "'")}, '_blank')`;
    if (d === 'svelte') return ` onclick={() => ${js}}`;
    if (d === 'html') return ` onclick="${attrVal(js, ctx)}"`;
    ctx.needs.warnings.add(`“Open URL” interactions aren't written for ${ctx.framework.label} yet — wire them in code.`);
    return '';
  }
  if (it.action !== 'navigate' || !it.targetPageId) return '';
  const href = hrefFor(it.targetPageId, ctx);
  if (href === undefined) return '';
  const q = `'${href.replace(/'/g, "\\'")}'`;
  switch (d) {
    case 'vue':
      return ` @click="$router.push(${q})"`;
    case 'angular':
      ctx.needs.ngImports.add('RouterLink');
      needImport(ctx, '@angular/router', { named: 'RouterLink' });
      return ` routerLink="${attrVal(href, ctx)}"`;
    case 'svelte': {
      const ev = (ctx.framework.major ?? 5) >= 5 ? 'onclick' : 'on:click';
      if (ctx.framework.router === 'sveltekit') {
        needImport(ctx, '$app/navigation', { named: 'goto' });
        return ` ${ev}={() => goto(${q})}`;
      }
      if (ctx.framework.router === 'svelte-spa-router') {
        needImport(ctx, 'svelte-spa-router', { named: 'push' });
        return ` ${ev}={() => push(${q})}`;
      }
      return ` ${ev}={() => (window.location.href = ${q})}`;
    }
    case 'html':
      return ` onclick="location.href='${attrVal(href, ctx)}'"`;
  }
}

/** The start tag (`<tag attrs…>`, without the closing `>`) for an element node. */
function openTag(n: CanvasNode, ctx: MarkupPrintContext): { tag: string; head: string } {
  const p = n.props ?? {};
  const d = ctx.dialect;
  const it = n.interactions?.find((i) => i.trigger === 'click' && i.action === 'navigate');
  const route = n.type === 'link' && it?.targetPageId ? hrefFor(it.targetPageId, ctx) : undefined;
  const tag = tagOf(n, ctx);
  const adhar = adharFor(n, ctx);
  if (adhar) {
    if (d === 'angular') {
      ctx.needs.ngImports.add(adhar.comp);
      needImport(ctx, `${ctx.framework.adharUi}/components/${adhar.dir}/${adhar.comp}.ts`, { default: adhar.comp });
    } else needImport(ctx, `${ctx.framework.adharUi}/components/${adhar.dir}/${adhar.comp}.${ADHAR_EXT[d]}`, { default: adhar.comp });
  }
  let attrs = '';
  const classAttr = adhar ? 'className' : 'class';
  if (p.classExpr) attrs += ` ${p.classExpr}`;
  else if (typeof p.className === 'string' && p.className.trim()) attrs += ` ${classAttr}="${attrVal(p.className.trim(), ctx)}"`;
  if (n.type === 'link') {
    const linkAttr = typeof p.linkAttr === 'string' ? p.linkAttr
      : d === 'angular' && route !== undefined ? 'routerLink'
      : tag === 'a' ? 'href' : 'to';
    if (linkAttr === 'routerLink') {
      ctx.needs.ngImports.add('RouterLink');
      needImport(ctx, '@angular/router', { named: 'RouterLink' });
    }
    const written = typeof p.to === 'string' ? p.to : typeof p.href === 'string' ? p.href : undefined;
    const value = (written !== undefined && it?.targetPageId === p.linkPage ? written : route) ?? written ?? '#';
    attrs += ` ${linkAttr}="${attrVal(value, ctx)}"`;
    // A link that also had an href next to its router attribute keeps it verbatim (rawAttrs).
    if (linkAttr !== 'href' && typeof p.href === 'string' && typeof p.to === 'string' && tag === 'a') attrs += ` href="${attrVal(p.href, ctx)}"`;
  }
  if (tag === 'img') attrs += ` src="${attrVal(String(p.src ?? ''), ctx)}" alt="${attrVal(String(p.alt ?? ''), ctx)}"`;
  // An imported input without a type stays without one.
  if (n.type === 'date-input' || (n.type === 'input' && (p.inputType !== undefined || !n.src))) attrs += ` type="${attrVal(n.type === 'date-input' ? 'date' : String(p.inputType ?? 'text'), ctx)}"`;
  if (p.placeholder) attrs += ` placeholder="${attrVal(String(p.placeholder), ctx)}"`;
  if (p.required) attrs += ' required';
  for (const raw of (p.rawAttrs as string[] | undefined) ?? []) attrs += ` ${raw}`;
  attrs += navAttr(n, ctx, tag);
  return { tag, head: `<${tag}${attrs}` };
}

function wrap(open: string, close: string, kids: string[], indent: string): string {
  if (!kids.length) return `${open}${close}`;
  const inner = indent + '  ';
  return `${open}\n${kids.map((k) => inner + k).join('\n')}\n${indent}${close}`;
}

/** Print a node in full (unchanged descendants still print as their original text). */
export function printMarkupNode(n: CanvasNode, ctx: MarkupPrintContext, indent: string): string {
  const s = src(n);
  if (s && unchanged(n) && ctx.source) return ctx.source.slice(s.start, s.end);
  switch (n.type) {
    case 'code':
      return String(n.props?.code ?? '');
    case 'text':
      return text(String(n.props?.children ?? ''), ctx);
    case 'fragment':
      return n.children.map((c) => printMarkupNode(c, ctx, indent)).join(`\n${indent}`);
    case 'symbol': {
      const sym = ctx.symbols[String(n.props?.symbolId ?? '')];
      if (!sym) return '<!-- missing component -->';
      if (ctx.dialect === 'html') return (sym.nodes ?? []).map((c) => printMarkupNode(c, { ...ctx, source: '' }, indent)).join(`\n${indent}`);
      if (ctx.dialect === 'angular') {
        ctx.needs.ngImports.add(sym.name);
        needImport(ctx, relativeModule(ctx.filePath, sym.path), { named: sym.name });
      } else needImport(ctx, relativeModule(ctx.filePath, sym.path, true), { default: sym.name });
      return ctx.dialect === 'angular' ? `<${sym.tag}></${sym.tag}>` : `<${sym.tag} />`;
    }
  }
  return printElement(n, ctx, indent);
}

/** Import specifier for a repo file from another (`.vue` / `.svelte` keep their extension). */
export function relativeModule(from: string, to: string, keepExt = false): string {
  const r = relativePath(from, to);
  const p = r.startsWith('.') ? r : './' + r;
  return keepExt ? p : p.replace(/\.(tsx|ts|jsx|js)$/, '');
}

function printChildren(n: CanvasNode, ctx: MarkupPrintContext, indent: string): string[] {
  const kids: string[] = [];
  const t = typeof n.props?.children === 'string' ? n.props.children : '';
  if (t) kids.push(text(t, ctx));
  if (n.bind) ctx.needs.warnings.add(`Data bindings (repeaters) aren't written for ${ctx.framework.label} yet — the items were written once; loop over the data in code.`);
  for (const c of n.children) kids.push(printMarkupNode(c, ctx, indent + '  '));
  return kids;
}

function printElement(n: CanvasNode, ctx: MarkupPrintContext, indent: string): string {
  const p = n.props ?? {};
  const { tag, head } = openTag(n, ctx);
  const selfClose = ctx.dialect === 'html' ? '>' : ' />';
  switch (n.type) {
    case 'checkbox':
    case 'radio':
    case 'switch': {
      const t = typeof p.children === 'string' ? p.children : '';
      return `${head}>\n${indent}  <input type="${n.type === 'radio' ? 'radio' : 'checkbox'}"${n.type === 'switch' ? ' role="switch"' : ''}${p.name ? ` name="${attrVal(String(p.name), ctx)}"` : ''}${selfClose}\n${indent}  ${text(t, ctx)}\n${indent}</${tag}>`;
    }
    case 'select': {
      const opts = Array.isArray(p.options) ? (p.options as unknown[]).map(String) : [];
      return wrap(`${head}>`, `</${tag}>`, opts.map((o) => `<option>${text(o, ctx)}</option>`), indent);
    }
    case 'progress-bar':
      return `${head}>\n${indent}  <div class="h-full rounded-full bg-primary" style="width: ${Number(p['data-value'] ?? 66)}%"></div>\n${indent}</${tag}>`;
  }
  if (VOID.has(tag)) return `${head}${selfClose}`;
  const kids = printChildren(n, ctx, indent);
  if (!kids.length) return `${head}></${tag}>`;
  if (kids.length === 1 && !kids[0].includes('\n') && kids[0].length + head.length + tag.length < 100) return `${head}>${kids[0]}</${tag}>`;
  return wrap(`${head}>`, `</${tag}>`, kids, indent);
}

/** Print several root nodes (a new file's template), one per line. */
export function printMarkupRoots(nodes: CanvasNode[], ctx: MarkupPrintContext, indent: string): string {
  return nodes.map((n) => printMarkupNode(n, ctx, indent)).join(`\n${indent}`);
}

/* ───────────────────────────── splicing ───────────────────────────── */

export interface Edit {
  at: number;
  end: number;
  text: string;
}

/** Apply non-overlapping edits (replacements before insertions at the same offset). */
export function applyEdits(code: string, edits: Edit[]): string {
  let out = code;
  const sorted = [...edits].sort((a, b) => (b.at - a.at) || ((b.end - b.at) - (a.end - a.at)));
  for (const e of sorted) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return out;
}

class Splicer {
  edits: Edit[] = [];
  constructor(private code: string, private ctx: MarkupPrintContext) {}

  onOwnLine(at: number): boolean {
    const ls = this.code.lastIndexOf('\n', at - 1) + 1;
    return isWs(this.code.slice(ls, at));
  }

  /** Separator style between siblings: the whitespace between the first two, else newline+indent. */
  sepFor(kids: Array<[number, number]>, childIndent: string): string {
    for (let i = 1; i < kids.length; i++) {
      const between = this.code.slice(kids[i - 1][1], kids[i][0]);
      if (isWs(between)) return between.includes('\n') ? '\n' + lineIndent(this.code, kids[i][0]) : between;
    }
    if (kids.length && !this.onOwnLine(kids[0][0])) return ' ';
    return '\n' + childIndent;
  }

  list(cur: CanvasNode[], kids: Array<[number, number]>, inner: [number, number], parentIndent: string, childDefault = parentIndent + '  ') {
    const childIndent = kids.length && this.onOwnLine(kids[0][0]) ? lineIndent(this.code, kids[0][0]) : childDefault;
    const idx = cur.map((n) => {
      const s = src(n);
      return s ? kids.findIndex((k) => k[0] === s.start && k[1] === s.end) : -1;
    });
    const kept = idx.filter((i) => i >= 0);
    const ordered = kept.every((v, i) => i === 0 || v > kept[i - 1]);
    if (cur.length === kept.length && kept.length === kids.length && ordered) {
      // Same children in the same places: only descend.
      cur.forEach((n) => this.node(n));
      return;
    }
    if (cur.length === 0 && kids.length > 0) {
      // Everything removed: an empty element.
      this.edits.push({ at: inner[0], end: inner[1], text: '' });
      return;
    }
    if (!ordered || (kept.length === 0 && cur.length > 0)) {
      this.reprintInner(cur, kids, inner, parentIndent, childIndent);
      return;
    }
    const sep = this.sepFor(kids, childIndent);
    const keptSet = new Set(kept);
    // Removed children (with the whitespace that led up to them).
    kids.forEach((k, j) => {
      if (keptSet.has(j)) return;
      const floor = j > 0 ? kids[j - 1][1] : inner[0];
      let s = k[0];
      while (s > floor && /\s/.test(this.code[s - 1])) s--;
      if (j === 0 && keptSet.has(1)) {
        // First child: drop the whitespace after it instead, keeping the leading indentation.
        let e = k[1];
        while (e < kids[1][0] && /\s/.test(this.code[e])) e++;
        this.edits.push({ at: k[0], end: e, text: '' });
      } else this.edits.push({ at: s, end: k[1], text: '' });
    });
    // Kept children: descend. New ones: insert next to their kept neighbour.
    let run: CanvasNode[] = [];
    let prevKept: number | null = null;
    const flush = (nextKept: number | null) => {
      if (!run.length) return;
      if (prevKept !== null) {
        const anchor = kids[prevKept];
        const ind = this.onOwnLine(anchor[0]) ? lineIndent(this.code, anchor[0]) : childIndent;
        const s = sep.includes('\n') ? '\n' + ind : sep;
        this.edits.push({ at: anchor[1], end: anchor[1], text: run.map((n) => s + printMarkupNode(n, this.ctx, ind)).join('') });
      } else if (nextKept !== null) {
        const anchor = kids[nextKept];
        const ind = this.onOwnLine(anchor[0]) ? lineIndent(this.code, anchor[0]) : childIndent;
        const s = sep.includes('\n') ? '\n' + ind : sep;
        this.edits.push({ at: anchor[0], end: anchor[0], text: run.map((n) => printMarkupNode(n, this.ctx, ind) + s).join('') });
      }
      run = [];
    };
    cur.forEach((n, i) => {
      if (idx[i] < 0) { run.push(n); return; }
      flush(idx[i]);
      this.node(n);
      prevKept = idx[i];
    });
    flush(null);
  }

  reprintInner(cur: CanvasNode[], kids: Array<[number, number]>, inner: [number, number], parentIndent: string, childIndent: string) {
    const printed = cur.map((n) => printMarkupNode(n, this.ctx, childIndent));
    if (!kids.length) {
      const one = printed.length === 1 && !printed[0].includes('\n') && printed[0].length < 80 && !this.onOwnLine(inner[0]);
      const text = !printed.length ? '' : one ? printed[0] : `\n${childIndent}${printed.join(`\n${childIndent}`)}\n${parentIndent}`;
      this.edits.push({ at: inner[0], end: inner[1], text });
      return;
    }
    // The whitespace before the first and after the last child stays as it was.
    const sep = this.sepFor(kids, childIndent);
    this.edits.push({ at: kids[0][0], end: kids[kids.length - 1][1], text: printed.join(sep) });
  }

  node(n: CanvasNode) {
    if (unchanged(n)) return;
    const s = src(n);
    if (!s) return;
    const indent = lineIndent(this.code, s.start);
    if (n.type === 'text') {
      const t = String(n.props?.children ?? '').trim();
      this.edits.push({ at: s.start, end: s.end, text: text(t, this.ctx) });
      return;
    }
    if (n.type === 'code' || n.type === 'symbol' || s.attrs === undefined) {
      this.edits.push({ at: s.start, end: s.end, text: printMarkupNode(n, this.ctx, indent) });
      return;
    }
    const tagNow = tagOf(n, this.ctx);
    const textNow = typeof n.props?.children === 'string' && n.props.children !== '' && n.children.length === 0;
    const structuralOk = tagNow === s.tag && !n.bind && s.inner !== undefined && !['select', 'checkbox', 'radio', 'switch', 'progress-bar'].includes(n.type);
    if (!structuralOk) {
      // Void / self-closing elements whose children didn't change: the start tag is the whole element.
      if (tagNow === s.tag && s.inner === undefined && n.children.length === 0 && !(typeof n.props?.children === 'string' && n.props.children) && !n.bind) {
        if (attrsFingerprint(n) !== s.attrs) {
          const { head } = openTag(n, this.ctx);
          const tail = this.code.slice(s.start, s.end).endsWith('/>') ? ' />' : '>';
          this.edits.push({ at: s.start, end: s.end, text: head + tail });
        }
        return;
      }
      this.edits.push({ at: s.start, end: s.end, text: printMarkupNode(n, this.ctx, indent) });
      return;
    }
    if (attrsFingerprint(n) !== s.attrs) {
      const { head } = openTag(n, this.ctx);
      this.edits.push({ at: s.start, end: s.openEnd!, text: head + '>' });
    }
    const [a, b] = s.inner!;
    if (s.textMode && textNow && n.children.length === 0) {
      const before = this.code.slice(a, b);
      const lead = before.match(/^\s*/)![0];
      const trail = before.match(/\s*$/)![0];
      const t = text(String(n.props.children), this.ctx);
      if (markupTextValue(before).trim() !== String(n.props.children)) this.edits.push({ at: a + lead.length, end: b - trail.length, text: t });
      return;
    }
    if (s.textMode || textNow) {
      // Text ↔ children: rewrite the content.
      const kids = printChildren(n, this.ctx, indent);
      const one = kids.length === 1 && !kids[0].includes('\n');
      this.edits.push({ at: a, end: b, text: !kids.length ? '' : one ? kids[0] : `\n${kids.map((k) => indent + '  ' + k).join('\n')}\n${indent}` });
      return;
    }
    this.list(n.children, s.kids ?? [], [a, b], indent);
  }
}

/**
 * The edits that write a page's (possibly edited) nodes back into its
 * template — none when nothing changed.
 */
export function planMarkupSplice(code: string, region: MarkupRegion, nodes: CanvasNode[], ctx: Omit<MarkupPrintContext, 'source' | 'needs' | 'dialect' | 'literal'>): { edits: Edit[]; needs: Needs } {
  const needs = newNeeds();
  const full: MarkupPrintContext = { ...ctx, dialect: region.dialect, source: code, needs, literal: region.literal };
  const sp = new Splicer(code, full);
  const closeIndent = lineIndent(code, region.end);
  const childDefault = region.indent ?? (region.kids.length ? lineIndent(code, region.kids[0][0]) : closeIndent);
  sp.list(nodes, region.kids, [region.start, region.end], closeIndent, childDefault);
  return { edits: sp.edits, needs };
}

/** Script import lines for what printing needed (and the script doesn't import yet). */
export function scriptImportLines(needs: Needs, existing: string, semi = false): string[] {
  const lines: string[] = [];
  for (const [source, spec] of needs.imports) {
    const esc = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const has = (name: string) => new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s+['"]${esc}['"]`).test(existing);
    const named = [...spec.named].filter((n) => !has(n));
    const def = spec.default && !has(spec.default) ? spec.default : undefined;
    if (!def && !named.length) continue;
    const parts = [def, named.length ? `{ ${named.join(', ')} }` : ''].filter(Boolean).join(', ');
    lines.push(`import ${parts} from '${source}'${semi ? ';' : ''}`);
  }
  return lines;
}

/** Offset just after the last `import …` line inside `[from, to)` of `code` (or `from` itself). */
export function importOffset(code: string, from: number, to: number): number {
  const body = code.slice(from, to);
  const re = /^[ \t]*import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$|^[ \t]*import\s+['"][^'"]+['"];?[ \t]*$/gm;
  let at = -1;
  for (const m of body.matchAll(re)) at = (m.index ?? 0) + m[0].length;
  if (at < 0) return from;
  const nl = body.indexOf('\n', at);
  return from + (nl === -1 ? body.length : nl + 1);
}

export { fingerprint, unchanged };
