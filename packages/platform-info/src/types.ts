export interface BackingTool {
  id: string
  name: string
  purpose: string
  version: string
  homepage: string
  sourceRepo: string
  license: string
  health: ServiceHealth
  docsUrl?: string
}

export type ServiceHealth = 'operational' | 'degraded' | 'partial-outage' | 'outage' | 'unknown'

export interface PlatformVersion {
  console: string
  api: string
  built: string
  commit: string
  released: string
}

export interface ChangelogEntry {
  version: string
  date: string
  highlights: string[]
  prUrls?: string[]
}

export interface RoadmapItem {
  title: string
  status: 'shipped' | 'in-progress' | 'planned'
  target: string
}

/** A marquee platform capability, showcased on the What's New page. */
export interface FeatureHighlight {
  title: string
  description: string
  /** Icon key rendered by the UI (see What's New page icon map). */
  icon:
    | 'catalog'
    | 'pipeline'
    | 'gitops'
    | 'logs'
    | 'shell'
    | 'resources'
    | 'observability'
    | 'security'
    | 'editor'
    | 'scorecard'
  /** Short category tag (e.g. "Develop", "Deliver", "Platform"). */
  category: string
  /** Highlight as newly shipped. */
  isNew?: boolean
}
