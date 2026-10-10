import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, Line, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { PROMOTION_GATES, SUPPLY_CHAIN } from '~/data/launch-content.ts'
import { activeStage } from '~/data/ui-store.ts'
import { BRAND, gearGeometry, HtmlSacrifice, ribbonGeometry, Sway } from './scene-primitives.tsx'
import { useIsDark, useReducedMotion } from './use-color-mode.ts'
import { ToolLogo } from '~/components/tool-logos.tsx'

/**
 * The software supply chain, end to end, as one continuous conveyor.
 *
 * Packets are born at SOURCE as plain commits, get forged into layered
 * images at BUILD, pass through the SCAN & SIGN gate (which flashes and
 * gives them a signature ring), clear the three PROMOTION gates on their
 * environment pads, land on the DEPLOY cluster (which flares when one
 * arrives) and dissolve into OBSERVE, whose rings pulse outward.
 *
 * Every station stands on its own lit platform, the conveyor carries moving
 * direction dashes, and the scene publishes the lead packet's stage to
 * `activeStage` so the strip under the canvas follows the picture.
 */
export default function SupplyChainCanvas() {
  const reduced = useReducedMotion()
  return (
    <Canvas
      dpr={[1, 1.75]}
      shadows
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ position: [0, 9, 18], fov: 30, near: 0.1, far: 140 }}
      frameloop={reduced ? 'demand' : 'always'}
      style={{ position: 'absolute', inset: 0 }}
    >
      <FitCamera />
      <Lights />
      <Sway enabled={!reduced} amplitude={0.07} speed={0.1}>
        <Chain animate={!reduced} />
      </Sway>
      <Ground />
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        minPolarAngle={Math.PI / 5}
        maxPolarAngle={Math.PI / 2.25}
        minAzimuthAngle={-Math.PI / 3}
        maxAzimuthAngle={Math.PI / 3}
        makeDefault
      />
    </Canvas>
  )
}

/**
 * Frame the whole chain (about 28 units wide) whatever the viewport: the
 * distance comes from the horizontal field of view, so a wide screen sits
 * close and a phone pulls back (capped, so the middle stations stay
 * legible and the ends crop). The camera aims ABOVE the conveyor so it
 * lands in the lower half of the screen, under the message and the card
 * and above the stage strip. OrbitControls owns the camera, so the aim
 * goes through its target rather than `lookAt`.
 */
function FitCamera() {
  const { camera, size, controls } = useThree()
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    const aspect = size.width / size.height
    const vfov = THREE.MathUtils.degToRad(cam.fov)
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect)
    const dist = THREE.MathUtils.clamp((14.5 / Math.tan(hfov / 2)) * 1.05, 18, 48)
    const pitch = THREE.MathUtils.degToRad(27)
    const targetY = 0.3 + 0.55 * dist * Math.tan(vfov / 2)
    cam.position.set(0, targetY + Math.sin(pitch) * dist, Math.cos(pitch) * dist)
    const ctl = controls as unknown as { target: THREE.Vector3; update: () => void } | null
    if (ctl) {
      ctl.target.set(0, targetY, 0)
      ctl.update()
    } else {
      cam.lookAt(0, targetY, 0)
    }
    cam.updateProjectionMatrix()
  }, [camera, size.width, size.height, controls])
  return null
}

function Lights() {
  const dark = useIsDark()
  const { size } = useThree()
  const mapSize = size.width < 720 ? 1024 : 2048
  return (
    <>
      <hemisphereLight args={['#e4ecff', '#ffffff', dark ? 0.35 : 1.0]} />
      <ambientLight intensity={dark ? 0.3 : 0.7} />
      <directionalLight
        position={[11, 10, 9]}
        intensity={dark ? 1.2 : 2.3}
        castShadow
        shadow-mapSize={[mapSize, mapSize]}
        shadow-radius={4}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-19}
        shadow-camera-right={19}
        shadow-camera-top={10}
        shadow-camera-bottom={-10}
        shadow-camera-near={1}
        shadow-camera-far={50}
      />
      <directionalLight position={[-10, 6, -6]} intensity={0.35} color={BRAND.violet} />
    </>
  )
}

/**
 * The ground is the page itself: the canvas is transparent and sits on the
 * site's ambient field, so all this plane does is catch shadows, tinted the
 * brand's navy like every other shadow in the design system.
 */
