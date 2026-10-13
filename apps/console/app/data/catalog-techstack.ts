/**
 * Tech-stack detection from a repository's own files.
 *
 * Catalog tags say *what* a service is built with (`java`, `spring-boot`) but
 * rarely *which version* — the scaffolder and the Gitea sync both tag the
 * language without one. The build files always know: `pom.xml` names the
 * Spring Boot parent and the Java release, `build.gradle` the plugin version
 * and the toolchain, `go.mod` its `go` directive. This module reads those
 * files (already fetched — it does no I/O) and reports each technology with
 * a version and the file it came from, so a wrong number can be traced to
 * the line that set it.
 *
 * Keys are the canonical lowercase tech keys the catalog's TECH_MAP knows
 * (`java`, `spring-boot`, `node`, …). Every mention carries a rank — build
 * manifests outrank version-pin files, which outrank container base images —
 * and `mergeDetections` keeps the best-ranked version per tech while keeping
 * the disagreeing ones as `also`, because "pom.xml says 17, the Dockerfile
 * runs 21" is exactly the thing a reader wants to see.
 */

export interface TechMention {
  /** Canonical tech key, e.g. `java`, `spring-boot`. */
  key: string
  version?: string
  /** Repository path the mention came from. */
  source: string
  /** How it was read, e.g. `<parent> spring-boot-starter-parent`. */
  detail?: string
  /** Lower is more authoritative. */
  rank: number
}

export interface DetectedTech {
  key: string
  version?: string
  source: string
  detail?: string
  /** Other versions found elsewhere in the repository that disagree. */
  also: Array<{ version: string; source: string; detail?: string }>
}

/** Build manifests: what the build actually compiles against. */
const RANK_BUILD = 10
/** Version-pin files (.java-version, .sdkmanrc, .nvmrc, …). */
const RANK_PIN = 20
/** Container base images — what it runs on, not what it targets. */
const RANK_IMAGE = 30
/** Present, but only inferred from a dependency or a file's existence. */
const RANK_HINT = 40

/* ─────────── which files to read ─────────── */

const EXACT_FILES = new Set([
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  '.java-version',
  '.sdkmanrc',
  '.tool-versions',
  'package.json',
  '.nvmrc',
  '.node-version',
  'deno.json',
  'deno.jsonc',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'pipfile',
  '.python-version',
  'runtime.txt',
  'cargo.toml',
  'rust-toolchain',
  'rust-toolchain.toml',
  'gemfile',
  '.ruby-version',
  'composer.json',
  'global.json',
  'mix.exs',
  'dockerfile',
  'containerfile',
])

/** Files whose mere presence says something; never read. */
const PRESENCE: Array<{ re: RegExp; key: string; detail: string }> = [
  { re: /^tsconfig(\.[\w-]+)?\.json$/i, key: 'typescript', detail: 'tsconfig.json present' },
  { re: /^pnpm-lock\.yaml$/i, key: 'pnpm', detail: 'pnpm-lock.yaml present' },
  { re: /^yarn\.lock$/i, key: 'yarn', detail: 'yarn.lock present' },
  { re: /^package-lock\.json$/i, key: 'npm', detail: 'package-lock.json present' },
  { re: /^chart\.ya?ml$/i, key: 'helm', detail: 'Chart.yaml present' },
  { re: /^kustomization\.ya?ml$/i, key: 'kustomize', detail: 'kustomization.yaml present' },
  { re: /^mvnw$/i, key: 'maven', detail: 'Maven wrapper' },
  { re: /^gradlew$/i, key: 'gradle', detail: 'Gradle wrapper' },
]

const isDockerfile = (name: string) => /^(docker|container)file(\.[\w.-]+)?$/i.test(name) || /\.dockerfile$/i.test(name)
const isCsproj = (name: string) => /\.(cs|fs|vb)proj$/i.test(name)
const baseName = (p: string) => p.split('/').pop() ?? p

/**
 * The files worth reading, given a directory's listing. `blobs` and `dirs`
 * are paths (as the forge reports them); nested well-known paths — the
 * Gradle version catalog, the wrappers — are added when their folder exists.
 */
export function wantedFiles(blobs: string[], dirs: string[]): string[] {
  const out: string[] = []
  for (const p of blobs) {
    const n = baseName(p)
    if (EXACT_FILES.has(n.toLowerCase()) || isDockerfile(n) || isCsproj(n)) out.push(p)
  }
  const dirNames = new Map(dirs.map((d) => [baseName(d), d]))
  const gradle = dirNames.get('gradle')
  if (gradle) out.push(`${gradle}/libs.versions.toml`, `${gradle}/wrapper/gradle-wrapper.properties`)
  const mvn = dirNames.get('.mvn')
  if (mvn) out.push(`${mvn}/wrapper/maven-wrapper.properties`)
  return out
}

/** True when a listing holds a build manifest — used to decide whether to look one level deeper. */
export function hasManifest(blobs: string[]): boolean {
  return blobs.some((p) =>
    /^(pom\.xml|build\.gradle(\.kts)?|package\.json|go\.mod|pyproject\.toml|requirements\.txt|cargo\.toml|gemfile|composer\.json|mix\.exs)$/i.test(baseName(p)) ||
    isCsproj(baseName(p))
  )
}

/* ─────────── version helpers ─────────── */

/** `1.8` → `8`, `VERSION_1_8` → `8`, `17` → `17`. Java dropped the `1.` prefix in 9. */
export function normalizeJava(v: string): string {
  const s = v.trim().replace(/^VERSION_/i, '').replace(/_/g, '.')
  const m = /^1\.(\d+)(.*)$/.exec(s)
  return m && Number(m[1]) <= 8 ? m[1] + m[2] : s
}

/**
 * A dependency spec as a version a person reads: `^18.2.0` → `18.2.0`,
 * `>=3.11,<3.13` → `3.11+`, `~> 7.1` → `7.1`, `==5.0.*` → `5.0`. Returns
 * undefined for specs with no number (`*`, `latest`, a git URL).
 */
