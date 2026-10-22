/**
 * Pages of the template frameworks as files: where a page's template is (Vue
 * `<template>`, Svelte markup, Angular inline `template:` / `templateUrl`,
 * HTML `<body>`), where its script imports go, and how a new page or
 * component is written in the framework's — and the repo's — style.
 */

import type { CanvasNode } from '../lib/builder-types.ts';
import { lineIndent } from './jsx-import.ts';
import { familyOf, type Framework } from './framework.ts';
import { walk, type Node, type ParseFn } from './ast.ts';
import {
  applyEdits, importMarkup, importOffset, newNeeds, planMarkupSplice, printMarkupNode, printMarkupRoots, relativeModule, scriptImportLines,
  type Dialect, type Edit, type MarkupImportContext, type MarkupImported, type MarkupPrintContext, type MCode, type MNode, type Needs,
} from './markup.ts';
import { codeStyle, parseScript } from './markup-routes.ts';
import type { MarkupParsers, ParsedHtml, ScriptBlock } from './parsers/types.ts';

export function dialectOf(fw: Framework): Dialect | null {
  const f = familyOf(fw);
  return f === 'vue' || f === 'svelte' || f === 'angular' || f === 'html' ? f : null;
}

/* ───────────────────────────── Angular components ───────────────────────────── */

export interface NgComponent {
  className: string;
  selector?: string;
  /** The `@Component({...})` object. */
  decorator: { start: number; end: number };
  /** Inline template content range. */
  template?: { start: number; end: number; backtick: boolean; raw: string; computed?: boolean };
  /** `templateUrl`, resolved to a repo path. */
  templateUrl?: string;
  styleUrls: string[];
  styles: string[];
  /** The `imports: [...]` array. */
  imports?: { start: number; end: number; names: string[] };
  standalone?: boolean;
}

function resolveRel(from: string, rel: string): string {
  const dir = from.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') dir.pop();
    else dir.push(seg);
  }
  return dir.join('/');
}

export function angularComponent(parse: ParseFn, code: string, path: string, exportName?: string): NgComponent | null {
  const ast = parseScript(parse, code, path);
  if (!ast) return null;
  const found: NgComponent[] = [];
  walk(ast.program, (n) => {
    if (n.type !== 'ClassDeclaration' || !n.decorators?.length) return;
    for (const d of n.decorators) {
      const call = d.expression;
      if (call?.type !== 'CallExpression' || call.callee?.name !== 'Component') continue;
      const obj = call.arguments[0];
      if (obj?.type !== 'ObjectExpression') continue;
      const prop = (k: string) => obj.properties.find((p: Node) => p.type === 'ObjectProperty' && (p.key?.name === k || p.key?.value === k));
      const str = (v: Node): string | null => (v?.type === 'StringLiteral' ? v.value : v?.type === 'TemplateLiteral' && !v.expressions.length ? v.quasis[0].value.cooked : null);
      const info: NgComponent = { className: n.id?.name ?? 'Component', decorator: { start: obj.start, end: obj.end }, styleUrls: [], styles: [] };
      info.selector = str(prop('selector')?.value) ?? undefined;
      const tpl = prop('template')?.value;
      if (tpl?.type === 'TemplateLiteral' && tpl.quasis.length === 1) {
        info.template = { start: tpl.quasis[0].start, end: tpl.quasis[0].end, backtick: true, raw: tpl.quasis[0].value.raw };
      } else if (tpl?.type === 'StringLiteral') {
        info.template = { start: tpl.start + 1, end: tpl.end - 1, backtick: false, raw: code.slice(tpl.start + 1, tpl.end - 1) };
      } else if (tpl) {
        info.template = { start: tpl.start, end: tpl.end, backtick: false, raw: '', computed: true };
      }
      const url = str(prop('templateUrl')?.value);
      if (url) info.templateUrl = resolveRel(path, url);
      const su = prop('styleUrls')?.value ?? prop('styleUrl')?.value;
      for (const v of su?.type === 'ArrayExpression' ? su.elements : su ? [su] : []) { const s = str(v); if (s) info.styleUrls.push(resolveRel(path, s)); }
      const st = prop('styles')?.value;
      for (const v of st?.type === 'ArrayExpression' ? st.elements : st ? [st] : []) { const s = str(v); if (s) info.styles.push(s); }
      const im = prop('imports')?.value;
      if (im?.type === 'ArrayExpression') info.imports = { start: im.start, end: im.end, names: im.elements.map((e: Node) => e?.name ?? '').filter(Boolean) };
      const sa = prop('standalone')?.value;
      if (sa?.type === 'BooleanLiteral') info.standalone = sa.value;
      found.push(info);
    }
  });
  if (exportName) return found.find((f) => f.className === exportName) ?? null;
  return found[0] ?? null;
}

