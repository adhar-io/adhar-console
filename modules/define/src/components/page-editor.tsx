import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar/utils'
import { memberDisplayName, useMembers } from '../data/plane.ts'
import { IssueSearch } from './issue-search.tsx'
import { type MarkdownHooks, PageMarkdown } from './page-markdown.tsx'

/**
 * Markdown editor for Define pages: toolbar, keyboard shortcuts (⌘B / ⌘I /
 * ⌘K / ⌘S), `@` mention autocomplete from Plane members, an issue picker that
 * inserts live issue references, and a sanitised live preview (side by side
 * on wide screens, a toggle on phones).
 */

type Mode = 'write' | 'preview' | 'split'

export function PageEditor({
  value,
  onChange,
  onSave,
  hooks,
  autoFocus,
}: {
  value: string
  onChange(v: string): void
  onSave?(): void
  hooks?: MarkdownHooks
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [mode, setMode] = useState<Mode>(() => (typeof matchMedia !== 'undefined' && matchMedia('(min-width: 1024px)').matches ? 'split' : 'write'))
  const [picker, setPicker] = useState(false)
  const members = useMembers()
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const names = useMemo(() => (members.data ?? []).map((m) => memberDisplayName(m)).filter(Boolean), [members.data])
  const suggestions = mention ? names.filter((n) => n.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6) : []

  /** Replace the selection (or insert at the caret) and keep focus. */
  const edit = (fn: (sel: string) => { text: string; select?: [number, number] }) => {
    const el = ref.current
    if (!el) return
    const { selectionStart: s, selectionEnd: e } = el
    const out = fn(value.slice(s, e))
    const next = value.slice(0, s) + out.text + value.slice(e)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      // `select` is relative to where the text went in; default: caret after it.
      const [a, b] = out.select ?? [out.text.length, out.text.length]
      el.setSelectionRange(s + a, s + b)
    })
  }
  const wrap = (l: string, r = l, placeholder = 'text') => edit((sel) => ({ text: `${l}${sel || placeholder}${r}`, select: [l.length, l.length + (sel || placeholder).length] }))
  const linePrefix = (prefix: string) => {
    const el = ref.current
    if (!el) return
    const s = el.selectionStart
    const lineStart = value.lastIndexOf('\n', s - 1) + 1
    onChange(value.slice(0, lineStart) + prefix + value.slice(lineStart))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + prefix.length, s + prefix.length)
    })
  }
  const insert = (text: string) => edit(() => ({ text }))

  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret)
    const m = /(^|[\s(])@([\w.-]{0,30})$/.exec(before)
    setMention(m ? { start: caret - m[2].length - 1, query: m[2] } : null)
    setActive(0)
  }
  const pickMention = (name: string) => {
    if (!mention || !ref.current) return
    const caret = ref.current.selectionStart
    const token = /^[\w.-]+$/.test(name) ? `@${name} ` : `@[${name}] `
    const next = value.slice(0, mention.start) + token + value.slice(caret)
    onChange(next)
    setMention(null)
    const pos = mention.start + token.length
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        return setActive((a) => (a + 1) % suggestions.length)
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        return setActive((a) => (a - 1 + suggestions.length) % suggestions.length)
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return pickMention(suggestions[active])
      }
      if (e.key === 'Escape') return setMention(null)
    }
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onSave?.()
    } else if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      wrap('**')
    } else if (mod && e.key.toLowerCase() === 'i') {
      e.preventDefault()
      wrap('_')
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      edit((sel) => ({ text: `[${sel || 'link'}](https://)`, select: [(sel || 'link').length + 3, (sel || 'link').length + 11] }))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      insert('  ')
    }
  }

  const tools: Array<{ label: string; title: string; run(): void }> = [
    { label: 'H2', title: 'Heading', run: () => linePrefix('## ') },
    { label: 'B', title: 'Bold (⌘B)', run: () => wrap('**') },
    { label: 'I', title: 'Italic (⌘I)', run: () => wrap('_') },
    { label: 'S', title: 'Strikethrough', run: () => wrap('~~') },
    { label: '`', title: 'Inline code', run: () => wrap('`') },
    { label: '•', title: 'Bullet list', run: () => linePrefix('- ') },
    { label: '1.', title: 'Numbered list', run: () => linePrefix('1. ') },
    { label: '☐', title: 'Task', run: () => linePrefix('- [ ] ') },
    { label: '❝', title: 'Quote', run: () => linePrefix('> ') },
    { label: '{ }', title: 'Code block', run: () => edit((sel) => ({ text: `\n\`\`\`\n${sel || 'code'}\n\`\`\`\n`, select: [5, 5 + (sel || 'code').length] })) },
    { label: '⊞', title: 'Table', run: () => insert('\n| Column | Column |\n| --- | --- |\n|  |  |\n') },
    { label: '🔗', title: 'Link (⌘K)', run: () => edit((sel) => ({ text: `[${sel || 'link'}](https://)`, select: [(sel || 'link').length + 3, (sel || 'link').length + 11] })) },
    { label: '[[ ]]', title: 'Link to a page', run: () => wrap('[[', ']]', 'Page title') },
    { label: '@', title: 'Mention', run: () => insert('@') },
  ]

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-edge-subtle px-2 py-1.5">
        {tools.map((t) => (
          <button key={t.title} type="button" title={t.title} aria-label={t.title} onClick={t.run} className="min-w-7 rounded px-1.5 py-1 text-[12px] font-semibold text-content-muted hover:bg-surface-sunken hover:text-content">
            {t.label}
          </button>
        ))}
        <button type="button" onClick={() => setPicker((p) => !p)} className={cn('rounded px-1.5 py-1 text-[12px] font-semibold text-content-muted hover:bg-surface-sunken hover:text-content', picker && 'bg-surface-sunken text-content')} title="Insert a Plane issue">
          # Issue
        </button>
        <div className="ml-auto flex rounded-md border border-edge-default p-0.5 text-[11px]">
          {(['write', 'split', 'preview'] as Mode[]).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={cn('rounded px-2 py-0.5 capitalize', mode === m ? 'bg-surface-sunken font-semibold text-content' : 'text-content-muted', m === 'split' && 'hidden lg:block')}>
              {m}
            </button>
          ))}
        </div>
      </div>
      {picker
        ? (
          <div className="border-b border-edge-subtle p-2">
            <IssueSearch
              autoFocus
              onPick={(h) => {
                insert(`${h.project__identifier}-${h.sequence_id} `)
                setPicker(false)
              }}
              placeholder="Find an issue to reference…"
            />
          </div>
        )
        : null}
      <div className={cn('grid', mode === 'split' && 'lg:grid-cols-2 lg:divide-x lg:divide-edge-subtle')}>
        {mode !== 'preview'
          ? (
            <div className="relative">
              <textarea
                ref={ref}
                value={value}
                onChange={(e) => {
                  onChange(e.target.value)
                  detectMention(e.target.value, e.target.selectionStart)
                }}
                onKeyDown={onKeyDown}
                onBlur={() => setTimeout(() => setMention(null), 150)}
                spellCheck
                aria-label="Page content (markdown)"
                className="block min-h-112 w-full resize-y bg-transparent p-4 font-mono text-[13px] leading-relaxed text-content placeholder:text-content-subtle focus:outline-none"
                placeholder="Write in markdown. @ to mention, KEY-123 to reference an issue, [[Page]] to link a page."
              />
              {mention && suggestions.length
                ? (
                  <ul role="listbox" className="absolute left-4 top-4 z-20 w-60 overflow-hidden rounded-lg border border-edge-default bg-surface-raised py-1 shadow-lg">
                    {suggestions.map((n, i) => (
                      <li key={n}>
                        <button type="button" role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(n)} className={cn('block w-full px-3 py-1.5 text-left text-[13px]', i === active ? 'bg-surface-sunken text-content' : 'text-content-muted')}>
                          @{n}
                        </button>
                      </li>
                    ))}
                  </ul>
                )
                : null}
            </div>
          )
          : null}
        {mode !== 'write'
          ? (
            <div className="min-h-112 overflow-auto p-4">
              <PageMarkdown text={value} hooks={hooks} />
            </div>
          )
          : null}
      </div>
    </div>
  )
}
