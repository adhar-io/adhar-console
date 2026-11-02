/**
 * An entity's links, made fit for a row of buttons — once, where the list
 * enters the page (`publicizeEntity` in the catalog route).
 *
 * Links reach an entity from three places that do not know about each other:
 * annotations on the live workload (`Source`, `Docs`, …), the Gitea repo the
 * workload was matched to (`Source`), and the repo's `catalog-info.yaml`
 * (`Repo URL`, anything the team wrote). Merged by exact URL, the same
 * repository showed up twice (`…/shop` and `…/shop.git`, `http` vs `https`),
 * template skeletons leaked their placeholders and laptop defaults
 * (`https://adhar.localtest.me:8443/gitea`), and links still named the domain
 * the platform used to live on. Every one of those rendered as a button in the
 * drawer header that went nowhere.
 *
 * Pure — no React, no config reads — so the rules are unit-tested.
 */
import type { Link } from './catalog.ts'
import { isSafeLinkUrl } from './safe-url.ts'

export interface TidyLinksOptions {
  /** Rewrites an in-cluster host to the tool's public URL (`usePublicUrl`). */
  pub?: (url: string) => string
  /** The platform's public base domain (`cloud.adhar.io`); '' when unknown. */
  baseDomain?: string
  /**
   * Which platform tool a hostname's first label names (`gitea` → `gitea`),
   * `toolForInternalHost` from shell-ui. Used to move a link off a domain the
   * platform no longer serves.
   */
  toolFor?: (host: string) => string | undefined
}

type Icon = NonNullable<Link['icon']>

/** Icons a hand-written `catalog-info.yaml` uses, folded onto the ones the console draws. */
const ICON_ALIASES: Record<string, Icon> = {
  docs: 'docs',
  doc: 'docs',
  documentation: 'docs',
  book: 'docs',
  techdocs: 'docs',
  dashboard: 'dashboard',
  grafana: 'dashboard',
  monitor: 'dashboard',
  monitoring: 'dashboard',
  metrics: 'dashboard',
  repo: 'repo',
  repository: 'repo',
  git: 'repo',
  github: 'repo',
  gitlab: 'repo',
  gitea: 'repo',
  source: 'repo',
  code: 'repo',
  runbook: 'runbook',
  chat: 'chat',
  slack: 'chat',
  'on-call': 'on-call',
  oncall: 'on-call',
  pagerduty: 'on-call',
}

/** Titles that say "the repository" and nothing more: two of these are one link. */
const GENERIC_REPO_TITLES = new Set([
  'source',
  'source code',
  'code',
  'repo',
  'repo url',
  'repository',
  'repository url',
  'git',
  'git repo',
  'gitea',
  'github',
  'gitlab',
])

/** Titles the console made up itself; a person's own title beats them. */
const DEFAULT_TITLES = new Set(['source', 'docs', 'dashboard', 'runbook'])

export function normalizeLinkIcon(icon: string | undefined): Icon | undefined {
  if (!icon) return undefined
  return ICON_ALIASES[icon.trim().toLowerCase()]
}

/** A value still carrying a template placeholder (`${{ values.name }}`, `{{ .Name }}`, `<no value>`). */
export function hasTemplatePlaceholder(url: string): boolean {
  return /\$\{\{|\{\{|\}\}|%7B%7B|%7D%7D|<no value>/i.test(url)
}

/** Hosts that only ever resolve on a laptop install. */
function isLaptopHost(host: string): boolean {
  const h = host.split(':')[0].toLowerCase()
  return h === 'localtest.me' || h.endsWith('.localtest.me') || h === 'localhost' || h.endsWith('.localhost') ||
    h === '127.0.0.1'
}

function lastLabels(host: string, n: number): string {
  return host.split('.').slice(-n).join('.')
}

/**
 * Make one URL openable, or say it cannot be (`null`).
 *
 * - refuses non-web schemes, unparsable absolute URLs and template placeholders;
 * - rewrites an in-cluster host through `pub`;
 * - moves `<tool>.<old base>` to `<tool>.<base>` when the old base is a sibling
 *   of the current one (`gitea.dev.adhar.io` → `gitea.cloud.adhar.io`) — the
 *   platform moved, the repository did not;
 * - on a real install, rewrites a laptop default with a tool path
 *   (`https://adhar.localtest.me:8443/gitea/org/repo`) to the public tool host,
 *   and drops it when it names no tool.
 *
 * Same-origin paths (`/catalog?entity=…`) and `mailto:` pass through.
 */
export function repairLinkUrl(raw: string, opts: TidyLinksOptions = {}): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!isSafeLinkUrl(trimmed) || hasTemplatePlaceholder(trimmed)) return null
  if (!/^https?:/i.test(trimmed)) return trimmed
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (!u.hostname) return null
  const base = (opts.baseDomain ?? '').trim().toLowerCase().replace(/:\d+$/, '')
  const host = u.hostname.toLowerCase()

  if (isLaptopHost(host) && base && !isLaptopHost(base)) {
    // `adhar.localtest.me:8443/gitea/org/repo` → `gitea.<base>/org/repo`
    const [, first, ...rest] = u.pathname.split('/')
    const tool = first ? opts.toolFor?.(first) : undefined
    if (tool && rest.join('/')) {
      return `https://${tool}.${base}/${rest.join('/')}${u.search}${u.hash}`
    }
    const sub = host.split('.')[0]
    const hostTool = !host.startsWith('adhar.') ? opts.toolFor?.(sub) : undefined
    if (hostTool && u.pathname.length > 1) {
      return `https://${hostTool}.${base}${u.pathname}${u.search}${u.hash}`
    }
    return null
  }

  const viaPub = opts.pub ? opts.pub(trimmed) : trimmed
  if (viaPub !== trimmed) return viaPub

  if (base && host !== base && !host.endsWith(`.${base}`)) {
    const labels = host.split('.')
    const rest = labels.slice(1).join('.')
    const tool = opts.toolFor?.(labels[0])
    // Only a sibling of the current base (same registrable domain, at least
    // two labels): `gitea.com` or `grafana.example.org` are somebody else's.
    if (tool && rest.split('.').length >= 2 && lastLabels(rest, 2) === lastLabels(base, 2) && labels[0] === tool) {
      return `${u.protocol}//${tool}.${base}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}${u.hash}`
    }
  }
  return trimmed
}

