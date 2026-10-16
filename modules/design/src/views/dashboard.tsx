import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, EmptyState, SearchInput, useClickOutside } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { KIND, type Listed, TOKEN_SET_ID, useCollection, useDoc } from '../data/store.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Adr, ApiSpec, Diagram, Journey, Persona, TokenSet, WhiteboardBoard, Wireframe } from '../data/types.ts'
import { type DesignParams, type DesignSection, useGoDesign } from '../data/nav.ts'
import { countTokens, mergeDefaults } from '../data/tokens-lib.ts'
import { coverageHints, shortPersonaName } from '../data/ux-lib.ts'
import { IconArrowRight, IconChevron, IconInfo, IconPlus, IconWarning } from '../components/ux-kit.tsx'

type Kind = 'adr' | 'diagram' | 'board' | 'persona' | 'journey' | 'wireframe' | 'spec'

const KIND_META: Record<Kind, { label: string; section: DesignSection; param: keyof DesignParams; tone: string; dot: string }> = {
  adr: { label: 'ADR', section: 'adrs', param: 'adr', tone: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200', dot: 'bg-brand-500' },
  diagram: { label: 'Diagram', section: 'diagrams', param: 'diagram', tone: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200', dot: 'bg-amber-500' },
  board: { label: 'Whiteboard', section: 'whiteboard', param: 'board', tone: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-200', dot: 'bg-sky-500' },
  persona: { label: 'Persona', section: 'personas', param: 'persona', tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200', dot: 'bg-emerald-500' },
  journey: { label: 'Journey', section: 'journeys', param: 'journey', tone: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200', dot: 'bg-violet-500' },
  wireframe: { label: 'Wireframe', section: 'wireframes', param: 'doc', tone: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200', dot: 'bg-rose-500' },
  spec: { label: 'API spec', section: 'api-schemas', param: 'spec', tone: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-200', dot: 'bg-teal-500' },
}

interface Row {
  key: string
  kind: Kind
  id: string
  title: string
  subtitle: string
  ts?: string
  hay: string
}

const ADR_STATUS: Array<{ status: Adr['status']; label: string; color: string }> = [
  { status: 'accepted', label: 'Accepted', color: 'var(--color-emerald-500)' },
  { status: 'proposed', label: 'Proposed', color: 'var(--color-brand-500)' },
  { status: 'superseded', label: 'Superseded', color: 'var(--color-slate-400)' },
  { status: 'deprecated', label: 'Deprecated', color: 'var(--color-amber-500)' },
  { status: 'rejected', label: 'Rejected', color: 'var(--color-rose-500)' },
]

/**
 * Design dashboard — every design artifact in the workspace at a glance, all
 * from the tenant document store: per-kind counts, one search across every
 * artifact, recently edited items (each opening the exact item), ADRs awaiting
 * a decision, and coverage gaps worth closing. No invented metrics: an empty
 * workspace shows zeros and guidance, a failing store shows an error.
 */
export function Dashboard() {
  const adrsQ = useCollection<Adr>(KIND.adr)
  const diagramsQ = useCollection<Diagram>(KIND.diagram)
  const boardsQ = useCollection<WhiteboardBoard>(KIND.board)
  const personasQ = useCollection<Persona>(KIND.persona)
  const journeysQ = useCollection<Journey>(KIND.journey)
  const wireframesQ = useCollection<Wireframe>(KIND.wireframe)
  const specsQ = useCollection<ApiSpec>(KIND.apiSpec)
  const tokensQ = useDoc<TokenSet>(KIND.tokenSet, TOKEN_SET_ID)
  const go = useGoDesign()

  const [q, setQ] = useState('')
  const [kindFilter, setKindFilter] = useState<Kind | null>(null)

  const all = [adrsQ, diagramsQ, boardsQ, personasQ, journeysQ, wireframesQ, specsQ]
  const anyError = all.find((x) => x.error)?.error ?? null
  const anyLoading = all.some((x) => x.isLoading)

  const adrs = adrsQ.items
  const personas = personasQ.items
  const journeys = journeysQ.items

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const push = (kind: Kind, id: string, title: string, subtitle: string, ts: string | undefined, extra = '') =>
      out.push({ key: `${kind}:${id}`, kind, id, title: title || 'Untitled', subtitle, ts, hay: `${title} ${subtitle} ${extra}`.toLowerCase() })
    for (const a of adrsQ.items) push('adr', a.id, a.title, `ADR-${String(a.number).padStart(4, '0')} · ${a.status}`, a._updatedAt ?? a.updated_at, [...(a.tags ?? []), ...(a.authors ?? [])].join(' '))
    for (const d of diagramsQ.items) push('diagram', d.id, d.title, d.type, d._updatedAt ?? d.updated_at, (d.tags ?? []).join(' '))
    for (const b of boardsQ.items) push('board', b.id, b.name, `${b.notes?.length ?? 0} notes`, b._updatedAt ?? b.updated_at)
    for (const p of personasQ.items) push('persona', p.id, p.name, p.role, p._updatedAt, (p.tags ?? []).join(' '))
    for (const j of journeysQ.items) {
      const p = personasQ.items.find((x) => x.id === j.persona)
      push('journey', j.id, j.name, `${j.stages.length} stages${p ? ` · ${shortPersonaName(p.name)}` : ''}`, j._updatedAt, j.summary)
    }
    for (const w of wireframesQ.items) push('wireframe', w.id, w.name, w.flow, w._updatedAt, w.notes ?? '')
    for (const s of specsQ.items) push('spec', s.id, s.name, `v${s.version}`, s._updatedAt ?? s.updated_at, s.description)
    return out.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''))
  }, [adrsQ.items, diagramsQ.items, boardsQ.items, personasQ.items, journeysQ.items, wireframesQ.items, specsQ.items])

  const hints = useMemo(
    () => coverageHints({ personas, journeys, adrs, tokens: tokensQ.data ? mergeDefaults(tokensQ.data) : null }),
    [personas, journeys, adrs, tokensQ.data],
  )

  if (anyError) return <ErrorBlock error={anyError} onRetry={() => all.forEach((x) => x.refetch())} />
  if (anyLoading) return <LoadingBlock label="Loading design workspace…" />

  const searching = q.trim().length > 0
  const needle = q.trim().toLowerCase()
  const listed = rows
    .filter((r) => (!kindFilter || r.kind === kindFilter) && (!searching || needle.split(/\s+/).every((w) => r.hay.includes(w))))
    .slice(0, searching || kindFilter ? 50 : 12)

  const proposed = adrs
    .filter((a) => a.status === 'proposed')
    .sort((a, b) => (a._updatedAt ?? a.updated_at).localeCompare(b._updatedAt ?? b.updated_at))
  const notes = boardsQ.items.reduce((n, b) => n + (b.notes?.length ?? 0), 0)
  const flows = new Set(wireframesQ.items.map((w) => w.flow)).size
  const stages = journeys.reduce((n, j) => n + j.stages.length, 0)
  const tokenCount = countTokens(mergeDefaults(tokensQ.data))
  const total = rows.length

  const open = (r: Row) => go(KIND_META[r.kind].section, { [KIND_META[r.kind].param]: r.id })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search every design artifact…" className="w-full sm:w-96" />
        <div className="ml-auto">
          <CreateMenu onPick={(section) => go(section, { new: '1' })} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="ADRs" value={adrs.length} hint={adrs.length ? `${adrs.filter((a) => a.status === 'accepted').length} accepted · ${proposed.length} proposed` : 'Record decisions'} dot={KIND_META.adr.dot} onClick={() => go('adrs')} />
        <Tile label="Diagrams" value={diagramsQ.items.length} hint={diagramsQ.items.length ? `${new Set(diagramsQ.items.map((d) => d.type)).size} diagram types` : 'Draw the system'} dot={KIND_META.diagram.dot} onClick={() => go('diagrams')} />
        <Tile label="Whiteboards" value={boardsQ.items.length} hint={`${notes} sticky notes`} dot={KIND_META.board.dot} onClick={() => go('whiteboard')} />
        <Tile label="API specs" value={specsQ.items.length} hint={specsQ.items.length ? 'OpenAPI documents' : 'Design an API'} dot={KIND_META.spec.dot} onClick={() => go('api-schemas')} />
        <Tile label="Personas" value={personas.length} hint={personas.length ? `${personas.filter((p) => journeys.some((j) => j.persona === p.id)).length} with a journey` : 'Who you build for'} dot={KIND_META.persona.dot} onClick={() => go('personas')} />
        <Tile label="Journey maps" value={journeys.length} hint={`${stages} stages mapped`} dot={KIND_META.journey.dot} onClick={() => go('journeys')} />
        <Tile label="Wireframes" value={wireframesQ.items.length} hint={`${flows} flow${flows === 1 ? '' : 's'}`} dot={KIND_META.wireframe.dot} onClick={() => go('wireframes')} />
        <Tile label="Design tokens" value={tokenCount} hint={tokensQ.data ? 'Workspace token set' : 'Using defaults'} dot="bg-content-subtle" onClick={() => go('tokens')} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-content">{searching ? `Results for “${q.trim()}”` : 'Recently edited'}</h2>
            <span className="text-xs text-content-subtle">{searching || kindFilter ? `${listed.length} of ${total}` : `${total} artifacts`}</span>
            <div className="ml-auto flex flex-wrap gap-1">
              <FilterChip on={!kindFilter} onClick={() => setKindFilter(null)}>All</FilterChip>
              {(Object.keys(KIND_META) as Kind[]).map((k) => (
                <FilterChip key={k} on={kindFilter === k} onClick={() => setKindFilter(kindFilter === k ? null : k)}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', KIND_META[k].dot)} />
                  {KIND_META[k].label}
                </FilterChip>
              ))}
            </div>
          </div>
          {total === 0 ? (
            <EmptyState
              title="Your design workspace is empty"
              description="Start with who you're building for, then map their journey — or record the first architecture decision."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="sm" variant="primary" onClick={() => go('personas', { new: '1' })} leading={<IconPlus size={12} />}>New persona</Button>
                  <Button size="sm" onClick={() => go('adrs')}>Open ADRs</Button>
                </div>
              }
            />
          ) : listed.length === 0 ? (
            <EmptyState compact title="Nothing matches" description="Try another word or clear the type filter." />
          ) : (
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              {listed.map((r) => (
                <li key={r.key}>
                  <button type="button" onClick={() => open(r)} className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-sunken">
                    <span className={cn('w-20 shrink-0 rounded-md px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide', KIND_META[r.kind].tone)}>
                      {KIND_META[r.kind].label}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-content">{r.title}</span>
                      <span className="block truncate text-[11px] text-content-subtle">{r.subtitle}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-content-subtle" title={r.ts ? new Date(r.ts).toLocaleString() : undefined}>
                      {r.ts ? formatRelative(r.ts) : '—'}
                    </span>
                    <IconArrowRight size={12} className="shrink-0 text-content-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-6">
          <section>
            <PanelTitle title="Awaiting decision" count={proposed.length} action={adrs.length ? { label: 'All ADRs', onClick: () => go('adrs') } : undefined} />
            {proposed.length === 0 ? (
              <p className="rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">
                {adrs.length ? 'No proposed ADRs — every decision is settled.' : 'No ADRs yet. Architecture decisions recorded here show up while they await a decision.'}
              </p>
            ) : (
              <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
                {proposed.slice(0, 6).map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => go('adrs', { adr: a.id })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-sunken">
                      <span className="font-mono text-[11px] text-content-subtle">ADR-{String(a.number).padStart(4, '0')}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-content">{a.title}</span>
                      <span className="shrink-0 text-[11px] text-content-subtle">{formatRelative(a._updatedAt ?? a.updated_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {adrs.length ? (
            <section>
              <PanelTitle title="Decision status" />
              <DecisionBar adrs={adrs} />
            </section>
          ) : null}

          <section>
            <PanelTitle title="Coverage" count={hints.length} />
            {hints.length === 0 ? (
              <p className="rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">
                {personas.length || journeys.length
                  ? 'No gaps found: every journey has a persona, every persona a journey, and body text passes WCAG AA.'
                  : 'Coverage checks appear once you add personas and journey maps.'}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {hints.slice(0, 8).map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => go(h.section, h.params)}
                      className="flex w-full items-start gap-2.5 rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-left hover:border-edge-strong"
                    >
                      <span className={cn('mt-0.5 shrink-0', h.tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400')}>
                        {h.tone === 'warning' ? <IconWarning size={13} /> : <IconInfo size={13} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-content">{h.title}</span>
                        <span className="block truncate text-[11px] text-content-muted">{h.detail}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {hints.length > 8 ? <li className="px-1 text-[11px] text-content-subtle">+{hints.length - 8} more</li> : null}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function Tile({ label, value, hint, dot, onClick }: { label: string; value: number; hint: string; dot: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group rounded-xl border border-edge-default bg-surface-raised p-4 text-left shadow-sm transition-[border-color,box-shadow] hover:border-edge-strong hover:shadow-md"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-content-muted">
        <span className={cn('h-2 w-2 rounded-full', dot)} />
        {label}
        <IconArrowRight size={11} className="ml-auto text-content-subtle opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-content">{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-content-subtle">{hint}</div>
    </button>
  )
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors',
        on ? 'bg-brand-50 text-brand-700 ring-brand-300 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-400/40' : 'text-content-muted ring-edge-default hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function PanelTitle({ title, count, action }: { title: string; count?: number; action?: { label: string; onClick(): void } }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="text-sm font-semibold text-content">{title}</h2>
      {count !== undefined ? <span className="text-xs tabular-nums text-content-subtle">{count}</span> : null}
      {action ? (
        <button type="button" onClick={action.onClick} className="ml-auto text-xs text-brand-700 hover:underline dark:text-brand-300">
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

function DecisionBar({ adrs }: { adrs: Listed<Adr>[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const total = adrs.length
  const buckets = ADR_STATUS.map((b) => ({ ...b, n: adrs.filter((a) => a.status === b.status).length }))
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4">
      <div className="relative">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          {buckets.map((b) =>
            b.n ? (
              <div
                key={b.status}
                onMouseEnter={() => setHover(b.status)}
                onMouseLeave={() => setHover(null)}
                className={cn('h-full transition-opacity', hover && hover !== b.status && 'opacity-40')}
                style={{ width: `${(b.n / total) * 100}%`, background: b.color }}
              />
            ) : null
          )}
        </div>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        {buckets.map((b) => (
          <li
            key={b.status}
            onMouseEnter={() => setHover(b.status)}
            onMouseLeave={() => setHover(null)}
            className={cn('flex items-center gap-1.5 text-[11px] text-content-muted', hover === b.status && 'text-content')}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: b.color }} />
            {b.label}
            <span className="ml-auto tabular-nums text-content">{b.n}</span>
            <span className="w-8 text-right tabular-nums text-content-subtle">{Math.round((b.n / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const CREATE: Array<{ label: string; section: DesignSection }> = [
  { label: 'Persona', section: 'personas' },
  { label: 'Journey map', section: 'journeys' },
  { label: 'ADR', section: 'adrs' },
  { label: 'Diagram', section: 'diagrams' },
  { label: 'Whiteboard', section: 'whiteboard' },
  { label: 'Wireframe', section: 'wireframes' },
  { label: 'API spec', section: 'api-schemas' },
]

function CreateMenu({ onPick }: { onPick(s: DesignSection): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)
  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="primary" onClick={() => setOpen((o) => !o)} leading={<IconPlus size={12} />} trailing={<IconChevron dir="down" size={11} />} aria-expanded={open}>
        New
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-xl" role="menu">
          {CREATE.map((c) => (
            <button
              key={c.section}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onPick(c.section)
              }}
              className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-content hover:bg-surface-sunken"
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
