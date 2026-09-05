import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getTool } from './tool-registry.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import { parseYaml } from './yaml-lite.ts'
import type { YamlValue } from './yaml-lite.ts'

/**
 * Software-template discovery — the real source behind Catalog → Create New.
 *
 * `GET /api/templates` lists the platform's **Backstage Software Templates**
 * hosted in Gitea, so platform teams curate the golden paths in git rather than
 * in the console bundle. The model is Backstage's, NOT Gitea "template repos":
 *
 *   - `adhar/adhar-templates/catalog-info.yaml` is a Backstage `kind: Location`
 *     whose `spec.targets` point at `./templates/<name>/template.yaml`.
 *   - Each `template.yaml` is a `kind: Template` with `metadata` (name/title/
 *     description/tags), `spec.parameters` (the wizard's parameter schema) and
 *     `spec.steps` (a `fetch:template` that renders a `skeleton/` tree).
 *
 * Discovery fetches the Location, reads its targets, then fetches + parses each
 * `template.yaml`. The org/repo are configurable via `GITEA_TEMPLATES_ORG` /
 * `GITEA_ORG` (default org `adhar`) and `GITEA_TEMPLATES_REPO` (default
 * `adhar-templates`); the real defaults work out of the box.
 *
 * Each template maps to a Create-New card. The Backstage `spec.parameters` are
 * translated into the wizard's `steps`/`fields` model so the Create wizard
 * renders the real form, and the parameter schema is carried through verbatim
 * on `parameters` for callers that want it. The card's `scaffold` block records
 * where the skeleton lives so `/api/scaffold` can render + commit it.
 *
 * When Gitea isn't configured the endpoint returns `configured: false` with an
 * empty list; when it's configured but unreachable it returns
 * `error: 'gitea_unreachable'`. The client then falls back to seed templates.
 */

const TONES = ['brand', 'emerald', 'sky', 'amber', 'violet', 'rose', 'slate'] as const

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function humanize(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step'
}

function glyphOf(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, '')
  return (letters.slice(0, 2) || 'GT').toUpperCase()
}

function toneOf(key: string): (typeof TONES)[number] {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return TONES[h % TONES.length]
}

/** Infer a template family from its name + tags (all are `spec.type: service`). */
function inferFamily(name: string, tags: string[]): string {
  const hay = `${name} ${tags.join(' ')}`.toLowerCase()
  if (/\b(web|frontend|spa|site|ui|react|vue|angular|next|tanstack)\b/.test(hay)) return 'website'
  if (/\b(lib|library|sdk|package)\b/.test(hay)) return 'library'
  if (/\b(api|openapi|graphql|grpc|proto|contract)\b/.test(hay)) return 'api'
  if (/\b(mobile|ios|android|expo|flutter)\b/.test(hay)) return 'mobile'
  if (/\b(data|ml|pipeline|etl|spark|notebook|model)\b/.test(hay)) return 'data'
  if (/\b(infra|terraform|helm|chart|iac|module)\b/.test(hay)) return 'infra'
  if (/\b(docs|documentation)\b/.test(hay)) return 'docs'
  return 'service'
}

/** Infer the display language from name + tags. */
function inferLanguage(name: string, tags: string[]): string {
  const hay = `${name} ${tags.join(' ')}`.toLowerCase()
  if (/\b(nodejs|node|express|javascript)\b/.test(hay)) return 'javascript'
  if (/\b(react|angular|vue|tanstack|typescript|spa)\b/.test(hay)) return 'typescript'
  if (/\bgo\b|golang/.test(hay)) return 'go'
  if (/\b(springboot|spring|quarkus|java|hexagon)\b/.test(hay)) return 'java'
  if (/\bkotlin\b/.test(hay)) return 'kotlin'
  if (/\bpython\b/.test(hay)) return 'python'
  if (/\brust\b/.test(hay)) return 'rust'
  if (/\b(helm|chart)\b/.test(hay)) return 'helm'
  if (/\b(terraform|hcl|iac)\b/.test(hay)) return 'hcl'
  return 'mixed'
}

/** Progress-log actions mirroring the real scaffolder steps (display only). */
function defaultActions() {
  return [
    { title: 'Create repository', duration: 0.8 },
    { title: 'Render template skeleton', duration: 0.9 },
    { title: 'Commit rendered files', duration: 0.7 },
    { title: 'Register catalog-info.yaml', duration: 0.3 },
    { title: 'Create kpack build (buildpacks → Harbor)', duration: 0.6 },
    { title: 'Create Argo CD Application (GitOps)', duration: 0.6 },
  ]
}

