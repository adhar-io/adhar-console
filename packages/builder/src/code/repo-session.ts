/**
 * A repository branch opened in the Visual Designer.
 *
 *   openRepo()        tree → framework → pages/routes → each page's JSX
 *                     imported into the builder's node tree; designer-made
 *                     components and data sources re-linked from
 *                     `.adhar/designer/project.json`.
 *   computeChanges()  the edited project → the exact file changes: pages
 *                     spliced in place (untouched files byte-identical), new
 *                     pages/components written in the repo's style, routes
 *                     wired, data and designer metadata saved.
 *
 * Gitea access is injected (`RepoApi`), so the whole flow is testable without
 * a server; the UI passes the console's Gitea client.
 */

import type { BuilderProject } from '../types.ts';
import { findFileInTree, genId, type CanvasNode, type ProjectFile } from '../lib/builder-types.ts';
import { DEFAULT_SETTINGS } from '../lib/project.ts';
import { dataSourceName, listDataSources, listPages, listSymbols, pageRoute, slugify, symbolName } from '../lib/studio.ts';
import type { ParseFn } from './ast.ts';
import { detectFramework, familyOf, findAppPackageJson, isEditable, SUPPORTED_FRAMEWORKS, type Framework } from './framework.ts';
import { importPage, type ImportedPage } from './jsx-import.ts';
import { applyPlans, newComponentModule, planSplice, relativeImport, type PrintContext, type SplicePlan } from './jsx-print.ts';
import {
  addReactRoute, aliasesFrom, folderPages, isPagePath, newPagePath, nextPages, reactRouterPages, remixPages, rootComponent, routerCandidates,
  type PageRef,
} from './routes.ts';
import { cssCandidates, pickAppCss } from './css-theme.ts';
import type { Dialect, MarkupImportContext, MarkupPrintContext } from './markup.ts';
import {
  angularComponent, angularNames, angularStyle, dialectOf, findNav, htmlChrome, importMarkupPage, kebab, markupPageChanges, newMarkupModule,
  relativeModule, type MarkupPage, type NgStyle,
} from './markup-pages.ts';
import {
  addImportLine, addObjectRoute, addSpaRoute, addSvelteRoutingRoute, angularRouterCandidates, codeStyle, folderPagesExt, htmlPages, nuxtPages,
  objectRoutes, resolveHref, rootFile, solidStartPages, sortRoutes, svelteKitPages, svelteRouterCandidates, svelteRoutingPages, svelteSpaPages,
  vueRouterCandidates,
} from './markup-routes.ts';
import { loadMarkupParsers } from './parsers/load.ts';
import type { MarkupParsers } from './parsers/types.ts';

export const DESIGNER_META = '.adhar/designer/project.json';

export interface RepoApi {
  tree(ref: string): Promise<{ entries: Array<{ path: string; sha: string }>; truncated: boolean }>;
  /** Text content + blob sha; rejects when the file doesn't exist. */
  read(path: string, ref: string): Promise<{ content: string; sha: string }>;
}

export interface DesignerMeta {
  version: 1;
  theme?: string;
  /** Components made in the designer — re-linked as editable components on open. */
  components?: Array<{ name: string; path: string }>;
  /** Data sources made in the designer. */
  data?: Array<{ name: string; path: string }>;
}

export interface OpenPage extends PageRef {
  id: string;
  /** JSX import (React / Solid) or template import (Angular / Vue / Svelte / HTML). */
  imported: ImportedPage | MarkupPage;
}

export interface RepoSession {
  repo: string;
  branch: string;
  framework: Framework;
  paths: string[];
  /** Every file read, as read (for splicing and conflict checks). */
  originals: Map<string, { content: string; sha: string }>;
  pages: OpenPage[];
  routerFile: string | null;
  appCss: { path: string; content: string } | null;
  meta: DesignerMeta;
  metaRaw: string | null;
  alias: Record<string, string>;
  warnings: string[];
  editable: boolean;
  /** Template parsers loaded for this framework (Angular / Vue / Svelte / HTML). */
  parsers?: MarkupParsers;
  /** Component-level and extra global CSS (Vue / Svelte `<style>`, Angular `styles`, linked sheets) for the canvas. */
  componentCss?: string;
}

const pageId = (ref: PageRef) => `pg:${ref.path}${ref.exportName ? '#' + ref.exportName : ''}`;

function pageTitle(ref: PageRef): string {
  if (ref.exportName) return ref.exportName;
  if (ref.route === '/') return 'Home';
  const last = ref.route.split('/').filter((s) => s && !s.startsWith(':') && s !== '*').pop()?.replace(/\.html?$/, '');
  if (last) return last.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase());
  const base = ref.path.split('/').pop()!.replace(/\.\w+$/, '');
  return base === 'page' || base === 'index' ? ref.path.split('/').slice(-2, -1)[0] ?? 'Page' : base;
}

async function tryRead(api: RepoApi, path: string, ref: string, originals: RepoSession['originals']): Promise<string | null> {
  if (originals.has(path)) return originals.get(path)!.content;
  try {
    const f = await api.read(path, ref);
    originals.set(path, f);
    return f.content;
  } catch {
    return null;
  }
}

export interface OpenOptions {
  /** Template parsers for Angular / Vue / Svelte / HTML apps — loaded lazily (own chunks) by default. */
  loadParsers?: (dialect: Dialect) => Promise<MarkupParsers>;
}

