#!/usr/bin/env node
// Release notes from git — the single source for the CHANGELOG and the
// console's What's New page.
//
//   node scripts/release-notes.mjs                 # regenerate data + backfill CHANGELOG
//   node scripts/release-notes.mjs --next 0.1.120  # also attribute unreleased commits to 0.1.120
//
// Why: `scripts/release.mjs` promoted an empty "[Unreleased]" section on every
// release, so every CHANGELOG heading had no body and What's New showed a
// hand-written list frozen at 0.1.42. The truth is in git: each `vX.Y.Z` tag
// and the commit subjects between it and the previous tag. This script turns
// that into:
//   - packages/platform-info/src/release-notes.generated.ts (What's New)
//   - bullet lists under every CHANGELOG heading that is still empty
//     (headings someone has written by hand are left untouched).

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'packages/platform-info/src/release-notes.generated.ts')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')
/** How many releases the What's New page carries. The CHANGELOG gets all of them. */
const PAGE_RELEASES = 40

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

const TYPE = {
  feat: 'feature',
  fix: 'fix',
  perf: 'improvement',
  refactor: 'improvement',
  style: 'improvement',
  ui: 'improvement',
  docs: 'docs',
}

/**
 * `feat(shell): lift the sidebar` → { type: 'feature', scope: 'shell', text: 'Lift the sidebar' }
 *
 * Not every subject is conventional. `catalog: drop the chips` names a scope,
 * not a type, and `fix ci issue` names neither — for those the type is read
 * from the leading verb, so a fix still lands under "Fixed".
 */
export function parseSubject(subject) {
  // Up to three words before the colon: `cloud shell: …`, `adhar resources: …`.
  const m = /^([\w-]+(?: [\w-]+){0,2})(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject)
  let type
  let scope
  let raw = subject
  if (m) {
    raw = m[4]
    const head = m[1].toLowerCase()
    if (TYPE[head]) {
      type = TYPE[head]
      scope = m[2]
    } else if (head === 'chore' || head === 'build' || head === 'ci' || head === 'test') {
      type = 'change'
      scope = m[2]
    } else {
      // `catalog: …` / `adhar resources: …` — the prefix is the area.
      scope = (m[2] ? `${m[1]}/${m[2]}` : m[1]).toLowerCase()
    }
  }
  type ??= verbType(raw)
  const text = raw.charAt(0).toUpperCase() + raw.slice(1)
  return { type, scope, text, breaking: (m && m[3]) ? true : undefined }
}

function verbType(text) {
  const t = text.toLowerCase()
  if (/^(fix|repair|correct|resolve|stop|prevent)\b|\bfix(es|ed)?\b/.test(t)) return 'fix'
  if (/^(add|introduce|new|support|enable|show|let|allow|expose)\b/.test(t)) return 'feature'
  if (/^(make|improve|enhance|polish|refine|speed|tighten|drop|remove|rework|redesign|keep|lift|move)\b|enhancement/.test(t)) return 'improvement'
  return 'change'
}

/** Housekeeping that says nothing to a reader of release notes. */
function noise(subject) {
  return /^chore\(release\)|^Merge (branch|pull request)|^chore(\(deps\))?: bump|^wip\b/i.test(subject)
}

function semverTags() {
  return git(['tag', '--list', 'v*'])
    .split('\n')
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number)
      const pb = b.slice(1).split('.').map(Number)
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
    })
}

function changesIn(range) {
  const out = git(['log', '--no-merges', '--format=%s', range])
  const seen = new Set()
  const items = []
  for (const s of out ? out.split('\n') : []) {
    if (!s || noise(s) || seen.has(s)) continue
    seen.add(s)
    items.push(parseSubject(s))
  }
  return items
}

export function buildNotes({ next, date } = {}) {
  const tags = semverTags()
  const notes = []
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]
    const range = i === 0 ? tag : `${tags[i - 1]}..${tag}`
    const tagDate = git(['log', '-1', '--format=%cI', tag]).slice(0, 10)
    notes.push({ version: tag.slice(1), date: tagDate, changes: changesIn(range) })
  }
  const last = tags[tags.length - 1]
  const pending = last ? changesIn(`${last}..HEAD`) : []
  if (next && pending.length) {
    notes.push({ version: next.replace(/^v/, ''), date: date ?? new Date().toISOString().slice(0, 10), changes: pending })
  }
  return notes.reverse()
}

const SECTION = { feature: 'Added', improvement: 'Improved', fix: 'Fixed', docs: 'Documentation', change: 'Changed' }
const ORDER = ['feature', 'improvement', 'fix', 'change', 'docs']

function changelogBody(changes) {
  if (!changes.length) return '_Maintenance release — no user-facing changes._\n'
  const parts = []
  for (const type of ORDER) {
    const items = changes.filter((c) => c.type === type)
    if (!items.length) continue
    parts.push(`### ${SECTION[type]}\n\n${items.map((c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.text}`).join('\n')}\n`)
  }
  return parts.join('\n')
}

/** Fill every `## [x.y.z] - date` heading whose body is empty; leave written ones alone. */
export function backfillChangelog(notes) {
  const byVersion = new Map(notes.map((n) => [n.version, n]))
  const text = readFileSync(CHANGELOG, 'utf8')
  const lines = text.split('\n')
  const out = []
  let filled = 0
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const m = /^## \[(\d+\.\d+\.\d+)\]/.exec(lines[i])
    if (!m) continue
    // Empty body = only blank lines until the next `## ` heading.
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    const empty = j >= lines.length || lines[j].startsWith('## ')
    const note = byVersion.get(m[1])
    if (empty && note) {
      out.push('', changelogBody(note.changes).trimEnd())
      filled++
    }
  }
  writeFileSync(CHANGELOG, out.join('\n').replace(/\n{3,}/g, '\n\n'))
  return filled
}

export function writeData(notes) {
  const page = notes.slice(0, PAGE_RELEASES)
  const body = `// GENERATED by scripts/release-notes.mjs from git tags — do not edit by hand.
// Regenerated on every release (scripts/release.mjs) and by \`node scripts/release-notes.mjs\`.
import type { ReleaseNote } from './types.ts'

export const RELEASE_NOTES: ReleaseNote[] = ${JSON.stringify(page, null, 2)}
`
  writeFileSync(OUT, body)
  return page.length
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--next')
  const next = i > 0 ? process.argv[i + 1] : undefined
  const notes = buildNotes({ next })
  const n = writeData(notes)
  const filled = backfillChangelog(notes)
  console.log(`release notes: ${n} release(s) → ${OUT.replace(ROOT + '/', '')}; CHANGELOG sections filled: ${filled}`)
}
