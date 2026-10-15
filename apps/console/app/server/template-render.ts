/**
 * Backstage skeleton renderer — the subset of the `fetch:template` templating
 * the platform's 9 Software Templates actually use, implemented dependency-free.
 *
 * The skeletons (verified against the live `adhar/adhar-templates`) use exactly:
 *   - `${{ values.<key> }}` substitutions,
 *   - `{% if values.<key> %}…{% else %}…{% endif %}` conditionals, including the
 *     whitespace-trimming `{%- … %}` variant, and
 *   - a `fetch:template` step whose `input.values` map derives the render
 *     context from `parameters` — including `${{ parameters.name }}.suffix`
 *     concatenation and `${{ (parameters.repoUrl | parseRepoUrl).owner }}`.
 *
 * This module renders content strings and computes that values context. It is
 * intentionally NOT a general Nunjucks engine.
 */

import type { YamlValue } from './yaml-lite.ts'

export type Ctx = Record<string, unknown>

/**
 * Parse a Backstage RepoUrlPicker value (`host?owner=X&repo=Y`).
 *
 * `host` is returned BARE — no scheme, no trailing slash — because that is
 * what the field means and what every skeleton assumes. They add the scheme
 * themselves:
 *
 *     const REPO_URL = 'https://${{ values.giteaHost }}/...'
 *
 * This used to hand back everything before the `?` verbatim, so a picker value
 * carrying a scheme produced a doubled one. Live on 2026-10-13 every
 * scaffolded app was created with
 *
 *     const REPO_URL = 'https://https://gitea.platform.adhar.io/adhar/reactapp'
 *
 * which is a URL nothing can fetch, in the docs link and the repo link of
 * every generated app.
 */
export function parseRepoUrl(url: string): { host: string; owner: string; repo: string } {
  const s = String(url ?? '')
  const [rawHost, query = ''] = s.split('?')
  const q = new URLSearchParams(query)
  return {
    host: rawHost.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/\/+$/, ''),
    owner: q.get('owner') ?? '',
    repo: (q.get('repo') ?? '').replace(/\.git$/, ''),
  }
}

