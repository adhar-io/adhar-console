import { useMemo, useState, type ReactNode } from 'react'
import { Button, EmptyState } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { KIND, type Listed, useCollection } from '../data/store.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Adr, ApiSpec, Diagram, Journey, Persona, PlaneLink, ScopeTag, TokenPublishDoc, TokenSet, WhiteboardBoard, Wireframe } from '../data/types.ts'
import { type DesignParams, type DesignSection, useGoDesign } from '../data/nav.ts'
import { countTokens } from '../data/tokens-lib.ts'
import { useDesignScope } from '../data/design-scope.ts'
import { useEffectiveTokens } from '../data/token-scope.ts'
import { overrideCount } from '../data/token-publish.ts'
import { scopedApps, useCatalogApps } from '../data/designer-repos.ts'
import { activityByUser, appCoverage, type AppCoverage, coverageSummary } from '../data/coverage.ts'
import { usePlaneIssueIndex, usePlaneItemUrl } from '../data/plane.ts'
import { type IssueStatus, statusCounts } from '../data/plane-map.ts'
import { IssueStateChip, PrBadge, ReviewBadge } from '../components/integrations.tsx'
import { coverageHints, shortPersonaName } from '../data/ux-lib.ts'
import { IconArrowRight, IconInfo, IconPlus, IconWarning } from '../components/ux-kit.tsx'
import { Icon } from '../components/ui-bits.tsx'

type Kind = 'adr' | 'diagram' | 'board' | 'persona' | 'journey' | 'wireframe' | 'spec'

