/**
 * Pure design-token logic for the Design Tokens page (and any other surface
 * that wants to read the workspace token set, e.g. the Visual Builder):
 *
 *   • colour parsing + WCAG 2.x contrast maths
 *   • defaults merging (stored documents may predate newer fields)
 *   • export: W3C Design Tokens (DTCG) JSON, CSS custom properties,
 *     Tailwind v4 `@theme`, Tailwind v3 config, legacy flat JSON
 *   • import: DTCG JSON (ours or third-party), legacy flat JSON, CSS variables
 *   • type-scale generation and set diffing (for the History tab)
 *
 * Framework-free — no React, no DOM — so it is unit-tested directly.
 */

import type {
  BreakpointToken,
  ColorToken,
  MotionToken,
  TokenSet,
  ValueToken,
} from './types.ts'
import { DEFAULT_TOKENS } from './tokens-seed.ts'

export type TokenCategory = keyof TokenSet
export type Mode = 'light' | 'dark'

export const CATEGORIES: readonly TokenCategory[] = [
  'color',
  'typography',
  'spacing',
  'radius',
  'elevation',
  'motion',
  'breakpoint',
]

export const CATEGORY_LABEL: Record<TokenCategory, string> = {
  color: 'Color',
  typography: 'Typography',
  spacing: 'Spacing',
  radius: 'Radius',
  elevation: 'Shadows',
  motion: 'Motion',
  breakpoint: 'Breakpoints',
}

/** The CSS-variable prefix each category's new tokens get. */
export const CATEGORY_PREFIX: Record<TokenCategory, string> = {
  color: '--adhar-color-',
  typography: '--adhar-text-',
  spacing: '--adhar-space-',
  radius: '--adhar-radius-',
  elevation: '--adhar-shadow-',
  motion: '--adhar-duration-',
  breakpoint: '--adhar-bp-',
}

/* ───────────────────────────── colour ───────────────────────────── */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NAMED: Record<string, Rgba> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function channel(raw: string): number {
  const s = raw.trim()
  if (s.endsWith('%')) return clamp((parseFloat(s) / 100) * 255, 0, 255)
  return clamp(parseFloat(s), 0, 255)
}

function alpha(raw: string | undefined): number {
  if (raw === undefined) return 1
  const s = raw.trim()
  if (s.endsWith('%')) return clamp(parseFloat(s) / 100, 0, 1)
  return clamp(parseFloat(s), 0, 1)
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255]
}

/** Parse `#rgb[a]`, `#rrggbb[aa]`, `rgb[a](…)`, `hsl[a](…)` or white/black/transparent. */
export function parseColor(input: string | undefined | null): Rgba | null {
  if (!input) return null
  const s = input.trim().toLowerCase()
  if (NAMED[s]) return { ...NAMED[s] }
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    }
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s)
  if (!fn) return null
  const parts = fn[2].replace(/\s*\/\s*/, ',').split(/[\s,]+/).filter(Boolean)
  if (parts.length < 3) return null
  if (fn[1].startsWith('rgb')) {
    const [r, g, b, a] = parts
    const out = { r: channel(r), g: channel(g), b: channel(b), a: alpha(a) }
    return [out.r, out.g, out.b, out.a].every(Number.isFinite) ? out : null
  }
  const h = parseFloat(parts[0])
  const sat = clamp(parseFloat(parts[1]) / 100, 0, 1)
  const lig = clamp(parseFloat(parts[2]) / 100, 0, 1)
  if (![h, sat, lig].every(Number.isFinite)) return null
  const [r, g, b] = hslToRgb(h, sat, lig)
  return { r, g, b, a: alpha(parts[3]) }
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')

/** `#rrggbb`, or `#rrggbbaa` when translucent. */
export function toHex(c: Rgba): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
  return c.a < 1 ? `${base}${hex2(c.a * 255)}` : base
}

/** A value an `<input type="color">` accepts (`#rrggbb`), with a safe fallback. */
export function toInputColor(value: string | undefined, fallback = '#000000'): string {
  const c = parseColor(value)
  return c ? toHex({ ...c, a: 1 }) : fallback
}

