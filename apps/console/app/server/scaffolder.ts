import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getTool } from './tool-registry.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'
import { generateGoldenPathFiles, isGoldenPathFamily } from './golden-paths.ts'
import type { GoldenPathFamily } from './golden-paths.ts'
import { parseYaml } from './yaml-lite.ts'
import { computeValues, renderContent, renderPath, skeletonDir } from './template-render.ts'
import { toolPublicUrl, toPublicToolUrl } from './domain.ts'

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

/** Notified as each real step finishes, so progress can be streamed live. */
type OnStep = (s: StepResult) => void

/**
 * `POST /api/scaffold`.
 *
 * Two response shapes from one implementation:
 *
 *   • **JSON** (default) — the original contract: one object with every step's
 *     outcome, returned when the whole run is over.
 *   • **SSE** (`Accept: text/event-stream`, or `?stream=1`) — the same run, with
 *     each step published the moment it actually completes.
 *
 * The stream exists because the work is genuinely sequential and genuinely
 * takes time: create the repository, render and commit a skeleton file by file,
 * create the kpack Image, create the Argo CD Application. Buffering all of that
 * into one response meant the wizard sat at zero and then jumped to done, which
 * read as "nothing happened" for the several seconds it was working hardest.
 * Nothing here is simulated — an event is emitted when a real backend call has
 * returned, so a slow step looks slow and a fast one looks fast.
 */
export async function handleScaffold(req: Request): Promise<Response> {
  const wantsStream = req.headers.get('accept')?.includes('text/event-stream') ||
    new URL(req.url).searchParams.get('stream') === '1'
  if (!wantsStream) return scaffold(req, () => {})

  // Resolve the session once, out here, so the streaming response can carry a
  // rotated cookie in its headers — they are sent before the body starts, and
  // the inner run cannot add one afterwards.
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (event: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }

      void (async () => {
        send({ type: 'start', at: Date.now() })
        try {
          const res = await scaffold(req, (s) => send({ type: 'step', step: s, at: Date.now() }), auth)
          const payload = await res.json().catch(() => ({}))
          send({ type: 'result', status: res.status, ok: res.ok, payload })
        } catch (e) {
          send({
            type: 'result',
            status: 500,
            ok: false,
            payload: { error: 'scaffold_failed', detail: e instanceof Error ? e.message : String(e) },
          })
        } finally {
          closed = true
          try {
            controller.close()
          } catch {
            // client went away first
          }
        }
      })()
    },
  })

  const res = new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would defeat the point of streaming at all.
      'x-accel-buffering': 'no',
    },
  })
  return withCookie(res, auth.refreshedCookie)
}

