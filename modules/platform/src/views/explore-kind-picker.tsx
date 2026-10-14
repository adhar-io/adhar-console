import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Kbd, Spinner, useOverlayDismiss } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { DiscoveredResource } from '@adhar/api-clients/k8s'
import { groupKinds, groupLabel, isBuiltinGroup, kindKey, searchKinds } from '../data/explore.ts'
import { useKindCount } from '../data/explore-hooks.ts'

/**
 * The Explore page's resource-type finder. One component, two homes: a sticky
 * rail beside the table on wide screens, and a bottom sheet on phones (so the
 * table keeps the full width of a small screen).
 *
 * Empty query → Pinned, Recent, then every API group (built-ins open,
 * extensions folded). Typing ranks kinds by short name / name / prefix / group
 * (`svc`, `deploy`, `argo app`) into one flat list. ↑ ↓ move, Enter opens,
 * Esc clears; `/` anywhere on the page focuses the search.
 */

export interface KindPickerHandle {
  focus(): void
}

interface Props {
  kinds: DiscoveredResource[]
  loading: boolean
  error?: string
  selectedKey: string | null
  pins: string[]
  recents: string[]
  namespace?: string
  onSelect(k: DiscoveredResource): void
  onTogglePin(key: string): void
  onRetry?(): void
  /** `sheet` drops the sticky-rail sizing and autofocuses on open. */
  variant?: 'rail' | 'sheet'
}

type Entry = { k: DiscoveredResource; section: string }

