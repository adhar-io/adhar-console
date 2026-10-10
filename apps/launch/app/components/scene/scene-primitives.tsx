import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'

/* Brand palette the scenes share. Hexes, because three materials want them. */
export const BRAND = {
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  amber: '#f59e0b',
  emerald: '#10b981',
  slate: '#94a3b8',
  ink: '#0f172a',
  /* light-scene materials */
  stone: '#ffffff',
  steel: '#9fb3d1',
  gold: '#f2c14e',
  goldDeep: '#d9a440',
} as const

/**
 * A floating DOM label pinned to a point in the scene. Styled with the same
 * tokens as the page, so it flips theme with everything else and uses the
 * app's font instead of a baked-in SDF glyph set.
 */
export function Tag({
  position,
  children,
  tone = 'neutral',
  size = 'sm',
  hidden = false,
}: {
  position: [number, number, number]
  children: React.ReactNode
  tone?: 'neutral' | 'brand' | 'amber' | 'emerald' | 'violet'
  size?: 'xs' | 'sm' | 'md'
  hidden?: boolean
}) {
  const toneCls = {
    neutral: 'border-edge-default bg-surface-raised/90 text-content',
    brand:
      'border-brand-500/40 bg-brand-50/90 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200',
    amber:
      'border-amber-500/40 bg-amber-50/90 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
    emerald:
      'border-emerald-500/40 bg-emerald-50/90 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200',
    violet:
      'border-violet-500/40 bg-violet-50/90 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200',
  }[tone]
  const sizeCls =
    { xs: 'text-[10px] px-1.5 py-0.5', sm: 'text-xs px-2 py-1', md: 'text-sm px-2.5 py-1' }[size]
  if (hidden) return null
  return (
    <Html position={position} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <span
        className={`whitespace-nowrap rounded-md border font-medium shadow-sm backdrop-blur ${toneCls} ${sizeCls}`}
      >
        {children}
      </span>
    </Html>
  )
}

/**
 * drei's `Html` loses the first instance mounted in a scene (observed with
 * drei 10 on React 19: whichever label renders first never reaches the DOM,
 * every later one does). Mount this once, first, so the casualty is an empty
 * hidden element instead of a real label.
 */
export function HtmlSacrifice() {
  return (
    <Html position={[0, -100, 0]} style={{ display: 'none' }}>
      <span aria-hidden />
    </Html>
  )
}

/** Slow idle rotation for a group; stops under reduced motion. */
export function Spin({
  speed = 0.08,
  enabled = true,
  children,
}: {
  speed?: number
  enabled?: boolean
  children: React.ReactNode
}) {
  const ref = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (enabled && ref.current) ref.current.rotation.y += dt * speed
  })
  return <group ref={ref}>{children}</group>
}

/** Gentle side-to-side sway for a group — the camera appears to breathe. */
export function Sway({
  amplitude = 0.1,
  speed = 0.12,
  enabled = true,
  children,
}: {
  amplitude?: number
  speed?: number
  enabled?: boolean
  children: React.ReactNode
}) {
  const ref = useRef<THREE.Group>(null)
  const t = useRef(0)
  useFrame((_, dt) => {
    if (!enabled || !ref.current) return
    t.current += dt
    ref.current.rotation.y = Math.sin(t.current * speed) * amplitude
  })
  return <group ref={ref}>{children}</group>
}

/* ───────────────────────────── Geometry ────────────────────────────────── */

/** A flat ribbon of `width` laid along `curve`, hugging the ground. */
export function ribbonGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  width: number,
  segments = 200,
): THREE.BufferGeometry {
  const pos: number[] = []
  const idx: number[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const side = new THREE.Vector3()
  for (let i = 0; i <= segments; i++) {
    const u = i / segments
    const p = curve.getPointAt(u)
    const t = curve.getTangentAt(u)
    side.crossVectors(up, t).normalize().multiplyScalar(width / 2)
    pos.push(p.x + side.x, p.y, p.z + side.z, p.x - side.x, p.y, p.z - side.z)
    if (i < segments) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** An extruded gear with `teeth` teeth and a hub hole. */
export function gearGeometry(teeth: number, outer: number, depth: number): THREE.ExtrudeGeometry {
  const inner = outer * 0.82
  const shape = new THREE.Shape()
  const steps = teeth * 4
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    const phase = i % 4
    const r = phase === 0 || phase === 3 ? inner : outer
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    if (i === 0) shape.moveTo(x, y)
    else shape.lineTo(x, y)
  }
  shape.closePath()
  const hole = new THREE.Path()
  hole.absarc(0, 0, outer * 0.28, 0, Math.PI * 2, true)
  shape.holes.push(hole)
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2,
  })
  geo.center()
  return geo
}
