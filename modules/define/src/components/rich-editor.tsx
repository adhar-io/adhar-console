import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { escapeHtml, renderMentions, sanitizeHtml } from '../data/work-text.ts'

/**
 * Rich text for Plane's `description_html`: a sanitised viewer and a small
 * WYSIWYG editor (contentEditable + formatting toolbar). Everything going in
 * or out passes the allow-list sanitiser; pasted HTML is sanitised before it
 * lands in the document.
 */

/** Typography for rendered Plane HTML (no typography plugin in this build). */
export const RICH = cn(
  'text-[13.5px] leading-relaxed text-content break-words',
  '[&_p]:my-1.5 [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold',
  '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li>p]:my-0.5',
  '[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-1 [&_li[data-checked=true]]:text-content-muted [&_li[data-checked=true]]:line-through',
  '[&_a]:text-brand-700 [&_a]:underline dark:[&_a]:text-brand-300',
  '[&_code]:rounded [&_code]:bg-surface-sunken [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface-sunken [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-edge-strong [&_blockquote]:pl-3 [&_blockquote]:text-content-muted',
  '[&_img]:my-2 [&_img]:max-h-80 [&_img]:rounded-lg [&_hr]:my-3 [&_hr]:border-edge-default',
  '[&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-edge-default [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-edge-default [&_th]:px-2 [&_th]:py-1',
  '[&_.adhar-mention]:rounded [&_.adhar-mention]:bg-brand-50 [&_.adhar-mention]:px-1 [&_.adhar-mention]:font-medium [&_.adhar-mention]:text-brand-800 dark:[&_.adhar-mention]:bg-brand-500/15 dark:[&_.adhar-mention]:text-brand-200',
)

export function RichView({ html, nameOf, className }: { html?: string | null; nameOf?(id: string): string | undefined; className?: string }) {
  const safe = renderMentions(sanitizeHtml(html), nameOf ?? (() => undefined))
  // deno-lint-ignore react-no-danger
  return <div className={cn(RICH, className)} dangerouslySetInnerHTML={{ __html: safe }} />
}

const TOOLS: Array<{ cmd: string; arg?: string; label: ReactNode; title: string }> = [
  { cmd: 'bold', label: <b>B</b>, title: 'Bold (⌘B)' },
  { cmd: 'italic', label: <i>I</i>, title: 'Italic (⌘I)' },
  { cmd: 'strikeThrough', label: <s>S</s>, title: 'Strikethrough' },
  { cmd: 'formatBlock', arg: 'h2', label: 'H2', title: 'Heading' },
  { cmd: 'formatBlock', arg: 'h3', label: 'H3', title: 'Subheading' },
  { cmd: 'insertUnorderedList', label: '• List', title: 'Bulleted list' },
  { cmd: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
  { cmd: 'formatBlock', arg: 'blockquote', label: '❝', title: 'Quote' },
  { cmd: 'formatBlock', arg: 'pre', label: '</>', title: 'Code block' },
  { cmd: 'link', label: '🔗', title: 'Link' },
  { cmd: 'removeFormat', label: 'Tx', title: 'Clear formatting' },
]

export function RichEditor({
  initial,
  onSave,
  onCancel,
  saving,
  placeholder = 'Describe the work…',
}: {
  initial?: string | null
  onSave(html: string): void
  onCancel(): void
  saving?: boolean
  placeholder?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = sanitizeHtml(initial) || ''
      ref.current.focus()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus()
    if (cmd === 'link') {
      const url = globalThis.prompt?.('Link URL (https://…)')
      if (url && /^(https?:|mailto:|\/)/i.test(url.trim())) document.execCommand('createLink', false, url.trim())
      return
    }
    document.execCommand(cmd, false, arg)
  }
  const save = () => onSave(sanitizeHtml(ref.current?.innerHTML ?? '').replace(/^(<p><br><\/p>)+$/, ''))

  return (
    <div className="overflow-hidden rounded-lg border border-brand-400 bg-surface-raised ring-2 ring-brand-400/15">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-edge-subtle bg-surface-sunken/60 px-1.5 py-1">
        {TOOLS.map((t) => (
          <button key={`${t.cmd}${t.arg ?? ''}`} type="button" title={t.title} onMouseDown={(e) => e.preventDefault()} onClick={() => exec(t.cmd, t.arg)} className="h-7 min-w-7 rounded px-1.5 text-[12px] text-content-muted hover:bg-surface-raised hover:text-content">
            {t.label}
          </button>
        ))}
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label="Description"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onPaste={(e) => {
          e.preventDefault()
          const html = e.clipboardData.getData('text/html')
          const text = e.clipboardData.getData('text/plain')
          document.execCommand('insertHTML', false, html ? sanitizeHtml(html) : escapeHtml(text).replace(/\n/g, '<br>'))
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
        className={cn(RICH, 'min-h-40 max-h-[60vh] overflow-y-auto px-3 py-2 focus:outline-none empty:before:text-content-subtle empty:before:content-[attr(data-placeholder)]')}
      />
      <div className="flex items-center justify-between gap-2 border-t border-edge-subtle px-2 py-1.5">
        <span className="text-[11px] text-content-subtle">⌘↵ save · Esc cancel</span>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button size="xs" variant="primary" loading={saving} onClick={save}>Save</Button>
        </div>
      </div>
    </div>
  )
}
