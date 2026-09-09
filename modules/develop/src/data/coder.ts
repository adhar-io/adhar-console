import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { coder } from '@adhar-console/api-clients'
import { toPublicUrl, useOptionalUser, usePublicBaseDomain, useToolPublicUrl } from '@adhar-console/shell-ui'

/**
 * Coder hooks for cloud development environments.
 *
 * The BFF proxies Coder with the bootstrap owner's session, so listings are
 * org-wide and `useWorkspaceOwner()` decides whose workspace a "New env"
 * becomes: the signed-in developer's Coder account (matched by e-mail) when
 * they have one — they get one on first Keycloak sign-in to Coder — else the
 * proxy identity.
 */

export const coderClient = coder.CoderClient.auto({ tool: 'coder' })

const REFRESH_MS = 10_000

export function useCoderInfo() {
  const toolUrl = useToolPublicUrl('coder')
  const baseDomain = usePublicBaseDomain()
  return useQuery({
    queryKey: ['coder', 'buildinfo'],
    queryFn: () => coderClient.buildInfo(),
    select: (info: coder.BuildInfo) => ({
      ...info,
      // Coder reports CODER_ACCESS_URL; fall back to the public tool URL when
      // that is an in-cluster host.
      dashboard_url: toPublicUrl(info.dashboard_url, { toolUrl, tool: 'coder', baseDomain }) || toolUrl,
    }),
    staleTime: 5 * 60_000,
  })
}

export function useCoderMe() {
  return useQuery({
    queryKey: ['coder', 'me'],
    queryFn: () => coderClient.me(),
    staleTime: 5 * 60_000,
  })
}

export function useOrganizations() {
  return useQuery({
    queryKey: ['coder', 'orgs'],
    queryFn: () => coderClient.listOrganizations(),
    staleTime: 5 * 60_000,
  })
}

export function useTemplates() {
  return useQuery({
    queryKey: ['coder', 'templates'],
    queryFn: () => coderClient.listTemplates(),
    staleTime: 60_000,
  })
}

export function useTemplateParameters(versionId?: string) {
  return useQuery({
    queryKey: ['coder', 'template-params', versionId],
    queryFn: () => coderClient.listTemplateParameters(versionId!),
    enabled: !!versionId,
    staleTime: 5 * 60_000,
  })
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ['coder', 'workspaces'],
    queryFn: () => coderClient.listWorkspaces(),
    refetchInterval: REFRESH_MS,
  })
}

export function useWorkspace(id?: string) {
  return useQuery({
    queryKey: ['coder', 'workspace', id],
    queryFn: () => coderClient.getWorkspace(id!),
    enabled: !!id,
    refetchInterval: REFRESH_MS,
  })
}

export function useBuilds(workspaceId?: string) {
  return useQuery({
    queryKey: ['coder', 'builds', workspaceId],
    queryFn: () => coderClient.listBuilds(workspaceId!, 20),
    enabled: !!workspaceId,
    refetchInterval: REFRESH_MS,
  })
}

/** Provisioner log lines for a build; polls while the build is in flight. */
export function useBuildLogs(buildId?: string, live = false) {
  return useQuery({
    queryKey: ['coder', 'build-logs', buildId],
    queryFn: () => coderClient.listBuildLogs(buildId!),
    enabled: !!buildId,
    refetchInterval: live ? 3_000 : false,
  })
}

/**
 * The Coder account new workspaces are created for. The signed-in console
 * user's e-mail is looked up in Coder; when they have no account yet (never
 * opened Coder), the proxy identity (`me`) owns the workspace and the UI says
 * so.
 */
export function useWorkspaceOwner() {
  const user = useOptionalUser()
  const email = user?.email?.trim().toLowerCase() ?? ''
  return useQuery({
    queryKey: ['coder', 'owner', email],
    queryFn: async (): Promise<{ owner: string; matched: boolean; email: string }> => {
      if (email) {
        try {
          const hits = await coderClient.searchUsers(email, 5)
          const exact = hits.find((u) => u.email?.toLowerCase() === email)
          if (exact) return { owner: exact.username, matched: true, email }
        } catch {
          /* fall through to the proxy identity */
        }
      }
      const me = await coderClient.me()
      return { owner: me.username, matched: false, email }
    },
    staleTime: 5 * 60_000,
  })
}

/* ─────────── mutations ─────────── */

function useInvalidating<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['coder', 'workspaces'] })
      qc.invalidateQueries({ queryKey: ['coder', 'workspace'] })
      qc.invalidateQueries({ queryKey: ['coder', 'builds'] })
    },
  })
}

export function useStartWorkspace() {
  return useInvalidating((v: { id: string; templateVersionId?: string }) => coderClient.startWorkspace(v.id, v.templateVersionId))
}
export function useStopWorkspace() {
  return useInvalidating((id: string) => coderClient.stopWorkspace(id))
}
/** Stop, then start on the template's active version (an update when outdated). */
export function useRestartWorkspace() {
  return useInvalidating(async (v: { id: string; templateVersionId?: string }) => {
    const build = await coderClient.buildWorkspace(v.id, { transition: 'stop' })
    // Wait for the stop build to settle before queueing the start (Coder
    // rejects a build while another is in progress).
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2_000))
      const w = await coderClient.getWorkspace(v.id)
      if (w.latest_build.id !== build.id || !['pending', 'stopping', 'canceling'].includes(w.latest_build.status)) break
    }
    await coderClient.startWorkspace(v.id, v.templateVersionId)
  })
}
export function useDeleteWorkspace() {
  return useInvalidating((v: { id: string; orphan?: boolean }) => coderClient.deleteWorkspace(v.id, v.orphan))
}
export function useCancelBuild() {
  return useInvalidating((buildId: string) => coderClient.cancelBuild(buildId))
}
export function useUpdateTtl() {
  return useInvalidating((v: { id: string; ttlMs: number | null }) => coderClient.updateTtl(v.id, v.ttlMs))
}
export function useUpdateAutostart() {
  return useInvalidating((v: { id: string; schedule: string | null }) => coderClient.updateAutostart(v.id, v.schedule))
}
export function useSetFavorite() {
  return useInvalidating((v: { id: string; on: boolean }) => coderClient.setFavorite(v.id, v.on))
}
export function useCreateWorkspace() {
  return useInvalidating((v: { orgId: string; owner: string; body: coder.CreateWorkspaceBody }) =>
    coderClient.createWorkspace(v.orgId, v.owner, v.body))
}
