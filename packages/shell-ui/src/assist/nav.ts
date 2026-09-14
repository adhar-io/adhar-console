import type { ReactNode } from 'react'
import type { NavItem, NavSection } from '../nav-tree.tsx'

/**
 * The navigation lane — every page and command in the console, flattened and
 * ranked. With no LLM configured the assistant is still a full command
 * palette, and with one it is how "open the pods page" is a keystroke rather
 * than a conversation.
 */

export interface CommandItem {
  id: string
  label: string
  description?: string
  to?: string
  search?: Record<string, unknown>
  group?: string
  icon?: ReactNode
  /** Custom action — runs instead of navigating. */
  onSelect?(): void
  keywords?: string[]
}

export function flattenNav(sections: NavSection[]): CommandItem[] {
  const out: CommandItem[] = []
  const walk = (item: NavItem, groupLabel: string) => {
    if (item.to) {
      out.push({
        id: item.id,
        label: item.label,
        description: item.description,
        to: item.to,
        search: item.search ? { section: item.search } : undefined,
        group: groupLabel,
        icon: item.icon,
        keywords: item.description ? [item.description] : undefined,
      })
    }
    item.children?.forEach((c) => walk(c, groupLabel))
  }
  for (const section of sections) {
    const label = section.label ?? 'General'
    for (const item of section.items) walk(item, label)
  }
  return out
}

export function filterItems(items: CommandItem[], q: string): CommandItem[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return items
  return items
    .map((item) => ({ item, score: score(item, needle) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
}

function score(item: CommandItem, needle: string): number {
  const label = item.label.toLowerCase()
  let s = 0
  if (label === needle) s += 100
  else if (label.startsWith(needle)) s += 50
  else if (label.includes(needle)) s += 25
  if (item.group?.toLowerCase().includes(needle)) s += 6
  if (item.description?.toLowerCase().includes(needle)) s += 10
  if (item.keywords?.some((k) => k.toLowerCase().includes(needle))) s += 8
  // Multi-word queries: every word must hit somewhere.
  const words = needle.split(/\s+/).filter((w) => w.length > 2)
  if (words.length > 1) {
    const hay = `${label} ${item.description ?? ''} ${item.group ?? ''}`.toLowerCase()
    if (words.every((w) => hay.includes(w))) s += 15
  }
  return s
}

/**
 * Does this input read as "take me somewhere" rather than a question?
 *
 * Short, no question mark, no verb-ish opener, and it matches a page well.
 * Used to promote the Navigate lane when the operator is clearly typing a
 * page name — a question about pods and the word "pods" should not behave the
 * same way.
 */
export function looksLikeNavigation(input: string, topScoreLabel?: string): boolean {
  const q = input.trim()
  if (!q || q.length > 32 || /[?]/.test(q) || /\s/.test(q) && q.split(/\s+/).length > 3) return false
  if (/^(why|how|what|when|which|who|show|find|list|explain|diagnose|check|is|are|do|does|can|should)\b/i.test(q)) return false
  if (!topScoreLabel) return false
  return topScoreLabel.toLowerCase().startsWith(q.toLowerCase()) || q.toLowerCase().includes(topScoreLabel.toLowerCase())
}