/** Alpha-composite `fg` over an opaque `bg`. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  }
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/**
 * WCAG contrast ratio (1…21) of `fg` on `bg`. A translucent background is
 * first composited over white; a translucent foreground over the background.
 * `null` when either colour can't be parsed.
 */
export function contrastRatio(fg: string, bg: string): number | null {
  const b0 = parseColor(bg)
  const f0 = parseColor(fg)
  if (!b0 || !f0) return null
  const b = b0.a < 1 ? composite(b0, NAMED.white) : b0
  const f = f0.a < 1 ? composite(f0, b) : f0
  const l1 = relativeLuminance(f)
  const l2 = relativeLuminance(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

export type WcagLevel = 'AAA' | 'AA' | 'AA Large' | 'Fail'

export interface WcagResult {
  ratio: number
  /** Normal text ≥ 4.5:1. */
  aa: boolean
  /** Normal text ≥ 7:1. */
  aaa: boolean
  /** Large text (≥ 18.66px bold / 24px) and UI components ≥ 3:1. */
  aaLarge: boolean
  level: WcagLevel
}

/** Rate a ratio against WCAG 2.x thresholds (ratio is rounded down to 2dp, as checkers do). */
export function wcag(ratio: number): WcagResult {
  const r = Math.floor(ratio * 100) / 100
  const aaa = r >= 7
  const aa = r >= 4.5
  const aaLarge = r >= 3
  return { ratio: r, aa, aaa, aaLarge, level: aaa ? 'AAA' : aa ? 'AA' : aaLarge ? 'AA Large' : 'Fail' }
}

/** Black or white — whichever reads better on `bg`. */
export function readableOn(bg: string): '#000000' | '#ffffff' {
  const black = contrastRatio('#000000', bg) ?? 0
  const white = contrastRatio('#ffffff', bg) ?? 0
  return black >= white ? '#000000' : '#ffffff'
}

/* ───────────────────────────── set helpers ───────────────────────────── */

/**
 * Fill any category a stored document lacks (or holds a non-array for) from
 * the defaults. Individual tokens are never injected into a stored category —
 * a user who deleted a token keeps it deleted.
 */
export function mergeDefaults(stored: Partial<TokenSet> | null | undefined): TokenSet {
  const out = {} as TokenSet
  for (const c of CATEGORIES) {
    const v = stored?.[c]
    ;(out as unknown as Record<string, unknown>)[c] = Array.isArray(v) ? v : DEFAULT_TOKENS[c]
  }
  return out
}

export function countTokens(t: TokenSet): number {
  return CATEGORIES.reduce((n, c) => n + (t[c]?.length ?? 0), 0)
}

/** `--adhar-color-primary` → `primary`; `--brand-500` → `500`; `--x` → `x`. */
export function shortName(name: string): string {
  const bare = name.replace(/^--/, '').replace(/^adhar-/, '')
  const i = bare.indexOf('-')
  return i > 0 && i < bare.length - 1 ? bare.slice(i + 1) : bare
}

/** Slug for a CSS custom-property segment. */
export function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Is this typography token a font family (vs a size / line-height pair)? */
export function isFontFamily(t: ValueToken): boolean {
  return /-font-/.test(t.name) || !/^\s*[\d.]+(px|rem|em)/.test(t.value)
}

/** `16px / 24px` → `{ size: '16px', lineHeight: '24px' }`. */
export function parseTypeValue(v: string): { size: string; lineHeight?: string } | null {
  const m = /^\s*([\d.]+(?:px|rem|em)?)\s*(?:\/\s*([\d.]+(?:px|rem|em|%)?))?\s*$/.exec(v)
  if (!m) return null
  return { size: m[1], lineHeight: m[2] }
}

/** Colour value for a mode (dark falls back to the light value). */
export function colorValue(t: ColorToken, mode: Mode): string {
  return mode === 'dark' && t.dark ? t.dark : t.value
}

/** Find a colour by short name, trying several candidates in order. */
export function findColor(
  t: TokenSet,
  candidates: string[],
  mode: Mode,
  fallback: string,
): string {
  for (const c of candidates) {
    const hit = t.color.find((x) => shortName(x.name) === c)
    if (hit) return colorValue(hit, mode)
  }
  return fallback
}

/** Every token as `{ cssVar: value }` for one mode — for scoped inline previews. */
export function tokensToStyle(t: TokenSet, mode: Mode): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of t.color) out[c.name] = colorValue(c, mode)
  for (const c of [...t.spacing, ...t.typography, ...t.radius, ...t.elevation, ...t.breakpoint]) {
    out[c.name] = c.value
  }
  for (const m of t.motion) out[m.name] = m.value
  return out
}

