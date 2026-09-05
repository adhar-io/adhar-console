import { useMemo, useState } from 'react'
import { Card, CardBody, CardHeader, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { KIND, type Listed, useCollection } from '../data/store.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type {
  Adr,
  ApiSpec,
  Diagram,
  Journey,
  Persona,
  WhiteboardBoard,
  Wireframe,
} from '../data/types.ts'

/**
 * Design Catalog — a real, live index of every design artifact in the
 * workspace, aggregated from the Postgres-backed document store. It is NOT a
 * static embed: counts, recent activity, and search all reflect the tenant's
 * actual ADRs, diagrams, personas, journeys, boards, wireframes, and API specs.
 *
 * A unified artifact model (`Item`) is derived from each collection so the
 * catalog can rank recency across types and run one global search box over the
 * whole design surface. Every row deep-links back to the owning view via the
 * shell's `?<section>` query navigation.
 */

type Tone = 'brand' | 'amber' | 'sky' | 'emerald' | 'violet' | 'rose'

interface Group {
  type: string
  typeLabel: string
  section: string
  tone: Tone
  icon: React.ReactNode
  items: Item[]
}

interface Item {
  key: string
  type: string
  typeLabel: string
  section: string
  tone: Tone
  title: string
  subtitle: string
  /** Free-text haystack for the global search box. */
  haystack: string
  /** Real envelope timestamp (ISO) — undefined only for legacy rows. */
  ts?: string
  by?: string | null
}

const TONE_TILE: Record<Tone, string> = {
  brand: 'from-brand-500/10 to-surface-raised text-brand-700',
  amber: 'from-amber-500/10 to-surface-raised text-amber-700',
  sky: 'from-sky-500/10 to-surface-raised text-sky-700',
  emerald: 'from-emerald-500/10 to-surface-raised text-emerald-700',
  violet: 'from-violet-500/10 to-surface-raised text-violet-700',
  rose: 'from-rose-500/10 to-surface-raised text-rose-700',
}

const TONE_BADGE: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-700',
  amber: 'bg-amber-50 text-amber-700',
  sky: 'bg-sky-50 text-sky-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  violet: 'bg-violet-50 text-violet-700',
  rose: 'bg-rose-50 text-rose-700',
}

