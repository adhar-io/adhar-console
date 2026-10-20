import { Fragment, type ReactNode, useMemo } from 'react'
import { cn } from '@adhar/utils'
import { type Block, type Inline, parseMarkdown, taskOrdinal } from '../data/pages-model.ts'
import type { Group } from '../data/insights-math.ts'
import { StateChip } from './insights-ui.tsx'

/**
 * Renders a page's markdown from the safe AST in `pages-model.ts` — every
 * construct becomes a React element (no HTML string is ever injected; links
 * are limited to http(s), mailto and in-app paths). Issue keys become live
 * chips with their current Plane state, `@mentions` and `[[wiki links]]`
 * become chips too.
 */

export interface IssueChipInfo {
  name: string
  group: Group
  stateName?: string
}

export interface MarkdownHooks {
  issueKeys?: Set<string>
  resolveIssue?(key: string): IssueChipInfo | undefined
  onIssue?(key: string): void
  onWiki?(title: string): void
  wikiExists?(title: string): boolean
  /** Called with the task's ordinal among all tasks (see `toggleTaskAt`). */
  onToggleTask?(ordinal: number): void
}

export function PageMarkdown({ text, className, hooks = {} }: { text: string; className?: string; hooks?: MarkdownHooks }) {
  const blocks = useMemo(() => parseMarkdown(text, hooks.issueKeys), [text, hooks.issueKeys])
  if (!blocks.length) return <p className={cn('text-[13px] text-content-subtle', className)}>This page is empty.</p>
  return <div className={cn('space-y-3 text-[14px] leading-relaxed text-content', className)}>{blocks.map((b, i) => <BlockView key={i} b={b} index={i} hooks={hooks} blocks={blocks} />)}</div>
}

function BlockView({ b, index, hooks, blocks }: { b: Block; index: number; hooks: MarkdownHooks; blocks: Block[] }) {
  const r = (xs: Inline[]) => renderInline(xs, hooks)
  switch (b.t) {
    case 'h': {
      const H = `h${Math.min(6, b.level)}` as 'h1'
      return (
        <H className={cn('font-semibold tracking-tight text-content', b.level === 1 ? 'pt-1 text-[22px]' : b.level === 2 ? 'pt-2 text-[17px]' : b.level === 3 ? 'text-[15px]' : 'text-[14px]')}>
          {r(b.c)}
        </H>
      )
    }
    case 'p':
      return <p>{r(b.c)}</p>
    case 'quote':
      return <blockquote className="border-l-2 border-brand-400/60 pl-3 text-content-muted">{r(b.c)}</blockquote>
    case 'ul':
      return (
        <ul className={cn('space-y-1', b.items.some((it) => it.checked !== undefined) ? 'pl-1' : 'list-disc pl-5 marker:text-content-subtle')}>
          {b.items.map((it, j) => (
            <li key={j} className={cn(it.checked !== undefined && 'flex list-none items-start gap-2')}>
              {it.checked !== undefined
                ? (
                  <input
                    type="checkbox"
                    checked={it.checked}
                    readOnly={!hooks.onToggleTask}
                    onChange={() => hooks.onToggleTask?.(taskOrdinal(blocks, index, j))}
                    className="mt-1 accent-brand-600"
                    aria-label="Task"
                  />
                )
                : null}
              <span className={cn(it.checked && 'text-content-subtle line-through')}>{r(it.c)}</span>
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return <ol className="list-decimal space-y-1 pl-5 marker:text-content-subtle">{b.items.map((it, j) => <li key={j}>{r(it.c)}</li>)}</ol>
    case 'code':
      return (
        <div className="relative">
          <pre className="max-h-112 overflow-auto rounded-lg bg-code p-3 font-mono text-[12px] leading-relaxed text-code-fg">{b.v}</pre>
          {b.lang ? <span className="absolute right-2 top-1.5 text-[10px] uppercase text-code-fg/50">{b.lang}</span> : null}
        </div>
      )
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-edge-subtle">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-sunken/60 text-left text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              <tr>{b.head.map((h, j) => <th key={j} className="px-3 py-2">{r(h)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {b.rows.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k} className="px-3 py-2 align-top">{r(cell)}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      )
    case 'hr':
      return <hr className="border-edge-default" />
  }
}

function renderInline(xs: Inline[], hooks: MarkdownHooks): ReactNode {
  return xs.map((x, i) => <Fragment key={i}>{inlineNode(x, hooks)}</Fragment>)
}

function inlineNode(x: Inline, hooks: MarkdownHooks): ReactNode {
  switch (x.t) {
    case 'text':
      return x.v
    case 'b':
      return <strong className="font-semibold">{renderInline(x.c, hooks)}</strong>
    case 'i':
      return <em>{renderInline(x.c, hooks)}</em>
    case 's':
      return <s className="text-content-muted">{renderInline(x.c, hooks)}</s>
    case 'code':
      return <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">{x.v}</code>
    case 'link': {
      const external = /^(https?:|mailto:)/i.test(x.href)
      return (
        <a href={x.href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer noopener' : undefined} className="text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300">
          {renderInline(x.c, hooks)}
        </a>
      )
    }
    case 'mention':
      return <span className="rounded bg-brand-50 px-1 font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">@{x.v}</span>
    case 'wiki': {
      const exists = hooks.wikiExists?.(x.v) ?? true
      return (
        <button type="button" onClick={() => hooks.onWiki?.(x.v)} className={cn('rounded px-0.5 font-medium underline decoration-dotted underline-offset-2', exists ? 'text-brand-700 dark:text-brand-300' : 'text-content-subtle')} title={exists ? `Open “${x.v}”` : `No page called “${x.v}” — click to create it`}>
          {x.v}
        </button>
      )
    }
    case 'issue': {
      const info = hooks.resolveIssue?.(x.v)
      return (
        <button
          type="button"
          onClick={() => hooks.onIssue?.(x.v)}
          className="mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-1.5 py-0.5 align-baseline text-[12px] hover:border-edge-strong"
          title={info ? `${x.v}: ${info.name}` : `${x.v} — not found in loaded projects`}
        >
          <span className="font-mono text-[11px] font-semibold text-content-muted">{x.v}</span>
          {info
            ? (
              <>
                <span className="max-w-64 truncate text-content">{info.name}</span>
                <StateChip group={info.group} name={info.stateName} />
              </>
            )
            : null}
        </button>
      )
    }
  }
}
