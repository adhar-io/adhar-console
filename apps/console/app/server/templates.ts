import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getTool } from './tool-registry.ts'

/**
 * Software-template discovery — the real source behind Catalog → Create New.
 *
 * `GET /api/templates` lists templates hosted in **Gitea**, so platform teams
 * curate the golden paths in git rather than in the console bundle. Discovery,
 * in order, using the platform Gitea service token:
 *
 *   1. every repo flagged as a Gitea *template repository* (`template: true`),
 *   2. every repo in the templates org (`GITEA_TEMPLATES_ORG`, else `GITEA_ORG`).
 *
 * Each repo maps to a Create-New card whose `scaffold.sourceRepo` is the repo
 * itself, so submitting the wizard generates a new repo FROM it via the
 * existing `/api/scaffold` engine. A repo may include an optional
 * `.adhar/template.json` (or `template.json`) to enrich the card — title,
 * description, family, glyph, wizard steps, etc. — otherwise the card is built
 * from repo metadata (name, description, language).
 *
 * When Gitea is not configured the endpoint returns `configured: false` with an
 * empty list; the client then falls back to its built-in seed templates.
 */

interface GiteaOwner {
  login?: string
}
interface GiteaRepo {
  id?: number
  name?: string
  full_name?: string
  description?: string
  owner?: GiteaOwner
  language?: string
  html_url?: string
  template?: boolean
  archived?: boolean
  empty?: boolean
  topics?: string[]
  updated_at?: string
}

const LANGUAGE_BY_GITEA: Record<string, string> = {
  go: 'go',
  java: 'java',
  kotlin: 'kotlin',
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  rust: 'rust',
  scala: 'scala',
  swift: 'swift',
  shell: 'shell',
  hcl: 'hcl',
  smarty: 'helm',
  dockerfile: 'mixed',
}

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

function inferLanguage(repo: GiteaRepo): string {
  return LANGUAGE_BY_GITEA[(repo.language ?? '').toLowerCase()] ?? 'mixed'
}

/** Guess a template family from topics, name and language. */
function inferFamily(repo: GiteaRepo, lang: string): string {
  const hay = `${repo.name ?? ''} ${(repo.topics ?? []).join(' ')}`.toLowerCase()
  if (/\b(web|frontend|spa|site|ui|react|vue|angular|next)\b/.test(hay)) return 'website'
  if (/\b(lib|library|sdk|package)\b/.test(hay)) return 'library'
  if (/\b(api|openapi|graphql|grpc|proto|contract)\b/.test(hay)) return 'api'
  if (/\b(mobile|ios|android|expo|flutter)\b/.test(hay)) return 'mobile'
  if (/\b(data|ml|pipeline|etl|spark|notebook|model)\b/.test(hay)) return 'data'
  if (/\b(infra|terraform|helm|chart|iac|module)\b/.test(hay) || lang === 'hcl' || lang === 'helm') return 'infra'
  if (/\b(docs|documentation)\b/.test(hay)) return 'docs'
  return 'service'
}

function glyphOf(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, '')
  return (letters.slice(0, 2) || 'GT').toUpperCase()
}

function toneOf(fullName: string): (typeof TONES)[number] {
  let h = 0
  for (let i = 0; i < fullName.length; i++) h = (h * 31 + fullName.charCodeAt(i)) >>> 0
  return TONES[h % TONES.length]
}

/** Default single-step wizard when a repo carries no `template.json`. */
function defaultSteps() {
  return [
    {
      key: 'identity',
      title: 'Identity',
      description: 'Name, purpose and owner of the new component.',
      fields: [
        {
          kind: 'string',
          key: 'name',
          label: 'Component name',
          placeholder: 'orders-svc',
          help: 'Lowercase, kebab-case. Becomes the catalog name + repo slug.',
          required: true,
        },
        {
          kind: 'string',
          key: 'description',
          label: 'Description',
          placeholder: 'Short explanation of what this does.',
          required: true,
        },
        { kind: 'owner', key: 'owner', label: 'Owner', help: 'Pick a Group entity.', required: true },
      ],
    },
  ]
}

function defaultActions(fullName: string) {
  return [
    { title: 'Generate repository from template', duration: 0.9, detail: fullName },
    { title: 'Commit catalog-info.yaml', duration: 0.4 },
    { title: 'Register entity in catalog', duration: 0.4 },
  ]
}

type GiteaApi = (path: string) => Promise<Response>

