/**
 * Source → builder nodes, for a page component in a repository.
 *
 * Finds the component's returned JSX and converts it:
 *
 *   • Plain HTML elements (`<div>`, `<button>`, `<input>`, …), router links
 *     with a static target, fragments and static text become EDITABLE nodes.
 *     Attributes the designer doesn't model (handlers, `key`, `aria-*`,
 *     spreads, …) ride along verbatim in `props.rawAttrs`; a computed
 *     `className={cn(...)}` is kept verbatim in `props.classExpr`.
 *   • Everything else — `{expressions}`, `.map()`s, conditionals, custom
 *     components, tables — becomes an OPAQUE `code` node holding the exact
 *     source text, with a best-effort static preview of any JSX inside it.
 *
 * Every node records its source range and a fingerprint of what it looked like
 * when imported (`src`). The printer emits untouched nodes as their original
 * text, so only what the designer actually changed is ever rewritten.
 */

import { genId, type CanvasNode } from '../lib/builder-types.ts';
import { attrName, jsxName, parseModule, staticString, walk, type Node, type ParseFn } from './ast.ts';

export interface ComponentRegion {
  /** Component function name (or `default`). */
  name: string;
  /** Range of the returned root JSX expression (parentheses excluded). */
  jsxStart: number;
  jsxEnd: number;
  /** Offset just inside the function body `{` (for hooks); null for expression-bodied arrows. */
  bodyStart: number | null;
  /** Indentation of the line the JSX starts on. */
  indent: string;
  /** Indentation of the component function's own line (hooks go one level in). */
  fnIndent: string;
}

export interface ImportedPage {
  ok: boolean;
  /** Why the page can't be edited visually (no component / no JSX found / parse error). */
  reason?: string;
  region?: ComponentRegion;
  nodes: CanvasNode[];
}

export interface ImportContext {
  /** route → builder page id, for turning `<Link to>` into navigate interactions. */
  routes?: Record<string, string>;
  /** Component name → builder symbol id (designer-made components, see .adhar/designer). */
  symbols?: Record<string, string>;
  /** Import a specific export instead of the default one (e.g. a router's named page component). */
  exportName?: string;
}

/* ───────────────────────────── fingerprints ───────────────────────────── */

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Props that are designer-only (never printed) and so never count as a change. */
const NON_SOURCE_PROPS = new Set(['preview', 'label']);

/**
 * What a node "is" for printing purposes: everything that would change the
 * emitted source, nothing that wouldn't (ids, layer names, lock/hide, ranges).
 */
export function fingerprint(n: CanvasNode): string {
  const props: Record<string, unknown> = {};
  for (const k of Object.keys(n.props ?? {}).sort()) if (!NON_SOURCE_PROPS.has(k)) props[k] = n.props[k];
  return fnv(JSON.stringify([n.type, props, n.bind ?? null, n.interactions ?? null, n.children.map(fingerprint)]));
}

export function withFingerprint(n: CanvasNode, start: number, end: number): CanvasNode {
  n.src = { start, end, fp: fingerprint(n) };
  return n;
}

/** True when a node (and its subtree) is exactly as imported. */
export function unchanged(n: CanvasNode): boolean {
  return !!n.src && n.src.fp === fingerprint(n);
}

/* ───────────────────────────── conversion ───────────────────────────── */

const TAG_TO_TYPE: Record<string, string> = { a: 'link', img: 'img', hr: 'separator' };
/** Elements whose layout breaks if the canvas wraps their children: kept as code, previewed statically. */
const OPAQUE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'svg', 'path', 'g', 'iframe', 'video', 'audio', 'canvas', 'script', 'style', 'picture', 'source']);
const LINK_COMPONENTS = new Set(['Link', 'NavLink']);

