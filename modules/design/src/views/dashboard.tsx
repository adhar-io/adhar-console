import {
  Card,
  CardBody,
  CardHeader,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { KIND, useCollection } from '../data/store.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Adr, Diagram, Journey, Persona, WhiteboardBoard, Wireframe } from '../data/types.ts'

/**
 * Workspace-level Design dashboard. Aggregates the design collections (ADRs,
 * diagrams, personas, journeys, whiteboard notes, wireframes) into hero
 * counters + a recent-activity feed. Every number comes from the real,
 * Postgres-backed document store — an unavailable store surfaces as an error,
 * never fake data.
 */
const RECENT_TONE: Record<'brand' | 'amber' | 'violet' | 'emerald' | 'rose', string> = {
  brand: 'bg-brand-50 text-brand-700',
  amber: 'bg-amber-50 text-amber-700',
  violet: 'bg-violet-50 text-violet-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  rose: 'bg-rose-50 text-rose-700',
}

export function Dashboard() {
  const adrsQ = useCollection<Adr>(KIND.adr)
  const diagramsQ = useCollection<Diagram>(KIND.diagram)
  const personasQ = useCollection<Persona>(KIND.persona)
  const journeysQ = useCollection<Journey>(KIND.journey)
  const boardsQ = useCollection<WhiteboardBoard>(KIND.board)
  const wireframesQ = useCollection<Wireframe>(KIND.wireframe)

  const adrs = adrsQ.items
  const personas = personasQ.items
  const journeys = journeysQ.items
  const wireframes = wireframesQ.items
  const noteCount = boardsQ.items.reduce((n, b) => n + b.notes.length, 0)

  const anyError =
    adrsQ.error ||
    diagramsQ.error ||
    personasQ.error ||
    journeysQ.error ||
    boardsQ.error ||
    wireframesQ.error
  const anyLoading =
    adrsQ.isLoading ||
    diagramsQ.isLoading ||
    personasQ.isLoading ||
    journeysQ.isLoading ||
    boardsQ.isLoading ||
    wireframesQ.isLoading

  const proposed = adrs.filter((a) => a.status === 'proposed').length
  const accepted = adrs.filter((a) => a.status === 'accepted').length

  // Recent activity uses the REAL envelope timestamp (`_updatedAt`) the store
  // folds onto every listed document, falling back to a domain field only for
  // types that also carry one. No fabricated dates.
  const recent = [
    ...adrs.map((a) => ({
      kind: 'ADR',
      id: a.id,
      title: a.title,
      ts: a._updatedAt ?? a.updated_at,
      tone: 'brand' as const,
    })),
    ...diagramsQ.items.map((d) => ({
      kind: 'Diagram',
      id: d.id,
      title: d.title,
      ts: d._updatedAt ?? d.updated_at,
      tone: 'amber' as const,
    })),
    ...journeys.map((j) => ({
      kind: 'Journey',
      id: j.id,
      title: j.name,
      ts: j._updatedAt,
      tone: 'violet' as const,
    })),
    ...personas.map((p) => ({
      kind: 'Persona',
      id: p.id,
      title: p.name,
      ts: p._updatedAt,
      tone: 'emerald' as const,
    })),
    ...wireframes.map((w) => ({
      kind: 'Wireframe',
      id: w.id,
      title: w.name,
      ts: w._updatedAt,
      tone: 'rose' as const,
    })),
  ]
    .filter((r) => !!r.ts)
    .sort((a, b) => new Date(b.ts!).getTime() - new Date(a.ts!).getTime())
    .slice(0, 8)

  if (anyError) return <ErrorBlock error={anyError} onRetry={adrsQ.refetch} />
  if (anyLoading) return <LoadingBlock label="Loading design workspace…" />

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeroStat
          label="ADRs"
          value={adrs.length}
          tone="brand"
          icon={<IconBook />}
          hint={`${accepted} accepted · ${proposed} proposed`}
        />
        <HeroStat
          label="Diagrams"
          value={diagramsQ.items.length}
          tone="amber"
          icon={<IconDiagram />}
          hint="System maps"
        />
        <HeroStat
          label="Whiteboard notes"
          value={noteCount}
          tone="sky"
          icon={<IconNote />}
          hint="Sticky brainstorms"
        />
        <HeroStat
          label="Personas"
          value={personas.length}
          tone="emerald"
          icon={<IconUser />}
          hint="Target users"
        />
        <HeroStat
          label="Journeys"
          value={journeys.length}
          tone="violet"
          icon={<IconRoute />}
          hint="UX flows mapped"
        />
        <HeroStat
          label="Wireframes"
          value={wireframes.length}
          tone="rose"
          icon={<IconFrame />}
          hint="Across flows"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Recent activity</div>
                <div className="text-[11px] text-content-subtle">
                  Most recently touched design artifacts
                </div>
              </div>
              <StatusBadge kind="info">{recent.length}</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            {recent.length === 0 ? (
              <div className="px-5 py-8 text-center text-xs text-content-subtle">
                No artifacts yet — create an ADR, diagram, or persona to see activity here.
              </div>
            ) : (
            <ul className="divide-y divide-edge-subtle">
              {recent.map((r) => (
                <li
                  key={`${r.kind}-${r.id}`}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40"
                >
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${RECENT_TONE[r.tone]}`}
                  >
                    {r.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-content">{r.title}</span>
                  <span className="shrink-0 text-[11px] text-content-subtle">
                    {r.ts ? formatRelative(r.ts) : '—'}
                  </span>
                </li>
              ))}
            </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Decision pulse</div>
            <div className="text-[11px] text-content-subtle">ADR status distribution</div>
          </CardHeader>
          <CardBody>
            <DecisionPulse adrs={adrs} />
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <QuickStartCard
          title="Architecture track"
          description="Capture decisions, draw system diagrams, brainstorm with the team."
          links={[
            { label: 'Browse ADRs', href: '?adrs' },
            { label: 'Open whiteboard', href: '?whiteboard' },
            { label: 'View diagrams', href: '?diagrams' },
          ]}
          tone="brand"
        />
        <QuickStartCard
          title="UI/UX track"
          description="Define personas, map journeys, prototype screens, browse the design system."
          links={[
            { label: 'Personas', href: '?personas' },
            { label: 'Journey maps', href: '?journeys' },
            { label: 'Wireframes', href: '?wireframes' },
          ]}
          tone="violet"
        />
        <QuickStartCard
          title="Design system"
          description="Tokens, components, builder — the production-ready primitives."
          links={[
            { label: 'Design tokens', href: '?tokens' },
            { label: 'Artifact catalog', href: '?catalog' },
            { label: 'Visual builder', href: '?builder' },
          ]}
          tone="emerald"
        />
      </div>
    </div>
  )
}

function HeroStat({
  label,
  value,
  tone,
  icon,
  hint,
}: {
  label: string
  value: number
  tone: 'brand' | 'amber' | 'sky' | 'emerald' | 'violet' | 'rose'
  icon: React.ReactNode
  hint?: string
}) {
  const cls = {
    brand: 'from-brand-500/10 to-surface-raised text-brand-700',
    amber: 'from-amber-500/10 to-surface-raised text-amber-700',
    sky: 'from-sky-500/10 to-surface-raised text-sky-700',
    emerald: 'from-emerald-500/10 to-surface-raised text-emerald-700',
    violet: 'from-violet-500/10 to-surface-raised text-violet-700',
    rose: 'from-rose-500/10 to-surface-raised text-rose-700',
  }[tone]
  return (
    <Card className={`relative overflow-hidden bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
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
          {value}
        </div>
        {hint ? <div className="text-[11px] text-content-muted">{hint}</div> : null}
      </CardBody>
    </Card>
  )
}

function DecisionPulse({ adrs }: { adrs: Adr[] }) {
  const buckets: { label: string; status: Adr['status']; color: string }[] = [
    { label: 'Accepted', status: 'accepted', color: 'var(--color-brand-500)' },
    { label: 'Proposed', status: 'proposed', color: 'var(--color-accent-500)' },
    { label: 'Superseded', status: 'superseded', color: '#94a3b8' },
    { label: 'Deprecated', status: 'deprecated', color: '#f59e0b' },
    { label: 'Rejected', status: 'rejected', color: '#f43f5e' },
  ]
  const total = adrs.length || 1
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
        {buckets.map((b) => {
          const n = adrs.filter((a) => a.status === b.status).length
          if (!n) return null
          return (
            <div
              key={b.status}
              className="h-full transition-[width] duration-500"
              style={{ width: `${(n / total) * 100}%`, backgroundColor: b.color }}
              title={`${b.label}: ${n}`}
            />
          )
        })}
      </div>
      <ul className="space-y-1 text-[11px] text-content-muted">
        {buckets.map((b) => {
          const n = adrs.filter((a) => a.status === b.status).length
          return (
            <li key={b.status} className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: b.color }}
                />
                {b.label}
              </span>
              <span className="tabular-nums text-content">{n}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function QuickStartCard({
  title,
  description,
  links,
  tone,
}: {
  title: string
  description: string
  links: { label: string; href: string }[]
  tone: 'brand' | 'violet' | 'emerald'
}) {
  const accent = {
    brand: 'border-brand-200/60 bg-brand-50/30',
    violet: 'border-violet-200/60 bg-violet-50/30',
    emerald: 'border-emerald-200/60 bg-emerald-50/30',
  }[tone]
  return (
    <Card className={`${accent} border`}>
      <CardBody className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-content">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-content-muted">{description}</p>
        </div>
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline"
              >
                <IconArrow /> {l.label}
              </a>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
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
function IconArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
