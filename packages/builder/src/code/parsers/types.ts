/**
 * What the framework parser adapters return. The adapters themselves
 * (`vue.ts`, `angular.ts`, `svelte.ts`, `html.ts`) each import their
 * framework's real parser, so each is its own lazily-loaded chunk.
 */
import type { MarkupTree, MCode, MElement, MNode } from '../markup.ts';

export interface ScriptBlock {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  /** `<script setup>` (Vue). */
  setup?: boolean;
  /** `<script context="module">` / `<script module>` (Svelte). */
  module?: boolean;
  lang?: string;
}

export interface StyleBlock {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  scoped?: boolean;
  lang?: string;
}

/** A Vue single-file component. */
export interface ParsedSfc extends MarkupTree {
  /** `<template>` content range; null when the SFC has none (render functions). */
  template: { start: number; end: number } | null;
  scripts: ScriptBlock[];
  styles: StyleBlock[];
}

/** A Svelte component: top-level markup (scripts and styles excluded). */
export interface ParsedSvelte extends MarkupTree {
  scripts: ScriptBlock[];
  styles: StyleBlock[];
}

/** A static HTML document. */
export interface ParsedHtml extends MarkupTree {
  /** `<body>` content range (or the document's content when there's no body tag). */
  body: { start: number; end: number } | null;
  /** `<head>` element range. */
  head: { start: number; end: number } | null;
  /** `<title>` content range. */
  title: { start: number; end: number } | null;
  /** Stylesheets the page links (`<link rel="stylesheet" href>`) and inline `<style>` contents. */
  stylesheets: string[];
  inlineStyles: string[];
}

export type VueParse = (code: string) => ParsedSfc;
export type SvelteParse = (code: string) => ParsedSvelte;
export type HtmlParse = (code: string) => ParsedHtml;
/** Parse an Angular template that sits at `offset` in its file (offsets in the result are file offsets). */
export type AngularParse = (template: string, offset: number) => MarkupTree;

export interface MarkupParsers {
  vue?: VueParse;
  svelte?: SvelteParse;
  html?: HtmlParse;
  angular?: AngularParse;
}

export const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** End of the start tag: the first `>` at or after `from` (attribute values are already past). */
export function startTagEnd(code: string, from: number, limit: number): number {
  const i = code.indexOf('>', from);
  return i === -1 || i >= limit ? limit : i + 1;
}

export function closeKind(code: string, el: { tag: string; start: number; end: number }): 'tag' | 'self' | 'void' | 'implicit' {
  const raw = code.slice(el.start, el.end);
  if (new RegExp(`</\\s*${el.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>$`, 'i').test(raw)) return 'tag';
  if (raw.endsWith('/>')) return 'self';
  if (VOID_TAGS.has(el.tag.toLowerCase())) return 'void';
  return 'implicit';
}

/** Largest end offset in a subtree (elements whose end tag was implied end with their content). */
export function deepEnd(n: MNode): number {
  let e = n.end;
  if (n.kind === 'element') for (const c of n.children) e = Math.max(e, deepEnd(c));
  return e;
}

/**
 * Merge conditional chains into one chip: Vue `v-if` / `v-else-if` / `v-else`
 * siblings, Angular `@if {} @else {}` blocks. `cont(n)` says whether `n`
 * continues the chain started by a previous node; `starts(n)` whether it can
 * start one. Whitespace and comments between links are absorbed.
 */
export function mergeChains(code: string, nodes: MNode[], starts: (n: MNode) => boolean, cont: (n: MNode) => boolean, label: (first: MNode) => string): MNode[] {
  const out: MNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i];
    if (!starts(n)) { out.push(n); i++; continue; }
    let last = i;
    let j = i + 1;
    while (j < nodes.length) {
      const m = nodes[j];
      if (m.kind === 'text' && /^\s*$/.test(code.slice(m.start, m.end))) { j++; continue; }
      if (m.kind === 'code' && m.hidden) { j++; continue; }
      if (cont(m)) { last = j; j++; continue; }
      break;
    }
    if (last === i) { out.push(n); i++; continue; }
    const members = nodes.slice(i, last + 1);
    const chip: MCode = {
      kind: 'code', start: n.start, end: deepEnd(nodes[last]), label: label(n),
      preview: members.flatMap((m) => (m.kind === 'element' ? [m] : m.kind === 'code' ? (m.preview ?? []) : [])).slice(0, 1),
    };
    out.push(chip);
    i = last + 1;
  }
  return out;
}

export type { MCode, MElement, MNode };