export function cleanSpec(spec: string | undefined): string | undefined {
  if (!spec) return undefined
  const s = spec.trim().replace(/^['"]|['"]$/g, '')
  const m = /(\d+(?:\.\d+)*)/.exec(s)
  if (!m) return undefined
  const lead = s.slice(0, m.index).trim()
  return /^>=?$/.test(lead) || (/^>=/.test(lead)) ? `${m[1]}+` : m[1]
}

/** A literal version as written, minus quotes and a leading `v`. */
function literal(v: string | undefined): string | undefined {
  const s = v?.trim().replace(/^['"]|['"]$/g, '').replace(/^v(?=\d)/, '')
  return s && /\d/.test(s) && !/[${}]/.test(s) ? s : undefined
}

const NODE_LTS: Record<string, string> = {
  argon: '4', boron: '6', carbon: '8', dubnium: '10', erbium: '12', fermium: '14', gallium: '16', hydrogen: '18', iron: '20', jod: '22', krypton: '24',
}

/* ─────────── dependency → tech signals ─────────── */

/**
 * Library names that imply a framework or datastore. Matched against the
 * full coordinate (`org.postgresql:postgresql`, `github.com/jackc/pgx/v5`,
 * `psycopg2-binary`), so the patterns are anchored to the name part.
 */
const DEP_SIGNALS: Array<{ re: RegExp; key: string; versioned?: boolean }> = [
  { re: /(^|[:/])(postgresql|pgx(\/v\d+)?|pq|pg|psycopg2?(-binary)?|psycopg|asyncpg|r2dbc-postgresql)$/i, key: 'postgres' },
  { re: /(^|[:/])(mysql-connector-(j|java)|mysql2?|go-sql-driver\/mysql|mysqlclient|pymysql)$/i, key: 'mysql' },
  { re: /(^|[:/])(mariadb-java-client|mariadb)$/i, key: 'mariadb' },
  { re: /(^|[:/])(spring-boot-starter-data-mongodb(-reactive)?|mongodb-driver-\w+|mongodb|mongoose|pymongo|motor|mongo-driver)$/i, key: 'mongodb' },
  { re: /(^|[:/])(spring-boot-starter-data-redis(-reactive)?|jedis|lettuce-core|redis|ioredis|go-redis(\/v\d+)?|redis-py)$/i, key: 'redis' },
  { re: /(^|[:/])(spring-kafka|kafka-clients|kafkajs|kafka-python|confluent-kafka(-go)?|kafka-go|sarama)$/i, key: 'kafka' },
  { re: /(^|[:/])(spring-boot-starter-amqp|amqp-client|amqplib|pika|amqp091-go)$/i, key: 'rabbitmq' },
  { re: /(^|[:/])(elasticsearch(-java)?|spring-boot-starter-data-elasticsearch|@elastic\/elasticsearch)$/i, key: 'elasticsearch' },
  { re: /(^|[:/])(grpc-[\w-]+|@grpc\/grpc-js|grpcio|grpc)$/i, key: 'grpc' },
  { re: /(^|[:/])(spring-boot-starter-graphql|graphql-java|graphql|graphene|gqlgen)$/i, key: 'graphql' },
  { re: /(^|[:/])(opentelemetry-[\w-]+|@opentelemetry\/[\w-]+|otel(\/[\w-]+)?)$/i, key: 'otel' },
  { re: /(^|[:/])(micrometer-registry-prometheus|prom-client|prometheus-client|prometheus_client|client_golang)$/i, key: 'prometheus' },
  // frameworks that also carry a useful version of their own
  { re: /^(express)$/i, key: 'express', versioned: true },
  { re: /^(react)$/i, key: 'react', versioned: true },
  { re: /^(next)$/i, key: 'next', versioned: true },
  { re: /^(vue)$/i, key: 'vue', versioned: true },
  { re: /^(svelte)$/i, key: 'svelte', versioned: true },
  { re: /^(@angular\/core)$/i, key: 'angular', versioned: true },
  { re: /^(@nestjs\/core)$/i, key: 'nestjs', versioned: true },
  { re: /^(fastify)$/i, key: 'fastify', versioned: true },
  { re: /^(django)$/i, key: 'django', versioned: true },
  { re: /^(fastapi)$/i, key: 'fastapi', versioned: true },
  { re: /^(flask)$/i, key: 'flask', versioned: true },
  { re: /(^|\/)gin-gonic\/gin$/i, key: 'gin', versioned: true },
  { re: /(^|\/)labstack\/echo(\/v\d+)?$/i, key: 'echo', versioned: true },
  { re: /(^|\/)gofiber\/fiber(\/v\d+)?$/i, key: 'fiber', versioned: true },
  { re: /^(actix-web)$/i, key: 'actix', versioned: true },
  { re: /^(axum)$/i, key: 'axum', versioned: true },
  { re: /^(rocket)$/i, key: 'rocket', versioned: true },
  { re: /^(rails)$/i, key: 'rails', versioned: true },
  { re: /^(laravel\/framework)$/i, key: 'laravel', versioned: true },
  { re: /^(symfony\/framework-bundle)$/i, key: 'symfony', versioned: true },
  { re: /^(phoenix)$/i, key: 'phoenix', versioned: true },
]

function depMentions(deps: Array<{ name: string; version?: string }>, source: string): TechMention[] {
  const out: TechMention[] = []
  for (const d of deps) {
    for (const s of DEP_SIGNALS) {
      if (!s.re.test(d.name)) continue
      out.push({ key: s.key, version: s.versioned ? d.version : undefined, source, detail: `dependency ${d.name}`, rank: s.versioned ? RANK_BUILD : RANK_HINT })
      break
    }
  }
  return out
}

/* ─────────── Maven ─────────── */

const stripXmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '')

function xmlBlocks(s: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  return [...s.matchAll(re)].map((m) => m[1])
}
function xmlText(s: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${tag}>`).exec(s)
  return m ? m[1] : undefined
}

/** `${a}` placeholders, resolved against a property map (nested, bounded). */
function interpolate(v: string | undefined, props: Record<string, string>): string | undefined {
  if (v == null) return undefined
  let out = v
  for (let i = 0; i < 6 && /\$\{[^}]+\}/.test(out); i++) out = out.replace(/\$\{([^}]+)\}/g, (all, k: string) => props[k.trim()] ?? all)
  return out
}

interface PomCoord {
  groupId?: string
  artifactId?: string
  version?: string
}

/** Parse a pom.xml into the mentions it implies. */
export function parsePom(xml: string, source = 'pom.xml'): TechMention[] {
  const s = stripXmlComments(xml)
  const out: TechMention[] = []
  const props: Record<string, string> = {}
  for (const block of xmlBlocks(s, 'properties')) {
    for (const m of block.matchAll(/<([A-Za-z0-9_.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props[m[1]] = m[2]
  }
  const parentBlock = xmlBlocks(s, 'parent')[0]
  const parent: PomCoord | undefined = parentBlock
    ? { groupId: xmlText(parentBlock, 'groupId'), artifactId: xmlText(parentBlock, 'artifactId'), version: xmlText(parentBlock, 'version') }
    : undefined
  if (parent?.version) {
    props['project.parent.version'] = parent.version
    props['parent.version'] = parent.version
  }
  const coord = (b: string): PomCoord => ({
    groupId: interpolate(xmlText(b, 'groupId'), props),
    artifactId: interpolate(xmlText(b, 'artifactId'), props),
    version: interpolate(xmlText(b, 'version'), props),
  })
  const deps = xmlBlocks(s, 'dependency').map(coord)
  const plugins = xmlBlocks(s, 'plugin').map((b) => ({ ...coord(b), body: b }))
  const prop = (...keys: string[]) => {
    for (const k of keys) {
      const v = literal(interpolate(props[k], props))
      if (v) return { key: k, v }
    }
    return undefined
  }
  const push = (key: string, version: string | undefined, detail: string, rank = RANK_BUILD) =>
    out.push({ key, version: literal(version), source, detail, rank })

  // ── Spring Boot ──
  const bootParent = parent && (parent.artifactId === 'spring-boot-starter-parent' || (parent.groupId === 'org.springframework.boot' && parent.artifactId === 'spring-boot-dependencies'))
  const bootBom = deps.find((d) => d.artifactId === 'spring-boot-dependencies' && d.version)
  const bootPlugin = plugins.find((p) => p.artifactId === 'spring-boot-maven-plugin' && literal(p.version))
  const bootProp = prop('spring-boot.version', 'spring.boot.version', 'springboot.version', 'spring-boot-version', 'springBootVersion')
  const bootDep = deps.find((d) => d.groupId === 'org.springframework.boot' && literal(d.version))
  const usesBoot = bootParent || /org\.springframework\.boot/.test(s)
  if (bootParent && literal(interpolate(parent!.version, props))) push('spring-boot', interpolate(parent!.version, props), `<parent> ${parent!.artifactId}`)
  else if (bootBom) push('spring-boot', bootBom.version, 'spring-boot-dependencies BOM')
  else if (bootProp) push('spring-boot', bootProp.v, `<${bootProp.key}>`)
  else if (bootPlugin) push('spring-boot', bootPlugin.version, 'spring-boot-maven-plugin')
  else if (bootDep) push('spring-boot', bootDep.version, `dependency ${bootDep.artifactId}`)
  else if (usesBoot) {
    out.push({
      key: 'spring-boot',
      source,
      detail: parent?.artifactId ? `managed by parent ${parent.groupId ?? ''}:${parent.artifactId}${parent.version ? `:${parent.version}` : ''}` : 'Spring Boot dependencies',
      rank: RANK_BUILD,
    })
  }

  // ── Spring Cloud ──
  const cloudBom = deps.find((d) => d.artifactId === 'spring-cloud-dependencies')
  const cloudProp = prop('spring-cloud.version', 'spring.cloud.version', 'springCloudVersion')
  if (cloudBom && literal(cloudBom.version)) push('spring-cloud', cloudBom.version, 'spring-cloud-dependencies BOM')
  else if (cloudProp) push('spring-cloud', cloudProp.v, `<${cloudProp.key}>`)
  else if (/org\.springframework\.cloud/.test(s)) out.push({ key: 'spring-cloud', source, detail: 'Spring Cloud dependencies', rank: RANK_BUILD })

  // ── Java ──
  const javaProp = prop('maven.compiler.release', 'java.version', 'maven.compiler.source', 'maven.compiler.target', 'jdk.version', 'java.release', 'javaVersion')
  const compiler = plugins.find((p) => p.artifactId === 'maven-compiler-plugin')
  const compilerCfg = compiler ? xmlBlocks(compiler.body, 'configuration')[0] : undefined
  const compilerRelease = compilerCfg && (interpolate(xmlText(compilerCfg, 'release'), props) ?? interpolate(xmlText(compilerCfg, 'source'), props))
  if (javaProp) push('java', normalizeJava(javaProp.v), `<${javaProp.key}>`)
  else if (literal(compilerRelease)) push('java', normalizeJava(compilerRelease!), 'maven-compiler-plugin configuration')
  else if (bootParent) {
    // The Boot parent sets java.version itself: 17 since Boot 3, 1.8 before.
    const major = Number(/^(\d+)/.exec(literal(interpolate(parent!.version, props)) ?? '')?.[1])
    const dflt = major >= 3 ? '17' : major ? '8' : undefined
    out.push({ key: 'java', version: dflt, source, detail: 'java.version default of spring-boot-starter-parent', rank: RANK_HINT })
  }
  else out.push({ key: 'java', source, detail: 'Maven project', rank: RANK_HINT })

  // ── Kotlin ──
  const kotlinProp = prop('kotlin.version')
  const kotlinPlugin = plugins.find((p) => p.artifactId === 'kotlin-maven-plugin')
  if (kotlinProp) push('kotlin', kotlinProp.v, '<kotlin.version>')
  else if (kotlinPlugin) push('kotlin', kotlinPlugin.version, 'kotlin-maven-plugin', literal(kotlinPlugin.version) ? RANK_BUILD : RANK_HINT)

  // ── Quarkus / Micronaut ──
  const quarkusProp = prop('quarkus.platform.version', 'quarkus.version', 'quarkus-plugin.version')
  if (quarkusProp) push('quarkus', quarkusProp.v, `<${quarkusProp.key}>`)
  else if (/io\.quarkus/.test(s)) out.push({ key: 'quarkus', source, detail: 'io.quarkus dependencies', rank: RANK_BUILD })
  const microProp = prop('micronaut.version')
  if (parent?.artifactId === 'micronaut-parent' && literal(parent.version)) push('micronaut', parent.version, '<parent> micronaut-parent')
  else if (microProp) push('micronaut', microProp.v, '<micronaut.version>')
  else if (/io\.micronaut/.test(s)) out.push({ key: 'micronaut', source, detail: 'io.micronaut dependencies', rank: RANK_BUILD })

  out.push({ key: 'maven', source, detail: 'pom.xml', rank: RANK_HINT })
  out.push(...depMentions(deps.filter((d) => d.artifactId).map((d) => ({ name: `${d.groupId ?? ''}:${d.artifactId}`, version: literal(d.version) })), source))
  return out
}

/* ─────────── Gradle ─────────── */

export interface VersionCatalog {
  versions: Record<string, string>
  libraries: Array<{ module: string; version?: string }>
  plugins: Array<{ id: string; version?: string }>
}

/** The `gradle/libs.versions.toml` subset that matters: versions, libraries, plugins. */
export function parseVersionCatalog(toml: string): VersionCatalog {
  const cat: VersionCatalog = { versions: {}, libraries: [], plugins: [] }
  let section = ''
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const sec = /^\[([\w.-]+)\]$/.exec(line)
    if (sec) {
      section = sec[1]
      continue
    }
    const kv = /^"?([\w.-]+)"?\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const [, key, value] = kv
    const str = /^"([^"]*)"$/.exec(value)?.[1] ?? /^'([^']*)'$/.exec(value)?.[1]
    const table: Record<string, string> = {}
    if (value.startsWith('{')) for (const m of value.matchAll(/([\w.]+)\s*=\s*["']([^"']*)["']/g)) table[m[1]] = m[2]
    const ver = (t: Record<string, string>) => t['version.ref'] ? cat.versions[t['version.ref']] : t.version ?? t['version.strictly'] ?? t['version.require']
    if (section === 'versions') {
      if (str != null) cat.versions[key] = str
      else if (table.strictly || table.require || table.prefer) cat.versions[key] = table.strictly ?? table.require ?? table.prefer
    } else if (section === 'libraries') {
      if (str != null) {
        const [g, a, v] = str.split(':')
        cat.libraries.push({ module: `${g}:${a}`, version: v })
      } else if (table.module || (table.group && table.name)) {
        cat.libraries.push({ module: table.module ?? `${table.group}:${table.name}`, version: ver(table) })
      }
    } else if (section === 'plugins') {
      if (str != null) {
        const [id, v] = str.split(':')
        cat.plugins.push({ id, version: v })
      } else if (table.id) cat.plugins.push({ id: table.id, version: ver(table) })
    }
  }
  return cat
}

/** `key=value` lines of a .properties file. */
function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2]
  }
  return out
}

/**
 * Parse Gradle build scripts (Groovy or Kotlin DSL) into mentions. `script`
 * is the build file; `extra` carries the other files a Gradle build reads
 * versions from — gradle.properties and the version catalog.
 */
export function parseGradle(
  script: string,
  source = 'build.gradle',
  extra: { properties?: string; catalog?: string; catalogSource?: string; propertiesSource?: string } = {},
): TechMention[] {
  const s = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1')
  const out: TechMention[] = []
  const props: Record<string, string> = extra.properties ? parseProperties(extra.properties) : {}
  // Which properties the script itself declares, so a version is attributed to the right file.
  const inScript = new Set<string>()
  // ext { springBootVersion = '3.3.2' } · ext.x = '…' · val x = "…" · set('x', "…") · extra["x"] = "…"
  const declare = (k: string, v: string) => {
    // A script-level declaration overrides gradle.properties; the first one wins.
    if (inScript.has(k)) return
    props[k] = v
    inScript.add(k)
  }
  for (const m of s.matchAll(/(?:^|[\s{;])(?:ext\.|val\s+|def\s+|extra\.)?([A-Za-z_][\w]*)\s*=\s*['"]([^'"$]+)['"]/gm)) declare(m[1], m[2])
  for (const m of s.matchAll(/set\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g)) declare(m[1], m[2])
  for (const m of s.matchAll(/extra\[\s*"([\w.-]+)"\s*\]\s*=\s*"([^"]+)"/g)) declare(m[1], m[2])
  const cat = extra.catalog ? parseVersionCatalog(extra.catalog) : undefined
  const catSource = extra.catalogSource ?? 'gradle/libs.versions.toml'
  const propSource = extra.propertiesSource ?? 'gradle.properties'
  const interp = (v: string | undefined) =>
    v?.replace(/\$\{?([\w.]+)\}?/g, (all, k: string) => props[k] ?? all).replace(/\$\{property\(["'](\w+)["']\)\}/g, (all, k: string) => props[k] ?? all)
  const push = (key: string, version: string | undefined, detail: string, src = source, rank = RANK_BUILD) =>
    out.push({ key, version: literal(version), source: src, detail, rank })
  /** A plugin applied by id, with the version the script (or catalog) gives it. */
  const pluginVersion = (id: string): { v?: string; how: string; src: string } | undefined => {
    const esc = id.replace(/\./g, '\\.')
    const m = new RegExp(`id\\s*\\(?\\s*['"]${esc}['"]\\s*\\)?\\s*version\\s*\\(?\\s*['"]([^'"]+)['"]`).exec(s)
    if (m) return { v: interp(m[1]), how: `plugin ${id}`, src: source }
    const fromCat = cat?.plugins.find((p) => p.id === id)
    if (fromCat) return { v: fromCat.version, how: `plugin ${id}`, src: catSource }
    if (new RegExp(`['"]${esc}['"]`).test(s)) return { how: `plugin ${id}`, src: source }
    return undefined
  }
  const fromProps = (...keys: string[]) => {
    for (const k of keys) if (literal(props[k])) return { k, v: props[k], src: inScript.has(k) ? source : propSource }
    return undefined
  }
  const catVersion = (...keys: string[]) => {
    for (const k of keys) if (cat?.versions[k]) return { k, v: cat.versions[k] }
    return undefined
  }

  // ── Spring Boot ──
  const bootPlugin = pluginVersion('org.springframework.boot')
  const bootClasspath = /org\.springframework\.boot:spring-boot-(?:gradle-plugin|dependencies):([^'")\s]+)/.exec(s)
  const bootProp = fromProps('springBootVersion', 'spring_boot_version', 'spring.boot.version', 'springbootVersion')
  const bootCat = catVersion('spring-boot', 'springBoot', 'springboot', 'spring_boot')
  if (bootPlugin?.v && literal(bootPlugin.v)) push('spring-boot', bootPlugin.v, bootPlugin.how, bootPlugin.src)
  else if (bootClasspath && literal(interp(bootClasspath[1]))) push('spring-boot', interp(bootClasspath[1]), 'spring-boot-gradle-plugin classpath')
  else if (bootProp) push('spring-boot', bootProp.v, bootProp.k, bootProp.src)
  else if (bootCat) push('spring-boot', bootCat.v, `[versions] ${bootCat.k}`, catSource)
  else if (bootPlugin || /org\.springframework\.boot/.test(s) || cat?.libraries.some((l) => l.module.startsWith('org.springframework.boot:'))) {
    out.push({ key: 'spring-boot', source, detail: 'Spring Boot dependencies', rank: RANK_BUILD })
  }

  // ── Spring Cloud ──
  const cloudProp = fromProps('springCloudVersion', 'spring_cloud_version', 'spring.cloud.version')
  const cloudBom = /org\.springframework\.cloud:spring-cloud-dependencies:([^'")\s]+)/.exec(s)
  const cloudCat = catVersion('spring-cloud', 'springCloud', 'spring-cloud-dependencies')
  if (cloudBom && literal(interp(cloudBom[1]))) push('spring-cloud', interp(cloudBom[1]), 'spring-cloud-dependencies BOM')
  else if (cloudProp) push('spring-cloud', cloudProp.v, cloudProp.k, cloudProp.src)
  else if (cloudCat) push('spring-cloud', cloudCat.v, `[versions] ${cloudCat.k}`, catSource)
  else if (/org\.springframework\.cloud/.test(s)) out.push({ key: 'spring-cloud', source, detail: 'Spring Cloud dependencies', rank: RANK_BUILD })

  // ── Java ── toolchain › source/targetCompatibility › Kotlin jvmTarget
  const toolchain = /languageVersion\s*(?:=|\.set\(|\.value\()\s*JavaLanguageVersion\.of\(\s*['"]?(\d+)['"]?\s*\)/.exec(s)
  const kToolchain = /jvmToolchain\(\s*(\d+)\s*\)/.exec(s)
  const compat = /sourceCompatibility\s*=\s*(?:JavaVersion\.(VERSION_[\d_]+)|JavaVersion\.toVersion\(\s*['"]?([\d.]+)['"]?\s*\)|['"]?([\d.]+)['"]?)/.exec(s)
  const target = /targetCompatibility\s*=\s*(?:JavaVersion\.(VERSION_[\d_]+)|JavaVersion\.toVersion\(\s*['"]?([\d.]+)['"]?\s*\)|['"]?([\d.]+)['"]?)/.exec(s)
  const jvmTarget = /jvmTarget(?:\.set\(|\s*=\s*)\s*(?:JvmTarget\.JVM_([\d_]+)|['"]([\d.]+)['"])/.exec(s)
  const javaProp = fromProps('javaVersion', 'java_version', 'java.version', 'jdkVersion')
  const javaCat = catVersion('java', 'jdk', 'javaVersion')
  if (toolchain) push('java', toolchain[1], 'java toolchain languageVersion')
  else if (kToolchain) push('java', kToolchain[1], 'kotlin jvmToolchain')
  else if (compat) push('java', normalizeJava(compat[1] ?? compat[2] ?? compat[3]), 'sourceCompatibility')
  else if (target) push('java', normalizeJava(target[1] ?? target[2] ?? target[3]), 'targetCompatibility')
  else if (jvmTarget) push('java', normalizeJava(jvmTarget[1] ?? jvmTarget[2]), 'kotlin jvmTarget')
  else if (javaProp) push('java', normalizeJava(javaProp.v), javaProp.k, javaProp.src)
  else if (javaCat) push('java', normalizeJava(javaCat.v), `[versions] ${javaCat.k}`, catSource)
  else if (/\bjava\b|org\.springframework|application\b/.test(s)) out.push({ key: 'java', source, detail: 'Gradle JVM project', rank: RANK_HINT })

  // ── Kotlin ──
  const kDsl = /kotlin\(\s*["'](?:jvm|plugin\.spring|android|multiplatform)["']\s*\)\s*version\s*["']([^"']+)["']/.exec(s)
  const kPlugin = pluginVersion('org.jetbrains.kotlin.jvm') ?? pluginVersion('org.jetbrains.kotlin.plugin.spring') ?? pluginVersion('org.jetbrains.kotlin.android')
  const kProp = fromProps('kotlinVersion', 'kotlin_version', 'kotlin.version')
  const kCat = catVersion('kotlin')
  const kClasspath = /org\.jetbrains\.kotlin:kotlin-gradle-plugin:([^'")\s]+)/.exec(s)
  if (kDsl) push('kotlin', interp(kDsl[1]), 'kotlin("jvm") plugin')
  else if (kPlugin?.v && literal(interp(kPlugin.v))) push('kotlin', interp(kPlugin.v), kPlugin.how, kPlugin.src)
  else if (kClasspath && literal(interp(kClasspath[1]))) push('kotlin', interp(kClasspath[1]), 'kotlin-gradle-plugin classpath')
  else if (kProp) push('kotlin', kProp.v, kProp.k, kProp.src)
  else if (kCat && (kPlugin || /kotlin/.test(s))) push('kotlin', kCat.v, '[versions] kotlin', catSource)
  else if (kPlugin || /\bkotlin\(\s*["']jvm["']\s*\)/.test(s) || /org\.jetbrains\.kotlin/.test(s)) out.push({ key: 'kotlin', source, detail: 'Kotlin plugin', rank: RANK_HINT })

  // ── Quarkus / Micronaut ──
  const quarkus = pluginVersion('io.quarkus')
  const quarkusProp = fromProps('quarkusPlatformVersion', 'quarkusPluginVersion', 'quarkusVersion')
  if (quarkusProp) push('quarkus', quarkusProp.v, quarkusProp.k, quarkusProp.src)
  else if (quarkus?.v && literal(interp(quarkus.v))) push('quarkus', interp(quarkus.v), quarkus.how, quarkus.src)
  else if (quarkus || /io\.quarkus/.test(s)) out.push({ key: 'quarkus', source, detail: 'io.quarkus', rank: RANK_BUILD })
  const micronaut = pluginVersion('io.micronaut.application')
  const microProp = fromProps('micronautVersion', 'micronaut_version')
  if (microProp) push('micronaut', microProp.v, microProp.k, microProp.src)
  else if (micronaut?.v && literal(interp(micronaut.v))) push('micronaut', interp(micronaut.v), micronaut.how, micronaut.src)
  else if (micronaut || /io\.micronaut/.test(s)) out.push({ key: 'micronaut', source, detail: 'io.micronaut', rank: RANK_BUILD })

  out.push({ key: 'gradle', source, detail: baseName(source), rank: RANK_HINT })
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of s.matchAll(/['"]([\w.-]+):([\w.-]+)(?::([^'"@]+))?['"]/g)) deps.push({ name: `${m[1]}:${m[2]}`, version: literal(interp(m[3])) })
  for (const l of cat?.libraries ?? []) deps.push({ name: l.module, version: literal(l.version) })
  out.push(...depMentions(deps, source))
  return out
}

/** gradle-wrapper.properties / maven-wrapper.properties → the build tool's version. */
export function parseWrapper(text: string, source: string): TechMention[] {
  const url = parseProperties(text).distributionUrl ?? ''
  const g = /gradle-([\d.]+(?:-(?:rc|milestone)-\d+)?)-(?:bin|all)\.zip/.exec(url)
  if (g) return [{ key: 'gradle', version: g[1], source, detail: 'Gradle wrapper distributionUrl', rank: RANK_BUILD }]
  const m = /apache-maven-([\d.]+)-bin\.zip/.exec(url) ?? /apache-maven\/([\d.]+)\//.exec(url)
  if (m) return [{ key: 'maven', version: m[1], source, detail: 'Maven wrapper distributionUrl', rank: RANK_BUILD }]
  return []
}

/* ─────────── version-pin files ─────────── */

/** Tool names in .tool-versions (asdf/mise) and .sdkmanrc → tech keys. */
const PIN_TOOLS: Record<string, string> = {
  java: 'java', nodejs: 'node', node: 'node', python: 'python', golang: 'go', go: 'go', ruby: 'ruby', rust: 'rust',
  elixir: 'elixir', gradle: 'gradle', maven: 'maven', kotlin: 'kotlin', deno: 'deno', php: 'php', dotnet: 'dotnet', 'dotnet-core': 'dotnet', scala: 'scala',
}

/** `temurin-21.0.2` / `21.0.2-tem` / `corretto-17` → `21.0.2` / `17`. */
function pinVersion(tool: string, v: string): string | undefined {
  const num = /(\d+(?:\.\d+)*)/.exec(v)?.[1]
  if (!num) return undefined
  return tool === 'java' ? normalizeJava(num) : num
}

export function parseToolVersions(text: string, source = '.tool-versions'): TechMention[] {
  const out: TechMention[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([\w-]+)\s+(\S+)/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    const key = PIN_TOOLS[m[1].toLowerCase()]
    const v = key ? pinVersion(key, m[2]) : undefined
    if (key && v) out.push({ key, version: v, source, detail: `${m[1]} ${m[2]}`, rank: RANK_PIN })
  }
  return out
}

export function parseSdkmanrc(text: string, source = '.sdkmanrc'): TechMention[] {
  const out: TechMention[] = []
  for (const [tool, raw] of Object.entries(parseProperties(text))) {
    const key = PIN_TOOLS[tool.toLowerCase()]
    const v = key ? pinVersion(key, raw) : undefined
    if (key && v) out.push({ key, version: v, source, detail: `${tool}=${raw}`, rank: RANK_PIN })
  }
  return out
}

/** A single-value pin file: .java-version, .nvmrc, .python-version, … */
export function parsePinFile(key: string, text: string, source: string): TechMention[] {
  const raw = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  if (!raw) return []
  let v: string | undefined
  if (key === 'node') {
    const lts = /^lts\/(\w+)$/i.exec(raw)
    v = lts ? NODE_LTS[lts[1].toLowerCase()] : /^(\d+(?:\.\d+)*)/.exec(raw.replace(/^v/i, ''))?.[1]
  } else if (key === 'python') {
    v = /(\d+\.\d+(?:\.\d+)?)/.exec(raw)?.[1]
  } else v = pinVersion(key, raw)
  return v ? [{ key, version: v, source, detail: raw, rank: RANK_PIN }] : []
}

/* ─────────── Dockerfile ─────────── */

/** Base images → the runtime they carry. The version is read from the tag. */
const IMAGE_RUNTIMES: Array<{ re: RegExp; key: string }> = [
  { re: /(^|\/)(eclipse-temurin|openjdk|amazoncorretto|zulu-openjdk[\w-]*|liberica-openjdk[\w-]*|ibm-semeru-runtimes|sapmachine|ibmjava|jdk|jre)$/i, key: 'java' },
  { re: /(^|\/)node$/i, key: 'node' },
  { re: /(^|\/)python$/i, key: 'python' },
  { re: /(^|\/)golang$/i, key: 'go' },
  { re: /(^|\/)ruby$/i, key: 'ruby' },
  { re: /(^|\/)rust$/i, key: 'rust' },
  { re: /(^|\/)php$/i, key: 'php' },
  { re: /(^|\/)elixir$/i, key: 'elixir' },
  { re: /(^|\/)deno$/i, key: 'deno' },
  { re: /dotnet\/(aspnet|runtime|sdk|runtime-deps)$/i, key: 'dotnet' },
]

export function parseDockerfile(text: string, source = 'Dockerfile'): TechMention[] {
  const out: TechMention[] = []
  const args: Record<string, string> = {}
  const stages = new Set<string>()
  let last: string | undefined
  for (const raw of text.replace(/\\\r?\n/g, ' ').split('\n')) {
    const line = raw.trim()
    const arg = /^ARG\s+([\w]+)=["']?([^"'\s]+)["']?/i.exec(line)
    if (arg) {
      args[arg[1]] = arg[2]
      continue
    }
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line)
    if (!from) continue
    const ref = from[1].replace(/\$\{?(\w+)(?::-([^}]*))?\}?/g, (_all, k: string, dflt?: string) => args[k] ?? dflt ?? '')
    const fromStage = stages.has(ref.toLowerCase())
    if (from[2]) stages.add(from[2].toLowerCase())
    if (fromStage) continue
    const noDigest = ref.split('@')[0]
    const colon = noDigest.lastIndexOf(':')
    const hasTag = colon > noDigest.lastIndexOf('/')
    const name = hasTag ? noDigest.slice(0, colon) : noDigest
    const tag = hasTag ? noDigest.slice(colon + 1) : ''
    last = noDigest
    const firstNum = /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1]
    // Build-tool images carry a JDK too: maven:3.9.6-eclipse-temurin-21, gradle:8.8-jdk21.
    const jdkInTag = /(?:temurin|jdk|openjdk|corretto|java|zulu|liberica|semeru)-?(\d+)/i.exec(tag)?.[1]
    const distroless = /distroless\/java(\d+)/i.exec(name)?.[1]
    if (/(^|\/)maven$/i.test(name) || /(^|\/)gradle$/i.test(name)) {
      const tool = /maven$/i.test(name) ? 'maven' : 'gradle'
      if (firstNum) out.push({ key: tool, version: firstNum, source, detail: `FROM ${noDigest}`, rank: RANK_IMAGE })
      if (jdkInTag) out.push({ key: 'java', version: jdkInTag, source, detail: `FROM ${noDigest} (build stage)`, rank: RANK_IMAGE + 1 })
      continue
    }
    if (distroless) {
      out.push({ key: 'java', version: distroless, source, detail: `FROM ${noDigest}`, rank: RANK_IMAGE })
      continue
    }
    const hit = IMAGE_RUNTIMES.find((r) => r.re.test(name))
    if (!hit) continue
    const v = hit.key === 'java' ? (firstNum ? normalizeJava(firstNum) : jdkInTag) : firstNum
    out.push({ key: hit.key, version: v, source, detail: `FROM ${noDigest}`, rank: RANK_IMAGE })
  }
  // The final stage is the image that ships; earlier ones only build it.
  out.push({ key: 'docker', source, detail: last ? `final stage ${last}` : 'Dockerfile', rank: RANK_HINT })
  // Prefer the runtime stage's version for the same tech: re-rank so the last FROM wins ties.
  return out.map((m, i) => (m.rank === RANK_IMAGE ? { ...m, rank: RANK_IMAGE - i / 1000 } : m))
}

/* ─────────── Node / Deno ─────────── */

export function parsePackageJson(text: string, source = 'package.json'): TechMention[] {
  let pkg: {
    engines?: Record<string, string>
    packageManager?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    volta?: Record<string, string>
  }
  try {
    pkg = JSON.parse(text)
  } catch {
    return []
  }
  const out: TechMention[] = []
  const deps = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies }
  const node = pkg.volta?.node ? { v: pkg.volta.node, how: 'volta.node' } : pkg.engines?.node ? { v: pkg.engines.node, how: 'engines.node' } : undefined
  out.push({ key: 'node', version: cleanSpec(node?.v), source, detail: node ? `${node.how} ${node.v}` : 'package.json', rank: node ? RANK_BUILD : RANK_HINT })
  if (deps.typescript) out.push({ key: 'typescript', version: cleanSpec(deps.typescript), source, detail: `typescript ${deps.typescript}`, rank: RANK_BUILD })
  else out.push({ key: 'javascript', source, detail: 'package.json without TypeScript', rank: RANK_HINT })
  const pm = /^(pnpm|yarn|npm|bun)@(\S+)/.exec(pkg.packageManager ?? '')
  if (pm && pm[1] !== 'bun') out.push({ key: pm[1], version: cleanSpec(pm[2]), source, detail: `packageManager ${pkg.packageManager}`, rank: RANK_BUILD })
  if (pkg.engines?.pnpm) out.push({ key: 'pnpm', version: cleanSpec(pkg.engines.pnpm), source, detail: `engines.pnpm ${pkg.engines.pnpm}`, rank: RANK_BUILD })
  const list = Object.entries(deps).map(([name, spec]) => ({ name, version: cleanSpec(spec) }))
  // A Next.js app is a React app; both are worth a row. SvelteKit implies Svelte.
  if (deps['@sveltejs/kit'] && !deps.svelte) list.push({ name: 'svelte', version: undefined })
  out.push(...depMentions(list, source))
  return out
}

export function parseDenoJson(text: string, source = 'deno.json'): TechMention[] {
  const out: TechMention[] = [{ key: 'deno', source, detail: baseName(source), rank: RANK_HINT }, { key: 'typescript', source, detail: 'Deno project', rank: RANK_HINT }]
  // Imports pin frameworks the same way package.json dependencies do: "react": "npm:react@^19".
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of text.matchAll(/"(?:npm|jsr):(@?[\w./-]+?)@([^"/]+)/g)) deps.push({ name: m[1], version: cleanSpec(m[2]) })
  out.push(...depMentions(deps, source))
  return out
}

/* ─────────── Go ─────────── */

export function parseGoMod(text: string, source = 'go.mod'): TechMention[] {
  const out: TechMention[] = []
  const go = /^go\s+(\d+(?:\.\d+)*)/m.exec(text)
  const toolchain = /^toolchain\s+go(\d+(?:\.\d+)*)/m.exec(text)
  out.push({ key: 'go', version: go?.[1], source, detail: go ? `go ${go[1]} directive` : 'go.mod', rank: go ? RANK_BUILD : RANK_HINT })
  if (toolchain && toolchain[1] !== go?.[1]) out.push({ key: 'go', version: toolchain[1], source, detail: `toolchain go${toolchain[1]}`, rank: RANK_BUILD + 1 })
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v(\d[\w.+-]*)/gm)) deps.push({ name: m[1], version: m[2].replace(/[-+].*$/, '') })
  out.push(...depMentions(deps, source))
  return out
}

/* ─────────── Python ─────────── */

/** A PEP 508 requirement → name + version: `fastapi[all]>=0.110,<1` → fastapi / 0.110+. */
function pyReq(line: string): { name: string; version?: string } | undefined {
  const m = /^\s*([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*([^;#]*)/.exec(line)
  if (!m || /^-/.test(line.trim())) return undefined
  return { name: m[1].toLowerCase(), version: cleanSpec(m[2]) }
}

export function parsePyproject(text: string, source = 'pyproject.toml'): TechMention[] {
  const out: TechMention[] = []
  const req = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(text)
  const poetryPy = /\[tool\.poetry\.dependencies\][\s\S]*?^\s*python\s*=\s*["']([^"']+)["']/m.exec(text)
  const py = req ? { v: req[1], how: 'requires-python' } : poetryPy ? { v: poetryPy[1], how: 'tool.poetry python' } : undefined
  out.push({ key: 'python', version: cleanSpec(py?.v), source, detail: py ? `${py.how} ${py.v}` : 'pyproject.toml', rank: py ? RANK_BUILD : RANK_HINT })
  const deps: Array<{ name: string; version?: string }> = []
  // PEP 621: dependencies = ["fastapi>=0.110", …] (and optional-dependencies groups)
  for (const arr of text.matchAll(/^\s*[\w-]+\s*=\s*\[((?:[^\]"']|"[^"]*"|'[^']*')*)\]/gm)) {
    for (const s of arr[1].matchAll(/["']([^"']+)["']/g)) {
      const r = pyReq(s[1])
      if (r) deps.push(r)
    }
  }
  // Poetry / PDM tables: fastapi = "^0.110.0" or { version = "^0.110" }
  for (const sec of text.matchAll(/^\[tool\.poetry\.(?:group\.\w+\.)?(?:dev-)?dependencies\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) {
    for (const m of sec[1].matchAll(/^\s*([\w.-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'][^}]*\})/gm)) {
      if (m[1].toLowerCase() !== 'python') deps.push({ name: m[1].toLowerCase(), version: cleanSpec(m[2] ?? m[3]) })
    }
  }
  out.push(...depMentions(deps, source))
  return out
}

export function parseRequirements(text: string, source = 'requirements.txt'): TechMention[] {
  const deps = text.split('\n').map((l) => l.replace(/#.*$/, '')).filter((l) => l.trim()).map(pyReq).filter((d): d is { name: string; version?: string } => Boolean(d))
  return [{ key: 'python', source, detail: 'requirements.txt', rank: RANK_HINT }, ...depMentions(deps, source)]
}

export function parsePipfile(text: string, source = 'Pipfile'): TechMention[] {
  const v = /^\s*python_(?:full_)?version\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
  const out: TechMention[] = [{ key: 'python', version: cleanSpec(v), source, detail: v ? `python_version ${v}` : 'Pipfile', rank: v ? RANK_BUILD : RANK_HINT }]
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of text.matchAll(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/gm)) if (!/^python_/.test(m[1]) && !/^(url|name|verify_ssl)$/.test(m[1])) deps.push({ name: m[1].toLowerCase(), version: cleanSpec(m[2]) })
  out.push(...depMentions(deps, source))
  return out
}

/* ─────────── Rust / Ruby / PHP / .NET / Elixir ─────────── */

export function parseCargo(text: string, source = 'Cargo.toml'): TechMention[] {
  const rv = /^\s*rust-version\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
  const edition = /^\s*edition\s*=\s*["'](\d+)["']/m.exec(text)?.[1]
  const out: TechMention[] = [{ key: 'rust', version: cleanSpec(rv), source, detail: rv ? `rust-version ${rv}` : edition ? `edition ${edition}` : 'Cargo.toml', rank: rv ? RANK_BUILD : RANK_HINT }]
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of text.matchAll(/^\s*([\w-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'][^}]*\})/gm)) deps.push({ name: m[1], version: cleanSpec(m[2] ?? m[3]) })
  out.push(...depMentions(deps, source))
  return out
}

export function parseRustToolchain(text: string, source = 'rust-toolchain.toml'): TechMention[] {
  const ch = /channel\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? (source.endsWith('.toml') ? undefined : text.trim().split('\n')[0])
  const v = ch ? /^(\d+\.\d+(?:\.\d+)?)/.exec(ch)?.[1] : undefined
  return ch ? [{ key: 'rust', version: v, source, detail: `channel ${ch}`, rank: v ? RANK_PIN : RANK_HINT }] : []
}

export function parseGemfile(text: string, source = 'Gemfile'): TechMention[] {
  const ruby = /^\s*ruby\s+['"]([^'"]+)['"]/m.exec(text)?.[1]
  const out: TechMention[] = [{ key: 'ruby', version: cleanSpec(ruby), source, detail: ruby ? `ruby '${ruby}'` : 'Gemfile', rank: ruby ? RANK_BUILD : RANK_HINT }]
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of text.matchAll(/^\s*gem\s+['"]([\w-]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) deps.push({ name: m[1], version: cleanSpec(m[2]) })
  out.push(...depMentions(deps, source))
  return out
}

export function parseComposer(text: string, source = 'composer.json'): TechMention[] {
  let pkg: { require?: Record<string, string>; 'require-dev'?: Record<string, string> }
  try {
    pkg = JSON.parse(text)
  } catch {
    return []
  }
  const req = { ...pkg['require-dev'], ...pkg.require }
  const out: TechMention[] = [{ key: 'php', version: cleanSpec(req.php), source, detail: req.php ? `require.php ${req.php}` : 'composer.json', rank: req.php ? RANK_BUILD : RANK_HINT }]
  out.push(...depMentions(Object.entries(req).map(([name, spec]) => ({ name, version: cleanSpec(spec) })), source))
  return out
}

export function parseCsproj(text: string, source: string): TechMention[] {
  const tf = /<TargetFrameworks?>\s*([^<]+?)\s*<\/TargetFrameworks?>/.exec(text)?.[1]
  const first = tf?.split(';')[0]
  const v = first ? /^net(?:coreapp)?(\d+\.\d+)/.exec(first)?.[1] : undefined
  const out: TechMention[] = [{ key: 'dotnet', version: v, source, detail: tf ? `TargetFramework ${tf}` : baseName(source), rank: v ? RANK_BUILD : RANK_HINT }]
  if (/\.csproj$/i.test(source)) out.push({ key: 'csharp', source, detail: baseName(source), rank: RANK_HINT })
  return out
}

export function parseGlobalJson(text: string, source = 'global.json'): TechMention[] {
  try {
    const v = (JSON.parse(text) as { sdk?: { version?: string } }).sdk?.version
    return v ? [{ key: 'dotnet', version: v, source, detail: 'sdk.version (SDK)', rank: RANK_PIN }] : []
  } catch {
    return []
  }
}

export function parseMixExs(text: string, source = 'mix.exs'): TechMention[] {
  const ex = /elixir:\s*"([^"]+)"/.exec(text)?.[1]
  const out: TechMention[] = [{ key: 'elixir', version: cleanSpec(ex), source, detail: ex ? `elixir: "${ex}"` : 'mix.exs', rank: ex ? RANK_BUILD : RANK_HINT }]
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of text.matchAll(/\{:(\w+),\s*"([^"]+)"/g)) deps.push({ name: m[1], version: cleanSpec(m[2]) })
  out.push(...depMentions(deps, source))
  return out
}

/* ─────────── the whole repository ─────────── */

/**
 * Every mention the files imply. `files` maps repository path → content
 * (only what was read); `listing` is every path seen, for the presence-only
 * signals (tsconfig.json, Chart.yaml, mvnw, lockfiles).
 */
export function detectTech(files: Record<string, string>, listing: string[] = []): TechMention[] {
  const out: TechMention[] = []
  const byDir = (dir: string, name: string) => {
    const want = (dir ? `${dir}/` : '') + name
    const hit = Object.keys(files).find((p) => p.toLowerCase() === want.toLowerCase())
    return hit ? { path: hit, text: files[hit] } : undefined
  }
  for (const [path, text] of Object.entries(files)) {
    const name = baseName(path)
    const lower = name.toLowerCase()
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (lower === 'pom.xml') out.push(...parsePom(text, path))
    else if (/^(build|settings)\.gradle(\.kts)?$/.test(lower)) {
      // settings.gradle carries pluginManagement versions; it is read the same way.
      const props = byDir(dir, 'gradle.properties')
      const cat = byDir(dir, 'gradle/libs.versions.toml')
      out.push(...parseGradle(text, path, { properties: props?.text, propertiesSource: props?.path, catalog: cat?.text, catalogSource: cat?.path }))
    } else if (lower === 'gradle-wrapper.properties' || lower === 'maven-wrapper.properties') out.push(...parseWrapper(text, path))
    else if (lower === '.java-version') out.push(...parsePinFile('java', text, path))
    else if (lower === '.sdkmanrc') out.push(...parseSdkmanrc(text, path))
    else if (lower === '.tool-versions') out.push(...parseToolVersions(text, path))
    else if (lower === 'package.json') out.push(...parsePackageJson(text, path))
    else if (lower === '.nvmrc' || lower === '.node-version') out.push(...parsePinFile('node', text, path))
    else if (lower === 'deno.json' || lower === 'deno.jsonc') out.push(...parseDenoJson(text, path))
    else if (lower === 'go.mod') out.push(...parseGoMod(text, path))
    else if (lower === 'pyproject.toml') out.push(...parsePyproject(text, path))
    else if (lower === 'requirements.txt') out.push(...parseRequirements(text, path))
    else if (lower === 'pipfile') out.push(...parsePipfile(text, path))
    else if (lower === '.python-version' || lower === 'runtime.txt') out.push(...parsePinFile('python', text, path))
    else if (lower === 'cargo.toml') out.push(...parseCargo(text, path))
    else if (lower === 'rust-toolchain' || lower === 'rust-toolchain.toml') out.push(...parseRustToolchain(text, path))
    else if (lower === 'gemfile') out.push(...parseGemfile(text, path))
    else if (lower === '.ruby-version') out.push(...parsePinFile('ruby', text, path))
    else if (lower === 'composer.json') out.push(...parseComposer(text, path))
    else if (lower === 'global.json') out.push(...parseGlobalJson(text, path))
    else if (lower === 'mix.exs') out.push(...parseMixExs(text, path))
    else if (isCsproj(name)) out.push(...parseCsproj(text, path))
    else if (isDockerfile(name)) out.push(...parseDockerfile(text, path))
  }
  for (const p of listing) {
    const hit = PRESENCE.find((x) => x.re.test(baseName(p)))
    if (hit) out.push({ key: hit.key, source: p, detail: hit.detail, rank: RANK_HINT })
  }
  return out
}

/**
 * One row per tech: the best-ranked versioned mention wins (else the
 * best-ranked bare one); other mentions with a *different* version are
 * kept as `also`, in rank order. Order of first appearance is preserved.
 */
export function mergeDetections(mentions: TechMention[]): DetectedTech[] {
  const byKey = new Map<string, TechMention[]>()
  for (const m of mentions) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m])
  const out: DetectedTech[] = []
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.rank - b.rank)
    const best = sorted.find((m) => m.version) ?? sorted[0]
    const seen = new Set([best.version])
    const also: DetectedTech['also'] = []
    for (const m of sorted) {
      if (!m.version || seen.has(m.version)) continue
      seen.add(m.version)
      also.push({ version: m.version, source: m.source, detail: m.detail })
    }
    out.push({ key, version: best.version, source: best.source, detail: best.detail, also })
  }
  return out
}