/* ───────────────────────────── type scale ───────────────────────────── */

export const SCALE_RATIOS = [
  { value: 1.125, label: 'Major second · 1.125' },
  { value: 1.2, label: 'Minor third · 1.2' },
  { value: 1.25, label: 'Major third · 1.25' },
  { value: 1.333, label: 'Perfect fourth · 1.333' },
  { value: 1.5, label: 'Perfect fifth · 1.5' },
] as const

const SCALE_STEPS = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl']

/**
 * A modular type scale: `base` px at step `base`, multiplied/divided by
 * `ratio` per step, sizes rounded to whole px and line-heights to a 4px grid
 * (1.5× for body sizes, tightening to 1.2× for display sizes).
 */
export function modularScale(base: number, ratio: number, prefix = '--adhar-text-'): ValueToken[] {
  const baseIdx = SCALE_STEPS.indexOf('base')
  return SCALE_STEPS.map((step, i) => {
    const size = Math.round(base * Math.pow(ratio, i - baseIdx))
    const lhFactor = size <= 18 ? 1.5 : size <= 24 ? 1.35 : 1.2
    const lh = Math.max(size, Math.round((size * lhFactor) / 4) * 4)
    return { name: `${prefix}${step}`, value: `${size}px / ${lh}px` }
  })
}

/* ───────────────────────────── diff ───────────────────────────── */

export interface TokenDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

function flatten(t: TokenSet): Map<string, string> {
  const m = new Map<string, string>()
  for (const c of CATEGORIES) {
    for (const tok of t[c] ?? []) {
      const any = tok as ColorToken & MotionToken & BreakpointToken
      m.set(`${c}:${tok.name}`, JSON.stringify([tok.value, any.dark ?? '', any.curve ?? '', any.role ?? '', any.label ?? '']))
    }
  }
  return m
}

/** What changed going from `from` to `to` (token names, by category). */
export function diffTokenSets(from: TokenSet, to: TokenSet): TokenDiff {
  const a = flatten(from)
  const b = flatten(to)
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k.split(':')[1])
    else if (a.get(k) !== v) changed.push(k.split(':')[1])
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k.split(':')[1])
  return { added, removed, changed }
}

/** Upsert `incoming` tokens into `base` by name, category by category. */
export function mergeTokenSets(
  base: TokenSet,
  incoming: Partial<TokenSet>,
  mode: 'merge' | 'replace' = 'merge',
): TokenSet {
  const out = { ...base } as Record<TokenCategory, Array<{ name: string }>>
  for (const c of CATEGORIES) {
    const inc = incoming[c] as Array<{ name: string }> | undefined
    if (!inc?.length) continue
    if (mode === 'replace') {
      out[c] = inc
      continue
    }
    const list = [...(base[c] as Array<{ name: string }>)]
    for (const tok of inc) {
      const i = list.findIndex((x) => x.name === tok.name)
      if (i >= 0) list[i] = { ...list[i], ...tok }
      else list.push(tok)
    }
    out[c] = list
  }
  return out as unknown as TokenSet
}

/* ───────────────────────────── shadow / motion parsing ───────────────────────────── */

interface DtcgShadow {
  color: string
  offsetX: string
  offsetY: string
  blur: string
  spread: string
  inset?: boolean
}

