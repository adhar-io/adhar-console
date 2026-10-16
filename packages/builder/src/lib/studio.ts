/**
 * The app-builder model on top of the builder's file tree — pure, no React.
 *
 * Everything an app needs lives IN the project's file tree, so it is saved,
 * versioned, committed and exported with no extra plumbing:
 *
 *   • Pages       — page files under `pages/`, each with an optional `route`
 *                   and one `home` page.
 *   • Components  — reusable "symbols": files under `components/` flagged
 *                   `symbol`, whose `nodes[0]` is the master. Instances are
 *                   nodes `{ type: 'symbol', props: { symbolId } }`; editing the
 *                   master updates every instance.
 *   • Data        — JSON files under `data/`. A container with
 *                   `bind: { source, path }` repeats its children per item;
 *                   text may use `{{field}}` templates against the item.
 */

import {
  addFileToFolder,
  findFileInTree,
  genId,
  getAllPageFiles,
  reIdNodes,
  type CanvasNode,
  type ProjectFile,
} from './builder-types.ts';

export const PAGES_FOLDER = 'f_pages';
export const SYMBOLS_FOLDER = 'f_symbols';
export const DATA_FOLDER = 'f_data';

/* ───────────────────────────── folders ───────────────────────────── */

const FOLDER_META: Record<string, { name: string; parent?: string }> = {
  [PAGES_FOLDER]: { name: 'pages', parent: 'f_src' },
  [SYMBOLS_FOLDER]: { name: 'components', parent: 'f_src' },
  [DATA_FOLDER]: { name: 'data', parent: 'f_src' },
};

/** Make sure a well-known folder exists (older projects may lack it). */
export function ensureFolder(files: ProjectFile[], folderId: string): ProjectFile[] {
  if (findFileInTree(files, folderId)) return files;
  const meta = FOLDER_META[folderId];
  const folder: ProjectFile = { id: folderId, name: meta?.name ?? folderId, type: 'folder', expanded: true, children: [] };
  if (meta?.parent && findFileInTree(files, meta.parent)) return addFileToFolder(files, meta.parent, folder);
  return [...files, folder];
}

/* ───────────────────────────── pages ───────────────────────────── */