export async function openRepo(api: RepoApi, parse: ParseFn, repo: string, branch: string, opts: OpenOptions = {}): Promise<{ session: RepoSession; project: BuilderProject }> {
  const { entries, truncated } = await api.tree(branch);
  const paths = entries.map((e) => e.path).filter((p) => !p.includes('node_modules/'));
  const originals: RepoSession['originals'] = new Map();
  const warnings: string[] = [];
  if (truncated) warnings.push('The repository is very large; only part of its file list was read.');

  const pkgPath = findAppPackageJson(paths);
  const pkgText = pkgPath ? await tryRead(api, pkgPath, branch, originals) : null;
  const fw = detectFramework(pkgText, paths, pkgPath);
  const editable = isEditable(fw);
  const family = familyOf(fw);
  const dialect = dialectOf(fw);
  const read = (p: string) => tryRead(api, p, branch, originals);
  const tsconfig = await tryRead(api, fw.root ? `${fw.root}/tsconfig.json` : 'tsconfig.json', branch, originals)
    ?? await tryRead(api, fw.root ? `${fw.root}/jsconfig.json` : 'jsconfig.json', branch, originals);
  const alias = aliasesFrom(tsconfig, fw.root);
  if (family === 'svelte' && !alias.$lib) alias.$lib = `${fw.root ? fw.root + '/' : ''}src/lib`;
  if (family === 'vue' && !alias['@']) alias['@'] = `${fw.root ? fw.root + '/' : ''}src`;
  const parsers: MarkupParsers = dialect ? await (opts.loadParsers ?? loadMarkupParsers)(dialect) : {};

  // ── pages ──
  let refs: PageRef[] = [];
  let routerFile: string | null = null;
  if (fw.id === 'next') refs = nextPages(fw, paths);
  else if (fw.id === 'remix') refs = remixPages(fw, paths);
  else if (family === 'react') {
    for (const cand of routerCandidates(fw, paths)) {
      const code = await tryRead(api, cand, branch, originals);
      if (!code) continue;
      const found = reactRouterPages(parse, code, cand, paths, alias);
      if (found.length) {
        refs = found;
        routerFile = cand;
        break;
      }
    }
    if (!refs.length) refs = folderPages(fw, paths);
    if (!refs.length) {
      const root = rootComponent(fw, paths);
      if (root) refs = [root];
    }
  } else if (editable) {
    ({ refs, routerFile } = await discoverPages(fw, paths, parse, parsers, alias, read));
  }
  if (!editable) warnings.push(`${fw.label} apps can't be edited visually yet — the designer works with ${SUPPORTED_FRAMEWORKS}.`);
  else if (!refs.length) warnings.push('No pages were found in this repository.');

  // ── designer metadata: components + data made here before ──
  const metaRaw = await tryRead(api, DESIGNER_META, branch, originals);
  let meta: DesignerMeta = { version: 1 };
  try {
    if (metaRaw) meta = { version: 1, ...JSON.parse(metaRaw) };
  } catch {
    warnings.push(`${DESIGNER_META} is not valid JSON and was ignored.`);
  }
  const symbolIds: Record<string, string> = {};
  for (const c of meta.components ?? []) {
    if (!paths.includes(c.path)) continue;
    let tag = c.name;
    if (family === 'angular') {
      const code = await read(c.path);
      tag = (code && angularComponent(parse, code, c.path)?.selector) || `app-${kebab(c.name)}`;
    }
    symbolIds[tag] = `sym:${c.path}`;
  }

  const routeIds: Record<string, string> = {};
  for (const r of refs) routeIds[r.route] = pageId(r);
  const idByPath = new Map(refs.map((r) => [r.path, pageId(r)]));
  const markupCtx = (path: string): MarkupImportContext => family === 'html'
    ? {
      symbols: symbolIds,
      resolveLink: (href) => {
        const p = resolveHref(path, href, fw.root);
        if (!p) return undefined;
        return idByPath.get(p) ?? idByPath.get(`${p}.html`) ?? idByPath.get(`${p}/index.html`);
      },
    }
    : { routes: routeIds, symbols: symbolIds };
  const importFile = async (code: string, path: string, exportName?: string): Promise<ImportedPage | MarkupPage> => {
    if (!dialect) return importPage(parse, code, path, { routes: routeIds, symbols: symbolIds, exportName, solid: family === 'solid' });
    if (dialect === 'angular') {
      // The template and stylesheets live next to the component: read them first.
      const c = angularComponent(parse, code, path, exportName);
      for (const p of [c?.templateUrl, ...(c?.styleUrls ?? [])]) if (p) await read(p);
    }
    return importMarkupPage(fw, parsers, parse, code, path, (p) => originals.get(p)?.content ?? null, markupCtx(path), exportName);
  };

  const pages: OpenPage[] = [];
  for (const ref of refs) {
    const code = await read(ref.path);
    const imported = code === null ? { ok: false, reason: `Could not read ${ref.path}.`, nodes: [] } : await importFile(code, ref.path, ref.exportName);
    pages.push({ ...ref, id: pageId(ref), imported });
  }

  // A static site using the Tailwind CDN / browser build: render its classes too.
  if (family === 'html' && !fw.tailwind) {
    const home = pages.find((p) => p.route === '/') ?? pages[0];
    const html = home ? originals.get(home.path)?.content ?? '' : '';
    if (/cdn\.tailwindcss\.com|@tailwindcss\/browser/.test(html)) {
      fw.tailwind = true;
      fw.tailwindVersion = /@tailwindcss\/browser/.test(html) ? 4 : 3;
    }
  }

  const ext = (p: string) => (family === 'react' ? 'tsx' : (p.match(/\.(\w+)$/)?.[1] ?? 'tsx'));
  const symbolFiles: ProjectFile[] = [];
  const componentCss: string[] = [];
  for (const p of pages) componentCss.push(...((p.imported as MarkupPage).files?.css ?? []));
  for (const c of meta.components ?? []) {
    const code = await read(c.path);
    if (code === null) continue;
    const imp = await importFile(code, c.path);
    if (!imp.ok) continue;
    componentCss.push(...((imp as MarkupPage).files?.css ?? []));
    symbolFiles.push({ id: `sym:${c.path}`, name: `${c.name}.${ext(c.path)}`, type: 'file', language: 'tsx', symbol: true, nodes: imp.nodes, repoPath: c.path, repoSha: originals.get(c.path)?.sha });
  }

  // Data: designer-made sources + small JSON files under <src>/data.
  const dataDir = `${fw.root ? fw.root + '/' : ''}${fw.srcDir ? fw.srcDir + '/' : ''}data/`;
  const dataPaths = new Set([...(meta.data ?? []).map((d) => d.path), ...paths.filter((p) => p.startsWith(dataDir) && p.endsWith('.json'))]);
  const dataFiles: ProjectFile[] = [];
  for (const p of dataPaths) {
    const code = await tryRead(api, p, branch, originals);
    if (code === null || code.length > 200_000) continue;
    dataFiles.push({ id: `data:${p}`, name: p.split('/').pop()!, type: 'file', language: 'json', content: code, repoPath: p, repoSha: originals.get(p)?.sha });
  }

  // App stylesheet (for faithful rendering).
  const cssPaths = family === 'react' ? cssCandidates(paths, fw.root) : [...await extraCssPaths(fw, paths, pages, read), ...cssCandidates(paths, fw.root, family)];
  const cssFiles: Array<{ path: string; content: string }> = [];
  for (const p of [...new Set(cssPaths)]) {
    const c = await tryRead(api, p, branch, originals);
    if (c !== null) cssFiles.push({ path: p, content: c });
  }
  const appCss = pickAppCss(cssFiles);
  // Without Tailwind every global stylesheet counts (a static site often links several).
  if (family !== 'react' && !fw.tailwind) for (const f of cssFiles) if (f !== appCss) componentCss.unshift(f.content);

  const pageFiles: ProjectFile[] = pages.map((p) => ({
    id: p.id,
    name: `${pageTitle(p)}.${ext(p.path)}`,
    type: 'file',
    language: 'tsx',
    nodes: p.imported.ok ? p.imported.nodes : [],
    route: p.route,
    home: p.route === '/',
    repoPath: p.path,
    repoSha: originals.get(p.path)?.sha,
    exportName: p.exportName,
    ...(p.imported.ok ? {} : { readonlyReason: p.imported.reason }),
  }));
  if (pageFiles.length && !pageFiles.some((f) => f.home)) pageFiles[0].home = true;

  const project: BuilderProject = {
    version: 1,
    name: repo,
    source: { repo, branch },
    // The page language (Code view highlighting, AI context) follows the app.
    settings: { ...DEFAULT_SETTINGS, theme: meta.theme ?? DEFAULT_SETTINGS.theme, ...(['vue', 'svelte', 'angular', 'solid'].includes(family) ? { framework: family } : {}) },
    files: [{
      id: 'f_src', name: 'src', type: 'folder', expanded: true, children: [
        { id: 'f_pages', name: 'pages', type: 'folder', expanded: true, children: pageFiles },
        { id: 'f_symbols', name: 'components', type: 'folder', expanded: true, children: symbolFiles },
        { id: 'f_data', name: 'data', type: 'folder', expanded: true, children: dataFiles },
      ],
    }],
  };
  const css = componentCss.join('\n').slice(0, 300_000);
  return {
    session: {
      repo, branch, framework: fw, paths, originals, pages, routerFile, appCss, meta, metaRaw, alias, warnings, editable, parsers,
      ...(css.trim() ? { componentCss: css } : {}),
    },
    project,
  };
}

