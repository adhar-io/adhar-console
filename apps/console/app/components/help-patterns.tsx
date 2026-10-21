import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { DrawerWidenButton, Markdown, useDrawerWidth, useOverlayDismiss, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { CATEGORIES, CATEGORY_BLURB, type Category, matchesPattern, type Pattern } from '~/data/patterns.ts'
import { PATTERNS } from '~/data/patterns-content.ts'

/**
 * Help → Architecture patterns.
 *
 * Byte-sized docs on the patterns the platform is built on, each one a
 * Markdown file in `app/content/patterns/` (see its README). The page shows
 * them as cards filtered by category and by the Help search box; a card opens
 * a reader that renders the four standard sections — Why, How Adhar does it,
 * Use it, Watch out — as distinct blocks. The open pattern is in the URL
 * (`?pattern=<slug>`), so a link to one is shareable.
 */

const CAT_STYLE: Record<Category, { chip: string; dot: string; ring: string; icon: string }> = {
  Scale: { chip: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300', dot: 'bg-sky-500', ring: 'hover:border-sky-300 dark:hover:border-sky-500/40', icon: 'M3 17l6-6 4 4 8-8M15 7h6v6' },
  Resilience: { chip: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300', dot: 'bg-emerald-500', ring: 'hover:border-emerald-300 dark:hover:border-emerald-500/40', icon: 'M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z' },
  Delivery: { chip: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300', dot: 'bg-violet-500', ring: 'hover:border-violet-300 dark:hover:border-violet-500/40', icon: 'M5 12h14M13 6l6 6-6 6' },
  Data: { chip: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300', dot: 'bg-amber-500', ring: 'hover:border-amber-300 dark:hover:border-amber-500/40', icon: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' },
  Security: { chip: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300', dot: 'bg-rose-500', ring: 'hover:border-rose-300 dark:hover:border-rose-500/40', icon: 'M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5z' },
  Tenancy: { chip: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300', dot: 'bg-indigo-500', ring: 'hover:border-indigo-300 dark:hover:border-indigo-500/40', icon: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6' },
  Operations: { chip: 'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300', dot: 'bg-teal-500', ring: 'hover:border-teal-300 dark:hover:border-teal-500/40', icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
}

function CatIcon({ category, size = 14 }: { category: Category; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={CAT_STYLE[category].icon} />
    </svg>
  )
}

export function usePatternsMatching(needle: string): Pattern[] {
  return useMemo(() => PATTERNS.filter((p) => matchesPattern(p, needle)), [needle])
}

export function ArchitecturePatterns({ needle, openSlug, onOpen }: {
  /** The Help page's search text — filters patterns like everything else. */
  needle: string
  openSlug?: string
  onOpen(slug: string | undefined): void
}) {
  const [cat, setCat] = useState<Category | 'All'>('All')
  const matching = usePatternsMatching(needle)
  const shown = cat === 'All' ? matching : matching.filter((p) => p.category === cat)
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of matching) m.set(p.category, (m.get(p.category) ?? 0) + 1)
    return m
  }, [matching])
  const open = openSlug ? PATTERNS.find((p) => p.slug === openSlug) : undefined

  if (!matching.length && !open) return null

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Pattern categories">
        <CatChip on={cat === 'All'} onClick={() => setCat('All')} label="All" count={matching.length} />
        {CATEGORIES.filter((c) => counts.get(c)).map((c) => (
          <CatChip key={c} on={cat === c} onClick={() => setCat(c)} label={c} count={counts.get(c) ?? 0} category={c} />
        ))}
      </div>
      {cat !== 'All' ? <p className="-mt-2 mb-4 text-[13px] text-content-muted">{CATEGORY_BLURB[cat]}</p> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((p) => <PatternCard key={p.slug} pattern={p} onOpen={() => onOpen(p.slug)} />)}
      </div>

      {open ? <PatternReader pattern={open} list={shown.some((p) => p.slug === open.slug) ? shown : PATTERNS} onOpen={onOpen} /> : null}
    </>
  )
}

function CatChip({ on, onClick, label, count, category }: { on: boolean; onClick(): void; label: string; count: number; category?: Category }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors',
        on ? 'border-content bg-content text-surface-raised' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
      )}
    >
      {category ? <i className={cn('h-2 w-2 rounded-full', CAT_STYLE[category].dot)} /> : null}
      {label}
      <span className={cn('tabular-nums', on ? 'opacity-70' : 'text-content-subtle')}>{count}</span>
    </button>
  )
}

