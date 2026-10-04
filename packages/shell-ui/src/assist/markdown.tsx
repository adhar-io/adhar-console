import { useMemo, type ReactNode } from 'react'
import { tokenizeInline } from './markdown-inline.ts'
import { cn } from '@adhar-console/utils'

/**
 * Small, dependency-free renderer for the subset the assistant emits:
 * fenced code, inline code, headings, bullet / numbered lists, tables, block
 * quotes, bold, italic, links and paragraphs. Never injects HTML — every
 * construct becomes a React element, so model output cannot smuggle markup.
 */
export function Markdown(
  { text, className, images, resolveSrc }: {
    text: string
    className?: string
  } & InlineOpts,
) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const opts: InlineOpts = { images, resolveSrc }
  return (
    <div className={cn('space-y-2.5', className)}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'code':
            return (
              <div key={i} className="group/code relative">
                <pre className="max-h-96 overflow-auto rounded-lg bg-code p-3 font-mono text-[11px] leading-relaxed text-code-fg">{b.text}</pre>
                {b.lang ? <span className="absolute right-2 top-1.5 text-[10px] uppercase text-code-fg/45">{b.lang}</span> : null}
                <button type="button" onClick={() => void navigator.clipboard?.writeText(b.text)} className="absolute bottom-2 right-2 rounded bg-code-raised px-1.5 py-0.5 text-[10px] text-code-fg/70 opacity-0 transition-opacity hover:text-white group-hover/code:opacity-100">copy</button>
              </div>
            )
          case 'heading': {
            // A real heading element. A README is a document with a structure,
            // and a screen reader cannot navigate a stack of divs.
            const H = (`h${Math.min(6, Math.max(1, b.level))}`) as 'h1'
            return (
              <H
                key={i}
                className={cn(
                  'font-semibold tracking-tight text-content',
                  b.level === 1 ? 'text-[16px]' : b.level === 2 ? 'text-[14px]' : 'text-[13px]',
                )}
              >
                {inline(b.text, opts)}
              </H>
            )
          }
          case 'ul':
            return <ul key={i} className="list-disc space-y-1 pl-5 marker:text-content-subtle">{b.items.map((it, j) => <li key={j}>{inline(it, opts)}</li>)}</ul>
          case 'ol':
            return <ol key={i} className="list-decimal space-y-1 pl-5 marker:text-content-subtle">{b.items.map((it, j) => <li key={j}>{inline(it, opts)}</li>)}</ol>
          case 'quote':
            return <blockquote key={i} className="border-l-2 border-brand-400/60 pl-3 text-content-muted">{inline(b.text, opts)}</blockquote>
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-lg border border-edge-subtle">
                <table className="w-full text-[12px]">
                  <thead className="bg-surface-sunken/60 text-[10px] uppercase tracking-wider text-content-subtle">
                    <tr>{b.head.map((h, j) => <th key={j} className="px-2.5 py-1.5 text-left font-semibold">{inline(h, opts)}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-edge-subtle">
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, k) => <td key={k} className="px-2.5 py-1.5 align-top text-content">{inline(c, opts)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'hr':
            return <hr key={i} className="border-edge-subtle" />
          default:
            return <p key={i}>{inline(b.text, opts)}</p>
        }
      })}
    </div>
  )
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'hr' }

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim() || undefined
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push({ type: 'code', lang, text: buf.join('\n') })
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ type: 'hr' })
      i++
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ type: 'heading', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(splitRow(lines[i++]))
      out.push({ type: 'table', head, rows })
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ type: 'quote', text: buf.join(' ') })
      continue
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''))
      out.push({ type: 'ul', items })
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))
      out.push({ type: 'ol', items })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*[-*•]\s+|^\s*\d+[.)]\s+|^\s*>|^\s*\|/.test(lines[i])) buf.push(lines[i++])
    if (!buf.length) buf.push(lines[i++])
    out.push({ type: 'p', text: buf.join(' ') })
  }
  return out
}

/**
 * How images are treated.
 *
 * `alt` is the assistant's rule: model output must never make this console
 * fetch from someone else's CDN, and the console has to work air-gapped.
 * `show` is for the user's own repository content, where a README whose every
 * badge and screenshot is a word of grey text is not the README.
 */
export type ImagePolicy = 'alt' | 'show'

export interface InlineOpts {
  images?: ImagePolicy
  /** Turns a README-relative `./docs/x.png` into something fetchable. */
  resolveSrc?(src: string): string | undefined
}

function imageNode(
  key: number,
  alt: string,
  src: string,
  opts: InlineOpts,
): ReactNode {
  if (opts.images !== 'show') {
    return alt
      ? <span key={key} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted">{alt}</span>
      : null
  }
  const resolved = opts.resolveSrc ? opts.resolveSrc(src) : src
  // A relative path nothing can resolve would render as a broken image icon,
  // which is worse than the alt text it replaced.
  if (!resolved) {
    return alt
      ? <span key={key} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted">{alt}</span>
      : null
  }
  return (
    <img
      key={key}
      src={resolved}
      alt={alt}
      loading="lazy"
      className="inline-block max-w-full align-middle"
    />
  )
}

function inline(text: string, opts: InlineOpts = {}): ReactNode[] {
  return tokenizeInline(text).map((t, k) => {
    switch (t.kind) {
      case 'code':
        return <code key={k} className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px] text-content">{t.text}</code>
      case 'strong':
        return <strong key={k} className="font-semibold text-content">{t.text}</strong>
      case 'em':
        return <em key={k}>{t.text}</em>
      case 'link':
        return <a key={k} href={t.href} target="_blank" rel="noreferrer" className="text-brand-700 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-600 dark:text-brand-300">{t.text}</a>
      case 'image':
        return imageNode(k, t.alt, t.src, opts)
      case 'image-link':
        return (
          <a key={k} href={t.href} target="_blank" rel="noreferrer" className="inline-block align-middle">
            {imageNode(k, t.alt, t.src, opts)}
          </a>
        )
      default:
        return t.text
    }
  })
}
