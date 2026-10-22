/**
 * Vue SFC → markup tree, with `@vue/compiler-dom`'s own parser (SFC mode,
 * source offsets kept). Its own lazy chunk.
 */
import { parse } from '@vue/compiler-dom';
import type { MAttr, MNode } from '../markup.ts';
import { closeKind, mergeChains, startTagEnd, type ParsedSfc, type ScriptBlock, type StyleBlock } from './types.ts';

// deno-lint-ignore no-explicit-any
type VNode = any;

const ELEMENT = 1, TEXT = 2, COMMENT = 3, INTERPOLATION = 5, ATTRIBUTE = 6;
const COMPONENT = 1, SLOT = 2, TEMPLATE = 3;

function attrs(code: string, el: VNode): MAttr[] {
  return (el.props ?? []).map((p: VNode): MAttr => {
    const start = p.loc.start.offset;
    const end = p.loc.end.offset;
    if (p.type === ATTRIBUTE) return { name: p.name, start, end, value: p.value ? p.value.content : null, dynamic: false };
    const raw = code.slice(start, end);
    const name = p.rawName ?? raw.split('=')[0];
    return { name, start, end, value: null, dynamic: true };
  });
}

function convert(code: string, n: VNode): MNode | null {
  const start = n.loc.start.offset;
  const end = n.loc.end.offset;
  switch (n.type) {
    case TEXT:
      return { kind: 'text', start, end };
    case COMMENT:
      return { kind: 'code', start, end, label: 'comment', hidden: true };
    case INTERPOLATION:
      return { kind: 'code', start, end, label: code.slice(start, end).replace(/\s+/g, ' ').slice(0, 48) };
    case ELEMENT: {
      const as = attrs(code, n);
      const lastAttr = as.length ? as[as.length - 1].end : start + 1 + n.tag.length;
      const close = n.isSelfClosing ? 'self' : closeKind(code, { tag: n.tag, start, end });
      const openEnd = close === 'self' ? end : startTagEnd(code, lastAttr, end);
      const closeStart = close === 'tag' ? code.lastIndexOf('</', end - 1) : null;
      const children = mergeVIf(code, (n.children ?? []).map((c: VNode) => convert(code, c)).filter(Boolean) as MNode[]);
      const special = n.tagType === SLOT ? '<slot>' : n.tagType === TEMPLATE ? '<template>' : ['component', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense'].includes(n.tag) ? `<${n.tag}>` : undefined;
      return {
        kind: 'element', tag: n.tag, start, end, openEnd, closeStart, close, attrs: as, children,
        component: n.tagType === COMPONENT, ...(special ? { opaque: special } : {}),
      };
    }
    default:
      return { kind: 'code', start, end, label: code.slice(start, end).slice(0, 40) };
  }
}

const has = (n: MNode, re: RegExp) => n.kind === 'element' && n.attrs.some((a) => re.test(a.name));

function mergeVIf(code: string, nodes: MNode[]): MNode[] {
  return mergeChains(code, nodes, (n) => has(n, /^v-if$/), (n) => has(n, /^v-else(-if)?$/), () => 'v-if');
}

function block(code: string, n: VNode): { start: number; end: number; contentStart: number; contentEnd: number } {
  const start = n.loc.start.offset;
  const end = n.loc.end.offset;
  const contentStart = startTagEnd(code, start, end);
  const close = code.lastIndexOf('</', end - 1);
  return { start, end, contentStart, contentEnd: close > contentStart ? close : contentStart };
}

const attrOf = (n: VNode, name: string) => (n.props ?? []).find((p: VNode) => p.type === ATTRIBUTE && p.name === name);

export function parseVue(code: string): ParsedSfc {
  const errors: string[] = [];
  const ast = parse(code, { parseMode: 'sfc', comments: true, whitespace: 'preserve', onError: (e: Error) => errors.push(e.message), onWarn: () => {} } as never) as VNode;
  let template: ParsedSfc['template'] = null;
  let nodes: MNode[] = [];
  const scripts: ScriptBlock[] = [];
  const styles: StyleBlock[] = [];
  for (const top of ast.children ?? []) {
    if (top.type !== ELEMENT) continue;
    if (top.tag === 'template' && !template && !attrOf(top, 'src')) {
      const b = block(code, top);
      template = { start: b.contentStart, end: b.contentEnd };
      nodes = mergeVIf(code, (top.children ?? []).map((c: VNode) => convert(code, c)).filter(Boolean) as MNode[]);
    } else if (top.tag === 'script') {
      scripts.push({ ...block(code, top), setup: !!(top.props ?? []).find((p: VNode) => p.name === 'setup'), lang: attrOf(top, 'lang')?.value?.content });
    } else if (top.tag === 'style') {
      styles.push({ ...block(code, top), scoped: !!(top.props ?? []).find((p: VNode) => p.name === 'scoped'), lang: attrOf(top, 'lang')?.value?.content });
    }
  }
  return { template, nodes, scripts, styles, errors };
}
