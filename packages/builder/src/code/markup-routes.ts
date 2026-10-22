/**
 * Pages and routes for the non-React frameworks — discovery and wiring.
 *
 *   • Angular      the Router config (`Routes` arrays, `provideRouter([...])`,
 *                  `RouterModule.forRoot/forChild([...])`), `component` and lazy
 *                  `loadComponent`, nested `children`, lazy `loadChildren` files
 *   • Vue          vue-router `routes` (`component: X` or `() => import(…)`);
 *                  Nuxt `pages/**` file routes
 *   • Svelte       SvelteKit `src/routes/**\/+page.svelte`; svelte-spa-router
 *                  route objects; svelte-routing `<Route path component>`
 *   • Solid        SolidStart `src/routes/**` file routes (the @solidjs/router
 *                  config is read by the React Router reader)
 *   • static HTML  every `.html` page; links between them are the routes
 *
 * Pure: file contents are passed in by the caller.
 */

import type { Framework } from './framework.ts';
import { importsOf, walk, type Node, type ParseFn } from './ast.ts';
import type { PageRef } from './routes.ts';

const at = (root: string, p: string) => (root ? `${root}/${p}` : p);
const within = (root: string, paths: string[]) => (root ? paths.filter((p) => p.startsWith(root + '/')).map((p) => p.slice(root.length + 1)) : paths);

export function sortRoutes(list: PageRef[]): PageRef[] {
  return list.sort((a, b) => (a.route === '/' ? -1 : b.route === '/' ? 1 : a.route.localeCompare(b.route)));
}

/** Parse TS/JS (decorators allowed) — null on failure. */
export function parseScript(parse: ParseFn, code: string, path: string): Node | null {
  const ts = /\.(ts|tsx|mts|cts)$/.test(path) || path.endsWith('.svelte') || path.endsWith('.vue');
  try {
    return parse(code, { sourceType: 'module', plugins: ts ? ['typescript', 'decorators-legacy'] : ['jsx', 'decorators-legacy'], errorRecovery: true });
  } catch {
    return null;
  }
}

/** Resolve an import specifier to an existing repo path, trying the given extensions. */
export function resolveSpec(from: string, spec: string, paths: Set<string>, alias: Record<string, string>, exts: string[]): string | null {
  let base: string;
  if (spec.startsWith('.')) {
    const dir = from.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') dir.pop();
      else dir.push(seg);
    }
    base = dir.join('/');
  } else {
    const key = Object.keys(alias).find((a) => spec === a || spec.startsWith(a + '/'));
    if (!key) return null;
    base = alias[key] + spec.slice(key.length);
  }
  for (const cand of [base, ...exts.map((e) => `${base}.${e}`), ...exts.map((e) => `${base}/index.${e}`)]) if (paths.has(cand)) return cand;
  return null;
}

function joinRoute(parent: string, child: string): string {
  if (child.startsWith('/')) return child.replace(/\/+$/, '') || '/';
  const p = parent === '/' ? '' : parent;
  return child ? `${p}/${child}`.replace(/\/+$/, '') || '/' : parent || '/';
}

const prop = (obj: Node, k: string) => obj.properties?.find((p: Node) => (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') && (p.key?.name === k || p.key?.value === k));
const strOf = (n: Node): string | null => (n?.type === 'StringLiteral' ? n.value : n?.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked : null);
const unwrapTs = (n: Node): Node => (n && /^TS(As|Satisfies|NonNull)Expression$|^TSTypeAssertion$/.test(n.type) ? unwrapTs(n.expression) : n);

/** `() => import('./x')` / `() => import('./x').then(m => m.X)` → { spec, export }. */
export function lazyImport(n: Node): { spec: string; exportName?: string } | null {
  if (!n) return null;
  if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
    let body = n.body;
    if (body?.type === 'BlockStatement') body = body.body.find((s: Node) => s.type === 'ReturnStatement')?.argument;
    return lazyImport(body);
  }
  if (n.type === 'CallExpression' && n.callee?.type === 'Import') {
    const spec = strOf(n.arguments[0]);
    return spec ? { spec } : null;
  }
  if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && n.callee.property?.name === 'then') {
    const inner = lazyImport(n.callee.object);
    const fn = n.arguments[0];
    const body = fn?.body?.type === 'MemberExpression' ? fn.body : null;
    if (inner) return { spec: inner.spec, exportName: body?.property?.name };
  }
  // lazy(() => import('./x')), defineAsyncComponent(() => import(…))
  if (n.type === 'CallExpression' && n.arguments.length === 1) return lazyImport(n.arguments[0]);
  return null;
}