/** Page discovery for the non-React frameworks. */
async function discoverPages(
  fw: Framework, paths: string[], parse: ParseFn, parsers: MarkupParsers, alias: Record<string, string>, read: (p: string) => Promise<string | null>,
): Promise<{ refs: PageRef[]; routerFile: string | null }> {
  const family = familyOf(fw);
  if (fw.router === 'solid-start') return { refs: solidStartPages(fw, paths), routerFile: null };
  if (fw.router === 'nuxt') return { refs: nuxtPages(fw, paths), routerFile: null };
  if (fw.router === 'sveltekit') return { refs: svelteKitPages(fw, paths), routerFile: null };
  if (family === 'html') return { refs: htmlPages(fw, paths), routerFile: null };
  if (family === 'solid') {
    for (const cand of routerCandidates(fw, paths)) {
      const code = await read(cand);
      const found = code ? reactRouterPages(parse, code, cand, paths, alias, { lazy: true }) : [];
      if (found.length) return { refs: found, routerFile: cand };
    }
    const folder = folderPages(fw, paths);
    const root = rootComponent(fw, paths);
    return { refs: folder.length ? folder : root ? [root] : [], routerFile: null };
  }
  if (family === 'angular') {
    for (const cand of angularRouterCandidates(fw, paths)) {
      const code = await read(cand);
      if (!code) continue;
      const res = objectRoutes(parse, code, cand, paths, alias, { kind: 'angular', exts: ['ts'] });
      const refs = [...res.pages];
      // Lazy child route files (`loadChildren`), two levels deep.
      let pending = res.pending;
      for (let depth = 0; depth < 2 && pending.length; depth++) {
        const next: typeof pending = [];
        for (const p of pending) {
          const child = await read(p.path);
          if (!child) continue;
          const r = objectRoutes(parse, child, p.path, paths, alias, { kind: 'angular', exts: ['ts'], prefix: p.prefix, exportName: p.exportName });
          for (const x of r.pages) if (!refs.some((o) => o.route === x.route)) refs.push(x);
          next.push(...r.pending);
        }
        pending = next;
      }
      if (refs.length) return { refs: sortRoutes(refs), routerFile: cand };
    }
    const root = rootFile(fw, paths, ['src/app/app.component.ts', 'src/app/app.ts']);
    return { refs: root ? [root] : [], routerFile: null };
  }
  if (family === 'vue') {
    for (const cand of vueRouterCandidates(fw, paths)) {
      const code = await read(cand);
      if (!code) continue;
      const res = objectRoutes(parse, code, cand, paths, alias, { kind: 'vue', exts: ['vue', 'ts', 'js'] });
      if (res.pages.length) return { refs: res.pages, routerFile: cand };
    }
    const folder = folderPagesExt(fw, paths, 'vue');
    const root = rootFile(fw, paths, ['src/App.vue', 'App.vue']);
    return { refs: folder.length ? folder : root ? [root] : [], routerFile: null };
  }
  if (family === 'svelte') {
    for (const cand of svelteRouterCandidates(fw, paths)) {
      const code = await read(cand);
      if (!code) continue;
      let script = code;
      let offset = 0;
      if (cand.endsWith('.svelte')) {
        const parsed = (() => { try { return parsers.svelte?.(code) ?? null; } catch { return null; } })();
        const inst = parsed?.scripts.find((s) => !s.module);
        if (!inst) continue;
        script = code.slice(inst.contentStart, inst.contentEnd);
        offset = inst.contentStart;
      }
      const spa = svelteSpaPages(parse, script, offset, cand, paths, alias);
      if (spa.pages.length) return { refs: spa.pages, routerFile: cand };
      if (cand.endsWith('.svelte')) {
        const sr = svelteRoutingPages(parse, code, script, cand, paths, alias);
        if (sr.length) return { refs: sr, routerFile: cand };
      }
    }
    const folder = folderPagesExt(fw, paths, 'svelte');
    const root = rootFile(fw, paths, ['src/App.svelte', 'App.svelte']);
    return { refs: folder.length ? folder : root ? [root] : [], routerFile: null };
  }
  return { refs: [], routerFile: null };
}

