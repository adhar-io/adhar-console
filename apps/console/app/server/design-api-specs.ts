import { parseYaml } from '@adhar/utils'

/**
 * Design → API & Schemas registration for a scaffolded component.
 *
 * A template that scaffolds an HTTP service or function ships its contract:
 * `catalog-info.yaml` carries a `kind: API` document whose
 * `spec.definition.$text` names the spec file (`./api/openapi.yaml`), and the
 * Component lists it under `providesApis`. Until now that contract reached the
 * Design module only when someone opened Catalog APIs and clicked Import, so a
 * new API existed in the catalog and in the repository and nowhere a designer
 * looked. The scaffolder now registers it the moment the skeleton is
 * committed, from the files it just rendered — no second read of Gitea.
 *
 * The document is written to the tenant store under the SAME kind and shape
 * the Design module persists (`design.api-spec`, modules/design
 * data/store.ts + views/api-schemas.tsx), at a deterministic id derived from
 * the catalog entity ref (`specIdFor`), so the view's own back-fill from the
 * catalog and a scaffold converge on one document instead of two. An existing
 * document is never overwritten: someone may already be editing it.
 */

/** Mirrors `KIND.apiSpec` in modules/design/src/data/store.ts. */
export const API_SPEC_KIND = 'design.api-spec'

export interface ScaffoldedFile {
  path: string
  text: string
}

/** A `kind: API` document of a catalog-info file, with its definition resolved. */
export interface CatalogApi {
  name: string
  namespace: string
  title?: string
  description?: string
  /** Repository path of the definition (`$text: ./api/openapi.yaml`, resolved). */
  definitionPath?: string
  /** The definition itself when catalog-info carries it inline. */
  definition?: string
}

export interface ApiSpecRegistration {
  id: string
  /** Catalog ref the Design module links the spec to: `api:<namespace>/<name>`. */
  entity: string
  name: string
  data: Record<string, unknown>
}

/** The documents of a YAML stream (same split as the Design module's `splitYamlDocs`). */
export function splitYamlDocuments(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/^---[ \t]*$/m)
    .map((d) => d.trim())
    .filter((d) => d && !/^\.\.\.$/.test(d))
}

type Obj = Record<string, unknown>
const obj = (
  v: unknown,
): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (
  v: unknown,
):
  | string
  | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined)

/** `./api/openapi.yaml` next to `catalog-info.yaml` → `api/openapi.yaml`. */
function resolveRepoPath(from: string, target: string): string {
  const base = from.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') base.pop()
    else base.push(seg)
  }
  return base.join('/')
}

/** Every `kind: API` document of a catalog-info file (documents that do not parse are skipped). */
export function catalogApis(
  catalogInfo: string,
  catalogInfoPath = 'catalog-info.yaml',
): CatalogApi[] {
  const out: CatalogApi[] = []
  for (const text of splitYamlDocuments(catalogInfo)) {
    let doc: Obj | null
    try {
      doc = obj(parseYaml(text))
    } catch {
      continue
    }
    if (!doc || doc.kind !== 'API') continue
    const meta = obj(doc.metadata) ?? {}
    const spec = obj(doc.spec) ?? {}
    const name = str(meta.name)
    if (!name) continue
    const api: CatalogApi = {
      name: name.toLowerCase(),
      namespace: (str(meta.namespace) ?? 'default').toLowerCase(),
      title: str(meta.title),
      description: str(meta.description),
    }
    const def = spec.definition
    if (typeof def === 'string' && def.trim()) {
      api.definition = def
    } else {
      const sub = obj(def)
      const target = str(sub?.$text) ?? str(sub?.$yaml) ?? str(sub?.$json)
      if (target && !/^https?:\/\//.test(target)) {
        api.definitionPath = resolveRepoPath(catalogInfoPath, target)
      }
    }
    out.push(api)
  }
  return out
}

/** The Design module's catalog ref (`refOf` in modules/design data/platform-model.ts). */
export function apiEntityRef(api: Pick<CatalogApi, 'namespace' | 'name'>): string {
  return `api:${api.namespace || 'default'}/${api.name}`.toLowerCase()
}

