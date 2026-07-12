import { createFileRoute } from '@tanstack/react-router'
import { proxyToolRequest } from '~/server/proxy.ts'

/**
 * /api/svc/<tool>/<...upstream path> — same-origin BFF proxy to a backing tool.
 *
 * Examples:
 *   GET  /api/svc/gitea/api/v1/orgs/acme/repos
 *   GET  /api/svc/k8s/api/v1/namespaces/payments/pods
 *
 * The session cookie authenticates the caller; the server injects the upstream
 * credential. See app/server/proxy.ts + tool-registry.ts.
 */
const handle = ({
  request,
  params,
}: {
  request: Request
  params: { tool: string; _splat?: string }
}) => proxyToolRequest(request, params.tool, params._splat ?? '')

export const Route = createFileRoute('/api/svc/$tool/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
})