const KIND_META: Record<Kind, { label: string; section: DesignSection; param: keyof DesignParams; tone: string; dot: string }> = {
  adr: { label: 'ADR', section: 'adrs', param: 'adr', tone: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200', dot: 'bg-brand-500' },
  diagram: { label: 'Diagram', section: 'diagrams', param: 'diagram', tone: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200', dot: 'bg-amber-500' },
  board: { label: 'Whiteboard', section: 'whiteboard', param: 'board', tone: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-200', dot: 'bg-sky-500' },
  persona: { label: 'Persona', section: 'personas', param: 'persona', tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200', dot: 'bg-emerald-500' },
  journey: { label: 'Journey', section: 'journeys', param: 'journey', tone: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200', dot: 'bg-violet-500' },
  wireframe: { label: 'Wireframe', section: 'wireframes', param: 'wireframe', tone: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200', dot: 'bg-rose-500' },
  spec: { label: 'API spec', section: 'api-schemas', param: 'spec', tone: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-200', dot: 'bg-teal-500' },
}

interface Row {
  key: string
  kind: Kind
  id: string
  title: string
  subtitle: string
  ts?: string
  by?: string | null
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
 * Design dashboard — the active project's (or team's) design work at a
 * glance: per-kind counts, design coverage of every catalog application in
 * scope, wireframes waiting for review, Plane work items created from design
 * artifacts with their live state, pull requests opened from design, who has
 * been editing, ADRs awaiting a decision, and coverage gaps worth closing.
 * Everything is read from the document store, the catalog, Plane and Gitea —
 * no invented metrics: an empty scope shows zeros and guidance, a failing
 * source says so.
 */
export function Dashboard() {
  const scope = useDesignScope()
  // Every collection narrowed to the active Org → Team → Project scope.
  const scoped = <T extends ScopeTag>(q: { items: Listed<T>[] }) => scope.pick(q.items)
  const adrsQ = useCollection<Adr & ScopeTag>(KIND.adr)
  const diagramsQ = useCollection<Diagram & ScopeTag>(KIND.diagram)
  const boardsQ = useCollection<WhiteboardBoard & ScopeTag>(KIND.board)
  const personasQ = useCollection<Persona>(KIND.persona)
  const journeysQ = useCollection<Journey>(KIND.journey)
  const wireframesQ = useCollection<Wireframe>(KIND.wireframe)
  const specsQ = useCollection<ApiSpec & ScopeTag>(KIND.apiSpec)
  const tokenDocs = useCollection<TokenSet & { id: string }>(KIND.tokenSet)
  const publishDocs = useCollection<TokenPublishDoc & { id: string }>(KIND.tokenPublish)
  const eff = useEffectiveTokens(scope.project || undefined)
  const catalog = useCatalogApps()
  const go = useGoDesign()

  const [kindFilter, setKindFilter] = useState<Kind | null>(null)

  const all = [adrsQ, diagramsQ, boardsQ, personasQ, journeysQ, wireframesQ, specsQ]
  const anyError = all.find((x) => x.error)?.error ?? null
  const anyLoading = all.some((x) => x.isLoading)

  const adrs = scoped(adrsQ)
  const diagrams = scoped(diagramsQ)
  const boards = scoped(boardsQ)
  const personas = scoped(personasQ)
  const journeys = scoped(journeysQ)
  const wireframes = scoped(wireframesQ)
  const specs = scoped(specsQ)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const push = (kind: Kind, id: string, title: string, subtitle: string, ts: string | undefined, by: string | null | undefined, extra = '') =>
      out.push({ key: `${kind}:${id}`, kind, id, title: title || 'Untitled', subtitle, ts, by, hay: `${title} ${subtitle} ${extra}`.toLowerCase() })
    for (const a of adrs) push('adr', a.id, a.title, `ADR-${String(a.number).padStart(4, '0')} · ${a.status}`, a._updatedAt ?? a.updated_at, a._updatedBy, [...(a.tags ?? []), ...(a.authors ?? [])].join(' '))
    for (const d of diagrams) push('diagram', d.id, d.title, d.type, d._updatedAt ?? d.updated_at, d._updatedBy, (d.tags ?? []).join(' '))
    for (const b of boards) push('board', b.id, b.name, `${b.notes?.length ?? 0} notes`, b._updatedAt ?? b.updated_at, b._updatedBy)
    for (const p of personas) push('persona', p.id, p.name, p.role, p._updatedAt, p._updatedBy, (p.tags ?? []).join(' '))
    for (const j of journeys) {
      const p = personas.find((x) => x.id === j.persona)
      push('journey', j.id, j.name, `${j.stages.length} stages${p ? ` · ${shortPersonaName(p.name)}` : ''}`, j._updatedAt, j._updatedBy, j.summary)
    }
    for (const w of wireframes) push('wireframe', w.id, w.name, w.flow, w._updatedAt, w._updatedBy, w.notes ?? '')
    for (const s of specs) push('spec', s.id, s.name, `v${s.version}`, s._updatedAt ?? s.updated_at, s._updatedBy, s.description)
    return out.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adrsQ.items, diagramsQ.items, boardsQ.items, personasQ.items, journeysQ.items, wireframesQ.items, specsQ.items, scope])

  const hints = useMemo(
    () => coverageHints({ personas, journeys, adrs, tokens: eff.workspaceStored || eff.overrideCount ? eff.effective : null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [personasQ.items, journeysQ.items, adrsQ.items, eff.effective, scope],
  )

  // Platform links: catalog applications in scope and their design coverage.
  const apps = useMemo(() => scopedApps(catalog.data ?? [], scope.inScope, scope.projects), [catalog.data, scope.inScope, scope.projects])
  const tokenProjects = useMemo(
    () => new Set(tokenDocs.items.filter((d) => d.id.startsWith('project:') && overrideCount(d) > 0).map((d) => d.id.slice('project:'.length))),
    [tokenDocs.items],
  )
  const publishes = useMemo(() => publishDocs.items.flatMap((d) => (d.history ?? []).map((h) => ({ ...h, scopeId: d.id }))), [publishDocs.items])
  const coverage = useMemo(
    () => appCoverage({ apps, personas, journeys, wireframes, tokenProjects, publishes }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apps, personasQ.items, journeysQ.items, wireframesQ.items, tokenProjects, publishes, scope],
  )
  const planeLinks = useMemo(
    () => [...personas, ...journeys, ...wireframes].flatMap((a) => (a.planeLinks ?? []).map((l) => ({ ...l, from: a }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [personasQ.items, journeysQ.items, wireframesQ.items, scope],
  )
  const activity = useMemo(() => activityByUser(rows, new Date(Date.now() - 14 * 86_400_000)), [rows])

  if (anyError) return <ErrorBlock error={anyError} onRetry={() => all.forEach((x) => x.refetch())} />
  // Keep hook order stable: everything below is plain derivation.
  if (anyLoading) return <LoadingBlock label="Loading design workspace…" />

  const listed = rows.filter((r) => !kindFilter || r.kind === kindFilter).slice(0, kindFilter ? 50 : 12)

  const proposed = adrs
    .filter((a) => a.status === 'proposed')
    .sort((a, b) => (a._updatedAt ?? a.updated_at).localeCompare(b._updatedAt ?? b.updated_at))
  const notes = boards.reduce((n, b) => n + (b.notes?.length ?? 0), 0)
  const flows = new Set(wireframes.map((w) => w.flow)).size
  const stages = journeys.reduce((n, j) => n + j.stages.length, 0)
  // No stored set (workspace or project) means no tokens — the starter set is a template, not a count.
  const tokensSet = eff.workspaceStored || eff.overrideCount > 0
  const tokenCount = tokensSet ? countTokens(eff.effective) : 0
  const total = rows.length
  const inReview = wireframes.filter((w) => w.review?.state === 'in-review')
  const designPrs = [
    ...wireframes.flatMap((w) => (w.prs ?? []).map((pr) => ({ pr, label: w.name, open: () => go('wireframes', { wireframe: w.id }) }))),
    ...publishes
      .filter((p) => p.number && (scope.project ? p.scopeId === scope.project : true))
      .map((p) => ({ pr: { repo: p.repo, number: p.number!, url: p.url, createdAt: p.at, branch: p.branch }, label: `Tokens ${p.versionLabel ?? ''}`.trim(), open: () => go('tokens', { tab: 'code' }) })),
  ].sort((a, b) => b.pr.createdAt.localeCompare(a.pr.createdAt))

  const open = (r: Row) => go(KIND_META[r.kind].section, { [KIND_META[r.kind].param]: r.id })

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="ADRs" value={adrs.length} hint={adrs.length ? `${adrs.filter((a) => a.status === 'accepted').length} accepted · ${proposed.length} proposed` : 'Record decisions'} dot={KIND_META.adr.dot} onClick={() => go('adrs')} />
        <Tile label="Diagrams" value={diagrams.length} hint={diagrams.length ? `${new Set(diagrams.map((d) => d.type)).size} diagram types` : 'Draw the system'} dot={KIND_META.diagram.dot} onClick={() => go('diagrams')} />
        <Tile label="Whiteboards" value={boards.length} hint={`${notes} sticky notes`} dot={KIND_META.board.dot} onClick={() => go('whiteboard')} />
        <Tile label="API specs" value={specs.length} hint={specs.length ? 'OpenAPI documents' : 'Design an API'} dot={KIND_META.spec.dot} onClick={() => go('api-schemas')} />
        <Tile label="Personas" value={personas.length} hint={personas.length ? `${personas.filter((p) => journeys.some((j) => j.persona === p.id)).length} with a journey` : 'Who you build for'} dot={KIND_META.persona.dot} onClick={() => go('personas')} />
        <Tile label="Journey maps" value={journeys.length} hint={`${stages} stages mapped`} dot={KIND_META.journey.dot} onClick={() => go('journeys')} />
        <Tile label="Wireframes" value={wireframes.length} hint={`${flows} flow${flows === 1 ? '' : 's'}${inReview.length ? ` · ${inReview.length} in review` : ''}`} dot={KIND_META.wireframe.dot} onClick={() => go('wireframes')} />
        <Tile label="Design tokens" value={tokenCount} hint={!tokensSet ? 'Not set up yet' : scope.project ? (eff.overrideCount ? `${eff.overrideCount} project overrides` : 'Workspace set') : 'Workspace token set'} dot="bg-content-subtle" onClick={() => go('tokens')} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
        <AppCoverageTable rows={coverage} loading={catalog.isLoading} scopeLabel={scope.label} personas={personas} go={go} />
        <section className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-content">Recently edited</h2>
            <span className="text-xs text-content-subtle">{kindFilter ? `${listed.length} of ${total}` : `${total} artifacts`}</span>
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
              icon={<Icon name="layers" size={22} />}
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
        </div>

        <div className="space-y-6">
          <section>
            <PanelTitle title="Design reviews" count={inReview.length} action={wireframes.length ? { label: 'Wireframes', onClick: () => go('wireframes') } : undefined} />
            {inReview.length === 0 ? (
              <p className="rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">
                {wireframes.length ? 'No wireframes waiting for review.' : 'Wireframes sent for review show up here.'}
              </p>
            ) : (
              <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
                {inReview.slice(0, 6).map((w) => (
                  <li key={w.id}>
                    <button type="button" onClick={() => go('wireframes', { wireframe: w.id })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-sunken">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-content">{w.name}</span>
                        <span className="block truncate text-[11px] text-content-subtle">
                          {w.review?.requestedBy ? `${w.review.requestedBy} · ` : ''}{w.review?.requestedAt ? formatRelative(w.review.requestedAt) : w.flow}
                        </span>
                      </span>
                      <ReviewBadge review={w.review} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <WorkItemsPanel links={planeLinks} go={go} />

          <section>
            <PanelTitle title="Pull requests from design" count={designPrs.length} />
            {designPrs.length === 0 ? (
              <p className="rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">
                Pull requests opened from wireframes (Implement in repo) and token publishes show here with their live state.
              </p>
            ) : (
              <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
                {designPrs.slice(0, 6).map((d) => (
                  <li key={`${d.pr.repo}#${d.pr.number}`} className="flex items-center gap-2 px-4 py-2 text-xs">
                    <button type="button" onClick={d.open} className="min-w-0 flex-1 truncate text-left text-content hover:underline">{d.label}</button>
                    <PrBadge pr={d.pr} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <PanelTitle title="Recent activity" count={activity.length} />
            {activity.length === 0 ? (
              <p className="rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">No edits in the last 14 days{scope.inScope ? ` in ${scope.label}` : ''}.</p>
            ) : (
              <ul className="space-y-1.5" title="Last editor of each artifact, last 14 days">
                {activity.slice(0, 6).map((a) => (
                  <li key={a.user} className="flex items-center gap-2 text-xs">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold uppercase text-content-muted">{a.user.slice(0, 2)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-content">{a.user}</span>
                      <span className="block truncate text-[11px] text-content-subtle">{a.count} artifact{a.count === 1 ? '' : 's'} · last “{a.lastTitle}” {formatRelative(a.last)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

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
            <PanelTitle title="Gaps worth closing" count={hints.length} />
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

/* ───────────────────────────── coverage by application ───────────────────────────── */

const COVER_COLS: Array<{ key: 'personas' | 'journeys' | 'wireframes' | 'designs' | 'tokens'; label: string; hint: string }> = [
  { key: 'personas', label: 'Personas', hint: 'Personas whose journeys this application serves' },
  { key: 'journeys', label: 'Journeys', hint: 'Journey maps with a stage served by this application' },
  { key: 'wireframes', label: 'Wireframes', hint: 'Wireframes linked to this application' },
  { key: 'designs', label: 'Designs', hint: 'Visual Designer pull requests on its repository' },
  { key: 'tokens', label: 'Tokens', hint: 'Token set: published to its repo, a project set, or the workspace set' },
]

function AppCoverageTable({
  rows,
  loading,
  scopeLabel,
  personas,
  go,
}: {
  rows: AppCoverage[]
  loading: boolean
  scopeLabel: string
  personas: Persona[]
  go: ReturnType<typeof useGoDesign>
}) {
  const sum = coverageSummary(rows)
  const cell = (r: AppCoverage, key: (typeof COVER_COLS)[number]['key']) => {
    switch (key) {
      case 'personas': {
        const names = r.personas.map((id) => personas.find((p) => p.id === id)?.name ?? id)
        return r.personas.length
          ? <button type="button" title={names.join(', ')} onClick={() => go('personas', { persona: r.personas[0] })} className="tabular-nums text-content hover:underline">{r.personas.length}</button>
          : <Gap />
      }
      case 'journeys':
        return r.journeys.length ? <button type="button" onClick={() => go('journeys', { journey: r.journeys[0] })} className="tabular-nums text-content hover:underline">{r.journeys.length}</button> : <Gap />
      case 'wireframes':
        return r.wireframes.length ? <button type="button" onClick={() => go('wireframes', { wireframe: r.wireframes[0] })} className="tabular-nums text-content hover:underline">{r.wireframes.length}</button> : <Gap />
      case 'designs':
        return r.designPrs ? <span className="tabular-nums text-content">{r.designPrs}</span> : <Gap />
      case 'tokens':
        return r.tokens === 'published'
          ? <span className="text-emerald-700 dark:text-emerald-300">Published</span>
          : r.tokens === 'project'
          ? <span className="text-content">Project</span>
          : <span className="text-content-subtle">Workspace</span>
    }
  }
  return (
    <section className="min-w-0">
      <PanelTitle title="Design coverage by application" count={rows.length} />
      {loading ? (
        <div className="h-24 animate-pulse rounded-xl border border-edge-default bg-surface-raised" />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">
          No catalog applications in {scopeLabel}. Applications deployed from the Service Catalog appear here with the personas, journeys, wireframes, designs and tokens linked to them.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-edge-default text-left text-[11px] font-semibold uppercase tracking-wide text-content-subtle">
                <th className="px-4 py-2">Application</th>
                {COVER_COLS.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-right" title={c.hint}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {rows.slice(0, 12).map((r) => (
                <tr key={`${r.app.project ?? ''}:${r.app.name}`}>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <CoverageDots score={r.score} />
                      <span className="truncate font-medium text-content">{r.app.name}</span>
                    </div>
                    <div className="truncate pl-[3.25rem] font-mono text-[10px] text-content-subtle">{r.app.project ?? '—'}{r.repo ? ` · ${r.repo}` : ''}</div>
                  </td>
                  {COVER_COLS.map((c) => <td key={c.key} className="px-3 py-2 text-right text-xs">{cell(r, c.key)}</td>)}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-edge-default text-[11px] text-content-muted">
                <td className="px-4 py-2">Covered</td>
                {[sum.withPersonas, sum.withJourneys, sum.withWireframes, sum.withDesigns, sum.withTokens].map((n, i) => (
                  <td key={i} className="px-3 py-2 text-right tabular-nums">{n}/{sum.apps}</td>
                ))}
              </tr>
            </tfoot>
          </table>
          {rows.length > 12 ? <div className="border-t border-edge-subtle px-4 py-1.5 text-[11px] text-content-subtle">Least covered first · {rows.length - 12} more</div> : null}
        </div>
      )}
    </section>
  )
}

function Gap() {
  return <span className="text-content-subtle" aria-label="none">—</span>
}

/** Five small dots — dimensions covered, out of five. */
function CoverageDots({ score }: { score: number }) {
  return (
    <span className="flex shrink-0 gap-0.5" title={`${score} of 5 covered`} aria-label={`${score} of 5 covered`}>
      {[0, 1, 2, 3, 4].map((i) => <span key={i} className={cn('h-1.5 w-1.5 rounded-full', i < score ? 'bg-brand-500' : 'bg-surface-sunken ring-1 ring-inset ring-edge-default')} />)}
    </span>
  )
}

/* ───────────────────────────── Plane work items ───────────────────────────── */

const STATUS_BAR: Array<{ key: IssueStatus; label: string; color: string }> = [
  { key: 'done', label: 'Done', color: 'var(--color-emerald-500)' },
  { key: 'in-progress', label: 'In progress', color: 'var(--color-amber-500)' },
  { key: 'todo', label: 'To do', color: 'var(--color-sky-500)' },
  { key: 'backlog', label: 'Backlog', color: 'var(--color-slate-400)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--color-rose-400)' },
]

function WorkItemsPanel({
  links,
  go,
}: {
  links: Array<PlaneLink & { from: { id: string; name: string } & Partial<Persona & Journey & Wireframe> }>
  go: ReturnType<typeof useGoDesign>
}) {
  const items = useMemo(() => links.filter((l) => !l.parent), [links])
  const { index, loading, error } = usePlaneIssueIndex(items)
  const url = usePlaneItemUrl()
  const [hover, setHover] = useState<IssueStatus | null>(null)
  const known = items.map((l) => index.get(l.issueId)).filter(Boolean)
  const counts = statusCounts(known.map((i) => i!.status))
  const total = known.length
  const openFrom = (f: { id: string } & Partial<Persona & Journey & Wireframe>) => {
    if ('stages' in f && f.stages) go('journeys', { journey: f.id })
    else if ('flow' in f && f.flow) go('wireframes', { wireframe: f.id })
    else go('personas', { persona: f.id })
  }
  const recent = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6)
  return (
    <section>
      <PanelTitle title="Work items from design" count={items.length} />
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">
          Create Plane work items from journey pain points, persona jobs or wireframes — they show here with their live state.
        </p>
      ) : (
        <div className="space-y-2 rounded-xl border border-edge-default bg-surface-raised p-4">
          {error ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">Plane state unavailable: {error.message}</p>
          ) : loading ? (
            <p className="text-[11px] text-content-subtle">Reading state from Plane…</p>
          ) : total ? (
            <>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label="Work items by state">
                {STATUS_BAR.map((b) => counts[b.key] ? (
                  <div
                    key={b.key}
                    title={`${b.label}: ${counts[b.key]}`}
                    onMouseEnter={() => setHover(b.key)}
                    onMouseLeave={() => setHover(null)}
                    className={cn('h-full transition-opacity', hover && hover !== b.key && 'opacity-40')}
                    style={{ width: `${(counts[b.key] / total) * 100}%`, background: b.color }}
                  />
                ) : null)}
              </div>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                {STATUS_BAR.filter((b) => counts[b.key]).map((b) => (
                  <li key={b.key} onMouseEnter={() => setHover(b.key)} onMouseLeave={() => setHover(null)} className={cn('flex items-center gap-1.5 text-[11px] text-content-muted', hover === b.key && 'text-content')}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: b.color }} />
                    {b.label}
                    <span className="ml-auto tabular-nums text-content">{counts[b.key]}</span>
                  </li>
                ))}
              </ul>
              {items.length > total ? <p className="text-[11px] text-content-subtle">{items.length - total} not found in Plane.</p> : null}
            </>
          ) : null}
          <ul className="divide-y divide-edge-subtle border-t border-edge-subtle pt-1">
            {recent.map((l) => {
              const info = index.get(l.issueId)
              const href = url(l)
              return (
                <li key={`${l.projectId}:${l.issueId}`} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className="w-14 shrink-0 font-mono text-[10px] text-content-subtle">{info?.key ?? l.key ?? '—'}</span>
                  <span className="min-w-0 flex-1">
                    {href ? <a href={href} target="_blank" rel="noreferrer" className="block truncate text-content hover:underline">{info?.name ?? l.name}</a> : <span className="block truncate text-content">{info?.name ?? l.name}</span>}
                    <button type="button" onClick={() => openFrom(l.from)} className="block truncate text-[10px] text-content-subtle hover:underline">from {l.from.name}</button>
                  </span>
                  <IssueStateChip info={info} missing={!loading && !error && !info} />
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