const asObj = (v: YamlValue | undefined): Record<string, YamlValue> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, YamlValue>) : {}

/** Translate one Backstage parameter property into a wizard field. */
function buildField(key: string, spec: Record<string, YamlValue>, required: boolean): Record<string, unknown> | null {
  const uiField = spec['ui:field']
  // The console creates the repo itself from `name`; a RepoUrlPicker has no
  // place in the wizard (the scaffolder derives owner/repo from the org + name).
  if (uiField === 'RepoUrlPicker') return null

  const label = typeof spec.title === 'string' ? spec.title : humanize(key)
  const help = typeof spec.description === 'string' ? spec.description : undefined
  const base: Record<string, unknown> = { key, label }
  if (help) base.help = help
  if (required) base.required = true

  if (uiField === 'OwnerPicker') return { kind: 'owner', ...base }

  if (Array.isArray(spec.enum)) {
    const names = Array.isArray(spec.enumNames) ? spec.enumNames : []
    return {
      kind: 'select',
      ...base,
      options: spec.enum.map((v, i) => ({ value: String(v), label: String(names[i] ?? v) })),
      ...(spec.default != null ? { default: String(spec.default) } : {}),
    }
  }

  const type = spec.type
  if (type === 'boolean') return { kind: 'boolean', ...base, default: Boolean(spec.default) }

  if (type === 'integer' || type === 'number') {
    return {
      kind: 'string',
      ...base,
      ...(spec.default != null ? { default: String(spec.default) } : {}),
      pattern: {
        regex: type === 'integer' ? '^-?\\d+$' : '^-?\\d*\\.?\\d+$',
        message: 'Enter a number.',
      },
    }
  }

  if (type === 'array') {
    const items = asObj(spec.items)
    if (Array.isArray(items.enum)) {
      return {
        kind: 'multiselect',
        ...base,
        options: items.enum.map((v) => ({ value: String(v), label: String(v) })),
        ...(Array.isArray(spec.default) ? { default: spec.default.map(String) } : {}),
      }
    }
  }

  // Default: a string field, carrying JSON-schema pattern + maxLength hints.
  const field: Record<string, unknown> = { kind: 'string', ...base }
  if (spec.default != null) field.default = String(spec.default)
  if (typeof spec.pattern === 'string') {
    field.pattern = { regex: spec.pattern, message: 'Value does not match the required format.' }
  }
  if (typeof spec.maxLength === 'number') {
    field.help = `${help ? `${help} ` : ''}Max ${spec.maxLength} characters.`
  }
  return field
}

/** Turn Backstage `spec.parameters` (a page, or an array of pages) into wizard steps. */
function buildSteps(parameters: YamlValue | undefined): Array<Record<string, unknown>> {
  const pages: YamlValue[] = Array.isArray(parameters)
    ? parameters
    : parameters && typeof parameters === 'object'
    ? [parameters]
    : []

  const steps: Array<Record<string, unknown>> = []
  pages.forEach((pageRaw, i) => {
    const page = asObj(pageRaw)
    const props = asObj(page.properties)
    const required = Array.isArray(page.required) ? page.required.map(String) : []
    const fields: Array<Record<string, unknown>> = []
    for (const [key, spec] of Object.entries(props)) {
      const f = buildField(key, asObj(spec), required.includes(key))
      if (f) fields.push(f)
    }
    if (!fields.length) return
    const title = typeof page.title === 'string' ? page.title : `Step ${i + 1}`
    steps.push({
      key: slug(title),
      title,
      description: typeof page.description === 'string' ? page.description : '',
      fields,
    })
  })
  return steps
}