export const KindPicker = forwardRef<KindPickerHandle, Props>(function KindPicker(
  { kinds, loading, error, selectedKey, pins, recents, namespace, onSelect, onTogglePin, onRetry, variant = 'rail' },
  ref,
) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), [])

  const byKey = useMemo(() => new Map(kinds.map((k) => [kindKey(k), k])), [kinds])
  const groups = useMemo(() => groupKinds(kinds), [kinds])
  const searching = query.trim().length > 0
  const results = useMemo(() => (searching ? searchKinds(kinds, query) : []), [kinds, query, searching])

  const pinned = useMemo(() => pins.map((p) => byKey.get(p)).filter(Boolean) as DiscoveredResource[], [pins, byKey])
  const recent = useMemo(
    () => recents.filter((r) => !pins.includes(r)).map((r) => byKey.get(r)).filter(Boolean) as DiscoveredResource[],
    [recents, pins, byKey],
  )

  const isFolded = (label: string, builtin: boolean) => folded[label] ?? !builtin

  // The flat, keyboard-navigable order of what is on screen right now.
  const entries: Entry[] = useMemo(() => {
    if (searching) return results.map((k) => ({ k, section: 'results' }))
    const out: Entry[] = [
      ...pinned.map((k) => ({ k, section: 'pinned' })),
      ...recent.map((k) => ({ k, section: 'recent' })),
    ]
    for (const g of groups) if (!(folded[g.label] ?? !g.builtin)) out.push(...g.items.map((k) => ({ k, section: g.label })))
    return out
  }, [searching, results, pinned, recent, groups, folded])

  useEffect(() => setActive(0), [query])

  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-entry="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    if (variant === 'sheet') inputRef.current?.focus({ preventScroll: true })
  }, [variant])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(entries.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      const hit = entries[active]
      if (hit) {
        e.preventDefault()
        onSelect(hit.k)
        setQuery('')
        if (variant === 'rail') inputRef.current?.blur()
      }
    } else if (e.key === 'Escape' && variant === 'rail') {
      e.stopPropagation()
      if (query) setQuery('')
      else inputRef.current?.blur()
    }
  }

  let n = -1
  const row = (k: DiscoveredResource, opts: { showGroup?: boolean; count?: boolean } = {}) => {
    n += 1
    const idx = n
    const key = kindKey(k)
    return (
      <KindRow
        key={`${key}:${idx}`}
        k={k}
        index={idx}
        selected={key === selectedKey}
        highlighted={(searching || focused) && idx === active}
        pinned={pins.includes(key)}
        showGroup={opts.showGroup}
        count={opts.count}
        namespace={namespace}
        onSelect={() => {
          onSelect(k)
          setQuery('')
        }}
        onHover={() => setActive(idx)}
        onTogglePin={() => onTogglePin(key)}
      />
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col', variant === 'rail' ? 'h-full' : 'flex-1')}>
      <div className="relative shrink-0">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">
          <SearchGlyph />
        </span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Find a resource type…"
          aria-label="Find a resource type"
          aria-controls="explore-kind-list"
          aria-activedescendant={entries[active] ? `explore-kind-${active}` : undefined}
          role="combobox"
          aria-expanded="true"
          autoComplete="off"
          spellCheck={false}
          className={cn(
            'h-9 w-full rounded-lg border border-edge-default bg-surface-raised pl-8 pr-9 text-sm text-content placeholder:text-content-subtle',
            'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20',
          )}
        />
        {query ? null : (
          <Kbd size="xs" className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 sm:inline-flex">
            /
          </Kbd>
        )}
      </div>

      <div
        ref={listRef}
        id="explore-kind-list"
        role="listbox"
        aria-label="Resource types"
        className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2"
      >
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-6 text-xs text-content-muted">
            <Spinner size={14} /> Discovering API resources…
          </div>
        ) : error ? (
          <div className="space-y-2 px-2 py-6 text-xs">
            <div className="font-medium text-rose-700 dark:text-rose-300">Discovery failed</div>
            <div className="break-words text-content-muted">{error}</div>
            {onRetry ? (
              <button type="button" onClick={onRetry} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                Try again
              </button>
            ) : null}
          </div>
        ) : searching ? (
          results.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-content-subtle">
              No resource type matches <span className="font-mono text-content-muted">{query}</span>
            </div>
          ) : (
            <Section title={`${results.length} match${results.length === 1 ? '' : 'es'}`}>
              {results.map((k) => row(k, { showGroup: true }))}
            </Section>
          )
        ) : (
          <>
            {pinned.length ? (
              <Section title="Pinned">{pinned.map((k) => row(k, { showGroup: !isBuiltinGroup(k.group), count: true }))}</Section>
            ) : null}
            {recent.length ? (
              <Section title="Recent">{recent.map((k) => row(k, { showGroup: !isBuiltinGroup(k.group) }))}</Section>
            ) : null}
            {groups.map((g) => {
              const closed = isFolded(g.label, g.builtin)
              return (
                <div key={g.label} className="mt-1">
                  <button
                    type="button"
                    onClick={() => setFolded((f) => ({ ...f, [g.label]: !closed }))}
                    aria-expanded={!closed}
                    title={g.groups.map((x) => x || 'core').join(', ')}
                    className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-content-subtle hover:bg-surface-sunken hover:text-content-muted"
                  >
                    <Chevron open={!closed} />
                    <span className="min-w-0 flex-1 truncate">{g.label}</span>
                    <span className="font-mono text-[10px] font-normal tabular-nums">{g.items.length}</span>
                  </button>
                  {closed ? null : <div className="space-y-px">{g.items.map((k) => row(k))}</div>}
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
})

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{title}</div>
      <div className="space-y-px">{children}</div>
    </div>
  )
}

function KindRow({
  k,
  index,
  selected,
  highlighted,
  pinned,
  showGroup,
  count,
  namespace,
  onSelect,
  onHover,
  onTogglePin,
}: {
  k: DiscoveredResource
  index: number
  selected: boolean
  highlighted: boolean
  pinned: boolean
  showGroup?: boolean
  count?: boolean
  namespace?: string
  onSelect(): void
  onHover(): void
  onTogglePin(): void
}) {
  const short = k.shortNames?.[0]
  return (
    <div
      id={`explore-kind-${index}`}
      data-entry={index}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      className={cn(
        'group/row relative flex items-center rounded-md transition-colors',
        selected
          ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/25'
          : highlighted
            ? 'bg-surface-sunken text-content'
            : 'text-content-muted hover:bg-surface-sunken hover:text-content',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={`${k.group || 'core'}/${k.version} · ${k.name}${k.namespaced ? '' : ' · cluster-scoped'}`}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 pr-1 text-left text-sm pointer-coarse:py-2.5"
      >
        <span className={cn('min-w-0 truncate', selected && 'font-medium')}>{k.kind}</span>
        {short ? <span className="shrink-0 font-mono text-[10px] text-content-subtle">{short}</span> : null}
        {showGroup ? (
          <span className="ml-auto min-w-0 truncate pl-2 text-[10px] text-content-subtle">{groupLabel(k.group)}</span>
        ) : null}
        {count ? <KindCount k={k} namespace={namespace} className={showGroup ? 'ml-2' : 'ml-auto'} /> : null}
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-label={pinned ? `Unpin ${k.kind}` : `Pin ${k.kind}`}
        aria-pressed={pinned}
        className={cn(
          'mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-subtle transition hover:text-amber-500',
          pinned ? 'text-amber-500' : 'opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-60',
        )}
      >
        <StarGlyph filled={pinned} />
      </button>
    </div>
  )
}

/** Live-ish object count for a pinned kind (a `limit=1` list, cached a minute). */
function KindCount({ k, namespace, className }: { k: DiscoveredResource; namespace?: string; className?: string }) {
  const count = useKindCount({ group: k.group, version: k.version, resource: k.name, namespaced: k.namespaced }, namespace)
  if (count.data === undefined) return null
  return <span className={cn('shrink-0 font-mono text-[10px] tabular-nums text-content-subtle', className)}>{count.data}</span>
}

/* ─── phone sheet ───────────────────────────────────────────────────────── */

export function KindPickerSheet({ open, onClose, ...props }: Props & { open: boolean; onClose(): void }) {
  useOverlayDismiss(open, onClose)
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Choose a resource type">
      <div className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div className="relative flex h-[85dvh] w-full flex-col rounded-t-2xl border border-edge-default bg-surface-raised px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 shadow-2xl sm:h-[70vh] sm:max-w-lg sm:rounded-2xl">
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-edge-strong sm:hidden" aria-hidden />
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-content">Resource types</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <CloseGlyph />
          </button>
        </div>
        <KindPicker
          {...props}
          variant="sheet"
          onSelect={(k) => {
            props.onSelect(k)
            onClose()
          }}
        />
      </div>
    </div>,
    document.body,
  )
}

/* ─── glyphs ────────────────────────────────────────────────────────────── */

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn('shrink-0 transition-transform', open && 'rotate-90')}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export function StarGlyph({ filled, size = 13 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
    </svg>
  )
}

function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
