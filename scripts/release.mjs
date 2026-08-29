#!/usr/bin/env node
// One-command release cutter — the local twin of .github/workflows/version-bump.yml.
//
//   npm run release              # patch bump  (0.1.11 → 0.1.12)
//   npm run release minor        # minor bump  (0.1.11 → 0.2.0)
//   npm run release major        # major bump  (0.1.11 → 1.0.0)
//   npm run release v0.1.12      # explicit version (leading v optional)
//   npm run release 0.1.12 --dry # print the plan, change + push nothing
//
// It bumps package.json, promotes the CHANGELOG "[Unreleased]" section to a
// dated release heading, commits, creates the annotated tag `vX.Y.Z`, and
// pushes both the branch and the tag. Pushing the tag from your machine (a real
// user, not GITHUB_TOKEN) is what triggers the Release workflow — build → push
// `ghcr.io/adhar-io/adhar-console:{version}` + `:latest` → GitHub Release.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'package.json')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')

const die = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}
const step = (msg) => console.log(`\x1b[36m→\x1b[0m ${msg}`)
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`)

// Run git, returning trimmed stdout. `quiet` swallows a non-zero exit (for probes).
function git(args, { quiet = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'] }).trim()
  } catch (e) {
    if (quiet) return ''
    throw e
  }
}

// ── Parse args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const dry = argv.some((a) => a === '--dry' || a === '--dry-run')
const positional = argv.filter((a) => !a.startsWith('-'))
const spec = positional[0] ?? 'patch' // version | patch | minor | major

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
const current = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(current)) die(`package.json version "${current}" is not x.y.z`)

// ── Compute next version ──────────────────────────────────────────────────────
let next
if (['patch', 'minor', 'major'].includes(spec)) {
  let [ma, mi, pa] = current.split('.').map(Number)
  if (spec === 'major') (ma += 1), (mi = 0), (pa = 0)
  else if (spec === 'minor') (mi += 1), (pa = 0)
  else pa += 1
  next = `${ma}.${mi}.${pa}`
} else {
  next = spec.replace(/^v/, '')
}
if (!/^\d+\.\d+\.\d+$/.test(next)) die(`"${next}" is not a valid SemVer x.y.z (or a bump: patch|minor|major)`)
if (next === current) die(`version is already ${next} — nothing to bump`)
const tag = `v${next}`

// ── Preflight guards ──────────────────────────────────────────────────────────
if (git(['rev-parse', '--is-inside-work-tree'], { quiet: true }) !== 'true') die('not inside a git work tree')

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
const defaultBranch = (git(['symbolic-ref', 'refs/remotes/origin/HEAD'], { quiet: true }) || 'refs/remotes/origin/main').replace('refs/remotes/origin/', '')
if (branch !== defaultBranch) console.warn(`\x1b[33m! on "${branch}", not the default branch "${defaultBranch}" — the tag will point at this branch\x1b[0m`)

if (git(['tag', '--list', tag])) die(`tag ${tag} already exists locally`)
if (git(['ls-remote', '--tags', 'origin', tag], { quiet: true })) die(`tag ${tag} already exists on origin`)

// The commit only ever includes package.json + CHANGELOG.md (git add below is
// explicit), so unrelated dirty files / build artifacts never sneak in — no
// need to block on them. Just note anything else that's uncommitted.
const others = git(['status', '--porcelain'], { quiet: true })
  .split('\n')
  .map((l) => l.replace(/^..\s/, '').trim())
  .filter((f) => f && f !== 'package.json' && f !== 'CHANGELOG.md')
if (others.length) console.warn(`\x1b[33m! ${others.length} other uncommitted path(s) will NOT be part of the release commit (only package.json + CHANGELOG.md are)\x1b[0m`)

console.log(`\n\x1b[1mRelease ${current} → ${next}\x1b[0m  (tag ${tag}, branch ${branch})${dry ? '  \x1b[33m[dry run]\x1b[0m' : ''}\n`)

// ── 1. package.json version ───────────────────────────────────────────────────
step(`package.json version → ${next}`)
if (!dry) {
  pkg.version = next
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n')
}

// ── 2. Promote CHANGELOG [Unreleased] → [x.y.z] - <date> ──────────────────────
const date = new Date().toISOString().slice(0, 10)
const changelog = readFileSync(CHANGELOG, 'utf8')
if (changelog.includes('## [Unreleased]')) {
  step(`CHANGELOG: [Unreleased] → [${next}] - ${date}`)
  if (!dry) writeFileSync(CHANGELOG, changelog.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] - ${date}`))
} else {
  console.warn('\x1b[33m! no "## [Unreleased]" heading in CHANGELOG.md — skipping promotion\x1b[0m')
}

// ── 3. Commit · tag · push ────────────────────────────────────────────────────
if (dry) {
  console.log('\n\x1b[33mDry run — would now:\x1b[0m')
  console.log(`  git add package.json CHANGELOG.md`)
  console.log(`  git commit -m "chore(release): ${tag}"`)
  console.log(`  git tag -a ${tag} -m "adhar-console ${tag}"`)
  console.log(`  git push origin ${branch} && git push origin ${tag}`)
  process.exit(0)
}

step('commit')
git(['add', 'package.json', 'CHANGELOG.md'])
git(['commit', '-m', `chore(release): ${tag}`])
step(`tag ${tag}`)
git(['tag', '-a', tag, '-m', `adhar-console ${tag}`])
step(`push ${branch} + ${tag}`)
git(['push', 'origin', branch])
git(['push', 'origin', tag])

const repo = (git(['remote', 'get-url', 'origin'], { quiet: true }).match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/) || [])[1]
ok(`released ${tag}`)
console.log(`\n  Release pipeline: https://github.com/${repo}/actions/workflows/release.yml`)
console.log(`  Publishes ghcr.io/adhar-io/adhar-console:${next} + :latest → ArgoCD rolls it out.\n`)
