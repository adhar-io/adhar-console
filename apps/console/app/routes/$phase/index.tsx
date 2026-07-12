import { createFileRoute, useSearch } from '@tanstack/react-router'
import { RemoteModule } from '@adhar-console/mf-utils'
import type { Phase } from '@adhar-console/shell-ui'

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
  return (
    <RemoteModule
      loader={() => loaderFor(phase)}
      label={PHASE_LABEL[phase]}
      componentProps={{ section: search.section }}
    />
  )
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
