/**
 * Browser client for the console AI assistant (`/api/ai/*`).
 *
 * The server streams Server-Sent Events; since we POST a body we read the
 * stream manually (EventSource can't POST). Events:
 *   token · tool · proposal · error · done
 */

export interface AiContext {
  group?: string
  version: string
  resource: string
  namespace?: string
  name?: string
  kind?: string
}

export interface AiProposal {
  summary: string
  manifest: unknown
}

export interface AiHandlers {
  onToken?(text: string): void
  onTool?(name: string, args: unknown): void
  onProposal?(p: AiProposal): void
  onError?(message: string): void
  onDone?(): void
}

export type AiMode = 'chat' | 'diagnose' | 'explain' | 'generate'

export interface AiRequest {
  mode: AiMode
  prompt?: string
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  context?: AiContext
  signal?: AbortSignal
}

let configCache: { configured: boolean; model?: string } | null = null

export async function getAiConfig(): Promise<{ configured: boolean; model?: string }> {
  if (configCache) return configCache
  try {
    const res = await fetch('/api/ai/config', { credentials: 'include', headers: { accept: 'application/json' } })
    configCache = res.ok ? await res.json() : { configured: false }
  } catch {
    configCache = { configured: false }
  }
  return configCache!
}

/** Run an AI request, streaming events to the handlers. Resolves on done/error. */
export async function streamAi(req: AiRequest, handlers: AiHandlers): Promise<void> {
  const res = await fetch(`/api/ai/${req.mode}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    signal: req.signal,
    body: JSON.stringify({
      mode: req.mode,
      prompt: req.prompt,
      messages: req.messages,
      context: req.context,
    }),
  })
  if (!res.ok || !res.body) {
    let msg = `AI request failed (${res.status})`
    try {
      const j = await res.json()
      msg = j.error === 'ai_not_configured' ? 'AI is not configured on this cluster.' : (j.error ?? msg)
    } catch {
      /* keep default */
    }
    handlers.onError?.(msg)
    return
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        let ev: { type: string; text?: string; name?: string; args?: unknown; summary?: string; manifest?: unknown; message?: string }
        try {
          ev = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        switch (ev.type) {
          case 'token':
            handlers.onToken?.(ev.text ?? '')
            break
          case 'tool':
            handlers.onTool?.(ev.name ?? '', ev.args)
            break
          case 'proposal':
            handlers.onProposal?.({ summary: ev.summary ?? '', manifest: ev.manifest })
            break
          case 'error':
            handlers.onError?.(ev.message ?? 'AI error')
            break
          case 'done':
            handlers.onDone?.()
            break
        }
      }
    }
  }
}