function Ground() {
  const dark = useIsDark()
  return (
    <mesh position={[0, -0.07, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[90, 90]} />
      <shadowMaterial
        color={dark ? '#000000' : '#1e2a5a'}
        transparent
        opacity={dark ? 0.55 : 0.3}
      />
    </mesh>
  )
}

/* ─────────────────────────────── Track ─────────────────────────────────── */

const TRACK_Y = 0.12

function useTrack() {
  return useMemo(
    () => ({
      main: new THREE.CatmullRomCurve3(
        [
          new THREE.Vector3(-13, TRACK_Y, 1.7),
          new THREE.Vector3(-7.5, TRACK_Y, -1.1),
          new THREE.Vector3(-1, TRACK_Y, 1.3),
          new THREE.Vector3(5.5, TRACK_Y, -1.1),
          new THREE.Vector3(13, TRACK_Y, 0.9),
        ],
        false,
        'catmullrom',
        0.5,
      ),
    }),
    [],
  )
}

interface Shared {
  /** Seconds-clock the whole scene shares. */
  t: number
  /** When the deploy cluster was last hit by a packet. */
  deployHit: number
  /** When the scan gate last stamped a packet. */
  scanHit: number
}

type Stage = (typeof SUPPLY_CHAIN)[number]

function Chain({ animate }: { animate: boolean }) {
  const track = useTrack()
  const shared = useRef<Shared>({ t: 0, deployHit: -10, scanHit: -10 })
  const { size } = useThree()
  const compact = size.width < 720
  const mainPts = useMemo(() => track.main.getPoints(240), [track])
  const ribbon = useMemo(() => ribbonGeometry(track.main, 0.86, 220), [track])
  const dashes = useRef<React.ComponentRef<typeof Line>>(null)
  const root = useRef<THREE.Group>(null)
  const dark = useIsDark()

  // Every opaque mesh casts and receives. Done once by traversal rather than
  // a prop on each of ~80 meshes; transparent planes and lines are skipped so
  // beams and rails don't throw solid shadows.
  useEffect(() => {
    root.current?.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mat = m.material as THREE.Material
      m.receiveShadow = true
      m.castShadow = !mat.transparent &&
        !(mat as THREE.Material & { isLineMaterial?: boolean }).isLineMaterial
    })
  }, [])

  useFrame((_, dt) => {
    if (!animate) return
    shared.current.t += dt
    // Moving dashes = direction of travel.
    if (dashes.current) dashes.current.material.dashOffset = -shared.current.t * 0.6
  })

  const at = (u: number) => track.main.getPointAt(u)
  const byId = Object.fromEntries(SUPPLY_CHAIN.map((s) => [s.id, s])) as Record<Stage['id'], Stage>
  const index = (s: Stage) => SUPPLY_CHAIN.indexOf(s) + 1

  return (
    <group ref={root}>
      <HtmlSacrifice />
      {/* The Adhar platform: one deck under every stage, the mark behind it */}
      <Deck shared={shared} />
      <Governance />

      {
        /* The road: paved in stone, bounded by guardrails, with the golden path
          running down its centre — the one route every artifact follows */
      }
      <mesh geometry={ribbon} position={[0, -0.02, 0]} receiveShadow>
        <meshStandardMaterial
          color={dark ? '#1a1f2b' : '#20242f'}
          roughness={0.9}
          side={THREE.DoubleSide}
        />
      </mesh>
      <PavedTiles curve={track.main} count={110} />
      <GuardRails curve={track.main} />
      <Line
        points={mainPts.map((p) => p.clone().setY(TRACK_Y + 0.012))}
        color={BRAND.gold}
        lineWidth={4.5}
        transparent
        opacity={0.95}
      />
      <Line
        ref={dashes}
        points={mainPts.map((p) => p.clone().setY(TRACK_Y + 0.022))}
        color='#fff3c4'
        lineWidth={2.6}
        dashed
        dashSize={0.3}
        gapSize={0.7}
        transparent
        opacity={0.9}
      />

      <Source
        n={index(byId.source)}
        stage={byId.source}
        pos={at(byId.source.u)}
        shared={shared}
        compact={compact}
      />
      <Build
        n={index(byId.build)}
        stage={byId.build}
        pos={at(byId.build.u)}
        shared={shared}
        compact={compact}
        animate={animate}
      />
      <ScanGate
        n={index(byId.attest)}
        stage={byId.attest}
        pos={at(byId.attest.u)}
        shared={shared}
        compact={compact}
      />
      <Promote
        n={index(byId.promote)}
        stage={byId.promote}
        track={track.main}
        shared={shared}
        compact={compact}
      />
      <Cluster
        n={index(byId.deploy)}
        stage={byId.deploy}
        pos={at(byId.deploy.u)}
        shared={shared}
        compact={compact}
      />
      <Observe
        n={index(byId.observe)}
        stage={byId.observe}
        pos={at(byId.observe.u)}
        shared={shared}
        compact={compact}
      />

      <Packets curve={track.main} count={9} shared={shared} />
    </group>
  )
}

/* ─────────────────────────── Station chrome ───────────────────────────── */

type StationProps = {
  n: number
  stage: Stage
  pos: THREE.Vector3
  shared: React.RefObject<Shared>
  compact: boolean
}

/** Every station stands on one of these: a disc with a glowing rim in its colour. */
function Platform(
  { pos, color, radius = 1.5 }: { pos: THREE.Vector3; color: string; radius?: number },
) {
  const dark = useIsDark()
  return (
    <group position={[pos.x, 0, pos.z]}>
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[radius, radius + 0.08, 0.06, 48]} />
        <meshStandardMaterial
          color='#ffffff'
          emissive='#ffffff'
          emissiveIntensity={dark ? 0 : 0.15}
          roughness={0.6}
        />
      </mesh>
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius - 0.06, radius, 64]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.9}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  )
}

/**
 * Station signpost: a vertical card — tool logo on top, the tool's name,
 * then the numbered stage — pinned to the station by a thin stem. The
 * anchor is the bottom of the stem, so `y` is where the stem touches down.
 */
