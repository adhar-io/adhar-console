import { env } from '@adhar-console/utils'

/**
 * LLM provider — OpenAI-compatible chat completions. Self-hosted / air-gapped
 * friendly: point `AI_BASE_URL` at any OpenAI-compatible endpoint (vLLM, Ollama
 * `/v1`, LiteLLM, LocalAI, …). No external Anthropic calls.
 *
 *   AI_BASE_URL   e.g. http://litellm.adhar-system.svc.cluster.local/v1
 *   AI_API_KEY    bearer token for that endpoint (optional for some)
 *   AI_MODEL      model id (default "default")
 */
export interface AiConfig {
  baseUrl: string
  apiKey?: string
  model: string
}

export function getAiConfig(): AiConfig | null {
  const baseUrl = env('AI_BASE_URL')?.replace(/\/$/, '')
  if (!baseUrl) return null
  return { baseUrl, apiKey: env('AI_API_KEY'), model: env('AI_MODEL') ?? 'default' }
}

export function isAiConfigured(): boolean {
  return getAiConfig() !== null
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
export interface ChatMessage {
  role: ChatRole
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}
export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface StreamDelta {
  content?: string
  toolCalls?: ToolCall[]
  finishReason?: string
}

/**
 * Streaming chat completion. Yields deltas as they arrive (content tokens and,
 * at the end of a tool round, the accumulated tool_calls + finish_reason).
 */
export async function* streamChat(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; temperature?: number; signal?: AbortSignal } = {},
): AsyncGenerator<StreamDelta> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.2,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
    }),
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI provider error ${res.status}: ${text.slice(0, 300)}`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  // Accumulate streamed tool_calls by index (OpenAI streams them piecemeal).
  const toolAcc: Record<number, { id: string; name: string; args: string }> = {}
  let finishReason: string | undefined

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let json: {
        choices?: Array<{
          delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
          finish_reason?: string
        }>
      }
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      const choice = json.choices?.[0]
      if (!choice) continue
      if (choice.delta?.content) yield { content: choice.delta.content }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const slot = (toolAcc[tc.index] ??= { id: '', name: '', args: '' })
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  }

  const toolCalls = Object.values(toolAcc)
    .filter((t) => t.name)
    .map((t) => ({ id: t.id || cryptoId(), type: 'function' as const, function: { name: t.name, arguments: t.args || '{}' } }))
  yield { toolCalls: toolCalls.length ? toolCalls : undefined, finishReason }
}

function cryptoId(): string {
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  return 'call_' + [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}