/* ───────────────────────────── object route configs ───────────────────────────── */

interface RouteArray {
  node: Node;
  kind: 'angular' | 'vue' | 'solid';
}

/** The top-level route arrays of a router file (Angular `Routes`, vue-router `routes`, Solid configs). */
function routeArrays(ast: Node, kind: RouteArray['kind']): Node[] {
  const out: Node[] = [];
  const byName = new Map<string, Node>();
  walk(ast.program, (n) => {
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier') {
      const init = unwrapTs(n.init);
      if (init?.type === 'ArrayExpression') byName.set(n.id.name, init);
    }
  });
  const isRouteArray = (arr: Node) => arr?.type === 'ArrayExpression' && arr.elements.some((e: Node) => e?.type === 'ObjectExpression' && prop(e, 'path'));
  const add = (arr: Node) => { if (isRouteArray(arr) && !out.includes(arr)) out.push(arr); };
  walk(ast.program, (n) => {
    // Typed: `const routes: Routes = [...]`
    if (n.type === 'VariableDeclarator' && n.id?.typeAnnotation) {
      const t = n.id.typeAnnotation.typeAnnotation;
      const name = t?.typeName?.name ?? t?.elementType?.typeName?.name;
      if (/^(Routes|Route|RouteRecordRaw|RouteDefinition)$/.test(name ?? '')) add(unwrapTs(n.init));
    }
    if (n.type === 'CallExpression') {
      const callee = n.callee?.type === 'MemberExpression' ? n.callee.property?.name : n.callee?.name;
      if (/^(provideRouter|forRoot|forChild|createRouter|createBrowserRouter)$/.test(callee ?? '')) {
        const a0 = unwrapTs(n.arguments[0]);
        if (a0?.type === 'ArrayExpression') add(a0);
        else if (a0?.type === 'Identifier' && byName.has(a0.name)) add(byName.get(a0.name));
        else if (a0?.type === 'ObjectExpression') {
          // createRouter({ routes }) / createRouter({ routes: [...] })
          const r = prop(a0, 'routes');
          const v = unwrapTs(r?.value);
          if (v?.type === 'ArrayExpression') add(v);
          else if (v?.type === 'Identifier' && byName.has(v.name)) add(byName.get(v.name));
          else if (r?.shorthand && byName.has('routes')) add(byName.get('routes'));
        }
      }
    }
    // `export default [...]` / `export const routes = [...]`
    if (n.type === 'ExportDefaultDeclaration') add(unwrapTs(n.declaration));
  });
  if (!out.length) {
    for (const [name, arr] of byName) if (/routes?$/i.test(name)) add(arr);
  }
  void kind;
  return out;
}

export interface ObjectRoutesResult {
  pages: PageRef[];
  /** Lazy child route files to read next (Angular `loadChildren`): file + route prefix + export. */
  pending: Array<{ path: string; prefix: string; exportName?: string }>;
}

/**
 * Pages declared in object route configs (Angular, vue-router, Solid).
 * `componentKeys` name the properties holding the page component.
 */
