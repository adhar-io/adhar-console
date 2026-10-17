/**
 * The clickable prototype: every page of the app in one self-contained HTML
 * document, with a page bar, "navigate" / "toggle" / "open URL" interactions,
 * modals, and native form validation.
 *
 * Rendered from the node tree with every value escaped; interactions are data
 * attributes handled by one small delegated script — no inline handlers built
 * from user text. Runs in a sandboxed iframe (scripts, no same-origin).
 */

import { findFileInTree, type CanvasNode, type ProjectFile } from './builder-types.ts';
import { nodeToTag } from './builder-codegen.ts';
import { homePage, listPages, pageRoute, renderableNodes } from './studio.ts';

export const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function collectToggleTargets(nodes: CanvasNode[], into: Set<string>) {
  for (const n of nodes) {
    for (const it of n.interactions ?? []) if (it.action === 'toggle-visibility' && it.targetNodeId) into.add(it.targetNodeId);
    collectToggleTargets(n.children, into);
  }
}

export function nodeToPrototypeHTML(n: CanvasNode, targets: Set<string>, files: ProjectFile[]): string {
  // Repeater copies carry `__<i>` suffixes; interactions target the template id.
  const baseId = n.id.replace(/__\d+$/, '');
  if (n.hidden && !targets.has(baseId)) return '';
  const cls = n.props?.className ? ` class="${esc(n.props.className)}"` : '';
  let attrs = ` data-node-id="${esc(baseId)}"`;
  const click = n.interactions?.find((i) => i.trigger === 'click');
  if (click?.action === 'navigate' && click.targetPageId && findFileInTree(files, click.targetPageId)) attrs += ` data-nav="${esc(click.targetPageId)}"`;
  else if (click?.action === 'toggle-visibility' && click.targetNodeId) attrs += ` data-toggle="${esc(click.targetNodeId)}"`;
  else if (click?.action === 'open-url' && click.url && /^https?:\/\//.test(click.url)) attrs += ` data-href="${esc(click.url)}"`;
  if (click) attrs += ' style="cursor:pointer"';
  if ((n.type === 'modal' || n.hidden) && targets.has(baseId)) attrs += ' data-initially-hidden hidden';

  const text = typeof n.props?.children === 'string' ? esc(n.props.children) : '';
  const ph = n.props?.placeholder ? ` placeholder="${esc(n.props.placeholder)}"` : '';
  const req = n.props?.required ? ' required' : '';
  const kids = () => n.children.map((c) => nodeToPrototypeHTML(c, targets, files)).join('');

  switch (n.type) {
    case 'text':
      return text;
    case 'code': {
      const preview = Array.isArray(n.props?.preview) ? (n.props.preview as CanvasNode[]) : [];
      if (preview.length) return preview.map((c) => nodeToPrototypeHTML(c, targets, files)).join('');
      return n.props?.label === 'comment' ? '' : `<span style="font:11px ui-monospace,monospace;padding:1px 4px;border-radius:4px;background:rgba(245,158,11,.15);color:#b45309">${esc(n.props?.label ?? '')}</span>`;
    }
    case 'img': {
      const src = String(n.props?.src ?? '');
      return /^(https?:|data:)/.test(src) ? `<img src="${esc(src)}" alt="${esc(n.props?.alt ?? '')}"${cls}${attrs} />` : `<span${cls}${attrs} style="display:inline-flex;align-items:center;justify-content:center;background:var(--b-muted);font-size:12px">${esc(n.props?.alt || 'image')}</span>`;
    }
    case 'input':
      return `<input type="${esc(n.props?.inputType || 'text')}"${cls}${attrs}${ph}${req} />`;
    case 'date-input':
      return `<input type="date"${cls}${attrs}${req} />`;
    case 'textarea':
      return `<textarea${cls}${attrs}${ph}${req}></textarea>`;
    case 'select': {
      const opts = Array.isArray(n.props?.options) ? (n.props.options as unknown[]) : [];
      return `<select${cls}${attrs}${req}>${opts.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
    }
    case 'checkbox':
    case 'radio':
    case 'switch':
      return `<label${cls}${attrs}><input type="${n.type === 'radio' ? 'radio' : 'checkbox'}"${n.props?.name ? ` name="${esc(n.props.name)}"` : ''} style="accent-color:var(--b-primary)" /> ${text}</label>`;
    case 'progress-bar':
      return `<div${cls}${attrs}><div style="height:100%;border-radius:9999px;background:var(--b-primary);width:${Number(n.props?.['data-value'] ?? 66)}%"></div></div>`;
    case 'separator':
      return `<div${cls}${attrs}></div>`;
  }
  const tag = nodeToTag(n.type);
  if (tag === 'input') return `<input${cls}${attrs}${ph} />`;
  return `<${tag}${cls}${attrs}>${text}${kids()}</${tag}>`;
}

const SCRIPT = `
(function(){
  var pages = document.querySelectorAll('[data-page]');
  var tabs = document.querySelectorAll('[data-goto]');
  function show(id){
    var found = false;
    pages.forEach(function(p){ var on = p.getAttribute('data-page') === id; p.hidden = !on; if (on) found = true; });
    if (!found && pages[0]) { pages[0].hidden = false; id = pages[0].getAttribute('data-page'); }
    tabs.forEach(function(t){ t.setAttribute('aria-current', t.getAttribute('data-goto') === id ? 'page' : 'false'); });
    document.querySelectorAll('[data-initially-hidden]').forEach(function(el){ el.hidden = true; });
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', function(e){
    var t = e.target.closest ? e.target : e.target.parentElement;
    var go = t.closest('[data-goto]'); if (go) { show(go.getAttribute('data-goto')); return; }
    var nav = t.closest('[data-nav]'); if (nav) { e.preventDefault(); show(nav.getAttribute('data-nav')); return; }
    var tg = t.closest('[data-toggle]');
    if (tg) { e.preventDefault(); document.querySelectorAll('[data-node-id="' + tg.getAttribute('data-toggle') + '"]').forEach(function(el){ el.hidden = !el.hidden; }); return; }
    var href = t.closest('[data-href]'); if (href) { window.open(href.getAttribute('data-href'), '_blank', 'noopener'); return; }
    if (t.closest('a')) e.preventDefault();
  });
  document.addEventListener('submit', function(e){
    e.preventDefault();
    var f = e.target; if (f.reportValidity && !f.reportValidity()) return;
    var n = document.getElementById('proto-toast'); n.hidden = false; setTimeout(function(){ n.hidden = true; }, 1800);
  });
  show(document.body.getAttribute('data-start'));
})();`;

export interface PrototypeOptions {
  files: ProjectFile[];
  /** The console's compiled CSS (Tailwind utilities incl. the builder vocabulary). */
  css: string;
  /** Design theme as `--b-*` declarations. */
  themeVars: Record<string, string>;
  dark: boolean;
  /** Page to open on; defaults to the home page. */
  startPageId?: string;
  /** Show the page bar (off for a single-page HTML export). */
  chrome?: boolean;
  /** The repo's CSS is scoped to `.adhar-repo-canvas` (see code/css-theme.ts): render pages inside it. */
  scoped?: boolean;
}

export function buildPrototypeDoc(o: PrototypeOptions): string {
  const pages = listPages(o.files);
  const start = (o.startPageId && pages.some((p) => p.id === o.startPageId) ? o.startPageId : homePage(o.files)?.id) ?? '';
  const vars = Object.entries(o.themeVars).map(([k, v]) => `${k}:${v};`).join('');
  const sections = pages.map((p) => {
    const nodes = renderableNodes(p.nodes ?? [], o.files);
    const targets = new Set<string>();
    collectToggleTargets(nodes, targets);
    return `<section data-page="${esc(p.id)}" hidden><div class="mx-auto max-w-7xl px-4 py-6">${nodes.map((n) => nodeToPrototypeHTML(n, targets, o.files)).join('')}</div></section>`;
  }).join('');
  const bar = o.chrome === false || pages.length < 2 ? '' :
    `<div class="proto-bar">${pages.map((p) => `<button type="button" data-goto="${esc(p.id)}">${esc(p.name.replace(/\.\w+$/, ''))}<small>${esc(pageRoute(p, o.files))}</small></button>`).join('')}</div>`;
  return `<!DOCTYPE html><html class="${o.dark ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${o.css}</style><style>.adhar-builder{${vars}}html,body{margin:0;background:var(--b-background);color:var(--b-foreground);font-family:var(--font-sans,system-ui,sans-serif);-webkit-font-smoothing:antialiased}${o.dark ? 'html{color-scheme:dark}' : ''}[hidden]{display:none!important}.proto-bar{position:sticky;top:0;z-index:40;display:flex;gap:4px;overflow-x:auto;padding:6px 8px;background:color-mix(in oklab,var(--b-background) 90%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--b-border)}.proto-bar button{display:flex;flex-direction:column;align-items:flex-start;padding:4px 10px;border-radius:8px;font:500 12px/1.2 inherit;color:var(--b-muted-foreground);background:none;border:0;cursor:pointer}.proto-bar button small{font-size:10px;opacity:.7}.proto-bar button[aria-current=page]{background:color-mix(in oklab,var(--b-primary) 12%,transparent);color:var(--b-primary)}#proto-toast{position:fixed;bottom:16px;right:16px;padding:10px 14px;border-radius:10px;background:var(--b-foreground);color:var(--b-background);font:500 13px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.2)}</style></head><body class="adhar-builder${o.scoped ? ' adhar-repo-canvas' : ''}" data-start="${esc(start)}">${bar}${sections}<div id="proto-toast" hidden>Form submitted</div><script>${SCRIPT}</script></body></html>`;
}