/** Stylesheets a framework declares outside the usual places (angular.json `styles`, a static page's `<link>`s). */
async function extraCssPaths(fw: Framework, paths: string[], pages: OpenPage[], read: (p: string) => Promise<string | null>): Promise<string[]> {
  const out: string[] = [];
  const family = familyOf(fw);
  if (family === 'angular') {
    const cfg = await read(fw.root ? `${fw.root}/angular.json` : 'angular.json');
    try {
      const json = cfg ? JSON.parse(cfg) : null;
      for (const p of Object.values(json?.projects ?? {}) as Array<{ architect?: { build?: { options?: { styles?: Array<string | { input: string }> } } } }>) {
        for (const s of p.architect?.build?.options?.styles ?? []) {
          const f = typeof s === 'string' ? s : s.input;
          if (f?.endsWith('.css')) out.push(fw.root ? `${fw.root}/${f}` : f);
        }
      }
    } catch { /* not JSON */ }
  }
  if (family === 'html') {
    const home = pages.find((p) => p.route === '/') ?? pages[0];
    const doc = (home?.imported as MarkupPage | undefined)?.files?.html;
    for (const href of doc?.stylesheets ?? []) {
      const p = resolveHref(home!.path, href, fw.root);
      if (p && paths.includes(p)) out.push(p);
    }
  }
  return out;
}

/* ───────────────────────────── changes ───────────────────────────── */

export interface FileChange {
  path: string;
  /** null for a new file. */
  before: string | null;
  after: string;
  /** Blob sha when opened (null for new files) — for conflict checks. */
  sha: string | null;
  /** What the change is, for the review list. */
  reason: string;
}

export interface ChangeSet {
  changes: FileChange[];
  warnings: string[];
}

function pascal(s: string): string {
  const v = s.replace(/\.\w+$/, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/(?:^|\s)(\w)/g, (_m, c: string) => c.toUpperCase());
  return /^[A-Za-z]/.test(v) ? v : `Page${v}`;
}

