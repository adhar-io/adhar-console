import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getTool } from './tool-registry.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'

/**
 * Component scaffolder — the real GitOps engine behind Catalog → Create.
 *
 * `POST /api/scaffold` runs as the signed-in user and performs, in order:
 *   1. create a Gitea repo (generated from a template repo, or auto-init'd),
 *   2. commit a Backstage `catalog-info.yaml` descriptor,
 *   3. (optional) commit a `deploy/` starter + create an Argo CD `Application`
 *      via the per-user Kubernetes gateway so GitOps takes over.
 *
 * Nothing is simulated: each step hits a real backend and its outcome is
 * reported back so the wizard can show true progress + links. Repos are created
 * with the platform Gitea service token; the Argo CD Application is created with
 * the USER's token (their RBAC), consistent with the console's impersonation model.
 *
 * See docs/guides/authoring-templates.md + component-registration.md.
 */

interface ScaffoldRequest {
  templateId?: string
  name?: string
  title?: string
  description?: string
  owner?: string
  system?: string
  domain?: string
  lifecycle?: string
  type?: string
  tags?: string[]
  scaffold?: {
    sourceRepo?: string
    gitops?: boolean
    manifestPath?: string
    catalogInfoPath?: string
  }
  params?: Record<string, unknown>
}

interface StepResult {
  name: string
  ok: boolean
  detail?: string
}

const NAME_RE = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/

/** UTF-8 safe base64 (Gitea contents API expects base64-encoded file bodies). */
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

export async function handleScaffold(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  let body: ScaffoldRequest
  try {
    body = (await req.json()) as ScaffoldRequest
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const name = String(body.name ?? '').trim().toLowerCase()
  if (!NAME_RE.test(name)) {
    return withCookie(
      Response.json({ error: 'invalid_name', detail: 'lowercase kebab-case, 3–63 chars' }, { status: 400 }),
      auth.refreshedCookie,
    )
  }

  const gitea = getTool('gitea')
  if (!gitea?.baseUrl) {
    return withCookie(Response.json({ error: 'gitea_not_configured' }, { status: 503 }), auth.refreshedCookie)
  }
  if (!gitea.serviceToken) {
    return withCookie(
      Response.json({ error: 'gitea_service_token_missing', detail: 'set GITEA_TOKEN' }, { status: 503 }),
      auth.refreshedCookie,
    )
  }

  const org = env('GITEA_ORG') ?? 'platform'
  const sc = body.scaffold ?? {}
  const catalogInfoPath = sc.catalogInfoPath || 'catalog-info.yaml'
  const manifestPath = sc.manifestPath || 'deploy'
  const steps: StepResult[] = []

  const gitea_api = (path: string, init?: RequestInit) =>
    fetch(`${gitea.baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `token ${gitea.serviceToken}`,
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })

  /* ── 1. create the repo ── */
  let repoRes: Response
  try {
    if (sc.sourceRepo && sc.sourceRepo.includes('/')) {
      const [tplOwner, tplRepo] = sc.sourceRepo.split('/')
      repoRes = await gitea_api(
        `/repos/${encodeURIComponent(tplOwner)}/${encodeURIComponent(tplRepo)}/generate`,
        {
          method: 'POST',
          body: JSON.stringify({
            owner: org,
            name,
            description: body.description ?? '',
            private: false,
            git_content: true,
            default_branch: 'main',
          }),
        },
      )
    } else {
      repoRes = await gitea_api(`/orgs/${encodeURIComponent(org)}/repos`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: body.description ?? '',
          private: false,
          auto_init: true,
          default_branch: 'main',
        }),
      })
    }
  } catch (e) {
    return withCookie(
      Response.json({ error: 'gitea_unreachable', detail: e instanceof Error ? e.message : '', steps }, { status: 502 }),
      auth.refreshedCookie,
    )
  }

  if (!repoRes.ok) {
    const detail = (await repoRes.text().catch(() => '')).slice(0, 300)
    steps.push({ name: 'create-repo', ok: false, detail })
    const code = repoRes.status === 409 ? 409 : 502
    return withCookie(
      Response.json({ error: 'repo_create_failed', status: repoRes.status, detail, steps }, { status: code }),
      auth.refreshedCookie,
    )
  }
  const repo = (await repoRes.json().catch(() => ({}))) as { html_url?: string; clone_url?: string }
  const repoUrl = repo.html_url ?? `${gitea.baseUrl}/${org}/${name}`
  const cloneUrl = repo.clone_url ?? `${gitea.baseUrl}/${org}/${name}.git`
  steps.push({ name: 'create-repo', ok: true, detail: repoUrl })

  const putFile = (filePath: string, content: string, message: string) =>
    gitea_api(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}/contents/${filePath}`, {
      method: 'POST',
      body: JSON.stringify({ content: toBase64(content), message, branch: 'main' }),
    })

  /* ── 2. commit catalog-info.yaml ── */
  const catalogInfo = buildCatalogInfo({ ...body, name, repoUrl, gitops: Boolean(sc.gitops) })
  try {
    const r = await putFile(catalogInfoPath, catalogInfo, `chore: add ${catalogInfoPath} (adhar scaffolder)`)
    steps.push({ name: 'catalog-info', ok: r.ok, detail: r.ok ? catalogInfoPath : (await r.text().catch(() => '')).slice(0, 200) })
  } catch (e) {
    steps.push({ name: 'catalog-info', ok: false, detail: e instanceof Error ? e.message : '' })
  }

  /* ── 3. GitOps: deploy starter + Argo CD Application (as the user) ── */
  let appName: string | undefined
  if (sc.gitops) {
    try {
      await putFile(
        `${manifestPath}/kustomization.yaml`,
        'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: []\n',
        'chore: add deploy starter (adhar scaffolder)',
      )
    } catch {
      /* non-fatal */
    }
    const id = await resolveIdentity(req)
    if (!id) {
      steps.push({ name: 'argocd-application', ok: false, detail: 'no cluster identity' })
    } else {
      const argoNs = env('ARGOCD_NAMESPACE') ?? 'argocd'
      const app = buildArgoApplication({
        name,
        repoUrl: cloneUrl,
        path: manifestPath,
        project: env('ARGOCD_PROJECT') ?? 'default',
        destNamespace: env('SCAFFOLD_DEST_NAMESPACE') ?? 'default',
      })
      try {
        const r = await apiServerFetch(
          id.token,
          `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(argoNs)}/applications`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(app) },
        )
        appName = r.ok ? name : undefined
        steps.push({
          name: 'argocd-application',
          ok: r.ok,
          detail: r.ok ? `${argoNs}/${name}` : `apiserver ${r.status}`,
        })
      } catch (e) {
        steps.push({ name: 'argocd-application', ok: false, detail: e instanceof Error ? e.message : '' })
      }
    }
  }

  return withCookie(
    Response.json({
      ok: true,
      name,
      repo: `${org}/${name}`,
      repoUrl,
      cloneUrl,
      catalogInfoPath,
      appName,
      steps,
    }),
    auth.refreshedCookie,
  )
}