async function scaffold(
  req: Request,
  onStep: OnStep,
  preAuth?: Awaited<ReturnType<typeof getRequestUser>>,
): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const auth = preAuth ?? (await getRequestUser(req))
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
  /** Record a finished step and publish it immediately to any listener. */
  const step = (s: StepResult) => {
    steps.push(s)
    onStep(s)
  }

  // A GOLDEN PATH IS NOT A BACKSTAGE SKELETON, and deciding that first matters.
  //
  // `templatePath` used to default to `templates/${templateId}` for ANY
  // templateId, which made `isBackstage` true for the golden paths too (their
  // catalog ids are `golden-microservice`, `golden-frontend`, ...). Two things
  // then went wrong at once, and the response still said `ok: true`:
  //
  //   * the Backstage render 404'd — there is no `templates/golden-microservice`
  //     in the Gitea templates repo, because golden paths are GENERATED, not
  //     stored; and
  //   * `goldenPath` below is gated on `!isBackstage`, so the generator was
  //     skipped as well.
  //
  // The scaffolded repo therefore contained nothing but catalog-info.yaml, while
  // an Argo CD Application was still created pointing at a `deploy/` that did
  // not exist — leaving it stuck at sync status `Unknown`. "Scaffold to running"
  // could not work for any golden path.
  //
  // So: a declared golden-path family wins, unless the caller explicitly names a
  // Backstage source (`templatePath` / `templatesRepo`), in which case they have
  // asked for a skeleton render and get one.
  const templatesOrg = env('GITEA_TEMPLATES_ORG') || env('GITEA_ORG') || 'adhar'
  const templatesRepo = sc.templatesRepo || `${templatesOrg}/${env('GITEA_TEMPLATES_REPO') || 'adhar-templates'}`
  const { templatePath, isBackstage, goldenPath } = resolveTemplateSource({
    templateId: body.templateId,
    templatePath: sc.templatePath,
    templatesRepo,
    explicitTemplatesRepo: Boolean(sc.templatesRepo),
    goldenPath: sc.goldenPath,
  })

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
    step({ name: 'create-repo', ok: false, detail })
    const code = repoRes.status === 409 ? 409 : 502
    return withCookie(
      Response.json({ error: 'repo_create_failed', status: repoRes.status, detail, steps }, { status: code }),
      auth.refreshedCookie,
    )
  }
  const repo = (await repoRes.json().catch(() => ({}))) as { html_url?: string; clone_url?: string }
  // Gitea builds `html_url` / `clone_url` from the host of the request it
  // received, and the console reaches it over in-cluster Service DNS — so both
  // come back as `http://gitea-http.<ns>.svc.cluster.local:3000/...`, which no
  // developer can clone and no browser can open. Everything below this line is
  // consumed outside the cluster (the response, the catalog annotation, the
  // Argo CD `repoURL`, the kpack source), so it all uses the public origin.
  //
  // Verified reachable from inside the cluster with valid TLS, so the GitOps
  // and build references stay correct too.
  const publicGitea = toolPublicUrl('gitea', 'GITEA_URL')
  const repoUrl = toPublicToolUrl(repo.html_url, 'gitea', 'GITEA_URL') ??
    `${publicGitea}/${org}/${name}`
  const cloneUrl = toPublicToolUrl(repo.clone_url, 'gitea', 'GITEA_URL') ??
    `${publicGitea}/${org}/${name}.git`
  step({ name: 'create-repo', ok: true, detail: repoUrl })

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
      step({ name: 'render-skeleton', ok: true, detail: `${templatePath} — ${entries.length} files` })
    } catch (e) {
      step({ name: 'render-skeleton', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }

    if (entries.length) {
      // Build the render context from the template's fetch:template value map.
      const params: Record<string, unknown> = { ...(body.params ?? {}) }
      if (params.name == null) params.name = name
      if (params.description == null) params.description = body.description ?? ''
      if (params.owner == null && body.owner) params.owner = body.owner
      // The console creates the repo itself, so synthesise the RepoUrlPicker value.
      if (params.repoUrl == null) params.repoUrl = `${publicGitea}?owner=${org}&repo=${name}`
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
      step({
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
    step({ name: 'catalog-info', ok: true, detail: `${catalogInfoPath} (from template skeleton)` })
  } else {
    const catalogInfo = buildCatalogInfo({ ...body, name, repoUrl, gitops: Boolean(sc.gitops) })
    try {
      const r = await putFile(catalogInfoPath, toBase64(catalogInfo), `chore: add ${catalogInfoPath} (adhar scaffolder)`)
      step({ name: 'catalog-info', ok: r.ok, detail: r.ok ? catalogInfoPath : (await r.text().catch(() => '')).slice(0, 200) })
      if (r.ok) committedPaths.add(catalogInfoPath)
    } catch (e) {
      step({ name: 'catalog-info', ok: false, detail: e instanceof Error ? e.message : '' })
    }
  }

  /* ── 2c. golden path: commit the full generated starter set ── */
  // Only for non-Backstage templates; a Backstage skeleton already populated the
  // repo (Dockerfile-less buildpacks + deploy/ + observability).
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
        step({
          name: `commit:${file.path}`,
          ok: r.ok,
          detail: r.ok ? undefined : `gitea ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`,
        })
        if (r.ok) committedPaths.add(file.path)
      } catch (e) {
        step({ name: `commit:${file.path}`, ok: false, detail: e instanceof Error ? e.message : '' })
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
      step({ name: 'build-image', ok: false, detail: 'no cluster identity to create the kpack Image' })
    } else {
      const buildNs = env('KPACK_NAMESPACE') ?? 'adhar-system'
      const subPath = typeof body.params?.subpath === 'string' ? (body.params.subpath as string) : undefined
      const image = buildKpackImage({ name, cloneUrl, subPath })
      try {
        const r = await apiServerFetch(
          id,
          `/apis/kpack.io/v1alpha2/namespaces/${encodeURIComponent(buildNs)}/images`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(image) },
        )
        step({
          name: 'build-image',
          ok: r.ok,
          detail: r.ok
            ? `kpack Image ${buildNs}/${name} — buildpacks build → Harbor (rebuilds on push)`
            : `apiserver ${r.status}: ${(await r.text().catch(() => '')).slice(0, 140)}`,
        })
      } catch (e) {
        step({ name: 'build-image', ok: false, detail: e instanceof Error ? e.message : '' })
      }
    }
  }

  /* ── 3. GitOps: deploy starter + Argo CD Application (as the user) ── */
  let appName: string | undefined
  if (sc.gitops) {
    // Seed an empty Kustomization stub only when nothing actually filled deploy/.
    //
    // This used to read `isBackstage || goldenPath || <committed>` — i.e. it
    // trusted INTENT. When a skeleton render or golden-path commit failed, the
    // first two were still true, so no stub was written either, and the Argo CD
    // Application below was created pointing at a path that did not exist. It
    // then sat at sync status `Unknown` forever with no error anywhere.
    // Ask what was committed instead; a valid-but-empty Kustomization is a far
    // better failure mode than a dangling source.
    const haveDeploy = [...committedPaths].some((p) => p.startsWith(`${manifestPath}/`))
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
      step({ name: 'gitops-app', ok: false, detail: 'no cluster identity' })
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
          id,
          `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(argoNs)}/applications`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(app) },
        )
        appName = r.ok ? name : undefined
        step({
          name: 'gitops-app',
          ok: r.ok,
          detail: r.ok ? `${argoNs}/${name}` : `apiserver ${r.status}: ${(await r.text().catch(() => '')).slice(0, 140)}`,
        })
      } catch (e) {
        step({ name: 'gitops-app', ok: false, detail: e instanceof Error ? e.message : '' })
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

/* ─────────────── template source resolution ─────────────── */

/**
 * Decide whether a scaffold renders a stored Backstage skeleton or GENERATES a
 * golden-path starter — exactly one of the two, never neither.
 *
 * Pure and exported because getting it wrong is silent: the previous inline
 * version defaulted `templatePath` to `templates/${templateId}` for ANY
 * templateId, so a golden path (catalog ids `golden-microservice`, ...) was
 * treated as a Backstage skeleton. The render then 404'd (golden paths are
 * generated, not stored) AND the generator was skipped, because it was gated on
 * `!isBackstage`. The scaffolded repo got nothing but catalog-info.yaml while an
 * Argo CD Application was still created against a `deploy/` that did not exist,
 * and the response reported success.
 *
 * Precedence: an explicitly named Backstage source wins (the caller asked for a
 * skeleton); otherwise a valid golden-path family wins; otherwise a templateId
 * means a stored skeleton.
 */
export function resolveTemplateSource(o: {
  templateId?: string
  templatePath?: string
  templatesRepo: string
  explicitTemplatesRepo?: boolean
  goldenPath?: unknown
}): { templatePath?: string; isBackstage: boolean; goldenPath?: GoldenPathFamily } {
  const family = isGoldenPathFamily(o.goldenPath) ? o.goldenPath : undefined
  const explicitBackstage = Boolean(o.templatePath || o.explicitTemplatesRepo)
  const generating = Boolean(family) && !explicitBackstage
  const templatePath = o.templatePath ??
    (o.templateId && !generating ? `templates/${o.templateId}` : undefined)
  const isBackstage = Boolean(templatePath && o.templatesRepo.includes('/'))
  return { templatePath, isBackstage, goldenPath: isBackstage ? undefined : family }
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