function camel(s: string): string {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

export function computeChanges(session: RepoSession, project: BuilderProject, parse: ParseFn): ChangeSet {
  const fw = session.framework;
  const files = project.files;
  const warnings: string[] = [];
  const changes = new Map<string, FileChange>();
  const put = (path: string, after: string, reason: string) => {
    const orig = session.originals.get(path);
    const before = changes.get(path)?.before ?? orig?.content ?? null;
    if (before === after) { changes.delete(path); return; }
    changes.set(path, { path, before, after, sha: orig?.sha ?? null, reason });
  };
  const current = (path: string) => changes.get(path)?.after ?? session.originals.get(path)?.content ?? null;
  const base = `${fw.root ? fw.root + '/' : ''}${fw.srcDir ? fw.srcDir + '/' : ''}`;
  const data: PrintContext['data'] = {};
  for (const d of listDataSources(files)) {
    data[d.id] = { name: camel(dataSourceName(d)), path: d.repoPath ?? `${base}data/${slugify(dataSourceName(d)) || 'data'}.json` };
  }

  const metaComponents = dialectOf(fw)
    ? markupChanges(session, project, parse, put, current, warnings)
    : jsxChanges(session, project, parse, put, warnings, data);

  // Removed pages are never deleted from the repo.
  for (const o of session.pages) {
    if (o.imported.ok && !findFileInTree(files, o.id)) warnings.push(`${o.path} was removed from the designer but is left in the repository — delete it in code if you meant to.`);
  }

  // Data sources.
  for (const d of listDataSources(files)) put(data[d.id].path, d.content ?? '[]', d.repoPath ? 'Edited data' : 'New data source');

  // Designer metadata — versioned with the code. Data files that were simply
  // found in the repo aren't recorded; ones made here (or recorded before) are.
  const recorded = new Set((session.meta.data ?? []).map((d) => d.path));
  const designerData = listDataSources(files)
    .filter((d) => !d.repoPath || recorded.has(d.repoPath))
    .map((d) => ({ name: data[d.id].name, path: data[d.id].path }));
  const meta: DesignerMeta = {
    version: 1,
    ...(project.settings.theme !== DEFAULT_SETTINGS.theme ? { theme: project.settings.theme } : {}),
    ...(metaComponents.length ? { components: metaComponents } : {}),
    ...(designerData.length ? { data: designerData } : {}),
  };
  const metaText = JSON.stringify(meta, null, 2) + '\n';
  const meaningful = Object.keys(meta).length > 1;
  if ((session.metaRaw ?? null) !== metaText && (meaningful || session.metaRaw !== null) && changes.size) put(DESIGNER_META, metaText, 'Designer metadata');

  return { changes: [...changes.values()], warnings: [...new Set(warnings)] };
}

type Put = (path: string, after: string, reason: string) => void;

/** React / Solid (JSX) pages, new pages + routes, components. Returns the designer components for the metadata. */
function jsxChanges(session: RepoSession, project: BuilderProject, parse: ParseFn, put: Put, warnings: string[], data: PrintContext['data']): Array<{ name: string; path: string }> {
  const fw = session.framework;
  const files = project.files;
  const pages = listPages(files);
  const ext = fw.typescript ? 'tsx' : 'jsx';
  const base = `${fw.root ? fw.root + '/' : ''}${fw.srcDir ? fw.srcDir + '/' : ''}`;

  // Paths for anything new.
  const existingRefs: PageRef[] = session.pages;
  const pagePaths = new Map<string, string>();
  const routes: Record<string, string> = {};
  for (const p of pages) {
    const route = p.route ?? pageRoute(p, files);
    routes[p.id] = route;
    pagePaths.set(p.id, p.repoPath ?? newPagePath(fw, route, pascal(p.name), existingRefs));
  }
  const symbols: PrintContext['symbols'] = {};
  for (const s of listSymbols(files)) {
    const name = pascal(symbolName(s));
    symbols[s.id] = { name, path: s.repoPath ?? `${base}components/${name}.${ext}` };
  }
  const ctxFor = (filePath: string) => ({ framework: fw, filePath, routes, symbols, data });
  const solid = familyOf(fw) === 'solid';

  // Existing pages: splice in place, grouped per file.
  const plansByFile = new Map<string, SplicePlan[]>();
  for (const p of pages) {
    if (!p.repoPath || p.readonlyReason) continue;
    const open = session.pages.find((o) => o.id === p.id);
    const orig = session.originals.get(p.repoPath);
    const imported = open?.imported as ImportedPage | undefined;
    if (!imported?.ok || !imported.region || !orig) continue;
    const plan = planSplice(orig.content, imported.region, p.nodes ?? [], ctxFor(p.repoPath));
    plansByFile.set(p.repoPath, [...(plansByFile.get(p.repoPath) ?? []), plan]);
    if (p.route && open && p.route !== open.route) warnings.push(`Route changes for existing pages aren't written yet — ${open.route} stays in code.`);
  }
  for (const [path, plans] of plansByFile) put(path, applyPlans(session.originals.get(path)!.content, plans), 'Edited page');

  // New pages (+ route wiring).
  let router = session.routerFile ? session.originals.get(session.routerFile)?.content ?? null : null;
  for (const p of pages) {
    if (p.repoPath) continue;
    const path = pagePaths.get(p.id)!;
    const name = pascal(p.name);
    put(path, newComponentModule(name, p.nodes ?? [], ctxFor(path)), 'New page');
    if (fw.router === 'react-router' || fw.router === 'solid-router') {
      if (router !== null && session.routerFile) {
        const next = addReactRoute(parse, router, session.routerFile, routes[p.id], name, relativeImport(session.routerFile, path), solid);
        if (next) { router = next; put(session.routerFile, router, 'Route added'); }
        else warnings.push(`Couldn't recognise the routes in ${session.routerFile} — add a route for ${path} by hand.`);
      } else warnings.push(`No route config found — add a route for ${path} by hand.`);
    } else if (fw.router === 'none') {
      warnings.push(`This app has no router — ${path} was created but isn't linked from anywhere yet.`);
    }
  }

  // Components.
  for (const s of listSymbols(files)) {
    const sym = symbols[s.id];
    const master = s.nodes?.[0];
    if (!master) continue;
    if (s.repoPath && session.originals.has(s.repoPath)) {
      const orig = session.originals.get(s.repoPath)!.content;
      const imp = importPage(parse, orig, s.repoPath, { solid });
      if (imp.ok && imp.region) put(s.repoPath, applyPlans(orig, [planSplice(orig, imp.region, [master], ctxFor(s.repoPath))]), 'Edited component');
    } else {
      put(sym.path, newComponentModule(sym.name, [master], ctxFor(sym.path)), 'New component');
    }
  }
  return Object.values(symbols).map((s) => ({ name: s.name, path: s.path }));
}

/** Where a new page goes in a template framework, by its conventions and the repo's existing pages. */
function newMarkupPagePath(fw: Framework, route: string, name: string, existing: PageRef[], ng: NgStyle | null): string {
  const slug = route.replace(/^\/+|\/+$/g, '');
  const root = fw.root ? fw.root + '/' : '';
  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
  switch (fw.router) {
    case 'nuxt': {
      const dir = existing.find((p) => /(^|\/)pages\//.test(p.path))?.path.match(/^(.*?pages)\//)?.[1] ?? `${root}pages`;
      return `${dir}/${slug || 'index'}.vue`;
    }
    case 'sveltekit':
      return `${root}src/routes/${slug ? slug + '/' : ''}+page.svelte`;
    case 'html': {
      const home = existing.find((p) => p.route === '/') ?? existing[0];
      const dir = home ? dirOf(home.path) : fw.root;
      return `${dir ? dir + '/' : ''}${kebab(slug || name) || 'page'}.html`;
    }
  }
  if (familyOf(fw) === 'angular' && ng) {
    const n = angularNames(name, ng);
    return `${ng.pagesDir}/${ng.folder ? n.slug + '/' : ''}${n.file}.ts`;
  }
  const ext = familyOf(fw) === 'vue' ? 'vue' : 'svelte';
  const pageLike = existing.find((p) => /\/(pages|views|screens|routes)\//.test(p.path) && p.path.endsWith('.' + ext));
  const dir = pageLike ? dirOf(pageLike.path) : `${root}src/${ext === 'vue' ? 'views' : 'routes'}`;
  const suffix = pageLike && /View\.vue$/.test(pageLike.path) ? 'View' : '';
  return `${dir}/${name}${suffix}.${ext}`;
}

/** Angular / Vue / Svelte / static HTML pages, new pages + routes, components. */
function markupChanges(
  session: RepoSession, project: BuilderProject, parse: ParseFn, put: Put, current: (path: string) => string | null, warnings: string[],
): Array<{ name: string; path: string }> {
  const fw = session.framework;
  const family = familyOf(fw);
  const files = project.files;
  const pages = listPages(files);
  const root = fw.root ? fw.root + '/' : '';
  const base = `${root}${fw.srcDir ? fw.srcDir + '/' : ''}`;
  const parsers = session.parsers ?? {};
  const original = (p: string) => session.originals.get(p)?.content ?? null;
  const ngStyle = family === 'angular'
    ? angularStyle(fw, session.pages.map((p) => ({ path: p.path, ng: (p.imported as MarkupPage).files?.ng })))
    : null;
  const display = (f: ProjectFile) => f.name.replace(/\.\w+$/, '');

  // Routes (static HTML: the page's file) and paths of new pages.
  const routes: Record<string, string> = {};
  const newPaths = new Map<string, string>();
  for (const p of pages) {
    const route = p.route ?? pageRoute(p, files);
    if (!p.repoPath) newPaths.set(p.id, newMarkupPagePath(fw, route, pascal(p.name), session.pages, ngStyle));
    routes[p.id] = family === 'html' ? (p.repoPath ?? newPaths.get(p.id)!) : route;
  }

  // Components made in the designer.
  const symbols: MarkupPrintContext['symbols'] = {};
  const metaComponents: Array<{ name: string; path: string }> = [];
  for (const s of listSymbols(files)) {
    const name = pascal(symbolName(s));
    if (family === 'html') { symbols[s.id] = { name, path: '', tag: name, nodes: s.nodes ?? [] }; continue; }
    if (family === 'angular') {
      const n = angularNames(name, ngStyle!);
      const existing = s.repoPath ? angularComponent(parse, original(s.repoPath) ?? '', s.repoPath) : null;
      const path = s.repoPath ?? `${base}app/components/${ngStyle!.folder ? n.slug + '/' : ''}${n.file}.ts`;
      symbols[s.id] = { name: existing?.className ?? n.cls, path, tag: existing?.selector ?? n.selector };
    } else {
      const ext = family === 'vue' ? 'vue' : 'svelte';
      const dir = fw.router === 'sveltekit' ? `${root}src/lib/components` : `${base}components`;
      symbols[s.id] = { name, path: s.repoPath ?? `${dir}/${name}.${ext}`, tag: name };
    }
    metaComponents.push({ name, path: symbols[s.id].path });
  }
  const pbase = { framework: fw, routes, symbols };

  // Static HTML: new pages get a link in each page's <nav> (the site's navigation is copied per page).
  const nodesFor = new Map<string, CanvasNode[]>(pages.map((p) => [p.id, p.nodes ?? []]));
  const added = pages.filter((p) => !p.repoPath);
  if (family === 'html' && added.length) {
    for (const p of pages) {
      if (!p.repoPath || p.readonlyReason) continue;
      const clone = structuredClone(p.nodes ?? []) as CanvasNode[];
      const nav = findNav(clone);
      if (!nav) continue;
      const last = [...nav.children].reverse().find((c) => c.type === 'link');
      for (const np of added) {
        if (nav.children.some((c) => c.interactions?.some((i) => i.targetPageId === np.id))) continue;
        nav.children.push({
          id: genId(), type: 'link', children: [], style: {},
          props: { ...(typeof last?.props?.className === 'string' && last.props.className ? { className: last.props.className } : {}), children: display(np) },
          interactions: [{ trigger: 'click', action: 'navigate', targetPageId: np.id }],
        });
      }
      nodesFor.set(p.id, clone);
    }
  }

  // Existing pages: splice in place.
  for (const p of pages) {
    if (!p.repoPath || p.readonlyReason) continue;
    const open = session.pages.find((o) => o.id === p.id);
    const imp = open?.imported as MarkupPage | undefined;
    if (!imp?.ok || !imp.region) continue;
    const res = markupPageChanges(imp, original, nodesFor.get(p.id) ?? [], pbase, p.repoPath);
    for (const f of res.files) put(f.path, f.after, 'Edited page');
    warnings.push(...res.warnings);
    if (p.route && open && p.route !== open.route && family !== 'html') warnings.push(`Route changes for existing pages aren't written yet — ${open.route} stays in code.`);
  }

  // New pages (+ route wiring).
  const home = session.pages.find((o) => o.route === '/') ?? session.pages[0];
  for (const p of added) {
    const path = newPaths.get(p.id)!;
    const name = pascal(p.name);
    const ng = ngStyle ? { ...ngStyle, ...angularNames(name, ngStyle) } : undefined;
    const homeImp = home?.imported as MarkupPage | undefined;
    const htmlShell = family === 'html' && home && homeImp?.files?.html && original(home.path) !== null
      ? { code: original(home.path)!, doc: homeImp.files.html, title: display(p), chrome: htmlChrome(nodesFor.get(home.id) ?? []) }
      : undefined;
    const out = newMarkupModule('page', name, path, p.nodes ?? [], pbase, { ng, htmlShell });
    for (const f of out.files) put(f.path, f.content, 'New page');
    warnings.push(...out.warnings);
    const wired = wireRoute(session, parse, current, routes[p.id], name, path, ng?.cls);
    if (wired.file) put(wired.file, wired.after!, 'Route added');
    if (wired.warning) warnings.push(wired.warning);
  }

  // Components.
  for (const s of listSymbols(files)) {
    if (family === 'html') continue;
    const sym = symbols[s.id];
    const master = s.nodes?.[0];
    if (!master) continue;
    if (s.repoPath && session.originals.has(s.repoPath)) {
      const imp = importMarkupPage(fw, parsers, parse, original(s.repoPath)!, s.repoPath, original);
      if (!imp.ok || !imp.region) continue;
      const res = markupPageChanges(imp, original, s.nodes ?? [], pbase, s.repoPath);
      for (const f of res.files) put(f.path, f.after, 'Edited component');
      warnings.push(...res.warnings);
    } else {
      const n = ngStyle ? angularNames(pascal(symbolName(s)), ngStyle) : null;
      const out = newMarkupModule('component', sym.name, sym.path, [master], pbase, n ? { ng: { ...ngStyle!, ...n, templateUrl: false } } : {});
      for (const f of out.files) put(f.path, f.content, 'New component');
      warnings.push(...out.warnings);
    }
  }
  if (family === 'html' && listSymbols(files).length) warnings.push('Static HTML has no components — designer components are written into each page as plain markup.');
  return metaComponents;
}

/** Register a new page with the app's router (file-based routers need nothing). */
function wireRoute(
  session: RepoSession, parse: ParseFn, current: (path: string) => string | null, route: string, name: string, path: string, ngClass?: string,
): { file?: string; after?: string; warning?: string } {
  const fw = session.framework;
  const file = session.routerFile;
  const code = file ? current(file) : null;
  const byHand = `add a route for ${path} by hand.`;
  if (['nuxt', 'sveltekit', 'solid-start', 'html'].includes(fw.router)) return {};
  if (fw.router === 'none' || !file || code === null) {
    return { warning: fw.router === 'none' ? `This app has no router — ${path} was created but isn't linked from anywhere yet.` : `No route config found — ${byHand}` };
  }
  const { q, semi } = codeStyle(code);
  const s = semi ? ';' : '';
  const fail = { warning: `Couldn't recognise the routes in ${file} — ${byHand}` };
  if (fw.router === 'angular') {
    const rel = relativeModule(file, path);
    const lazy = /loadComponent\s*:/.test(code);
    const p = route.replace(/^\/+/, '');
    const entry = lazy
      ? `{ path: ${q}${p}${q}, loadComponent: () => import(${q}${rel}${q}).then((m) => m.${ngClass}) }`
      : `{ path: ${q}${p}${q}, component: ${ngClass} }`;
    let next = addObjectRoute(parse, code, file, entry, 'angular');
    if (!next) return fail;
    if (!lazy) next = addImportLine(next, `import { ${ngClass} } from ${q}${rel}${q}${s}`);
    return { file, after: next };
  }
  if (fw.router === 'vue-router') {
    const srcDir = `${fw.root ? fw.root + '/' : ''}src/`;
    const rel = /from\s+['"]@\//.test(code) && path.startsWith(srcDir) ? '@/' + path.slice(srcDir.length) : relativeModule(file, path, true);
    const lazy = /component\s*:\s*\(\)\s*=>\s*import\(/.test(code);
    const named = /\bname\s*:/.test(code);
    const slug = route.replace(/^\/+/, '').replace(/\//g, '-') || 'home';
    const entry = `{ path: ${q}${route}${q}, ${named ? `name: ${q}${slug}${q}, ` : ''}component: ${lazy ? `() => import(${q}${rel}${q})` : name} }`;
    let next = addObjectRoute(parse, code, file, entry, 'vue');
    if (!next) return fail;
    if (!lazy) next = addImportLine(next, `import ${name} from ${q}${rel}${q}${s}`);
    return { file, after: next };
  }
  if (fw.router === 'svelte-spa-router' || fw.router === 'svelte-routing') {
    const rel = relativeModule(file, path, true);
    const importLine = `import ${name} from ${q}${rel}${q}${s}`;
    if (!file.endsWith('.svelte')) {
      const next = addSpaRoute(parse, code, file, route, name, q);
      return next ? { file, after: addImportLine(next, importLine) } : fail;
    }
    const inst = (() => { try { return session.parsers?.svelte?.(code).scripts.find((x) => !x.module) ?? null; } catch { return null; } })();
    if (!inst) return fail;
    const script = code.slice(inst.contentStart, inst.contentEnd);
    let markup = code;
    let nextScript = script;
    if (fw.router === 'svelte-spa-router') {
      const r = addSpaRoute(parse, script, file, route, name, q);
      if (!r) return fail;
      nextScript = r;
    } else {
      const r = addSvelteRoutingRoute(code, route, name);
      if (!r) return fail;
      markup = r;
    }
    nextScript = addImportLine(nextScript, importLine);
    return { file, after: markup.slice(0, inst.contentStart) + nextScript + markup.slice(inst.contentEnd) };
  }
  return fail;
}

/**
 * The code a single page / component would be saved as — for the Code view.
 * Cheap enough to run on every edit of the open page.
 */
export function previewFile(session: RepoSession, project: BuilderProject, fileId: string, parse: ParseFn): string | null {
  const file = findFileInTree(project.files, fileId);
  if (!file || file.readonlyReason) return null;
  const { changes } = computeChanges(session, { ...project, files: project.files }, parse);
  let path = file.repoPath ?? null;
  // Angular `templateUrl` pages: the template is what the designer edits.
  const tpl = (session.pages.find((o) => o.id === fileId)?.imported as MarkupPage | undefined)?.region?.file;
  if (path && tpl && tpl !== path) path = tpl;
  if (path) return changes.find((c) => c.path === path)?.after ?? session.originals.get(path)?.content ?? null;
  // New page / component: the created file (an Angular page's template when it has one).
  const created = changes.filter((c) => c.before === null && /\.(tsx|jsx|vue|svelte|ts|html)$/.test(c.path) && !c.path.endsWith('.d.ts'));
  const name = file.name.replace(/\.\w+$/, '').replace(/[^A-Za-z0-9]+/g, '');
  const keys = [name.toLowerCase(), kebab(name)];
  const mine = created.filter((c) => keys.some((k) => c.path.toLowerCase().includes(k)));
  const html = mine.find((c) => c.path.endsWith('.html'));
  return (familyOf(session.framework) === 'angular' && html ? html : mine.find((c) => !c.path.endsWith('.html')) ?? html)?.after ?? null;
}

/** Files whose blob changed upstream since the session was opened. */
export async function findConflicts(api: RepoApi, changes: FileChange[], branch: string): Promise<string[]> {
  const out: string[] = [];
  await Promise.all(changes.map(async (c) => {
    try {
      const now = await api.read(c.path, branch);
      if (c.sha === null || now.sha !== c.sha) out.push(c.path);
    } catch {
      if (c.sha !== null) out.push(c.path);
    }
  }));
  return out.sort();
}

/** A branch name for a designer change: `designer/<repo>-<yyyymmdd-hhmm>`. */
export function designerBranch(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `designer/${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** Same rule as Develop's `pullRequestsBlocked` (git.ts): PR calls 404 on these. */
export function pullRequestsBlocked(r?: { mirror?: boolean; archived?: boolean; empty?: boolean; has_pull_requests?: boolean }): string | null {
  if (!r) return null;
  if (r.mirror) return 'This repository is a pull mirror — its content is overwritten from upstream, so pull requests belong in the upstream repository.';
  if (r.archived) return 'This repository is archived and read-only.';
  if (r.empty) return 'This repository has no commits yet.';
  if (r.has_pull_requests === false) return 'Pull requests are turned off for this repository (Settings → Pull requests).';
  return null;
}

/** Repos the designer must not write to at all (direct commits included). */
export function writesBlocked(r?: { mirror?: boolean; archived?: boolean }): string | null {
  if (r?.mirror) return 'This repository is a pull mirror — changes made here would be overwritten from upstream.';
  if (r?.archived) return 'This repository is archived and read-only.';
  return null;
}

/** Stable id for a node created in the designer (exported for tests). */
export const freshId = genId;
export type { CanvasNode };
export { isPagePath };
