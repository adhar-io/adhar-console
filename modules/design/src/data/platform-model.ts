/**
 * The Adhar platform, as the Design module sees it — pure model, no React.
 *
 * The console's Service Catalog is composed in the host app from three live
 * sources, and the Design phase reads the same ones directly (it is a remote
 * and cannot import host code):
 *
 *   • Application XRs (`platform.adhar.io/v1alpha1 applications` in
 *     `adhar-system`) — one per deployable, carrying its project.
 *   • Gitea repositories in the organisation — one Component each.
 *   • `catalog-info.yaml` descriptors in those repositories (Backstage
 *     format) — Systems, Components, APIs, Resources and their relations.
 *
 * Plus Argo CD Applications (`<project>-<app>-<env>`, labelled with
 * `adhar.io/application|environment|project`) and the workspace tenancy
 * (Organisation → Teams → Projects → Apps).
 *
 * From those this module derives Mermaid diagrams (C4 context / container,
 * deployment per environment, tenancy). Everything is a pure function of its
 * inputs so the generators are unit-tested and a generated diagram can be
 * regenerated and diffed.
 */

import { parseYaml } from './openapi.ts'

/* ───────────────────────── entities ───────────────────────── */

export type PKind = 'Component' | 'API' | 'Resource' | 'System' | 'Domain' | 'Group'

export interface RepoLocation {
  repo: string
  branch: string
  path: string
}

export interface PEntity {
  kind: PKind
  /** Lower-case entity name. */
  name: string
  namespace: string
  title?: string
  description?: string
  type?: string
  lifecycle?: string
  /** Canonical refs (`group:default/payments`, `system:default/orders`, …). */
  owner?: string
  system?: string
  domain?: string
  providesApis: string[]
  consumesApis: string[]
  dependsOn: string[]
  tags: string[]
  /** Workspace project slug (Application XR `spec.parameters.project`). */
  project?: string
  /** Gitea repository the entity lives in. */
  repo?: string
  /** Where the descriptor itself was read from. */
  location?: RepoLocation
  /** API: inline definition text. */
  definition?: string
  /** API: repository path of the definition (`$text: ./openapi.yaml`, resolved). */
  definitionPath?: string
  /** API: an absolute URL the definition points at. */
  definitionUrl?: string
  annotations?: Record<string, string>
  origin: 'catalog-info' | 'application' | 'repo'
}

const KIND_BY_PREFIX: Record<string, PKind> = {
  component: 'Component',
  api: 'API',
  resource: 'Resource',
  system: 'System',
  domain: 'Domain',
  group: 'Group',
}

/**
 * Canonical `kind:namespace/name` ref, lower-case. Accepts every form the
 * console uses (`component:cart`, `api:default/orders`, a bare `cart` with a
 * default kind).
 */
export function normalizeRef(ref: string, defaultKind = 'component', defaultNs = 'default'): string {
  const s = String(ref ?? '').trim().toLowerCase()
  if (!s) return ''
  const hasKind = /^[a-z]+:/.test(s)
  const kind = hasKind ? s.slice(0, s.indexOf(':')) : defaultKind.toLowerCase()
  const rest = hasKind ? s.slice(s.indexOf(':') + 1) : s
  const [ns, name] = rest.includes('/') ? rest.split('/', 2) : [defaultNs, rest]
  return `${kind}:${ns || defaultNs}/${name}`
}

export function refOf(e: Pick<PEntity, 'kind' | 'namespace' | 'name'>): string {
  return `${e.kind.toLowerCase()}:${e.namespace || 'default'}/${e.name}`.toLowerCase()
}

/** `component:default/cart` → `{ kind: 'Component', name: 'cart' }`. */
export function splitRef(ref: string): { kind?: PKind; namespace: string; name: string } {
  const n = normalizeRef(ref)
  const kindKey = n.slice(0, n.indexOf(':'))
  const [namespace, name] = n.slice(n.indexOf(':') + 1).split('/', 2)
  return { kind: KIND_BY_PREFIX[kindKey], namespace, name }
}

/** Short label for a ref: drops the default namespace. */
export function shortRef(ref: string): string {
  const { kind, namespace, name } = splitRef(ref)
  return `${(kind ?? 'Component').toLowerCase()}:${namespace === 'default' ? '' : `${namespace}/`}${name}`
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return []
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined
}

