import { SceneFrame } from './scene-frame.tsx'
import { MaintenanceFallback, SupplyChainFallback } from './scene-fallback.tsx'

export function SupplyChainScene({ className }: { className?: string }) {
  return (
    <SceneFrame
      className={className}
      label='Three-dimensional animation of the software supply chain: commits leave a source repository, are built into images, pass a scan-and-sign gate, clear dev, stage and prod promotion gates, land on a cluster that lights up, and dissolve into observability, whose signals flow back to the start.'
      load={() => import('./supply-chain-canvas.tsx')}
      fallback={<SupplyChainFallback />}
    />
  )
}

export function MaintenanceScene({ className }: { className?: string }) {
  return (
    <SceneFrame
      className={className}
      label='Three-dimensional view of the platform in maintenance: the control-plane tier glowing amber with a diagnostic ring sweeping it, and a turning gear train with a spanner.'
      load={() => import('./maintenance-canvas.tsx')}
      fallback={<MaintenanceFallback />}
    />
  )
}