function StationLabel(
  { n, stage, pos, compact, y = 1.6 }: Omit<StationProps, 'shared'> & { y?: number },
) {
  return (
    <Html
      position={[pos.x, pos.y + y, pos.z]}
      zIndexRange={[20, 0]}
      style={{ pointerEvents: 'none', transform: 'translate(-50%, -100%)' }}
    >
      <div className='flex flex-col items-center'>
        <div
          className={`flex flex-col items-center rounded-xl border border-edge-default bg-surface-raised/92 shadow-md backdrop-blur ${
            compact ? 'gap-0.5 px-2 py-1.5' : 'gap-1 px-3 py-2'
          }`}
        >
          <ToolLogo stage={stage.id} size={compact ? 22 : 34} />
          <span className={`text-content-subtle ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
            {stage.tool}
          </span>
          <div className='flex items-center gap-1.5 whitespace-nowrap'>
            <span
              className='inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold text-white'
              style={{ backgroundColor: stage.color }}
            >
              {n}
            </span>
            <span
              className={`font-semibold text-content ${compact ? 'text-[11px]' : 'text-sm'}`}
            >
              {stage.name}
            </span>
          </div>
        </div>
        <span className='h-4 w-px bg-edge-strong' aria-hidden />
        <span
          className='size-1.5 rounded-full'
          style={{ backgroundColor: stage.color }}
          aria-hidden
        />
      </div>
    </Html>
  )
}

/* 1 · Source — a repo: hex plinth, a commit graph above it, a commit orbiting. */
function Source({ n, stage, pos, shared, compact }: StationProps) {
  const orbit = useRef<THREE.Mesh>(null)
  useFrame(() => {
    const t = shared.current.t
    if (orbit.current) {
      orbit.current.position.set(
        pos.x + Math.cos(t * 1.4) * 0.9,
        0.5 + Math.sin(t * 2.8) * 0.06,
        pos.z + Math.sin(t * 1.4) * 0.9,
      )
    }
  })
  // A tiny branch graph: main line with a feature branch merging back.
  const nodes: [number, number][] = [
    [-0.45, 0.95],
    [-0.15, 0.95],
    [0.15, 0.95],
    [0.45, 0.95],
    [0, 1.3],
  ]
  return (
    <group>
      <Platform pos={pos} color={stage.color} />
      <mesh position={[pos.x, 0.32, pos.z]}>
        <cylinderGeometry args={[0.55, 0.62, 0.52, 6]} />
        <meshStandardMaterial color={BRAND.stone} roughness={0.6} />
      </mesh>
      <group position={[pos.x, 0, pos.z]}>
        {/* main line */}
        <mesh position={[0, 0.95, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.02, 0.02, 1.0, 6]} />
          <meshBasicMaterial color={BRAND.slate} />
        </mesh>
        {/* branch out + back in */}
        <mesh position={[-0.075, 1.125, 0]} rotation={[0, 0, Math.PI / 4]}>
          <cylinderGeometry args={[0.02, 0.02, 0.5, 6]} />
          <meshBasicMaterial color={stage.color} />
        </mesh>
        <mesh position={[0.075, 1.125, 0]} rotation={[0, 0, -Math.PI / 4]}>
          <cylinderGeometry args={[0.02, 0.02, 0.5, 6]} />
          <meshBasicMaterial color={stage.color} />
        </mesh>
        {nodes.map(([x, y], i) => (
          <mesh key={i} position={[x, y, 0]}>
            <sphereGeometry args={[i === 4 ? 0.09 : 0.07, 12, 12]} />
            <meshStandardMaterial
              color={i === 4 ? BRAND.blue : BRAND.slate}
              emissive={i === 4 ? BRAND.blue : BRAND.slate}
              emissiveIntensity={0.6}
            />
          </mesh>
        ))}
      </group>
      <mesh ref={orbit}>
        <boxGeometry args={[0.16, 0.16, 0.16]} />
        <meshStandardMaterial color={BRAND.slate} emissive={BRAND.slate} emissiveIntensity={0.4} />
      </mesh>
      {/* policy checks passed: an emerald ring on the plinth, commits queued on the orbit */}
      <mesh position={[pos.x, 0.6, pos.z]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.5, 0.02, 8, 48]} />
        <meshBasicMaterial color={BRAND.emerald} transparent opacity={0.9} toneMapped={false} />
      </mesh>
      {[0.9, 2.2, 3.9].map((a) => (
        <mesh key={a} position={[pos.x + Math.cos(a) * 0.9, 0.5, pos.z + Math.sin(a) * 0.9]}>
          <boxGeometry args={[0.12, 0.12, 0.12]} />
          <meshStandardMaterial
            color={BRAND.slate}
            emissive={BRAND.slate}
            emissiveIntensity={0.3}
          />
        </mesh>
      ))}
      <StationLabel n={n} stage={stage} pos={pos} compact={compact} y={1.85} />
    </group>
  )
}

/* 2 · Build — a forge: slabs assembling in sequence, a gear turning, sparks. */
function Build({ n, stage, pos, shared, compact, animate }: StationProps & { animate: boolean }) {
  const slabs = useRef<(THREE.Mesh | null)[]>([])
  const gear = useRef<THREE.Mesh>(null)
  const gearGeo = useMemo(() => gearGeometry(12, 0.42, 0.14), [])
  useFrame(() => {
    const t = shared.current.t
    slabs.current.forEach((m, k) => {
      if (m) m.position.y = 0.42 + k * 0.2 + Math.max(0, Math.sin(t * 2 - k * 0.9)) * 0.1
    })
    if (gear.current) gear.current.rotation.z = t * 0.9
  })
  return (
    <group>
      <Platform pos={pos} color={stage.color} />
      <mesh position={[pos.x, 0.19, pos.z]}>
        <boxGeometry args={[1.5, 0.3, 1.2]} />
        <meshStandardMaterial color={BRAND.stone} roughness={0.6} />
      </mesh>
      {[0, 1, 2].map((k) => (
        <mesh
          key={k}
          ref={(el) => {
            slabs.current[k] = el
          }}
          position={[pos.x, 0.42 + k * 0.2, pos.z]}
        >
          <boxGeometry args={[0.9 - k * 0.12, 0.14, 0.7 - k * 0.1]} />
          <meshStandardMaterial color={stage.color} roughness={0.35} metalness={0.2} />
        </mesh>
      ))}
      {/* gantry + gear */}
      <mesh position={[pos.x - 0.95, 0.7, pos.z]}>
        <boxGeometry args={[0.1, 1.4, 0.1]} />
        <meshStandardMaterial color={BRAND.steel} />
      </mesh>
      <mesh ref={gear} geometry={gearGeo} position={[pos.x - 0.95, 1.5, pos.z]}>
        <meshStandardMaterial color={BRAND.amber} roughness={0.35} metalness={0.45} />
      </mesh>
      {/* build log: a small panel with passing steps */}
      <group position={[pos.x + 1.05, 0.72, pos.z + 0.35]} rotation={[0, -0.5, 0]}>
        <mesh>
          <boxGeometry args={[0.8, 0.56, 0.05]} />
          <meshStandardMaterial color={BRAND.ink} roughness={0.5} />
        </mesh>
        {[0, 1, 2, 3].map((k) => (
          <mesh key={k} position={[-0.1 + (k === 3 ? -0.08 : 0), 0.17 - k * 0.11, 0.03]}>
            <boxGeometry args={[k === 3 ? 0.3 : 0.5, 0.035, 0.01]} />
            <meshBasicMaterial color={k === 3 ? BRAND.amber : BRAND.emerald} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <StationLabel n={n} stage={stage} pos={pos} compact={compact} y={2.2} />
    </group>
  )
}

/* 3 · Scan & sign — a gate with sweeping beams; flashes when it stamps a packet. */
function ScanGate({ n, stage, pos, shared, compact }: StationProps) {
  const beams = useRef<(THREE.Mesh | null)[]>([])
  const shield = useRef<THREE.Mesh>(null)
  const flash = useRef<THREE.Mesh>(null)
  useFrame(() => {
    const t = shared.current.t
    beams.current.forEach((m, k) => {
      if (m) m.position.y = 0.2 + (0.5 + 0.5 * Math.sin(t * 2.2 - k * 0.5)) * 1.1
    })
    if (shield.current) shield.current.rotation.y = t * 0.8
    if (flash.current) {
      const f = Math.exp(-(t - shared.current.scanHit) * 4)
      ;(flash.current.material as THREE.MeshBasicMaterial).opacity = f * 0.9
      flash.current.scale.setScalar(1 + (1 - f) * 0.6)
    }
  })
  const post = (dz: number) => (
    <mesh position={[pos.x, 0.8, pos.z + dz]}>
      <boxGeometry args={[0.14, 1.6, 0.14]} />
      <meshStandardMaterial color={BRAND.steel} />
    </mesh>
  )
  return (
    <group>
      <Platform pos={pos} color={stage.color} radius={1.3} />
      {post(-0.95)}
      {post(0.95)}
      <mesh position={[pos.x, 1.62, pos.z]}>
        <boxGeometry args={[0.14, 0.14, 2.04]} />
        <meshStandardMaterial color={BRAND.steel} />
      </mesh>
      {[0, 1, 2].map((k) => (
        <mesh
          key={k}
          ref={(el) => {
            beams.current[k] = el
          }}
          position={[pos.x, 0.8, pos.z]}
          rotation={[0, Math.PI / 2, 0]}
        >
          <planeGeometry args={[1.8, 0.035]} />
          <meshBasicMaterial
            color={stage.color}
            transparent
            opacity={0.9 - k * 0.3}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ))}
      <mesh position={[pos.x, 0.8, pos.z]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[1.8, 1.5]} />
        <meshBasicMaterial
          color={stage.color}
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* stamp flash */}
      <mesh ref={flash} position={[pos.x, 0.8, pos.z]} rotation={[0, Math.PI / 2, 0]}>
        <ringGeometry args={[0.5, 0.6, 48]} />
        <meshBasicMaterial
          color='#ffffff'
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={shield} position={[pos.x, 2.05, pos.z]}>
        <octahedronGeometry args={[0.2, 0]} />
        <meshStandardMaterial color={stage.color} emissive={stage.color} emissiveIntensity={1.2} />
      </mesh>
      {/* SBOM + signature card, pinned beside the gate */}
      <group position={[pos.x + 0.2, 1.25, pos.z - 1.35]} rotation={[0, 0.35, 0]}>
        <mesh>
          <boxGeometry args={[0.56, 0.72, 0.04]} />
          <meshStandardMaterial color='#ffffff' roughness={0.6} />
        </mesh>
        {[0, 1, 2].map((k) => (
          <mesh key={k} position={[-0.04, 0.2 - k * 0.13, 0.025]}>
            <boxGeometry args={[0.36 - k * 0.06, 0.03, 0.01]} />
            <meshBasicMaterial color={BRAND.steel} />
          </mesh>
        ))}
        <mesh position={[0.12, -0.22, 0.03]}>
          <circleGeometry args={[0.09, 24]} />
          <meshBasicMaterial color={stage.color} toneMapped={false} />
        </mesh>
      </group>
      <StationLabel n={n} stage={stage} pos={pos} compact={compact} y={2.65} />
    </group>
  )
}

/* 4 · Promote — three gates (dev, stage, prod) on their own environment pads. */
function Promote(
  { n, stage, track, shared, compact }: Omit<StationProps, 'pos'> & {
    track: THREE.CatmullRomCurve3
  },
) {
  const mid = track.getPointAt(stage.u)
  const rings = useRef<(THREE.Mesh | null)[]>([])
  useFrame(() => {
    const t = shared.current.t
    rings.current.forEach((m, k) => {
      if (m) {
        ;(m.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5 +
          0.5 * Math.sin(t * 2 - k * 1.2)
      }
    })
  })
  const padColors = [BRAND.blue, BRAND.indigo, BRAND.violet]
  return (
    <group>
      <Platform pos={mid} color={stage.color} radius={2.1} />
      {PROMOTION_GATES.map((g, k) => {
        const p = track.getPointAt(g.u)
        const tangent = track.getTangentAt(g.u)
        const yaw = Math.atan2(tangent.x, tangent.z)
        const r = 0.5 + k * 0.12
        return (
          <group key={g.name}>
            {/* environment pad */}
            <mesh position={[p.x, 0.07 + k * 0.08, p.z]}>
              <cylinderGeometry args={[0.55, 0.55, 0.06 + k * 0.16, 32]} />
              <meshStandardMaterial
                color={padColors[k]}
                emissive={padColors[k]}
                emissiveIntensity={0.25}
                transparent
                opacity={0.8}
              />
            </mesh>
            <group position={[p.x, r + 0.1 + k * 0.16, p.z]} rotation={[0, yaw, 0]}>
              <mesh
                ref={(el) => {
                  rings.current[k] = el
                }}
              >
                <torusGeometry args={[r, 0.05, 12, 48]} />
                <meshStandardMaterial
                  color={padColors[k]}
                  emissive={padColors[k]}
                  emissiveIntensity={0.6}
                  roughness={0.3}
                  metalness={0.3}
                />
              </mesh>
              {/* gate posts */}
              {[-1, 1].map((s) => (
                <mesh key={s} position={[0, -r / 2 - 0.05, s * r]}>
                  <boxGeometry args={[0.06, r + 0.1, 0.06]} />
                  <meshStandardMaterial color={BRAND.steel} />
                </mesh>
              ))}
            </group>
          </group>
        )
      })}
      <StationLabel n={n} stage={stage} pos={mid} compact={compact} y={2.5} />
    </group>
  )
}

/* 5 · Deploy — a honeycomb cluster with a sync ring; pods flare when a packet lands. */
function Cluster({ n, stage, pos, shared, compact }: StationProps) {
  const pods = useRef<(THREE.Mesh | null)[]>([])
  const sync = useRef<THREE.Mesh>(null)
  const cells = useMemo(() => {
    const out: [number, number][] = [[0, 0]]
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      out.push([Math.cos(a) * 0.82, Math.sin(a) * 0.82])
    }
    return out
  }, [])
  useFrame(() => {
    const t = shared.current.t
    const flare = Math.exp(-(t - shared.current.deployHit) * 1.8)
    pods.current.forEach((m, k) => {
      if (!m) return
      const mat = m.material as THREE.MeshStandardMaterial
      mat.emissiveIntensity = 0.15 + flare * (1.6 - k * 0.12)
      m.scale.y = 1 + flare * 0.35
    })
    if (sync.current) sync.current.rotation.z = t * 0.5
  })
  return (
    <group>
      <Platform pos={pos} color={stage.color} radius={1.7} />
      {cells.map(([dx, dz], k) => (
        <group key={k} position={[pos.x + dx, 0, pos.z + dz]}>
          <mesh position={[0, 0.1, 0]}>
            <cylinderGeometry args={[0.44, 0.44, 0.12, 6]} />
            <meshStandardMaterial color={BRAND.stone} roughness={0.6} />
          </mesh>
          <mesh
            ref={(el) => {
              pods.current[k] = el
            }}
            position={[0, 0.36, 0]}
          >
            <cylinderGeometry args={[0.17, 0.17, 0.4, 16]} />
            <meshStandardMaterial
              color={stage.color}
              emissive={stage.color}
              emissiveIntensity={0.15}
              roughness={0.35}
            />
          </mesh>
        </group>
      ))}
      {/* reconciliation ring: a broken torus turning above the cluster */}
      <mesh ref={sync} position={[pos.x, 1.35, pos.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.95, 0.035, 8, 48, Math.PI * 1.6]} />
        <meshBasicMaterial color={stage.color} toneMapped={false} />
      </mesh>
      {/* cluster boundary */}
      <mesh position={[pos.x, 0.02, pos.z]}>
        <sphereGeometry args={[1.3, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial
          color={stage.color}
          transparent
          opacity={0.09}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <StationLabel n={n} stage={stage} pos={pos} compact={compact} y={1.95} />
    </group>
  )
}

/* 6 · Observe — a mast, rings pulsing outward, metric bars breathing. */
function Observe({ n, stage, pos, shared, compact }: StationProps) {
  const rings = useRef<(THREE.Mesh | null)[]>([])
  const bars = useRef<(THREE.Mesh | null)[]>([])
  useFrame(() => {
    const t = shared.current.t
    rings.current.forEach((m, k) => {
      if (!m) return
      const ph = (t * 0.45 + k / 3) % 1
      const s = 0.2 + ph * 1.6
      m.scale.set(s, s, 1)
      ;(m.material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.8
    })
    bars.current.forEach((m, k) => {
      if (!m) return
      const h = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t * 1.3 + k * 1.7))
      m.scale.y = h
      m.position.y = 0.1 + h * 0.5
    })
  })
  return (
    <group>
      <Platform pos={pos} color={stage.color} radius={1.4} />
      <mesh position={[pos.x, 0.6, pos.z]}>
        <cylinderGeometry args={[0.07, 0.13, 1.2, 12]} />
        <meshStandardMaterial color={BRAND.steel} />
      </mesh>
      <mesh position={[pos.x, 1.25, pos.z]}>
        <sphereGeometry args={[0.17, 16, 16]} />
        <meshStandardMaterial color={stage.color} emissive={stage.color} emissiveIntensity={1.4} />
      </mesh>
      {/* metric bars */}
      {[0, 1, 2, 3].map((k) => (
        <mesh
          key={k}
          ref={(el) => {
            bars.current[k] = el
          }}
          position={[pos.x + 0.55 + k * 0.22, 0.3, pos.z + 0.6]}
        >
          <boxGeometry args={[0.14, 1, 0.14]} />
          <meshStandardMaterial
            color={stage.color}
            emissive={stage.color}
            emissiveIntensity={0.5}
          />
        </mesh>
      ))}
      {[0, 1, 2].map((k) => (
        <mesh
          key={k}
          ref={(el) => {
            rings.current[k] = el
          }}
          position={[pos.x, 0.08, pos.z]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <ringGeometry args={[0.95, 1.0, 48]} />
          <meshBasicMaterial
            color={stage.color}
            transparent
            opacity={0.6}
            side={THREE.DoubleSide}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
      ))}
      {/* dashboard panel behind the bars */}
      <group position={[pos.x + 0.9, 0.62, pos.z + 0.28]} rotation={[0, -0.25, 0]}>
        <mesh position={[0, 0, -0.12]}>
          <boxGeometry args={[1.15, 0.95, 0.04]} />
          <meshStandardMaterial color={BRAND.ink} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.32, -0.09]}>
          <boxGeometry args={[0.9, 0.03, 0.01]} />
          <meshBasicMaterial color={stage.color} toneMapped={false} />
        </mesh>
      </group>
      <StationLabel n={n} stage={stage} pos={pos} compact={compact} y={1.75} />
    </group>
  )
}

/* ─────────────────────────── The Adhar platform ───────────────────────── */

const DECK_HALF_X = 15.2
const DECK_HALF_Z = 3.7
const DECK_R = 3.0

/** Stadium outline of the deck, reused for the slab, the rim and the pulse. */
function deckShape(): THREE.Shape {
  const sh = new THREE.Shape()
  const x = DECK_HALF_X - DECK_R
  const z = DECK_HALF_Z - DECK_R
  sh.moveTo(-x, -DECK_HALF_Z)
  sh.lineTo(x, -DECK_HALF_Z)
  sh.absarc(x, -z, DECK_R, -Math.PI / 2, 0, false)
  sh.lineTo(DECK_HALF_X, z)
  sh.absarc(x, z, DECK_R, 0, Math.PI / 2, false)
  sh.lineTo(-x, DECK_HALF_Z)
  sh.absarc(-x, z, DECK_R, Math.PI / 2, Math.PI, false)
  sh.lineTo(-DECK_HALF_X, -z)
  sh.absarc(-x, -z, DECK_R, Math.PI, Math.PI * 1.5, false)
  sh.closePath()
  return sh
}

/**
 * One deck under all six stations — the platform itself. A dark slab with
 * a brand-blue rim and a pulse of light that laps the rim, spanning the
 * whole chain.
 */
function Deck({ shared }: { shared: React.RefObject<Shared> }) {
  const dark = useIsDark()
  const shape = useMemo(() => deckShape(), [])
  const slab = useMemo(() => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: 0.14,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.22,
      bevelSegments: 5,
    })
    g.rotateX(Math.PI / 2)
    return g
  }, [shape])
  const rim = useMemo(() => shape.getPoints(96).map((p) => new THREE.Vector3(p.x, 0.0, p.y)), [
    shape,
  ])
  const pulse = useRef<React.ComponentRef<typeof Line>>(null)
  useFrame(() => {
    if (pulse.current) pulse.current.material.dashOffset = -shared.current.t * 2.2
  })
  return (
    <group>
      {/* slab — top face sits just under the station platforms */}
      <mesh geometry={slab} position={[0, -0.04, 0]}>
        <meshStandardMaterial
          color={dark ? '#232c4f' : '#e4ecfc'}
          emissive={dark ? '#000000' : '#ffffff'}
          emissiveIntensity={dark ? 0 : 0.16}
          roughness={0.6}
          metalness={0.05}
        />
      </mesh>
      {/* soft inner glow on the top face */}
      <mesh position={[0, -0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial
          color={BRAND.blue}
          transparent
          opacity={dark ? 0.12 : 0.06}
          depthWrite={false}
        />
      </mesh>
      {
        /* halo: wider, fainter copies of the plate beneath it, so the deck melts
          into the page instead of ending at a hard edge */
      }
      <mesh position={[0, -0.26, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.06, 1.14, 1]}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial
          color={BRAND.blue}
          transparent
          opacity={dark ? 0.16 : 0.12}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, -0.27, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.12, 1.3, 1]}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial
          color={BRAND.blue}
          transparent
          opacity={dark ? 0.08 : 0.06}
          depthWrite={false}
        />
      </mesh>
      {/* rim + travelling pulse */}
      <Line
        points={rim}
        color={BRAND.blue}
        lineWidth={1.6}
        transparent
        opacity={dark ? 0.7 : 0.55}
      />
      <Line
        ref={pulse}
        points={rim.map((p) => p.clone().setY(0.005))}
        color={BRAND.gold}
        lineWidth={3}
        dashed
        dashSize={4}
        gapSize={92}
        transparent
        opacity={0.95}
      />
    </group>
  )
}

/* Paving slabs laid along the road — asphalt blacks, a shade lighter in dark mode. */
function PavedTiles({ curve, count }: { curve: THREE.CatmullRomCurve3; count: number }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const dark = useIsDark()
  const shades = useMemo(
    () =>
      (dark
        ? ['#2e3444', '#29303f', '#323849', '#272d3c']
        : ['#272c38', '#232835', '#2b303d', '#20252f']).map(
          (c) => new THREE.Color(c),
        ),
    [dark],
  )
  useEffect(() => {
    const m = ref.current
    if (!m) return
    const dummy = new THREE.Object3D()
    const ahead = new THREE.Vector3()
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count
      const p = curve.getPointAt(u)
      const t = curve.getTangentAt(u)
      dummy.position.set(p.x, TRACK_Y - 0.04, p.z)
      ahead.copy(p).add(t)
      dummy.lookAt(ahead)
      dummy.updateMatrix()
      m.setMatrixAt(i, dummy.matrix)
      m.setColorAt(i, shades[i % shades.length])
    }
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }, [curve, count, shades])
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} castShadow receiveShadow>
      <boxGeometry args={[0.72, 0.05, 0.2]} />
      <meshStandardMaterial color='#ffffff' roughness={0.75} metalness={0.02} />
    </instancedMesh>
  )
}

/**
 * Guardrails — literally. Posts and a rail run along both sides of the
 * golden path, so the thing platform engineers mean by the word is the thing
 * you see: a paved road you cannot fall off. Policy, security and promotion
 * rules are the rails; the artifact rides between them.
 */
function GuardRails({ curve }: { curve: THREE.CatmullRomCurve3 }) {
  const OFFSET = 0.62
  const POSTS = 22
  const { left, right, postPts } = useMemo(() => {
    const up = new THREE.Vector3(0, 1, 0)
    const side = new THREE.Vector3()
    const left: THREE.Vector3[] = []
    const right: THREE.Vector3[] = []
    for (let i = 0; i <= 220; i++) {
      const u = i / 220
      const p = curve.getPointAt(u)
      side.crossVectors(up, curve.getTangentAt(u)).normalize().multiplyScalar(OFFSET)
      left.push(new THREE.Vector3(p.x + side.x, 0, p.z + side.z))
      right.push(new THREE.Vector3(p.x - side.x, 0, p.z - side.z))
    }
    const postPts: THREE.Vector3[] = []
    for (let i = 0; i <= POSTS; i++) {
      const u = i / POSTS
      const p = curve.getPointAt(u)
      side.crossVectors(up, curve.getTangentAt(u)).normalize().multiplyScalar(OFFSET)
      postPts.push(
        new THREE.Vector3(p.x + side.x, 0, p.z + side.z),
        new THREE.Vector3(p.x - side.x, 0, p.z - side.z),
      )
    }
    return { left, right, postPts }
  }, [curve])
  const posts = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    const m = posts.current
    if (!m) return
    const dummy = new THREE.Object3D()
    postPts.forEach((p, i) => {
      dummy.position.set(p.x, TRACK_Y + 0.16, p.z)
      dummy.updateMatrix()
      m.setMatrixAt(i, dummy.matrix)
    })
    m.instanceMatrix.needsUpdate = true
  }, [postPts])
  const rail = (pts: THREE.Vector3[], y: number, w: number, o: number) => (
    <Line
      points={pts.map((p) => p.clone().setY(TRACK_Y + y))}
      color={BRAND.blue}
      lineWidth={w}
      transparent
      opacity={o}
    />
  )
  return (
    <group>
      <instancedMesh ref={posts} args={[undefined, undefined, postPts.length]} castShadow>
        <cylinderGeometry args={[0.028, 0.034, 0.34, 8]} />
        <meshStandardMaterial color={BRAND.steel} roughness={0.4} metalness={0.3} />
      </instancedMesh>
      {rail(left, 0.3, 2, 0.9)}
      {rail(right, 0.3, 2, 0.9)}
    </group>
  )
}

/**
 * Overall governance: one translucent band running the length of the deck
 * behind every station — identity, policy and audit are not stages, they
 * apply to all of them at once.
 */
function Governance() {
  const dark = useIsDark()
  const W = DECK_HALF_X * 2 - 4
  const H = 1.6
  const z = -DECK_HALF_Z + 0.35
  return (
    <group>
      <mesh position={[0, H / 2 + 0.05, z]}>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial
          color={BRAND.indigo}
          transparent
          opacity={dark ? 0.16 : 0.1}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Line
        points={[new THREE.Vector3(-W / 2, H + 0.05, z), new THREE.Vector3(W / 2, H + 0.05, z)]}
        color={BRAND.indigo}
        lineWidth={1.6}
        transparent
        opacity={0.7}
      />
    </group>
  )
}

/* ────────────────────────────── Packets ────────────────────────────────── */

const SPEED = 0.045
const STAGE_U = SUPPLY_CHAIN.map((s) => s.u)
const BUILD_U = SUPPLY_CHAIN[1].u
const ATTEST_U = SUPPLY_CHAIN[2].u
const PROD_U = PROMOTION_GATES[2].u
const DEPLOY_U = SUPPLY_CHAIN[4].u

function stageIndexAt(u: number): number {
  let i = 0
  for (let k = 0; k < STAGE_U.length; k++) if (u >= STAGE_U[k]) i = k
  return i
}

/**
 * The same handful of packets loop forever. Each frame every packet is
 * re-positioned from the shared clock and re-dressed for the stage it is in:
 * grey commit → indigo layered image (two plates appear) → blue signed image
 * with a ring → violet promoted release → emerald telemetry after it lands.
 */
function Packets(
  { curve, count, shared }: {
    curve: THREE.CatmullRomCurve3
    count: number
    shared: React.RefObject<Shared>
  },
) {
  const groups = useRef<(THREE.Group | null)[]>([])
  const bodies = useRef<(THREE.Mesh | null)[]>([])
  const plates = useRef<(THREE.Group | null)[]>([])
  const rings = useRef<(THREE.Mesh | null)[]>([])
  const prevU = useRef<number[]>(Array.from({ length: count }, () => 0))
  const tmp = useMemo(() => ({ target: new THREE.Color() }), [])

  useFrame(() => {
    const t = shared.current.t
    let leadU = -1
    for (let i = 0; i < count; i++) {
      const u = (t * SPEED + i / count) % 1
      const g = groups.current[i]
      const b = bodies.current[i]
      const pl = plates.current[i]
      const r = rings.current[i]
      if (!g || !b || !r || !pl) continue

      // Crossings that light something up.
      if (prevU.current[i] < DEPLOY_U && u >= DEPLOY_U) shared.current.deployHit = t
      if (prevU.current[i] < ATTEST_U && u >= ATTEST_U) shared.current.scanHit = t
      prevU.current[i] = u

      const p = curve.getPointAt(u)
      g.position.set(p.x, 0.26, p.z)
      g.rotation.y = t * 0.3 + i

      let scale = 0.16
      let color: string = BRAND.slate
      let emissive = 0.25
      if (u >= BUILD_U) {
        scale = 0.26
        color = BRAND.indigo
        emissive = 0.5
      }
      if (u >= ATTEST_U) {
        color = BRAND.blue
        emissive = 0.9
      }
      if (u >= PROD_U) color = BRAND.violet
      if (u >= DEPLOY_U) {
        scale = 0.12
        color = BRAND.emerald
        emissive = 1.4
      }
      if (u > 0.955) scale *= Math.max(0, (1 - u) / 0.045)

      g.scale.setScalar(scale / 0.2)
      const mat = b.material as THREE.MeshStandardMaterial
      tmp.target.set(color)
      mat.color.lerp(tmp.target, 0.2)
      mat.emissive.copy(mat.color)
      mat.emissiveIntensity = emissive
      pl.visible = u >= BUILD_U && u < DEPLOY_U
      for (const c of pl.children) {
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial
        m.color.copy(mat.color)
        m.emissive.copy(mat.color)
        m.emissiveIntensity = emissive * 0.6
      }
      r.visible = u >= ATTEST_U && u < DEPLOY_U
      r.rotation.x = t * 1.5
      r.rotation.y = t * 1.1

      if (u > leadU && u < 0.955) leadU = u
    }
    if (leadU >= 0) activeStage.set(stageIndexAt(leadU))
  })

  return (
    <group>
      {Array.from({ length: count }, (_, i) => (
        <group
          key={i}
          ref={(el) => {
            groups.current[i] = el
          }}
        >
          <mesh
            ref={(el) => {
              bodies.current[i] = el
            }}
          >
            <boxGeometry args={[0.2, 0.12, 0.2]} />
            <meshStandardMaterial
              color={BRAND.slate}
              emissive={BRAND.slate}
              emissiveIntensity={0.3}
              roughness={0.3}
              metalness={0.2}
              toneMapped={false}
            />
          </mesh>
          {/* image layers */}
          <group
            ref={(el) => {
              plates.current[i] = el
            }}
            visible={false}
          >
            <mesh position={[0, 0.1, 0]}>
              <boxGeometry args={[0.18, 0.05, 0.18]} />
              <meshStandardMaterial
                color={BRAND.indigo}
                emissive={BRAND.indigo}
                emissiveIntensity={0.3}
                toneMapped={false}
              />
            </mesh>
            <mesh position={[0, 0.17, 0]}>
              <boxGeometry args={[0.16, 0.05, 0.16]} />
              <meshStandardMaterial
                color={BRAND.indigo}
                emissive={BRAND.indigo}
                emissiveIntensity={0.3}
                toneMapped={false}
              />
            </mesh>
          </group>
          <mesh
            ref={(el) => {
              rings.current[i] = el
            }}
            visible={false}
            position={[0, 0.08, 0]}
          >
            <torusGeometry args={[0.26, 0.018, 8, 32]} />
            <meshBasicMaterial color={BRAND.blue} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  )
}
