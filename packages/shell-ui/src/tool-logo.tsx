import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@adhar/utils'
import { AdharSymbol } from './brand.tsx'
import { ADHAR_LOGO_KEY, TOOL_LOGOS, toolLogoKey } from './tool-logos.ts'

/**
 * Official tool logo, bundled (never a runtime CDN). Each file under
 * `./logos/` becomes its own lazily-imported asset URL, so the shared chunk
 * carries only the manifest — a page with five tools fetches five logos.
 *
 * `import.meta.glob` is Vite-only; under the Deno test runner the call throws
 * and the map stays empty (the component then renders its fallback).
 */
type LogoLoader = () => Promise<string>
let LOADERS: Record<string, LogoLoader> = {}
try {
  LOADERS = (import.meta as unknown as {
    glob: (pattern: string, opts: Record<string, unknown>) => Record<string, LogoLoader>
  }).glob('./logos/*.{svg,png}', { query: '?url', import: 'default', eager: false })
} catch {
  /* not running under Vite */
}

/** Resolved asset URLs, shared by every instance so remounts paint at once. */
const RESOLVED = new Map<string, string>()
const PENDING = new Map<string, Promise<string>>()

function loaderFor(key: string): LogoLoader | undefined {
  const meta = TOOL_LOGOS[key]
  return meta ? LOADERS[`./logos/${key}.${meta.ext}`] : undefined
}

function loadLogo(key: string): Promise<string> | undefined {
  const hit = PENDING.get(key)
  if (hit) return hit
  const load = loaderFor(key)
  if (!load) return undefined
  const p = load().then((url) => {
    RESOLVED.set(key, url)
    return url
  })
  PENDING.set(key, p)
  return p
}

/** Whether a bundled logo (or the Adhar symbol) exists for this app/tool name. */
export function hasToolLogo(tool: string | undefined | null): boolean {
  const key = toolLogoKey(tool)
  return key === ADHAR_LOGO_KEY || (!!key && !!TOOL_LOGOS[key])
}

/**
 * True when the tool's artwork is dark-on-transparent and needs a light
 * backdrop in dark mode — for callers that render `tile={false}` inside their
 * own container and want to add `dark:bg-white` to it.
 */
export function toolLogoWantsLightTile(tool: string | undefined | null): boolean {
  const key = toolLogoKey(tool)
  return !!key && TOOL_LOGOS[key]?.onDark === 'light'
}

export interface ToolLogoProps {
  /** Logo key or any app / package / tool name — resolved via `toolLogoKey`. */
  tool: string
  /** Logo box size in px. With `tile`, the tile adds 8px around it. */
  size?: number
  /** Wrap in the standard raised, rounded, ringed tile (default true). */
  tile?: boolean
  className?: string
  /** Rendered when no official logo is bundled for `tool`. */
  fallback?: ReactNode
}

/**
 * `<ToolLogo tool="grafana" size={40} />` — the tool's official full-colour
 * logo. Adhar-built packages (`adhar-*`) render the Adhar symbol. Logos whose
 * artwork is dark-on-transparent sit on a light tile in dark mode instead of
 * being recoloured.
 */
export function ToolLogo({ tool, size = 40, tile = true, className, fallback = null }: ToolLogoProps) {
  const key = toolLogoKey(tool)
  const meta = key && key !== ADHAR_LOGO_KEY ? TOOL_LOGOS[key] : undefined
  const [url, setUrl] = useState<string | undefined>(() => (key ? RESOLVED.get(key) : undefined))

  useEffect(() => {
    if (!meta || !key) return
    const cached = RESOLVED.get(key)
    if (cached) {
      setUrl(cached)
      return
    }
    let live = true
    loadLogo(key)?.then((u) => live && setUrl(u)).catch(() => {})
    return () => {
      live = false
    }
  }, [key, meta])

  if (key === ADHAR_LOGO_KEY) {
    const mark = <AdharSymbol size={Math.round(size * 0.86)} title="Adhar" />
    return tile ? <Tile size={size} className={className}>{mark}</Tile> : mark
  }
  if (!meta || !loaderFor(key!)) return <>{fallback}</>

  const img = url
    ? (
      <img
        src={url}
        alt={`${meta.name} logo`}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        className={cn('object-contain', !tile && className)}
        style={{ width: size, height: size }}
      />
    )
    // Reserve the box while the asset URL resolves — no layout shift.
    : <span aria-label={`${meta.name} logo`} role="img" className={cn('block', !tile && className)} style={{ width: size, height: size }} />

  if (!tile) return img
  return (
    <Tile size={size} className={cn(meta.onDark === 'light' && 'dark:bg-white', className)}>
      {img}
    </Tile>
  )
}

function Tile({ size, className, children }: { size: number; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-xl bg-surface-raised shadow-sm ring-1 ring-edge-subtle',
        className,
      )}
      style={{ width: size + 8, height: size + 8 }}
    >
      {children}
    </span>
  )
}
