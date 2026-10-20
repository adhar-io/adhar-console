import { getAiConfig, runAguiAgent } from '@adhar/shell-ui'
import { useEffect, useState } from 'react'

/**
 * Adhar AI for the Design module — the console's own agent endpoint
 * (`POST /api/ai/run`, AG-UI over SSE, same-origin cookie auth). The model,
 * key and policy live on the platform; this sends a prompt plus grounding
 * context and reads the streamed text back. When `/api/ai/config` says AI is
 * not configured the callers show that instead of a button that cannot work.
 */

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export interface AiContextEntry {
  description: string
  value: string
}

export interface DraftOptions {
  prompt: string
  context?: AiContextEntry[]
  signal?: AbortSignal
  onDelta?(textSoFar: string): void
}

/** Run one prompt and return the assistant's full reply. */
export async function askAdharAi(opts: DraftOptions): Promise<string> {
  let text = ''
  for await (const ev of runAguiAgent({
    threadId: uid(),
    runId: uid(),
    messages: [{ id: uid(), role: 'user', content: opts.prompt }],
    context: opts.context ?? [],
    forwardedProps: { surface: 'design' },
    signal: opts.signal,
  })) {
    const e = ev as { type: string; delta?: string; message?: string }
    if (e.type === 'TEXT_MESSAGE_CONTENT' && e.delta) {
      text += e.delta
      opts.onDelta?.(text)
    } else if (e.type === 'RUN_ERROR') {
      throw new Error(e.message || 'Adhar AI run failed')
    }
  }
  return text
}

/** `null` while loading, then whether Adhar AI is configured on this cluster. */
export function useAiConfigured(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    getAiConfig().then((c) => alive && setOk(c.configured === true)).catch(() => alive && setOk(false))
    return () => {
      alive = false
    }
  }, [])
  return ok
}

export { draftPrompt, type DraftKind, extractFenced, ideaLines } from './ai-text.ts'