/** Resolve `./openapi.yaml` (or `../x`) against the descriptor's folder. */
export function resolveRepoPath(fromFile: string, rel: string): string {
  if (/^[a-z]+:\/\//i.test(rel)) return rel
  const base = fromFile.split('/').slice(0, -1)
  const parts = rel.startsWith('/') ? [] : [...base]
  for (const seg of rel.replace(/^\/+/, '').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** Split a multi-document YAML stream on `---` lines. */
export function splitYamlDocs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/^---[ \t]*$/m)
    .map((d) => d.trim())
    .filter((d) => d && !/^\.\.\.$/.test(d))
}

/**
 * Parse a Backstage `catalog-info.yaml` (one or many documents) into
 * entities. Unknown kinds (Location, Template, User) are skipped; a document
 * that does not parse is skipped rather than failing the whole file.
 */
export function parseCatalogInfo(text: string, loc?: RepoLocation): PEntity[] {
  const out: PEntity[] = []
  for (const docText of splitYamlDocs(text)) {
    let doc: unknown
    try {
      doc = parseYaml(docText)
    } catch {
      continue
    }
    if (!doc || typeof doc !== 'object') continue
    const d = doc as { kind?: unknown; metadata?: Record<string, unknown>; spec?: Record<string, unknown> }
    const kind = KIND_BY_PREFIX[String(d.kind ?? '').toLowerCase()]
    const meta = d.metadata ?? {}
    const name = str(meta.name)?.toLowerCase()
    if (!kind || !name) continue
    const spec = d.spec ?? {}
    const ns = str(meta.namespace)?.toLowerCase() ?? 'default'
    const e: PEntity = {
      kind,
      name,
      namespace: ns,
      title: str(meta.title),
      description: str(meta.description),
      type: str(spec.type),
      lifecycle: str(spec.lifecycle),
      owner: str(spec.owner) ? normalizeRef(str(spec.owner)!, 'group', ns) : undefined,
      system: str(spec.system) ? normalizeRef(str(spec.system)!, 'system', ns) : undefined,
      domain: str(spec.domain) ? normalizeRef(str(spec.domain)!, 'domain', ns) : undefined,
      providesApis: asList(spec.providesApis).map((r) => normalizeRef(r, 'api', ns)),
      consumesApis: asList(spec.consumesApis).map((r) => normalizeRef(r, 'api', ns)),
      dependsOn: asList(spec.dependsOn).map((r) => normalizeRef(r, 'component', ns)),
      tags: asList(meta.tags),
      annotations: meta.annotations && typeof meta.annotations === 'object'
        ? Object.fromEntries(Object.entries(meta.annotations as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : undefined,
      repo: loc?.repo,
      location: loc,
      origin: 'catalog-info',
    }
    if (kind === 'API') {
      const def = spec.definition
      if (typeof def === 'string') {
        if (/^https?:\/\//.test(def.trim()) && !def.trim().includes('\n')) e.definitionUrl = def.trim()
        else e.definition = def
      } else if (def && typeof def === 'object') {
        const sub = def as Record<string, unknown>
        const target = str(sub.$text) ?? str(sub.$yaml) ?? str(sub.$json)
        if (target) {
          if (/^https?:\/\//.test(target)) e.definitionUrl = target
          else e.definitionPath = loc ? resolveRepoPath(loc.path, target) : target.replace(/^\.\//, '')
        }
      }
    }
    out.push(e)
  }
  return out
}

/** Minimal shape of an Application XR. */
export interface AppXR {
  metadata?: { name?: string; labels?: Record<string, string>; creationTimestamp?: string; deletionTimestamp?: string }
  spec?: { parameters?: Record<string, unknown> }
}

/** Repository name from a clone URL (`https://git/org/cart.git` → `cart`). */
export function repoNameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  const m = /([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m?.[1] || undefined
}

export function entitiesFromApplications(xrs: readonly AppXR[]): PEntity[] {
  const out: PEntity[] = []
  for (const a of xrs) {
    const name = a.metadata?.name?.toLowerCase()
    if (!name || a.metadata?.deletionTimestamp) continue
    const p = a.spec?.parameters ?? {}
    const source = (p.source ?? {}) as Record<string, unknown>
    out.push({
      kind: 'Component',
      name,
      namespace: 'default',
      title: str(p.displayName),
      description: str(p.description),
      type: str(p.type) ?? 'service',
      project: str(p.project) ?? a.metadata?.labels?.['adhar.io/project'],
      repo: repoNameFromUrl(str(source.repoURL)),
      providesApis: [],
      consumesApis: [],
      dependsOn: [],
      tags: ['application'],
      origin: 'application',
    })
  }
  return out
}

export interface RepoLite {
  name: string
  description?: string
  default_branch?: string
  mirror?: boolean
  language?: string
}

/** The platform's own repos in the org are not services (mirrors the host's list). */
export { isPlatformRepo, PLATFORM_REPOS } from './platform-repos.ts'

export function entityFromRepo(r: RepoLite): PEntity {
  return {
    kind: 'Component',
    name: r.name.toLowerCase(),
    namespace: 'default',
    title: r.name,
    description: r.description || undefined,
    type: 'service',
    repo: r.name,
    providesApis: [],
    consumesApis: [],
    dependsOn: [],
    tags: r.language ? [r.language.toLowerCase()] : [],
    origin: 'repo',
  }
}

const ORIGIN_RANK: Record<PEntity['origin'], number> = { 'catalog-info': 0, application: 1, repo: 2 }

/**
 * Merge entity lists by ref. The descriptor (`catalog-info`) wins for
 * metadata and relations; an Application contributes its project; a repo its
 * repository name — so a service described in its repo and deployed as an
 * Application is ONE entity carrying both.
 */
export function mergeEntities(...lists: PEntity[][]): PEntity[] {
  const by = new Map<string, PEntity>()
  const all = lists.flat().sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin])
  for (const e of all) {
    const k = refOf(e)
    const cur = by.get(k)
    if (!cur) {
      by.set(k, { ...e })
      continue
    }
    cur.project ??= e.project
    cur.repo ??= e.repo
    cur.title ??= e.title
    cur.description ??= e.description
    cur.type ??= e.type
    cur.tags = Array.from(new Set([...cur.tags, ...e.tags]))
  }
  // A repository that carries a catalog-info.yaml is described by it: the
  // bare "repo = component" fallback would duplicate what the descriptor
  // already says (a repo named after its System showed up twice).
  const described = new Set(all.filter((e) => e.origin === 'catalog-info' && e.location).map((e) => e.location!.repo.toLowerCase()))
  return [...by.values()]
    .filter((e) => !(e.origin === 'repo' && e.repo && described.has(e.repo.toLowerCase())))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

export type RelationType = 'provides' | 'consumes' | 'dependsOn' | 'partOf' | 'ownedBy'

export interface Relation {
  from: string
  to: string
  type: RelationType
}

export function relationsOf(entities: readonly PEntity[]): Relation[] {
  const out: Relation[] = []
  for (const e of entities) {
    const r = refOf(e)
    for (const a of e.providesApis) out.push({ from: r, to: a, type: 'provides' })
    for (const a of e.consumesApis) out.push({ from: r, to: a, type: 'consumes' })
    for (const d of e.dependsOn) out.push({ from: r, to: d, type: 'dependsOn' })
    if (e.system) out.push({ from: r, to: e.system, type: 'partOf' })
    if (e.owner) out.push({ from: r, to: e.owner, type: 'ownedBy' })
  }
  return out
}

/** Components providing / consuming an API (catalog relations). */
export function apiUsage(entities: readonly PEntity[], apiRef: string): { providers: PEntity[]; consumers: PEntity[] } {
  const ref = normalizeRef(apiRef, 'api')
  return {
    providers: entities.filter((e) => e.providesApis.includes(ref)),
    consumers: entities.filter((e) => e.consumesApis.includes(ref)),
  }
}

/** Everything that mentions `ref` (either direction), for "related" panels. */
export function neighbours(entities: readonly PEntity[], ref: string): { entity: PEntity; type: RelationType; direction: 'out' | 'in' }[] {
  const target = normalizeRef(ref)
  const byRef = new Map(entities.map((e) => [refOf(e), e]))
  const out: { entity: PEntity; type: RelationType; direction: 'out' | 'in' }[] = []
  for (const rel of relationsOf(entities)) {
    if (rel.from === target && byRef.has(rel.to)) out.push({ entity: byRef.get(rel.to)!, type: rel.type, direction: 'out' })
    else if (rel.to === target && byRef.has(rel.from)) out.push({ entity: byRef.get(rel.from)!, type: rel.type, direction: 'in' })
  }
  return out
}

/* ───────────────────────── Mermaid helpers ───────────────────────── */

/** A Mermaid-safe identifier. */
export function mid(prefix: string, ...parts: string[]): string {
  return `${prefix}_${parts.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_')
}

/** Text safe inside a double-quoted Mermaid label. */
export function q(s: string | undefined): string {
  return String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '').trim()
}

function label(e: PEntity): string {
  return e.title || e.name
}

const DB_TYPES = new Set(['database', 'db', 'postgres', 'postgresql', 'mysql', 'cache', 'redis'])
const QUEUE_TYPES = new Set(['queue', 'topic', 'kafka', 'stream', 'rabbitmq'])

/* ───────────────────────── C4 context ───────────────────────── */

export interface C4Options {
  title?: string
  /** Restrict to one project's entities (plus what they relate to). */
  project?: string
}

function inProject(entities: readonly PEntity[], project?: string): PEntity[] {
  if (!project) return [...entities]
  return entities.filter((e) => e.project === project || e.kind === 'System' || e.kind === 'API' || e.kind === 'Resource')
}

/**
 * System-landscape view: one box per System (or, when a component belongs to
 * none, the component itself), and a relation wherever a component of one
 * consumes an API provided by — or depends on — a component of another.
 */
export function c4ContextDiagram(entities: readonly PEntity[], opts: C4Options = {}): string {
  const list = inProject(entities, opts.project)
  const byRef = new Map(list.map((e) => [refOf(e), e]))
  const systems = list.filter((e) => e.kind === 'System')
  const components = list.filter((e) => e.kind === 'Component')
  // The box a component is drawn as: its system when known, else itself.
  const boxOf = (ref: string): string | undefined => {
    const e = byRef.get(ref)
    if (!e) return undefined
    if (e.kind === 'System') return refOf(e)
    if (e.kind === 'API') {
      const provider = components.find((c) => c.providesApis.includes(ref))
      return provider ? boxOf(refOf(provider)) : undefined
    }
    if (e.system && byRef.has(e.system)) return e.system
    return e.kind === 'Component' ? refOf(e) : undefined
  }
  const boxes = new Map<string, { id: string; label: string; desc: string; ext: boolean }>()
  for (const s of systems) boxes.set(refOf(s), { id: mid('sys', s.name), label: label(s), desc: s.description ?? '', ext: false })
  for (const c of components) {
    if (c.system && byRef.has(c.system)) continue
    boxes.set(refOf(c), { id: mid('cmp', c.name), label: label(c), desc: c.description ?? (c.project ? `Project ${c.project}` : ''), ext: false })
  }
  const rels = new Map<string, { from: string; to: string; label: string }>()
  for (const c of components) {
    const from = boxOf(refOf(c))
    if (!from) continue
    for (const api of c.consumesApis) {
      const to = boxOf(api)
      if (!to || to === from) continue
      const k = `${from}>${to}`
      const name = byRef.get(api)?.title ?? splitRef(api).name
      const cur = rels.get(k)
      rels.set(k, { from, to, label: cur ? `${cur.label}, ${name}` : `uses ${name}` })
    }
    for (const dep of c.dependsOn) {
      const to = boxOf(dep)
      if (!to || to === from || !boxes.has(to)) continue
      const k = `${from}>${to}`
      if (!rels.has(k)) rels.set(k, { from, to, label: 'depends on' })
    }
  }
  const lines = ['C4Context', `  title ${q(opts.title ?? (opts.project ? `System context — ${opts.project}` : 'System context'))}`]
  if (!boxes.size) lines.push('  System(empty, "No systems or components in the catalog", "")')
  for (const b of [...boxes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`  ${b.ext ? 'System_Ext' : 'System'}(${b.id}, "${q(b.label)}", "${q(b.desc)}")`)
  }
  for (const r of [...rels.values()].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))) {
    lines.push(`  Rel(${boxes.get(r.from)!.id}, ${boxes.get(r.to)!.id}, "${q(r.label)}")`)
  }
  return lines.join('\n') + '\n'
}

/* ───────────────────────── C4 container ───────────────────────── */

export interface C4ContainerOptions extends C4Options {
  /** Draw one system's containers (ref); omitted = every system. */
  system?: string
}

/**
 * Container view: each System becomes a boundary holding its Components
 * (containers) and Resources (databases / queues); relations follow API
 * consumption (labelled with the API) and `dependsOn`.
 */
export function c4ContainerDiagram(entities: readonly PEntity[], opts: C4ContainerOptions = {}): string {
  const list = inProject(entities, opts.project)
  const byRef = new Map(list.map((e) => [refOf(e), e]))
  const focus = opts.system ? normalizeRef(opts.system, 'system') : undefined
  const members = list.filter((e) => (e.kind === 'Component' || e.kind === 'Resource') && (!focus || e.system === focus))
  const memberRefs = new Set(members.map(refOf))
  // Components / resources outside the focus that members talk to — drawn as external.
  const external = new Map<string, PEntity>()
  const providerOf = (api: string) => list.find((c) => c.kind === 'Component' && c.providesApis.includes(api))
  for (const m of members) {
    for (const api of m.consumesApis) {
      const p = providerOf(api)
      if (p && !memberRefs.has(refOf(p))) external.set(refOf(p), p)
    }
    for (const d of m.dependsOn) {
      const t = byRef.get(d)
      if (t && !memberRefs.has(d)) external.set(d, t)
    }
  }
  const idOf = (e: PEntity) => mid(e.kind === 'Resource' ? 'res' : 'cnt', e.name)
  const node = (e: PEntity, ext: boolean, indent: string) => {
    const t = (e.type ?? '').toLowerCase()
    const fn = DB_TYPES.has(t) ? 'ContainerDb' : QUEUE_TYPES.has(t) ? 'ContainerQueue' : 'Container'
    return `${indent}${fn}${ext ? '_Ext' : ''}(${idOf(e)}, "${q(label(e))}", "${q(e.type ?? e.kind.toLowerCase())}", "${q(e.description)}")`
  }
  const lines = ['C4Container']
  const sysTitle = focus ? byRef.get(focus)?.title ?? splitRef(focus).name : undefined
  lines.push(`  title ${q(opts.title ?? (sysTitle ? `Containers — ${sysTitle}` : opts.project ? `Containers — ${opts.project}` : 'Containers'))}`)
  const bySystem = new Map<string, PEntity[]>()
  const loose: PEntity[] = []
  for (const m of members) {
    if (m.system && byRef.has(m.system)) (bySystem.get(m.system) ?? bySystem.set(m.system, []).get(m.system)!).push(m)
    else loose.push(m)
  }
  if (!members.length) lines.push('  System(empty, "No components in the catalog for this selection", "")')
  for (const [sys, items] of [...bySystem.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = byRef.get(sys)!
    lines.push(`  System_Boundary(${mid('b', s.name)}, "${q(label(s))}") {`)
    for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) lines.push(node(it, false, '    '))
    lines.push('  }')
  }
  for (const it of loose.sort((a, b) => a.name.localeCompare(b.name))) lines.push(node(it, false, '  '))
  for (const it of [...external.values()].sort((a, b) => a.name.localeCompare(b.name))) lines.push(node(it, true, '  '))
  const drawn = new Set([...memberRefs, ...external.keys()])
  const rels: string[] = []
  for (const m of [...members].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const api of m.consumesApis) {
      const p = providerOf(api)
      if (!p || !drawn.has(refOf(p)) || refOf(p) === refOf(m)) continue
      const apiE = byRef.get(api)
      rels.push(`  Rel(${idOf(m)}, ${idOf(p)}, "${q(`calls ${apiE?.title ?? splitRef(api).name}`)}", "${q(apiE?.type ?? 'API')}")`)
    }
    for (const d of m.dependsOn) {
      const t = byRef.get(d)
      if (!t || !drawn.has(d)) continue
      const tt = (t.type ?? '').toLowerCase()
      rels.push(`  Rel(${idOf(m)}, ${idOf(t)}, "${DB_TYPES.has(tt) ? 'reads / writes' : QUEUE_TYPES.has(tt) ? 'publishes / consumes' : 'depends on'}")`)
    }
  }
  return [...lines, ...Array.from(new Set(rels))].join('\n') + '\n'
}

/* ───────────────────────── deployment ───────────────────────── */

export interface ArgoAppLite {
  name: string
  project?: string
  labels?: Record<string, string>
  namespace?: string
  sync?: string
  health?: string
}

export const ENV_KEYS = ['dev', 'development', 'test', 'qa', 'uat', 'staging', 'stage', 'stg', 'preview', 'canary', 'prod', 'production'] as const

export function envRank(env: string): number {
  const e = env.toLowerCase()
  if (e === 'dev' || e === 'development') return 0
  if (e === 'test' || e === 'qa') return 1
  if (e === 'uat' || e === 'preview' || e === 'canary') return 2
  if (e === 'staging' || e === 'stage' || e === 'stg') return 3
  if (e === 'prod' || e === 'production') return 5
  return 4
}

export function envTitle(env: string): string {
  const e = env.toLowerCase()
  if (e === 'dev' || e === 'development') return 'Development'
  if (e === 'test') return 'Test'
  if (e === 'qa') return 'QA'
  if (e === 'staging' || e === 'stage' || e === 'stg') return 'Staging'
  if (e === 'prod' || e === 'production') return 'Production'
  return env.charAt(0).toUpperCase() + env.slice(1)
}

export interface DeployedApp {
  argo: string
  project: string
  app: string
  env: string
  sync?: string
  health?: string
}

/**
 * Read `<project>-<app>-<env>` (and the labels the control plane stamps)
 * into project / app / environment. Labels win; the name is the fallback.
 * Apps that name no environment are not part of a promotion chain and are
 * left out (returns undefined).
 */
export function classifyArgoApp(a: ArgoAppLite): DeployedApp | undefined {
  const l = a.labels ?? {}
  const name = a.name.toLowerCase()
  let env = (l['adhar.io/environment'] ?? '').toLowerCase()
  if (!env) env = ENV_KEYS.find((k) => name.endsWith(`-${k}`)) ?? ''
  if (!env) return undefined
  let project = (l['adhar.io/project'] ?? '').toLowerCase()
  if (!project && a.project && a.project !== 'default') project = a.project.toLowerCase()
  let app = (l['adhar.io/application'] ?? '').toLowerCase()
  if (!app) {
    let rest = name.endsWith(`-${env}`) ? name.slice(0, -(env.length + 1)) : name
    if (project && rest.startsWith(`${project}-`)) rest = rest.slice(project.length + 1)
    app = rest
  }
  return { argo: a.name, project: project || 'unassigned', app, env, sync: a.sync, health: a.health }
}

export interface DeploymentOptions {
  title?: string
  project?: string
}

/**
 * Deployment view per environment: projects as outer groups, each holding
 * its environments in promotion order (dev → test → prod), each environment
 * holding the Argo CD applications deployed there with their live sync and
 * health. Dashed edges follow one app's promotion path.
 */
export function deploymentDiagram(apps: readonly ArgoAppLite[], opts: DeploymentOptions = {}): string {
  const deployed = apps.map(classifyArgoApp).filter((d): d is DeployedApp => !!d)
    .filter((d) => !opts.project || d.project === opts.project)
  const lines = ['flowchart LR']
  if (opts.title) lines.unshift(`---\ntitle: ${q(opts.title)}\n---`)
  if (!deployed.length) {
    lines.push('  empty["No Argo CD applications with an environment were found"]')
    return lines.join('\n') + '\n'
  }
  const projects = Array.from(new Set(deployed.map((d) => d.project))).sort()
  const cls = (h?: string) => {
    const s = (h ?? '').toLowerCase()
    return s === 'healthy' ? 'healthy' : s === 'degraded' || s === 'missing' ? 'degraded' : s === 'progressing' ? 'progressing' : 'unknown'
  }
  const nodeId = (d: DeployedApp) => mid('a', d.project, d.app, d.env)
  for (const p of projects) {
    const inP = deployed.filter((d) => d.project === p)
    lines.push(`  subgraph ${mid('p', p)}["Project · ${q(p)}"]`)
    lines.push('    direction LR')
    const envs = Array.from(new Set(inP.map((d) => d.env))).sort((a, b) => envRank(a) - envRank(b) || a.localeCompare(b))
    for (const env of envs) {
      lines.push(`    subgraph ${mid('e', p, env)}["${q(envTitle(env))}"]`)
      for (const d of inP.filter((x) => x.env === env).sort((a, b) => a.app.localeCompare(b.app))) {
        const status = [d.sync, d.health].filter(Boolean).join(' · ')
        lines.push(`      ${nodeId(d)}["${q(d.app)}${status ? `<br/><small>${q(status)}</small>` : ''}"]:::${cls(d.health)}`)
      }
      lines.push('    end')
    }
    lines.push('  end')
  }
  // Promotion edges: an app's consecutive environments.
  const byApp = new Map<string, DeployedApp[]>()
  for (const d of deployed) {
    const k = `${d.project}/${d.app}`
    ;(byApp.get(k) ?? byApp.set(k, []).get(k)!).push(d)
  }
  for (const k of [...byApp.keys()].sort()) {
    const chain = byApp.get(k)!.sort((a, b) => envRank(a.env) - envRank(b.env) || a.env.localeCompare(b.env))
    for (let i = 1; i < chain.length; i++) lines.push(`  ${nodeId(chain[i - 1])} -.-> ${nodeId(chain[i])}`)
  }
  lines.push(
    '  classDef healthy fill:#ecfdf5,stroke:#10b981,color:#064e3b',
    '  classDef degraded fill:#fff1f2,stroke:#f43f5e,color:#881337',
    '  classDef progressing fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a',
    '  classDef unknown fill:#f8fafc,stroke:#94a3b8,color:#334155',
  )
  return lines.join('\n') + '\n'
}

/* ───────────────────────── tenancy ───────────────────────── */

export interface TenancyInput {
  org: { slug: string; name?: string }
  teams: { slug: string; name?: string }[]
  projects: { slug: string; name?: string; teams?: string[] }[]
  /** Apps with their project. */
  apps: { name: string; project?: string }[]
}

/** Organisation → Teams → Projects → Apps. */
export function tenancyDiagram(t: TenancyInput, opts: { title?: string } = {}): string {
  const lines = ['flowchart TD']
  if (opts.title) lines.unshift(`---\ntitle: ${q(opts.title)}\n---`)
  const org = mid('org', t.org.slug || 'org')
  lines.push(`  ${org}["Organisation · ${q(t.org.name || t.org.slug || 'organisation')}"]:::org`)
  const teamSlugs = new Set(t.teams.map((x) => x.slug))
  for (const team of [...t.teams].sort((a, b) => a.slug.localeCompare(b.slug))) {
    lines.push(`  ${mid('t', team.slug)}["Team · ${q(team.name || team.slug)}"]:::team`)
    lines.push(`  ${org} --> ${mid('t', team.slug)}`)
  }
  for (const p of [...t.projects].sort((a, b) => a.slug.localeCompare(b.slug))) {
    lines.push(`  ${mid('p', p.slug)}["Project · ${q(p.name || p.slug)}"]:::project`)
    const owners = (p.teams ?? []).filter((s) => teamSlugs.has(s))
    if (owners.length) for (const s of owners.sort()) lines.push(`  ${mid('t', s)} --> ${mid('p', p.slug)}`)
    else lines.push(`  ${org} --> ${mid('p', p.slug)}`)
  }
  const known = new Set(t.projects.map((p) => p.slug))
  const seen = new Set<string>()
  for (const a of [...t.apps].sort((x, y) => x.name.localeCompare(y.name))) {
    const key = `${a.project ?? ''}/${a.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const id = mid('a', a.project ?? 'none', a.name)
    lines.push(`  ${id}["App · ${q(a.name)}"]:::app`)
    if (a.project && known.has(a.project)) lines.push(`  ${mid('p', a.project)} --> ${id}`)
    else lines.push(`  ${org} -.-> ${id}`)
  }
  lines.push(
    '  classDef org fill:#eef2ff,stroke:#6366f1,color:#312e81',
    '  classDef team fill:#f5f3ff,stroke:#8b5cf6,color:#4c1d95',
    '  classDef project fill:#ecfeff,stroke:#06b6d4,color:#164e63',
    '  classDef app fill:#f8fafc,stroke:#94a3b8,color:#334155',
  )
  return lines.join('\n') + '\n'
}

/* ───────────────────────── regenerate diff ───────────────────────── */

export interface DiffLine {
  op: ' ' | '+' | '-'
  text: string
}

/** Line diff (LCS) — diagrams are small, so O(n·m) is fine. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\s+$/, '').split('\n')
  const b = after.replace(/\s+$/, '').split('\n')
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] })
    else out.push({ op: '+', text: b[j++] })
  }
  while (i < n) out.push({ op: '-', text: a[i++] })
  while (j < m) out.push({ op: '+', text: b[j++] })
  return out
}

export function diffStats(d: DiffLine[]): { added: number; removed: number } {
  return { added: d.filter((x) => x.op === '+').length, removed: d.filter((x) => x.op === '-').length }
}

/* ───────────────────────── generated diagrams ───────────────────────── */

export type GeneratorKind = 'c4-context' | 'c4-container' | 'deployment' | 'tenancy'

export interface GeneratorParams {
  project?: string
  system?: string
}

/** Stored on a generated diagram so it can be regenerated and diffed. */
export interface GeneratorInfo {
  kind: GeneratorKind
  params: GeneratorParams
  /** When the source was last (re)generated. */
  at: string
  /** The source exactly as last generated — tells hand edits from platform drift. */
  output: string
}

export interface PlatformSnapshot {
  entities: readonly PEntity[]
  argoApps: readonly ArgoAppLite[]
  tenancy: TenancyInput
}

export const GENERATOR_LABEL: Record<GeneratorKind, string> = {
  'c4-context': 'C4 system context',
  'c4-container': 'C4 containers',
  deployment: 'Deployment by environment',
  tenancy: 'Tenancy',
}

export function generatorTitle(kind: GeneratorKind, p: GeneratorParams, entities: readonly PEntity[] = []): string {
  const sys = p.system ? entities.find((e) => refOf(e) === normalizeRef(p.system!, 'system'))?.title ?? splitRef(p.system).name : undefined
  const scope = [sys, p.project].filter(Boolean).join(' · ')
  return scope ? `${GENERATOR_LABEL[kind]} — ${scope}` : GENERATOR_LABEL[kind]
}

/** Mermaid source for a generator over a platform snapshot. Deterministic. */
export function generateDiagram(kind: GeneratorKind, p: GeneratorParams, data: PlatformSnapshot): string {
  switch (kind) {
    case 'c4-context':
      return c4ContextDiagram(data.entities, { project: p.project })
    case 'c4-container':
      return c4ContainerDiagram(data.entities, { project: p.project, system: p.system })
    case 'deployment':
      return deploymentDiagram(data.argoApps, { project: p.project })
    case 'tenancy': {
      const t = data.tenancy
      if (!p.project) return tenancyDiagram(t)
      const proj = t.projects.filter((x) => x.slug === p.project)
      const teams = t.teams.filter((x) => proj.some((pp) => (pp.teams ?? []).includes(x.slug)))
      return tenancyDiagram({ org: t.org, teams, projects: proj, apps: t.apps.filter((a) => a.project === p.project) })
    }
  }
}

/** Apps per project for the tenancy view: Application XRs plus Argo CD environments. */
export function tenancyApps(entities: readonly PEntity[], argoApps: readonly ArgoAppLite[]): { name: string; project?: string }[] {
  const out = new Map<string, { name: string; project?: string }>()
  for (const e of entities) if (e.kind === 'Component' && e.origin !== 'repo' && e.project) out.set(`${e.project}/${e.name}`, { name: e.name, project: e.project })
  for (const a of argoApps) {
    const d = classifyArgoApp(a)
    if (d && d.project !== 'unassigned') out.set(`${d.project}/${d.app}`, { name: d.app, project: d.project })
  }
  return [...out.values()]
}
