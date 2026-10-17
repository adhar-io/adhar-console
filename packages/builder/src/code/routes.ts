/**
 * Where an app's pages are, and how to add one.
 *
 *   • Next.js     — `app/<dir>/page.tsx` (App Router) or `pages/<file>` (Pages Router)
 *   • Remix       — `app/routes/*` flat routes
 *   • React Router — the route config (JSX `<Route path element={<X/>}>` or
 *                   `createBrowserRouter([{ path, element: <X/> }])`), with
 *                   each `X` resolved through the file's imports
 *   • fallback    — `src/pages/*`, then the app's root component
 *
 * Pure: file contents are passed in by the caller.
 */

import type { Framework } from './framework.ts';
import { attrName, importsOf, jsxName, parseModule, staticString, walk, type Node, type ParseFn } from './ast.ts';

export interface PageRef {
  /** Route as the app serves it, e.g. `/`, `/customers`, `/customers/:id`. */
  route: string;
  /** Repo path of the file holding the page component. */
  path: string;
  /** Export to import from that file (default when omitted). */
  exportName?: string;
}

const PAGE_EXT = /\.(tsx|jsx|ts|js)$/;

function at(root: string, p: string) {
  return root ? `${root}/${p}` : p;
}

function within(root: string, paths: string[]): string[] {
  return root ? paths.filter((p) => p.startsWith(root + '/')).map((p) => p.slice(root.length + 1)) : paths;
}

export function nextPages(fw: Framework, paths: string[]): PageRef[] {
  const local = within(fw.root, paths);
  const out: PageRef[] = [];
  for (const p of local) {
    const app = p.match(/^(?:src\/)?app\/(?:(.*)\/)?page\.(tsx|jsx|js|ts)$/);
    if (app) {
      const segs = (app[1] ?? '').split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
      out.push({ route: '/' + segs.map((s) => s.replace(/^\[\.\.\.(.+)\]$/, '*').replace(/^\[(.+)\]$/, ':$1')).join('/'), path: at(fw.root, p) });
      continue;
    }
    const pages = p.match(/^(?:src\/)?pages\/(.+)\.(tsx|jsx|js|ts)$/);
    if (pages && !/(^|\/)(_app|_document|_error|404|500)$/.test(pages[1]) && !pages[1].startsWith('api/')) {
      const route = '/' + pages[1].replace(/(^|\/)index$/, '').replace(/\[(.+?)\]/g, ':$1');
      out.push({ route: route === '/' ? '/' : route.replace(/\/$/, ''), path: at(fw.root, p) });
    }
  }
  return sortRoutes(out);
}

export function remixPages(fw: Framework, paths: string[]): PageRef[] {
  const out: PageRef[] = [];
  for (const p of within(fw.root, paths)) {
    const m = p.match(/^app\/routes\/([^/]+?)(?:\/route)?\.(tsx|jsx)$/);
    if (!m || m[1].startsWith('api.') || m[1].startsWith('resources.')) continue;
    const segs = m[1].split('.').filter((s) => !s.startsWith('_') || s === '_index').map((s) => (s === '_index' ? '' : s.replace(/^\$/, ':')));
    out.push({ route: '/' + segs.filter(Boolean).join('/'), path: at(fw.root, p) });
  }
  if (!out.some((p) => p.route === '/') && paths.includes(at(fw.root, 'app/root.tsx'))) out.push({ route: '/', path: at(fw.root, 'app/root.tsx') });
  return sortRoutes(out);
}

/** Files that usually hold a React Router config, best first. */
export function routerCandidates(fw: Framework, paths: string[]): string[] {
  const names = ['src/router', 'src/routes', 'src/App', 'src/app', 'src/main', 'src/index', 'app/routes', 'app/App'];
  const out: string[] = [];
  for (const n of names) for (const ext of ['tsx', 'jsx', 'ts', 'js']) {
    const p = at(fw.root, `${n}.${ext}`);
    if (paths.includes(p)) out.push(p);
  }
  return out;
}

/** Resolve a relative import specifier to an existing repo path. */
export function resolveImport(from: string, spec: string, paths: Set<string>, alias: Record<string, string> = {}): string | null {
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
  for (const cand of [base, ...['tsx', 'jsx', 'ts', 'js'].map((e) => `${base}.${e}`), ...['tsx', 'jsx', 'ts', 'js'].map((e) => `${base}/index.${e}`)]) {
    if (paths.has(cand)) return cand;
  }
  return null;
}

function joinRoute(parent: string, child: string | null, index: boolean): string {
  if (index || child === null || child === '') return parent || '/';
  if (child.startsWith('/')) return child;
  return `${parent === '/' ? '' : parent}/${child}`;
}