export function Catalog() {
  const adrs = useCollection<Adr>(KIND.adr)
  const diagrams = useCollection<Diagram>(KIND.diagram)
  const personas = useCollection<Persona>(KIND.persona)
  const journeys = useCollection<Journey>(KIND.journey)
  const boards = useCollection<WhiteboardBoard>(KIND.board)
  const wireframes = useCollection<Wireframe>(KIND.wireframe)
  const specs = useCollection<ApiSpec>(KIND.apiSpec)

  const [search, setSearch] = useState('')

  const groups = useMemo<Group[]>(
    () => [
      {
        type: 'adr',
        typeLabel: 'ADRs',
        section: 'adrs',
        tone: 'brand' as Tone,
        icon: <IconBook />,
        items: adrs.items.map((a): Item => toItem(a, {
          type: 'adr',
          typeLabel: 'ADR',
          section: 'adrs',
          tone: 'brand',
          title: a.title,
          subtitle: `ADR-${String(a.number).padStart(4, '0')} · ${a.status}`,
          haystack: [a.title, ...a.tags, ...a.authors, a.status].join(' '),
          fallbackTs: a.updated_at,
        })),
      },
      {
        type: 'diagram',
        typeLabel: 'Diagrams',
        section: 'diagrams',
        tone: 'amber' as Tone,
        icon: <IconDiagram />,
        items: diagrams.items.map((d): Item => toItem(d, {
          type: 'diagram',
          typeLabel: 'Diagram',
          section: 'diagrams',
          tone: 'amber',
          title: d.title,
          subtitle: d.type,
          haystack: [d.title, d.type, ...d.tags].join(' '),
          fallbackTs: d.updated_at,
        })),
      },
      {
        type: 'persona',
        typeLabel: 'Personas',
        section: 'personas',
        tone: 'emerald' as Tone,
        icon: <IconUser />,
        items: personas.items.map((p): Item => toItem(p, {
          type: 'persona',
          typeLabel: 'Persona',
          section: 'personas',
          tone: 'emerald',
          title: p.name,
          subtitle: p.role,
          haystack: [p.name, p.role, p.bio, ...p.tech].join(' '),
        })),
      },
      {
        type: 'journey',
        typeLabel: 'Journeys',
        section: 'journeys',
        tone: 'violet' as Tone,
        icon: <IconRoute />,
        items: journeys.items.map((j): Item => toItem(j, {
          type: 'journey',
          typeLabel: 'Journey',
          section: 'journeys',
          tone: 'violet',
          title: j.name,
          subtitle: `${j.stages.length} stage${j.stages.length === 1 ? '' : 's'}`,
          haystack: [j.name, j.summary].join(' '),
        })),
      },
      {
        type: 'board',
        typeLabel: 'Whiteboards',
        section: 'whiteboard',
        tone: 'sky' as Tone,
        icon: <IconNote />,
        items: boards.items.map((b): Item => toItem(b, {
          type: 'board',
          typeLabel: 'Whiteboard',
          section: 'whiteboard',
          tone: 'sky',
          title: b.name,
          subtitle: `${b.notes.length} note${b.notes.length === 1 ? '' : 's'}`,
          haystack: [b.name, ...b.notes.map((n) => n.text)].join(' '),
          fallbackTs: b.updated_at,
        })),
      },
      {
        type: 'wireframe',
        typeLabel: 'Wireframes',
        section: 'wireframes',
        tone: 'rose' as Tone,
        icon: <IconFrame />,
        items: wireframes.items.map((w): Item => toItem(w, {
          type: 'wireframe',
          typeLabel: 'Wireframe',
          section: 'wireframes',
          tone: 'rose',
          title: w.name,
          subtitle: `${w.flow} · step ${w.order}`,
          haystack: [w.name, w.flow, w.notes ?? ''].join(' '),
        })),
      },
      {
        type: 'apiSpec',
        typeLabel: 'API specs',
        section: 'api-schemas',
        tone: 'brand' as Tone,
        icon: <IconApi />,
        items: specs.items.map((s): Item => toItem(s, {
          type: 'apiSpec',
          typeLabel: 'API spec',
          section: 'api-schemas',
          tone: 'brand',
          title: s.name,
          subtitle: `v${s.version}`,
          haystack: [s.name, s.description, s.version].join(' '),
          fallbackTs: s.updated_at,
        })),
      },
    ],
    [adrs.items, diagrams.items, personas.items, journeys.items, boards.items, wireframes.items, specs.items],
  )

  const allItems = useMemo<Item[]>(() => groups.flatMap((g: Group) => g.items), [groups])
  const total = allItems.length

  const recent = useMemo<Item[]>(
    () =>
      allItems
        .filter((i: Item) => i.ts)
        .sort((a: Item, b: Item) => new Date(b.ts!).getTime() - new Date(a.ts!).getTime())
        .slice(0, 10),
    [allItems],
  )

  const results = useMemo<Item[]>(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return allItems
      .filter((i: Item) => i.haystack.toLowerCase().includes(q) || i.typeLabel.toLowerCase().includes(q))
      .sort((a: Item, b: Item) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())
      .slice(0, 40)
  }, [allItems, search])

  const anyError =
    adrs.error ||
    diagrams.error ||
    personas.error ||
    journeys.error ||
    boards.error ||
    wireframes.error ||
    specs.error
  const anyLoading =
    adrs.isLoading ||
    diagrams.isLoading ||
    personas.isLoading ||
    journeys.isLoading ||
    boards.isLoading ||
    wireframes.isLoading ||
    specs.isLoading

  if (anyError) return <ErrorBlock error={anyError} onRetry={adrs.refetch} />
  if (anyLoading) return <LoadingBlock label="Indexing design artifacts…" />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-[11px] text-content-muted">
          {total} artifact{total === 1 ? '' : 's'} across {groups.filter((g: Group) => g.items.length).length}{' '}
          type{groups.filter((g: Group) => g.items.length).length === 1 ? '' : 's'}
        </div>
        <div className="ml-auto">
          <SearchInput value={search} onChange={setSearch} />
        </div>
      </div>

      {search.trim() ? (
        <SearchResults query={search} results={results} />
      ) : total === 0 ? (
        <EmptyState
          title="No design artifacts yet"
          description="The catalog indexes everything you create in Design. Start in any area — ADRs, diagrams, personas, journeys, whiteboards, wireframes, or API specs — and it will appear here."
          action={
            <a
              href="?dashboard"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              Go to dashboard
            </a>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {groups.map((g: Group) => (
              <TypeTile
                key={g.type}
                label={g.typeLabel}
                count={g.items.length}
                section={g.section}
                tone={g.tone}
                icon={g.icon}
              />
            ))}
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-content">Recent activity</div>
                  <div className="text-[11px] text-content-subtle">
                    Most recently created or edited artifacts across every type
                  </div>
                </div>
                <StatusBadge kind="info">{recent.length}</StatusBadge>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {recent.length === 0 ? (
                <div className="px-5 py-6 text-center text-xs text-content-subtle">
                  No timestamped activity yet.
                </div>
              ) : (
                <ul className="divide-y divide-edge-subtle">
                  {recent.map((i: Item) => (
                    <li key={i.key}>
                      <a
                        href={`?${i.section}`}
                        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40"
                      >
                        <span
                          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${TONE_BADGE[i.tone]}`}
                        >
                          {i.typeLabel}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-content">
                          {i.title}
                          <span className="ml-2 text-[11px] text-content-subtle">{i.subtitle}</span>
                        </span>
                        {i.by ? (
                          <span className="shrink-0 text-[11px] text-content-subtle">{i.by}</span>
                        ) : null}
                        <span className="shrink-0 text-[11px] text-content-subtle">
                          {i.ts ? formatRelative(i.ts) : '—'}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}

/** Build an Item, preferring the real envelope timestamp over a domain field. */
function toItem<T>(
  entity: Listed<T>,
  cfg: {
    type: string
    typeLabel: string
    section: string
    tone: Tone
    title: string
    subtitle: string
    haystack: string
    fallbackTs?: string
  },
): Item {
  return {
    key: `${cfg.type}-${(entity as unknown as { id: string }).id}`,
    type: cfg.type,
    typeLabel: cfg.typeLabel,
    section: cfg.section,
    tone: cfg.tone,
    title: cfg.title || '(untitled)',
    subtitle: cfg.subtitle,
    haystack: cfg.haystack,
    ts: entity._updatedAt ?? cfg.fallbackTs,
    by: entity._updatedBy ?? undefined,
  }
}

function TypeTile({
  label,
  count,
  section,
  tone,
  icon,
}: {
  label: string
  count: number
  section: string
  tone: Tone
  icon: React.ReactNode
}) {
  return (
    <a href={`?${section}`} className="group block">
      <Card
        className={`relative overflow-hidden bg-linear-to-br ${TONE_TILE[tone]} ring-1 ring-inset ring-edge-subtle transition-shadow group-hover:shadow-md`}
      >
        <CardBody className="space-y-1 p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-raised/80 shadow-sm">
              {icon}
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
              {label}
            </span>
          </div>
          <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
            {count}
          </div>
          <div className="inline-flex items-center gap-1 text-[11px] font-medium text-content-muted group-hover:text-brand-700">
            Open <IconArrow />
          </div>
        </CardBody>
      </Card>
    </a>
  )
}

function SearchResults({ query, results }: { query: string; results: Item[] }) {
  if (results.length === 0) {
    return (
      <EmptyState
        compact
        title="No matches"
        description={`Nothing in the catalog matches "${query.trim()}". Try a different term.`}
      />
    )
  }
  return (
    <Card>
      <CardHeader>
        <div className="text-sm font-semibold text-content">
          {results.length} match{results.length === 1 ? '' : 'es'}
        </div>
        <div className="text-[11px] text-content-subtle">Across every design artifact type</div>
      </CardHeader>
      <CardBody className="p-0">
        <ul className="divide-y divide-edge-subtle">
          {results.map((i: Item) => (
            <li key={i.key}>
              <a
                href={`?${i.section}`}
                className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40"
              >
                <span
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${TONE_BADGE[i.tone]}`}
                >
                  {i.typeLabel}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-content">
                  {i.title}
                  <span className="ml-2 text-[11px] text-content-subtle">{i.subtitle}</span>
                </span>
                <span className="shrink-0 text-[11px] text-content-subtle">
                  {i.ts ? formatRelative(i.ts) : '—'}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function SearchInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
        <IconSearch />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search all artifacts…"
        className="block h-9 w-56 rounded-lg border border-edge-default bg-surface-raised pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-72"
      />
    </div>
  )
}

function IconBook() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  )
}
function IconDiagram() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
function IconNote() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}
function IconUser() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}
function IconRoute() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="19" r="3" />
      <circle cx="18" cy="5" r="3" />
      <path d="M6 16V8a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v8" />
    </svg>
  )
}
function IconFrame() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 9H2" />
      <path d="M22 15H2" />
      <path d="M9 2v20" />
      <path d="M15 2v20" />
    </svg>
  )
}
function IconApi() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </svg>
  )
}
function IconArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
