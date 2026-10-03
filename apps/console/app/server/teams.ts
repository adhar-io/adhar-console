import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getTool } from './tool-registry.ts'
import { activeOrgSlug } from './organizations.ts'

/**
 * Team (Group entity) discovery — the source behind the Create-New wizard's
 * "Owner" picker.
 *
 * `GET /api/teams` returns the groups an organisation can own components with.
 *
 * The teams are the ACTIVE ORGANISATION'S OWN. The provisioner creates a Gitea
 * org named after the tenant's slug, and a team in that org is a real group of
 * real people with real repository access — so it is the honest answer to "who
 * can own this service". Previously this read a curated, install-wide
 * `adhar/adhar-templates` repo instead, which meant the owner picker offered
 * the same list to every organisation on the platform and, on most installs,
 * only the two hardcoded defaults. Picking an owner was picking a label.
 *
 * Contract: `{ teams: [{ name, title }], source, org }` where `source` is
 *   - 'org'      → teams discovered in the organisation's own Gitea org,
 *   - 'catalog'  → the templates repo's Group descriptors (older installs that
 *                  keep their teams there, and no org teams exist),
 *   - 'default'  → neither was reachable; the two platform defaults stand.
 *
 * The defaults are always appended, so the picker is never empty and the
 * wizard can always proceed.
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

/** A Gitea team, as `GET /orgs/{org}/teams` returns it. */
interface GiteaTeam {
  name?: string
  description?: string
}

/**
 * The teams of one Gitea organisation.
 *
 * Gitea gives every org an `Owners` team at creation, so a provisioned tenant
 * always has at least one real group — which is why this can be the primary
 * source rather than a best-effort extra.
 *
 * A 404 means the org does not exist on this install (the console is pointed
 * at a Gitea that never had the tenant provisioned); a 403 means the service
 * token cannot see it. Both return empty so the caller falls back rather than
 * failing the picker.
 */
export async function listOrgTeams(api: GiteaApi, org: string): Promise<Team[]> {
  try {
    const res = await api(`/orgs/${encodeURIComponent(org)}/teams`)
    if (!res.ok) return []
    const body = (await res.json()) as GiteaTeam[]
    if (!Array.isArray(body)) return []
    return body
      .filter((t) => typeof t.name === 'string' && t.name.length > 0)
      .map((t) => {
        // A Gitea team description is free text and is often a whole sentence
        // — "Mapped from the Keycloak platform-developer group" — which as a
        // dropdown label buries the name the operator is actually choosing.
        // Short ones read as titles; long ones are prose, so the name wins.
        const desc = t.description?.trim() ?? ''
        const title = desc && desc.length <= 32 ? desc : humanize(t.name!)
        return { name: t.name!, title }
      })
  } catch {
    return []
  }
}

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

  const org = await activeOrgSlug(auth.user.id, auth.activeTenant)

  const gitea = getTool('gitea')
  if (!gitea?.baseUrl || !gitea.serviceToken) {
    // Gitea not configured — the two defaults are always selectable.
    return withCookie(
      Response.json({ teams: DEFAULT_TEAMS, source: 'default', org }),
      auth.refreshedCookie,
    )
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

  // The organisation's own teams first. This is the answer the question
  // actually asks — who, in this org, can own the thing being created.
  const orgTeams = await listOrgTeams(api, org)
  if (orgTeams.length > 0) {
    return withCookie(
      Response.json({ teams: dedupeTeams([...orgTeams, ...DEFAULT_TEAMS]), source: 'org', org }),
      auth.refreshedCookie,
    )
  }

  // No org teams — either this install predates per-tenant Gitea orgs, or the
  // tenant was never provisioned. Fall back to the curated templates repo.
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

  return withCookie(Response.json({ teams, source: 'catalog', org }), auth.refreshedCookie)
}
