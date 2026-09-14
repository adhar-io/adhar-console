import { useCallback, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { assistStore } from './agui/store.ts'
import { consumePendingAsk } from './ai-assistant.tsx'
import { AssistSurface } from './assist/surface.tsx'
import type { NavSection } from './nav-tree.tsx'
import { DEFAULT_NAV } from './nav-tree.tsx'
import type { CommandItem } from './assist/nav.ts'

export type { CommandItem } from './assist/nav.ts'
export { Markdown } from './assist/markdown.tsx'

/**
 * Adhar AI — the ⌘K overlay, and the primary way to talk to the platform.
 *
 * This file is the router-aware shim. The surface itself lives in
 * `./assist/` and is deliberately router-free so it can be rendered and
 * verified without one; what needs the router — following a navigation item,
 * and the `navigate_to` frontend tool the agent calls — is supplied here.
 *
 * The conversation runs on **AG-UI**: the BFF is an AG-UI server and the
 * surface an AG-UI client, so everything on screen is driven by protocol
 * events — text, tool calls, shared state, generative components, grounding.
 */
export interface CommandPaletteProps {
  open: boolean
  onClose(): void
  /** Sources — a set of flat commands to search through. */
  items?: CommandItem[]
  /** Falls back to DEFAULT_NAV flattened into commands. */
  sections?: NavSection[]
}

export function CommandPalette({ open, onClose, items, sections = DEFAULT_NAV }: CommandPaletteProps) {
  if (!open) return null
  return <Mounted onClose={onClose} items={items} sections={sections} />
}

function Mounted({ onClose, items, sections }: { onClose(): void; items?: CommandItem[]; sections: NavSection[] }) {
  const navigate = useNavigate()

  const onNavigate = useCallback((to: string, search?: Record<string, unknown>) => {
    navigate({ to, search: search as never })
  }, [navigate])

  // Boot: config, then any ask queued from a remote (`useAi().ask`, AiButton).
  useEffect(() => {
    void assistStore.loadConfig()
    const pending = consumePendingAsk()
    if (pending) {
      if (pending.agentId) assistStore.setAgent(pending.agentId)
      if (pending.context) assistStore.setContext(pending.context)
      if (pending.prompt) assistStore.send(pending.prompt, { context: pending.context, title: pending.title })
    }
  }, [])

  /**
   * Frontend tools. Registered while the overlay is mounted because they need
   * the router; the store outlives the overlay so a run keeps going if the
   * agent navigates and the panel closes.
   */
  useEffect(() => {
    assistStore.setFrontendHandler('navigate_to', (args) => {
      const path = String(args.path ?? '')
      if (!path.startsWith('/')) return JSON.stringify({ error: 'path must be a console route starting with /' })
      const [pathname, qs] = path.split('?')
      const search = qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined
      try {
        navigate({ to: pathname, search: search as never })
      } catch {
        return JSON.stringify({ error: `no such console route: ${pathname}` })
      }
      onClose()
      return JSON.stringify({ ok: true, navigated: path, note: 'The operator is now on this page.' })
    })
    assistStore.setFrontendHandler('open_resource', (args) => {
      globalThis.dispatchEvent(new CustomEvent('adhar:ai:open-resource', { detail: args }))
      return JSON.stringify({ ok: true, opened: `${String(args.kind)}/${String(args.name)}` })
    })
    return () => {
      assistStore.setFrontendHandler('navigate_to', null)
      assistStore.setFrontendHandler('open_resource', null)
    }
  }, [navigate, onClose])

  return <AssistSurface onClose={onClose} onNavigate={onNavigate} items={items} sections={sections} />
}
