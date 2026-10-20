/**
 * Shared types for the Design module. These are intentionally framework-free
 * so the views and the eventual BFF can both consume them without circular
 * imports.
 */

export type AdrStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated' | 'rejected'

export interface Adr {
  id: string
  number: number
  title: string
  status: AdrStatus
  authors: string[]
  updated_at: string
  repo: string
  context: string
  decision: string
  consequences: string
  tags: string[]
}

export interface Persona {
  id: string
  name: string
  avatar: string
  role: string
  bio: string
  goals: string[]
  frustrations: string[]
  behaviors: string[]
  needs: string[]
  tech: string[]
  /** A representative quote, in the persona's own words. */
  quote?: string
  /** Jobs-to-be-done ("When …, I want to …, so I can …"). */
  jobs?: string[]
  /** Avatar colour key (see the Personas view palette) for initials avatars. */
  color?: string
  /** Free-form segment / tag labels used for filtering. */
  tags?: string[]
  /** Location / context line (e.g. "Bengaluru · hybrid"). */
  location?: string
  /** Tenancy tag — the Adhar project (and team) this persona belongs to. */
  project?: string
  team?: string
  /** Plane work items created from this persona (e.g. from its jobs). */
  planeLinks?: PlaneLink[]
  /** Product-analytics evidence: a PostHog cohort this persona represents. */
  evidence?: AnalyticsEvidence
}

export type JourneyEmotion =
  | 'curious'
  | 'cautious'
  | 'focused'
  | 'excited'
  | 'satisfied'
  | 'stressed'
  | 'urgent'
  | 'reflective'
  | 'frustrated'

export interface JourneyStage {
  id: string
  name: string
  emotion: JourneyEmotion
  actions: string[]
  thoughts: string[]
  pains: string[]
  opportunities: string[]
  /** Channels / surfaces the user touches in this stage. */
  touchpoints?: string[]
  /** Fine-grained emotion score, -2 (very negative) … +2 (very positive). */
  score?: number
  /** Catalog components (platform Application names) that serve this stage. */
  components?: string[]
  /** PostHog events that mark reaching this stage (funnel steps, in order). */
  events?: string[]
}

export interface Journey {
  id: string
  name: string
  persona: string
  summary: string
  stages: JourneyStage[]
  /** What the persona is trying to achieve across the journey. */
  goal?: string
  tags?: string[]
  /** Tenancy tag — the Adhar project (and team) this journey belongs to. */
  project?: string
  team?: string
  /** Plane work items created from pain points / opportunities. */
  planeLinks?: PlaneLink[]
  /** Optional cohort the funnel is narrowed to. */
  evidence?: AnalyticsEvidence
}

export type StickyColor = 'amber' | 'rose' | 'sky' | 'violet' | 'emerald' | 'slate'

export interface StickyNote {
  id: string
  text: string
  color: StickyColor
  x: number
  y: number
  author: string
}

export type WireframeBlockType =
  | 'logo'
  | 'h1'
  | 'h2'
  | 'text'
  | 'input'
  | 'button'
  | 'card'
  | 'image'
  | 'avatar'
  | 'tag'
  | 'divider'
  | 'navbar'
  | 'sidebar'
  | 'search'
  | 'toggle'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'link'
  | 'list'
  | 'table'
  | 'tabs'
  | 'stat'
  | 'chart'
  | 'icon'
  | 'footer'
  | 'badge'
  | 'alert'
  | 'breadcrumb'

export interface WireframeBlock {
  type: WireframeBlockType
  x: number
  y: number
  w: number
  h: number
  label?: string
}

export interface Wireframe {
  id: string
  flow: string
  name: string
  order: number
  notes?: string
  blocks: WireframeBlock[]
  /** The full Visual Builder project, once the frame has been edited there. */
  builder?: unknown
  /** Tenancy tag — the Adhar project (and team) this frame belongs to. */
  project?: string
  team?: string
  /** The catalog component (platform Application) this screen is for. */
  component?: ComponentLink
  /** Plane work items tracking this screen. */
  planeLinks?: PlaneLink[]
  /** Design review state. */
  review?: DesignReview
  /** Pull requests opened from this frame through the Visual Designer. */
  prs?: RepoPullRef[]
}

export type DiagramType =
  | 'flowchart'
  | 'sequence'
  | 'classDiagram'
  | 'stateDiagram'
  | 'erDiagram'
  | 'gantt'
  | 'mindmap'
  | 'C4Context'
  | 'journey'