/** Build one CatalogTemplate-shaped object from a parsed `template.yaml`. */
function buildTemplate(
  doc: YamlValue,
  templateDir: string,
  org: string,
  templatesRepo: string,
  browseBase: string,
): Record<string, unknown> | null {
  const root = asObj(doc)
  const metadata = asObj(root.metadata)
  const spec = asObj(root.spec)
  const name = typeof metadata.name === 'string' ? metadata.name : undefined
  if (!name) return null

  const tags = Array.isArray(metadata.tags) ? metadata.tags.map(String) : []
  const family = inferFamily(name, tags)
  const language = inferLanguage(name, tags)
  const specType = typeof spec.type === 'string' ? spec.type : 'service'
  const steps = buildSteps(spec.parameters)

  return {
    id: name,
    title: typeof metadata.title === 'string' ? metadata.title : humanize(name),
    description: typeof metadata.description === 'string' ? metadata.description : '',
    produces: {
      kind: family === 'api' ? 'API' : family === 'infra' ? 'Resource' : 'Component',
      type: specType,
    },
    family,
    language,
    tags: tags.length ? tags : ['gitea'],
    owner: typeof spec.owner === 'string' ? spec.owner : org,
    glyph: glyphOf(name),
    tone: toneOf(name),
    estimateMinutes: 2,
    popular: tags.includes('recommended'),
    isNew: true,
    source: 'gitea',
    repoUrl: `${browseBase}/${org}/${templatesRepo}/src/branch/main/${templateDir}`,
    // Carry the Backstage parameter schema through verbatim (additive), and the
    // wizard-native translation the Create form actually renders.
    parameters: spec.parameters ?? [],
    steps,
    actions: defaultActions(),
    scaffold: {
      // Backstage templates own their catalog descriptor + deploy/ + GitOps, so
      // GitOps is ON: generate repo → render skeleton → kpack build → Argo CD.
      gitops: true,
      manifestPath: 'deploy',
      catalogInfoPath: 'catalog-info.yaml',
      // Where the scaffolder finds the skeleton to render + commit.
      templatesRepo: `${org}/${templatesRepo}`,
      templatePath: templateDir,
    },
  }
}

/** Read `spec.targets` from a parsed catalog-info Location. */
function extractTargets(doc: YamlValue): string[] {
  const spec = asObj(asObj(doc).spec)
  const targets = spec.targets
  if (!Array.isArray(targets)) return []
  return targets
    .map(String)
    .map((t) => t.replace(/^\.\//, ''))
    .filter((t) => t.endsWith('template.yaml'))
}

type Api = (path: string, init?: RequestInit) => Promise<Response>

/** Fallback discovery: list each `templates/<name>` dir via the contents API. */
async function listTargetsFromContents(api: Api, org: string, repo: string): Promise<string[]> {
  const r = await api(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/contents/templates`)
  if (!r.ok) return []
  const entries = (await r.json().catch(() => [])) as Array<{ type?: string; name?: string; path?: string }>
  return entries
    .filter((e) => e?.type === 'dir' && e.name)
    .map((e) => `templates/${e.name}/template.yaml`)
}

export async function handleListTemplates(req: Request): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  const conn = giteaConn()
  if (!conn) {
    return withCookie(
      Response.json({ configured: false, source: 'gitea', templates: [] }),
      auth.refreshedCookie,
    )
  }

  const org = env('GITEA_TEMPLATES_ORG') || env('GITEA_ORG') || 'adhar'
  const templatesRepo = env('GITEA_TEMPLATES_REPO') || 'adhar-templates'
  const browseBase = getTool('gitea')?.baseUrl ?? ''
  const api = giteaFetcher(conn)

  let targets: string[] = []
  try {
    const ci = await api(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(templatesRepo)}/raw/catalog-info.yaml`)
    if (ci.ok) targets = extractTargets(parseYaml(await ci.text()))
    if (!targets.length) targets = await listTargetsFromContents(api, org, templatesRepo)
  } catch (e) {
    return withCookie(
      Response.json(
        {
          configured: true,
          source: 'gitea',
          org,
          templates: [],
          error: 'gitea_unreachable',
          detail: e instanceof Error ? e.message : String(e),
        },
        { status: 502 },
      ),
      auth.refreshedCookie,
    )
  }

  const templates: Array<Record<string, unknown>> = []
  for (const target of targets) {
    const dir = target.replace(/\/template\.yaml$/, '')
    try {
      const r = await api(
        `/repos/${encodeURIComponent(org)}/${encodeURIComponent(templatesRepo)}/raw/${target}`,
      )
      if (!r.ok) continue
      const built = buildTemplate(parseYaml(await r.text()), dir, org, templatesRepo, browseBase)
      if (built) templates.push(built)
    } catch {
      /* skip a single malformed template — the rest still list */
    }
  }

  return withCookie(
    Response.json({ configured: true, source: 'gitea', org, templates }),
    auth.refreshedCookie,
  )
}
