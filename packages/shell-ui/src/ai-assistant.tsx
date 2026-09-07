import { useEffect, useState, type ReactNode } from 'react'
import type { AiContext, AiMode } from './ai.ts'
import { assistStore, useAssist, type AskOptions } from './assist-store.ts'

export type { AskOptions } from './assist-store.ts'

/**
 * Adhar Assist — wiring.
 *
 * The assistant UI is the ⌘K overlay (`command-palette.tsx`, rendered by
 * AppShell inside the router). This file owns the cross-remote plumbing:
 *
 *   • `useAi().ask(opts)` / `<AiButton>` from ANY remote dispatch window
 *     events (React context does not cross Module-Federation boundaries).
 *   • `<AiProvider>` (host, outside the router) loads AI config, registers
 *     the host's proposal-apply handler on the shared store, renders the
 *     floating launcher, and translates `ask` events into a pending request
 *     the overlay consumes when it opens.
 *   • `AppShell` listens for `adhar:ai:open` / `adhar:ai:close` to show the
 *     overlay.
 */

const ASK_EVENT = 'adhar:ai:ask'
export const OPEN_EVENT = 'adhar:ai:open'
export const CLOSE_EVENT = 'adhar:ai:close'

function emit(name: string, detail?: unknown) {
  if (typeof document !== 'undefined') globalThis.dispatchEvent(new CustomEvent(name, { detail }))
}

/** A request queued by `ask()` for the overlay to run as soon as it mounts. */
let pendingAsk: AskOptions | null = null
export function consumePendingAsk(): AskOptions | null {
  const p = pendingAsk
  pendingAsk = null
  return p
}

/**
 * Trigger the assistant from anywhere (host or any remote). Provider-free: it
 * dispatches window events the host-mounted plumbing listens for.
 */
export function useAi(): { ask(opts: AskOptions): void; open(): void; close(): void; configured: boolean } {
  const { configured } = useAssist()
  useEffect(() => {
    void assistStore.loadConfig()
  }, [])
  return {
    ask: (opts) => emit(ASK_EVENT, opts),
    open: () => emit(OPEN_EVENT),
    close: () => emit(CLOSE_EVENT),
    configured,
  }
}

export interface AiProviderProps {
  children: ReactNode
  /** Apply a model-proposed manifest. Return a human-readable result. */
  onApplyProposal?(manifest: unknown): Promise<{ ok: boolean; message: string }>
}

export function AiProvider({ children, onApplyProposal }: AiProviderProps) {
  const { configured, busy } = useAssist()
  const [overlayOpen, setOverlayOpen] = useState(false)

  useEffect(() => {
    void assistStore.loadConfig()
  }, [])

  useEffect(() => {
    assistStore.setApplyHandler(onApplyProposal ?? null)
    return () => assistStore.setApplyHandler(null)
  }, [onApplyProposal])

  // ask → queue the request and open the overlay (AppShell shows it).
  useEffect(() => {
    const onAsk = (e: Event) => {
      pendingAsk = (e as CustomEvent<AskOptions>).detail ?? {}
      emit(OPEN_EVENT)
    }
    const onOpen = () => setOverlayOpen(true)
    const onClose = () => setOverlayOpen(false)
    globalThis.addEventListener(ASK_EVENT, onAsk)
    globalThis.addEventListener(OPEN_EVENT, onOpen)
    globalThis.addEventListener(CLOSE_EVENT, onClose)
    return () => {
      globalThis.removeEventListener(ASK_EVENT, onAsk)
      globalThis.removeEventListener(OPEN_EVENT, onOpen)
      globalThis.removeEventListener(CLOSE_EVENT, onClose)
    }
  }, [])

  return (
    <>
      {children}
      {!overlayOpen ? (
        <button
          type="button"
          onClick={() => emit(OPEN_EVENT)}
          className="group fixed bottom-5 right-5 z-50 flex h-12 items-center gap-2 rounded-full bg-linear-to-br from-brand-500 to-accent-500 pl-3 pr-4 text-white shadow-lg ring-1 ring-black/10 transition-transform hover:scale-[1.03]"
          aria-label="Open Adhar Assist"
          title="Adhar Assist (⌘K)"
        >
          <span className="relative flex h-6 w-6 items-center justify-center">
            <SparkIcon />
            {busy ? <span className="absolute inset-0 animate-ping rounded-full bg-white/40" /> : null}
          </span>
          <span className="text-[13px] font-semibold">Assist</span>
          {!configured ? <span className="rounded-full bg-white/20 px-1.5 text-[10px]">search</span> : null}
        </button>
      ) : null}
    </>
  )
}

/* ─────────────── inline trigger ─────────────── */

export function AiButton({
  mode = 'chat',
  context,
  prompt,
  label = 'Ask AI',
  title,
  className,
}: {
  mode?: AiMode
  context?: AiContext
  prompt?: string
  label?: string
  title?: string
  className?: string
}) {
  const ai = useAi()
  if (!ai.configured) return null
  return (
    <button
      type="button"
      onClick={() => ai.ask({ mode, context, prompt, title })}
      className={
        className ??
        'inline-flex items-center gap-1.5 rounded-md border border-brand-200 dark:border-brand-500/25 bg-brand-50 dark:bg-brand-500/10 px-2.5 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 transition-colors hover:border-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/15'
      }
    >
      <SparkIcon /> {label}
    </button>
  )
}

export function SparkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4L12 2z" />
    </svg>
  )
}
