import { resolveIdentity } from '../k8s/gateway.ts'
import { getAiConfig, isAiConfigured } from './provider.ts'
import { getRequestUser } from '../request-user.ts'
import { openStore } from '../workspace/store.ts'
import { emitNotification } from '../notify.ts'
import { runAgent } from './agui/run.ts'
import { AGENTS, DEFAULT_AGENT } from './agui/agents.ts'

/**
 * Adhar AI endpoints (`/api/ai/*`) — an AG-UI (Agent-User Interaction Protocol)
 * server.
 *
 *   GET  /api/ai/config  → { configured, model, protocol, agents }
 *   GET  /api/ai/agents  → the agent roster (id, name, description, starters)
 *   POST /api/ai/run     → RunAgentInput in, AG-UI SSE event stream out
 *
 * `/run` is the whole conversation surface: the browser posts a canonical
 * `RunAgentInput` (thread, run, messages, its own frontend tools, context,
 * forwardedProps.agent) and reads back canonical AG-UI events. Anything that
 * speaks AG-UI can drive this console's agents; see app/server/ai/agui/run.ts.
 *
 * Policy is unchanged: the agent reads the cluster with the SIGNED-IN USER's
 * RBAC, and it can only ever *propose* a change for a human to apply.
 */

export async function handleAi(req: Request, name: string): Promise<Response> {
  if (name === 'config') {
    const cfg = getAiConfig()
    return Response.json({
      configured: isAiConfigured(),
      model: cfg?.model,
      protocol: 'ag-ui',
      defaultAgent: DEFAULT_AGENT,
      agents: AGENTS.map(publicAgent),
    })
  }

  if (name === 'agents') {
    return Response.json({ agents: AGENTS.map(publicAgent), defaultAgent: DEFAULT_AGENT })
  }

  if (name !== 'run') {
    return Response.json({ error: 'unknown_ai_endpoint', endpoint: name }, { status: 404 })
  }
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 })
  }
  if (!isAiConfigured()) {
    return Response.json({ error: 'ai_not_configured', hint: 'set AI_BASE_URL / AI_MODEL' }, { status: 503 })
  }

  const identity = await resolveIdentity(req)
  if (!identity) return Response.json({ error: 'unauthenticated' }, { status: 401 })

  let input: unknown
  try {
    input = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const auth = await getRequestUser(req)
  const res = runAgent(input, {
    identity,
    signal: req.signal,
    onComplete: ({ findings, agent }) => {
      // A run that reached a real conclusion is worth a notification — the
      // operator may have navigated away while it worked. Never let this
      // affect the stream.
      const notable = findings.filter((f) => f.severity === 'critical' || f.severity === 'warning')
      if (!notable.length || !auth) return
      void (async () => {
        try {
          const store = await openStore(auth.activeTenant)
          if (!store) return
          await emitNotification(
            store,
            {
              kind: 'insight',
              title: `${agent.name} agent found ${notable.length} issue${notable.length === 1 ? '' : 's'}`,
              description: notable[0].title,
              source: 'ai',
              href: '/',
              audience: [auth.user.id],
              at: new Date().toISOString(),
              prompt: `Summarise your last findings and what I should do first.`,
            },
            auth.user.id,
          )
        } catch {
          // notifications are best-effort
        }
      })()
    },
  })

  if (identity.refreshedCookie && res.body) {
    const headers = new Headers(res.headers)
    headers.append('set-cookie', identity.refreshedCookie)
    return new Response(res.body, { status: res.status, headers })
  }
  return res
}

function publicAgent(a: (typeof AGENTS)[number]) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    accent: a.accent,
    icon: a.icon,
    starters: a.starters,
    tools: a.tools.length,
  }
}
