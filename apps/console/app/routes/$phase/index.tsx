import { createFileRoute, Navigate, useSearch } from '@tanstack/react-router'
import { RemoteModule } from '@adhar/mf-utils'
import type { Phase } from '@adhar/shell-ui'

export const Route = createFileRoute('/$phase/')({
  component: PhaseLanding,
})

const PHASE_LABEL: Record<Phase, string> = {
  define: 'Define',
  design: 'Design',
  develop: 'Develop',
  deliver: 'Deliver',
  discover: 'Discover',
  decide: 'Decide',
  platform: 'Platform',
}

function PhaseLanding() {
  const { phase } = Route.useParams() as { phase: Phase }
  const search = useSearch({ from: '/$phase' }) as { section?: string }
  // Builds moved from Platform to Develop. Old links (bookmarks, notification
  // hrefs) still say /platform?section=ci — send them to the new home.
  if (phase === 'platform' && search.section === 'ci') {
    return <Navigate to="/develop" search={{ section: 'builds' } as never} replace />
  }
  // Code Builder was retired; the Visual Designer in Design replaces it.
  if (phase === 'develop' && search.section === 'codebuilder') {
    return <Navigate to="/design" search={{ section: 'builder' } as never} replace />
  }
  // The Performance Center moved from Develop to Deliver.
  if (phase === 'develop' && search.section === 'performance') {
    return <Navigate to="/deliver" search={{ ...(search as Record<string, unknown>), section: 'performance' } as never} replace />
  }
  // Owned by the Develop module (k6 runner, test suite), shown under Deliver.
  if (phase === 'deliver' && search.section === 'performance') {
    return <RemoteModule key="performance" loader={loadPerformance} label="Performance Center" />
  }
  // Functions are managed in Develop; Deliver shows the same view in delivery
  // mode (drawer on the Delivery tab), so there is one table, not two.
  if (phase === 'deliver' && search.section === 'functions') {
    return <RemoteModule key="functions" loader={loadFunctions} label="Functions" />
  }
  // Chaos Engineering moved from Platform to Deliver.
  if (phase === 'platform' && search.section === 'chaos') {
    return <Navigate to="/deliver" search={{ section: 'chaos' } as never} replace />
  }
  // Owned by the Platform module (Litmus CRDs, cluster picker), shown under Deliver.
  if (phase === 'deliver' && search.section === 'chaos') {
    return <RemoteModule key="chaos" loader={loadChaos} label="Chaos Engineering" />
  }
  // The Builds page is owned by the Platform module (it is built on its
  // cluster data layer) but lives in the Develop sidebar.
  if (phase === 'develop' && search.section === 'builds') {
    return <RemoteModule key="builds" loader={loadBuilds} label="Builds" />
  }
  return (
    // Keyed by phase so a remote that failed to load (its ErrorBoundary is
    // latched on the error) does not keep showing that failure after the user
    // switches to another phase.
    <RemoteModule
      key={phase}
      loader={LOADERS[phase]}
      label={PHASE_LABEL[phase]}
      componentProps={{ section: search.section }}
    />
  )
}

function loadBuilds(): Promise<{ default: React.ComponentType }> {
  return import('platform/Builds') as Promise<{ default: React.ComponentType }>
}

function loadPerformance(): Promise<{ default: React.ComponentType }> {
  return import('develop/Performance') as Promise<{ default: React.ComponentType }>
}

function loadFunctions(): Promise<{ default: React.ComponentType }> {
  return import('develop/Functions') as Promise<{ default: React.ComponentType }>
}

function loadChaos(): Promise<{ default: React.ComponentType }> {
  return import('platform/Chaos') as Promise<{ default: React.ComponentType }>
}

/**
 * One loader function per phase, created once at module load.
 *
 * `RemoteModule` memoises its `React.lazy` on the loader's identity. An inline
 * `() => loaderFor(phase)` was a new function on every render of this
 * component — and it re-renders on every search change, i.e. every deep-link
 * click inside a module (`?repo=`, `?tab=`, `?pr=`…). Each click therefore
 * built a new lazy component type: React unmounted the whole remote, suspended
 * on the import again, flashed the module skeleton and remounted it from
 * scratch, dropping every piece of local state (search text, filters, open
 * menus) and re-running every query observer. Stable references keep the
 * remote mounted; only its `section` prop changes.
 */
const LOADERS: Record<Phase, () => Promise<{ default: React.ComponentType }>> = {
  define: () => loaderFor('define'),
  design: () => loaderFor('design'),
  develop: () => loaderFor('develop'),
  deliver: () => loaderFor('deliver'),
  discover: () => loaderFor('discover'),
  decide: () => loaderFor('decide'),
  platform: () => loaderFor('platform'),
}

/**
 * Static loader map so `@module-federation/vite` can statically transform each
 * `import()` call. Dynamic identifiers would defeat the transform.
 */
function loaderFor(phase: Phase): Promise<{ default: React.ComponentType }> {
  switch (phase) {
    case 'define':
      return import('define/Home') as Promise<{ default: React.ComponentType }>
    case 'design':
      return import('design/Home') as Promise<{ default: React.ComponentType }>
    case 'develop':
      return import('develop/Home') as Promise<{ default: React.ComponentType }>
    case 'deliver':
      return import('deliver/Home') as Promise<{ default: React.ComponentType }>
    case 'discover':
      return import('discover/Home') as Promise<{ default: React.ComponentType }>
    case 'decide':
      return import('decide/Home') as Promise<{ default: React.ComponentType }>
    case 'platform':
      return import('platform/Home') as Promise<{ default: React.ComponentType }>
  }
}
