import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { coder } from '@adhar-console/api-clients'
import { toPublicUrl, useLiveToolPoll, usePublicBaseDomain, useToolPublicUrl } from '@adhar-console/shell-ui'

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

/**
 * Coder has no watch endpoint, so "live" here means the BFF does the polling
 * and pushes only on an actual change — one upstream poll shared by every open
 * tab instead of one per tab, and no browser timer while the socket is up.
 */
export function useWorkspaces() {
  const queryKey = ['coder', 'workspaces']
  return useQuery({
    queryKey,
    queryFn: () => coderClient.listWorkspaces(),
    refetchInterval: useLiveToolPoll('coder', '/api/v2/workspaces?limit=200', REFRESH_MS, [queryKey]),
  })
}

export function useWorkspace(id?: string) {
  const queryKey = ['coder', 'workspace', id]
  return useQuery({
    queryKey,
    queryFn: () => coderClient.getWorkspace(id!),
    enabled: !!id,
    refetchInterval: useLiveToolPoll(
      'coder',
      `/api/v2/workspaces/${id ?? ''}`,
      REFRESH_MS,
      [queryKey],
      { enabled: !!id },
    ),
  })
}

export function useBuilds(workspaceId?: string) {
  const queryKey = ['coder', 'builds', workspaceId]
  return useQuery({
    queryKey,
    queryFn: () => coderClient.listBuilds(workspaceId!, 20),
    enabled: !!workspaceId,
    refetchInterval: useLiveToolPoll(
      'coder',
      `/api/v2/workspaces/${workspaceId ?? ''}/builds?limit=20`,
      REFRESH_MS,
      [queryKey],
      { enabled: !!workspaceId },
    ),
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
 * The Coder account new workspaces are created for.
 *
 * The signed-in console user's e-mail is looked up in Coder. When they have no
 * account yet, one is CREATED for them with `login_type: oidc`: Coder links
 * their first Keycloak sign-in to it by e-mail, so an environment made here
 * before they ever open Coder is already theirs when they do. Falling back to
 * the proxy identity instead (the old behaviour) put every workspace under the
 * bootstrap owner, whose `code-server` app is owner-only — every "Open IDE"
 * then ended at Coder's OIDC callback with **Access denied**, because the
 * person signing in was never the owner.
 */
export interface CoderOwner {
  owner: string
  /** True when `owner` is the signed-in person's own Coder account. */
  matched: boolean
  created: boolean
  /** Why it is not their own account — shown to the person, not swallowed. */
  reason?: string
}

/**
 * The Coder account this browser drives, decided by the BFF.
 *
 * It used to be worked out here, which could not work: matching a person to a
 * Coder account, creating one for them, and falling back to the console's own
 * identity when there is no identity provider are all decisions that need the
 * server's credential and its auth configuration. The browser only needs the
 * answer.
 */
export function useWorkspaceOwner() {
  return useQuery({
    queryKey: ['coder', 'identity'],
    queryFn: async (): Promise<CoderOwner> => {
      const res = await fetch('/api/coder/identity', { credentials: 'include', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`Coder identity failed (${res.status})`)
      return (await res.json()) as CoderOwner
    },
    staleTime: 5 * 60_000,
  })
}

export interface IdeSession {
  /** Open this: a browser URL carrying a one-shot session, or a desktop deep link. */
  url: string
  owner: string
  /** True for a desktop app (JetBrains Gateway, VS Code Desktop). */
  external: boolean
  matched: boolean
}

/**
 * An IDE URL the browser can actually open.
 *
 * Coder serves the IDE from its own domain, where this tab has no session, so
 * a plain app link always landed on Coder's sign-in page. The BFF mints a
 * short-lived token for the workspace's owner and returns a URL carrying it;
 * Coder swaps it for a cookie on first load.
 */
export async function ideSessionUrl(input: { workspace: string; agent: string; app: string }): Promise<IdeSession> {
  const res = await fetch('/api/coder/ide-session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as Partial<IdeSession> & { error?: string; detail?: string }
  if (!res.ok || !body.url) {
    throw new Error(body.detail || body.error || `Could not open the IDE (${res.status}).`)
  }
  return { url: body.url, owner: body.owner ?? '', external: Boolean(body.external), matched: Boolean(body.matched) }
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

/* ─────────── one workspace per repository ─────────── */

export const workspaceNameFor = coder.workspaceNameFor

const REPO_PARAM = 'git_repo'


/**
 * The signed-in user's workspace for a repository — found by the naming
 * convention, or CREATED from the platform template with `git_repo` set so
 * the template clones the repository and both IDEs open its folder.
 *
 * Creation happens here, for the person, not in the proxy identity: the
 * workspace is theirs, so Coder's owner-only IDE apps open for them.
 */
export function useRepoWorkspace(repo: string) {
  const owner = useWorkspaceOwner()
  const workspaces = useWorkspaces()
  const name = workspaceNameFor(repo)
  // Whatever account the BFF resolved: their own where an identity provider
  // says who they are, the console's own on a laptop without one. Either way
  // the IDE session is minted for THIS owner, so its apps open for them.
  const mine = owner.data?.owner || undefined
  const existing = mine ? (workspaces.data ?? []).find((w) => w.name === name && w.owner_name === mine) : undefined
  return {
    owner: mine,
    name,
    workspace: existing,
    isLoading: owner.isLoading || workspaces.isLoading,
    /** Set when there is no usable Coder account — the control explains itself. */
    blocked: owner.isLoading || mine ? undefined : (owner.data?.reason ?? 'Your Coder account could not be resolved.'),
    /** Present when the account is not the person's own — worth saying once. */
    note: owner.data && !owner.data.matched ? owner.data.reason : undefined,
  }
}

export interface EnsureRepoWorkspaceInput {
  repo: string
  cloneUrl: string
  owner: string
}

/**
 * Create the repository workspace for its owner and wait for it to start.
 * Resolves with the workspace once its agent has connected (or after a bounded
 * wait, with whatever state it reached — the caller opens the environments
 * page in that case rather than a dead tab).
 */
export async function ensureRepoWorkspace(input: EnsureRepoWorkspaceInput): Promise<coder.Workspace> {
  const name = workspaceNameFor(input.repo)
  const templates = await coderClient.listTemplates()
  const tpl = templates.find((t) => t.name === 'kubernetes') ?? templates[0]
  if (!tpl?.active_version_id) throw new Error('No Coder template is available to create an environment from.')
  const params = await coderClient.listTemplateParameters(tpl.active_version_id)
  if (!params.some((p) => p.name === REPO_PARAM)) {
    throw new Error('The platform template has no `git_repo` parameter yet — the coder package must be at adhar-ide-v3 or later.')
  }
  const rich = params
    .filter((p) => p.name !== REPO_PARAM && (p.default_value ?? '') !== '')
    .map((p) => ({ name: p.name, value: p.default_value! }))
  rich.push({ name: REPO_PARAM, value: input.cloneUrl })
  const orgId = tpl.organization_id ?? (await coderClient.listOrganizations())[0]?.id
  if (!orgId) throw new Error('Coder reported no organization to create the workspace in.')
  let w = await coderClient.createWorkspace(orgId, input.owner, {
    name,
    template_version_id: tpl.active_version_id,
    rich_parameter_values: rich,
    automatic_updates: 'always',
  })
  // A build takes a minute or two on this platform (image pull + PVC).
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2_000))
    w = await coderClient.getWorkspace(w.id)
    const st = w.latest_build.status
    if (st === 'running' || st === 'failed' || st === 'canceled') break
  }
  return w
}

/** The workspace's code-server app and its agent, if connected. */
export function editorOf(w: coder.Workspace, kind: 'vscode' | 'intellij'): { agent: string; app: coder.WorkspaceApp } | null {
  const re = kind === 'vscode' ? /^code-server$|vscode-web|^code$/i : /jetbrains|intellij/i
  for (const r of w.latest_build.resources ?? []) {
    for (const a of r.agents ?? []) {
      const app = a.apps?.find((x) => re.test(x.slug))
      if (app) return { agent: a.name, app }
    }
  }
  return null
}
