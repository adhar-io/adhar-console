import { forwardRef, memo, useMemo, useState } from 'react'
import { cn } from '@adhar/utils'
import type { PaletteEntry } from '../model/kinds.ts'
import { MIME } from './mime.ts'
import { KindTile } from './glyph.tsx'
import { entryLook } from './kind-look.ts'

/**
 * The palette (design 0026 §6.8): search, then the sections. Every entry is a
 * BUTTON — drag it onto the canvas to place it where it lands, or press
 * Enter / click to add it (laid out automatically), so building a flow never
 * needs a mouse (acceptance 6). `/` focuses the search.
 */

const SECTION_ORDER = ['Run something', 'Flow control', 'Platform steps', 'Reuse'] as const

export interface PaletteProps {
  entries: readonly PaletteEntry[]
  disabled?: boolean
  onAdd(id: string): void
  className?: string
}

export function matches(e: PaletteEntry, q: string): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  return [e.title, e.description, e.id, e.section].some((v) => v.toLowerCase().includes(s))
}

export const Palette = memo(forwardRef<HTMLInputElement, PaletteProps>(function Palette({ entries, disabled, onAdd, className }, searchRef) {
  const [q, setQ] = useState('')
  const sections = useMemo(() => SECTION_ORDER.map((name) => ({ name, items: entries.filter((e) => e.section === name && matches(e, q)) })).filter((s) => s.items.length), [entries, q])
  return (
    <nav aria-label="Step palette" className={cn('flex min-h-0 flex-col gap-3', className)}>
      <input
        ref={searchRef}
        type="search"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        placeholder="Search steps  ( / )"
        aria-label="Search the palette"
        className="h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-2.5 text-sm placeholder:text-content-subtle focus:border-brand-500 focus:outline-none"
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {sections.length ? sections.map((s) => (
          <section key={s.name} aria-label={s.name}>
            <h3 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-content-subtle">{s.name}</h3>
            <ul className="space-y-1">
              {s.items.map((e) => {
                const look = entryLook(e.id, e.kind)
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      draggable={!disabled}
                      disabled={disabled}
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData(MIME, e.id)
                        ev.dataTransfer.effectAllowed = 'copy'
                      }}
                      onClick={() => onAdd(e.id)}
                      title={e.description}
                      aria-label={`Add ${e.title}: ${e.description}`}
                      data-palette-entry={e.id}
                      className="flex w-full cursor-grab items-center gap-2 rounded-lg border border-transparent px-1.5 py-1 text-left hover:border-edge-default hover:bg-surface-raised focus-visible:border-brand-500 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <KindTile look={look} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-content">{e.title}</span>
                        <span className="block truncate text-[11px] text-content-subtle">{e.description}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )) : <p className="px-1 text-xs text-content-subtle">No step matches “{q}”.</p>}
      </div>
    </nav>
  )
}))
