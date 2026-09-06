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
  /** Base URL of the platform documentation site (no trailing slash). */
  docsBaseUrl: string
  /**
   * Public base domain tools are exposed under (`<tool>.<base>`), e.g.
   * `platform.adhar.io`. Derived server-side from ADHAR_BASE_DOMAIN or
   * AUTH_PUBLIC_URL; empty when unknown (the client then uses its own origin).
   */
  publicBaseDomain: string
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
  docsBaseUrl: 'https://docs.adhar.io',
  publicBaseDomain: '',
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
