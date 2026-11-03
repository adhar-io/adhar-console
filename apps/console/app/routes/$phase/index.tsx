import { createFileRoute, redirect, useSearch } from '@tanstack/react-router'
import { RemoteModule } from '@adhar/mf-utils'
import type { Phase } from '@adhar/shell-ui'
import { legacyRedirect } from '~/data/legacy-redirects.ts'

export const Route = createFileRoute('/$phase/')({
  // Moved pages are redirected before render — see legacy-redirects.ts for
  // why not with a rendered <Navigate>.
  beforeLoad: ({ params, search }) => {
    const r = legacyRedirect((params as { phase: string }).phase, search as Record<string, unknown>)
    if (r) throw redirect({ to: r.to, search: r.search as never, replace: true })
  },
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
  // Owned by the Develop module (k6 runner, test suite), shown under Deliver.
  if (phase === 'deliver' && search.section === 'performance') {
    return <RemoteModule key="performance" loader={loadPerformance} label="Performance Center" />
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