/** Split on commas that are not inside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** One CSS shadow → DTCG shadow object; `null` if it doesn't look like one. */
export function parseShadow(css: string): DtcgShadow | null {
  let s = css.trim()
  const inset = /\binset\b/.test(s)
  s = s.replace(/\binset\b/, '').trim()
  const colorMatch = /(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8}|\b(?:black|white|transparent)\b)/.exec(s)
  const color = colorMatch ? colorMatch[1] : '#000000'
  const rest = colorMatch ? s.replace(colorMatch[1], '').trim() : s
  const lens = rest.split(/\s+/).filter(Boolean)
  if (lens.length < 2 || lens.length > 4 || !lens.every((l) => /^-?[\d.]+(px|rem|em)?$/.test(l))) return null
  const px = (v?: string) => (v === undefined ? '0px' : /^-?[\d.]+$/.test(v) ? `${v}px` : v)
  return { color, offsetX: px(lens[0]), offsetY: px(lens[1]), blur: px(lens[2]), spread: px(lens[3]), ...(inset ? { inset } : {}) }
}

function shadowToCss(v: unknown): string | null {
  if (typeof v === 'string') return v
  const one = (o: Record<string, unknown>) =>
    [o.inset ? 'inset' : '', o.offsetX ?? 0, o.offsetY ?? 0, o.blur ?? 0, o.spread ?? 0, o.color ?? '#000']
      .filter((x) => x !== '')
      .join(' ')
  if (Array.isArray(v)) return v.map((x) => one(x as Record<string, unknown>)).join(', ')
  if (v && typeof v === 'object') return one(v as Record<string, unknown>)
  return null
}

function bezierFromCss(curve: string): number[] | null {
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(curve.trim())
  if (!m) return null
  const n = m[1].split(',').map((x) => parseFloat(x))
  return n.length === 4 && n.every(Number.isFinite) ? n : null
}

function curveToCss(v: unknown): string {
  if (Array.isArray(v) && v.length === 4) return `cubic-bezier(${v.join(', ')})`
  return typeof v === 'string' ? v : 'ease'
}

/* ───────────────────────────── export ───────────────────────────── */

const EXT = 'io.adhar'

type DtcgNode = Record<string, unknown>

function token(type: string, value: unknown, name: string, extra: DtcgNode = {}, description?: string): DtcgNode {
  return {
    $type: type,
    $value: value,
    ...(description ? { $description: description } : {}),
    $extensions: { [EXT]: { name, ...extra } },
  }
}

/**
 * W3C Design Tokens Community Group format. Every token carries its exact CSS
 * variable name (and dark value / label) under `$extensions["io.adhar"]`, so
 * an export re-imports losslessly; other tools just see standard DTCG.
 */