export function slugify(s: string): string {
  return s.replace(/\.\w+$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The pages of an app, in tree order. */
export function listPages(files: ProjectFile[]): ProjectFile[] {
  return getAllPageFiles(files);
}

/** The home page: the one flagged `home`, else the first page. */
export function homePage(files: ProjectFile[]): ProjectFile | undefined {
  const pages = listPages(files);
  return pages.find((p) => p.home) ?? pages[0];
}

/** A page's route: its own, `/` for home, else `/<slug-of-name>`. */
export function pageRoute(page: ProjectFile, files: ProjectFile[]): string {
  if (page.route && page.route.startsWith('/')) return page.route;
  if (homePage(files)?.id === page.id) return '/';
  return `/${slugify(page.name) || page.id}`;
}

export function setHomePage(files: ProjectFile[], pageId: string): ProjectFile[] {
  const walk = (fs: ProjectFile[]): ProjectFile[] =>
    fs.map((f) => {
      const next = f.type === 'file' && f.nodes !== undefined && !f.symbol ? { ...f, home: f.id === pageId } : f;
      return next.children ? { ...next, children: walk(next.children) } : next;
    });
  return walk(files);
}

/** Move a file up/down among its siblings. */
export function moveFile(files: ProjectFile[], fileId: string, dir: -1 | 1): ProjectFile[] {
  const idx = files.findIndex((f) => f.id === fileId);
  if (idx >= 0) {
    const j = idx + dir;
    if (j < 0 || j >= files.length) return files;
    const next = files.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  }
  return files.map((f) => (f.children ? { ...f, children: moveFile(f.children, fileId, dir) } : f));
}

export function newPage(name: string, taken: string[] = []): ProjectFile {
  const base = name.replace(/[^A-Za-z0-9 ]+/g, '').trim().replace(/\s+(.)/g, (_m, c: string) => c.toUpperCase()) || 'Page';
  const pascal = base.charAt(0).toUpperCase() + base.slice(1);
  let file = `${pascal}.tsx`;
  for (let i = 2; taken.includes(file); i++) file = `${pascal}${i}.tsx`;
  return { id: `f_page_${genId()}`, name: file, type: 'file', language: 'tsx', nodes: [], route: `/${slugify(file)}` };
}

/* ───────────────────────────── symbols ───────────────────────────── */

export function listSymbols(files: ProjectFile[]): ProjectFile[] {
  const out: ProjectFile[] = [];
  const walk = (fs: ProjectFile[]) => {
    for (const f of fs) {
      if (f.type === 'file' && f.symbol) out.push(f);
      if (f.children) walk(f.children);
    }
  };
  walk(files);
  return out;
}

export function symbolName(file: ProjectFile): string {
  return file.name.replace(/\.\w+$/, '');
}

/**
 * Turn `node` into a reusable component: returns the new symbol file (master =
 * a re-id'd copy of the node) and the instance node to put where it was.
 */
export function makeSymbol(node: CanvasNode, name: string, taken: string[] = []): { symbol: ProjectFile; instance: CanvasNode } {
  const clean = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/(?:^|\s)(\w)/g, (_m, c: string) => c.toUpperCase()) || 'Component';
  let fileName = `${clean}.tsx`;
  for (let i = 2; taken.includes(fileName); i++) fileName = `${clean}${i}.tsx`;
  const id = `f_sym_${genId()}`;
  const master = reIdNodes(JSON.parse(JSON.stringify({ ...node, x: undefined, y: undefined })));
  return {
    symbol: { id, name: fileName, type: 'file', language: 'tsx', nodes: [master], symbol: true },
    instance: { id: genId(), type: 'symbol', props: { symbolId: id }, children: [], style: {} },
  };
}

export function instanceOf(id: string): CanvasNode {
  return { id: genId(), type: 'symbol', props: { symbolId: id }, children: [], style: {} };
}

/** Replace an instance by a plain, editable copy of its master. */
export function detachInstance(instance: CanvasNode, files: ProjectFile[]): CanvasNode | null {
  const sym = findFileInTree(files, String(instance.props?.symbolId ?? ''));
  const master = sym?.nodes?.[0];
  return master ? reIdNodes(JSON.parse(JSON.stringify(master))) : null;
}

/**
 * Expand every instance into its master's tree (recursively, guarding
 * cycles). Used for preview, HTML export and thumbnails; the canvas renders
 * instances itself.
 */
export function resolveSymbols(nodes: CanvasNode[], files: ProjectFile[], seen: string[] = []): CanvasNode[] {
  return nodes.map((n) => {
    if (n.type === 'symbol') {
      const id = String(n.props?.symbolId ?? '');
      const master = findFileInTree(files, id)?.nodes?.[0];
      if (!master || seen.includes(id)) {
        return { id: n.id, type: 'div', props: { className: 'p-3 rounded-md border border-dashed border-border text-sm text-muted-foreground', children: 'Missing component' }, children: [], style: {} };
      }
      const [resolved] = resolveSymbols([master], files, [...seen, id]);
      return { ...resolved, id: n.id, interactions: n.interactions ?? resolved.interactions, hidden: n.hidden };
    }
    return n.children.length ? { ...n, children: resolveSymbols(n.children, files, seen) } : n;
  });
}

/* ───────────────────────────── data ───────────────────────────── */

export function listDataSources(files: ProjectFile[]): ProjectFile[] {
  const folder = findFileInTree(files, DATA_FOLDER);
  return (folder?.children ?? []).filter((f) => f.type === 'file' && f.language === 'json');
}

export function dataSourceName(file: ProjectFile): string {
  return file.name.replace(/\.json$/, '');
}

export function newDataSource(name: string, json: string, taken: string[] = []): ProjectFile {
  const base = slugify(name) || 'data';
  let file = `${base}.json`;
  for (let i = 2; taken.includes(file); i++) file = `${base}-${i}.json`;
  return { id: `f_data_${genId()}`, name: file, type: 'file', language: 'json', content: json };
}

/** Parse a data source; returns null and an error message when invalid. */
export function parseData(json: string | undefined): { value: unknown; error: string | null } {
  try {
    return { value: JSON.parse(json || 'null'), error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `a.b.0.c` lookup; empty path returns the value itself. */
export function getPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The items a bound container repeats over (always an array). */
export function bindingItems(files: ProjectFile[], bind: CanvasNode['bind']): unknown[] {
  if (!bind) return [];
  const src = findFileInTree(files, bind.source);
  const v = getPath(parseData(src?.content).value, bind.path);
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;

export function hasTemplate(text: string): boolean {
  TEMPLATE.lastIndex = 0;
  return TEMPLATE.test(text);
}

/** `"Hi {{name}}"` + `{ name: 'Ann' }` → `"Hi Ann"`. Unknown fields render empty. */
export function interpolate(text: string, item: unknown): string {
  return text.replace(TEMPLATE, (_m, path: string) => {
    const v = getPath(item, path);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** `{{a}} and {{b.c}}` → `['a', 'b.c']`. */
export function templateFields(text: string): string[] {
  return [...text.matchAll(TEMPLATE)].map((m) => m[1]);
}

function interpolateTree(n: CanvasNode, item: unknown, suffix: string): CanvasNode {
  const props = { ...n.props };
  for (const k of ['children', 'placeholder'] as const) {
    if (typeof props[k] === 'string') props[k] = interpolate(props[k], item);
  }
  return { ...n, id: `${n.id}${suffix}`, props, children: n.children.map((c) => interpolateTree(c, item, suffix)) };
}

/** Repeat bound containers' children per item (preview / HTML export). */
export function expandBindings(nodes: CanvasNode[], files: ProjectFile[]): CanvasNode[] {
  return nodes.map((n) => {
    const children = expandBindings(n.children, files);
    if (!n.bind) return { ...n, children };
    const items = bindingItems(files, n.bind);
    const repeated = items.flatMap((item, i) => children.map((c) => interpolateTree(c, item, `__${i}`)));
    return { ...n, children: repeated };
  });
}

/** A page ready to render outside the editor: symbols resolved, bindings expanded. */
export function renderableNodes(nodes: CanvasNode[], files: ProjectFile[]): CanvasNode[] {
  return expandBindings(resolveSymbols(nodes, files), files);
}

/* ───────────────────────────── tree helpers ───────────────────────────── */

/** Nodes in `root`'s subtree marked as "bind me to data" by a palette blueprint. */
export function collectRepeaters(root: CanvasNode): CanvasNode[] {
  const out: CanvasNode[] = [];
  const walk = (n: CanvasNode) => {
    if (n.props?.['data-repeater']) out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** Replace the node `id` (anywhere in the tree) with `next`. */
export function replaceNode(nodes: CanvasNode[], id: string, next: CanvasNode): CanvasNode[] {
  return nodes.map((n) => (n.id === id ? next : n.children.length ? { ...n, children: replaceNode(n.children, id, next) } : n));
}

/** Symbol ids referenced by instances in `nodes`. */
export function symbolRefs(nodes: CanvasNode[], into = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'symbol' && n.props?.symbolId) into.add(String(n.props.symbolId));
    symbolRefs(n.children, into);
  }
  return into;
}

/** How many instances of `symbolId` exist across all pages and components. */
export function countInstances(files: ProjectFile[], symbolId: string): number {
  let count = 0;
  const walkNodes = (ns: CanvasNode[]) => {
    for (const n of ns) {
      if (n.type === 'symbol' && n.props?.symbolId === symbolId) count++;
      walkNodes(n.children);
    }
  };
  const walk = (fs: ProjectFile[]) => {
    for (const f of fs) {
      if (f.nodes) walkNodes(f.nodes);
      if (f.children) walk(f.children);
    }
  };
  walk(files);
  return count;
}
