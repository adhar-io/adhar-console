import { useEffect, useRef, useState } from 'react'
import { Button, Card, CardBody, CardHeader, Spinner, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { planeError, useStickies, useStickyMutations } from '../data/plane.ts'

/**
 * Team notes — Plane's workspace stickies, on the Define dashboard.
 *
 * Stickies belong to the account behind the console's Plane API key, which
 * every console user shares, so these read as one shared board of short
 * notes: a release checklist, this quarter's focus, a phone number. Edits
 * save when the note loses focus.
 */

const COLORS: Array<{ id: string; swatch: string; card: string }> = [
  { id: 'yellow', swatch: 'bg-amber-300', card: 'bg-amber-50 border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30' },
  { id: 'green', swatch: 'bg-emerald-300', card: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/30' },
  { id: 'blue', swatch: 'bg-sky-300', card: 'bg-sky-50 border-sky-200 dark:bg-sky-500/10 dark:border-sky-500/30' },
  { id: 'purple', swatch: 'bg-violet-300', card: 'bg-violet-50 border-violet-200 dark:bg-violet-500/10 dark:border-violet-500/30' },
  { id: 'pink', swatch: 'bg-pink-300', card: 'bg-pink-50 border-pink-200 dark:bg-pink-500/10 dark:border-pink-500/30' },
  { id: 'gray', swatch: 'bg-slate-300', card: 'bg-surface-raised border-edge-default' },
]
const style = (c?: string | null) => COLORS.find((x) => x.id === c) ?? COLORS[0]

export function StickyNotes() {
  const q = useStickies()
  const m = useStickyMutations()
  const toast = useToast()
  // Plane may not expose stickies on older builds; the widget just steps aside.
  if (q.isError) return null
  const notes = [...(q.data ?? [])].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-content">Team notes</div>
            <div className="text-[11px] text-content-subtle">Plane stickies — shared by everyone using this console</div>
          </div>
          <Button
            size="sm"
            variant="primary"
            loading={m.create.isPending}
            onClick={() => m.create.mutate({ name: '', description_html: '<p></p>', background_color: 'yellow' }, { onError: (e) => toast.error(planeError(e, "Couldn't add a note.")) })}
          >
            + Note
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {q.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Loading notes…</div>
        ) : notes.length === 0 ? (
          <p className="text-[12px] text-content-subtle">No notes yet — add a release checklist, this cycle's focus, or anything the team should see.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {notes.map((n) => <Note key={n.id} note={n} />)}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function Note({ note: n }: { note: plane.Sticky }) {
  const m = useStickyMutations()
  const toast = useToast()
  const [name, setName] = useState(n.name ?? '')
  const [body, setBody] = useState(htmlToText(n.description_html))
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    setName(n.name ?? '')
    setBody(htmlToText(n.description_html))
  }, [n.name, n.description_html])
  // A brand-new empty note takes focus so it can be typed straight into.
  useEffect(() => {
    if (!n.name && !htmlToText(n.description_html)) ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const save = () => {
    const html = textToHtml(body)
    if (name === (n.name ?? '') && html === textToHtml(htmlToText(n.description_html))) return
    m.update.mutate({ id: n.id, patch: { name, description_html: html } }, { onError: (e) => toast.error(planeError(e, "Couldn't save the note.")) })
  }
  const st = style(n.background_color)
  return (
    <div className={cn('group flex min-h-36 flex-col rounded-xl border p-3 shadow-sm', st.card)}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        placeholder="Title"
        aria-label="Note title"
        className="w-full bg-transparent text-[13px] font-semibold text-content placeholder:text-content-subtle focus:outline-none"
      />
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={save}
        placeholder="Write a note…"
        aria-label="Note"
        rows={4}
        className="mt-1 w-full flex-1 resize-none bg-transparent text-[12px] leading-relaxed text-content placeholder:text-content-subtle focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-1">
        {COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-label={`${c.id} note`}
            onClick={() => m.update.mutate({ id: n.id, patch: { background_color: c.id } })}
            className={cn('h-3.5 w-3.5 rounded-full ring-1 ring-black/10 transition-transform hover:scale-110', c.swatch, (n.background_color ?? 'yellow') === c.id && 'ring-2 ring-content')}
          />
        ))}
        <span className="ml-auto text-[10px] text-content-subtle">{n.updated_at ? formatRelative(n.updated_at) : ''}</span>
        <button
          type="button"
          onClick={() => {
            if (!confirm('Delete this note?')) return
            m.remove.mutate(n.id, { onError: (e) => toast.error(planeError(e, "Couldn't delete the note.")) })
          }}
          className="ml-1 text-[11px] text-content-subtle opacity-0 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

function htmlToText(html?: string): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}
function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const t = text.trim()
  return t ? t.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') : '<p></p>'
}
