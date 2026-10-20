import { useEffect, useMemo, useState } from 'react'
import { Button, Modal } from '@adhar/shell-ui'
import type { CatalogSource } from '../data/platform.ts'
import { type PEntity, type PKind, refOf, shortRef, splitRef } from '../data/platform-model.ts'

/**
 * Catalog entity UI shared by the Design editors: kind-coloured chips that
 * deep-link into the console's Service Catalog, a multi-select picker, and an
 * honest per-source status line.
 */

export const KIND_TONE: Record<PKind, string> = {
  Component: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  API: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  Resource: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  System: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  Domain: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300',
  Group: 'bg-surface-sunken text-content-muted',
}

/** Console Service Catalog deep link (Components are what the host lists). */
export function catalogHref(ref: string): string | undefined {
  const { kind } = splitRef(ref)
  if (kind !== 'Component') return undefined
  return `/catalog?entity=${encodeURIComponent(shortRef(ref))}`
}

/** `entity`: the live entity, `null` when the catalog loaded without it, `undefined` while unknown. */
export function EntityChip({ entityRef, entity, onRemove }: { entityRef: string; entity?: PEntity | null; onRemove?(): void }) {
  const { kind, name } = splitRef(entityRef)
  const href = catalogHref(entityRef)
  const body = (
    <>
      <span className="font-mono text-[9.5px] uppercase opacity-70">{kind ?? '?'}</span>
      <span className="truncate">{entity?.title ?? name}</span>
    </>
  )
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] ${kind ? KIND_TONE[kind] : 'bg-surface-sunken text-content-muted'}`} title={entity === null ? 'Not in the live catalog right now' : undefined}>
      {href ? <a href={href} className="inline-flex min-w-0 items-center gap-1 hover:underline">{body}</a> : body}
      {entity === null ? <span className="text-[10px] opacity-60">(missing)</span> : null}
      {onRemove
        ? <button type="button" aria-label={`Unlink ${name}`} onClick={onRemove} className="ml-0.5 opacity-60 hover:opacity-100">×</button>
        : null}
    </span>
  )
}

export function EntityChips({ refs, entities, onChange, loaded = entities.length > 0 }: { refs: string[]; entities: PEntity[]; onChange?(next: string[]): void; loaded?: boolean }) {
  const byRef = useMemo(() => new Map(entities.map((e) => [refOf(e), e])), [entities])
  if (!refs.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {refs.map((r) => <EntityChip key={r} entityRef={r} entity={byRef.get(r) ?? (loaded ? null : undefined)} onRemove={onChange ? () => onChange(refs.filter((x) => x !== r)) : undefined} />)}
    </div>
  )
}

/** Per-source status of the live catalog — loading / error / empty is said, never hidden. */
export function CatalogSources({ sources, className }: { sources: CatalogSource[]; className?: string }) {
  const bad = sources.filter((s) => s.state === 'error')
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-subtle ${className ?? ''}`}>
      {sources.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1" title={s.error}>
          <span className={`h-1.5 w-1.5 rounded-full ${s.state === 'ok' ? 'bg-emerald-500' : s.state === 'error' ? 'bg-rose-500' : s.state === 'loading' ? 'animate-pulse bg-sky-400' : 'bg-content-subtle/50'}`} />
          {s.label}: {s.state === 'loading' ? 'loading…' : s.state === 'error' ? 'unavailable' : s.count}
        </span>
      ))}
      {bad.length ? <span className="text-rose-600 dark:text-rose-400">{bad.map((b) => b.error).filter(Boolean).join(' · ')}</span> : null}
    </div>
  )
}

const KINDS: PKind[] = ['System', 'Component', 'API', 'Resource']

/** Pick catalog entities (multi-select). */
export function EntityPickerModal({
  open,
  onClose,
  entities,
  sources,
  selected,
  onSave,
  title = 'Link catalog entities',
  kinds = KINDS,
}: {
  open: boolean
  onClose(): void
  entities: PEntity[]
  sources: CatalogSource[]
  selected: string[]
  onSave(refs: string[]): void
  title?: string
  kinds?: PKind[]
}) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<PKind | 'all'>('all')
  const [sel, setSel] = useState<Set<string>>(new Set(selected))
  useEffect(() => {
    if (open) {
      setSel(new Set(selected))
      setQ('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const shown = entities
    .filter((e) => kinds.includes(e.kind))
    .filter((e) => kind === 'all' || e.kind === kind)
    .filter((e) => !q.trim() || `${e.name} ${e.title ?? ''} ${e.description ?? ''} ${e.project ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
  const toggle = (r: string) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(r)) n.delete(r)
      else n.add(r)
      return n
    })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="Entities from the live service catalog — Application XRs, Gitea repositories and their catalog-info.yaml."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => onSave([...sel])}>Save links ({sel.size})</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search entities…"
            aria-label="Search entities"
            className="h-8 min-w-0 flex-1 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[12.5px] text-content placeholder:text-content-subtle"
          />
          <select value={kind} onChange={(e) => setKind(e.target.value as PKind | 'all')} aria-label="Kind" className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content">
            <option value="all">All kinds</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <CatalogSources sources={sources} />
        <ul className="max-h-[46vh] divide-y divide-edge-subtle overflow-auto rounded-lg border border-edge-default">
          {shown.length === 0
            ? <li className="p-4 text-center text-[12px] text-content-subtle">{entities.length ? 'No entities match.' : 'The catalog has no entities yet.'}</li>
            : shown.map((e) => {
              const r = refOf(e)
              return (
                <li key={r}>
                  <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-surface-sunken/60">
                    <input type="checkbox" checked={sel.has(r)} onChange={() => toggle(r)} className="mt-1" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={`rounded px-1 font-mono text-[9.5px] uppercase ${KIND_TONE[e.kind]}`}>{e.kind}</span>
                        <span className="truncate text-[13px] font-medium text-content">{e.title ?? e.name}</span>
                        {e.project ? <span className="text-[10.5px] text-content-subtle">· {e.project}</span> : null}
                      </span>
                      {e.description ? <span className="mt-0.5 block truncate text-[11.5px] text-content-muted">{e.description}</span> : null}
                    </span>
                  </label>
                </li>
              )
            })}
        </ul>
      </div>
    </Modal>
  )
}
