import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getTool } from './tool-registry.ts'

/**
 * Team (Group entity) discovery — the source behind the Create-New wizard's
 * "Owner" picker.
 *
 * `GET /api/teams` returns the Backstage `kind: Group` entities an organisation
 * can own components with. The live catalog (real cluster) surfaces only k8s
 * workloads + Gitea repos and defines no Group entities, so the owner picker
 * would otherwise be empty and the wizard couldn't proceed. This endpoint fixes
 * that by discovering teams from the curated `adhar/adhar-templates` Gitea repo
 * (its `catalog-info.yaml` / `teams.yaml` catalog descriptors) using the
 * platform Gitea service token, and ALWAYS guarantees the two platform defaults
 * `default-platform` + `default-application` are present.
 *
 * Contract: `{ teams: [{ name, title }], source: 'gitea' | 'default' }`.
 *   - Gitea configured  → discovered Groups ∪ the two defaults (source 'gitea').
 *   - Gitea unavailable → just the two defaults (source 'default').
 *
 * As a side effect (best-effort, non-fatal) it seeds a `teams.yaml` describing
 * the two defaults into `adhar/adhar-templates` if one isn't there yet, so the
 * teams genuinely originate from the repo rather than only from this code.
 */

export interface Team {
  name: string
  title: string
}

/** The two teams every organisation must be able to own components with. */
const DEFAULT_TEAMS: Team[] = [
  { name: 'default-platform', title: 'Platform Team' },
  { name: 'default-application', title: 'Application Team' },
]

/** owner/name of the curated templates repo that also holds the team catalog. */
function templatesRepo(): { owner: string; name: string } {
  const ref = env('GITEA_TEMPLATES_REPO') || 'adhar/adhar-templates'
  const [owner, name] = ref.split('/')
  return { owner: owner || 'adhar', name: name || 'adhar-templates' }
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** UTF-8 safe base64 (Gitea contents API expects base64-encoded file bodies). */
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * Light, dependency-free parse of Backstage catalog YAML for `kind: Group`
 * entities. The descriptor files are small and controlled, so a scoped scan of
 * each `---`-separated document is enough — we pull `metadata.name` and
 * `metadata.title` from the metadata block of any Group document.
 */
export function parseGroups(text: string): Team[] {
  const out: Team[] = []
  const docs = text.split(/^---\s*$/m)
  for (const doc of docs) {
    if (!/(^|\n)\s*kind:\s*Group\b/.test(doc)) continue
    // Capture the indented body of the `metadata:` mapping.
    const meta = doc.match(/(^|\n)[ \t]*metadata:[ \t]*\n((?:[ \t]+.*(?:\n|$))+)/)
    const block = meta ? meta[2] : doc
    const nameM = block.match(/(^|\n)[ \t]*name:[ \t]*(["']?)([A-Za-z0-9][A-Za-z0-9._-]*)\2/)
    if (!nameM) continue
    const name = nameM[3]
    const titleM = block.match(/(^|\n)[ \t]*title:[ \t]*(.+)/)
    const title = titleM ? titleM[2].trim().replace(/^["']|["']$/g, '') : humanize(name)
    out.push({ name, title })
  }
  return out
}

function humanize(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function dedupeTeams(teams: Team[]): Team[] {
  const seen = new Set<string>()
  const out: Team[] = []
  for (const t of teams) {
    if (!t.name || seen.has(t.name)) continue
    seen.add(t.name)
    out.push({ name: t.name, title: t.title || humanize(t.name) })
  }
  return out
}

type GiteaApi = (path: string, init?: RequestInit) => Promise<Response>

/** The `teams.yaml` we seed into the templates repo (the two defaults). */
function defaultTeamsYaml(): string {
  const doc = (t: Team) =>
    [
      'apiVersion: backstage.io/v1alpha1',
      'kind: Group',
      'metadata:',
      `  name: ${t.name}`,
      `  title: ${JSON.stringify(t.title)}`,
      `  description: ${JSON.stringify(`${t.title} — default owner for scaffolded components.`)}`,
      'spec:',
      '  type: team',
      '  children: []',
    ].join('\n')
  return (
    '# Default platform teams — auto-seeded by the Adhar console so every\n' +
    '# organisation can own components with a Group entity out of the box.\n' +
    DEFAULT_TEAMS.map(doc).join('\n---\n') +
    '\n'
  )
}

/**
 * Seed `teams.yaml` into the templates repo if absent (idempotent). Best-effort:
 * any failure is swallowed — the endpoint still returns the defaults.
 */
async function seedTeamsFile(api: GiteaApi, owner: string, name: string): Promise<void> {
  try {
    const existing = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/teams.yaml`)
    if (existing.ok) return // already present — nothing to do
    if (existing.status !== 404) return // unexpected (403/500) — don't fight it
    await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/teams.yaml`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: toBase64(defaultTeamsYaml()),
        message: 'chore: seed default platform teams (adhar console)',
        branch: 'main',
      }),
    })
  } catch {
    /* non-fatal — discovery + defaults still work */
  }
}

/** Read one catalog descriptor and extract its Group entities, if any. */
async function readGroupsFrom(api: GiteaApi, owner: string, name: string, path: string): Promise<Team[]> {
  try {
    const r = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path}`)
    if (!r.ok) return []
    const body = (await r.json()) as { content?: string; encoding?: string }
    if (!body.content) return []
    const text = body.encoding === 'base64' ? decodeBase64(body.content) : body.content
    return parseGroups(text)
  } catch {
    return []
  }
}

export async function handleListTeams(req: Request): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  const gitea = getTool('gitea')
  if (!gitea?.baseUrl || !gitea.serviceToken) {
    // Gitea not configured — the two defaults are always selectable.
    return withCookie(Response.json({ teams: DEFAULT_TEAMS, source: 'default' }), auth.refreshedCookie)
  }

  const api: GiteaApi = (path, init) =>
    fetch(`${gitea.baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `token ${gitea.serviceToken}`,
        accept: 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    })

  const { owner, name } = templatesRepo()

  // Best-effort: make sure the repo actually declares the defaults.
  await seedTeamsFile(api, owner, name)

  // Discover Group entities from the repo's catalog descriptors.
  const discovered: Team[] = []
  try {
    // Known descriptor files first.
    for (const path of ['teams.yaml', 'catalog-info.yaml', '.adhar/teams.yaml']) {
      discovered.push(...(await readGroupsFrom(api, owner, name, path)))
    }
    // Plus any other top-level *.yaml/*.yml catalog descriptors.
    try {
      const listing = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`)
      if (listing.ok) {
        const entries = (await listing.json()) as Array<{ name?: string; type?: string }>
        const extra = (Array.isArray(entries) ? entries : [])
          .filter((e) => e.type === 'file' && /\.ya?ml$/i.test(e.name ?? ''))
          .map((e) => e.name!)
          .filter((p) => !['teams.yaml', 'catalog-info.yaml'].includes(p))
        for (const path of extra) discovered.push(...(await readGroupsFrom(api, owner, name, path)))
      }
    } catch {
      /* listing unavailable — the known-path scan above still ran */
    }
  } catch {
    /* discovery failed — fall through to defaults only */
  }

  // The two defaults are ALWAYS present, deduped with whatever the repo defines.
  const teams = dedupeTeams([...discovered, ...DEFAULT_TEAMS])

  return withCookie(Response.json({ teams, source: 'gitea' }), auth.refreshedCookie)
}