/**
 * The document id a catalog API's spec lives at — the same on the server and
 * in the Design module's back-fill (`catalogSpecId`), so both land on ONE
 * document. `api:default/orders-api` → `catalog-api-default-orders-api`.
 */
export function specIdFor(entityRef: string): string {
  return `catalog-${entityRef.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
    .slice(0, 120)
}

/** `info.title` / `info.version` / `info.description` of an OpenAPI, AsyncAPI or JSON document. */
function specInfo(document: string): { title?: string; version?: string; description?: string } {
  let doc: unknown
  try {
    doc = document.trim().startsWith('{') ? JSON.parse(document) : parseYaml(document)
  } catch {
    return {}
  }
  const info = obj(obj(doc)?.info) ?? {}
  return {
    title: str(info.title),
    version: str(info.version),
    description: str(info.description)?.split('\n')[0],
  }
}

export interface RegistrationContext {
  /** Where the skeleton's catalog-info was committed (relative to the repo root). */
  catalogInfoPath: string
  /** Bare repository name in the platform's Gitea org (what the Design module's git links carry). */
  repo: string
  branch: string
  /** Shown in the library, e.g. `scaffold:templates/function-go-service`. */
  source: string
  project?: string
  team?: string
  /** Display name of whoever scaffolded. */
  by?: string
  now: string
}

/**
 * The specs a scaffold declares: one per `kind: API` document whose definition
 * is among the committed files (or inline). An API whose definition is a URL,
 * or names a file the skeleton did not ship, registers nothing — a spec the
 * library cannot show is worse than a catalog row that says "no definition".
 */
export function apiSpecRegistrations(
  files: readonly ScaffoldedFile[],
  ctx: RegistrationContext,
): ApiSpecRegistration[] {
  const byPath = new Map(files.map((f) => [f.path, f.text]))
  const catalogInfo = byPath.get(ctx.catalogInfoPath)
  if (!catalogInfo) return []
  const out: ApiSpecRegistration[] = []
  for (const api of catalogApis(catalogInfo, ctx.catalogInfoPath)) {
    const document = api.definition ??
      (api.definitionPath ? byPath.get(api.definitionPath) : undefined)
    if (!document?.trim()) continue
    const info = specInfo(document)
    const entity = apiEntityRef(api)
    // What the Catalog tab's manual Import names it: the entity, not the document.
    const name = api.title ?? api.name
    out.push({
      id: specIdFor(entity),
      entity,
      name,
      data: {
        name,
        version: info.version ?? '0.1.0',
        description: api.description ?? info.description ?? '',
        document,
        source: ctx.source,
        entity,
        ...(api.definitionPath ? { git: { repo: ctx.repo, branch: ctx.branch, path: api.definitionPath, at: ctx.now } } : {}),
        ...(ctx.project ? { project: ctx.project } : {}),
        ...(ctx.team ? { team: ctx.team } : {}),
        created_at: ctx.now,
        updated_at: ctx.now,
        ...(ctx.by ? { updated_by: ctx.by } : {}),
      },
    })
  }
  return out
}

/** The two store calls registration needs (workspace/store.ts `Store` satisfies it). */
export interface SpecStore {
  get(kind: string, id: string): Promise<unknown | null>
  put(kind: string, id: string, data: Record<string, unknown>, userId: string): Promise<unknown>
}

/** Write each registration that does not exist yet; one already there is left exactly as it is. */
export async function registerApiSpecs(
  store: SpecStore,
  registrations: readonly ApiSpecRegistration[],
  userId: string,
): Promise<{ created: ApiSpecRegistration[]; existing: ApiSpecRegistration[] }> {
  const created: ApiSpecRegistration[] = []
  const existing: ApiSpecRegistration[] = []
  for (const r of registrations) {
    if (await store.get(API_SPEC_KIND, r.id)) {
      existing.push(r)
      continue
    }
    await store.put(API_SPEC_KIND, r.id, r.data, userId)
    created.push(r)
  }
  return { created, existing }
}

/** The text of a rendered skeleton file (the scaffolder holds them base64-encoded for Gitea). */
export function decodeScaffoldedFile(path: string, base64: string): ScaffoldedFile {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return { path, text: new TextDecoder().decode(bytes) }
}
