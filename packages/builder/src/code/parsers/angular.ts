/**
 * Angular template → markup tree, with `@angular/compiler`'s own HTML lexer
 * and parser (control-flow blocks, `@let`, ICU expansions, self-closing
 * components). Its own lazy chunk.
 *
 * Nodes are classified through the parser's visitor interface (not class
 * names), so minified builds work.
 */
import { HtmlParser } from '@angular/compiler';
import type { MAttr, MarkupTree, MNode } from '../markup.ts';
import { closeKind, deepEnd, mergeChains } from './types.ts';

// deno-lint-ignore no-explicit-any
type NgNode = any;

const BLOCK_CONTINUATIONS = /^(else|else if|empty|placeholder|loading|error)\b/;
const DYNAMIC_ATTR = /^[[(*#@]|^(bind|on|bindon|let|ref)-|^i18n/;

function textParts(code: string, start: number, end: number): MNode[] {
  const out: MNode[] = [];
  const raw = code.slice(start, end);
  let last = 0;
  for (const m of raw.matchAll(/\{\{[\s\S]*?\}\}/g)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', start: start + last, end: start + at });
    out.push({ kind: 'code', start: start + at, end: start + at + m[0].length, label: m[0].replace(/\s+/g, ' ').slice(0, 48) });
    last = at + m[0].length;
  }
  if (last < raw.length) out.push({ kind: 'text', start: start + last, end });
  return out;
}

export function parseAngularTemplate(template: string, offset: number): MarkupTree {
  const result = new HtmlParser().parse(template, 'template.html', {
    tokenizeExpansionForms: true,
    tokenizeBlocks: true,
    tokenizeLet: true,
    canSelfClose: true,
  } as never);
  const code = ' '.repeat(offset) + template;
  const at = (span: NgNode) => span.start.offset + offset;
  const atEnd = (span: NgNode) => span.end.offset + offset;

  const list = (nodes: NgNode[]): MNode[] => {
    const out: MNode[] = [];
    for (const n of nodes) out.push(...(n.visit(visitor, null) as MNode[]));
    return mergeChains(
      code, out,
      (n) => n.kind === 'code' && n.label.startsWith('@') && !BLOCK_CONTINUATIONS.test(n.label.slice(1)),
      (n) => n.kind === 'code' && n.label.startsWith('@') && BLOCK_CONTINUATIONS.test(n.label.slice(1)),
      (first) => (first.kind === 'code' ? first.label : '@block'),
    );
  };

  const visitor = {
    visitElement(el: NgNode): MNode[] {
      const start = at(el.sourceSpan);
      const tagName = (code.slice(start + 1).match(/^[^\s/>]+/) ?? [el.name])[0];
      const attrs: MAttr[] = (el.attrs ?? []).map((a: NgNode): MAttr => {
        const s = at(a.sourceSpan);
        const e = atEnd(a.sourceSpan);
        const name = a.name as string;
        const dynamic = DYNAMIC_ATTR.test(name) || /\{\{/.test(String(a.value ?? ''));
        const hasValue = a.valueSpan != null;
        return { name, start: s, end: e, value: dynamic ? null : hasValue ? String(a.value) : null, dynamic };
      });
      const children = list(el.children ?? []);
      let end = atEnd(el.sourceSpan);
      const provisional = { tag: tagName, start, end };
      let close = closeKind(code, provisional);
      if (close === 'implicit') {
        end = Math.max(end, ...children.map(deepEnd));
      }
      if (close === 'self' && children.length) close = 'implicit';
      const openEnd = el.startSourceSpan ? atEnd(el.startSourceSpan) : end;
      const closeStart = close === 'tag' && el.endSourceSpan ? at(el.endSourceSpan) : null;
      const special = /^(ng-template|ng-container|ng-content|router-outlet)$/.test(tagName) ? `<${tagName}>` : undefined;
      return [{
        kind: 'element', tag: tagName, start, end, openEnd, closeStart: close === 'tag' ? closeStart : null, close, attrs, children,
        component: tagName.includes('-'), ...(special ? { opaque: special } : {}),
      }];
    },
    visitText(t: NgNode): MNode[] {
      return textParts(code, at(t.sourceSpan), atEnd(t.sourceSpan));
    },
    visitComment(c: NgNode): MNode[] {
      return [{ kind: 'code', start: at(c.sourceSpan), end: atEnd(c.sourceSpan), label: 'comment', hidden: true }];
    },
    visitBlock(b: NgNode): MNode[] {
      return [{ kind: 'code', start: at(b.sourceSpan), end: atEnd(b.sourceSpan), label: `@${b.name}`, preview: list(b.children ?? []) }];
    },
    visitExpansion(x: NgNode): MNode[] {
      return [{ kind: 'code', start: at(x.sourceSpan), end: atEnd(x.sourceSpan), label: 'ICU' }];
    },
    visitLetDeclaration(l: NgNode): MNode[] {
      return [{ kind: 'code', start: at(l.sourceSpan), end: atEnd(l.sourceSpan), label: '@let' }];
    },
    visitComponent(c: NgNode): MNode[] {
      return [{ kind: 'code', start: at(c.sourceSpan), end: atEnd(c.sourceSpan), label: `<${c.fullName ?? c.componentName}>` }];
    },
    visitAttribute: () => [],
    visitExpansionCase: () => [],
    visitBlockParameter: () => [],
    visitDirective: () => [],
  };

  const nodes = list(result.rootNodes ?? []);
  return { nodes, errors: (result.errors ?? []).map((e: NgNode) => String(e.msg ?? e)) };
}
