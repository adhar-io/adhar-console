import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Organizations (workspaces) the signed-in user can access, backed by
 * `/api/organizations`. An org is the tenant that scopes the console's own
 * data; switching / creating persists server-side (per-user) and re-signs the
 * session cookie's `activeTenant`, so we do a full reload afterwards for a
 * clean slate across every module.
 */
export interface OrgSummary {
  id: string
  name: string
  slug: string
  createdAt?: string
}

export type OrgAction = 'switch' | 'create' | 'delete' | null

export interface UseOrganizations {
  orgs: OrgSummary[]
  activeId: string
  /** True once the real list has loaded from the server. */
  ready: boolean
  loading: boolean
  busy: OrgAction
  error: string | null
  switchOrg(id: string): Promise<void>
  createOrg(name: string): Promise<OrgSummary | null>
  deleteOrg(id: string): Promise<void>
  refresh(): void
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string }
    return body.detail || body.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export function useOrganizations(): UseOrganizations {
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [activeId, setActiveId] = useState('')
  const [ready, setReady] = useState(false)
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
        return (await res.json()) as { organizations: OrgSummary[]; activeId: string }
      })
      .then((data) => {
        if (cancelled) return
        setOrgs(data.organizations ?? [])
        setActiveId(data.activeId ?? '')
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

  const deleteOrg = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy('delete')
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
          return
        }
        if (alive.current) {
          setBusy(null)
          refresh()
        }
      } catch (e) {
        if (alive.current) {
          setError(e instanceof Error ? e.message : 'Could not delete organization')
          setBusy(null)
        }
      }
    },
    [busy, refresh],
  )

  return { orgs, activeId, ready, loading, busy, error, switchOrg, createOrg, deleteOrg, refresh }
}
