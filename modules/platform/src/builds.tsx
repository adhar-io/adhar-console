import { PageHeader } from '@adhar/shell-ui'
import { ConnectionGate } from './components/connection-banner.tsx'
import { ClusterProvider } from './components/cluster-picker.tsx'
import { CiRunsView } from './views/ci-runs.tsx'
import { useActiveNamespace } from './data/client.ts'

/**
 * Builds (Tekton) as its own federated entry.
 *
 * The page sits in the Develop sidebar (`/develop?section=builds`) — builds
 * are where developers watch their changes — but its code stays here with
 * the rest of the cluster surface it is built on (live lists, logs, the
 * cluster picker). The host loads this entry for that one Develop section,
 * so there is a single implementation and no copy to drift.
 */
export default function PlatformBuilds() {
  const { namespace } = useActiveNamespace()
  return (
    <ClusterProvider>
      <div className="space-y-6">
        <PageHeader title="Builds" />
        <ConnectionGate>
          <CiRunsView namespace={namespace} />
        </ConnectionGate>
      </div>
    </ClusterProvider>
  )
}