/* ─────────────── descriptor builders ─────────────── */

function yamlList(items: string[]): string {
  return items.length ? `[${items.map((t) => JSON.stringify(t)).join(', ')}]` : '[]'
}

function buildCatalogInfo(
  b: ScaffoldRequest & { name: string; repoUrl: string; gitops: boolean },
): string {
  const kind = 'Component'
  const type = b.type || 'service'
  const lifecycle = b.lifecycle || 'experimental'
  const owner = b.owner || 'group:platform'
  const lines = [
    'apiVersion: backstage.io/v1alpha1',
    `kind: ${kind}`,
    'metadata:',
    `  name: ${b.name}`,
    ...(b.title ? [`  title: ${JSON.stringify(b.title)}`] : []),
    ...(b.description ? [`  description: ${JSON.stringify(b.description)}`] : []),
    '  annotations:',
    `    adhar.io/git-repo: ${b.repoUrl}`,
    ...(b.gitops ? [`    argocd/app-name: ${b.name}`] : []),
    `  tags: ${yamlList(b.tags ?? [])}`,
    'spec:',
    `  type: ${type}`,
    `  lifecycle: ${lifecycle}`,
    `  owner: ${owner}`,
    ...(b.system ? [`  system: ${b.system}`] : []),
    ...(b.domain ? [`  domain: ${b.domain}`] : []),
  ]
  return lines.join('\n') + '\n'
}

function buildArgoApplication(opts: {
  name: string
  repoUrl: string
  path: string
  project: string
  destNamespace: string
}): Record<string, unknown> {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: {
      name: opts.name,
      labels: { 'app.kubernetes.io/managed-by': 'adhar-console', 'adhar.io/scaffolded': 'true' },
    },
    spec: {
      project: opts.project,
      source: { repoURL: opts.repoUrl, path: opts.path, targetRevision: 'main' },
      destination: { server: 'https://kubernetes.default.svc', namespace: opts.destNamespace },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        syncOptions: ['CreateNamespace=true'],
      },
    },
  }
}
