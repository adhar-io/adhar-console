import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { plane } from '@adhar/api-clients'
import { usePlaneWorkspace, useToolPublicUrl } from '@adhar/shell-ui'

/**
 * Plane.so client + per-resource hooks for the Define module.
 *
 * The hook layer hides Plane's `(workspaceSlug, projectId)` ergonomics: every
 * hook reads the active project from `useActiveProject()` and skips the query
 * when nothing's selected. Pass an explicit `projectId` to override.
 *
 * Calls go through the console's BFF proxy (`/api/svc/plane/…`), which
 * injects the platform's Plane API key and shares reads for a few seconds so
 * every console user together stays inside Plane's per-key rate limit.
 *
 * Plane's public API has no Pages or Views endpoints: Pages open in Plane
 * itself (see `usePlaneLink`), and saved views are kept by the console in the
 * signed-in user's preferences.
 */

export const planeClient = plane.PlaneClient.auto({ tool: 'plane' })

/**
 * The Plane workspace slug is RUNTIME configuration — `/api/config.planeWorkspace`
 * (PLANE_WORKSPACE / PLANE_WORKSPACE_SLUG, defaulting to the Gitea org) — never a
 * hardcoded company. Every hook below reads it through usePlaneWorkspace(), so the
 * whole Define phase follows the real organization.
 */

const REFRESH_MS = 30_000

/* ───── selection state ───── */

export const ACTIVE_PROJECT_KEY = 'adhar.define.activeProject'

export function getStoredProjectId(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return localStorage.getItem(ACTIVE_PROJECT_KEY) ?? undefined
}

export function setStoredProjectId(id: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(ACTIVE_PROJECT_KEY, id)
}

/* ───── queries ───── */

export function useProjects() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'projects', WORKSPACE_SLUG],
    queryFn: () => planeClient.listProjects(WORKSPACE_SLUG),
    staleTime: REFRESH_MS,
  })
}

export function useProject(id?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'project', WORKSPACE_SLUG, id],
    queryFn: () => planeClient.getProject(WORKSPACE_SLUG, id!),
    enabled: !!id,
    staleTime: REFRESH_MS,
  })
}

export function useStates(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'states', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listStates(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useLabels(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'labels', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listLabels(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useIssues(projectId?: string, params?: plane.IssueListParams) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId, params],
    queryFn: () => planeClient.listIssues(WORKSPACE_SLUG, projectId!, params),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useCycles(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listCycles(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useModules(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listModules(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

/**
 * A link into Plane's own UI for this workspace — `path` is appended after the
 * workspace slug, e.g. `projects/<id>/pages`. Empty when the console cannot
 * tell where Plane is published.
 */
export function usePlaneLink(path = ''): string {
  const base = useToolPublicUrl('plane')
  const slug = usePlaneWorkspace()
  if (!base) return ''
  return `${base}/${slug}/${path.replace(/^\/+/, '')}`
}

export function useInvitations() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'invitations', WORKSPACE_SLUG],
    queryFn: () => planeClient.listInvitations(WORKSPACE_SLUG),
    staleTime: REFRESH_MS,
  })
}

export function useMembers() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'members', WORKSPACE_SLUG],
    queryFn: () => planeClient.listMembers(WORKSPACE_SLUG),
    staleTime: REFRESH_MS,
  })
}

export function useIssue(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'issue', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.getIssue(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useComments(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'comments', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listComments(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useActivities(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'activities', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listActivities(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useSubIssues(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'sub-issues', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listSubIssues(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

/* ───── mutations ───── */

export function useUpdateIssue(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      patch,
      current,
    }: {
      id: string
      patch: Partial<plane.Issue>
      /** The issue as last read — needed to move it out of its old cycle or module. */
      current?: Pick<plane.Issue, 'cycle' | 'module'>
    }) => planeClient.updateIssue(WORKSPACE_SLUG, projectId!, id, patch, current),
    onSuccess: (issue) => {
      qc.invalidateQueries({ queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'issue', WORKSPACE_SLUG, projectId, issue.id] })
      qc.invalidateQueries({ queryKey: ['plane', 'activities', WORKSPACE_SLUG, projectId, issue.id] })
    },
  })
}

export function useCreateIssue(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Issue>) =>
      planeClient.createIssue(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] })
    },
  })
}

export function useDeleteIssue(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteIssue(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId] })
    },
  })
}

/* ───── workspace + project mutations ───── */

export function useCreateProject() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Project>) => planeClient.createProject(WORKSPACE_SLUG, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

export function useUpdateProject() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<plane.Project> }) =>
      planeClient.updateProject(WORKSPACE_SLUG, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

export function useDeleteProject() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteProject(WORKSPACE_SLUG, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

export function useInviteMember() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { email: string; role: number }) =>
      planeClient.inviteMember(WORKSPACE_SLUG, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'invitations', WORKSPACE_SLUG] }),
  })
}

export function useDeleteInvitation() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteInvitation(WORKSPACE_SLUG, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'invitations', WORKSPACE_SLUG] }),
  })
}

/* ───── cycle / module / view mutations ───── */

export function useCreateCycle(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Cycle>) =>
      planeClient.createCycle(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] }),
  })
}
export function useDeleteCycle(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteCycle(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] }),
  })
}

export function useCreateModule(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Module>) =>
      planeClient.createModule(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] }),
  })
}
export function useDeleteModule(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteModule(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] }),
  })
}

/* ───── saved views (console-side; Plane's API has none) ───── */

/**
 * Saved issue views live in the signed-in user's console preferences
 * (`/api/prefs/define-views`), keyed by Plane workspace and project. Plane's
 * public API exposes no views endpoint, so this is the only place a view
 * saved from the console can be kept.
 */
