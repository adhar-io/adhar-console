import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Float, Line, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { BRAND, gearGeometry, HtmlSacrifice, Spin, Tag } from './scene-primitives.tsx'
import { useIsDark, useReducedMotion } from './use-color-mode.ts'

/**
 * The platform in for service, drawn in the same light, white-and-blue
 * language as the launch scene: a round plate with a blue rim, the four
 * tiers of the stack as pale plates with the tier being worked on glowing
 * amber, a diagnostic ring sweeping the stack, and a meshed gear train
 * with a spanner — the universal sign that someone is in there working.
 */
export default function MaintenanceCanvas() {
  const reduced = useReducedMotion()
  return (
    <Canvas
      dpr={[1, 1.75]}
      shadows
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ position: [10, 7, 10], fov: 30 }}
      frameloop={reduced ? 'demand' : 'always'}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Lights />
      <HtmlSacrifice />
      <Spin enabled={!reduced} speed={0.06}>
        <Plate />
        <ServiceStack animate={!reduced} />
        <GearTrain animate={!reduced} position={[3.4, 1.6, 0.4]} />
        <Bolts animate={!reduced} />
      </Spin>
      <Ground />
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        minPolarAngle={Math.PI / 4}
        maxPolarAngle={Math.PI / 2.3}
        target={[0.8, 1.3, 0]}
        makeDefault
      />
    </Canvas>
  )
}