/** Resolve a dotted path (`values.name`, `parameters.port`) against a context. */
function getByPath(ctx: Ctx, path: string): unknown {
  const parts = path.split('.').map((p) => p.trim())
  let cur: unknown = ctx
  // Allow a bare key to resolve against `values` when present.
  if (parts.length === 1 && !(parts[0] in ctx) && ctx.values && typeof ctx.values === 'object') {
    cur = ctx.values
  }
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

/** Evaluate a single `${{ … }}` expression body against the context. */
function evalExpr(expr: string, ctx: Ctx): unknown {
  const e = expr.trim()
  // (parameters.repoUrl | parseRepoUrl).field
  const piped = e.match(/^\(\s*(.+?)\s*\|\s*parseRepoUrl\s*\)\.(\w+)$/)
  if (piped) {
    const src = getByPath(ctx, piped[1])
    const parsed = parseRepoUrl(String(src ?? ''))
    return (parsed as Record<string, string>)[piped[2]] ?? ''
  }
  // `X or Y` — Nunjucks's default-value idiom, which every shipped template
  // uses for optional parameters: `${{ parameters.kafkaTopic or 'events' }}`.
  // Left-hand side is a path; right-hand side is a quoted string, a number,
  // true/false, or another path. Falsy LHS (undefined, '', null, false, 0)
  // takes the default, exactly as Nunjucks does.
  //
  // Live on 2026-10-14 this fell through to a path lookup of the whole
  // expression and rendered EMPTY, so the Spring Boot skeleton shipped
  // `name:` with no topic and `app.kafka.topic=` with no value. The Messaging
  // XR then tried to compose `topic-<no value>` — an invalid name, which fails
  // the WHOLE XR — so no Kafka cluster was ever created and the service died
  // at startup on "No resolvable bootstrap urls". Nothing reported a template
  // problem; it looked like a Kafka outage.
  // `( … ) | filter` — a grouped expression piped to a filter, which Nunjucks
  // needs because a filter binds tighter than `or`:
  //
  //    ${{ (values.description or 'A React single-page app…') | dump }}
  //
  // Checked BEFORE `or`, and evaluated inside-out. Live on 2026-10-15 the
  // `or` branch matched first, took `(values.description` as its left-hand
  // side and threw — so the scaffolder dropped App.jsx and app.component.ts
  // from every new SPA (a file that fails to render is skipped) and the build
  // died on `Could not resolve "./app/app.component"`, which reads like a
  // broken template rather than a renderer that cannot parse one line of it.
  const grouped = e.match(/^\(\s*(.+)\s*\)\s*\|\s*(lower|upper|dump|escape)$/)
  if (grouped) return applyFilter(grouped[2], evalExpr(grouped[1], ctx))
  const orExpr = e.match(/^(.+?)\s+or\s+(.+)$/)
  if (orExpr) {
    const lhs = evalExpr(orExpr[1], ctx)
    if (lhs !== undefined && lhs !== null && lhs !== '' && lhs !== false && lhs !== 0) return lhs
    return evalLiteralOrPath(orExpr[2].trim(), ctx)
  }
  // bare `X | lower` / `X | upper` / `X | dump` / `X | escape`
  const filt = e.match(/^(.+?)\s*\|\s*(lower|upper|dump|escape)$/)
  if (filt) return applyFilter(filt[2], getByPath(ctx, filt[1].trim()))
  // An expression carrying a filter we do not implement must NOT fall through
  // to a path lookup. `getByPath(ctx, "values.name | dump")` matches nothing,
  // returns undefined and stringifies to "", so the renderer silently emits
  // broken output instead of reporting that it could not render.
  //
  // Live on 2026-10-13: the react-spa-app skeleton uses `| dump` for three
  // values, and every scaffolded app was created with
  //
  //    const APP_NAME =
  //    const DESCRIPTION =
  //    const OWNER =
  //
  // which fails the build at `vite build` with `Unexpected "const"` — a
  // scaffolding fault that reads like a broken template or a bad dependency.
  if (/[|()]|\s(and|if|else|not|in)\s|[~+]/.test(e)) {
    throw new Error(
      `template expression ${JSON.stringify(e)} uses syntax this renderer does not implement; ` +
        `supported: lower, upper, dump, escape, (x | parseRepoUrl).field, x or <default>`,
    )
  }
  return getByPath(ctx, e)
}

/** A quoted string, number, boolean, or a context path — the right side of `or`. */
function evalLiteralOrPath(raw: string, ctx: Ctx): unknown {
  const str = raw.match(/^'(.*)'$|^"(.*)"$/)
  if (str) return str[1] ?? str[2] ?? ''
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null' || raw === 'none') return null
  return evalExpr(raw, ctx)
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/**
 * Interpolate a value-map RHS. A lone `${{ … }}` returns the *typed* value
 * (so `port: ${{ parameters.port }}` stays a number and `withDatabase` a
 * boolean); any surrounding literal text forces string interpolation.
 */
function interpolateValue(raw: string, ctx: Ctx): unknown {
  const lone = raw.match(/^\$\{\{\s*([\s\S]+?)\s*\}\}$/)
  if (lone) return evalExpr(lone[1], ctx)
  return raw.replace(/\$\{\{\s*([\s\S]+?)\s*\}\}/g, (_, ex: string) => stringify(evalExpr(ex, ctx)))
}

/** Find the `fetch:template` step in a parsed Template document. */
function fetchTemplateStep(doc: YamlValue): Record<string, YamlValue> | null {
  const steps = (doc as { spec?: { steps?: YamlValue } })?.spec?.steps
  if (!Array.isArray(steps)) return null
  for (const s of steps) {
    if (s && typeof s === 'object' && (s as Record<string, unknown>).action === 'fetch:template') {
      return s as Record<string, YamlValue>
    }
  }
  return null
}

/** Directory the skeleton lives in, relative to the template dir (default `skeleton`). */
export function skeletonDir(doc: YamlValue): string {
  const step = fetchTemplateStep(doc)
  const url = step?.input && typeof step.input === 'object'
    ? (step.input as Record<string, unknown>).url
    : undefined
  const rel = typeof url === 'string' ? url : './skeleton'
  return rel.replace(/^\.\//, '').replace(/\/$/, '')
}

/**
 * Compute the `values` render context from the template's `fetch:template`
 * step, evaluating each mapping against the caller-supplied `parameters`.
 * Falls back to the raw parameters when the step/map is absent.
 */
export function computeValues(doc: YamlValue, parameters: Ctx): Record<string, unknown> {
  const ctx: Ctx = { parameters }
  const step = fetchTemplateStep(doc)
  const map = step?.input && typeof step.input === 'object'
    ? (step.input as Record<string, unknown>).values
    : undefined
  const values: Record<string, unknown> = {}
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      values[k] = typeof v === 'string' ? interpolateValue(v, ctx) : v
    }
    return values
  }
  return { ...parameters }
}

/** Truthiness with YAML/string quirks handled (`"false"`, `"0"`, `""` ⇒ false). */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false
  if (v === 0) return false
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return !(s === '' || s === 'false' || s === '0' || s === 'no')
  }
  return Boolean(v)
}