const VIEWS_SCOPE = 'define-views'
type ViewStore = Record<string, plane.View[]>

async function readViewStore(): Promise<ViewStore> {
  const res = await fetch(`/api/prefs/${VIEWS_SCOPE}`, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`Couldn't load saved views (${res.status})`)
  const body = (await res.json()) as { data?: { views?: ViewStore } | null }
  return body.data?.views ?? {}
}

async function writeViewStore(views: ViewStore): Promise<void> {
  const res = await fetch(`/api/prefs/${VIEWS_SCOPE}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { views } }),
  })
  if (!res.ok) throw new Error(`Couldn't save the view (${res.status})`)
  const body = (await res.json().catch(() => ({}))) as { persisted?: boolean }
  if (body.persisted === false) throw new Error('Saved views need the console database, which is not configured.')
}

const viewKey = (slug: string, projectId: string) => `${slug}/${projectId}`

export function useViews(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId],
    queryFn: async () => (await readViewStore())[viewKey(WORKSPACE_SLUG, projectId!)] ?? [],
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useCreateView(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: Partial<plane.View>) => {
      const store = await readViewStore()
      const key = viewKey(WORKSPACE_SLUG, projectId!)
      const view: plane.View = {
        id: `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: body.name?.trim() || 'Untitled view',
        description: body.description,
        query_data: body.query_data ?? {},
        access: 'private',
        project: projectId!,
        workspace: WORKSPACE_SLUG,
        created_at: new Date().toISOString(),
      }
      await writeViewStore({ ...store, [key]: [...(store[key] ?? []), view] })
      return view
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId] }),
  })
}

export function useDeleteView(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const store = await readViewStore()
      const key = viewKey(WORKSPACE_SLUG, projectId!)
      await writeViewStore({ ...store, [key]: (store[key] ?? []).filter((v) => v.id !== id) })
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId] }),
  })
}

export function useCreateComment(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { comment_html: string }) =>
      planeClient.createComment(WORKSPACE_SLUG, projectId!, issueId!, body),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ['plane', 'comments', WORKSPACE_SLUG, projectId, issueId],
      })
    },
  })
}

/* ───── lookup helpers ───── */

export function memberDisplayName(m?: plane.Member): string {
  if (!m) return 'Unknown'
  return m.member?.display_name ?? m.display_name ?? m.member?.email ?? m.email ?? '—'
}

export function memberInitials(m?: plane.Member): string {
  const name = memberDisplayName(m)
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/** Plane workspace roles: 20 Admin, 15 Member, 5 Guest. */
export const ROLE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: plane.PLANE_ROLE.ADMIN, label: 'Admin' },
  { value: plane.PLANE_ROLE.MEMBER, label: 'Member' },
  { value: plane.PLANE_ROLE.GUEST, label: 'Guest' },
]

export function rolePill(role: number): { label: string; tone: 'failed' | 'progressing' | 'info' | 'unknown' } {
  switch (role) {
    case plane.PLANE_ROLE.ADMIN:
      return { label: 'Admin', tone: 'failed' }
    case plane.PLANE_ROLE.MEMBER:
      return { label: 'Member', tone: 'progressing' }
    case plane.PLANE_ROLE.GUEST:
      return { label: 'Guest', tone: 'info' }
    default:
      return { label: `role ${role}`, tone: 'unknown' }
  }
}

/* Friendly mapping from Plane priority → StatusBadge kind. */
export function priorityKind(p: plane.Priority): 'failed' | 'degraded' | 'progressing' | 'info' | 'unknown' {
  switch (p) {
    case 'urgent':
      return 'failed'
    case 'high':
      return 'degraded'
    case 'medium':
      return 'progressing'
    case 'low':
      return 'info'
    default:
      return 'unknown'
  }
}

/* Friendly mapping from state group → StatusBadge kind. */
export function stateGroupKind(g: plane.StateGroup): 'unknown' | 'info' | 'progressing' | 'healthy' | 'failed' {
  switch (g) {
    case 'backlog':
      return 'unknown'
    case 'unstarted':
      return 'info'
    case 'started':
      return 'progressing'
    case 'completed':
      return 'healthy'
    case 'cancelled':
      return 'failed'
  }
}

/* ───── errors ───── */

/**
 * A sentence a person can act on, from whatever a Plane call threw. The BFF
 * and Plane both answer in JSON — `{error}`, `{detail}`, or DRF field errors
 * (`{name: ["This field is required."]}`) — and the raw `HTTP 400 at …`
 * message names none of that.
 */
export function planeError(e: unknown, fallback = 'Plane request failed.'): string {
  const err = e as { status?: number; body?: unknown; message?: string } | undefined
  const status = err?.status
  const body = err?.body
  if (status === 429) return 'Plane is rate-limiting the console right now. Try again in a minute.'
  if (status === 401 || status === 403) {
    return 'Plane rejected the console\'s API key. An operator needs to re-run the Plane setup so the console gets a valid token.'
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (b.error === 'tool_not_configured') return 'Plane is not connected to this console (no PLANE_URL).'
    if (b.error === 'upstream_unreachable') return 'The console could not reach Plane. It may be restarting.'
    for (const key of ['error', 'detail', 'message']) {
      if (typeof b[key] === 'string' && b[key]) return b[key] as string
    }
    const fields = Object.entries(b)
      .filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'string')
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${(v as string[])[0]}`)
    if (fields.length) return fields.join(' · ')
  }
  if (status === 404) return 'Plane has no such item, or it was deleted.'
  return e instanceof Error && e.message ? e.message : fallback
}
