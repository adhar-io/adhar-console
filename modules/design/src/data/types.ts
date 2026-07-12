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
}

export interface Journey {
  id: string
  name: string
  persona: string
  summary: string
  stages: JourneyStage[]
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
