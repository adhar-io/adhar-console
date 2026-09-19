import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { setActiveTeam } from './selection-store.ts'

/**
 * The active team — the level between an organization and its projects in
 * `Organization → Team → Project → App`.
 *
 * All of that hierarchy already exists server-side: `workspace.team` documents
 * are tenant-scoped and reflected into Keycloak groups (`ws-team-<slug>`), a
 * member carries the team slugs they belong to, and a project carries the teams
 * that own it. What was missing is that a team was only ever a row in Workspace
 * admin — there was no way to say "I am working in this team" and have the
 * console follow, and no way to move between the teams you belong to.
 *
 * This hook adds exactly that, and deliberately nothing else. It does not own
 * teams (Workspace does), it reads them:
 *
 *   • `/api/workspace/teams` — the teams in the active organization.
 *   • `/api/workspace/me`    — the signed-in member, whose `teams` decides
 *                              which of them are *yours*.
 *   • `/api/prefs/active-team` — the selection, per user and server-side, so it
 *                              survives a reload and follows you between
 *                              devices rather than living in one browser.
 *
 * Switching does NOT reload the page. An organization switch re-signs the
 * session cookie because it changes which tenant's data the server will serve;
 * a team is a filter over data this session can already see, so reloading would
 * be a jarring answer to a click.
 */

export interface TeamSummary {
  id: string
  slug: string
  name: string
  description?: string
  /** False when the team exists only in the console, not yet in Keycloak. */
  keycloakSynced?: boolean
  /** True when the signed-in user is a member of this team. */
  mine?: boolean
}

export interface UseTeams {
  /** Teams in the active organization, the user's own first. */
  teams: TeamSummary[]
  /** Just the teams the signed-in user belongs to. */
  myTeams: TeamSummary[]
  activeId: string
  active?: TeamSummary
  ready: boolean
  loading: boolean
  switching: boolean
  error: string | null
  switchTeam(id: string): Promise<void>
  refresh(): void
  /** Which write is in flight, so one button can show progress without a global spinner. */
  busy: TeamAction | null
  /**
   * Create a team in the active organization. Resolves to the new team, or
   * null when the server refused — the caller keeps its dialog open and shows
   * `error` rather than guessing.
   */
  createTeam(input: { name: string; slug?: string; description?: string }): Promise<TeamSummary | null>
  renameTeam(id: string, name: string): Promise<boolean>
  deleteTeam(id: string): Promise<boolean>
}

/** A team write in flight. */
export type TeamAction = 'create' | 'rename' | 'delete'

const PREFS_SCOPE = 'active-team'

interface WsTeam {
  id: string
  slug: string
  name: string
  description?: string
  keycloakSynced?: boolean
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string }
    return body.detail || body.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

const json = { accept: 'application/json' }

/**
 * @param orgId Active organization. Changing it re-reads the list, because
 *   teams are tenant-scoped and the previous org's selection is meaningless.
 */
