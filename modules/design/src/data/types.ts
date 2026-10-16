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
}
