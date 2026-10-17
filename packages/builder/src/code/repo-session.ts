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
import { detectFramework, findAppPackageJson, isEditable, type Framework } from './framework.ts';
import { importPage, type ImportedPage } from './jsx-import.ts';
import { applyPlans, newComponentModule, planSplice, relativeImport, type PrintContext, type SplicePlan } from './jsx-print.ts';
import {
  addReactRoute, aliasesFrom, folderPages, isPagePath, newPagePath, nextPages, reactRouterPages, remixPages, rootComponent, routerCandidates,
  type PageRef,
} from './routes.ts';
import { cssCandidates, pickAppCss } from './css-theme.ts';

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
  imported: ImportedPage;
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
}

const pageId = (ref: PageRef) => `pg:${ref.path}${ref.exportName ? '#' + ref.exportName : ''}`;

function pageTitle(ref: PageRef): string {
  if (ref.exportName) return ref.exportName;
  if (ref.route === '/') return 'Home';
  const last = ref.route.split('/').filter((s) => s && !s.startsWith(':') && s !== '*').pop();
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

export async function openRepo(api: RepoApi, parse: ParseFn, repo: string, branch: string): Promise<{ session: RepoSession; project: BuilderProject }> {
  const { entries, truncated } = await api.tree(branch);
  const paths = entries.map((e) => e.path).filter((p) => !p.includes('node_modules/'));
  const originals: RepoSession['originals'] = new Map();
  const warnings: string[] = [];
  if (truncated) warnings.push('The repository is very large; only part of its file list was read.');

  const pkgPath = findAppPackageJson(paths);
  const pkgText = pkgPath ? await tryRead(api, pkgPath, branch, originals) : null;
  const fw = detectFramework(pkgText, paths, pkgPath);
  const editable = isEditable(fw);
  const tsconfig = await tryRead(api, fw.root ? `${fw.root}/tsconfig.json` : 'tsconfig.json', branch, originals)
    ?? await tryRead(api, fw.root ? `${fw.root}/jsconfig.json` : 'jsconfig.json', branch, originals);
  const alias = aliasesFrom(tsconfig, fw.root);

  // ── pages ──
  let refs: PageRef[] = [];
  let routerFile: string | null = null;
  if (fw.id === 'next') refs = nextPages(fw, paths);
  else if (fw.id === 'remix') refs = remixPages(fw, paths);
  else if (editable) {
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
  }
  if (!editable) warnings.push(`${fw.label} apps can't be edited visually yet — the designer works with React apps (Vite, Next.js, Remix).`);
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
  for (const c of meta.components ?? []) if (paths.includes(c.path)) symbolIds[c.name] = `sym:${c.path}`;

  const routeIds: Record<string, string> = {};
  for (const r of refs) routeIds[r.route] = pageId(r);

  const pages: OpenPage[] = [];
  for (const ref of refs) {
    const code = await tryRead(api, ref.path, branch, originals);
    const imported: ImportedPage = code === null
      ? { ok: false, reason: `Could not read ${ref.path}.`, nodes: [] }
      : importPage(parse, code, ref.path, { routes: routeIds, symbols: symbolIds, exportName: ref.exportName });
    pages.push({ ...ref, id: pageId(ref), imported });
  }

  const symbolFiles: ProjectFile[] = [];
  for (const c of meta.components ?? []) {
    const code = await tryRead(api, c.path, branch, originals);
    if (code === null) continue;
    const imp = importPage(parse, code, c.path, { routes: routeIds, symbols: symbolIds });
    if (!imp.ok) continue;
    symbolFiles.push({ id: `sym:${c.path}`, name: `${c.name}.tsx`, type: 'file', language: 'tsx', symbol: true, nodes: imp.nodes, repoPath: c.path, repoSha: originals.get(c.path)?.sha });
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
  const cssFiles: Array<{ path: string; content: string }> = [];
  for (const p of cssCandidates(paths, fw.root)) {
    const c = await tryRead(api, p, branch, originals);
    if (c !== null) cssFiles.push({ path: p, content: c });
  }
  const appCss = pickAppCss(cssFiles);

  const pageFiles: ProjectFile[] = pages.map((p) => ({
    id: p.id,
    name: `${pageTitle(p)}.tsx`,
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
    settings: { ...DEFAULT_SETTINGS, theme: meta.theme ?? DEFAULT_SETTINGS.theme },
    files: [{
      id: 'f_src', name: 'src', type: 'folder', expanded: true, children: [
        { id: 'f_pages', name: 'pages', type: 'folder', expanded: true, children: pageFiles },
        { id: 'f_symbols', name: 'components', type: 'folder', expanded: true, children: symbolFiles },
        { id: 'f_data', name: 'data', type: 'folder', expanded: true, children: dataFiles },
      ],
    }],
  };
  return {
    session: { repo, branch, framework: fw, paths, originals, pages, routerFile, appCss, meta, metaRaw, alias, warnings, editable },
    project,
  };
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
  const data: PrintContext['data'] = {};
  for (const d of listDataSources(files)) {
    data[d.id] = { name: camel(dataSourceName(d)), path: d.repoPath ?? `${base}data/${slugify(dataSourceName(d)) || 'data'}.json` };
  }
  const ctxFor = (filePath: string) => ({ framework: fw, filePath, routes, symbols, data });

  // Existing pages: splice in place, grouped per file.
  const plansByFile = new Map<string, SplicePlan[]>();
  for (const p of pages) {
    if (!p.repoPath || p.readonlyReason) continue;
    const open = session.pages.find((o) => o.id === p.id);
    const orig = session.originals.get(p.repoPath);
    if (!open?.imported.ok || !open.imported.region || !orig) continue;
    const plan = planSplice(orig.content, open.imported.region, p.nodes ?? [], ctxFor(p.repoPath));
    plansByFile.set(p.repoPath, [...(plansByFile.get(p.repoPath) ?? []), plan]);
    if (p.route && p.route !== open.route) warnings.push(`Route changes for existing pages aren't written yet — ${open.route} stays in code.`);
  }
  for (const [path, plans] of plansByFile) put(path, applyPlans(session.originals.get(path)!.content, plans), 'Edited page');

  // Removed pages are never deleted from the repo.
  for (const o of session.pages) {
    if (o.imported.ok && !findFileInTree(files, o.id)) warnings.push(`${o.path} was removed from the designer but is left in the repository — delete it in code if you meant to.`);
  }

  // New pages (+ route wiring).
  let router = session.routerFile ? session.originals.get(session.routerFile)?.content ?? null : null;
  for (const p of pages) {
    if (p.repoPath) continue;
    const path = pagePaths.get(p.id)!;
    const name = pascal(p.name);
    put(path, newComponentModule(name, p.nodes ?? [], ctxFor(path)), 'New page');
    if (fw.router === 'react-router') {
      if (router !== null && session.routerFile) {
        const next = addReactRoute(parse, router, session.routerFile, routes[p.id], name, relativeImport(session.routerFile, path));
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
      const imp = importPage(parse, orig, s.repoPath);
      if (imp.ok && imp.region) put(s.repoPath, applyPlans(orig, [planSplice(orig, imp.region, [master], ctxFor(s.repoPath))]), 'Edited component');
    } else {
      put(sym.path, newComponentModule(sym.name, [master], ctxFor(sym.path)), 'New component');
    }
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
    ...(Object.keys(symbols).length ? { components: Object.values(symbols).map((s) => ({ name: s.name, path: s.path })) } : {}),
    ...(designerData.length ? { data: designerData } : {}),
  };
  const metaText = JSON.stringify(meta, null, 2) + '\n';
  const meaningful = Object.keys(meta).length > 1;
  if ((session.metaRaw ?? null) !== metaText && (meaningful || session.metaRaw !== null) && changes.size) put(DESIGNER_META, metaText, 'Designer metadata');

  return { changes: [...changes.values()], warnings: [...new Set(warnings)] };
}

/**
 * The code a single page / component would be saved as — for the Code view.
 * Cheap enough to run on every edit of the open page.
 */
export function previewFile(session: RepoSession, project: BuilderProject, fileId: string, parse: ParseFn): string | null {
  const file = findFileInTree(project.files, fileId);
  if (!file || file.readonlyReason) return null;
  const { changes } = computeChanges(session, { ...project, files: project.files }, parse);
  const path = file.repoPath ?? null;
  if (path) return changes.find((c) => c.path === path)?.after ?? session.originals.get(path)?.content ?? null;
  // New page / component: the created file.
  const created = changes.filter((c) => c.before === null && /\.(tsx|jsx)$/.test(c.path));
  const name = file.name.replace(/\.\w+$/, '').replace(/[^A-Za-z0-9]+/g, '');
  return created.find((c) => c.path.includes(name))?.after ?? null;
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
