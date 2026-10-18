import type { DetectedTech } from './catalog-techstack.ts'

/**
 * Lockfiles → the exact versions a manifest's ranges resolved to.
 *
 * A manifest says `"react": "^18.2.0"`; what the build installs is whatever
 * the lockfile pinned (`18.3.1`). This module reads the lockfiles a repo
 * commits — line-based where the format allows, so a multi-megabyte file is
 * one pass with no YAML/TOML parser — and resolves only the packages the
 * Tech stack tab tracks. Pure: callers fetch the text (with a size cap).
 *
 * Package names are ecosystem coordinates: npm names (`@angular/core`),
 * Maven `group:artifact`, Go module paths, PyPI names (normalised), crate,
 * gem and Composer names. They never collide in practice.
 */

/** Lockfiles we read, by file name. */
export const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'deno.lock',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
  'gradle.lockfile',
])

/** Lockfiles above this size are skipped (the forge's contents API is the bottleneck, not parsing). */
export const MAX_LOCKFILE_BYTES = 3 * 1024 * 1024

export interface LockEntry {
  version: string
  /** Ranges that resolved to this version (yarn/deno record them). */
  specs?: string[]
  /** pnpm workspace importer the entry belongs to ('.' = root). */
  importer?: string
}

export interface LockIndex {
  /** Repository path of the lockfile. */
  source: string
  /** `npm`, `pnpm`, `yarn`, … */
  kind: string
  packages: Map<string, LockEntry[]>
}

const baseName = (p: string) => p.split('/').pop() ?? p
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** PyPI names compare case-insensitively with `-`, `_`, `.` equivalent (PEP 503). */
export const normalizePkg = (name: string) => (/^[\w.-]+$/.test(name) && !name.includes(':') && !name.includes('/') ? name.toLowerCase().replace(/[-_.]+/g, '-') : name)

function add(map: Map<string, LockEntry[]>, name: string, entry: LockEntry) {
  const key = normalizePkg(name)
  const list = map.get(key) ?? []
  if (!list.some((e) => e.version === entry.version && e.importer === entry.importer)) list.push(entry)
  map.set(key, list)
}

/** `npm:^18.2.0` / `"^18.2.0"` → `^18.2.0`. */
const cleanRange = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').replace(/^npm:/, '')

