import type { kargo } from '@adhar-console/api-clients'
import { orderStages } from './stage-order.ts'

/**
 * The promotion chain, as the thing an operator calls "our environments".
 *
 * On this platform an environment is a Kargo Stage — `dev`, `test`, `prod`,
 * each one a directory of config in the environments repository that a
 * promotion copies forward. The Environments page was instead listing every
 * `(cluster, namespace)` pair Argo CD deploys into, which on this install
 * reports `adhar-system` and `default`: both true, neither an environment.
 * The stages live in their own namespace (`adhar-environments`), so matching a
 * stage to a workload namespace never found one either.
 *
 * `upstream` says where a stage takes freight from. What a reader wants is
 * both directions — what feeds this, and what this feeds — so the reverse edge
 * is computed here rather than in a render.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export interface ChainLink {
  stage: kargo.Stage
  /** Position in promotion order, 0 first. */
  index: number
  /** Stages this one promotes from. Empty means it is fed by a warehouse. */
  upstream: string[]
  /** Stages that promote from this one. */
  downstream: string[]
  /** No upstream — the entry point of the chain. */
  isEntry: boolean
  /** Nothing promotes out of it — as close to "production" as the data says. */
  isTerminal: boolean
}

export function promotionChain(stages: kargo.Stage[]): ChainLink[] {
  const ordered = orderStages(stages)
  const present = new Set(ordered.map((s) => s.name))

  const downstream = new Map<string, string[]>()
  for (const s of ordered) {
    for (const up of s.upstream ?? []) {
      // Only edges to stages in this list; a stage in another project is not
      // part of this chain and must not appear as a phantom neighbour.
      if (!present.has(up) || up === s.name) continue
      downstream.set(up, [...(downstream.get(up) ?? []), s.name])
    }
  }

  return ordered.map((stage, index) => {
    const upstream = (stage.upstream ?? []).filter((u) => present.has(u) && u !== stage.name)
    const down = downstream.get(stage.name) ?? []
    return {
      stage,
      index,
      upstream,
      downstream: down,
      isEntry: upstream.length === 0,
      isTerminal: down.length === 0,
    }
  })
}

/** How a stage receives freight, in words a card can print. */
export function promotesFrom(link: ChainLink): string {
  if (link.upstream.length === 0) {
    return link.stage.warehouse ? `warehouse ${link.stage.warehouse}` : 'a warehouse'
  }
  return link.upstream.join(', ')
}

/** Whether the chain is carrying the same freight end to end. */
export interface ChainDrift {
  /** Stages holding freight that is not the newest in the chain. */
  behind: string[]
  /** Stages carrying no freight at all. */
  empty: string[]
  /** The freight the entry stage is holding, which is the newest promoted. */
  leading?: string
}

export function chainDrift(links: ChainLink[]): ChainDrift {
  const leading = links.find((l) => l.isEntry)?.stage.currentFreight
  const behind: string[] = []
  const empty: string[] = []
  for (const l of links) {
    const freight = l.stage.currentFreight
    if (!freight) {
      empty.push(l.stage.name)
      continue
    }
    if (leading && freight !== leading) behind.push(l.stage.name)
  }
  return { behind, empty, leading }
}
