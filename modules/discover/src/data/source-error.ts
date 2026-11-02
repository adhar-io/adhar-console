/**
 * What a failed backing-tool call actually means, for the Discover views.
 *
 * The status alone lies: the console BFF answers 502 both when the upstream
 * replied with a gateway error (PostHog / Grafana booting behind their own
 * proxy) and when the BFF could not connect at all (`upstream_unreachable`).
 * The first is "starting up, retry in a moment"; the second is "nothing is
 * listening" — telling an operator the tool is booting when it is not even
 * reachable sends them to wait instead of to fix the connection. The BFF puts
 * a machine code in the JSON body (`{ error: 'upstream_unreachable' }`), and
 * both `HttpError` (api-clients) and `PostHogError` keep that body on `.body`.
 */

/** The console BFF's own error code on a failed proxy call, if it sent one. */
export function bffErrorCode(error: unknown): string | undefined {
  const body = (error as { body?: unknown } | null)?.body
  if (!body || typeof body !== 'object') return undefined
  const code = (body as { error?: unknown }).error
  return typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : undefined
}

/** BFF codes meaning the console has no connection / credential for the tool. */
const NOT_CONFIGURED = new Set([
  'tool_not_configured',
  'auth_not_configured',
  'basic_credentials_missing',
  'login_credentials_missing',
])

export type SourceErrorKind = 'not-configured' | 'unauthorized' | 'rejected' | 'unreachable' | 'timeout' | 'starting' | 'other'

export function sourceErrorKind(error: unknown): SourceErrorKind {
  const code = bffErrorCode(error)
  if (code === 'upstream_unreachable') return 'unreachable'
  if (code === 'upstream_timeout') return 'timeout'
  if (code && NOT_CONFIGURED.has(code)) return 'not-configured'
  // The BFF signs in to the tool with a service credential and was refused.
  if (code === 'login_session_failed') return 'rejected'
  const status = (error as { status?: number } | null)?.status
  const name = (error as { name?: string } | null)?.name
  if (status === 404 || status === 501) return 'not-configured'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 502 || status === 503 || status === 504) return 'starting'
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'NetworkError') return 'unreachable'
  return 'other'
}

export function classifySourceError(tool: string, error: unknown): { title: string; description: string } {
  const status = (error as { status?: number } | null)?.status
  switch (sourceErrorKind(error)) {
    case 'not-configured':
      return {
        title: `${tool} is not configured`,
        description: `No ${tool} backend is wired to this workspace yet. Connect ${tool} through the platform integrations to populate this view.`,
      }
    case 'unauthorized':
      return {
        title: `Not authorized for ${tool}`,
        description: `Your session can't read from ${tool}. Check your role or re-authenticate, then retry.`,
      }
    case 'rejected':
      return {
        title: `${tool} rejected the console's sign-in`,
        description: `The console signs in to ${tool} with a service credential and ${tool} refused it. Check the ${tool} credentials in the console server's environment.`,
      }
    case 'unreachable':
      return {
        title: `Can't reach ${tool}`,
        description: `The console couldn't connect to ${tool}. Confirm the ${tool} service is running and reachable from the console, then retry.`,
      }
    case 'timeout':
      return {
        title: `${tool} timed out`,
        description: `The request to ${tool} took too long to respond. Retry, or check the backend's health.`,
      }
    case 'starting':
      return {
        title: `${tool} is unavailable`,
        description: `The ${tool} backend responded but isn't ready (HTTP ${status}). It may be starting up — retry in a moment.`,
      }
    default:
      return {
        title: `Couldn't load ${tool} data`,
        description: error instanceof Error && error.message ? error.message : `An unexpected error occurred talking to ${tool}.`,
      }
  }
}