/** The package name of a `name@range` descriptor, scoped names included. */
function splitDescriptor(d: string): { name: string; range: string } | undefined {
  const s = d.trim().replace(/^['"]|['"]$/g, '')
  const at = s.indexOf('@', s.startsWith('@') ? 1 : 0)
  if (at <= 0) return undefined
  return { name: s.slice(0, at), range: cleanRange(s.slice(at + 1)) }
}

/* ─────────── npm ─────────── */

export function parsePackageLock(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  let json: { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> }
  try {
    json = JSON.parse(text)
  } catch {
    return map
  }
  // v2/v3: "packages": { "node_modules/react": { "version": "18.3.1" } } — top level only.
  for (const [path, v] of Object.entries(json.packages ?? {})) {
    const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path)
    if (m && v.version) add(map, m[1], { version: v.version })
  }
  // v1: "dependencies": { "react": { "version": "18.3.1" } }
  if (!map.size) for (const [name, v] of Object.entries(json.dependencies ?? {})) if (v.version) add(map, name, { version: v.version })
  return map
}

/* ─────────── pnpm ─────────── */

/**
 * pnpm-lock.yaml v6–v9: `importers: <path>: dependencies: <name>: specifier / version`.
 * The version may carry a peer suffix (`18.3.1(react@18.3.1)`), which is dropped.
 * Older v5 locks without importers fall back to `packages:` keys (`/react@18.3.1:` or `/react/18.3.1:`).
 */
export function parsePnpmLock(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  const lines = text.split('\n')
  let section = ''
  let importer: string | undefined
  let name: string | undefined
  let spec: string | undefined
  let fromImporters = false
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (indent === 0) {
      section = line.replace(/:.*$/, '')
      importer = undefined
      continue
    }
    if (section === 'importers') {
      fromImporters = true
      if (indent === 2) {
        importer = line.replace(/:$/, '').replace(/^['"]|['"]$/g, '')
        continue
      }
      if (indent === 6 && line.endsWith(':')) {
        name = line.slice(0, -1).replace(/^['"]|['"]$/g, '')
        spec = undefined
        continue
      }
      const kv = /^(specifier|version):\s*(.+)$/.exec(line)
      if (indent === 8 && kv && name) {
        if (kv[1] === 'specifier') spec = cleanRange(kv[2])
        else {
          const v = cleanRange(kv[2]).replace(/\(.*$/, '')
          if (/^\d/.test(v)) add(map, name, { version: v, specs: spec ? [spec] : undefined, importer })
        }
      }
      // v5 style inside importers: `react: 18.3.1`
      const flat = /^((?:@[^/\s]+\/)?[^:\s]+):\s*([\d][^\s(]*)/.exec(line)
      if (indent === 6 && flat) add(map, flat[1].replace(/^['"]|['"]$/g, ''), { version: flat[2], importer })
    } else if (/^(dependencies|devDependencies|optionalDependencies)$/.test(section)) {
      // v6 single-project: top-level `dependencies:` with `name:` / `specifier` / `version` at indent 2/4.
      fromImporters = true
      if (indent === 2 && line.endsWith(':')) {
        name = line.slice(0, -1).replace(/^['"]|['"]$/g, '')
        spec = undefined
        continue
      }
      const kv = /^(specifier|version):\s*(.+)$/.exec(line)
      if (indent === 4 && kv && name) {
        if (kv[1] === 'specifier') spec = cleanRange(kv[2])
        else {
          const v = cleanRange(kv[2]).replace(/\(.*$/, '')
          if (/^\d/.test(v)) add(map, name, { version: v, specs: spec ? [spec] : undefined, importer: '.' })
        }
      }
      const flat = /^((?:@[^/\s]+\/)?[^:\s]+):\s*([\d][^\s(]*)/.exec(line)
      if (indent === 2 && flat) add(map, flat[1].replace(/^['"]|['"]$/g, ''), { version: flat[2], importer: '.' })
    } else if (section === 'packages' && indent === 2 && !fromImporters) {
      // `/react@18.3.1:` (v6) · `react@18.3.1:` (v9) · `/react/18.3.1:` (v5)
      const key = line.replace(/:$/, '').replace(/^['"]|['"]$/g, '').replace(/^\//, '').replace(/\(.*$/, '')
      const v5 = /^((?:@[^/]+\/)?[^/]+)\/(\d[^/]*)$/.exec(key)
      const d = splitDescriptor(key) ?? (v5 ? { name: v5[1], range: v5[2] } : undefined)
      if (d && /^\d/.test(d.range)) add(map, d.name, { version: d.range })
    }
  }
  return map
}

/* ─────────── yarn ─────────── */

/**
 * yarn.lock, classic (`react@^18.2.0, react@^18.0.0:` / `  version "18.3.1"`)
 * and berry (`"react@npm:^18.2.0":` / `  version: 18.3.1`).
 */
export function parseYarnLock(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  let current: Array<{ name: string; range: string }> = []
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.startsWith('#')) continue
    if (!/^\s/.test(raw) && raw.trimEnd().endsWith(':')) {
      current = raw.trimEnd().slice(0, -1).split(/,\s*/).map(splitDescriptor).filter((d): d is { name: string; range: string } => Boolean(d))
      continue
    }
    const v = /^\s{2}version:?\s+"?([^"\s]+)"?/.exec(raw)
    if (v && current.length) {
      const name = current[0].name
      if (name === '__metadata') continue
      add(map, name, { version: v[1], specs: current.filter((c) => c.name === name).map((c) => c.range) })
      current = []
    }
  }
  return map
}

/* ─────────── bun (text lockfile) ─────────── */

/** bun.lock (JSONC): `"packages": { "react": ["react@18.3.1", …] }`. The binary bun.lockb is not read. */
export function parseBunLock(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  for (const m of text.matchAll(/^\s*"((?:@[^"/]+\/)?[^"/]+)":\s*\[\s*"((?:@[^"@/]+\/)?[^"@]+)@([^"]+)"/gm)) {
    if (m[1] === m[2] && /^\d/.test(m[3])) add(map, m[2], { version: m[3] })
  }
  return map
}

/* ─────────── deno ─────────── */

/** deno.lock v3–v5: `"specifiers": { "npm:react@^19.2.0": "19.2.5", "jsr:@std/assert@1": "1.0.13" }`. */
export function parseDenoLock(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  let json: { specifiers?: Record<string, string>; packages?: { specifiers?: Record<string, string> } }
  try {
    json = JSON.parse(text)
  } catch {
    return map
  }
  const specs = json.specifiers ?? json.packages?.specifiers ?? {}
  for (const [k, v] of Object.entries(specs)) {
    const m = /^(?:npm|jsr):((?:@[^@/]+\/)?[^@]+)@(.+)$/.exec(k)
    // v3 values are `npm:react@19.2.5`; v4+ are `19.2.5` (with an optional `_peer` suffix).
    const ver = v.replace(/^(?:npm|jsr):(?:@[^@/]+\/)?[^@]+@/, '').replace(/_.*$/, '')
    if (m && /^\d/.test(ver)) add(map, m[1], { version: ver, specs: [m[2]] })
  }
  return map
}

/* ─────────── TOML [[package]] (poetry, uv, Cargo) ─────────── */

export function parseTomlPackages(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  let name: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '[[package]]') {
      name = undefined
      continue
    }
    const n = /^name\s*=\s*"([^"]+)"/.exec(line)
    if (n) {
      name = n[1]
      continue
    }
    const v = /^version\s*=\s*"([^"]+)"/.exec(line)
    if (v && name) {
      add(map, name, { version: v[1] })
      name = undefined
    }
  }
  return map
}

/* ─────────── Pipfile.lock / composer.lock (JSON) ─────────── */

export function parsePipfileLock(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  try {
    const json = JSON.parse(text) as Record<string, Record<string, { version?: string }>>
    for (const group of ['default', 'develop']) {
      for (const [name, v] of Object.entries(json[group] ?? {})) {
        const ver = v.version?.replace(/^==/, '')
        if (ver && /^\d/.test(ver)) add(map, name, { version: ver })
      }
    }
  } catch {
    /* not JSON */
  }
  return map
}

export function parseComposerLock(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  try {
    const json = JSON.parse(text) as { packages?: Array<{ name: string; version: string }>; 'packages-dev'?: Array<{ name: string; version: string }> }
    for (const p of [...(json.packages ?? []), ...(json['packages-dev'] ?? [])]) {
      const v = p.version.replace(/^v(?=\d)/, '')
      if (/^\d/.test(v)) add(map, p.name, { version: v })
    }
  } catch {
    /* not JSON */
  }
  return map
}

/* ─────────── Gemfile.lock / gradle.lockfile ─────────── */

/** Gemfile.lock `specs:` entries — four-space indent, `rails (7.1.3)`. */
export function parseGemfileLock(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  for (const m of text.matchAll(/^ {4}([\w.-]+) \((\d[^)\s-]*)(?:-[\w-]+)?\)\s*$/gm)) add(map, m[1], { version: m[2] })
  return map
}

/** gradle.lockfile: `org.springframework.boot:spring-boot:3.3.4=compileClasspath,runtimeClasspath`. */
export function parseGradleLockfile(text: string): Map<string, LockEntry[]> {
  const map = new Map<string, LockEntry[]>()
  for (const m of text.matchAll(/^([\w.-]+):([\w.-]+):([^=\s]+)=/gm)) add(map, `${m[1]}:${m[2]}`, { version: m[3] })
  return map
}

/** Parse one lockfile by name. Unknown names give an empty index. */
export function parseLockfile(path: string, text: string): LockIndex {
  const n = baseName(path).toLowerCase()
  const kinds: Record<string, [string, (t: string) => Map<string, LockEntry[]>]> = {
    'package-lock.json': ['npm', parsePackageLock],
    'npm-shrinkwrap.json': ['npm', parsePackageLock],
    'pnpm-lock.yaml': ['pnpm', parsePnpmLock],
    'yarn.lock': ['yarn', parseYarnLock],
    'bun.lock': ['bun', parseBunLock],
    'deno.lock': ['deno', parseDenoLock],
    'poetry.lock': ['poetry', parseTomlPackages],
    'uv.lock': ['uv', parseTomlPackages],
    'cargo.lock': ['cargo', parseTomlPackages],
    'pipfile.lock': ['pipenv', parsePipfileLock],
    'composer.lock': ['composer', parseComposerLock],
    'gemfile.lock': ['bundler', parseGemfileLock],
    'gradle.lockfile': ['gradle', parseGradleLockfile],
  }
  const hit = kinds[n]
  return { source: path, kind: hit?.[0] ?? 'unknown', packages: hit ? hit[1](text) : new Map() }
}

/** Lockfiles to read for the scanned folders: same folder first, then ancestors. */
export function lockfilesFor(listing: string[], dirs: string[], sizes?: Map<string, number>, max = 4): string[] {
  const out: string[] = []
  const chain = (d: string) => {
    const parts = d ? d.split('/') : []
    const list = [d]
    for (let i = parts.length - 1; i >= 0; i--) list.push(parts.slice(0, i).join('/'))
    return [...new Set(list)]
  }
  for (const d of dirs) {
    for (const anc of chain(d)) {
      for (const p of listing) {
        if (dirOf(p) !== anc || !LOCKFILE_NAMES.has(baseName(p).toLowerCase())) continue
        if ((sizes?.get(p) ?? 0) > MAX_LOCKFILE_BYTES) continue
        if (!out.includes(p)) out.push(p)
      }
    }
  }
  return out.slice(0, max)
}

/* ─────────── tech key → package coordinates ─────────── */

/**
 * Which package carries a tech's version, per ecosystem. Used to resolve a
 * tech that was not found through a dependency line (Spring Boot from the
 * parent POM, TypeScript) and to map SBOM components back to techs.
 */
export const TECH_PACKAGES: Record<string, string[]> = {
  'spring-boot': ['org.springframework.boot:spring-boot'],
  spring: ['org.springframework:spring-core'],
  'spring-cloud': ['org.springframework.cloud:spring-cloud-commons'],
  'spring-security': ['org.springframework.security:spring-security-core'],
  quarkus: ['io.quarkus:quarkus-core'],
  micronaut: ['io.micronaut:micronaut-core'],
  kotlin: ['org.jetbrains.kotlin:kotlin-stdlib'],
  jpa: ['org.hibernate.orm:hibernate-core', 'org.hibernate:hibernate-core'],
  flyway: ['org.flywaydb:flyway-core'],
  liquibase: ['org.liquibase:liquibase-core'],
  junit: ['org.junit.jupiter:junit-jupiter-api', 'junit:junit'],
  log4j: ['org.apache.logging.log4j:log4j-core'],
  logback: ['ch.qos.logback:logback-classic'],
  micrometer: ['io.micrometer:micrometer-core'],
  grpc: ['io.grpc:grpc-core', '@grpc/grpc-js', 'grpcio', 'google.golang.org/grpc'],
  react: ['react'],
  next: ['next'],
  vue: ['vue'],
  svelte: ['svelte'],
  angular: ['@angular/core'],
  nestjs: ['@nestjs/core'],
  express: ['express'],
  fastify: ['fastify'],
  hono: ['hono'],
  koa: ['koa'],
  nuxt: ['nuxt'],
  astro: ['astro'],
  remix: ['@remix-run/react', '@remix-run/node'],
  tanstack: ['@tanstack/react-router', '@tanstack/react-start'],
  typescript: ['typescript'],
  vite: ['vite'],
  webpack: ['webpack'],
  tailwind: ['tailwindcss'],
  jest: ['jest'],
  vitest: ['vitest'],
  mocha: ['mocha'],
  playwright: ['@playwright/test', 'playwright'],
  cypress: ['cypress'],
  eslint: ['eslint'],
  prettier: ['prettier'],
  biome: ['@biomejs/biome'],
  prisma: ['@prisma/client', 'prisma'],
  typeorm: ['typeorm'],
  sequelize: ['sequelize'],
  drizzle: ['drizzle-orm'],
  django: ['django'],
  fastapi: ['fastapi'],
  flask: ['flask'],
  sqlalchemy: ['sqlalchemy'],
  pytest: ['pytest'],
  ruff: ['ruff'],
  black: ['black'],
  mypy: ['mypy'],
  gin: ['github.com/gin-gonic/gin'],
  echo: ['github.com/labstack/echo/v4', 'github.com/labstack/echo'],
  fiber: ['github.com/gofiber/fiber/v2', 'github.com/gofiber/fiber/v3'],
  gorm: ['gorm.io/gorm'],
  testify: ['github.com/stretchr/testify'],
  actix: ['actix-web'],
  axum: ['axum'],
  rocket: ['rocket'],
  rails: ['rails'],
  rspec: ['rspec-core', 'rspec'],
  laravel: ['laravel/framework'],
  symfony: ['symfony/framework-bundle'],
  phpunit: ['phpunit/phpunit'],
  phoenix: ['phoenix'],
}

/** Highest of several versions (numeric dotted compare; pre-release sorts before release). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split(/[-+]/)[0].split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  const preA = /-/.test(a)
  const preB = /-/.test(b)
  return preA === preB ? 0 : preA ? -1 : 1
}

/** The entry a declared range resolved to: the one recording that range, else the importer's, else the highest. */
function pick(entries: LockEntry[], spec: string | undefined, importer: string | undefined): LockEntry | undefined {
  if (!entries.length) return undefined
  const s = spec ? cleanRange(spec) : undefined
  const bySpec = s ? entries.filter((e) => e.specs?.includes(s)) : []
  const pool = bySpec.length ? bySpec : entries
  const byImporter = importer != null ? pool.filter((e) => e.importer === importer) : []
  const pool2 = byImporter.length ? byImporter : pool.some((e) => e.importer) ? pool.filter((e) => e.importer === '.' || !e.importer) : pool
  const list = pool2.length ? pool2 : pool
  return [...list].sort((a, b) => compareVersions(b.version, a.version))[0]
}

/** Relative importer path of a manifest dir under a lockfile dir (pnpm workspaces). */
function importerOf(manifestDir: string, lockDir: string): string {
  if (manifestDir === lockDir) return '.'
  return lockDir ? manifestDir.slice(lockDir.length + 1) : manifestDir
}

/**
 * Attach the exact version a lockfile pins to every detected tech that has
 * a package behind it. The lockfile nearest the manifest wins (same folder,
 * then the closest ancestor). A tech whose declared version is already
 * exact still gets `resolved` when the lock agrees, so the UI can say so.
 */
export function resolveWithLocks(tech: DetectedTech[], locks: LockIndex[]): DetectedTech[] {
  if (!locks.length) return tech
  return tech.map((t) => {
    const pkgs = t.pkg ? [t.pkg] : TECH_PACKAGES[t.key] ?? []
    if (!pkgs.length) return t
    const manifestDir = dirOf(t.source)
    const candidates = locks
      .filter((l) => {
        const ld = dirOf(l.source)
        return manifestDir === ld || ld === '' || manifestDir.startsWith(`${ld}/`)
      })
      .sort((a, b) => dirOf(b.source).length - dirOf(a.source).length)
    for (const lock of candidates) {
      for (const pkg of pkgs) {
        const entries = lock.packages.get(normalizePkg(pkg))
        const hit = entries ? pick(entries, t.spec, importerOf(manifestDir, dirOf(lock.source))) : undefined
        if (hit) return { ...t, resolved: { version: hit.version, source: lock.source, detail: `${pkg} in ${lock.kind} lockfile` } }
      }
    }
    return t
  })
}
