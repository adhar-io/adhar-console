import { useState } from 'react'
import { cn } from '@adhar/utils'
import type { Diagnostic } from '../model/validate.ts'

/**
 * The diagnostics bar (design 0026 §6.7, §6.8): the three levels merged —
 * client (every edit), admission (dry run) and lint (argo-server) — with a
 * count, the list on demand, and a click that takes you to the step or the
 * line. Info is counted apart: it never blocks.
 */

export function summarise(diags: readonly Diagnostic[]): { errors: number; warnings: number; info: number } {
  let errors = 0, warnings = 0, info = 0
  for (const d of diags) d.level === 'error' ? errors++ : d.level === 'warning' ? warnings++ : info++
  return { errors, warnings, info }
}

const SOURCE: Record<Diagnostic['source'], string> = { client: 'designer', admission: 'admission', lint: 'argo' }

export function DiagnosticsBar({ diagnostics, onSelect, onReveal, defaultOpen = false }: { diagnostics: readonly Diagnostic[]; onSelect(uid: string): void; onReveal(d: Diagnostic): void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const s = summarise(diagnostics)
  const sorted = [...diagnostics].sort((a, b) => rank(a.level) - rank(b.level))
  return (
    <section aria-label="Problems" className="rounded-xl border border-edge-default bg-surface-raised text-xs">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-3 py-1.5 text-left">
        <span className={cn('font-medium', s.errors ? 'text-rose-700 dark:text-rose-300' : 'text-content-muted')}>{s.errors} error{s.errors === 1 ? '' : 's'}</span>
        <span className={cn(s.warnings ? 'text-amber-800 dark:text-amber-300' : 'text-content-muted')}>{s.warnings} warning{s.warnings === 1 ? '' : 's'}</span>
        <span className="text-content-subtle">{s.info} note{s.info === 1 ? '' : 's'}</span>
        <span className="ml-auto text-content-subtle">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && sorted.length ? (
        <ul className="max-h-40 overflow-y-auto border-t border-edge-subtle">
          {sorted.map((d, i) => (
            <li key={i}>
              <button
                type="button"
                className="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-surface-sunken"
                onClick={() => (d.task ? onSelect(d.task.uid) : onReveal(d))}
              >
                <span className={cn('mt-px w-14 shrink-0 font-semibold uppercase tracking-wide', d.level === 'error' ? 'text-rose-600' : d.level === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-content-subtle')}>{d.level}</span>
                <span className="min-w-0 flex-1 text-content">{d.task ? <span className="font-mono text-content-muted">{d.task.name}: </span> : null}{d.message}</span>
                <span className="shrink-0 rounded bg-surface-sunken px-1 text-[10px] text-content-subtle">{SOURCE[d.source]}{d.range ? ` · line ${d.range.startLine}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

const rank = (l: Diagnostic['level']) => (l === 'error' ? 0 : l === 'warning' ? 1 : 2)