/** Pages declared in a React Router config file. */
export function reactRouterPages(parse: ParseFn, code: string, file: string, paths: string[], alias: Record<string, string> = {}): PageRef[] {
  let ast: Node;
  try {
    ast = parseModule(parse, code, file);
  } catch {
    return [];
  }
  const imports = importsOf(ast.program);
  const set = new Set(paths);
  const out: PageRef[] = [];

  const resolveComponent = (name: string): PageRef | null => {
    const imp = imports.find((i) => i.local === name);
    if (imp) {
      const p = resolveImport(file, imp.source, set, alias);
      return p ? { route: '', path: p, exportName: imp.isDefault ? undefined : name } : null;
    }
    // Declared in the router file itself.
    const local = ast.program.body.some((st: Node) => {
      const d = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
      return (d.type === 'FunctionDeclaration' && d.id?.name === name) || (d.type === 'VariableDeclaration' && d.declarations.some((v: Node) => v.id?.name === name));
    });
    return local ? { route: '', path: file, exportName: name } : null;
  };

  const elementName = (expr: Node): string | null => {
    if (!expr) return null;
    if (expr.type === 'JSXExpressionContainer') expr = expr.expression;
    if (expr.type === 'JSXElement') return jsxName(expr.openingElement.name).split('.')[0];
    if (expr.type === 'Identifier') return expr.name;
    return null;
  };

  const add = (route: string, comp: string | null) => {
    if (!comp) return;
    const ref = resolveComponent(comp);
    if (ref && !out.some((o) => o.route === route)) out.push({ ...ref, route });
  };

  // JSX: <Route path="x" element={<X/>}> with nesting.
  const visitJsx = (n: Node, parentRoute: string) => {
    if (n.type !== 'JSXElement') return;
    const name = jsxName(n.openingElement.name);
    let route = parentRoute;
    if (name === 'Route') {
      const attrs = n.openingElement.attributes;
      const pathAttr = attrs.find((a: Node) => attrName(a) === 'path');
      const isIndex = attrs.some((a: Node) => attrName(a) === 'index');
      route = joinRoute(parentRoute, pathAttr ? staticString(pathAttr.value) : null, isIndex);
      const el = attrs.find((a: Node) => attrName(a) === 'element' || attrName(a) === 'Component' || attrName(a) === 'component');
      if (el && (pathAttr || isIndex)) add(route, elementName(el.value));
    }
    for (const c of n.children) visitJsx(c, route);
  };

  // Objects: { path, element: <X/>, children: [...] }.
  const visitArray = (arr: Node, parentRoute: string) => {
    for (const el of arr.elements) {
      if (el?.type !== 'ObjectExpression') continue;
      const prop = (k: string) => el.properties.find((p: Node) => p.type === 'ObjectProperty' && (p.key.name === k || p.key.value === k));
      const pathP = prop('path');
      const isIndex = prop('index')?.value?.value === true;
      const route = joinRoute(parentRoute, pathP?.value?.type === 'StringLiteral' ? pathP.value.value : null, isIndex);
      const element = prop('element') ?? prop('Component') ?? prop('component');
      if (element && (pathP || isIndex)) add(route, elementName(element.value));
      const children = prop('children');
      if (children?.value?.type === 'ArrayExpression') visitArray(children.value, route);
    }
  };

  walk(ast.program, (n) => {
    if (n.type === 'JSXElement' && ['Routes', 'Router', 'BrowserRouter', 'Route'].includes(jsxName(n.openingElement.name))) {
      visitJsx(n, '');
      return false;
    }
    if (n.type === 'CallExpression' && /^create(Browser|Hash|Memory)Router$|^useRoutes$/.test(n.callee?.name ?? '') && n.arguments[0]?.type === 'ArrayExpression') {
      visitArray(n.arguments[0], '');
      return false;
    }
  });
  return sortRoutes(out);
}