/** Best-effort `.adhar/template.json` (or `template.json`) enrichment. */
async function readManifest(api: GiteaApi, owner: string, name: string): Promise<Record<string, unknown> | null> {
  for (const path of ['.adhar/template.json', 'template.json']) {
    try {
      const r = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path}`)
      if (!r.ok) continue
      const body = (await r.json()) as { content?: string; encoding?: string }
      if (!body.content) continue
      const text = body.encoding === 'base64' ? decodeBase64(body.content) : body.content
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      /* missing / malformed manifest — ignore, fall back to metadata */
    }
  }
  return null
}

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** Build one CatalogTemplate-shaped object from a repo (+ optional manifest). */
async function buildFromRepo(api: GiteaApi, repo: GiteaRepo, org: string): Promise<Record<string, unknown> | null> {
  const owner = repo.owner?.login ?? repo.full_name?.split('/')[0]
  const name = repo.name ?? repo.full_name?.split('/')[1]
  if (!owner || !name) return null
  const fullName = `${owner}/${name}`
  const manifest = await readManifest(api, owner, name)
  const m = (k: string) => (manifest ? manifest[k] : undefined)

  const lang = (m('language') as string) ?? inferLanguage(repo)
  const family = (m('family') as string) ?? inferFamily(repo, lang)
  const tags = Array.isArray(m('tags'))
    ? (m('tags') as string[])
    : Array.from(new Set([...(repo.topics ?? []), 'gitea']))
  const scaffoldIn = (m('scaffold') as Record<string, unknown>) ?? {}

  return {
    id: `gitea-${owner}-${name}`.toLowerCase(),
    title: (m('title') as string) ?? humanize(name),
    description:
      (m('description') as string) ??
      repo.description ??
      `Scaffold a new project from the ${fullName} template.`,
    produces: (m('produces') as unknown) ?? {
      kind: family === 'api' ? 'API' : family === 'infra' ? 'Resource' : 'Component',
      type: family,
    },
    family,
    language: lang,
    tags: tags.length ? tags : ['gitea'],
    owner: (m('owner') as string) ?? org ?? owner,
    glyph: (m('glyph') as string) ?? glyphOf(name),
    tone: (m('tone') as string) ?? toneOf(fullName),
    estimateMinutes: (m('estimateMinutes') as number) ?? 1,
    popular: Boolean(m('popular')),
    isNew: m('isNew') !== undefined ? Boolean(m('isNew')) : true,
    source: 'gitea',
    repoUrl: repo.html_url,
    steps: (m('steps') as unknown) ?? defaultSteps(),
    actions: (m('actions') as unknown) ?? defaultActions(fullName),
    scaffold: {
      sourceRepo: fullName,
      gitops: Boolean(scaffoldIn.gitops),
      manifestPath: (scaffoldIn.manifestPath as string) ?? undefined,
      catalogInfoPath: (scaffoldIn.catalogInfoPath as string) ?? undefined,
      goldenPath: (scaffoldIn.goldenPath as string) ?? undefined,
    },
  }
}

function mergeReposById(a: GiteaRepo[], b: GiteaRepo[]): GiteaRepo[] {
  const seen = new Set(a.map((r) => r.full_name ?? `${r.owner?.login}/${r.name}`))
  const out = [...a]
  for (const r of b) {
    const key = r.full_name ?? `${r.owner?.login}/${r.name}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

export async function handleListTemplates(req: Request): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  const gitea = getTool('gitea')
  if (!gitea?.baseUrl || !gitea.serviceToken) {
    return withCookie(
      Response.json({ configured: false, source: 'gitea', templates: [] }),
      auth.refreshedCookie,
    )
  }

  const api: GiteaApi = (path) =>
    fetch(`${gitea.baseUrl}/api/v1${path}`, {
      headers: { authorization: `token ${gitea.serviceToken}`, accept: 'application/json' },
    })

  const org = env('GITEA_TEMPLATES_ORG') || env('GITEA_ORG') || ''
  let repos: GiteaRepo[] = []
  try {
    // Repos explicitly flagged as template repositories, instance-wide.
    const s = await api('/repos/search?template=true&limit=50')
    if (s.ok) {
      const body = (await s.json()) as { data?: GiteaRepo[] }
      repos = body.data ?? []
    }
    // Plus everything in the curated templates org.
    if (org) {
      const r = await api(`/orgs/${encodeURIComponent(org)}/repos?limit=50`)
      if (r.ok) repos = mergeReposById(repos, ((await r.json()) as GiteaRepo[]) ?? [])
    }
  } catch (e) {
    return withCookie(
      Response.json(
        { configured: true, source: 'gitea', templates: [], error: 'gitea_unreachable', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      ),
      auth.refreshedCookie,
    )
  }

  const candidates = repos.filter((r) => r && !r.archived && !r.empty).slice(0, 30)
  const built = await Promise.all(candidates.map((r) => buildFromRepo(api, r, org)))
  const templates = built.filter(Boolean)

  return withCookie(
    Response.json({ configured: true, source: 'gitea', org: org || undefined, templates }),
    auth.refreshedCookie,
  )
}
