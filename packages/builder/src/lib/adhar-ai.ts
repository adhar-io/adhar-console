import { getAiConfig, runAguiAgent } from '@adhar/shell-ui'

/**
 * Generation through Adhar AI — the console's own agent endpoint
 * (`POST /api/ai/run`, AG-UI over SSE, same-origin cookie auth).
 *
 * The standalone builder called OpenAI/Anthropic straight from the browser
 * with an API key typed into a settings field and kept in localStorage. Here
 * the model, the key and the policy live on the platform; the builder only
 * sends a prompt and reads the streamed text back. When Adhar AI is not
 * configured on the cluster the builder falls back to its offline generator.
 */

export async function adharAiAvailable(): Promise<boolean> {
  try {
    return (await getAiConfig()).configured === true
  } catch {
    return false
  }
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export interface AskOptions {
  prompt: string
  /** Extra grounding passed as AG-UI context entries. */
  context?: Array<{ description: string; value: string }>
  signal?: AbortSignal
  onDelta?(textSoFar: string): void
}

/** Run one prompt and return the assistant's full text reply. */
export async function askAdharAi(opts: AskOptions): Promise<string> {
  let text = ''
  for await (const ev of runAguiAgent({
    threadId: uid(),
    runId: uid(),
    messages: [{ id: uid(), role: 'user', content: opts.prompt }],
    context: opts.context ?? [],
    forwardedProps: { surface: 'builder' },
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

export const PAGE_INSTRUCTIONS = [
  'You are generating a UI page for a visual page builder.',
  'Reply with ONE fenced ```html block and nothing else of substance.',
  'The HTML is a body fragment: no <html>, <head>, <script>, <style> or inline event handlers.',
  'Style ONLY with Tailwind CSS utility classes. Prefer the semantic colour names',
  'bg-background, text-foreground, bg-card, bg-muted, text-muted-foreground, border-border,',
  'bg-primary, text-primary-foreground, bg-secondary, bg-accent so the page follows the design theme.',
  'Use <img alt="..."> for imagery (it becomes a placeholder). Keep it to one page, realistic copy, accessible structure.',
].join(' ')

export const CODE_INSTRUCTIONS = [
  'You are editing one source file inside a code builder.',
  'Reply with ONE fenced code block containing the COMPLETE new file content, then at most two sentences.',
].join(' ')
