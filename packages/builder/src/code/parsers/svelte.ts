/**
 * Svelte component → markup tree, with `svelte/compiler`'s own parser (modern
 * AST — Svelte 5, which also reads Svelte 3/4 syntax). Its own lazy chunk.
 */
import { parse } from 'svelte/compiler';
import type { MAttr, MNode } from '../markup.ts';
import { closeKind, startTagEnd, type ParsedSvelte, type ScriptBlock, type StyleBlock } from './types.ts';

// deno-lint-ignore no-explicit-any
type SNode = any;

const HIDDEN_SPECIAL = new Set(['SvelteHead', 'SvelteOptions', 'SvelteWindow', 'SvelteDocument', 'SvelteBody']);

function attr(code: string, a: SNode): MAttr {
  const raw = code.slice(a.start, a.end);
  if (a.type === 'Attribute') {
    const v = a.value;
    if (v === true) return { name: a.name, start: a.start, end: a.end, value: null, dynamic: false };
    const parts: SNode[] = Array.isArray(v) ? v : [v];
    if (parts.every((p) => p.type === 'Text')) return { name: a.name, start: a.start, end: a.end, value: parts.map((p) => p.data).join(''), dynamic: false };
    const staticParts = parts.filter((p) => p.type === 'Text').map((p) => p.data).join(' ').replace(/\s+/g, ' ').trim();
    return { name: a.name, start: a.start, end: a.end, value: null, dynamic: true, staticParts };
  }
  return { name: raw.split(/[=\s]/)[0], start: a.start, end: a.end, value: null, dynamic: true };
}

function nodes(code: string, list: SNode[] | undefined): MNode[] {
  return (list ?? []).map((n) => convert(code, n)).filter((n): n is MNode => n !== null);
}

const label = (code: string, n: SNode) => code.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 40);

function convert(code: string, n: SNode): MNode | null {
  const { start, end } = n;
  switch (n.type) {
    case 'Text':
      return { kind: 'text', start, end };
    case 'Comment':
      return { kind: 'code', start, end, label: 'comment', hidden: true };
    case 'ExpressionTag':
    case 'HtmlTag':
    case 'ConstTag':
    case 'DebugTag':
    case 'RenderTag':
    case 'AttachTag':
      return { kind: 'code', start, end, label: label(code, n) };
    case 'IfBlock':
      return { kind: 'code', start, end, label: '{#if}', preview: nodes(code, n.consequent?.nodes) };
    case 'EachBlock':
      return { kind: 'code', start, end, label: '{#each}', preview: nodes(code, n.body?.nodes) };
    case 'AwaitBlock':
      return { kind: 'code', start, end, label: '{#await}', preview: nodes(code, (n.then ?? n.pending)?.nodes) };
    case 'KeyBlock':
      return { kind: 'code', start, end, label: '{#key}', preview: nodes(code, n.fragment?.nodes) };
    case 'SnippetBlock':
      return { kind: 'code', start, end, label: `{#snippet ${n.expression?.name ?? ''}}` };
  }
  if (HIDDEN_SPECIAL.has(n.type)) return { kind: 'code', start, end, label: `<${n.name}>`, hidden: true };
  if (n.attributes && n.fragment) {
    const tag: string = n.name;
    const as = (n.attributes as SNode[]).map((a) => attr(code, a));
    const close = closeKind(code, { tag, start, end });
    const lastAttr = as.length ? as[as.length - 1].end : start + 1 + tag.length;
    const openEnd = close === 'self' ? end : startTagEnd(code, lastAttr, end);
    const closeStart = close === 'tag' ? code.lastIndexOf('</', end - 1) : null;
    const regular = n.type === 'RegularElement';
    return {
      kind: 'element', tag, start, end, openEnd, closeStart, close, attrs: as, children: nodes(code, n.fragment.nodes),
      component: !regular,
      ...(regular ? {} : { opaque: `<${tag}>` }),
    };
  }
  return { kind: 'code', start, end, label: label(code, n) };
}

function block(code: string, b: SNode): { start: number; end: number; contentStart: number; contentEnd: number } {
  const contentStart = startTagEnd(code, b.start, b.end);
  const close = code.lastIndexOf('</', b.end - 1);
  return { start: b.start, end: b.end, contentStart, contentEnd: close > contentStart ? close : contentStart };
}

export function parseSvelte(code: string): ParsedSvelte {
  const ast = parse(code, { modern: true }) as SNode;
  const scripts: ScriptBlock[] = [];
  for (const s of [ast.instance, ast.module]) {
    if (!s) continue;
    const head = code.slice(s.start, startTagEnd(code, s.start, s.end));
    scripts.push({ ...block(code, s), module: s === ast.module, lang: head.match(/lang=["']?(\w+)/)?.[1] });
  }
  const styles: StyleBlock[] = [];
  if (ast.css) styles.push(block(code, ast.css));
  return { nodes: nodes(code, ast.fragment?.nodes), scripts: scripts.sort((a, b) => a.start - b.start), styles, errors: [] };
}
