import { resolveIdentity } from '../k8s/gateway.ts'
import { getAiConfig, isAiConfigured } from './provider.ts'
import { getRequestUser } from '../request-user.ts'
import { openStore } from '../workspace/store.ts'
import { emitNotification } from '../notify.ts'
import { runAgent } from './agui/run.ts'
import { AGENTS, DEFAULT_AGENT } from './agui/agents.ts'
import {
  adharAiAddNote,
  adharAiFeedback,
  adharAiFindings,
  adharAiHealth,
  adharAiKnowledgeSearch,
  adharAiKnowledgeStats,
  adharAiRuntimeConfig,
  isAdharAiConfigured,
} from './adhar-ai.ts'

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
      // Reported separately from `configured`: the console's own agents and the
      // agentic runtime fail independently, and collapsing them into one flag
      // would blame the wrong thing.
      adharAi: { configured: isAdharAiConfigured() },
      agents: availableAgents().map(publicAgent),
    })
  }

  if (name === 'agents') {
    return Response.json({ agents: availableAgents().map(publicAgent), defaultAgent: DEFAULT_AGENT })
  }

  /*
   * Operator findings from adhar-ai — the agentic surface that exists whether
   * or not anyone is chatting. Its operators watch Alertmanager and Argo CD
   * notifications and record what they conclude; this is how the console shows
   * that work. Gated on the signed-in user and forwarded with their token,
   * because a finding carries the cluster detail the read tools are RBAC-scoped
   * to protect.
   */
  if (name === 'findings') {
    if (!isAdharAiConfigured()) {
      return Response.json({ error: 'adhar_ai_not_configured', hint: 'set ADHAR_AI_URL' }, { status: 503 })
    }
    const who = await resolveIdentity(req)
    if (!who) return Response.json({ error: 'unauthenticated' }, { status: 401 })
    const limit = Number(new URL(req.url).searchParams.get('limit') ?? '20')
    const res = await adharAiFindings({ bearer: who.token, limit: Number.isFinite(limit) ? limit : 20 })
    if (!res.ok) {
      return Response.json({ error: 'adhar_ai_unavailable', detail: res.error }, { status: 502 })
    }
    const body = res.data
    return Response.json({ findings: body.findings ?? body.items ?? [] })
  }

  /*
   * The runtime's own shape — which MCP servers are live, which tools they
   * expose, how grounding is retrieved, which operators are loaded. Shown in
   * the assistant so "what can you actually do" has an answer that comes from
   * the runtime rather than from marketing copy. `/healthz` is unauthenticated
   * on the runtime (it is the probe) but `/config` is not, so the merged view
   * is gated on the signed-in user like everything else here.
   */
  if (name === 'runtime') {
    if (!isAdharAiConfigured()) {
      return Response.json({ configured: false })
    }
    const who = await resolveIdentity(req)
    if (!who) return Response.json({ error: 'unauthenticated' }, { status: 401 })
    const [health, cfg] = await Promise.all([adharAiHealth(), adharAiRuntimeConfig({ bearer: who.token })])
    if (!health.ok) {
      return Response.json({ configured: true, reachable: false, error: health.error })
    }
    const h = health.data
    return Response.json({
      configured: true,
      reachable: true,
      status: h.status,
      autonomyDefault: h.autonomy_default,
      operators: cfg.ok ? cfg.data.operators ?? {} : Object.fromEntries((h.operators ?? []).map((o) => [o, {}])),
      mcp: {
        connected: h.mcp_servers_connected ?? [],
        unreachable: h.mcp_servers_unreachable ?? {},
      },
      tools: h.tools ?? [],
      rag: h.rag,
      findingsHeld: h.findings_held ?? 0,
      limits: cfg.ok ? cfg.data.limits : undefined,
      writePolicy: cfg.ok ? cfg.data.writePolicy : undefined,
    })
  }

  /*
   * Knowledge base. GET is the stats; POST with `{query}` is a search, with
   * `{title, body}` a note to remember. Retrieval without an agent run is the
   * cheap way to ask "what does the platform know about X", and adding a note
   * is the human half of the learning loop — indexed immediately, so an outage
   * written up at 02:00 is askable at 02:01.
   */
  if (name === 'knowledge') {
    if (!isAdharAiConfigured()) {
      return Response.json({ error: 'adhar_ai_not_configured' }, { status: 503 })
    }
    const who = await resolveIdentity(req)
    if (!who) return Response.json({ error: 'unauthenticated' }, { status: 401 })

    if (req.method === 'GET') {
      const res = await adharAiKnowledgeStats({ bearer: who.token })
      return res.ok ? Response.json(res.data) : Response.json({ error: 'adhar_ai_unavailable', detail: res.error }, { status: 502 })
    }
    if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 })

    let body: { query?: unknown; k?: unknown; kinds?: unknown; title?: unknown; body?: unknown; kind?: unknown; tags?: unknown }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }

    if (typeof body.title === 'string' && typeof body.body === 'string') {
      const kind = body.kind === 'runbook' || body.kind === 'incident' ? body.kind : 'note'
      const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : []
      const res = await adharAiAddNote({ title: body.title.slice(0, 200), body: body.body.slice(0, 20_000), kind, tags }, { bearer: who.token })
      return res.ok ? Response.json(res.data) : Response.json({ error: 'adhar_ai_unavailable', detail: res.error }, { status: 502 })
    }

    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) return Response.json({ error: 'query_required' }, { status: 400 })
    const k = typeof body.k === 'number' && body.k > 0 ? Math.min(body.k, 20) : 6
    const kinds = Array.isArray(body.kinds) ? body.kinds.filter((x): x is string => typeof x === 'string') : []
    const res = await adharAiKnowledgeSearch({ query, k, kinds }, { bearer: who.token })
    return res.ok ? Response.json(res.data) : Response.json({ error: 'adhar_ai_unavailable', detail: res.error }, { status: 502 })
  }

  /*
   * Feedback on an answer's grounding. The chunk ids arrive with the answer as
   * an AG-UI event; the verdict goes back here. The store nudges those chunks'
   * ranking — bounded, so one vote cannot bury the only document that answers
   * a question.
   */
  if (name === 'feedback') {
    if (!isAdharAiConfigured()) {
      return Response.json({ error: 'adhar_ai_not_configured' }, { status: 503 })
    }
    if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 })
    const who = await resolveIdentity(req)
    if (!who) return Response.json({ error: 'unauthenticated' }, { status: 401 })
    let body: { chunkIds?: unknown; helpful?: unknown }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    const chunkIds = Array.isArray(body.chunkIds) ? body.chunkIds.filter((x): x is number => typeof x === 'number' && Number.isInteger(x)) : []
    if (!chunkIds.length) return Response.json({ error: 'chunk_ids_required' }, { status: 400 })
    const res = await adharAiFeedback({ chunk_ids: chunkIds.slice(0, 50), helpful: body.helpful !== false }, { bearer: who.token })
    return res.ok ? Response.json(res.data) : Response.json({ error: 'adhar_ai_unavailable', detail: res.error }, { status: 502 })
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
    /** True for agents handled by an external runtime rather than this loop. */
    delegated: Boolean(a.delegateTo),
  }
}

/**
 * The roster the UI may offer.
 *
 * A delegated agent is only listed when its runtime is actually configured —
 * offering "Adhar AI" on an install without `ADHAR_AI_URL` would put a choice
 * in the switcher whose every message fails. The console's own agents need no
 * such gate: they run on the LLM endpoint this handler already checked.
 */
function availableAgents() {
  const adharAi = isAdharAiConfigured()
  return AGENTS.filter((a) => a.delegateTo !== 'adhar-ai' || adharAi)
}
