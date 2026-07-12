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
