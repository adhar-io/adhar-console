import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  SearchInput,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { useFreight, usePromote, usePromotions, useStages } from '../data/delivery.ts'
import { promotionChain } from '../data/promotion-chain.ts'
import {
  buildReleases,
  summariseReleases,
  type Release,
  type ReleaseContent,
} from '../data/releases.ts'

/**
 * Releases — every piece of freight, and how far through the chain it got.
 *
 * The page listed nothing on a platform with freight promoted through two
 * stages, because it built a row per *image* and this platform's warehouse
 * subscribes to a git repository. Freight carrying commits produced no rows,
 * and the page said releases appear once freight is promoted — which had
 * already happened twice.
 *
 * A release is a piece of freight. What it carries is its contents.
 */
export function Releases() {
  const stages = useStages()
  const freight = useFreight()
  const promotions = usePromotions()
  const promote = usePromote()

  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const chain = useMemo(() => promotionChain(stages.data ?? []), [stages.data])
  const releases = useMemo(
    () => buildReleases(freight.data ?? [], stages.data ?? [], promotions.data ?? []),
    [freight.data, stages.data, promotions.data],
  )
  const summary = useMemo(() => summariseReleases(releases), [releases])

  const visible = releases.filter((r) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    const hay = [r.id, r.alias, r.furthest, ...r.contents.map((c) => `${c.title} ${c.source} ${c.detail ?? ''}`)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })

  if (stages.isLoading || freight.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading releases…
      </div>
    )
  }
  if (freight.isError) {
    return (
      <EmptyState
        title="Couldn't reach Kargo"
        description={freight.error instanceof Error ? freight.error.message : 'Unknown error listing freight.'}
      />
    )
  }
  if (releases.length === 0) {
    return (
      <EmptyState
        title="No releases yet"
        description="A release is a piece of Kargo freight — a commit, an image or a chart the warehouse has picked up. The warehouse has not produced any yet."
      />
    )
  }

  /** The next stage that could take this release, if there is one. */
  const nextStage = (r: Release): string | undefined => {
    if (!r.furthest) return chain[0]?.stage.name
    const link = chain.find((l) => l.stage.name === r.furthest)
    return link?.downstream[0]
  }

  const doPromote = async (r: Release, stage: string) => {
    setBusy(r.id)
    try {
      await promote.mutateAsync({ stage, freight: r.id, project: r.project })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Releases" value={summary.total} hint="freight produced" />
        <Stat
          label="At the end of the chain"
          value={summary.atEnd}
          hint={chain.length ? `reached ${chain[chain.length - 1].stage.name}` : '—'}
          tone={summary.atEnd ? 'healthy' : undefined}
        />
        <Stat label="In flight" value={summary.inFlight} hint="promoted, still travelling" tone={summary.inFlight ? 'progressing' : undefined} />
        <Stat label="Never promoted" value={summary.unpromoted} hint="built, no stage holds it" tone={summary.unpromoted ? 'degraded' : undefined} />
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search alias, commit, image or stage…"
        label="Search releases"
      />

      {visible.length === 0 ? (
        <EmptyState compact title="No matching releases" description="Relax the search." />
      ) : (
        <div className="space-y-3">
          {visible.map((r) => (
            <ReleaseCard
              key={r.id}
              release={r}
              next={nextStage(r)}
              busy={busy === r.id}
              disabled={busy !== null}
              onPromote={(stage) => doPromote(r, stage)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ReleaseCard({
  release: r,
  next,
  busy,
  disabled,
  onPromote,
}: {
  release: Release
  next?: string
  busy: boolean
  disabled: boolean
  onPromote(stage: string): void
}) {
  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {/* Kargo's generated alias is what people say out loud; the id is
                  what they paste into a command. Both, in that order. */}
              <span className="text-[15px] font-semibold text-content">{r.alias ?? r.short}</span>
              <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted" title={r.id}>
                {r.short}
              </code>
              {r.atEnd ? <StatusBadge kind="healthy">At {r.furthest}</StatusBadge> : null}
              {r.unpromoted ? <StatusBadge kind="unknown">Never promoted</StatusBadge> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-content-subtle">
              {r.warehouse ? <span>warehouse {r.warehouse}</span> : null}
              <span>discovered {formatRelative(r.created)}</span>
              {r.lastPromotedAt ? <span>· last promoted {formatRelative(r.lastPromotedAt)}</span> : null}
            </div>
          </div>
          {next ? (
            <Button size="sm" onClick={() => onPromote(next)} loading={busy} disabled={disabled}>
              Promote to {next}
            </Button>
          ) : null}
        </div>

        {r.contents.length ? (
          <ul className="mt-3 space-y-1.5">
            {r.contents.map((c, i) => <ContentRow key={`${c.kind}:${c.title}:${i}`} content={c} />)}
          </ul>
        ) : (
          <p className="mt-3 text-[12px] text-content-subtle">
            This freight carries no commits, images or charts yet.
          </p>
        )}

        {r.stages.length ? <StageTrail release={r} /> : null}
      </CardBody>
    </Card>
  )
}

const KIND_LABEL: Record<ReleaseContent['kind'], string> = {
  commit: 'commit',
  image: 'image',
  chart: 'chart',
}

function ContentRow({ content: c }: { content: ReleaseContent }) {
  return (
    <li className="flex items-start gap-2 rounded-lg border border-edge-subtle bg-surface-sunken/40 px-2.5 py-2">
      <span className="mt-0.5 w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {KIND_LABEL[c.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <code className="font-mono text-[12px] font-medium text-content">{c.title}</code>
          <span className="truncate text-[11px] text-content-muted">{c.source}</span>
          {c.branch ? <span className="text-[11px] text-content-subtle">@ {c.branch}</span> : null}
        </span>
        {c.detail ? (
          <span className="mt-0.5 block truncate text-[11px] text-content-muted" title={c.detail}>
            {c.detail}
          </span>
        ) : null}
      </span>
    </li>
  )
}

/**
 * How far this release travelled, drawn as the chain itself. Reading the
 * promotion order off the card is the question the page exists to answer.
 */
function StageTrail({ release: r }: { release: Release }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-edge-subtle pt-3">
      {r.stages.map((s, i) => (
        <span key={s.name} className="flex items-center gap-1.5">
          {i > 0 ? <span aria-hidden className="text-content-subtle">→</span> : null}
          <span
            title={s.promotedAt ? `promoted ${new Date(s.promotedAt).toLocaleString()}` : undefined}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              s.current
                ? 'bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300'
                : 'bg-surface-sunken text-content-subtle',
            )}
          >
            {s.name}
            {s.verified ? <span title="Verified by Kargo" aria-label="verified">✓</span> : null}
            {s.approved ? <span title="Manually approved" aria-label="approved">★</span> : null}
          </span>
        </span>
      ))}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: StatusKind
}) {
  const toneText: Partial<Record<StatusKind, string>> = {
    healthy: 'text-emerald-600 dark:text-emerald-300',
    degraded: 'text-amber-600 dark:text-amber-300',
    progressing: 'text-indigo-600 dark:text-indigo-300',
  }
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised px-3.5 py-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold leading-none tabular-nums', tone ? toneText[tone] ?? 'text-content' : 'text-content')}>
        {value}
      </div>
      {hint ? <div className="mt-1 truncate text-[11px] text-content-subtle">{hint}</div> : null}
    </div>
  )
}

export default Releases
