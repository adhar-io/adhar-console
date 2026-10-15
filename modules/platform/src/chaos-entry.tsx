import { PageHeader } from '@adhar/shell-ui'
import { ConnectionGate } from './components/connection-banner.tsx'
import { ClusterProvider } from './components/cluster-picker.tsx'
import { ChaosView } from './views/chaos.tsx'
import { useActiveNamespace } from './data/client.ts'

/**
 * Chaos Engineering as its own federated entry.
 *
 * The page sits in the Deliver sidebar (`/deliver?section=chaos`) — proving a
 * release survives failure is part of delivering it — while its code stays
 * here, on the cluster data layer it is built on (Litmus CRDs, the cluster
 * picker). The host loads this entry for that one Deliver section, so there
 * is a single implementation.
 */
export default function PlatformChaos() {
  const { namespace } = useActiveNamespace()
  return (
    <ClusterProvider>
      <div className="space-y-6">
        <PageHeader title="Chaos Engineering" />
        <ConnectionGate>
          <ChaosView namespace={namespace} />
        </ConnectionGate>
      </div>
    </ClusterProvider>
  )
}