export function tokensToW3C(t: TokenSet): DtcgNode {
  const group = <T>(list: T[], fn: (x: T) => [string, DtcgNode]) =>
    Object.fromEntries(list.map(fn))
  const fonts = t.typography.filter(isFontFamily)
  const sizes = t.typography.filter((x) => !isFontFamily(x))
  return {
    $description: 'Adhar workspace design tokens (W3C Design Tokens format)',
    color: group(t.color, (c) => [
      shortName(c.name),
      token('color', c.value, c.name, c.dark ? { dark: c.dark } : {}, c.role),
    ]),
    font: group(fonts, (f) => [
      shortName(f.name),
      token('fontFamily', f.value.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')), f.name),
    ]),
    typography: group(sizes, (s) => {
      const p = parseTypeValue(s.value)
      return [
        shortName(s.name),
        token('typography', p ? { fontSize: p.size, lineHeight: p.lineHeight ?? 'normal' } : s.value, s.name),
      ]
    }),
    spacing: group(t.spacing, (s) => [shortName(s.name), token('dimension', s.value, s.name)]),
    radius: group(t.radius, (s) => [shortName(s.name), token('dimension', s.value, s.name)]),
    shadow: group(t.elevation, (s) => {
      const parts = splitTop(s.value).map(parseShadow)
      const value = parts.every(Boolean) ? (parts.length === 1 ? parts[0] : parts) : s.value
      return [shortName(s.name), token('shadow', value, s.name, { css: s.value })]
    }),
    motion: group(t.motion, (m) => [
      shortName(m.name),
      token('transition', { duration: m.value, delay: '0ms', timingFunction: bezierFromCss(m.curve) ?? m.curve }, m.name),
    ]),
    breakpoint: group(t.breakpoint, (b) => [shortName(b.name), token('dimension', b.value, b.name, {}, b.label)]),
  }
}

/** The pre-DTCG export (`{ color: { '--adhar-color-x': '#…' } }`), kept for compatibility. */
export function tokensToFlatJson(t: TokenSet): Record<string, Record<string, string>> {
  return {
    color: Object.fromEntries(t.color.map((x) => [x.name, x.value])),
    spacing: Object.fromEntries(t.spacing.map((x) => [x.name, x.value])),
    typography: Object.fromEntries(t.typography.map((x) => [x.name, x.value])),
    radius: Object.fromEntries(t.radius.map((x) => [x.name, x.value])),
    elevation: Object.fromEntries(t.elevation.map((x) => [x.name, x.value])),
    motion: Object.fromEntries(t.motion.map((x) => [x.name, `${x.value} ${x.curve}`])),
    breakpoint: Object.fromEntries(t.breakpoint.map((x) => [x.name, x.value])),
  }
}

/** CSS custom properties: `:root` (light) + a `.dark` block for colours with a dark value. */
export function tokensToCss(t: TokenSet): string {
  const lines: string[] = [':root {']
  const section = (label: string, rows: string[]) => {
    if (!rows.length) return
    lines.push(`  /* ${label} */`, ...rows.map((r) => `  ${r}`))
  }
  section('Color', t.color.map((c) => `${c.name}: ${c.value};`))
  section('Typography', t.typography.map((c) => `${c.name}: ${c.value};`))
  section('Spacing', t.spacing.map((c) => `${c.name}: ${c.value};`))
  section('Radius', t.radius.map((c) => `${c.name}: ${c.value};`))
  section('Shadows', t.elevation.map((c) => `${c.name}: ${c.value};`))
  section('Motion', t.motion.flatMap((c) => [`${c.name}: ${c.value};`, `${c.name}-ease: ${c.curve};`]))
  section('Breakpoints', t.breakpoint.map((c) => `${c.name}: ${c.value};`))
  lines.push('}')
  const dark = t.color.filter((c) => c.dark)
  if (dark.length) {
    lines.push('', ".dark, [data-theme='dark'] {", ...dark.map((c) => `  ${c.name}: ${c.dark};`), '}')
  }
  return lines.join('\n')
}

/** Tailwind CSS v4 `@theme` block (namespaced the way v4 generates utilities). */
export function tokensToTailwindV4(t: TokenSet): string {
  const lines: string[] = ['@theme {']
  for (const c of t.color) lines.push(`  --color-${shortName(c.name)}: ${c.value};`)
  for (const f of t.typography.filter(isFontFamily)) lines.push(`  --font-${shortName(f.name)}: ${f.value};`)
  for (const s of t.typography.filter((x) => !isFontFamily(x))) {
    const p = parseTypeValue(s.value)
    if (!p) continue
    lines.push(`  --text-${shortName(s.name)}: ${p.size};`)
    if (p.lineHeight) lines.push(`  --text-${shortName(s.name)}--line-height: ${p.lineHeight};`)
  }
  for (const s of t.spacing) lines.push(`  --spacing-${shortName(s.name)}: ${s.value};`)
  for (const r of t.radius) lines.push(`  --radius-${shortName(r.name)}: ${r.value};`)
  for (const e of t.elevation) lines.push(`  --shadow-${shortName(e.name)}: ${e.value};`)
  for (const m of t.motion) lines.push(`  --ease-${shortName(m.name)}: ${m.curve};`)
  for (const b of t.breakpoint) lines.push(`  --breakpoint-${shortName(b.name)}: ${b.value};`)
  lines.push('}')
  const dark = t.color.filter((c) => c.dark)
  if (dark.length) {
    lines.push('', '.dark {', ...dark.map((c) => `  --color-${shortName(c.name)}: ${c.dark};`), '}')
  }
  return lines.join('\n')
}

/** Tailwind v3 `tailwind.config.js`; colours point at the CSS variables so dark mode follows. */
export function tokensToTailwindV3(t: TokenSet): string {
  const obj = (entries: Array<[string, unknown]>) => Object.fromEntries(entries)
  const config = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: obj(t.color.map((c) => [shortName(c.name), `var(${c.name})`])),
        fontFamily: obj(
          t.typography.filter(isFontFamily).map((f) => [shortName(f.name), f.value.split(',').map((x) => x.trim())]),
        ),
        fontSize: obj(
          t.typography
            .filter((x) => !isFontFamily(x))
            .map((s): [string, unknown] => {
              const p = parseTypeValue(s.value)
              return [shortName(s.name), p?.lineHeight ? [p.size, { lineHeight: p.lineHeight }] : (p?.size ?? s.value)]
            }),
        ),
        spacing: obj(t.spacing.map((s) => [shortName(s.name), s.value])),
        borderRadius: obj(t.radius.map((s) => [shortName(s.name), s.value])),
        boxShadow: obj(t.elevation.map((s) => [shortName(s.name), s.value])),
        transitionDuration: obj(t.motion.map((m) => [shortName(m.name), m.value])),
        transitionTimingFunction: obj(t.motion.map((m) => [shortName(m.name), m.curve])),
        screens: obj(t.breakpoint.map((b) => [shortName(b.name), b.value])),
      },
    },
  }
  return `/** @type {import('tailwindcss').Config} */\nexport default ${JSON.stringify(config, null, 2)}\n`
}

