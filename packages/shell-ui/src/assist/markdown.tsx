import { useMemo, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * Small, dependency-free renderer for the subset the assistant emits:
 * fenced code, inline code, headings, bullet / numbered lists, tables, block
 * quotes, bold, italic, links and paragraphs. Never injects HTML — every
 * construct becomes a React element, so model output cannot smuggle markup.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <div className={cn('space-y-2.5', className)}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'code':
            return (
              <div key={i} className="group/code relative">
                <pre className="max-h-96 overflow-auto rounded-lg bg-code p-3 font-mono text-[11.5px] leading-relaxed text-code-fg">{b.text}</pre>
                {b.lang ? <span className="absolute right-2 top-1.5 text-[10px] uppercase text-code-fg/45">{b.lang}</span> : null}
                <button type="button" onClick={() => void navigator.clipboard?.writeText(b.text)} className="absolute bottom-2 right-2 rounded bg-code-raised px-1.5 py-0.5 text-[10px] text-code-fg/70 opacity-0 transition-opacity hover:text-white group-hover/code:opacity-100">copy</button>
              </div>
            )
          case 'heading':
            return <div key={i} className={cn('font-semibold tracking-tight text-content', b.level <= 2 ? 'text-[14.5px]' : 'text-[13.5px]')}>{inline(b.text)}</div>
          case 'ul':
            return <ul key={i} className="list-disc space-y-1 pl-5 marker:text-content-subtle">{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
          case 'ol':
            return <ol key={i} className="list-decimal space-y-1 pl-5 marker:text-content-subtle">{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>
          case 'quote':
            return <blockquote key={i} className="border-l-2 border-brand-400/60 pl-3 text-content-muted">{inline(b.text)}</blockquote>
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-lg border border-edge-subtle">
                <table className="w-full text-[12.5px]">
                  <thead className="bg-surface-sunken/60 text-[10.5px] uppercase tracking-wider text-content-subtle">
                    <tr>{b.head.map((h, j) => <th key={j} className="px-2.5 py-1.5 text-left font-semibold">{inline(h)}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-edge-subtle">
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, k) => <td key={k} className="px-2.5 py-1.5 align-top text-content">{inline(c)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'hr':
            return <hr key={i} className="border-edge-subtle" />
          default:
            return <p key={i}>{inline(b.text)}</p>
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

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let k = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const tok = m[0]
    if (tok.startsWith('`')) out.push(<code key={k++} className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px] text-content">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={k++} className="font-semibold text-content">{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      if (mm) out.push(<a key={k++} href={mm[2]} target="_blank" rel="noreferrer" className="text-brand-700 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-600 dark:text-brand-300">{mm[1]}</a>)
    } else out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    last = idx + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