/** Evaluate an `{% if … %}` condition (supports `not`, `==`, `!=`, plain path). */
function evalCondition(cond: string, ctx: Ctx): boolean {
  let c = cond.trim()
  let negate = false
  if (c.startsWith('not ')) {
    negate = true
    c = c.slice(4).trim()
  }
  const cmp = c.match(/^(.+?)\s*(==|!=)\s*(.+)$/)
  if (cmp) {
    const left = getByPath(ctx, cmp[1].trim())
    const rightRaw = cmp[3].trim().replace(/^['"]|['"]$/g, '')
    const eq = stringify(left) === rightRaw
    const res = cmp[2] === '==' ? eq : !eq
    return negate ? !res : res
  }
  const res = truthy(getByPath(ctx, c))
  return negate ? !res : res
}

/**
 * Render a skeleton file's content: resolve `{% if %}` conditionals then
 * substitute `${{ … }}` placeholders. `values` is the render context; the same
 * value object is exposed under both `values.*` and bare keys.
 */
export function renderContent(src: string, values: Record<string, unknown>): string {
  const ctx: Ctx = { values, ...values }

  // 1. Apply whitespace-control trim markers, then normalise dashes off tags.
  let s = src
    .replace(/[ \t]*\r?\n?[ \t]*\{%-/g, '{%')
    .replace(/\{%-/g, '{%')
    .replace(/-%\}[ \t]*\r?\n?/g, '%}')
    .replace(/-%\}/g, '%}')

  // 2. Resolve if/else/endif, innermost-first so nesting is handled.
  const ifRe =
    /\{%\s*if\s+([\s\S]+?)\s*%\}((?:(?!\{%\s*(?:if|else|endif)\b)[\s\S])*?)(?:\{%\s*else\s*%\}((?:(?!\{%\s*(?:if|else|endif)\b)[\s\S])*?))?\{%\s*endif\s*%\}/
  let guard = 0
  while (ifRe.test(s)) {
    s = s.replace(ifRe, (_m, cond: string, body: string, elseBody = '') =>
      evalCondition(cond, ctx) ? body : elseBody,
    )
    if (++guard > 1000) break
  }

  // 3. Substitute placeholders.
  s = s.replace(/\$\{\{\s*([\s\S]+?)\s*\}\}/g, (_, ex: string) => stringify(evalExpr(ex, ctx)))
  return s
}

/** Render placeholders that appear in a file PATH (defensive; skeletons rarely do). */
export function renderPath(path: string, values: Record<string, unknown>): string {
  const ctx: Ctx = { values, ...values }
  return path.replace(/\$\{\{\s*([\s\S]+?)\s*\}\}/g, (_, ex: string) => stringify(evalExpr(ex, ctx)))
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The four filters the subset implements, applied to an already-evaluated value. */
function applyFilter(name: string, src: unknown): unknown {
  // `dump` is JSON encoding, and the skeletons depend on it for anything
  // dropped into source code: `const APP_NAME = ${{ values.name | dump }}`
  // needs the QUOTES, so an unquoted or empty substitution is not a cosmetic
  // problem — it is a syntax error in the generated file.
  if (name === 'dump') return JSON.stringify(src ?? null)
  const v = String(src ?? '')
  // `escape` is HTML escaping: the SPA skeletons drop the description into
  // `<meta content="${{ values.description | escape }}">`, where a quote ends
  // the attribute and `<` opens a tag.
  if (name === 'escape') return escapeHtml(v)
  return name === 'lower' ? v.toLowerCase() : v.toUpperCase()
}
