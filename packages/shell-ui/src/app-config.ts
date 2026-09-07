import { useQuery } from '@tanstack/react-query'

/**
 * Non-secret runtime configuration served by the BFF at `/api/config`.
 *
 * This is how a single immutable image is configured per environment — the UI
 * reads real backend identifiers here instead of hardcoding them. Notably
 * `giteaOrg` / `argocdProject` replace the old bogus `"acme"` constants that
 * made Develop/Deliver query a non-existent org/project (404 / empty).
 */
export interface AppConfig {
  authConfigured: boolean
  builderUrl: string
  tools: Record<string, { configured: boolean; url: string }>
  version: string
  /** Gitea org that owns the platform's repos (single-tenant per install). */
  giteaOrg: string
  /** Argo CD project the platform's Applications live under. */
  argocdProject: string
  /** Harbor project the platform's images are pushed to. */
  harborProject: string
  /** Base URL of the platform documentation site (no trailing slash). */
  docsBaseUrl: string
  /**
   * Public base domain tools are exposed under (`<tool>.<base>`), e.g.
   * `platform.adhar.io`. Derived server-side from ADHAR_BASE_DOMAIN or
   * AUTH_PUBLIC_URL; empty when unknown (the client then uses its own origin).
   */
  publicBaseDomain: string
  /** Plane workspace slug the Define phase works in (PLANE_WORKSPACE, else the Gitea org). */
  planeWorkspace: string
}

/** Safe defaults matching the real platform install, used until `/api/config`
 *  resolves (so queries fire against correct values immediately). */
export const APP_CONFIG_DEFAULTS: AppConfig = {
  authConfigured: false,
  builderUrl: '',
  tools: {},
  version: '',
  giteaOrg: 'adhar',
  argocdProject: 'default',
  harborProject: 'library',
  docsBaseUrl: 'https://docs.adhar.io',
  publicBaseDomain: '',
  planeWorkspace: 'adhar',
}

export function useAppConfig() {
  return useQuery<AppConfig>({
    queryKey: ['app-config'],
    queryFn: async () => {
      const r = await fetch('/api/config', { credentials: 'include' })
      if (!r.ok) throw new Error(`/api/config ${r.status}`)
      return { ...APP_CONFIG_DEFAULTS, ...(await r.json()) }
    },
    staleTime: 5 * 60_000,
  })
}

/** The Gitea org, with the real default while config loads. */
export function useGiteaOrg(): string {
  return useAppConfig().data?.giteaOrg || APP_CONFIG_DEFAULTS.giteaOrg
}

/** The Argo CD project, with the real default while config loads. */
export function useArgocdProject(): string {
  return useAppConfig().data?.argocdProject || APP_CONFIG_DEFAULTS.argocdProject
}

/** The documentation site base URL (no trailing slash). */
export function useDocsUrl(): string {
  return (useAppConfig().data?.docsBaseUrl || APP_CONFIG_DEFAULTS.docsBaseUrl).replace(/\/$/, '')
}

/**
 * Public base domain tools live under (`<tool>.<base>`). Prefers the BFF value;
 * falls back to the console's own origin minus its first label
 * (`console.platform.adhar.io` → `platform.adhar.io`); empty if unknowable.
 */
export function usePublicBaseDomain(): string {
  const fromConfig = (useAppConfig().data?.publicBaseDomain ?? '').trim()
  if (fromConfig) return fromConfig
  if (typeof window === 'undefined') return ''
  const rest = window.location.host.split('.').slice(1).join('.')
  return rest.includes('.') ? rest : ''
}

/** The Plane workspace slug the Define phase works in, with the real default while config loads. */
export function usePlaneWorkspace(): string {
  return useAppConfig().data?.planeWorkspace || APP_CONFIG_DEFAULTS.planeWorkspace
}

/** The Harbor project (registry namespace), with the real default while config loads. */
export function useHarborProject(): string {
  return useAppConfig().data?.harborProject || APP_CONFIG_DEFAULTS.harborProject
}

/**
 * Rewrite a URL a backend reported with an IN-CLUSTER host (Gitea's
 * `html_url`, Harbor's registry host, …) into one the BROWSER can open.
 *
 * The BFF reaches tools at `http://<svc>.<ns>.svc.cluster.local:<port>`, so
 * anything they self-report carries that host — a dead link in the UI. We keep
 * the path and swap the origin for the tool's public URL (`/api/config.tools`)
 * or `<tool>.<publicBaseDomain>`. Returns the input unchanged when it is
 * already public or nothing better is known.
 */
export function toPublicUrl(raw: string, opts: { toolUrl?: string; tool?: string; baseDomain?: string; protocol?: string }): string {
  if (!raw) return raw
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  if (!isInternalHost(u.host)) return raw
  const proto = opts.protocol ?? (typeof location !== 'undefined' ? location.protocol : 'https:')
  let origin = ''
  if (opts.toolUrl) {
    try {
      const t = new URL(opts.toolUrl)
      if (!isInternalHost(t.host)) origin = t.origin
    } catch {
      /* ignore malformed */
    }
  }
  if (!origin && opts.tool && opts.baseDomain) origin = `${proto}//${opts.tool}.${opts.baseDomain}`
  if (!origin) return raw
  return `${origin.replace(/\/$/, '')}${u.pathname}${u.search}${u.hash}`
}

/** Service DNS / localhost / bare hostnames a browser can't resolve. */
function isInternalHost(host: string): boolean {
  const h = host.split(':')[0]
  return (
    h.endsWith('.svc') ||
    h.endsWith('.svc.cluster.local') ||
    h.endsWith('.local') ||
    h === 'localhost' ||
    h === '127.0.0.1' ||
    !h.includes('.')
  )
}

/**
 * Public, browser-openable base URL for a backing tool (empty when unknown).
 * Prefers what `/api/config` reports, else `<tool>.<publicBaseDomain>`.
 */
export function useToolPublicUrl(tool: string): string {
  const cfg = useAppConfig().data
  const base = usePublicBaseDomain()
  const reported = cfg?.tools?.[tool]?.url ?? ''
  if (reported && !isInternalHost(safeHost(reported))) return reported.replace(/\/$/, '')
  return base ? `${typeof location !== 'undefined' ? location.protocol : 'https:'}//${tool}.${base}` : ''
}

function safeHost(u: string): string {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}
