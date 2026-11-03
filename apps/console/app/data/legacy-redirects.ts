/**
 * Pages that moved between phases. Old links (bookmarks, notification hrefs,
 * docs) still point at the old home; the `/$phase/` route sends them on in
 * `beforeLoad`, before anything renders.
 *
 * Done there rather than with a rendered `<Navigate>`: TanStack's Navigate
 * calls `navigate()` whenever its props object changes, and a fresh object is
 * built on every render — so anything re-rendering the page first (the auth
 * status settling during a sign-in round trip) fired another navigation per
 * render, until React stopped it with "Maximum update depth exceeded" (#185).
 */

export interface LegacyRedirect {
  to: string
  search: Record<string, unknown>
}

export function legacyRedirect(phase: string, search: Record<string, unknown>): LegacyRedirect | null {
  const section = search.section
  // Builds moved from Platform to Develop.
  if (phase === 'platform' && section === 'ci') return { to: '/develop', search: { section: 'builds' } }
  // Code Builder was retired; the Visual Designer in Design replaces it.
  if (phase === 'develop' && section === 'codebuilder') return { to: '/design', search: { section: 'builder' } }
  // The Performance Center moved from Develop to Deliver (deep-link params kept).
  if (phase === 'develop' && section === 'performance') return { to: '/deliver', search: { ...search, section: 'performance' } }
  // Functions live in Develop only (deep-link params kept).
  if (phase === 'deliver' && section === 'functions') return { to: '/develop', search: { ...search, section: 'functions' } }
  // Chaos Engineering moved from Platform to Deliver.
  if (phase === 'platform' && section === 'chaos') return { to: '/deliver', search: { section: 'chaos' } }
  return null
}