/* ───────────────────────────── import ───────────────────────────── */

export interface ImportResult {
  tokens: Partial<TokenSet>
  count: number
  warnings: string[]
}

function emptyPartial(): Required<Partial<TokenSet>> {
  return { color: [], typography: [], spacing: [], radius: [], elevation: [], motion: [], breakpoint: [] }
}

function finish(out: Required<Partial<TokenSet>>, warnings: string[]): ImportResult {
  const tokens: Partial<TokenSet> = {}
  let count = 0
  for (const c of CATEGORIES) {
    const list = out[c] as Array<{ name: string }>
    // De-duplicate by name, last one wins.
    const seen = new Map<string, { name: string }>()
    for (const x of list) seen.set(x.name, x)
    const uniq = [...seen.values()]
    if (uniq.length) {
      ;(tokens as Record<string, unknown>)[c] = uniq
      count += uniq.length
    }
  }
  return { tokens, count, warnings }
}

function categoryForGroup(path: string[], type: string | undefined): TokenCategory | null {
  const head = path.join('.').toLowerCase()
  switch (type) {
    case 'color':
      return 'color'
    case 'fontFamily':
    case 'typography':
    case 'fontWeight':
      return 'typography'
    case 'shadow':
      return 'elevation'
    case 'transition':
    case 'duration':
      return 'motion'
  }
  if (/breakpoint|screen|\bbp\b/.test(head)) return 'breakpoint'
  if (/radius|radii|corner|rounded/.test(head)) return 'radius'
  if (/shadow|elevation/.test(head)) return 'elevation'
  if (/motion|duration|transition/.test(head)) return 'motion'
  if (/font|text|type/.test(head)) return 'typography'
  if (/color|colour/.test(head)) return 'color'
  if (type === 'dimension' || /space|spacing|size|gap/.test(head)) return 'spacing'
  return null
}

const GROUP_PREFIX: Record<TokenCategory, string> = {
  ...CATEGORY_PREFIX,
}

/** Resolve `{group.token}` aliases against the document (one level deep is plenty). */
function resolveAlias(root: DtcgNode, v: unknown): unknown {
  if (typeof v !== 'string') return v
  const m = /^\{([^}]+)\}$/.exec(v.trim())
  if (!m) return v
  let cur: unknown = root
  for (const k of m[1].split('.')) cur = (cur as DtcgNode | undefined)?.[k]
  return cur && typeof cur === 'object' && '$value' in (cur as DtcgNode) ? (cur as DtcgNode).$value : v
}

