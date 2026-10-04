import type { kargo } from '@adhar-console/api-clients'

/**
 * Put Kargo stages in promotion order.
 *
 * The API returns them alphabetically, so a `dev → test → prod` pipeline
 * rendered as `dev → prod → test` — with arrows between the cards, which reads
 * as a claim that prod promotes into test. The order is not cosmetic; it is
 * the thing the card is about.
 *
 * The real order is already in the data: each stage names the stages it draws
 * freight from (`spec.requestedFreight[].sources.stages`). That is a DAG, so
 * this is a topological sort, with two deliberate properties:
 *
 *   - Stable. Among stages that are equally ready — same depth, nothing left
 *     to wait for — the incoming order decides, so the list does not reshuffle
 *     between polls.
 *   - Total. A cycle, or an upstream that is not in the list (a stage in
 *     another project, or one the viewer cannot read), must not drop stages or
 *     hang; whatever cannot be placed is appended in its original order.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */
export function orderStages(stages: kargo.Stage[]): kargo.Stage[] {
  const present = new Set(stages.map((s) => s.name))
  // Only upstreams that are actually in this list can order it.
  const waitingOn = new Map<string, Set<string>>()
  for (const s of stages) {
    waitingOn.set(s.name, new Set((s.upstream ?? []).filter((u) => present.has(u) && u !== s.name)))
  }

  const out: kargo.Stage[] = []
  const placed = new Set<string>()
  const remaining = [...stages]

  while (remaining.length) {
    // The first stage whose upstreams are all placed — first, so equal
    // candidates keep their incoming order.
    const i = remaining.findIndex((s) => [...waitingOn.get(s.name)!].every((u) => placed.has(u)))
    if (i === -1) break // a cycle, or an unreachable dependency
    const [next] = remaining.splice(i, 1)
    out.push(next)
    placed.add(next.name)
  }

  // Anything a cycle left behind still has to be shown.
  return [...out, ...remaining]
}

/**
 * What a stage's status badge should say.
 *
 * Kargo deprecated `status.phase`; on a current cluster every stage reports
 * `NotApplicable`, which is what the pipeline card was displaying for all of
 * them — a word that tells the reader nothing about a stage that is in fact
 * healthy and carrying verified freight. `status.health` is where the signal
 * moved, so it is read first and the phase is the fallback for older clusters.
 */
export function stageStatus(
  s: Pick<kargo.Stage, 'phase' | 'health'>,
): { label: string; kind: 'healthy' | 'progressing' | 'failed' | 'unknown' } {
  const health = s.health
  if (health === 'Healthy') return { label: 'Healthy', kind: 'healthy' }
  if (health === 'Progressing') return { label: 'Progressing', kind: 'progressing' }
  if (health === 'Unhealthy') return { label: 'Unhealthy', kind: 'failed' }

  switch (s.phase) {
    case 'Steady':
      return { label: 'Steady', kind: 'healthy' }
    case 'Promoting':
      return { label: 'Promoting', kind: 'progressing' }
    case 'Verifying':
      return { label: 'Verifying', kind: 'progressing' }
    case 'Failed':
    case 'Erroring':
      return { label: s.phase, kind: 'failed' }
    case 'Pending':
      return { label: 'Pending', kind: 'unknown' }
    default:
      // `NotApplicable` is Kargo saying "this field no longer applies", not a
      // state. For a stage with no freight yet, that is what to say.
      return { label: 'No freight', kind: 'unknown' }
  }
}

/** A freight id shortened the way a commit is, with the full value on hover. */
export function shortFreight(id?: string): string {
  if (!id) return '—'
  return id.length > 12 ? id.slice(0, 12) : id
}
