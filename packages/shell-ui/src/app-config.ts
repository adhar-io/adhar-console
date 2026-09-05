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