function Lights() {
  const dark = useIsDark()
  return (
    <>
      <hemisphereLight args={['#e4ecff', '#ffffff', dark ? 0.35 : 1.0]} />
      <ambientLight intensity={dark ? 0.3 : 0.7} />
      <directionalLight
        position={[8, 9, 7]}
        intensity={dark ? 1.2 : 2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={4}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-camera-near={1}
        shadow-camera-far={40}
      />
      <pointLight
        position={[0, 3, 0]}
        intensity={dark ? 14 : 6}
        color={BRAND.amber}
        distance={10}
        decay={2}
      />
    </>
  )
}

function Ground() {
  const dark = useIsDark()
  return (
    <mesh position={[0, -0.07, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[40, 40]} />
      <shadowMaterial
        color={dark ? '#000000' : '#1e2a5a'}
        transparent
        opacity={dark ? 0.5 : 0.28}
      />
    </mesh>
  )
}

/** The round plate everything stands on — the maintenance bay. */
function Plate() {
  const dark = useIsDark()
  const rim = useMemo(() => {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2
      pts.push(new THREE.Vector3(Math.cos(a) * 4.4, 0.01, Math.sin(a) * 4.4))
    }
    return pts
  }, [])
  return (
    <group position={[0.8, 0, 0]}>
      <mesh position={[0, -0.08, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[4.4, 4.6, 0.16, 96]} />
        <meshStandardMaterial
          color={dark ? '#232c4f' : '#e4ecfc'}
          emissive={dark ? '#000000' : '#ffffff'}
          emissiveIntensity={dark ? 0 : 0.16}
          roughness={0.6}
          metalness={0.05}
        />
      </mesh>
      <Line
        points={rim}
        color={BRAND.blue}
        lineWidth={1.6}
        transparent
        opacity={dark ? 0.7 : 0.55}
      />
      <mesh position={[0, -0.3, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[5.1, 96]} />
        <meshBasicMaterial
          color={BRAND.blue}
          transparent
          opacity={dark ? 0.14 : 0.1}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

/** The platform's tiers, bottom to top — only this scene needs them. */
const TIERS = [
  { id: 'infra', name: 'Infrastructure', color: '#60a5fa' },
  { id: 'platform', name: 'Platform services', color: '#3b82f6' },
  { id: 'control', name: 'Lifecycle control plane', color: '#6366f1' },
  { id: 'experience', name: 'Experience', color: '#8b5cf6' },
]
const TIER_H = 0.95
/** Index of the tier being serviced — the control plane. */
const SERVICE_TIER = 2

function ServiceStack({ animate }: { animate: boolean }) {
  const dark = useIsDark()
  const ring = useRef<THREE.Mesh>(null)
  const glow = useRef<THREE.MeshStandardMaterial>(null)
  const t = useRef(0)
  const top = TIERS.length * TIER_H
  useFrame((_, dt) => {
    if (!animate) return
    t.current += dt
    if (ring.current) {
      ring.current.position.y = 0.2 + (top - 0.5) * (0.5 + 0.5 * Math.sin(t.current * 0.7))
    }
    if (glow.current) glow.current.emissiveIntensity = 0.5 + 0.4 * Math.sin(t.current * 2.2)
  })
  return (
    <group>
      {TIERS.map((layer, i) => {
        const w = 3.4 - i * 0.4
        const servicing = i === SERVICE_TIER
        const y = 0.2 + i * TIER_H
        return (
          <group key={layer.id}>
            <mesh position={[0, y, 0]} castShadow receiveShadow>
              <boxGeometry args={[w, 0.22, w]} />
              {servicing
                ? (
                  <meshStandardMaterial
                    ref={glow}
                    color={BRAND.amber}
                    emissive={BRAND.amber}
                    emissiveIntensity={0.7}
                    roughness={0.4}
                  />
                )
                : (
                  <meshStandardMaterial
                    color='#ffffff'
                    emissive='#ffffff'
                    emissiveIntensity={dark ? 0 : 0.12}
                    roughness={0.55}
                  />
                )}
            </mesh>
            {/* coloured edge band per tier */}
            <mesh position={[0, y - 0.12, 0]}>
              <boxGeometry args={[w + 0.02, 0.04, w + 0.02]} />
              <meshBasicMaterial color={layer.color} transparent opacity={0.9} toneMapped={false} />
            </mesh>
            {/* columns between tiers */}
            {i < TIERS.length - 1 &&
              [-1, 1].flatMap((sx) =>
                [-1, 1].map((sz) => (
                  <mesh
                    key={`${sx}${sz}`}
                    position={[sx * (w / 2 - 0.35), y + TIER_H / 2, sz * (w / 2 - 0.35)]}
                    castShadow
                  >
                    <cylinderGeometry args={[0.05, 0.05, TIER_H - 0.22, 10]} />
                    <meshStandardMaterial color={BRAND.steel} roughness={0.45} metalness={0.2} />
                  </mesh>
                ))
              )}
            {/* service tier: side panels pulled out */}
            {servicing &&
              [-1, 1].map((sg) => (
                <mesh
                  key={sg}
                  position={[sg * (w / 2 + 0.55), y + 0.05, 0]}
                  rotation={[0, 0, sg * 0.35]}
                  castShadow
                >
                  <boxGeometry args={[0.9, 0.06, 0.9]} />
                  <meshStandardMaterial color='#ffffff' roughness={0.55} />
                </mesh>
              ))}
            {servicing && (
              <Tag position={[-w / 2 - 0.3, y + 0.25, w / 2 + 0.2]} tone='amber' size='xs'>
                {layer.name} · in service
              </Tag>
            )}
          </group>
        )
      })}
      {/* diagnostic sweep ring */}
      <mesh ref={ring} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.3, 0.025, 8, 72]} />
        <meshBasicMaterial color={BRAND.blue} transparent opacity={0.9} toneMapped={false} />
      </mesh>
    </group>
  )
}

/* ─────────────────────────────── Gears ─────────────────────────────────── */

function Gear({
  teeth,
  radius,
  color,
  position,
  speed,
  animate,
  phase = 0,
}: {
  teeth: number
  radius: number
  color: string
  position: [number, number, number]
  speed: number
  animate: boolean
  phase?: number
}) {
  const geo = useMemo(() => gearGeometry(teeth, radius, 0.28), [teeth, radius])
  const ref = useRef<THREE.Mesh>(null)
  useFrame((_, dt) => {
    if (animate && ref.current) ref.current.rotation.z += dt * speed
  })
  return (
    <mesh ref={ref} geometry={geo} position={position} rotation={[0, 0, phase]} castShadow>
      <meshStandardMaterial color={color} roughness={0.35} metalness={0.45} />
    </mesh>
  )
}

function GearTrain(
  { animate, position }: { animate: boolean; position: [number, number, number] },
) {
  // Pitch radii touch; angular speeds are inversely proportional to teeth so
  // the teeth genuinely mesh instead of clipping through each other.
  const big = { teeth: 16, r: 1.0 }
  const mid = { teeth: 10, r: 0.64 }
  const small = { teeth: 8, r: 0.52 }
  const base = 0.5
  return (
    <group position={position} rotation={[0, -Math.PI / 5, 0]}>
      <Gear
        teeth={big.teeth}
        radius={big.r}
        color={BRAND.indigo}
        position={[0, 0, 0]}
        speed={base}
        animate={animate}
      />
      <Gear
        teeth={mid.teeth}
        radius={mid.r}
        color={BRAND.violet}
        position={[(big.r + mid.r) * 0.93, 0, 0]}
        speed={-base * (big.teeth / mid.teeth)}
        phase={Math.PI / mid.teeth}
        animate={animate}
      />
      <Gear
        teeth={small.teeth}
        radius={small.r}
        color={BRAND.blue}
        position={[
          (big.r + small.r) * 0.93 * Math.cos(2.1),
          (big.r + small.r) * 0.93 * Math.sin(2.1),
          0,
        ]}
        speed={-base * (big.teeth / small.teeth)}
        phase={Math.PI / small.teeth}
        animate={animate}
      />
      {/* Spanner laid across the hub */}
      <group position={[0.1, -0.25, 0.32]} rotation={[0, 0, -0.5]}>
        <mesh castShadow>
          <boxGeometry args={[1.5, 0.12, 0.06]} />
          <meshStandardMaterial color='#cbd5e1' metalness={0.8} roughness={0.25} />
        </mesh>
        <mesh position={[0.8, 0, 0]} castShadow>
          <torusGeometry args={[0.16, 0.06, 8, 16]} />
          <meshStandardMaterial color='#cbd5e1' metalness={0.8} roughness={0.25} />
        </mesh>
      </group>
    </group>
  )
}

function Bolts({ animate }: { animate: boolean }) {
  const bolts = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => ({
        pos: [2.2 + Math.random() * 2.6, 0.6 + Math.random() * 2.4, -1.2 + Math.random() * 2.4] as [
          number,
          number,
          number,
        ],
        rot: [Math.random() * 3, Math.random() * 3, 0] as [number, number, number],
        k: i,
      })),
    [],
  )
  return (
    <group>
      {bolts.map((b) => (
        <Float
          key={b.k}
          speed={animate ? 1.2 : 0}
          rotationIntensity={animate ? 0.8 : 0}
          floatIntensity={animate ? 0.6 : 0}
        >
          <mesh position={b.pos} rotation={b.rot} castShadow>
            <cylinderGeometry args={[0.09, 0.09, 0.08, 6]} />
            <meshStandardMaterial color={BRAND.steel} metalness={0.6} roughness={0.35} />
          </mesh>
        </Float>
      ))}
    </group>
  )
}
