import { useMemo } from 'react'
import { StatusBadge, type StatusKind } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { KIND, type Listed, useCollection } from '../data/store.ts'
import { type AdrDoc, formatAdrNumber, STATUS_LABEL } from '../data/adr.ts'
import { inReview } from '../data/adr-sync.ts'
import { normalizeRef } from '../data/platform-model.ts'
import type { AdrStatus } from '../data/types.ts'

/**
 * "Decisions" for a catalog entity — the ADRs linked to it.
 *
 * Reusable outside the Design module (exposed as `design/Decisions`): the
 * Service Catalog's entity drawer can render
 *
 *     <EntityDecisions entityRef="component:cart" />
 *
 * Accepts every ref spelling the console uses (`component:cart`,
 * `component:default/cart`); reads the tenant document store, so it shows the
 * same decisions the Design → ADRs page does.
 */

export function useEntityDecisions(entityRef: string): { decisions: Listed<AdrDoc>[]; isLoading: boolean; error: Error | null } {
  const { items, isLoading, error } = useCollection<AdrDoc>(KIND.adr)
  const ref = normalizeRef(entityRef)
  const decisions = useMemo(
    () => items.filter((a) => (a.entities ?? []).some((e) => normalizeRef(e) === ref)).sort((a, b) => b.number - a.number),
    [items, ref],
  )
  return { decisions, isLoading, error }
}

const STATUS_KIND: Record<AdrStatus, StatusKind> = {
  proposed: 'info',
  accepted: 'healthy',
  superseded: 'unknown',
  deprecated: 'degraded',
  rejected: 'failed',
}

export function adrHref(id: string): string {
  return `/design?section=adrs&adr=${encodeURIComponent(id)}`
}

export function EntityDecisions({ entityRef, limit = 8, emptyText }: { entityRef: string; limit?: number; emptyText?: string }) {
  const { decisions, isLoading, error } = useEntityDecisions(entityRef)
  if (isLoading) return <div className="text-[12px] text-content-subtle">Loading decisions…</div>
  if (error) return <div className="text-[12px] text-rose-600 dark:text-rose-400">Decisions unavailable: {error.message}</div>
  if (!decisions.length) {
    return <div className="text-[12px] text-content-subtle">{emptyText ?? 'No architecture decisions are linked to this entity.'}</div>
  }
  return (
    <ul className="space-y-1.5">
      {decisions.slice(0, limit).map((a) => (
        <li key={a.id} className="flex items-start gap-2 text-[12.5px]">
          <StatusBadge kind={inReview(a) ? 'progressing' : STATUS_KIND[a.status]}>{inReview(a) ? 'In review' : STATUS_LABEL[a.status]}</StatusBadge>
          <a href={adrHref(a.id)} className="min-w-0 flex-1 truncate text-content hover:underline">
            <span className="font-mono text-[10.5px] text-content-subtle">{formatAdrNumber(a.number)}</span> {a.title}
          </a>
          <span className="shrink-0 text-[10.5px] text-content-subtle">{formatRelative(a._updatedAt ?? a.updated_at)}</span>
        </li>
      ))}
      {decisions.length > limit ? <li className="text-[11px] text-content-subtle">+{decisions.length - limit} more</li> : null}
    </ul>
  )
}

export default EntityDecisions