/** Parse a W3C Design Tokens (DTCG) document — ours or any other tool's. */
export function importW3C(doc: DtcgNode): ImportResult {
  const out = emptyPartial()
  const warnings: string[] = []
  const walk = (node: DtcgNode, path: string[], inheritedType?: string) => {
    const type = (node.$type as string | undefined) ?? inheritedType
    if ('$value' in node) {
      const cat = categoryForGroup(path.slice(0, -1).length ? path.slice(0, -1) : path, type)
      const ext = ((node.$extensions as DtcgNode | undefined)?.[EXT] ?? {}) as DtcgNode
      const key = slug(path.slice(1).join('-') || path.join('-'))
      const value = resolveAlias(doc, node.$value)
      if (!cat) {
        warnings.push(`Skipped ${path.join('.')} (unsupported type ${type ?? 'unknown'})`)
        return
      }
      const isFont = type === 'fontFamily' || (cat === 'typography' && /font/.test(path[0] ?? ''))
      const name = typeof ext.name === 'string'
        ? ext.name
        : `${isFont ? '--adhar-font-' : GROUP_PREFIX[cat]}${key}`
      const desc = typeof node.$description === 'string' ? node.$description : ''
      switch (cat) {
        case 'color': {
          if (typeof value !== 'string' || !parseColor(value)) {
            warnings.push(`Skipped ${path.join('.')} (not a colour)`)
            return
          }
          const dark = typeof ext.dark === 'string' ? ext.dark : undefined
          out.color.push({ name, value, role: desc || key, ...(dark ? { dark } : {}) })
          return
        }
        case 'typography': {
          if (Array.isArray(value)) out.typography.push({ name, value: value.join(', ') })
          else if (value && typeof value === 'object') {
            const v = value as DtcgNode
            const size = v.fontSize ? String(v.fontSize) : ''
            if (!size) {
              warnings.push(`Skipped ${path.join('.')} (typography without fontSize)`)
              return
            }
            const lh = v.lineHeight
            const lhs = lh === undefined || lh === 'normal'
              ? ''
              : typeof lh === 'number' && /px$/.test(size)
              ? `${Math.round(parseFloat(size) * lh)}px`
              : String(lh)
            out.typography.push({ name, value: lhs ? `${size} / ${lhs}` : size })
          } else out.typography.push({ name, value: String(value) })
          return
        }
        case 'elevation': {
          const css = typeof ext.css === 'string' ? ext.css : shadowToCss(value)
          if (css) out.elevation.push({ name, value: css })
          return
        }
        case 'motion': {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const v = value as DtcgNode
            out.motion.push({ name, value: String(v.duration ?? '200ms'), curve: curveToCss(v.timingFunction) })
          } else out.motion.push({ name, value: String(value), curve: 'ease' })
          return
        }
        case 'breakpoint':
          out.breakpoint.push({ name, value: String(value), label: desc || key })
          return
        default:
          out[cat].push({ name, value: typeof value === 'object' ? JSON.stringify(value) : String(value) } as never)
      }
      return
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$') || !v || typeof v !== 'object') continue
      walk(v as DtcgNode, [...path, k], type)
    }
  }
  walk(doc, [])
  return finish(out, warnings)
}

/** Parse the legacy flat export (`{ color: { '--adhar-color-x': '#…' }, … }`). */
export function importFlatJson(doc: Record<string, unknown>): ImportResult {
  const out = emptyPartial()
  for (const c of CATEGORIES) {
    const g = doc[c]
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue
    for (const [name, raw] of Object.entries(g as Record<string, unknown>)) {
      const value = String(raw)
      if (c === 'color') out.color.push({ name, value, role: shortName(name) })
      else if (c === 'motion') {
        const [dur, ...curve] = value.split(' ')
        out.motion.push({ name, value: dur, curve: curve.join(' ') || 'ease' })
      } else if (c === 'breakpoint') out.breakpoint.push({ name, value, label: shortName(name) })
      else out[c].push({ name, value } as never)
    }
  }
  return finish(out, [])
}

