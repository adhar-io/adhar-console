import { env } from '@adhar-console/utils'
import { getTool } from './tool-registry.ts'

/**
 * Shared Gitea connection + auth for server-side handlers that talk to the
 * Gitea API directly (template discovery + the scaffolder). These are NOT
 * routed through `/api/svc/gitea`; they build the auth header themselves.
 *
 * Auth precedence — the durable path first:
 *   1. HTTP **Basic** `base64(GITEA_USERNAME:GITEA_PASSWORD)` when both admin
 *      creds are present (the durable credentials on the pod; a PAT rotation
 *      can't break them), else
 *   2. `token <GITEA_TOKEN>` when a personal-access token is configured.
 *
 * Gitea's REST API accepts either. Returns null when Gitea has no base URL or
 * no usable credentials, so callers can report an honest `configured:false`.
 */
export interface GiteaConn {
  /** Absolute API base, e.g. `https://gitea.example.com/api/v1` (no trailing slash). */
  base: string
  /** Ready-to-send Authorization header value. */
  authHeader: string
}

/** UTF-8 safe base64 (Basic auth credentials may contain non-ASCII). */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

export function giteaConn(): GiteaConn | null {
  const gitea = getTool('gitea')
  if (!gitea?.baseUrl) return null

  const user = env('GITEA_USERNAME')
  const pass = env('GITEA_PASSWORD')
  const token = gitea.serviceToken || env('GITEA_TOKEN')

  let authHeader: string | undefined
  if (user && pass) authHeader = `Basic ${b64(`${user}:${pass}`)}`
  else if (token) authHeader = `token ${token}`
  if (!authHeader) return null

  return { base: `${gitea.baseUrl}/api/v1`, authHeader }
}

/** A `fetch` bound to the Gitea API base with the resolved auth header. */
export function giteaFetcher(conn: GiteaConn) {
  return (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${conn.base}${path}`, {
      ...init,
      headers: {
        authorization: conn.authHeader,
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
}
