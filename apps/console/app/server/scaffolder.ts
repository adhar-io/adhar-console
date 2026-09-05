import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getTool } from './tool-registry.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'
import { generateGoldenPathFiles, isGoldenPathFamily } from './golden-paths.ts'
import type { GoldenPathFamily } from './golden-paths.ts'
import { parseYaml } from './yaml-lite.ts'
import { computeValues, renderContent, renderPath, skeletonDir } from './template-render.ts'

/**
 * Component scaffolder — the real GitOps engine behind Catalog → Create.
 *
 * `POST /api/scaffold` runs as the signed-in user and performs, in order:
 *   1. create an empty Gitea repo in the org,
 *   2. render the chosen Backstage template's `skeleton/` tree with the user's
 *      parameter values (`${{ values.x }}` + `{% if %}` nunjucks-lite) and
 *      commit every rendered file (the skeleton ships its own catalog-info.yaml
 *      + deploy/); golden-path / plain templates fall back to the generated
 *      starter set,
 *   3. create the kpack `Image` (Cloud Native Buildpacks build → Harbor), and
 *   4. create the Argo CD `Application` so GitOps takes over.
 *
 * Nothing is simulated: each step hits a real backend and its outcome is
 * reported back so the wizard can show true progress + links. Gitea calls use
 * the fixed durable auth (Basic `GITEA_USERNAME`/`GITEA_PASSWORD`, else a PAT —
 * see gitea-auth.ts); the kpack Image + Argo CD Application are created with the
 * USER's cluster token (their RBAC), consistent with the impersonation model.
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
    /** Backstage templates repo, "owner/repo" (default adhar/adhar-templates). */
    templatesRepo?: string
    /** Path of the chosen template within that repo, e.g. templates/nodejs-web-service. */
    templatePath?: string
    /** Legacy Gitea template-repo generate source (kept for back-compat). */
    sourceRepo?: string
    gitops?: boolean
    manifestPath?: string
    catalogInfoPath?: string
    /** Golden-path family — commit a full generated starter set. */
    goldenPath?: GoldenPathFamily | string
  }
  params?: Record<string, unknown>
}

interface StepResult {
  name: string
  ok: boolean
  detail?: string
}

interface TreeEntry {
  path?: string
  type?: string
}

const NAME_RE = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'svg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tar', 'jar', 'class', 'wasm', 'mp4', 'mp3',
])

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i >= 0 ? path.slice(i + 1).toLowerCase() : ''
}

/** UTF-8 safe base64 (Gitea contents API expects base64-encoded file bodies). */
function toBase64(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s))
}

