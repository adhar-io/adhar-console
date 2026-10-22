import { lazy, Suspense } from 'react'
import { PageHeader, Spinner } from '@adhar/shell-ui'
import { ScopePicker } from './components/scope-picker.tsx'

// One chunk per section: the remote's entry used to carry every view (the
// Visual Designer engine, whiteboard, OpenAPI editor…) — ~1 MB before the
// first paint of whichever single section the URL asked for.
const Dashboard = lazy(() => import('./views/dashboard.tsx').then((m) => ({ default: m.Dashboard })))
const Adrs = lazy(() => import('./views/adrs.tsx').then((m) => ({ default: m.Adrs })))
const Diagrams = lazy(() => import('./views/diagrams.tsx').then((m) => ({ default: m.Diagrams })))
const Whiteboard = lazy(() => import('./views/whiteboard.tsx').then((m) => ({ default: m.Whiteboard })))
const Personas = lazy(() => import('./views/personas.tsx').then((m) => ({ default: m.Personas })))
const Journeys = lazy(() => import('./views/journeys.tsx').then((m) => ({ default: m.Journeys })))
const Wireframes = lazy(() => import('./views/wireframes.tsx').then((m) => ({ default: m.Wireframes })))
const Tokens = lazy(() => import('./views/tokens.tsx').then((m) => ({ default: m.Tokens })))
const ApiSchemas = lazy(() => import('./views/api-schemas.tsx').then((m) => ({ default: m.ApiSchemas })))
const Catalog = lazy(() => import('./views/catalog.tsx').then((m) => ({ default: m.Catalog })))
const Builder = lazy(() => import('./views/builder.tsx').then((m) => ({ default: m.Builder })))

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

/** Shown while a section's chunk downloads (spinner only — no status text). */
function SectionFallback() {
  return <div className="flex justify-center py-16 text-content-subtle" aria-busy="true"><Spinner size={16} /></div>
}

export default function DesignHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  return (
    <div className="space-y-6">
      {active === 'builder' ? null : <PageHeader title={def.label} actions={PROJECT_SCOPED.has(active) ? <ScopePicker /> : undefined} />}
      <Suspense fallback={<SectionFallback />}>
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
      </Suspense>
    </div>
  )
}
