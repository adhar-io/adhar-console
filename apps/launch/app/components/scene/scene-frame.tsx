import {
  Component,
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from 'react'
import { cn } from '@adhar/utils'
import { supportsWebGL } from './use-color-mode.ts'

/**
 * Hosts a lazily-loaded three.js scene with every failure mode handled:
 *
 *  - the three/fiber chunk is only fetched once the frame mounts, so the
 *    page's first paint never waits on ~600 KB of renderer;
 *  - no WebGL (old GPU, headless capture, locked-down kiosk) → the static
 *    fallback renders instead of a blank box;
 *  - a renderer crash (context lost, shader failure) is caught by the
 *    boundary and swaps to the same fallback rather than taking the page down.
 */
export function SceneFrame({
  load,
  fallback,
  className,
  label,
}: {
  load: () => Promise<{ default: ComponentType }>
  fallback: ReactNode
  className?: string
  /** Accessible description of what the picture shows. */
  label: string
}) {
  const [webgl, setWebgl] = useState<boolean | null>(null)
  useEffect(() => setWebgl(supportsWebGL()), [])
  const [Scene] = useState(() => lazy(load))

  return (
    <div className={cn('scene-host', className)} role='img' aria-label={label}>
      {webgl === false
        ? fallback
        : webgl === null
        ? <div className='skeleton-shimmer absolute inset-0 opacity-40' />
        : (
          <SceneBoundary fallback={fallback}>
            <Suspense fallback={<div className='skeleton-shimmer absolute inset-0 opacity-40' />}>
              <Scene />
            </Suspense>
          </SceneBoundary>
        )}
    </div>
  )
}

class SceneBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(err: unknown) {
    console.warn('[launch] 3D scene failed, showing fallback:', err)
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