/** `src/pages/*` as a last resort. */
export function folderPages(fw: Framework, paths: string[]): PageRef[] {
  const out: PageRef[] = [];
  for (const p of within(fw.root, paths)) {
    const m = p.match(/^(?:src\/)?(?:pages|views|screens|routes)\/([^/]+)\.(tsx|jsx)$/);
    if (!m) continue;
    const slug = m[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.push({ route: /^(index|home)$/.test(slug) ? '/' : `/${slug}`, path: at(fw.root, p) });
  }
  return sortRoutes(out);
}

/** The app's root component, when there's nothing else to edit. */
export function rootComponent(fw: Framework, paths: string[]): PageRef | null {
  for (const n of ['src/App.tsx', 'src/App.jsx', 'src/app.tsx', 'src/app.jsx', 'App.tsx', 'App.jsx']) {
    if (paths.includes(at(fw.root, n))) return { route: '/', path: at(fw.root, n) };
  }
  return null;
}

function sortRoutes(list: PageRef[]): PageRef[] {
  return list.sort((a, b) => (a.route === '/' ? -1 : b.route === '/' ? 1 : a.route.localeCompare(b.route)));
}

export function isPagePath(p: string) {
  return PAGE_EXT.test(p);
}

/* ───────────────────────────── adding a page ───────────────────────────── */

/** Repo path for a new page, following the framework's conventions. */
export function newPagePath(fw: Framework, route: string, name: string, existing: PageRef[]): string {
  const slug = route.replace(/^\/+|\/+$/g, '');
  const ext = fw.typescript ? 'tsx' : 'jsx';
  if (fw.router === 'next-app') {
    const appDir = existing.find((p) => /\/?app\//.test(p.path))?.path.match(/^(.*?app)\//)?.[1] ?? at(fw.root, fw.srcDir ? `${fw.srcDir}/app` : 'app');
    return `${appDir}/${slug ? slug + '/' : ''}page.${ext}`;
  }
  if (fw.router === 'next-pages') {
    const pagesDir = existing.find((p) => /\/?pages\//.test(p.path))?.path.match(/^(.*?pages)\//)?.[1] ?? at(fw.root, fw.srcDir ? `${fw.srcDir}/pages` : 'pages');
    return `${pagesDir}/${slug || 'index'}.${ext}`;
  }
  if (fw.router === 'remix') return at(fw.root, `app/routes/${slug.replace(/\//g, '.') || '_index'}.${ext}`);
  // React Router / plain React: next to the existing pages, else src/pages.
  const dir = existing.find((p) => /\/(pages|views|screens|routes)\//.test(p.path))?.path.replace(/\/[^/]+$/, '') ?? at(fw.root, `${fw.srcDir || 'src'}/pages`);
  return `${dir}/${name}.${ext}`;
}

/**
 * Register a page in a React Router config: a `<Route>` after the last one,
 * or an object after the last route object — plus the import. Returns null
 * when the config isn't one we recognise (the caller then says so).
 */
export function addReactRoute(parse: ParseFn, code: string, file: string, route: string, component: string, importPath: string): string | null {
  let ast: Node;
  try {
    ast = parseModule(parse, code, file);
  } catch {
    return null;
  }
  let lastRoute: Node | null = null;
  let lastObject: Node | null = null;
  walk(ast.program, (n) => {
    if (n.type === 'JSXElement' && jsxName(n.openingElement.name) === 'Route' && n.openingElement.attributes.some((a: Node) => attrName(a) === 'path' || attrName(a) === 'index')) lastRoute = n;
    if (n.type === 'ObjectExpression' && n.properties.some((p: Node) => p.type === 'ObjectProperty' && (p.key.name === 'path' || p.key.value === 'path'))) {
      if (n.properties.some((p: Node) => p.type === 'ObjectProperty' && ['element', 'Component', 'component'].includes(p.key.name))) lastObject = n;
    }
  });
  const indentAt = (off: number) => {
    const ls = code.lastIndexOf('\n', off - 1) + 1;
    return (code.slice(ls).match(/^[ \t]*/) ?? [''])[0];
  };
  let out: string;
  const target = lastRoute ?? lastObject;
  if (!target) return null;
  const ind = indentAt((target as Node).start);
  if (lastRoute && (!lastObject || (lastRoute as Node).end > (lastObject as Node).end)) {
    const at = (lastRoute as Node).end;
    out = code.slice(0, at) + `\n${ind}<Route path=${JSON.stringify(route)} element={<${component} />} />` + code.slice(at);
  } else {
    const end = (lastObject as Node).end;
    const rest = code.slice(end);
    const comma = rest.match(/^\s*,/);
    const entry = `{ path: ${JSON.stringify(route)}, element: <${component} /> }`;
    out = comma
      ? code.slice(0, end + comma[0].length) + `\n${ind}${entry},` + code.slice(end + comma[0].length)
      : code.slice(0, end) + `,\n${ind}${entry}` + rest;
  }
  // Import (after the last import line).
  const importLine = `import ${component} from '${importPath}'\n`;
  const m = [...out.matchAll(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm)].pop();
  const at2 = m ? out.indexOf('\n', (m.index ?? 0) + m[0].length) + 1 : 0;
  return out.slice(0, at2) + importLine + out.slice(at2);
}

/** `@/…` style aliases from tsconfig/jsconfig `paths` (best effort). */
export function aliasesFrom(tsconfigText: string | null, root = ''): Record<string, string> {
  if (!tsconfigText) return {};
  try {
    const json = JSON.parse(tsconfigText.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'));
    const paths = json?.compilerOptions?.paths ?? {};
    const baseUrl = String(json?.compilerOptions?.baseUrl ?? '.').replace(/^\.\/?/, '');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(paths)) {
      const target = Array.isArray(v) ? String(v[0]) : '';
      if (!k.endsWith('/*') || !target.endsWith('/*')) continue;
      const dir = [root, baseUrl, target.slice(0, -2).replace(/^\.\//, '')].filter(Boolean).join('/');
      out[k.slice(0, -2)] = dir;
    }
    return out;
  } catch {
    return {};
  }
}
