import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { plane } from '@adhar-console/api-clients'

/**
 * Plane.so client + per-resource hooks for the Define module.
 *
 * The hook layer hides Plane's `(workspaceSlug, projectId)` ergonomics: every
 * hook reads the active project from `useActiveProject()` and skips the query
 * when nothing's selected. Pass an explicit `projectId` to override.
 *
 * In dev we use `.stub()` so the views render rich data without a Plane
 * backend; production swaps for `.create({ baseUrl, token })` once Keycloak
 * mints a token.
 */

export const planeClient = plane.PlaneClient.auto({ tool: 'plane' })

export const WORKSPACE_SLUG = 'acme'

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
  return useQuery({
    queryKey: ['plane', 'projects', WORKSPACE_SLUG],
    queryFn: () => planeClient.listProjects(WORKSPACE_SLUG),
    staleTime: REFRESH_MS,
  })
}

export function useProject(id?: string) {
  return useQuery({
    queryKey: ['plane', 'project', WORKSPACE_SLUG, id],
    queryFn: () => planeClient.getProject(WORKSPACE_SLUG, id!),
    enabled: !!id,
    staleTime: REFRESH_MS,
  })
}

export function useStates(projectId?: string) {
  return useQuery({
    queryKey: ['plane', 'states', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listStates(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useLabels(projectId?: string) {
  return useQuery({
    queryKey: ['plane', 'labels', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listLabels(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useIssues(projectId?: string, params?: plane.IssueListParams) {
  return useQuery({
    queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId, params],
    queryFn: () => planeClient.listIssues(WORKSPACE_SLUG, projectId!, params),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useCycles(projectId?: string) {
  return useQuery({
    queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listCycles(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useModules(projectId?: string) {
  return useQuery({
    queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listModules(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function usePages(projectId?: string) {
  return useQuery({
    queryKey: ['plane', 'pages', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listPages(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useViews(projectId?: string) {
  return useQuery({
    queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listViews(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useMembers() {
  return useQuery({
    queryKey: ['plane', 'members', WORKSPACE_SLUG],
    queryFn: () => planeClient.listMembers(WORKSPACE_SLUG),
    staleTime: REFRESH_MS,
  })
}

export function useIssue(projectId?: string, issueId?: string) {
  return useQuery({
    queryKey: ['plane', 'issue', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.getIssue(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useComments(projectId?: string, issueId?: string) {
  return useQuery({
    queryKey: ['plane', 'comments', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listComments(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useActivities(projectId?: string, issueId?: string) {
  return useQuery({
    queryKey: ['plane', 'activities', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listActivities(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useSubIssues(projectId?: string, issueId?: string) {
  return useQuery({
    queryKey: ['plane', 'sub-issues', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listSubIssues(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

/* ───── mutations ───── */

export function useUpdateIssue(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<plane.Issue> }) =>
      planeClient.updateIssue(WORKSPACE_SLUG, projectId!, id, patch),
    onSuccess: (issue) => {
      qc.invalidateQueries({ queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'issue', WORKSPACE_SLUG, projectId, issue.id] })
      qc.invalidateQueries({ queryKey: ['plane', 'activities', WORKSPACE_SLUG, projectId, issue.id] })
    },
  })
}

export function useCreateIssue(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Issue>) =>
      planeClient.createIssue(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId] })
    },
  })
}

export function useDeleteIssue(projectId?: string) {
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
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Project>) => planeClient.createProject(WORKSPACE_SLUG, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

export function useUpdateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<plane.Project> }) =>
      planeClient.updateProject(WORKSPACE_SLUG, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteProject(WORKSPACE_SLUG, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

export function useInviteMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { email: string; role: number }) =>
      planeClient.inviteMember(WORKSPACE_SLUG, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'members', WORKSPACE_SLUG] }),
  })
}

export function useUpdateMemberRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: number }) =>
      planeClient.updateMemberRole(WORKSPACE_SLUG, id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'members', WORKSPACE_SLUG] }),
  })
}

export function useRemoveMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.removeMember(WORKSPACE_SLUG, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'members', WORKSPACE_SLUG] }),
  })
}

/* ───── cycle / module / view mutations ───── */

export function useCreateCycle(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Cycle>) =>
      planeClient.createCycle(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] }),
  })
}
export function useDeleteCycle(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteCycle(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] }),
  })
}

export function useCreateModule(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Module>) =>
      planeClient.createModule(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] }),
  })
}
export function useDeleteModule(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteModule(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] }),
  })
}

export function useCreateView(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.View>) =>
      planeClient.createView(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId] }),
  })
}
export function useDeleteView(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteView(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId] }),
  })
}

export function useUpdatePage(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<plane.Page> }) =>
      planeClient.updatePage(WORKSPACE_SLUG, projectId!, id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plane', 'pages', WORKSPACE_SLUG, projectId] })
    },
  })
}

export function useCreatePage(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Page>) =>
      planeClient.createPage(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plane', 'pages', WORKSPACE_SLUG, projectId] })
    },
  })
}

export function useDeletePage(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deletePage(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plane', 'pages', WORKSPACE_SLUG, projectId] })
    },
  })
}

export function useCreateComment(projectId?: string, issueId?: string) {
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

export function rolePill(role: number): { label: string; tone: 'failed' | 'progressing' | 'info' | 'unknown' } {
  switch (role) {
    case 5:
      return { label: 'Admin', tone: 'failed' }
    case 15:
      return { label: 'Member', tone: 'progressing' }
    case 20:
      return { label: 'Guest', tone: 'info' }
    case 25:
      return { label: 'Viewer', tone: 'unknown' }
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
