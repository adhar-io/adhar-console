/**
 * Static HTML page → markup tree, with parse5 (the WHATWG parsing algorithm,
 * source locations on). Its own lazy chunk.
 */
import { parse } from 'parse5';
import type { MAttr, MNode } from '../markup.ts';
import { deepEnd, type ParsedHtml } from './types.ts';

// deno-lint-ignore no-explicit-any
type PNode = any;

function convert(code: string, n: PNode, out: MNode[]) {
  const loc = n.sourceCodeLocation;
  if (n.nodeName === '#text') {
    if (loc) out.push({ kind: 'text', start: loc.startOffset, end: loc.endOffset });
    return;
  }
  if (n.nodeName === '#comment') {
    if (loc) out.push({ kind: 'code', start: loc.startOffset, end: loc.endOffset, label: 'comment', hidden: true });
    return;
  }
  if (!n.tagName) return;
  if (!loc || !loc.startTag) {
    // Implied element (e.g. a <tbody> the parser added): its children stand in.
    for (const c of n.childNodes ?? []) convert(code, c, out);
    return;
  }
  const start = loc.startOffset;
  const raw = code.slice(start, loc.startTag.endOffset);
  const tag = (raw.match(/^<([^\s/>]+)/) ?? [, n.tagName])[1] as string;
  const attrs: MAttr[] = (n.attrs ?? []).map((a: PNode): MAttr => {
    const l = loc.attrs?.[a.name];
    const s = l?.startOffset ?? start;
    const e = l?.endOffset ?? start;
    const hasValue = /=/.test(code.slice(s, e));
    return { name: code.slice(s, e).split('=')[0] || a.name, start: s, end: e, value: hasValue ? a.value : null, dynamic: false };
  }).filter((a: MAttr) => a.end > a.start);
  const children: MNode[] = [];
  for (const c of (n.tagName === 'template' ? n.content?.childNodes : n.childNodes) ?? []) convert(code, c, children);
  const isVoid = !loc.endTag && /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(n.tagName);
  const close = loc.endTag ? 'tag' : isVoid ? 'void' : raw.endsWith('/>') && !children.length ? 'self' : 'implicit';
  let end = loc.endOffset;
  if (close === 'implicit') {
    // Ends where its content ends (parse5 may stretch it to the parent's end), without trailing whitespace.
    end = Math.max(loc.startTag.endOffset, ...children.map(deepEnd));
    while (end > loc.startTag.endOffset && /\s/.test(code[end - 1])) end--;
  }
  out.push({
    kind: 'element', tag, start, end: close === 'void' || close === 'self' ? loc.startTag.endOffset : end,
    openEnd: loc.startTag.endOffset, closeStart: loc.endTag ? loc.endTag.startOffset : null, close, attrs, children,
    component: tag.includes('-'),
  });
}

function find(n: PNode, name: string): PNode | null {
  if (n.nodeName === name) return n;
  for (const c of n.childNodes ?? []) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return null;
}

export function parseHtml(code: string): ParsedHtml {
  const errors: string[] = [];
  const doc = parse(code, { sourceCodeLocationInfo: true, onParseError: (e: PNode) => { if (e?.code) errors.push(e.code); } } as never);
  const body = find(doc, 'body');
  const head = find(doc, 'head');
  const title = head ? find(head, 'title') : null;
  const bl = body?.sourceCodeLocation;
  let range: ParsedHtml['body'] = null;
  const nodes: MNode[] = [];
  for (const c of body?.childNodes ?? []) convert(code, c, nodes);
  if (bl?.startTag) {
    range = { start: bl.startTag.endOffset, end: bl.endTag?.startOffset ?? Math.max(bl.startTag.endOffset, ...nodes.map((n) => n.end)) };
  } else if (nodes.length) {
    range = { start: nodes[0].start, end: Math.max(...nodes.map((n) => n.end)) };
  }
  const inRange = range ? nodes.filter((n) => n.start >= range!.start && n.end <= range!.end) : [];
  const hl = head?.sourceCodeLocation;
  const tl = title?.sourceCodeLocation;
  const stylesheets: string[] = [];
  const inlineStyles: string[] = [];
  const visit = (n: PNode) => {
    if (n.tagName === 'link' && /stylesheet/i.test(n.attrs?.find((a: PNode) => a.name === 'rel')?.value ?? '')) {
      const href = n.attrs.find((a: PNode) => a.name === 'href')?.value;
      if (href) stylesheets.push(href);
    }
    if (n.tagName === 'style') inlineStyles.push((n.childNodes ?? []).map((c: PNode) => c.value ?? '').join(''));
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(doc);
  return {
    nodes: inRange,
    body: range,
    head: hl?.startTag ? { start: hl.startOffset, end: hl.endOffset } : null,
    title: tl?.startTag && tl.endTag ? { start: tl.startTag.endOffset, end: tl.endTag.startOffset } : null,
    stylesheets,
    inlineStyles,
    errors,
  };
}