function PatternCard({ pattern: p, onOpen }: { pattern: Pattern; onOpen(): void }) {
  const st = CAT_STYLE[p.category]
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn('group flex h-full flex-col rounded-xl border border-edge-default bg-surface-raised p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md', st.ring)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold', st.chip)}>
          <CatIcon category={p.category} size={12} /> {p.category}
        </span>
        <span className="text-[11px] text-content-subtle">{p.minutes} min read</span>
      </div>
      <div className="mt-3 text-[15px] font-semibold leading-snug text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">{p.title}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-content-muted">{p.summary}</p>
      {p.tools.length ? (
        <div className="mt-auto flex flex-wrap gap-1 pt-3">
          {p.tools.slice(0, 3).map((t) => <span key={t} className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted">{t}</span>)}
          {p.tools.length > 3 ? <span className="px-1 py-0.5 text-[11px] text-content-subtle">+{p.tools.length - 3}</span> : null}
        </div>
      ) : null}
    </button>
  )
}

/* ─────────── reader ─────────── */

const SECTION_STYLE: Record<string, { label: string; className: string; icon: string }> = {
  'why': { label: 'Why', className: 'text-rose-700 dark:text-rose-300', icon: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
  'how adhar does it': { label: 'How Adhar does it', className: 'text-brand-700 dark:text-brand-300', icon: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  'use it': { label: 'Use it', className: 'text-emerald-700 dark:text-emerald-300', icon: 'm16 18 6-6-6-6M8 6l-6 6 6 6' },
  'watch out': { label: 'Watch out', className: 'text-amber-700 dark:text-amber-300', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v4M12 16h.01' },
}

/** Split the body on `## ` headings; text before the first one is an intro. */
function sections(body: string): Array<{ heading?: string; text: string }> {
  const out: Array<{ heading?: string; text: string }> = []
  let cur: { heading?: string; lines: string[] } = { lines: [] }
  let fenced = false
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) fenced = !fenced
    const m = !fenced && line.match(/^##\s+(.+)$/)
    if (m) {
      if (cur.heading || cur.lines.join('').trim()) out.push({ heading: cur.heading, text: cur.lines.join('\n').trim() })
      cur = { heading: m[1].trim(), lines: [] }
    } else {
      cur.lines.push(line)
    }
  }
  out.push({ heading: cur.heading, text: cur.lines.join('\n').trim() })
  return out.filter((s) => s.text)
}

function PatternReader({ pattern: p, list, onOpen }: { pattern: Pattern; list: Pattern[]; onOpen(slug: string | undefined): void }) {
  const close = () => onOpen(undefined)
  useOverlayDismiss(true, close)
  const toast = useToast()
  const width = useDrawerWidth('help.pattern', { base: 'max-w-2xl' })
  const copyLink = () => {
    const url = `${location.origin}/help?pattern=${p.slug}`
    navigator.clipboard?.writeText(url).then(() => toast.success('Link copied', { description: url }), () => toast.error('Clipboard unavailable'))
  }
  const st = CAT_STYLE[p.category]
  const i = list.findIndex((x) => x.slug === p.slug)
  const prev = i > 0 ? list[i - 1] : undefined
  const next = i >= 0 && i < list.length - 1 ? list[i + 1] : undefined
  const parts = useMemo(() => sections(p.body), [p.body])

  // Arrow keys page through the patterns, like the catalog drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /input|textarea|select/i.test(t.tagName)) return
      if (e.key === 'ArrowRight' && next) onOpen(next.slug)
      if (e.key === 'ArrowLeft' && prev) onOpen(prev.slug)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [next, prev, onOpen])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={p.title}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={close} />
      <article className={cn('relative flex h-full w-full flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl', width.className)}>
        <header className="border-b border-edge-default bg-surface-raised px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold', st.chip)}>
              <CatIcon category={p.category} size={12} /> {p.category} · {p.minutes} min read
            </span>
            <div className="-mr-2 -mt-1 flex items-center gap-1">
              <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
              <button type="button" onClick={close} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">✕</button>
            </div>
          </div>
          <h2 className="mt-3 text-[22px] font-semibold leading-tight tracking-tight text-content">{p.title}</h2>
          <p className="mt-1.5 text-[14px] leading-relaxed text-content-muted">{p.summary}</p>
          {p.tools.length ? (
            <div className="mt-3 flex flex-wrap gap-1">
              {p.tools.map((t) => <span key={t} className="rounded-md border border-edge-default px-1.5 py-0.5 text-[11px] text-content-muted">{t}</span>)}
            </div>
          ) : null}
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-6">
            {parts.map((s, k) => {
              const sty = s.heading ? SECTION_STYLE[s.heading.toLowerCase()] : undefined
              return (
                <section key={k}>
                  {s.heading ? (
                    <h3 className={cn('mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider', sty?.className ?? 'text-content-subtle')}>
                      {sty ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={sty.icon} /></svg> : null}
                      {sty?.label ?? s.heading}
                    </h3>
                  ) : null}
                  <Markdown text={s.text} className="text-[14px] leading-relaxed text-content [&_pre]:text-[12px] [&_li]:leading-relaxed" />
                </section>
              )
            })}
          </div>
        </div>

        <footer className="flex items-center gap-2 border-t border-edge-default bg-surface-raised px-6 py-3">
          <button type="button" disabled={!prev} onClick={() => prev && onOpen(prev.slug)} className="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-[12px] text-content-muted hover:bg-surface-sunken hover:text-content disabled:invisible">
            ← {prev?.title}
          </button>
          <span className="shrink-0 text-[11px] tabular-nums text-content-subtle">{i + 1} / {list.length}</span>
          <button type="button" onClick={copyLink} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content">
            Copy link
          </button>
          <button type="button" disabled={!next} onClick={() => next && onOpen(next.slug)} className="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-right text-[12px] text-content-muted hover:bg-surface-sunken hover:text-content disabled:invisible">
            {next?.title} →
          </button>
        </footer>
      </article>
    </div>,
    document.body,
  )
}
