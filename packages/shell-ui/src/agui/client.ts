import { EventType } from '@ag-ui/core'
import type {
  BaseEvent,
  CustomEvent as AguiCustomEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from '@ag-ui/core'

/**
 * AG-UI client transport for Adhar AI.
 *
 * The console's BFF (`POST /api/ai/run`) is an AG-UI server: it takes a
 * `RunAgentInput` and streams canonical AG-UI events over SSE. This module is
 * the browser half — it posts the input and yields typed events.
 *
 * We use the protocol's own `EventType` enum and event types rather than
 * re-declaring them, so a protocol upgrade surfaces as a type error here
 * instead of a silently ignored event at runtime. We do NOT use
 * `@ag-ui/client`'s `HttpAgent`: it brings an rxjs + protobuf runtime for a
 * transport we need to control anyway (same-origin cookie auth, the console's
 * 401 → re-login handling, and abort on panel close).
 */

/** The subset of AG-UI events this console reacts to. */
export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | AguiCustomEvent

/** A message in AG-UI's canonical shape — what we send back on a resume. */
export interface AguiMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content?: string
  name?: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

/** A frontend tool the browser executes on the agent's behalf. */
export interface FrontendTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface RunAgentRequest {
  threadId: string
  runId: string
  messages: AguiMessage[]
  tools?: FrontendTool[]
  context?: Array<{ description: string; value: string }>
  state?: Record<string, unknown>
  forwardedProps?: Record<string, unknown>
  signal?: AbortSignal
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  accent: string
  icon: string
  starters: Array<{ label: string; prompt: string }>
  tools: number
  /** Handled by the external adhar-ai runtime rather than the console's own loop. */
  delegated?: boolean
}

export interface AiConfig {
  configured: boolean
  model?: string
  protocol?: string
  defaultAgent?: string
  agents?: AgentInfo[]
}

let configCache: AiConfig | null = null

export async function getAiConfig(): Promise<AiConfig> {
  if (configCache) return configCache
  try {
    const res = await fetch('/api/ai/config', { credentials: 'include', headers: { accept: 'application/json' } })
    configCache = res.ok ? ((await res.json()) as AiConfig) : { configured: false }
  } catch {
    configCache = { configured: false }
  }
  return configCache
}

/** One thing adhar-ai's operators concluded on their own, without being asked. */
export interface OperatorFinding {
  id?: string
  operator?: string
  severity?: string
  title?: string
  summary?: string
  created_at?: string
}

/**
 * What the platform's operators have noticed.
 *
 * This is the half of the agentic runtime that works whether or not anyone is
 * chatting: operators watch Alertmanager and Argo CD and record what they
 * conclude. Failure is silent and returns nothing — an idle panel that cannot
 * reach the runtime should show no findings, not an error where an operator
 * expects a summary.
 */
export async function getOperatorFindings(limit = 6): Promise<OperatorFinding[]> {
  try {
    const res = await fetch(`/api/ai/findings?limit=${limit}`, { credentials: 'include', headers: { accept: 'application/json' } })
    if (!res.ok) return []
    const body = (await res.json()) as { findings?: OperatorFinding[] }
    return Array.isArray(body.findings) ? body.findings : []
  } catch {
    return []
  }
}

export class AgentRunError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'AgentRunError'
  }
}

/**
 * Run the agent, yielding AG-UI events as they arrive.
 *
 * Unknown event types are skipped rather than thrown on: AG-UI is versioned
 * additively, and a console that hard-fails on a new event type would break
 * the moment the protocol grows.
 */
export async function* runAgent(req: RunAgentRequest): AsyncGenerator<AguiEvent> {
  const res = await fetch('/api/ai/run', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    signal: req.signal,
    body: JSON.stringify({
      threadId: req.threadId,
      runId: req.runId,
      messages: req.messages,
      tools: req.tools ?? [],
      context: req.context ?? [],
      state: req.state ?? {},
      forwardedProps: req.forwardedProps ?? {},
    }),
  })

  if (!res.ok || !res.body) {
    let message = `Agent run failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string; hint?: string; issues?: string[] }
      if (body.error === 'ai_not_configured') message = 'Adhar AI is not configured on this cluster.'
      else if (body.error === 'unauthenticated') message = 'Your session expired — sign in again.'
      else if (body.issues?.length) message = `Invalid agent request: ${body.issues.join('; ')}`
      else if (body.error) message = body.error
    } catch {
      // keep the status-derived default
    }
    throw new AgentRunError(message, res.status)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  const KNOWN = new Set<string>(Object.values(EventType))

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        let event: BaseEvent
        try {
          event = JSON.parse(line.slice(5).trim()) as BaseEvent
        } catch {
          continue
        }
        if (!event || typeof event.type !== 'string' || !KNOWN.has(event.type)) continue
        yield event as AguiEvent
      }
    }
  }
}

export { EventType }
