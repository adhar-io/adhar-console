import { useMemo, useState } from 'react'
import { cn } from '@adhar-console/utils'
import { assistStore, useAssist, type Thread } from '../agui/store.ts'
import { relTime } from './inspector.tsx'
import { IconPlus, IconSearch, IconTrash } from './icons.tsx'
import { accentDot } from './accent.ts'

/**
 * Conversations, grouped by when they happened.
 *
 * Kept in this browser (localStorage), which the footer says plainly — a
 * transcript that carries pod names and log lines should not silently become
 * server-side data. Search filters by title and by the text of any turn, so
 * "the one where it found the OOM" is findable.
 */
export function ThreadsRail({ onPicked }: { onPicked?(): void }) {
  const { history, thread, agents } = useAssist()
  const [q, setQ] = useState('')

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = history.filter((t) => !needle || t.title.toLowerCase().includes(needle) || t.messages.some((m) => m.content.toLowerCase().includes(needle)))
    const out: Array<{ label: string; items: Thread[] }> = []
    const now = Date.now()
    const bucket = (iso: string) => {
      const age = now - new Date(iso).getTime()
      if (age < 86_400_000) return 'Today'
      if (age < 2 * 86_400_000) return 'Yesterday'
      if (age < 7 * 86_400_000) return 'This week'
      return 'Earlier'
    }
    for (const t of list) {
      const label = bucket(t.updatedAt)
      const g = out.find((x) => x.label === label)
      if (g) g.items.push(t)
      else out.push({ label, items: [t] })
    }
    return out
  }, [history, q])

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name
  const agentAccent = (id: string) => agents.find((a) => a.id === id)?.accent ?? 'brand'

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-edge-subtle bg-surface-raised/50">
      <div className="space-y-1.5 p-2.5">
        <button
          type="button"
          onClick={() => { assistStore.newThread(); onPicked?.() }}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised text-[12px] font-medium text-content transition-colors hover:border-brand-300 hover:bg-brand-50/50 dark:hover:border-brand-500/40 dark:hover:bg-brand-500/5"
        >
          <IconPlus size={11} /> New conversation
        </button>
        <label className="flex h-8 items-center gap-2 rounded-lg bg-surface-sunken/70 px-2.5 focus-within:ring-1 focus-within:ring-edge-default">
          <span className="text-content-subtle"><IconSearch size={12} /></span>
          {/* The wrapper draws the focus ring; the field itself must not, or the
              global input ring paints a second box inside the first. */}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content-subtle focus:ring-0 focus-visible:shadow-none" />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!history.length ? (
          <p className="px-2.5 py-4 text-[11.5px] leading-relaxed text-content-subtle">Conversations you have here are kept in this browser and listed by day.</p>
        ) : !groups.length ? (
          <p className="px-2.5 py-4 text-[11.5px] text-content-subtle">Nothing matches “{q}”.</p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-2">
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{g.label}</div>
              <ul className="space-y-px">
                {g.items.map((t) => {
                  const current = t.id === thread.id
                  const last = [...t.messages].reverse().find((m) => m.role === 'assistant' && m.content)
                  return (
                    <li key={t.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => { assistStore.openThread(t.id); onPicked?.() }}
                        className={cn('w-full rounded-lg px-2.5 py-1.5 pr-7 text-left transition-colors', current ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken')}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', accentDot(agentAccent(t.agentId)))} aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-content">{t.title}</span>
                        </div>
                        <div className="mt-0.5 truncate pl-3 text-[10.5px] text-content-subtle">
                          {last ? last.content.replace(/[#*`>\-]/g, '').slice(0, 80) : `${t.messages.length} message${t.messages.length === 1 ? '' : 's'}`}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 pl-3 text-[10px] text-content-subtle">
                          {agentName(t.agentId) ? <span>{agentName(t.agentId)}</span> : null}
                          <span>·</span>
                          <span>{relTime(t.updatedAt)}</span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => assistStore.deleteThread(t.id)}
                        aria-label="Delete conversation"
                        className="absolute right-1.5 top-1.5 rounded p-1 text-content-subtle opacity-0 transition-opacity hover:bg-surface-sunken hover:text-rose-600 group-hover:opacity-100"
                      >
                        <IconTrash size={11} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {history.length ? (
        <div className="flex items-center justify-between border-t border-edge-subtle px-3 py-2 text-[10.5px] text-content-subtle">
          <span>Kept in this browser</span>
          <button type="button" onClick={() => assistStore.clearHistory()} className="font-medium hover:text-rose-600">Clear all</button>
        </div>
      ) : null}
    </aside>
  )
}