function looksFlat(doc: Record<string, unknown>): boolean {
  return CATEGORIES.some((c) => {
    const g = doc[c]
    return !!g && typeof g === 'object' && !Array.isArray(g) &&
      Object.entries(g as Record<string, unknown>).some(([k, v]) => k.startsWith('--') && typeof v === 'string')
  })
}

/** Categorise a CSS custom property by its name, then by its value. */
function categoryForVar(name: string, value: string): TokenCategory | null {
  const n = name.toLowerCase()
  if (/breakpoint|screen|-bp-/.test(n)) return 'breakpoint'
  if (/radius|rounded/.test(n)) return 'radius'
  if (/shadow|elevation/.test(n)) return 'elevation'
  if (/duration|motion|transition|-ease/.test(n)) return 'motion'
  if (/font|-text-|leading|line-height/.test(n)) return 'typography'
  if (/space|spacing|gap|-size-/.test(n)) return 'spacing'
  if (/color|colour|-bg|-fg|surface|border/.test(n) || parseColor(value)) return 'color'
  return null
}

/** Parse CSS custom properties; declarations under a `dark` selector / media become dark colour values. */
export function importCss(css: string): ImportResult {
  const out = emptyPartial()
  const warnings: string[] = []
  const darkVals = new Map<string, string>()
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const stack: string[] = []
  let buf = ''
  const flushDecls = (text: string) => {
    const dark = stack.some((s) => /dark/i.test(s))
    for (const decl of text.split(';')) {
      const m = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl)
      if (!m) continue
      const [, name, value] = m
      if (dark) {
        darkVals.set(name, value)
        continue
      }
      if (/-ease$/.test(name)) continue // paired with its duration below
      const cat = categoryForVar(name, value)
      if (!cat) {
        warnings.push(`Skipped ${name} (couldn't tell what kind of token it is)`)
        continue
      }
      if (cat === 'color') out.color.push({ name, value, role: shortName(name) })
      else if (cat === 'motion') {
        const [dur, ...curve] = value.split(/\s+/)
        out.motion.push({ name, value: dur, curve: curve.join(' ') || 'ease' })
      } else if (cat === 'breakpoint') out.breakpoint.push({ name, value, label: shortName(name) })
      else out[cat].push({ name, value } as never)
    }
  }
  for (const ch of src) {
    if (ch === '{') {
      stack.push(buf.trim())
      buf = ''
    } else if (ch === '}') {
      flushDecls(buf)
      buf = ''
      stack.pop()
    } else buf += ch
  }
  // Pair `--x-ease` declarations with their `--x` duration.
  for (const m of src.matchAll(/(--[A-Za-z0-9_-]+)-ease\s*:\s*([^;]+);/g)) {
    const tok = out.motion.find((x) => x.name === m[1])
    if (tok) tok.curve = m[2].trim()
  }
  for (const [name, value] of darkVals) {
    const tok = out.color.find((c) => c.name === name)
    if (tok) tok.dark = value
    else if (parseColor(value)) warnings.push(`Dark value for ${name} has no light value; skipped`)
  }
  return finish(out, warnings)
}

/** Auto-detect: DTCG JSON, legacy flat JSON, or CSS custom properties. */
export function importTokens(text: string): ImportResult {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Nothing to import — paste JSON or CSS first.')
  let result: ImportResult
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let doc: unknown
    try {
      doc = JSON.parse(trimmed)
    } catch (e) {
      throw new Error(`Invalid JSON: ${(e as Error).message}`)
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Expected a JSON object of tokens.')
    result = looksFlat(doc as Record<string, unknown>)
      ? importFlatJson(doc as Record<string, unknown>)
      : importW3C(doc as DtcgNode)
  } else {
    result = importCss(trimmed)
  }
  if (!result.count) throw new Error('No tokens found in that input.')
  return result
}