export function useTeams(orgId: string | undefined): UseTeams {
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [activeId, setActiveId] = useState('')
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    // `me` and the saved selection are both optional: a workspace with no
    // member record, or no database, should still list teams rather than
    // failing the whole switcher.
    Promise.all([
      fetch('/api/workspace/teams', { credentials: 'same-origin', headers: json }).then(async (res) => {
        if (!res.ok) throw new Error(await readError(res))
        return (await res.json()) as { items: WsTeam[] }
      }),
      fetch('/api/workspace/me', { credentials: 'same-origin', headers: json })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null) as Promise<{ teams?: string[] } | null>,
      fetch(`/api/prefs/${PREFS_SCOPE}`, { credentials: 'same-origin', headers: json })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null) as Promise<{ data?: { id?: string } | null } | null>,
    ])
      .then(([list, me, pref]) => {
        if (cancelled) return
        const mine = new Set(me?.teams ?? [])
        const items: TeamSummary[] = (list.items ?? []).map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          description: t.description,
          keycloakSynced: t.keycloakSynced,
          mine: mine.has(t.slug),
        }))
        // Your own teams first — on a large organization the list is otherwise
        // mostly other people's teams, with yours somewhere in the middle.
        items.sort((a, b) => (a.mine === b.mine ? 0 : a.mine ? -1 : 1))
        setTeams(items)

        const saved = pref?.data?.id
        const valid = saved && items.some((t) => t.id === saved) ? saved : ''
        // Default to the first team you belong to, not simply the first team.
        setActiveId(valid || items.find((t) => t.mine)?.id || items[0]?.id || '')
        setReady(true)
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load teams')
        setReady(false)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [orgId, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  /* ─────────── writes ─────────── */

  const [busy, setBusy] = useState<TeamAction | null>(null)

  /**
   * One shape for all three writes: mark busy, call, surface the server's own
   * message on failure, re-read the list on success. Teams are mirrored into
   * Keycloak groups server-side, so the list is re-fetched rather than patched
   * locally — `keycloakSynced` is decided there and a local guess about it
   * would be a guess about whether access actually works.
   */
  const write = useCallback(
    async <T,>(action: TeamAction, run: () => Promise<Response>, parse?: (r: Response) => Promise<T>): Promise<T | null> => {
      setBusy(action)
      setError(null)
      try {
        const res = await run()
        if (!res.ok) throw new Error(await readError(res))
        // No parser means "nothing to read back" — resolve to a truthy marker
        // so callers can tell success from the null this returns on failure.
        const value = parse ? await parse(res) : (true as unknown as T)
        if (alive.current) refresh()
        return value
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : `Failed to ${action} team`)
        return null
      } finally {
        if (alive.current) setBusy(null)
      }
    },
    [refresh],
  )

  const createTeam = useCallback(
    (input: { name: string; slug?: string; description?: string }) =>
      write('create', () =>
        fetch('/api/workspace/teams', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { ...json, 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
        async (res) => {
          const t = (await res.json()) as WsTeam
          return { id: t.id, slug: t.slug, name: t.name, description: t.description, keycloakSynced: t.keycloakSynced, mine: true }
        },
      ),
    [write],
  )

  const renameTeam = useCallback(
    async (id: string, name: string) => {
      const res = await write('rename', () =>
        fetch(`/api/workspace/teams/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { ...json, 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      )
      return res !== null
    },
    [write],
  )

  const deleteTeam = useCallback(
    async (id: string) => {
      const ok = await write('delete', () =>
        fetch(`/api/workspace/teams/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', headers: json }),
      )
      // Deleting the team you were scoped to leaves the scope dangling; fall
      // back to whatever the refreshed list settles on rather than filtering
      // every page by a team that no longer exists.
      if (ok !== null && id === activeId) setActiveId('')
      return ok !== null
    },
    [write, activeId],
  )

  const switchTeam = useCallback(
    async (id: string) => {
      if (id === activeId) return
      // Optimistic: this is a local scope change, so the UI follows the click
      // at once and only rolls back if persisting it fails.
      const previous = activeId
      setActiveId(id)
      setSwitching(true)
      setError(null)
      try {
        const res = await fetch(`/api/prefs/${PREFS_SCOPE}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { ...json, 'content-type': 'application/json' },
          body: JSON.stringify({ data: { id } }),
        })
        if (!res.ok) throw new Error(await readError(res))
      } catch (e) {
        if (alive.current) {
          setActiveId(previous)
          setError(e instanceof Error ? e.message : 'Failed to switch team')
        }
      } finally {
        if (alive.current) setSwitching(false)
      }
    },
    [activeId],
  )

  const myTeams = useMemo(() => teams.filter((t) => t.mine), [teams])
  const active = teams.find((t) => t.id === activeId)

  /*
   * Publish the active team's SLUG into the shared selection store.
   *
   * `shell-ui` is not a Module-Federation singleton, so every remote holds its
   * own copy of this hook — a module-level variable would not cross the
   * host↔remote boundary. The selection store already solves that for cluster
   * and namespace (localStorage + a broadcast event), so the team rides the
   * same rails and every remote sees the same value.
   *
   * The slug rather than the id, because the slug is what the rest of the
   * platform already keys on: `ProjectDoc.teams`, member records, and the
   * Keycloak group name `ws-team-<slug>`.
   */
  useEffect(() => {
    if (!ready) return
    setActiveTeam(active?.slug ?? '')
  }, [ready, active?.slug])

  return {
    teams,
    myTeams,
    activeId,
    active,
    ready,
    loading,
    switching,
    error,
    switchTeam,
    refresh,
    busy,
    createTeam,
    renameTeam,
    deleteTeam,
  }
}
