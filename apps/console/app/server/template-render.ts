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

/** Parse a Backstage RepoUrlPicker value (`host?owner=X&repo=Y`). */
export function parseRepoUrl(url: string): { host: string; owner: string; repo: string } {
  const s = String(url ?? '')
  const [host, query = ''] = s.split('?')
  const q = new URLSearchParams(query)
  return {
    host,
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
  // bare `X | lower` / `X | upper` (supported since they are trivial)
  const filt = e.match(/^(.+?)\s*\|\s*(lower|upper)$/)
  if (filt) {
    const v = String(getByPath(ctx, filt[1].trim()) ?? '')
    return filt[2] === 'lower' ? v.toLowerCase() : v.toUpperCase()
  }
  return getByPath(ctx, e)
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