/** JSX text → the string React renders (JSX whitespace rules, simplified). */
export function jsxTextValue(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 1) return raw.replace(/[ \t]+/g, ' ');
  return lines
    .map((l, i) => (i === 0 ? l.replace(/\s+$/, '') : i === lines.length - 1 ? l.replace(/^\s+/, '') : l.trim()))
    .filter((l) => l.length > 0)
    .join(' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Best-effort static classes for canvas display only: plain strings, template
 * text, and the unconditional string arguments of `cn(…)` / `clsx(…)`.
 * Conditional classes (`cond && 'x'`, `{ x: cond }`) are left out.
 */
export function staticClassesOf(expr: Node): string {
  const out: string[] = [];
  const take = (n: Node) => {
    if (n.type === 'StringLiteral') out.push(n.value);
    else if (n.type === 'TemplateLiteral') out.push(n.quasis.map((q: Node) => q.value.cooked ?? '').join(' '));
  };
  if (expr.type === 'CallExpression') expr.arguments.forEach(take);
  else take(expr);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

class Converter {
  constructor(private code: string, private ctx: ImportContext) {}

  slice(n: Node): string {
    return this.code.slice(n.start, n.end);
  }

  children(nodes: Node[], stat: boolean): CanvasNode[] {
    const out: CanvasNode[] = [];
    for (const c of nodes) {
      const conv = this.node(c, stat);
      if (conv) out.push(conv);
    }
    return out;
  }

  /** `stat` = static preview conversion (no source tracking, everything best-effort). */
  node(n: Node, stat = false): CanvasNode | null {
    switch (n.type) {
      case 'JSXText': {
        const text = jsxTextValue(n.value);
        if (!text.trim()) return null;
        const node: CanvasNode = { id: genId(), type: 'text', props: { children: text }, children: [], style: {} };
        return stat ? node : withFingerprint(node, n.start, n.end);
      }
      case 'JSXExpressionContainer': {
        if (n.expression.type === 'JSXEmptyExpression') {
          // A JSX comment `{/* … */}` — preserved, invisible.
          return stat ? null : this.code_(n, 'comment');
        }
        const lit = literalText(n);
        if (lit !== null) {
          // `{"text"}` / `{' '}` is just text.
          const node: CanvasNode = { id: genId(), type: 'text', props: { children: lit }, children: [], style: {} };
          return stat ? node : withFingerprint(node, n.start, n.end);
        }
        return stat ? this.previewOnly(n) : this.code_(n);
      }
      case 'JSXFragment': {
        const node: CanvasNode = { id: genId(), type: 'fragment', props: {}, children: this.children(n.children, stat), style: {} };
        return stat ? node : withFingerprint(node, n.start, n.end);
      }
      case 'JSXElement':
        return this.element(n, stat);
      case 'JSXSpreadChild':
        return stat ? null : this.code_(n);
      default:
        return null;
    }
  }

  element(n: Node, stat: boolean): CanvasNode | null {
    const tag = jsxName(n.openingElement.name);
    const attrs: Node[] = n.openingElement.attributes;

    // Designer-made components (symbols) used plainly: `<ProductCard />`.
    const symbolId = this.ctx.symbols?.[tag];
    if (symbolId && attrs.length === 0 && n.children.every((c: Node) => c.type === 'JSXText' && !c.value.trim())) {
      const node: CanvasNode = { id: genId(), type: 'symbol', props: { symbolId }, children: [], style: {} };
      return stat ? node : withFingerprint(node, n.start, n.end);
    }

    const isLink = LINK_COMPONENTS.has(tag);
    const isHtml = /^[a-z][a-z0-9-]*$/.test(tag) && !OPAQUE_TAGS.has(tag);
    if (!isHtml && !isLink) return stat ? this.staticCustom(n) : this.code_(n);

    const props: Record<string, unknown> = {};
    const rawAttrs: string[] = [];
    let target: string | null = null;
    for (const a of attrs) {
      const name = attrName(a);
      const str = a.type === 'JSXAttribute' ? staticString(a.value) : null;
      if (name === 'className') {
        if (str !== null) props.className = str;
        else if (a.value?.type === 'JSXExpressionContainer') {
          props.classExpr = this.slice(a.value.expression);
          props.className = staticClassesOf(a.value.expression);
        } else rawAttrs.push(this.slice(a));
      } else if (name === 'placeholder' && str !== null) props.placeholder = str;
      else if (name === 'type' && tag === 'input' && str !== null) props.inputType = str;
      else if (name === 'required' && (a.value === null || (a.value?.type === 'JSXExpressionContainer' && a.value.expression.type === 'BooleanLiteral' && a.value.expression.value))) props.required = true;
      else if ((name === 'src' || name === 'alt') && tag === 'img' && str !== null) props[name] = str;
      else if (name === 'href' && tag === 'a' && str !== null) props.href = str;
      else if ((name === 'to' || name === 'href') && isLink && str !== null) {
        props.linkTag = tag;
        props.linkAttr = name;
        props.to = str;
        target = str;
      } else rawAttrs.push(this.slice(a));
    }
    if (isLink && target === null) return stat ? this.staticCustom(n) : this.code_(n);
    if (rawAttrs.length) props.rawAttrs = rawAttrs;

    let type = isLink ? 'link' : TAG_TO_TYPE[tag] ?? tag;
    if (tag === 'input' && props.inputType === 'date') { type = 'date-input'; delete props.inputType; }

    let children: CanvasNode[] = [];
    const kids: Node[] = n.children;
    if (tag === 'select') {
      const opts = kids.filter((c) => c.type === 'JSXElement');
      const allStatic = opts.every((o) => jsxName(o.openingElement.name) === 'option' && o.children.every((t: Node) => t.type === 'JSXText'))
        && kids.every((c) => c.type === 'JSXElement' || (c.type === 'JSXText' && !c.value.trim()));
      if (!allStatic) return stat ? this.staticCustom(n) : this.code_(n);
      props.options = opts.map((o) => jsxTextValue(o.children.map((t: Node) => t.value).join('')).trim());
    } else {
      const real = kids.filter((c) => !(c.type === 'JSXText' && !jsxTextValue(c.value).trim()));
      if (real.length === 1 && real[0].type === 'JSXText') {
        props.children = jsxTextValue(real[0].value).trim();
      } else if (real.length === 1 && literalText(real[0]) !== null) {
        props.children = literalText(real[0]);
      } else {
        children = this.children(kids, stat);
      }
    }

    // A router link to a known page drives the prototype's navigation.
    const node: CanvasNode = { id: genId(), type, props, children, style: {} };
    const pageId = target !== null ? this.ctx.routes?.[target] : undefined;
    if (pageId) node.interactions = [{ trigger: 'click', action: 'navigate', targetPageId: pageId }];
    return stat ? node : withFingerprint(node, n.start, n.end);
  }

  /** Opaque code, with a static preview of the JSX inside it when there is any. */
  code_(n: Node, label?: string): CanvasNode {
    const code = this.slice(n);
    const node: CanvasNode = { id: genId(), type: 'code', props: { code, label: label ?? summarize(code) }, children: [], style: {} };
    const preview = this.preview(n);
    if (preview.length) node.props.preview = preview;
    return withFingerprint(node, n.start, n.end);
  }

  preview(n: Node): CanvasNode[] {
    if (n.type === 'JSXElement') {
      const tag = jsxName(n.openingElement.name);
      if (/^[a-z]/.test(tag)) {
        const el = this.element(n, true);
        return el ? [el] : [];
      }
      return this.children(n.children, true);
    }
    // First JSX inside an expression: the template of a `.map()`, a branch of a conditional…
    let found: Node | null = null;
    walk(n, (c) => {
      if (found) return false;
      if (c !== n && (c.type === 'JSXElement' || c.type === 'JSXFragment')) {
        found = c;
        return false;
      }
    });
    if (!found) return [];
    const conv = this.node(found, true);
    return conv ? [conv] : [];
  }

  previewOnly(n: Node): CanvasNode | null {
    const p = this.preview(n);
    if (!p.length) return { id: genId(), type: 'code', props: { code: this.slice(n), label: summarize(this.slice(n)) }, children: [], style: {} };
    return p.length === 1 ? p[0] : { id: genId(), type: 'fragment', props: {}, children: p, style: {} };
  }

  staticCustom(n: Node): CanvasNode {
    const kids = this.children(n.children, true);
    return { id: genId(), type: 'div', props: { className: '' }, children: kids, style: {} };
  }
}

/** The string of `{"x"}` / `{'x'}` / `` {`x`} `` (no expressions), else null. */
function literalText(n: Node): string | null {
  if (n.type !== 'JSXExpressionContainer') return null;
  const e = n.expression;
  if (e.type === 'StringLiteral') return e.value;
  if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return e.quasis.map((q: Node) => q.value.cooked).join('');
  return null;
}

export function summarize(code: string): string {
  const one = code.replace(/\s+/g, ' ').trim();
  const m = one.match(/^<([A-Za-z][\w.]*)/);
  if (m) return `<${m[1]}${one.endsWith('/>') && one.length < 60 ? ' />' : '>'}`;
  return one.length > 48 ? `${one.slice(0, 45)}…` : one;
}

/* ───────────────────────────── component lookup ───────────────────────────── */

function functionOf(decl: Node, program: Node): Node | null {
  if (!decl) return null;
  if (decl.type === 'FunctionDeclaration' || decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') return decl;
  if (decl.type === 'CallExpression') {
    // export default memo(Page) / forwardRef(...)
    for (const a of decl.arguments) {
      const f = functionOf(a, program);
      if (f) return f;
    }
  }
  if (decl.type === 'Identifier') return findLocal(program, decl.name);
  if (decl.type === 'TSAsExpression' || decl.type === 'TSSatisfiesExpression') return functionOf(decl.expression, program);
  return null;
}

function findLocal(program: Node, name: string): Node | null {
  for (const st0 of program.body) {
    const st = st0.type === 'ExportNamedDeclaration' && st0.declaration ? st0.declaration : st0;
    if (st.type === 'FunctionDeclaration' && st.id?.name === name) return st;
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) if (d.id?.name === name) return functionOf(d.init, program);
    }
  }
  return null;
}

function componentFunction(program: Node, exportName?: string): { fn: Node; name: string } | null {
  if (exportName && exportName !== 'default') {
    const fn = findLocal(program, exportName);
    return fn ? { fn, name: exportName } : null;
  }
  for (const st of program.body) {
    if (st.type === 'ExportDefaultDeclaration') {
      const fn = functionOf(st.declaration, program);
      if (fn) return { fn, name: st.declaration.id?.name ?? st.declaration.name ?? 'default' };
    }
  }
  // No default export: the first exported (capitalised) function component.
  for (const st of program.body) {
    if (st.type === 'ExportNamedDeclaration' && st.declaration) {
      const d = st.declaration;
      if (d.type === 'FunctionDeclaration' && /^[A-Z]/.test(d.id?.name ?? '')) return { fn: d, name: d.id.name };
      if (d.type === 'VariableDeclaration') {
        for (const v of d.declarations) {
          const fn = functionOf(v.init, program);
          if (fn && /^[A-Z]/.test(v.id?.name ?? '')) return { fn, name: v.id.name };
        }
      }
    }
  }
  return null;
}

const isJsx = (n: Node) => n && (n.type === 'JSXElement' || n.type === 'JSXFragment');

function returnedJsx(fn: Node): { jsx: Node; bodyStart: number | null } | null {
  if (fn.body?.type !== 'BlockStatement') return isJsx(fn.body) ? { jsx: fn.body, bodyStart: null } : null;
  let last: Node | null = null;
  for (const st of fn.body.body) if (st.type === 'ReturnStatement' && isJsx(st.argument)) last = st.argument;
  return last ? { jsx: last, bodyStart: fn.body.start + 1 } : null;
}

export function lineIndent(code: string, offset: number): string {
  const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
  return (code.slice(lineStart).match(/^[ \t]*/) ?? [''])[0];
}

/** Import one page component's JSX from `code`. */
export function importPage(parse: ParseFn, code: string, path: string, ctx: ImportContext = {}): ImportedPage {
  let ast: Node;
  try {
    ast = parseModule(parse, code, path);
  } catch (e) {
    return { ok: false, reason: `Could not parse ${path}: ${e instanceof Error ? e.message : String(e)}`, nodes: [] };
  }
  const comp = componentFunction(ast.program, ctx.exportName);
  if (!comp) return { ok: false, reason: 'No React component found to edit.', nodes: [] };
  const ret = returnedJsx(comp.fn);
  if (!ret) return { ok: false, reason: `${comp.name} does not return JSX directly.`, nodes: [] };
  const conv = new Converter(code, ctx);
  const root = conv.node(ret.jsx);
  return {
    ok: true,
    region: { name: comp.name, jsxStart: ret.jsx.start, jsxEnd: ret.jsx.end, bodyStart: ret.bodyStart, indent: lineIndent(code, ret.jsx.start), fnIndent: lineIndent(code, comp.fn.start) },
    nodes: root ? [root] : [],
  };
}