export interface Diagram {
  id: string
  title: string
  type: DiagramType
  source: string
  tags: string[]
  created_at: string
  updated_at: string
}

/* ───── API / schema design ───── */

export interface ApiSpec {
  id: string
  name: string
  version: string
  description: string
  /** Raw OpenAPI document — JSON or (best-effort) YAML text. */
  document: string
  created_at: string
  updated_at: string
}

/* ───── Design tokens ───── */

export interface ColorToken {
  name: string
  value: string
  role: string
  /** Dark-mode value; absent means the light value is used in both modes. */
  dark?: string
}
export interface ValueToken {
  name: string
  value: string
}
export interface MotionToken {
  name: string
  value: string
  curve: string
}
export interface BreakpointToken {
  name: string
  value: string
  label: string
}

export interface TokenSet {
  color: ColorToken[]
  spacing: ValueToken[]
  typography: ValueToken[]
  radius: ValueToken[]
  elevation: ValueToken[]
  motion: MotionToken[]
  breakpoint: BreakpointToken[]
}

export interface NoteConnection {
  from: string
  to: string
}

export interface WhiteboardBoard {
  id: string
  name: string
  notes: StickyNote[]
  connections: NoteConnection[]
  created_at: string
  updated_at: string
}

/** A saved, restorable copy of the workspace token set (kind `design.token-snapshot`). */
export interface TokenSnapshot {
  id: string
  label: string
  created_at: string
  /** Number of tokens in the snapshot (for the history list). */
  count: number
  tokens: TokenSet
  /** Project the snapshot was taken in (absent = workspace set). */
  project?: string
}

/* ───── Adhar platform integration (tenancy, Plane, PostHog, Gitea) ───── */

/** The tenancy tag carried by project-scoped design artifacts. */
export interface ScopeTag {
  /** Adhar workspace project slug; absent = workspace-wide. */
  project?: string
  /** Team slug that owned the active lens when the artifact was created. */
  team?: string
}

/** A Plane work item created from (or linked to) a design artifact. */
export interface PlaneLink {
  /** Plane project id. */
  projectId: string
  /** Plane issue (work item) id. */
  issueId: string
  /** `KEY-123` when known. */
  key?: string
  /** Name at creation time — live name/state are read from Plane. */
  name: string
  /** What it came from, e.g. `pain:<stageId>:<text>` or `job:<text>`. */
  source: string
  createdAt: string
  /** True for the parent ("epic") item a bulk creation grouped under. */
  parent?: boolean
}

/** Product-analytics evidence attached to a persona or journey. */
export interface AnalyticsEvidence {
  cohortId?: number | string
  cohortName?: string
  /** Funnel conversion window in days (journeys). */
  windowDays?: number
  /** Date range for the funnel, PostHog form (`-30d`). */
  range?: string
}

/** A catalog component (platform Application) reference. */
export interface ComponentLink {
  /** Application name (catalog entity name). */
  name: string
  /** Gitea repository, `owner/name`, when the application declares one. */
  repo?: string
  project?: string
}

export type ReviewState = 'draft' | 'in-review' | 'approved' | 'changes-requested'

export interface DesignReview {
  state: ReviewState
  /** Who requested / decided, and when. */
  requestedBy?: string | null
  requestedAt?: string
  decidedBy?: string | null
  decidedAt?: string
  note?: string
}

/** A pull request in a Gitea repository opened from a design artifact. */
export interface RepoPullRef {
  /** `owner/name`. */
  repo: string
  number: number
  branch?: string
  base?: string
  url?: string
  createdAt: string
}

/** Project-scoped token overrides (kind `design.token-set`, id `project:<slug>`). */
export type TokenOverrides = Partial<TokenSet>

/** Where a token set was published, and the PRs it opened (kind `design.token-publish`). */
export interface TokenPublishRecord {
  /** `owner/name`. */
  repo: string
  base: string
  /** Folder the files are written into. */
  dir: string
  branch: string
  number?: number
  url?: string
  /** Snapshot (version) id tagged on publish. */
  versionId?: string
  versionLabel?: string
  at: string
  by?: string | null
}

export interface TokenPublishDoc {
  /** Last publish settings, reused as defaults. */
  repo?: string
  base?: string
  dir?: string
  history: TokenPublishRecord[]
}

/** Per-scope Design settings (kind `design.settings`, id = project slug or `workspace`). */
export interface DesignSettings {
  /** Plane project work items are created in. */
  planeProjectId?: string
}
