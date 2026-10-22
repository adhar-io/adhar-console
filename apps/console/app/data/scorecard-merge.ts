/**
 * The join between the Service Catalog and the platform scorer, kept free of
 * React so it can be tested on its own.
 */
import type { Entity, EntityMetadata } from './catalog.ts'
import type { PlatformService } from '../server/scorecards.ts'
import type { Scorecard } from './scorecard.ts'

/** Annotation a catalog entity uses to name its scorer record explicitly. */
export const SCORECARD_ANNOTATION = 'adhar.io/scorecard'

/** The key a catalog entity joins the platform scorer on. */
export function scorecardKey(e: Entity): string {
  const meta = e.metadata as EntityMetadata & { annotations?: Record<string, string> }
  const v = meta.annotations?.[SCORECARD_ANNOTATION]
  return typeof v === 'string' && v.trim() ? v.trim() : e.metadata.name
}

/**
 * Scorecards for exactly the Service Catalog's applications, platform scorer
 * first.
 *
 *   • catalog entity + platform record → the platform score/grade wins, the
 *     catalog checks stay available in the drawer (they answer a different
 *     question: is this service *documented and owned*).
 *   • catalog entity only             → the console's own derivation, labelled.
 *
 * A platform record with no catalog entity is NOT shown. That used to become a
 * platform-only card, and since the scorer graded every Argo CD Application,
 * 78 platform packages buried the 3 applications a team owns (2026-10-22).
 * The page lists what the catalog lists; the scorer now grades applications
 * only, and a package record from an older scorer is ignored here as well.
 *
 * Nothing is merged numerically: one card shows one scorer's number, and says
 * which scorer it was.
 */
export function mergeScorecards(
  catalogCards: readonly Scorecard[],
  records: readonly PlatformService[],
): { scorecards: Scorecard[]; matched: number; graded: number } {
  const apps = records.filter((r) => r.kind !== 'package')
  const byName = new Map(apps.map((r) => [r.name, r]))
  const used = new Set<string>()
  const scorecards = catalogCards
    .map((card) => {
      const rec = byName.get(scorecardKey(card.entity))
      if (!rec) return card
      used.add(rec.name)
      return { ...card, score: rec.score, grade: rec.grade, source: 'platform' as const, platform: rec }
    })
    .sort((a, b) => a.score - b.score || a.entityRef.localeCompare(b.entityRef))
  return { scorecards, matched: used.size, graded: apps.length }
}