function bytesToBase64(bytes: Uint8Array): string {
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
  const conn = giteaConn()
  if (!conn) {
    return withCookie(
      Response.json(
        { error: 'gitea_auth_missing', detail: 'set GITEA_USERNAME/GITEA_PASSWORD or GITEA_TOKEN' },
        { status: 503 },
      ),
      auth.refreshedCookie,
    )
  }
  const gitea_api = giteaFetcher(conn)

  const org = env('GITEA_ORG') ?? 'adhar'
  const sc = body.scaffold ?? {}
  const catalogInfoPath = sc.catalogInfoPath || 'catalog-info.yaml'
  const manifestPath = sc.manifestPath || 'deploy'
  const steps: StepResult[] = []

  // Resolve the Backstage template source (repo + path) for skeleton rendering.
  const templatesOrg = env('GITEA_TEMPLATES_ORG') || env('GITEA_ORG') || 'adhar'
  const templatesRepo = sc.templatesRepo || `${templatesOrg}/${env('GITEA_TEMPLATES_REPO') || 'adhar-templates'}`
  const templatePath = sc.templatePath || (body.templateId ? `templates/${body.templateId}` : undefined)
  const isBackstage = Boolean(templatePath && templatesRepo.includes('/'))

  /* ── 1. create the (empty) repo ── */
  let repoRes: Response
  try {
    repoRes = await gitea_api(`/orgs/${encodeURIComponent(org)}/repos`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: body.description ?? '',
        private: false,
        auto_init: false,
        default_branch: 'main',
      }),
    })
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

  const putFile = (filePath: string, base64Content: string, message: string) =>
    gitea_api(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}/contents/${filePath}`, {
      method: 'POST',
      body: JSON.stringify({ content: base64Content, message, branch: 'main' }),
    })

  // Track what the skeleton already wrote so later steps don't double-commit.
  const committedPaths = new Set<string>()

  /* ── 2. render + commit the template skeleton ── */
  if (isBackstage) {
    const [tplOwner, tplRepo] = templatesRepo.split('/')
    const rawBase = `/repos/${encodeURIComponent(tplOwner)}/${encodeURIComponent(tplRepo)}/raw`
    let doc: ReturnType<typeof parseYaml> = null
    let entries: TreeEntry[] = []
    let skelPrefix = ''
    try {
      const tplRes = await gitea_api(`${rawBase}/${templatePath}/template.yaml`)
      if (!tplRes.ok) throw new Error(`template.yaml ${tplRes.status}`)
      doc = parseYaml(await tplRes.text())
      const dir = skeletonDir(doc)
      skelPrefix = `${templatePath}/${dir}/`
      const treeRes = await gitea_api(
        `/repos/${encodeURIComponent(tplOwner)}/${encodeURIComponent(tplRepo)}/git/trees/main?recursive=true`,
      )
      if (!treeRes.ok) throw new Error(`git tree ${treeRes.status}`)
      const tree = (await treeRes.json().catch(() => ({}))) as { tree?: TreeEntry[] }
      entries = (tree.tree ?? []).filter((e) => e.type === 'blob' && e.path && e.path.startsWith(skelPrefix))
      steps.push({ name: 'render-skeleton', ok: true, detail: `${templatePath} — ${entries.length} files` })
    } catch (e) {
      steps.push({ name: 'render-skeleton', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }

    if (entries.length) {
      // Build the render context from the template's fetch:template value map.
      const params: Record<string, unknown> = { ...(body.params ?? {}) }
      if (params.name == null) params.name = name
      if (params.description == null) params.description = body.description ?? ''
      if (params.owner == null && body.owner) params.owner = body.owner
      // The console creates the repo itself, so synthesise the RepoUrlPicker value.
      if (params.repoUrl == null) params.repoUrl = `${gitea.baseUrl}?owner=${org}&repo=${name}`
      const values = computeValues(doc, params)
      // Pin repo identity to the repo we actually created (not the picker guess).
      values.gitOwner = org
      values.repoName = name

      let committed = 0
      let failed = 0
      let firstError: string | undefined
      for (const entry of entries) {
        const rel = entry.path!.slice(skelPrefix.length)
        const outPath = renderPath(rel, values)
        try {
          const fileRes = await gitea_api(`${rawBase}/${entry.path}`)
          if (!fileRes.ok) throw new Error(`fetch ${fileRes.status}`)
          const buf = new Uint8Array(await fileRes.arrayBuffer())
          const isBinary = BINARY_EXT.has(extOf(rel))
          const content = isBinary
            ? bytesToBase64(buf)
            : toBase64(renderContent(new TextDecoder().decode(buf), values))
          const put = await putFile(outPath, content, `feat: scaffold ${templatePath} skeleton (adhar)`)
          if (put.ok) {
            committed++
            committedPaths.add(outPath)
          } else {
            failed++
            if (!firstError) firstError = `${outPath}: gitea ${put.status} ${(await put.text().catch(() => '')).slice(0, 120)}`
          }
        } catch (e) {
          failed++
          if (!firstError) firstError = `${outPath}: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      steps.push({
        name: 'commit-files',
        ok: failed === 0,
        detail: failed === 0
          ? `${committed} files committed to main`
          : `${committed} committed, ${failed} failed — ${firstError ?? ''}`,
      })
    }
  }

  /* ── 2b. catalog-info.yaml ── */
  // The Backstage skeleton ships its own; only commit a generated descriptor
  // when the template didn't provide one.
  if (committedPaths.has(catalogInfoPath)) {
    steps.push({ name: 'catalog-info', ok: true, detail: `${catalogInfoPath} (from template skeleton)` })
  } else {
    const catalogInfo = buildCatalogInfo({ ...body, name, repoUrl, gitops: Boolean(sc.gitops) })
    try {
      const r = await putFile(catalogInfoPath, toBase64(catalogInfo), `chore: add ${catalogInfoPath} (adhar scaffolder)`)
      steps.push({ name: 'catalog-info', ok: r.ok, detail: r.ok ? catalogInfoPath : (await r.text().catch(() => '')).slice(0, 200) })
      if (r.ok) committedPaths.add(catalogInfoPath)
    } catch (e) {
      steps.push({ name: 'catalog-info', ok: false, detail: e instanceof Error ? e.message : '' })
    }
  }

  /* ── 2c. golden path: commit the full generated starter set ── */
  // Only for non-Backstage templates; a Backstage skeleton already populated the
  // repo (Dockerfile-less buildpacks + deploy/ + observability).
  const goldenPath = !isBackstage && isGoldenPathFamily(sc.goldenPath) ? sc.goldenPath : undefined
  if (goldenPath) {
    const p = body.params ?? {}
    const files = generateGoldenPathFiles(goldenPath, {
      name,
      description: body.description,
      owner: body.owner,
      port: Number(p.port) || undefined,
      language: typeof p.language === 'string' ? p.language : undefined,
    })
    for (const file of files) {
      if (committedPaths.has(file.path) || file.path === catalogInfoPath || file.path === 'catalog-info.yaml') continue
      try {
        const r = await putFile(file.path, toBase64(file.content), `feat: add ${goldenPath} golden-path starter (adhar scaffolder)`)
        steps.push({
          name: `commit:${file.path}`,
          ok: r.ok,
          detail: r.ok ? undefined : `gitea ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`,
        })
        if (r.ok) committedPaths.add(file.path)
      } catch (e) {
        steps.push({ name: `commit:${file.path}`, ok: false, detail: e instanceof Error ? e.message : '' })
      }
    }
  }

  /* ── 2d. Build: kpack Image (Cloud Native Buildpacks → Harbor) ── */
  // Adhar builds with kpack/buildpacks — no Dockerfile. Create a kpack Image
  // that builds the repo with the `adhar-builder` ClusterBuilder, pushes the OCI
  // image to Harbor, and auto-rebuilds on every commit. This is the CI build;
  // nothing is simulated.
  {
    const id = await resolveIdentity(req)
    if (!id) {
      steps.push({ name: 'build-image', ok: false, detail: 'no cluster identity to create the kpack Image' })
    } else {
      const buildNs = env('KPACK_NAMESPACE') ?? 'adhar-system'
      const subPath = typeof body.params?.subpath === 'string' ? (body.params.subpath as string) : undefined
      const image = buildKpackImage({ name, cloneUrl, subPath })
      try {
        const r = await apiServerFetch(
          id.token,
          `/apis/kpack.io/v1alpha2/namespaces/${encodeURIComponent(buildNs)}/images`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(image) },
        )
        steps.push({
          name: 'build-image',
          ok: r.ok,
          detail: r.ok
            ? `kpack Image ${buildNs}/${name} — buildpacks build → Harbor (rebuilds on push)`
            : `apiserver ${r.status}: ${(await r.text().catch(() => '')).slice(0, 140)}`,
        })
      } catch (e) {
        steps.push({ name: 'build-image', ok: false, detail: e instanceof Error ? e.message : '' })
      }
    }
  }

  /* ── 3. GitOps: deploy starter + Argo CD Application (as the user) ── */
  let appName: string | undefined
  if (sc.gitops) {
    // Backstage skeletons and golden paths ship their own populated deploy/;
    // only seed the empty Kustomization stub when nothing else filled it in.
    const haveDeploy = isBackstage || goldenPath ||
      [...committedPaths].some((p) => p.startsWith(`${manifestPath}/`))
    if (!haveDeploy) {
      try {
        await putFile(
          `${manifestPath}/kustomization.yaml`,
          toBase64('apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: []\n'),
          'chore: add deploy starter (adhar scaffolder)',
        )
      } catch {
        /* non-fatal */
      }
    }
    const id = await resolveIdentity(req)
    if (!id) {
      steps.push({ name: 'gitops-app', ok: false, detail: 'no cluster identity' })
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
          name: 'gitops-app',
          ok: r.ok,
          detail: r.ok ? `${argoNs}/${name}` : `apiserver ${r.status}: ${(await r.text().catch(() => '')).slice(0, 140)}`,
        })
      } catch (e) {
        steps.push({ name: 'gitops-app', ok: false, detail: e instanceof Error ? e.message : '' })
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

/**
 * kpack `Image` — builds the repo with Cloud Native Buildpacks (no Dockerfile)
 * via the platform's `adhar-builder` ClusterBuilder, pushing the OCI image to
 * Harbor. kpack polls the git source and rebuilds on every commit. Mirrors the
 * platform supply-chain convention (see supply-chain/50-service-template.yaml).
 */
function buildKpackImage(o: { name: string; cloneUrl: string; subPath?: string }) {
  const registry = env('KPACK_REGISTRY') ?? 'harbor-core.adhar-system.svc.cluster.local/library'
  return {
    apiVersion: 'kpack.io/v1alpha2',
    kind: 'Image',
    metadata: {
      name: o.name,
      namespace: env('KPACK_NAMESPACE') ?? 'adhar-system',
      labels: { 'adhar.io/supply-chain': 'true', 'adhar.io/scaffolded': 'true' },
    },
    spec: {
      tag: `${registry.replace(/\/$/, '')}/${o.name}`,
      serviceAccountName: env('KPACK_SERVICE_ACCOUNT') ?? 'adhar-pipeline',
      builder: { name: env('KPACK_BUILDER') ?? 'adhar-builder', kind: 'ClusterBuilder' },
      cache: { volume: { size: '1Gi' } },
      source: {
        git: { url: o.cloneUrl, revision: 'main' },
        ...(o.subPath ? { subPath: o.subPath } : {}),
      },
      // Build-time toolchain pins (Paketo). These only apply to the languages
      // that consume them — Java gets JDK 25 + Maven 3.9.x; every other language
      // ignores them and uses the buildpack's latest default. Overridable via env.
      build: {
        env: [
          { name: 'BP_JVM_VERSION', value: env('BP_JVM_VERSION') ?? '25' },
          { name: 'BP_MAVEN_VERSION', value: env('BP_MAVEN_VERSION') ?? '3.9.9' },
        ],
      },
    },
  }
}

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