export function objectRoutes(
  parse: ParseFn, code: string, file: string, paths: string[], alias: Record<string, string>,
  opts: { kind: RouteArray['kind']; exts: string[]; prefix?: string; exportName?: string },
): ObjectRoutesResult {
  const ast = parseScript(parse, code, file);
  if (!ast) return { pages: [], pending: [] };
  const imports = importsOf(ast.program);
  const set = new Set(paths);
  const out: PageRef[] = [];
  const pending: ObjectRoutesResult['pending'] = [];
  const localLazy = new Map<string, Node>();
  walk(ast.program, (n) => {
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init && lazyImport(n.init)) localLazy.set(n.id.name, n.init);
  });

  const resolveComponent = (v: Node): PageRef | null => {
    v = unwrapTs(v);
    if (!v) return null;
    if (v.type === 'Identifier') {
      const imp = imports.find((i) => i.local === v.name);
      if (imp) {
        const p = resolveSpec(file, imp.source, set, alias, opts.exts);
        return p ? { route: '', path: p, exportName: imp.isDefault ? undefined : v.name } : null;
      }
      const lz = localLazy.get(v.name);
      if (lz) return resolveComponent(lz);
      return null;
    }
    const lz = lazyImport(v);
    if (lz) {
      const p = resolveSpec(file, lz.spec, set, alias, opts.exts);
      return p ? { route: '', path: p, exportName: lz.exportName } : null;
    }
    return null;
  };

  const visit = (arr: Node, parent: string) => {
    for (const el of arr.elements) {
      if (el?.type !== 'ObjectExpression') continue;
      const pathP = prop(el, 'path');
      const raw = strOf(pathP?.value);
      if (raw === null || raw === '**' || raw.includes('*') || prop(el, 'redirectTo') || prop(el, 'redirect')) {
        const kids = unwrapTs(prop(el, 'children')?.value);
        if (kids?.type === 'ArrayExpression' && raw !== null && raw !== '**') visit(kids, joinRoute(parent, raw));
        continue;
      }
      const route = joinRoute(parent, raw);
      for (const key of ['component', 'loadComponent', 'Component', 'element']) {
        const c = prop(el, key);
        if (!c) continue;
        const ref = resolveComponent(c.type === 'ObjectMethod' ? c : c.value);
        // One component per file in Angular / Vue: the page is the file (no `#Export` suffix).
        if (ref && opts.kind !== 'solid') delete ref.exportName;
        if (ref && !out.some((o) => o.route === route)) out.push({ ...ref, route: route.replace(/:(\w+)\(.*?\)\??/g, ':$1') });
        break;
      }
      const lc = prop(el, 'loadChildren');
      if (lc) {
        const lz = lazyImport(lc.value);
        const p = lz ? resolveSpec(file, lz.spec, set, alias, opts.exts) : null;
        if (p) pending.push({ path: p, prefix: route, exportName: lz?.exportName });
      }
      const kids = unwrapTs(prop(el, 'children')?.value);
      if (kids?.type === 'ArrayExpression') visit(kids, route);
    }
  };
  let arrays = routeArrays(ast, opts.kind);
  if (opts.exportName) {
    const named = arrays.filter((a) => {
      let hit = false;
      walk(ast.program, (n) => { if (n.type === 'VariableDeclarator' && n.id?.name === opts.exportName && unwrapTs(n.init) === a) hit = true; });
      return hit;
    });
    if (named.length) arrays = named;
  }
  for (const a of arrays) visit(a, opts.prefix ?? '');
  return { pages: sortRoutes(out), pending };
}

/* ───────────────────────────── file-based routes ───────────────────────────── */

function segRoute(segs: string[]): string {
  const out = segs
    .filter((s) => s && !/^\(.*\)$/.test(s))
    .map((s) => s.replace(/^\[\[(.+)\]\]$/, ':$1?').replace(/^\[\.\.\.(.+)\]$/, '*').replace(/^\[(.+)\]$/, ':$1'));
  return '/' + out.join('/');
}

/** SvelteKit `src/routes/**\/+page.svelte`. */
export function svelteKitPages(fw: Framework, paths: string[]): PageRef[] {
  const out: PageRef[] = [];
  for (const p of within(fw.root, paths)) {
    const m = p.match(/^src\/routes\/(?:(.*)\/)?\+page\.svelte$/);
    if (m) out.push({ route: segRoute((m[1] ?? '').split('/')), path: at(fw.root, p) });
  }
  return sortRoutes(out);
}

/** Nuxt `pages/**\/*.vue` (Nuxt 3 root, Nuxt 4 `app/`, or `src/`). */
export function nuxtPages(fw: Framework, paths: string[]): PageRef[] {
  const out: PageRef[] = [];
  for (const p of within(fw.root, paths)) {
    const m = p.match(/^(?:app\/|src\/)?pages\/(.+)\.vue$/);
    if (!m) continue;
    const segs = m[1].split('/');
    if (segs[segs.length - 1] === 'index') segs.pop();
    out.push({ route: segRoute(segs), path: at(fw.root, p) });
  }
  if (!out.length) {
    for (const n of ['app.vue', 'app/app.vue', 'src/app.vue']) if (paths.includes(at(fw.root, n))) return [{ route: '/', path: at(fw.root, n) }];
  }
  return sortRoutes(out);
}

