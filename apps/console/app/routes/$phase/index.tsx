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
  // The Performance Center moved from Develop to Deliver.
  if (phase === 'develop' && search.section === 'performance') {
    return <Navigate to="/deliver" search={{ ...(search as Record<string, unknown>), section: 'performance' } as never} replace />
  }
  // Owned by the Develop module (k6 runner, test suite), shown under Deliver.
  if (phase === 'deliver' && search.section === 'performance') {
    return <RemoteModule key="performance" loader={loadPerformance} label="Performance Center" />
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
    <RemoteModule
      loader={() => loaderFor(phase)}
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