/**
 * The identity of a link for de-duplication: scheme-, case-, `www.`-, default
 * port-, trailing-slash- and `.git`-insensitive. Not for display.
 */
export function canonicalLinkKey(url: string): string {
  const t = url.trim()
  if (!/^https?:/i.test(t)) return t.toLowerCase()
  try {
    const u = new URL(t)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : ''
    const path = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
    return `${host}${port}${path}${u.search}${u.hash}`
  } catch {
    return t.toLowerCase()
  }
}

/** `gitea.cloud.adhar.io/acme/shop` — a title for a link that was given none. */
function titleFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.host}${path}`
  } catch {
    return url
  }
}

function isRepoRoot(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === ''
  } catch {
    return false
  }
}

/**
 * Repair, normalise and de-duplicate an entity's links. Order is kept (the
 * first occurrence holds its place); a person-written title replaces a
 * console default on a duplicate. Returns the input array itself when nothing
 * changed, so memoised consumers keep their identity.
 */
export function tidyLinks(links: readonly Link[] | undefined, opts: TidyLinksOptions = {}): Link[] {
  const input = links ?? []
  const out: Link[] = []
  const byKey = new Map<string, number>()
  let repoIndex = -1

  for (const l of input) {
    if (!l || typeof l.url !== 'string') continue
    const url = repairLinkUrl(l.url, opts)
    if (!url) continue
    const icon = normalizeLinkIcon(l.icon as string | undefined)
    const rawTitle = typeof l.title === 'string' ? l.title.trim() : ''
    const isRepo = icon === 'repo'
    // A repository link to a host's front page is not a repository.
    if (isRepo && /^https?:/i.test(url) && isRepoRoot(url)) continue
    // Show the repository itself, not its clone URL.
    const shown = isRepo && /^https?:/i.test(url) ? url.replace(/\.git(\/?)(?=$|[?#])/i, '$1').replace(/\/+(?=$|[?#])/, '') : url
    const title = !rawTitle || rawTitle === l.url || rawTitle === url ? titleFromUrl(shown) : rawTitle
    const next: Link = { url: shown, title, ...(icon ? { icon } : {}) }

    const key = canonicalLinkKey(shown)
    const seen = byKey.get(key)
    // One "the repository" button: a second generically-titled repo link to
    // a different address is a stale or template copy of the first.
    const dupRepo = isRepo && repoIndex >= 0 && GENERIC_REPO_TITLES.has(title.toLowerCase()) &&
      GENERIC_REPO_TITLES.has(out[repoIndex].title.toLowerCase())
    const target = seen ?? (dupRepo ? repoIndex : undefined)
    if (target !== undefined) {
      const kept = out[target]
      const better = DEFAULT_TITLES.has(kept.title.toLowerCase()) && !DEFAULT_TITLES.has(title.toLowerCase()) &&
        !GENERIC_REPO_TITLES.has(title.toLowerCase())
      out[target] = {
        ...kept,
        ...(better ? { title } : {}),
        ...(!kept.icon && icon ? { icon } : {}),
      }
      continue
    }
    byKey.set(key, out.length)
    if (isRepo && repoIndex < 0) repoIndex = out.length
    out.push(next)
  }

  const same = out.length === input.length &&
    out.every((l, i) => l.url === input[i].url && l.title === input[i].title && l.icon === input[i].icon)
  return same ? (input as Link[]) : out
}

/**
 * Whether a browser outside the cluster can open this URL: an absolute
 * http(s) URL whose host is a public name, not a Service (`shop.apps.svc`),
 * `*.cluster.local`, a bare name or loopback.
 */
export function isBrowsableUrl(url: string): boolean {
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    host = u.hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host || !host.includes('.')) return false
  return !(host.endsWith('.svc') || host.endsWith('.cluster.local') || host.endsWith('.local') || host === '127.0.0.1')
}