/** Angular ≥ 19 makes components standalone unless they say otherwise. */
export function isStandalone(fw: Framework, c: Pick<NgComponent, 'standalone'>): boolean {
  if (c.standalone !== undefined) return c.standalone;
  return (fw.major ?? 19) >= 19;
}

/* ───────────────────────────── import ───────────────────────────── */

export interface MarkupPageFiles {
  /** Where script imports go (Vue / Svelte): the block, or where to create one. */
  script?: { block: ScriptBlock | null; createAt: number };
  ng?: NgComponent;
  html?: ParsedHtml;
  /** Component-level CSS found while importing (Vue / Svelte `<style>`, Angular `styles`). */
  css?: string[];
}

export interface MarkupPage extends MarkupImported {
  files?: MarkupPageFiles;
}

function fail(reason: string): MarkupPage {
  return { ok: false, reason, nodes: [] };
}

function rootIndent(code: string, at: number, extra = '  '): string {
  return lineIndent(code, at) + extra;
}

/**
 * Import one page (or component) file. `read` returns already-read repo files
 * (Angular `templateUrl`s are read by the caller beforehand).
 */
export function importMarkupPage(
  fw: Framework, parsers: MarkupParsers, parse: ParseFn, code: string, path: string,
  read: (path: string) => string | null, ctx: MarkupImportContext = {}, exportName?: string,
): MarkupPage {
  const dialect = dialectOf(fw);
  try {
    if (dialect === 'vue') {
      if (!parsers.vue) return fail('The Vue parser is not loaded.');
      const sfc = parsers.vue(code);
      if (!sfc.template) return fail('This component has no <template> (render functions and JSX are kept as code).');
      const setup = sfc.scripts.find((s) => s.setup) ?? null;
      const imp = importMarkup(code, sfc.nodes, { dialect, file: path, start: sfc.template.start, end: sfc.template.end }, ctx);
      const css = sfc.styles.filter((s) => !s.lang || s.lang === 'css').map((s) => code.slice(s.contentStart, s.contentEnd));
      return { ...imp, region: { ...imp.region!, indent: rootIndent(code, sfc.template.start - 1) }, files: { script: { block: setup, createAt: 0 }, css } };
    }
    if (dialect === 'svelte') {
      if (!parsers.svelte) return fail('The Svelte parser is not loaded.');
      const sv = parsers.svelte(code);
      const markup = sv.nodes.filter((n) => !(n.kind === 'text' && !code.slice(n.start, n.end).trim()));
      const blocks = [...sv.scripts, ...sv.styles];
      let roots: MNode[] = sv.nodes;
      let start: number;
      let end: number;
      if (markup.length) {
        start = Math.min(...markup.map((n) => n.start));
        end = Math.max(...markup.map((n) => n.end));
        // A script / style between markup is kept (hidden) in place.
        const inside = blocks.filter((b) => b.start > start && b.end < end).map((b): MCode => ({ kind: 'code', start: b.start, end: b.end, label: 'comment', hidden: true }));
        roots = [...sv.nodes, ...inside].sort((a, b) => a.start - b.start);
      } else {
        // No markup yet (script / style only): new markup goes at the end.
        start = end = code.length;
      }
      const instance = sv.scripts.find((s) => !s.module) ?? null;
      const imp = importMarkup(code, roots, { dialect, file: path, start, end }, ctx);
      const css = sv.styles.filter((s) => !s.lang || s.lang === 'css').map((s) => code.slice(s.contentStart, s.contentEnd));
      return { ...imp, region: { ...imp.region!, indent: '' }, files: { script: { block: instance, createAt: 0 }, css } };
    }
    if (dialect === 'angular') {
      if (!parsers.angular) return fail('The Angular parser is not loaded.');
      const c = angularComponent(parse, code, path, exportName);
      if (!c) return fail('No Angular @Component found in this file.');
      const css = [...c.styles, ...c.styleUrls.filter((u) => u.endsWith('.css')).map((u) => read(u) ?? '')];
      if (c.template) {
        if (c.template.computed) return fail('The template is built with ${…} expressions or code — it stays as code.');
        if (!c.template.backtick) return fail('The inline template is a quoted string — make it a `backtick` template to edit it visually.');
        if (/\\[^`\\$]/.test(c.template.raw)) return fail('The inline template uses escape sequences — move it to a templateUrl file to edit it visually.');
        const tree = parsers.angular(code.slice(c.template.start, c.template.end), c.template.start);
        const imp = importMarkup(code, tree.nodes, { dialect, file: path, start: c.template.start, end: c.template.end, literal: true }, ctx);
        return { ...imp, region: { ...imp.region!, indent: rootIndent(code, c.template.start) }, files: { ng: c, css } };
      }
      if (c.templateUrl) {
        const tpl = read(c.templateUrl);
        if (tpl === null) return fail(`Could not read ${c.templateUrl}.`);
        const tree = parsers.angular(tpl, 0);
        const imp = importMarkup(tpl, tree.nodes, { dialect, file: c.templateUrl, start: 0, end: tpl.length }, ctx);
        return { ...imp, region: { ...imp.region!, indent: '' }, files: { ng: c, css } };
      }
      return fail(`${c.className} has no template.`);
    }
    if (dialect === 'html') {
      if (!parsers.html) return fail('The HTML parser is not loaded.');
      const doc = parsers.html(code);
      if (!doc.body) return fail('This page has no <body> content to edit.');
      const imp = importMarkup(code, doc.nodes, { dialect, file: path, start: doc.body.start, end: doc.body.end }, ctx);
      return { ...imp, region: { ...imp.region!, indent: rootIndent(code, doc.body.start - 1) }, files: { html: doc, css: doc.inlineStyles } };
    }
  } catch (e) {
    return fail(`Could not parse ${path}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  return fail(`${fw.label} pages can't be edited visually.`);
}

/* ───────────────────────────── writing back ───────────────────────────── */

export interface PrintBase {
  framework: Framework;
  filePath: string;
  routes: Record<string, string>;
  symbols: MarkupPrintContext['symbols'];
}

/** Script import lines (Vue / Svelte) into the right block — creating `<script>` when there's none. */
function scriptEdits(code: string, needs: Needs, files: MarkupPageFiles, fw: Framework, dialect: Dialect): Edit[] {
  if (!needs.imports.size || !files.script) return [];
  const block = files.script.block;
  const existing = block ? code.slice(block.contentStart, block.contentEnd) : '';
  const style = codeStyle(existing || code);
  const lines = scriptImportLines(needs, existing, style.semi);
  if (!lines.length) return [];
  if (block) {
    const body = code.slice(block.contentStart, block.contentEnd);
    const firstLine = body.split('\n').find((l) => l.trim());
    const ind = firstLine ? (firstLine.match(/^[ \t]*/) ?? [''])[0] : dialect === 'svelte' ? '  ' : '';
    const at = importOffset(code, block.contentStart, block.contentEnd);
    const lead = at === block.contentStart && !body.startsWith('\n') ? '\n' : '';
    return [{ at, end: at, text: `${lead}${lines.map((l) => ind + l).join('\n')}\n` }];
  }
  const lang = fw.typescript ? ' lang="ts"' : '';
  const ind = dialect === 'svelte' ? '  ' : '';
  const open = dialect === 'vue' ? `<script setup${lang}>` : `<script${lang}>`;
  return [{ at: files.script.createAt, end: files.script.createAt, text: `${open}\n${lines.map((l) => ind + l).join('\n')}\n</script>\n\n` }];
}

/** Angular: TS imports + the decorator's `imports: [...]`. */
function ngEdits(code: string, needs: Needs, c: NgComponent, fw: Framework, warnings: Set<string>): Edit[] {
  const edits: Edit[] = [];
  const style = codeStyle(code);
  const lines = scriptImportLines(needs, code, style.semi).map((l) => (style.q === '"' ? l.replace(/'/g, '"') : l));
  if (lines.length) {
    const at = importOffset(code, 0, code.length);
    edits.push({ at, end: at, text: lines.join('\n') + '\n' + (at === 0 ? '\n' : '') });
  }
  const want = [...needs.ngImports].filter((n) => !(c.imports?.names ?? []).includes(n) && !(n === 'RouterLink' && (c.imports?.names ?? []).includes('RouterModule')));
  if (!want.length) return edits;
  if (!isStandalone(fw, c)) {
    warnings.add(`${c.className} is declared in an NgModule — add ${want.join(', ')} to that module's imports.`);
    return edits;
  }
  if (c.imports) {
    const inner = code.slice(c.imports.start + 1, c.imports.end - 1);
    const at = c.imports.end - 1;
    const trimmed = inner.replace(/\s+$/, '');
    const trailingComma = trimmed.endsWith(',');
    const sep = !trimmed.trim() ? '' : trailingComma ? ' ' : ', ';
    edits.push({ at: c.imports.start + 1 + trimmed.length, end: at, text: `${sep}${want.join(', ')}${inner.slice(trimmed.length)}` });
  } else {
    const ind = lineIndent(code, c.decorator.start) + '  ';
    const at = c.decorator.start + 1;
    edits.push({ at, end: at, text: `\n${ind}imports: [${want.join(', ')}],` });
  }
  return edits;
}

/**
 * The new text of every file a page's edits touch (template file, and the
 * component / script for imports). Empty when nothing changed.
 */
export function markupPageChanges(
  page: MarkupPage, originals: (path: string) => string | null, nodes: CanvasNode[], base: Omit<PrintBase, 'filePath'>, pagePath: string,
): { files: Array<{ path: string; after: string }>; warnings: string[] } {
  const region = page.region!;
  const tplCode = originals(region.file) ?? '';
  const { edits, needs } = planMarkupSplice(tplCode, region, nodes, { ...base, filePath: region.file });
  const warnings = new Set(needs.warnings);
  if (!edits.length) return { files: [], warnings: [...warnings] };
  const byFile = new Map<string, Edit[]>([[region.file, edits]]);
  const files = page.files ?? {};
  if (files.ng) {
    const tsCode = originals(pagePath) ?? '';
    const more = ngEdits(tsCode, needs, files.ng, base.framework, warnings);
    byFile.set(pagePath, [...(byFile.get(pagePath) ?? []), ...more]);
  } else if (files.script) {
    byFile.set(region.file, [...edits, ...scriptEdits(tplCode, needs, files, base.framework, region.dialect)]);
  }
  const out: Array<{ path: string; after: string }> = [];
  for (const [path, es] of byFile) {
    if (!es.length) continue;
    const orig = originals(path);
    if (orig === null) continue;
    out.push({ path, after: applyEdits(orig, es) });
  }
  return { files: out, warnings: [...warnings] };
}

/* ───────────────────────────── new files ───────────────────────────── */

export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

export interface NewFile {
  path: string;
  content: string;
}

export interface NgStyle {
  /** `home.component.ts` / `HomeComponent` (classic) vs `home.ts` / `Home` (v20). */
  suffix: boolean;
  /** One folder per component (`home/home.component.ts`). */
  folder: boolean;
  /** Pages keep their template in a separate `.html`. */
  templateUrl: boolean;
  /** Selector prefix (`app`). */
  prefix: string;
  /** Directory new pages go in. */
  pagesDir: string;
}

/** How this Angular app writes components — from its existing pages. */
export function angularStyle(fw: Framework, pages: Array<{ path: string; ng?: NgComponent }>): NgStyle {
  // Prefer a page in a pages-like folder, then any page with a component, as the model.
  const first = pages.find((p) => p.ng && /\/(pages|views|routes|features|screens)\//.test(p.path)) ?? pages.find((p) => p.ng) ?? pages[0];
  const suffix = first ? /\.component\.ts$/.test(first.path) : (fw.major ?? 17) < 20;
  const parts = first?.path.split('/') ?? [];
  const base = (parts[parts.length - 1] ?? '').replace(/(\.component)?\.ts$/, '');
  const folder = parts.length >= 2 && parts[parts.length - 2] === base;
  const prefix = (first?.ng?.selector ?? 'app-x').split('-')[0] || 'app';
  const appDir = `${fw.root ? fw.root + '/' : ''}src/app`;
  let pagesDir = `${appDir}/pages`;
  if (first && first.path.startsWith(appDir)) {
    const dir = parts.slice(0, folder ? -2 : -1).join('/');
    // The root component (`src/app/app.component.ts`) doesn't make `src/app` a pages folder.
    pagesDir = !folder && dir === appDir ? `${appDir}/pages` : dir;
  }
  return { suffix, folder: first ? folder : true, templateUrl: !!first?.ng?.templateUrl, prefix, pagesDir };
}

export function angularNames(name: string, style: NgStyle) {
  const slug = kebab(name);
  const cls = style.suffix ? `${name}Component` : name;
  const file = style.suffix ? `${slug}.component` : slug;
  return { slug, cls, file, selector: `${style.prefix}-${slug}` };
}

function ngComponentFile(fw: Framework, cls: string, selector: string, needs: Needs, template: { inline?: string; url?: string }, q: string, semi: boolean): string {
  const s = semi ? ';' : '';
  const imports = [`import { Component } from ${q}@angular/core${q}${s}`, ...scriptImportLines(needs, '', semi).map((l) => (q === '"' ? l.replace(/'/g, '"') : l))];
  const lines = [`  selector: ${q}${selector}${q},`];
  if ((fw.major ?? 19) < 19) lines.push('  standalone: true,');
  if (needs.ngImports.size) lines.push(`  imports: [${[...needs.ngImports].join(', ')}],`);
  if (template.url) lines.push(`  templateUrl: ${q}${template.url}${q},`);
  else lines.push(`  template: \`\n${template.inline}\n  \`,`);
  return `${imports.join('\n')}\n\n@Component({\n${lines.join('\n')}\n})\nexport class ${cls} {}\n`;
}

function printCtx(base: Omit<PrintBase, 'filePath'>, filePath: string, dialect: Dialect, needs: Needs, literal = false): MarkupPrintContext {
  return { ...base, filePath, dialect, needs, source: '', literal };
}

/**
 * A new page / component in the framework's style. Angular may produce two
 * files (component + template).
 */
export function newMarkupModule(
  kind: 'page' | 'component', name: string, path: string, nodes: CanvasNode[], base: Omit<PrintBase, 'filePath'>,
  opts: { ng?: NgStyle & { cls: string; selector: string; slug: string; file: string }; htmlShell?: { code: string; doc: ParsedHtml; title: string; chrome?: { before: CanvasNode[]; after: CanvasNode[] } } } = {},
): { files: NewFile[]; warnings: string[] } {
  const fw = base.framework;
  const dialect = dialectOf(fw)!;
  const needs = newNeeds();
  const lang = fw.typescript ? ' lang="ts"' : '';
  if (dialect === 'vue') {
    const ctx = printCtx(base, path, dialect, needs);
    const tpl = printMarkupRoots(nodes, ctx, '  ');
    const lines = scriptImportLines(needs, '');
    const script = lines.length ? `<script setup${lang}>\n${lines.join('\n')}\n</script>\n\n` : '';
    return { files: [{ path, content: `${script}<template>\n  ${tpl}\n</template>\n` }], warnings: [...needs.warnings] };
  }
  if (dialect === 'svelte') {
    const ctx = printCtx(base, path, dialect, needs);
    const markup = printMarkupRoots(nodes, ctx, '');
    const lines = scriptImportLines(needs, '');
    const script = lines.length ? `<script${lang}>\n${lines.map((l) => '  ' + l).join('\n')}\n</script>\n\n` : '';
    return { files: [{ path, content: `${script}${markup}\n` }], warnings: [...needs.warnings] };
  }
  if (dialect === 'angular') {
    const ng = opts.ng!;
    const tplPath = path.replace(/\.ts$/, '.html');
    if (ng.templateUrl && kind === 'page') {
      const ctx = printCtx(base, tplPath, dialect, needs);
      const html = printMarkupRoots(nodes, ctx, '');
      const ts = ngComponentFile(fw, ng.cls, ng.selector, needs, { url: `./${tplPath.split('/').pop()}` }, "'", true);
      return { files: [{ path, content: ts }, { path: tplPath, content: html + '\n' }], warnings: [...needs.warnings] };
    }
    const ctx = printCtx(base, path, dialect, needs, true);
    const tpl = printMarkupRoots(nodes, ctx, '    ');
    const ts = ngComponentFile(fw, ng.cls, ng.selector, needs, { inline: `    ${tpl}` }, "'", true);
    return { files: [{ path, content: ts }], warnings: [...needs.warnings] };
  }
  // Static HTML: the home page's document around the new content (shared header / nav / footer kept).
  const ctx = printCtx(base, path, 'html', needs);
  const shell = opts.htmlShell;
  if (!shell || !shell.doc.body) {
    const body = printMarkupRoots(nodes, ctx, '  ');
    return { files: [{ path, content: `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${name}</title>\n</head>\n<body>\n  ${body}\n</body>\n</html>\n` }], warnings: [...needs.warnings] };
  }
  const { code, doc } = shell;
  const indent = doc.nodes.find((n) => n.kind === 'element') ? lineIndent(code, doc.nodes.find((n) => n.kind === 'element')!.start) : '  ';
  const shellCtx: MarkupPrintContext = { ...ctx, source: code };
  const parts = [
    ...(shell.chrome?.before ?? []).map((n) => printMarkupNode(n, shellCtx, indent)),
    ...nodes.map((n) => printMarkupNode(n, ctx, indent)),
    ...(shell.chrome?.after ?? []).map((n) => printMarkupNode(n, shellCtx, indent)),
  ];
  const body = doc.body!;
  let out = code.slice(0, body.start) + `\n${indent}${parts.join(`\n${indent}`)}\n` + code.slice(body.end).replace(/^[ \t]*/, '');
  if (doc.title) out = out.slice(0, doc.title.start) + shell.title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;')) + out.slice(doc.title.end);
  return { files: [{ path, content: out }], warnings: [...needs.warnings] };
}

/** Split a static page's root nodes into shared chrome (header / nav before, footer / scripts after) and content. */
export function htmlChrome(nodes: CanvasNode[]): { before: CanvasNode[]; after: CanvasNode[] } {
  const isChrome = (n: CanvasNode, tags: string[]) => tags.includes(n.type) || (n.type === 'code' && tags.some((t) => String(n.props?.code ?? '').trimStart().startsWith(`<${t}`)));
  const before: CanvasNode[] = [];
  for (const n of nodes) {
    if (n.type === 'code' && n.props?.label === 'comment') continue;
    if (isChrome(n, ['header', 'nav'])) before.push(n);
    else break;
  }
  const after: CanvasNode[] = [];
  for (let i = nodes.length - 1; i >= before.length; i--) {
    const n = nodes[i];
    if (n.type === 'code' && n.props?.label === 'comment') continue;
    if (isChrome(n, ['footer', 'script'])) after.unshift(n);
    else break;
  }
  return { before, after };
}

/** Find the first `<nav>` holding links (static HTML: where links to new pages go). */
export function findNav(nodes: CanvasNode[]): CanvasNode | null {
  for (const n of nodes) {
    if (n.type === 'nav' && n.children.some((c) => c.type === 'link')) return n;
    const hit = findNav(n.children);
    if (hit) return hit;
  }
  return null;
}

export { relativeModule };
