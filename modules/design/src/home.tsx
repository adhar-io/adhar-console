import { PageHeader } from '@adhar/shell-ui'
import { Dashboard } from './views/dashboard.tsx'
import { Adrs } from './views/adrs.tsx'
import { Diagrams } from './views/diagrams.tsx'
import { Whiteboard } from './views/whiteboard.tsx'
import { Personas } from './views/personas.tsx'
import { Journeys } from './views/journeys.tsx'
import { Wireframes } from './views/wireframes.tsx'
import { Tokens } from './views/tokens.tsx'
import { ApiSchemas } from './views/api-schemas.tsx'
import { Catalog } from './views/catalog.tsx'
import { Builder } from './views/builder.tsx'
import { ScopePicker } from './components/scope-picker.tsx'

/** Sections narrowed by the project scope (Org → Team → Project) — they show the picker. */
const PROJECT_SCOPED = new Set<string>(['dashboard', 'personas', 'journeys', 'wireframes', 'tokens', 'catalog'])

type Section =
  | 'dashboard'
  | 'adrs'
  | 'diagrams'
  | 'whiteboard'
  | 'personas'
  | 'journeys'
  | 'wireframes'
  | 'tokens'
  | 'api-schemas'
  | 'catalog'
  | 'builder'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Design Dashboard',
    description: 'Design work per project — coverage of each application, reviews, Plane work items, pull requests and recent activity.',
  },
  adrs: {
    label: 'ADRs',
    description: 'Architecture decision records — propose, debate, accept, supersede.',
  },
  diagrams: {
    label: 'Diagrams',
    description: 'Mermaid system diagrams rendered from canonical sources in Gitea.',
  },
  whiteboard: {
    label: 'Whiteboard',
    description: 'Sticky-note canvas for brainstorming and discovery — drag, recolor, archive.',
  },
  personas: {
    label: 'Personas',
    description: 'Target user personas with goals, frustrations, and behaviors.',
  },
  journeys: {
    label: 'Journey Maps',
    description: 'End-to-end user journeys with stages, emotions, touchpoints, and opportunities.',
  },
  wireframes: {
    label: 'Wireframes',
    description: 'Screen wireframes and flow diagrams for prototyping experiences.',
  },
  tokens: {
    label: 'Design Tokens',
    description: 'Color, spacing, typography, motion, elevation, and breakpoint primitives.',
  },
  'api-schemas': {
    label: 'API & Schemas',
    description: 'OpenAPI-driven API design — endpoints grouped by tag and component schemas.',
  },
  catalog: {
    label: 'Component Catalog',
    description: 'Live reference for @adhar/shell-ui, plus each project\'s own components discovered from its repositories.',
  },
  builder: {
    label: 'Visual Designer',
    description: 'Edit the React apps in your repositories visually — reviewed commits and pull requests.',
  },
}

export default function DesignHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  return (
    <div className="space-y-6">
      {active === 'builder' ? null : <PageHeader title={def.label} actions={PROJECT_SCOPED.has(active) ? <ScopePicker /> : undefined} />}
      {active === 'dashboard' && <Dashboard />}
      {active === 'adrs' && <Adrs />}
      {active === 'diagrams' && <Diagrams />}
      {active === 'whiteboard' && <Whiteboard />}
      {active === 'personas' && <Personas />}
      {active === 'journeys' && <Journeys />}
      {active === 'wireframes' && <Wireframes />}
      {active === 'tokens' && <Tokens />}
      {active === 'api-schemas' && <ApiSchemas />}
      {active === 'catalog' && <Catalog />}
      {active === 'builder' && <Builder />}
    </div>
  )
}