/** SolidStart `src/routes/**\/*.tsx|jsx`. */
export function solidStartPages(fw: Framework, paths: string[]): PageRef[] {
  const out: PageRef[] = [];
  for (const p of within(fw.root, paths)) {
    const m = p.match(/^src\/routes\/(.+)\.(tsx|jsx)$/);
    if (!m) continue;
    const segs = m[1].split('/');
    if (segs.some((s) => s.startsWith('_'))) continue;
    if (segs[segs.length - 1] === 'index') segs.pop();
    out.push({ route: segRoute(segs), path: at(fw.root, p) });
  }
  return sortRoutes(out);
}

const HTML_SKIP = /(^|\/)(node_modules|dist|build|out|vendor|coverage|\.git|\.github|public\/vendor)\//;

/** Every HTML page of a static site — `index.html` is `/`, others are their path. */
export function htmlPages(fw: Framework, paths: string[]): PageRef[] {
  const out: PageRef[] = [];
  for (const p of within(fw.root, paths)) {
    if (!/\.html?$/.test(p) || HTML_SKIP.test(p)) continue;
    out.push({ route: htmlRoute(p), path: at(fw.root, p) });
  }
  // A site in a sub-folder (`site/index.html`, `public/index.html`): its index is `/`.
  if (!out.some((p) => p.route === '/')) {
    const idx = out.filter((p) => /(^|\/)index\.html?$/.test(p.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
    if (idx) idx.route = '/';
  }
  return sortRoutes(out);
}

export function htmlRoute(p: string): string {
  const r = '/' + p.replace(/(^|\/)index\.html?$/, '$1');
  return r === '/' ? '/' : r;
}

/** Resolve an `href` written in `from` to a repo path (static HTML links). */
export function resolveHref(from: string, href: string, siteRoot = ''): string | null {
  const h = href.trim();
  if (!h || /^([a-z]+:|\/\/|#|\{|\$)/i.test(h)) return null;
  const clean = h.replace(/[?#].*$/, '');
  const dir = h.startsWith('/') ? (siteRoot ? siteRoot.split('/') : []) : from.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') dir.pop();
    else dir.push(seg);
  }
  let p = dir.join('/');
  if (clean.endsWith('/') || clean === '' ) p = p ? `${p}/index.html` : 'index.html';
  return p;
}

/* ───────────────────────────── Svelte routers ───────────────────────────── */

/** svelte-spa-router `{ '/': Home, '/about': About }` objects (and `wrap({ asyncComponent })`). */
export function svelteSpaPages(parse: ParseFn, script: string, scriptOffset: number, file: string, paths: string[], alias: Record<string, string>): { pages: PageRef[]; object: Node | null } {
  const ast = parseScript(parse, script, file.replace(/\.svelte$/, '.ts'));
  if (!ast) return { pages: [], object: null };
  const imports = importsOf(ast.program);
  const set = new Set(paths);
  const out: PageRef[] = [];
  let object: Node | null = null;
  walk(ast.program, (n) => {
    if (object || n.type !== 'ObjectExpression') return;
    const keyed = n.properties.filter((p: Node) => p.type === 'ObjectProperty' && typeof p.key?.value === 'string' && (p.key.value.startsWith('/') || p.key.value === '*'));
    if (keyed.length < 1 || keyed.length !== n.properties.length) return;
    object = n;
    for (const p of keyed) {
      const route = p.key.value as string;
      if (route.includes('*')) continue;
      let ref: PageRef | null = null;
      if (p.value.type === 'Identifier') {
        const imp = imports.find((i) => i.local === p.value.name);
        const rp = imp ? resolveSpec(file, imp.source, set, alias, ['svelte']) : null;
        if (rp) ref = { route, path: rp };
      } else {
        let lz: { spec: string } | null = null;
        walk(p.value, (c) => { if (!lz) lz = lazyImport(c); });
        const rp = lz ? resolveSpec(file, (lz as { spec: string }).spec, set, alias, ['svelte']) : null;
        if (rp) ref = { route, path: rp };
      }
      if (ref) out.push({ ...ref, route: route.replace(/:(\w+)\?/g, ':$1') });
    }
    return false;
  });
  void scriptOffset;
  return { pages: sortRoutes(out), object };
}

/** svelte-routing `<Route path="about" component={About} />` declarations. */
export function svelteRoutingPages(parse: ParseFn, code: string, script: string, file: string, paths: string[], alias: Record<string, string>): PageRef[] {
  const ast = parseScript(parse, script, file.replace(/\.svelte$/, '.ts'));
  const imports = ast ? importsOf(ast.program) : [];
  const set = new Set(paths);
  const out: PageRef[] = [];
  for (const m of code.matchAll(/<Route\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    const path = attrs.match(/\bpath=["']([^"']*)["']/)?.[1];
    const comp = attrs.match(/\bcomponent=\{\s*(\w+)\s*\}/)?.[1];
    if (path === undefined || !comp) continue;
    const imp = imports.find((i) => i.local === comp);
    const rp = imp ? resolveSpec(file, imp.source, set, alias, ['svelte']) : null;
    if (rp) out.push({ route: joinRoute('', path), path: rp });
  }
  return sortRoutes(out);
}

/* ───────────────────────────── wiring ───────────────────────────── */

export interface CodeStyle {
  q: string;
  semi: boolean;
}

export function codeStyle(code: string): CodeStyle {
  const singles = (code.match(/'/g) ?? []).length;
  const doubles = (code.match(/"/g) ?? []).length;
  const imports = code.match(/^import .*$/gm) ?? [];
  const semi = imports.length ? imports.filter((l) => l.trim().endsWith(';')).length * 2 >= imports.length : /;\s*$/m.test(code);
  return { q: doubles > singles ? '"' : "'", semi };
}

const lineIndentAt = (code: string, off: number) => (code.slice(code.lastIndexOf('\n', off - 1) + 1).match(/^[ \t]*/) ?? [''])[0];

/** Insert `line` after the last import (or at the top), with the imports' indentation. */
export function addImportLine(code: string, line: string): string {
  if (code.includes(line.trim())) return code;
  const all = [...code.matchAll(/^([ \t]*)import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$|^([ \t]*)import\s+['"][^'"]+['"];?[ \t]*$/gm)];
  const m = all.pop();
  if (m) {
    const ind = m[1] ?? m[2] ?? '';
    const end = (m.index ?? 0) + m[0].length;
    const nl = code.indexOf('\n', end);
    if (nl === -1) return code + '\n' + ind + line + '\n';
    return code.slice(0, nl + 1) + ind + line + '\n' + code.slice(nl + 1);
  }
  if (code.startsWith('\n')) {
    // A <script> body: first line after the tag.
    const ind = (code.match(/^\n+([ \t]*)\S/) ?? ['', ''])[1];
    return '\n' + ind + line + '\n' + code;
  }
  return line + '\n\n' + code;
}

/**
 * Add an object route (`entry`, already formatted) to the router file's
 * top-level route array — after the last route, but before a catch-all.
 */
export function addObjectRoute(parse: ParseFn, code: string, file: string, entry: string, kind: RouteArray['kind']): string | null {
  const ast = parseScript(parse, code, file);
  if (!ast) return null;
  const arrays = routeArrays(ast, kind);
  const arr = arrays[0];
  if (!arr) return null;
  const els: Node[] = arr.elements.filter(Boolean);
  if (!els.length) {
    const ind = lineIndentAt(code, arr.start) + '  ';
    return code.slice(0, arr.start) + `[\n${ind}${entry},\n${lineIndentAt(code, arr.start)}]` + code.slice(arr.end);
  }
  const catchAll = (e: Node) => e.type === 'ObjectExpression' && /\*/.test(strOf(prop(e, 'path')?.value) ?? '');
  const firstCatch = els.findIndex(catchAll);
  const ind = lineIndentAt(code, els[0].start);
  if (firstCatch >= 0) {
    const target = els[firstCatch];
    const sameLine = !/\n/.test(code.slice(arr.start, target.start));
    return code.slice(0, target.start) + entry + (sameLine ? ', ' : `,\n${ind}`) + code.slice(target.start);
  }
  const last = els[els.length - 1];
  const rest = code.slice(last.end);
  const comma = rest.match(/^\s*,/);
  if (comma) return code.slice(0, last.end + comma[0].length) + `\n${ind}${entry},` + code.slice(last.end + comma[0].length);
  return code.slice(0, last.end) + `,\n${ind}${entry}` + rest;
}

/** Add `'/route': Component` to a svelte-spa-router routes object (before the catch-all). */
export function addSpaRoute(parse: ParseFn, script: string, file: string, route: string, component: string, q = "'"): string | null {
  const { object } = svelteSpaPages(parse, script, 0, file, [], {});
  if (!object) return null;
  const props: Node[] = (object as Node).properties;
  const entry = `${q}${route}${q}: ${component}`;
  const ind = props.length ? lineIndentAt(script, props[0].start) : '  ';
  const catchAll = props.findIndex((p) => String(p.key.value).includes('*'));
  if (catchAll >= 0) return script.slice(0, props[catchAll].start) + entry + `,\n${ind}` + script.slice(props[catchAll].start);
  if (!props.length) return null;
  const last = props[props.length - 1];
  const rest = script.slice(last.end);
  const comma = rest.match(/^\s*,/);
  if (comma) return script.slice(0, last.end + comma[0].length) + `\n${ind}${entry},` + script.slice(last.end + comma[0].length);
  return script.slice(0, last.end) + `,\n${ind}${entry}` + rest;
}

/** Add `<Route path component />` after the last svelte-routing route. */
export function addSvelteRoutingRoute(code: string, route: string, component: string): string | null {
  const all = [...code.matchAll(/<Route\b[^>]*?\/>/g)];
  const last = all.pop();
  if (!last) return null;
  const end = (last.index ?? 0) + last[0].length;
  const ind = lineIndentAt(code, last.index ?? 0);
  return code.slice(0, end) + `\n${ind}<Route path="${route.replace(/^\//, '')}" component={${component}} />` + code.slice(end);
}

/* ───────────────────────────── candidates ───────────────────────────── */

export function angularRouterCandidates(fw: Framework, paths: string[]): string[] {
  const pref = ['src/app/app.routes.ts', 'src/app/app-routing.module.ts', 'src/app/app.config.ts', 'src/app/app.module.ts', 'src/app/routes.ts', 'src/main.ts'];
  const local = within(fw.root, paths);
  const out = pref.filter((p) => local.includes(p));
  for (const p of local) if (/\.routes\.ts$|-routing\.module\.ts$/.test(p) && !out.includes(p)) out.push(p);
  return out.map((p) => at(fw.root, p));
}

export function vueRouterCandidates(fw: Framework, paths: string[]): string[] {
  const names = ['src/router/index', 'src/router', 'src/router/routes', 'src/routes', 'src/main'];
  const out: string[] = [];
  for (const n of names) for (const e of ['ts', 'js', 'mjs']) if (paths.includes(at(fw.root, `${n}.${e}`))) out.push(at(fw.root, `${n}.${e}`));
  return out;
}

export function svelteRouterCandidates(fw: Framework, paths: string[]): string[] {
  const names = ['src/routes.ts', 'src/routes.js', 'src/router.ts', 'src/router.js', 'src/App.svelte', 'src/lib/routes.ts', 'src/lib/routes.js'];
  return names.map((n) => at(fw.root, n)).filter((p) => paths.includes(p));
}

/** Pages folder fallback for SPA frameworks without a recognised router. */
export function folderPagesExt(fw: Framework, paths: string[], ext: string): PageRef[] {
  const out: PageRef[] = [];
  for (const p of within(fw.root, paths)) {
    const m = p.match(new RegExp(`^(?:src/)?(?:pages|views|screens|routes|lib/pages)/([^/]+)\\.${ext}$`));
    if (!m) continue;
    const slug = m[1].replace(/(View|Page)$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.push({ route: /^(index|home)$/.test(slug) ? '/' : `/${slug}`, path: at(fw.root, p) });
  }
  return sortRoutes(out);
}

export function rootFile(fw: Framework, paths: string[], names: string[]): PageRef | null {
  for (const n of names) if (paths.includes(at(fw.root, n))) return { route: '/', path: at(fw.root, n) };
  return null;
}
