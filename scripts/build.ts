#!/usr/bin/env -S deno run -A
/**
 * Orchestrate a full production build.
 *
 * Steps:
 *   1. Build every federated remote in parallel (`modules/<name>/dist/`).
 *   2. Build the host app (`apps/console/.output/`).
 *   3. Copy every remote's `dist/*` into
 *      `apps/console/.output/public/mf/<name>/` so a single Deno process
 *      serves host + every remote from one origin in production.
 *
 * Run:
 *   deno task build
 *   pnpm run build
 *
 * Subset:
 *   deno task build platform develop
 */

import { copy, ensureDir, exists } from 'jsr:@std/fs@^1.0.0'
import { join, resolve } from 'jsr:@std/path@^1.0.0'

const REMOTES = [
  { name: 'define', dir: 'modules/define' },
  { name: 'design', dir: 'modules/design' },
  { name: 'develop', dir: 'modules/develop' },
  { name: 'deliver', dir: 'modules/deliver' },
  { name: 'discover', dir: 'modules/discover' },
  { name: 'decide', dir: 'modules/decide' },
  { name: 'platform', dir: 'modules/platform' },
  { name: 'workspace', dir: 'modules/workspace' },
] as const

const HOST = { name: 'console', dir: 'apps/console' }

const args = Deno.args.map((a) => a.trim()).filter(Boolean)
const filterRemotes = args.length > 0 && !args.includes('console')
const selectedRemotes = args.length === 0
  ? REMOTES
  : REMOTES.filter((r) => args.includes(r.name))
const buildHost = args.length === 0 || args.includes('console') || !filterRemotes

const tag = (name: string) => `\x1b[1;36m[${name.padEnd(9)}]\x1b[0m`

async function run(cmd: string[], cwd: string, label: string): Promise<void> {
  console.log(`${tag(label)} \x1b[90m$ ${cmd.join(' ')}\x1b[0m \x1b[2m(cwd: ${cwd})\x1b[0m`)
  const start = Date.now()
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...Deno.env.toObject(), FORCE_COLOR: '1' },
  }).spawn()
  const status = await proc.status
  const ms = Date.now() - start
  if (!status.success) {
    console.error(
      `${tag(label)} \x1b[31m✖ failed (exit ${status.code}, ${ms}ms)\x1b[0m`,
    )
    Deno.exit(status.code ?? 1)
  }
  console.log(`${tag(label)} \x1b[32m✓ built\x1b[0m \x1b[2m(${ms}ms)\x1b[0m`)
}

async function copyRemoteDist(remoteDir: string, name: string) {
  const src = resolve(remoteDir, 'dist')
  // Host is a Vite SPA build → served from `apps/console/dist/`. Stage each
  // remote under `dist/mf/<name>/` so the standalone server serves host +
  // every remote from one origin (matching the remote `base: /mf/<name>/`).
  const dst = resolve(HOST.dir, 'dist/mf', name)
  if (!(await exists(src))) {
    throw new Error(`${remoteDir}/dist does not exist — did its build fail silently?`)
  }
  await ensureDir(dst)
  // Clean destination first so a re-run doesn't leave stale chunks behind.
  await Deno.remove(dst, { recursive: true }).catch(() => {})
  await ensureDir(dst)
  await copy(src, dst, { overwrite: true })
  console.log(`${tag(name)} \x1b[90m→ ${dst.replace(Deno.cwd() + '/', '')}\x1b[0m`)
}

console.log(`\x1b[1mAdhar Console · production build\x1b[0m`)
console.log(`  remotes: ${selectedRemotes.map((r) => r.name).join(', ') || '(none)'}`)
console.log(`  host:    ${buildHost ? 'yes' : 'no'}`)
console.log()

// 1. Build remotes in parallel.
if (selectedRemotes.length > 0) {
  console.log(`\x1b[1mBuilding remotes…\x1b[0m`)
  await Promise.all(
    selectedRemotes.map((r) => run(['deno', 'task', 'build'], r.dir, r.name)),
  )
  console.log()
}

// 2. Build the host.
if (buildHost) {
  console.log(`\x1b[1mBuilding host…\x1b[0m`)
  await run(['deno', 'task', 'build'], HOST.dir, HOST.name)
  console.log()
}

// 3. Stage remote dists under the host's public dir.
if (buildHost && selectedRemotes.length > 0) {
  console.log(`\x1b[1mStaging remotes under host public/mf/…\x1b[0m`)
  for (const r of selectedRemotes) {
    await copyRemoteDist(r.dir, r.name)
  }
  console.log()
}

// 4. Sanity check — the SPA entry HTML must exist.
if (buildHost) {
  const entry = join(HOST.dir, 'dist/index.html')
  if (!(await exists(entry))) {
    console.warn(
      `\x1b[33m⚠  Expected SPA entry at ${entry} — did the host build fail?\x1b[0m`,
    )
  }
}

console.log(`\x1b[32m✓ build complete\x1b[0m`)
console.log(`\nTo serve locally (production-equivalent):`)
console.log(`  cd apps/console && deno run -A server.ts`)
