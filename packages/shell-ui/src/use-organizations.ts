import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Organizations (workspaces) the signed-in user can access, backed by
 * `/api/organizations`. The list is built from their Keycloak groups — an
 * organization is listed because they are in `org-<slug>` (or its `-admin`
 * group), and platform admins see every organization. An org is the tenant
 * that scopes the console's own data; switching / creating re-signs the
 * session cookie's `activeTenant`, so we do a full reload afterwards for a
 * clean slate across every module.
 */
export interface OrgSummary {
  /** The tenant id. */
  id: string
  name: string
  slug: string
  createdAt?: string
  /** The user's role in this organization. */
  role?: 'admin' | 'member'
  /**
   * How they hold it: their own membership, a platform admin group (admin of
   * every organization), or — in the platform's own organization — the
   * platform team. Only a membership of their own can be left.
   */
  via?: 'membership' | 'platform-admin' | 'platform-team'
}

export type OrgAction = 'switch' | 'create' | 'rename' | 'leave' | null

export interface UseOrganizations {
  orgs: OrgSummary[]
  /** The active tenant, or '' when the user is in no organization. */
  activeId: string
  /** True once the real list has loaded from the server. */
  ready: boolean
  /** The list came from the sign-in token because Keycloak could not be asked. */
  degraded: boolean
  loading: boolean
  busy: OrgAction
  error: string | null
  switchOrg(id: string): Promise<void>
  createOrg(name: string): Promise<OrgSummary | null>
  /** Rename in place (no reload) — resolves true on success. */
  renameOrg(id: string, name: string): Promise<boolean>
  /**
   * Leave an organization — removes the user from its Keycloak groups. Resolves
   * true on success (the page reloads if the active org was left).
   */
  leaveOrg(id: string): Promise<boolean>
  refresh(): void
}

/** The codes a person can act on, in their words; anything else shows the server's detail. */
const ORG_ERROR: Record<string, string> = {
  reauth_required: 'Your session does not carry this membership yet. Sign out and sign back in to switch to it.',
  not_a_member: 'You are not a member of that organization.',
  cannot_leave_last_admin: 'You are its last admin. Make someone else an admin before you leave.',
  platform_admin_access: 'You see this organization as a platform admin, not as a member, so there is no membership to leave.',
  requires_org_admin: 'Only an admin of that organization can do this.',
  keycloak_unavailable: 'Keycloak could not be reached. Try again in a moment.',
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string }
    return (body.error && ORG_ERROR[body.error]) || body.detail || body.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export function useOrganizations(): UseOrganizations {
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [activeId, setActiveId] = useState('')
  const [ready, setReady] = useState(false)
  const [degraded, setDegraded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<OrgAction>(null)
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
    fetch('/api/organizations', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res))
        return (await res.json()) as { organizations: OrgSummary[]; activeId: string; degraded?: boolean }
      })
      .then((data) => {
        if (cancelled) return
        setOrgs(data.organizations ?? [])
        setActiveId(data.activeId ?? '')
        setDegraded(data.degraded === true)
        setReady(true)
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        // Not signed in / no DB → the switcher falls back to whatever props it
        // was given; surface the reason but don't crash the shell.
        setError(e instanceof Error ? e.message : 'Failed to load organizations')
        setReady(false)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const switchOrg = useCallback(
    async (id: string) => {
      if (id === activeId || busy) return
      setBusy('switch')
      setError(null)
      try {
        const res = await fetch(`/api/organizations/${encodeURIComponent(id)}/activate`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) throw new Error(await readError(res))
        // Cookie is re-scoped server-side — reload for a clean slate.
        globalThis.location.assign('/')
      } catch (e) {
        if (alive.current) {
          setError(e instanceof Error ? e.message : 'Could not switch organization')
          setBusy(null)
        }
      }
    },
    [activeId, busy],
  )

  const createOrg = useCallback(
    async (name: string): Promise<OrgSummary | null> => {
      const trimmed = name.trim()
      if (!trimmed || busy) return null
      setBusy('create')
      setError(null)
      try {
        const res = await fetch('/api/organizations', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        })
        if (!res.ok) throw new Error(await readError(res))
        const data = (await res.json()) as { organization: OrgSummary }
        // New org is now active — reload into it.
        globalThis.location.assign('/')
        return data.organization
      } catch (e) {
        if (alive.current) {
          setError(e instanceof Error ? e.message : 'Could not create organization')
          setBusy(null)
        }
        return null
      }
    },
    [busy],
  )

  const renameOrg = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      const trimmed = name.trim()
      if (!trimmed || busy) return false
      setBusy('rename')
      setError(null)
      try {
        const res = await fetch(`/api/organizations/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        })
        if (!res.ok) throw new Error(await readError(res))
        const data = (await res.json()) as { organization: OrgSummary }
        if (alive.current) {
          // Name-only change — patch the local list instead of reloading.
          setOrgs((prev) => prev.map((o) => (o.id === id ? { ...o, ...data.organization } : o)))
          setBusy(null)
        }
        return true
      } catch (e) {
        if (alive.current) {
          setError(e instanceof Error ? e.message : 'Could not rename organization')
          setBusy(null)
        }
        return false
      }
    },
    [busy],
  )

  // DELETE on an organization means "take me out of it": the server removes the
  // user from its Keycloak groups and refuses to strand it without an admin.
  // Deleting an organization itself is Settings → Delete org.
  const leaveOrg = useCallback(
    async (id: string): Promise<boolean> => {
      if (busy) return false
      setBusy('leave')
      setError(null)
      try {
        const res = await fetch(`/api/organizations/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) throw new Error(await readError(res))
        const data = (await res.json()) as { switched?: boolean }
        if (data.switched) {
          globalThis.location.assign('/')
          return true
        }
        if (alive.current) {
          setBusy(null)
          refresh()
        }
        return true
      } catch (e) {
        if (alive.current) {
          setError(e instanceof Error ? e.message : 'Could not leave the organization')
          setBusy(null)
        }
        return false
      }
    },
    [busy, refresh],
  )

  return { orgs, activeId, ready, degraded, loading, busy, error, switchOrg, createOrg, renameOrg, leaveOrg, refresh }
}
