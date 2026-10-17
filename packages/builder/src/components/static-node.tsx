import { createContext, createElement, useContext, type ReactNode } from 'react';
import { findFileInTree, type CanvasNode, type ProjectFile } from '../lib/builder-types.ts';
import { nodeToTag } from '../lib/builder-codegen.ts';
import { bindingItems, hasTemplate, interpolate } from '../lib/studio.ts';

/**
 * Read-only React rendering of a node tree — component instances on the
 * canvas, repeated data rows, project thumbnails. React elements only (tag,
 * classes, text): nothing from a project document is ever injected as HTML.
 */

/** The project files (for symbols / data) — provided by the workbench. */
export const StudioFilesContext = createContext<ProjectFile[]>([]);
/** The current repeater item, for `{{field}}` templates. `undefined` = not in a repeater. */
export const RepeatItemContext = createContext<unknown>(undefined);

const TAGS = new Set([
  'div', 'section', 'nav', 'footer', 'header', 'main', 'aside', 'article', 'span', 'p', 'a', 'label', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'ul', 'ol', 'li', 'blockquote', 'small', 'strong', 'em',
]);

export function displayText(text: unknown, item: unknown): string | null {
  if (typeof text !== 'string') return null;
  return item !== undefined && hasTemplate(text) ? interpolate(text, item) : text;
}

/** Leaf form controls & widgets that render as a single element (no wrapper). */
export function renderLeaf(n: CanvasNode, item: unknown, key?: string): ReactNode | null {
  const className = typeof n.props?.className === 'string' ? n.props.className : undefined;
  const text = displayText(n.props?.children, item);
  switch (n.type) {
    case 'input':
      return <input key={key} type={String(n.props?.inputType || 'text')} className={className} placeholder={displayText(n.props?.placeholder, item) ?? ''} readOnly tabIndex={-1} />;
    case 'date-input':
      return <input key={key} type='date' className={className} readOnly tabIndex={-1} />;
    case 'textarea':
      return <textarea key={key} className={className} placeholder={String(n.props?.placeholder ?? '')} readOnly tabIndex={-1} />;
    case 'select': {
      const opts = Array.isArray(n.props?.options) ? (n.props.options as unknown[]).map(String) : [];
      return (
        <select key={key} className={className} tabIndex={-1} onChange={() => {}} value={opts[0] ?? ''}>
          {opts.map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    }
    case 'checkbox':
    case 'radio':
    case 'switch':
      return (
        <label key={key} className={className}>
          {n.type === 'switch'
            ? <span className='relative inline-flex h-5 w-9 shrink-0 rounded-full bg-primary'><span className='absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-background' /></span>
            : <input type={n.type === 'radio' ? 'radio' : 'checkbox'} readOnly tabIndex={-1} checked={false} onChange={() => {}} style={{ accentColor: 'var(--b-primary)' }} />}
          {text}
        </label>
      );
    case 'progress-bar':
      return <div key={key} className={className}><div className='h-full rounded-full bg-primary' style={{ width: `${Number(n.props?.['data-value'] ?? 66)}%` }} /></div>;
    case 'separator':
      return <div key={key} className={className} />;
    case 'img': {
      const src = String(n.props?.src ?? '');
      // Repo-relative assets aren't served by the console — show the alt text.
      return /^(https?:|data:)/.test(src)
        ? <img key={key} src={src} alt={String(n.props?.alt ?? '')} className={className} />
        : <span key={key} className={`inline-flex items-center justify-center bg-muted text-xs text-muted-foreground ${className ?? ''}`}>{String(n.props?.alt || 'image')}</span>;
    }
    case 'text':
      return <span key={key}>{text}</span>;
  }
  return null;
}

export function StaticNode({ node, depth = 0 }: { node: CanvasNode; depth?: number }) {
  const files = useContext(StudioFilesContext);
  const item = useContext(RepeatItemContext);
  if (node.hidden || depth > 30) return null;
  if (node.type === 'symbol') {
    const master = findMaster(files, String(node.props?.symbolId ?? ''));
    return master ? <StaticNode node={master} depth={depth + 1} /> : null;
  }
  if (node.type === 'code') {
    const preview = Array.isArray(node.props?.preview) ? (node.props.preview as CanvasNode[]) : [];
    if (preview.length) return <>{preview.map((p) => <StaticNode key={p.id} node={p} depth={depth + 1} />)}</>;
    return node.props?.label === 'comment' ? null : <span className='rounded bg-amber-500/15 px-1 font-mono text-[11px] text-amber-700'>{String(node.props?.label ?? '')}</span>;
  }
  const leaf = renderLeaf(node, item);
  if (leaf) return leaf;
  const raw = nodeToTag(node.type);
  const tag = TAGS.has(raw) ? raw : 'div';
  const className = node.type === 'modal'
    ? 'relative mt-4 flex justify-center rounded-xl border-2 border-dashed border-violet-500/40 bg-foreground/10 p-6'
    : typeof node.props?.className === 'string' ? node.props.className : undefined;
  const text = displayText(node.props?.children, item);
  return createElement(tag, { className }, text, ...staticChildren(node, files, depth));
}

function staticChildren(node: CanvasNode, files: ProjectFile[], depth: number): ReactNode[] {
  if (!node.bind) return node.children.map((c) => <StaticNode key={c.id} node={c} depth={depth + 1} />);
  return bindingItemsSafe(files, node).map((it, i) => (
    <RepeatItemContext.Provider key={i} value={it}>
      {node.children.map((c) => <StaticNode key={c.id} node={c} depth={depth + 1} />)}
    </RepeatItemContext.Provider>
  ));
}


export function findMaster(files: ProjectFile[], symbolId: string): CanvasNode | undefined {
  return findFileInTree(files, symbolId)?.nodes?.[0];
}

export function bindingItemsSafe(files: ProjectFile[], node: CanvasNode, max = 50): unknown[] {
  return bindingItems(files, node.bind).slice(0, max);
}
