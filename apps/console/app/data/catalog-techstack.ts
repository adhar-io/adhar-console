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
  'chart.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'version',
])

/**
 * Files whose mere presence says something; never read. `path: true` tests
 * the whole repository path (CI folders, manifest folders), otherwise only
 * the file name. One mention per key is kept, with a file count.
 */
const PRESENCE: Array<{ re: RegExp; key: string; detail: string; path?: boolean }> = [
  { re: /^tsconfig(\.[\w-]+)?\.json$/i, key: 'typescript', detail: 'tsconfig.json present' },
  { re: /^pnpm-lock\.yaml$/i, key: 'pnpm', detail: 'pnpm-lock.yaml present' },
  { re: /^yarn\.lock$/i, key: 'yarn', detail: 'yarn.lock present' },
  { re: /^package-lock\.json$/i, key: 'npm', detail: 'package-lock.json present' },
  { re: /^bun\.lockb?$/i, key: 'bun', detail: 'bun lockfile present' },
  { re: /^deno\.lock$/i, key: 'deno', detail: 'deno.lock present' },
  { re: /^uv\.lock$/i, key: 'uv', detail: 'uv.lock present' },
  { re: /^poetry\.lock$/i, key: 'poetry', detail: 'poetry.lock present' },
  { re: /^pipfile\.lock$/i, key: 'pipenv', detail: 'Pipfile.lock present' },
  { re: /^gemfile\.lock$/i, key: 'bundler', detail: 'Gemfile.lock present' },
  { re: /^chart\.ya?ml$/i, key: 'helm', detail: 'Helm chart' },
  { re: /^kustomization\.ya?ml$/i, key: 'kustomize', detail: 'kustomization.yaml' },
  { re: /^mvnw$/i, key: 'maven', detail: 'Maven wrapper' },
  { re: /^gradlew$/i, key: 'gradle', detail: 'Gradle wrapper' },
  { re: /^makefile$/i, key: 'make', detail: 'Makefile' },
  { re: /^(workspace|workspace\.bazel|module\.bazel)$/i, key: 'bazel', detail: 'Bazel workspace' },
  { re: /^nx\.json$/i, key: 'nx', detail: 'nx.json' },
  { re: /^turbo\.json$/i, key: 'turborepo', detail: 'turbo.json' },
  { re: /^project\.toml$/i, key: 'buildpacks', detail: 'Buildpacks project.toml' },
  { re: /^skaffold\.ya?ml$/i, key: 'skaffold', detail: 'skaffold.yaml' },
  { re: /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i, key: 'docker-compose', detail: 'Compose file' },
  { re: /\.tf$/i, key: 'terraform', detail: 'Terraform configuration' },
  // ── CI ── (Tekton is the platform's CI)
  { re: /(^|\/)\.?tekton\/.+\.ya?ml$/i, key: 'tekton', detail: 'Tekton pipelines', path: true },
  { re: /^\.gitea\/workflows\/.+\.ya?ml$/i, key: 'gitea-actions', detail: 'Gitea Actions workflows', path: true },
  { re: /^\.github\/workflows\/.+\.ya?ml$/i, key: 'github-actions', detail: 'GitHub Actions workflows', path: true },
  { re: /^\.gitlab-ci\.ya?ml$/i, key: 'gitlab-ci', detail: '.gitlab-ci.yml' },
  { re: /^jenkinsfile$/i, key: 'jenkins', detail: 'Jenkinsfile' },
  // ── deployment manifests ──
  { re: /(^|\/)(k8s|kubernetes|kube|manifests|deploy|deployment|deployments|overlays)\/.+\.ya?ml$/i, key: 'kubernetes', detail: 'Kubernetes manifests', path: true },
  { re: /(^|\/)argo-?cd\/.+\.ya?ml$/i, key: 'argocd', detail: 'Argo CD manifests', path: true },
  // ── testing ──
  { re: /^vitest\.(config|workspace)\.[cm]?[jt]s$/i, key: 'vitest', detail: 'vitest config' },
  { re: /^jest\.config\.[cm]?[jt]s(on)?$/i, key: 'jest', detail: 'jest config' },
  { re: /^playwright\.config\.[cm]?[jt]s$/i, key: 'playwright', detail: 'playwright config' },
  { re: /^cypress\.config\.[cm]?[jt]s$/i, key: 'cypress', detail: 'cypress config' },
  { re: /^(pytest\.ini|conftest\.py)$/i, key: 'pytest', detail: 'pytest config' },
  { re: /_test\.go$/i, key: 'go-test', detail: 'Go test files' },
  { re: /(^|\/)src\/test\/(java|kotlin)\//i, key: 'junit', detail: 'tests under src/test', path: true },
  // ── linters & quality ──
  { re: /^(\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]s)$/i, key: 'eslint', detail: 'ESLint config' },
  { re: /^(\.prettierrc(\.\w+)?|prettier\.config\.[cm]?[jt]s)$/i, key: 'prettier', detail: 'Prettier config' },
  { re: /^biome\.jsonc?$/i, key: 'biome', detail: 'biome.json' },
  { re: /^\.?ruff\.toml$/i, key: 'ruff', detail: 'ruff.toml' },
  { re: /^\.flake8$/i, key: 'flake8', detail: '.flake8' },
  { re: /^mypy\.ini$/i, key: 'mypy', detail: 'mypy.ini' },
  { re: /^\.golangci\.(ya?ml|toml|json)$/i, key: 'golangci-lint', detail: 'golangci-lint config' },
  { re: /^checkstyle(-[\w-]+)?\.xml$/i, key: 'checkstyle', detail: 'Checkstyle rules' },
  { re: /^sonar-project\.properties$/i, key: 'sonarqube', detail: 'sonar-project.properties' },
  { re: /^\.rubocop\.ya?ml$/i, key: 'rubocop', detail: '.rubocop.yml' },
  { re: /^\.pre-commit-config\.ya?ml$/i, key: 'pre-commit', detail: 'pre-commit hooks' },
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
  // Test-only modules first: `org.testcontainers:postgresql` is a test harness, not the datastore.
  { re: /^(org\.testcontainers:[\w-]+|@testcontainers\/[\w-]+|testcontainers|testcontainers-go|github\.com\/testcontainers\/[\w./-]+)$/i, key: 'testcontainers' },
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
  { re: /(^|[:/])(cassandra-driver-core|java-driver-core|cassandra-driver|gocql)$/i, key: 'cassandra' },
  { re: /(^|[:/])(jnats|nats|nats\.go|nats-py)$/i, key: 'nats' },
  { re: /(^|[:/])(pulsar-client(-[\w-]+)?)$/i, key: 'pulsar' },
  { re: /(^|[:/])(sqlite-jdbc|sqlite3|better-sqlite3|go-sqlite3|aiosqlite)$/i, key: 'sqlite' },
  { re: /(^|[:/])(clickhouse-jdbc|@clickhouse\/client|clickhouse-go(\/v\d+)?|clickhouse-connect)$/i, key: 'clickhouse' },
  { re: /(^|[:/])(@aws-sdk\/client-s3|minio|aws-sdk-s3|s3)$/i, key: 's3' },
  // persistence frameworks and migrations sit with the data they shape
  { re: /(^|[:/])(spring-boot-starter-data-jpa|hibernate-core|hibernate-orm)$/i, key: 'jpa' },
  { re: /(^|[:/])(flyway-core|flyway-database-postgresql|flyway-mysql)$/i, key: 'flyway', versioned: true },
  { re: /(^|[:/])(liquibase-core)$/i, key: 'liquibase', versioned: true },
  { re: /^(prisma|@prisma\/client)$/i, key: 'prisma', versioned: true },
  { re: /^(typeorm)$/i, key: 'typeorm', versioned: true },
  { re: /^(sequelize)$/i, key: 'sequelize', versioned: true },
  { re: /^(drizzle-orm)$/i, key: 'drizzle', versioned: true },
  { re: /^(sqlalchemy)$/i, key: 'sqlalchemy', versioned: true },
  { re: /(^|\/)gorm\.io\/gorm$/i, key: 'gorm', versioned: true },
  // observability
  { re: /(^|[:/])(opentelemetry-[\w-]+|@opentelemetry\/[\w-]+|otel(\/[\w-]+)?)$/i, key: 'otel' },
  { re: /(^|[:/])(micrometer-registry-prometheus|prom-client|prometheus-client|prometheus_client|client_golang|prometheus-fastapi-instrumentator)$/i, key: 'prometheus' },
  { re: /(^|[:/])(micrometer-core|micrometer-tracing(-[\w-]+)?)$/i, key: 'micrometer' },
  { re: /(^|[:/])(spring-boot-starter-actuator)$/i, key: 'actuator' },
  { re: /(^|[:/])(sentry(-[\w-]+)?|@sentry\/[\w-]+|sentry-sdk|sentry-go)$/i, key: 'sentry' },
  { re: /(^|[:/])(dd-trace(-[\w-]+)?|ddtrace|dd-java-agent)$/i, key: 'datadog' },
  { re: /(^|[:/])(logstash-logback-encoder|logback-classic)$/i, key: 'logback' },
  { re: /(^|[:/])(log4j-core|log4j-api)$/i, key: 'log4j' },
  { re: /^(pino|winston|structlog)$/i, key: 'structured-logging' },
  { re: /(^|\/)(uber-go\/zap|go\.uber\.org\/zap|rs\/zerolog)$/i, key: 'structured-logging' },
  // testing & quality (dev dependencies)
  { re: /^(vitest)$/i, key: 'vitest', versioned: true },
  { re: /^(jest|ts-jest)$/i, key: 'jest', versioned: true },
  { re: /^(mocha)$/i, key: 'mocha', versioned: true },
  { re: /^(@playwright\/test|playwright)$/i, key: 'playwright', versioned: true },
  { re: /^(cypress)$/i, key: 'cypress', versioned: true },
  { re: /^(@testing-library\/[\w-]+)$/i, key: 'testing-library' },
  { re: /(^|[:/])(junit-jupiter(-api|-engine)?|junit-bom|junit|spring-boot-starter-test)$/i, key: 'junit', versioned: true },
  { re: /(^|[:/])(testng)$/i, key: 'testng', versioned: true },
  { re: /(^|[:/])(mockito-core|mockito-junit-jupiter|mockk)$/i, key: 'mockito' },
  { re: /^(pytest)$/i, key: 'pytest', versioned: true },
  { re: /(^|\/)stretchr\/testify$/i, key: 'testify', versioned: true },
  { re: /^(rspec|rspec-rails)$/i, key: 'rspec', versioned: true },
  { re: /^(phpunit\/phpunit)$/i, key: 'phpunit', versioned: true },
  { re: /^(eslint)$/i, key: 'eslint', versioned: true },
  { re: /^(prettier)$/i, key: 'prettier', versioned: true },
  { re: /^(@biomejs\/biome)$/i, key: 'biome', versioned: true },
  { re: /^(ruff)$/i, key: 'ruff', versioned: true },
  { re: /^(black)$/i, key: 'black', versioned: true },
  { re: /^(flake8)$/i, key: 'flake8' },
  { re: /^(mypy)$/i, key: 'mypy', versioned: true },
  { re: /^(pylint)$/i, key: 'pylint' },
  { re: /^(rubocop)$/i, key: 'rubocop' },
  // build plugins (Maven artifactIds, Gradle plugin ids)
  { re: /(^|[:/])(jacoco-maven-plugin|org\.jacoco\.agent|jacoco)$/i, key: 'jacoco' },
  { re: /(^|[:/])(maven-checkstyle-plugin|checkstyle)$/i, key: 'checkstyle' },
  { re: /(^|[:/])(spotbugs-maven-plugin|com\.github\.spotbugs|spotbugs)$/i, key: 'spotbugs' },
  { re: /(^|[:/])(maven-pmd-plugin|pmd)$/i, key: 'pmd' },
  { re: /(^|[:/])(spotless-maven-plugin|com\.diffplug\.spotless)$/i, key: 'spotless' },
  { re: /(^|[:/])(sonar-maven-plugin|org\.sonarqube)$/i, key: 'sonarqube' },
  { re: /(^|[:/])(jib-maven-plugin|com\.google\.cloud\.tools\.jib)$/i, key: 'jib' },
  { re: /(^|[:/])(org\.jlleitschuh\.gradle\.ktlint|ktlint)$/i, key: 'ktlint' },
  { re: /(^|[:/])(io\.gitlab\.arturbosch\.detekt|detekt-gradle-plugin)$/i, key: 'detekt' },
  // bundlers / front-end build
  { re: /^(vite)$/i, key: 'vite', versioned: true },
  { re: /^(webpack)$/i, key: 'webpack', versioned: true },
  { re: /^(tailwindcss)$/i, key: 'tailwind', versioned: true },
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
  { re: /^(hono)$/i, key: 'hono', versioned: true },
  { re: /^(koa)$/i, key: 'koa', versioned: true },
  { re: /^(nuxt)$/i, key: 'nuxt', versioned: true },
  { re: /^(astro)$/i, key: 'astro', versioned: true },
  { re: /^(@remix-run\/react|@remix-run\/node)$/i, key: 'remix', versioned: true },
  { re: /^(@tanstack\/react-router|@tanstack\/react-start)$/i, key: 'tanstack', versioned: true },
  { re: /(^|[:/])(spring-boot-starter-webflux)$/i, key: 'webflux' },
  { re: /(^|[:/])(spring-boot-starter-security|spring-security-core)$/i, key: 'spring-security' },
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
  // Build plugins name the quality and packaging tools (jacoco, checkstyle, jib, …).
  out.push(...depMentions(plugins.filter((p) => p.artifactId && !/^maven-(compiler|resources|jar|install|deploy|clean|site|surefire|failsafe)-plugin$/.test(p.artifactId)).map((p) => ({ name: `${p.groupId ?? ''}:${p.artifactId}` })), source))
  if (plugins.some((p) => p.artifactId === 'maven-surefire-plugin' || p.artifactId === 'maven-failsafe-plugin') && !out.some((m) => m.key === 'junit' || m.key === 'testng')) {
    out.push({ key: 'junit', source, detail: 'maven-surefire-plugin', rank: RANK_HINT })
  }
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
  if (/useJUnitPlatform\s*\(/.test(s)) out.push({ key: 'junit', version: '5', source, detail: 'test { useJUnitPlatform() }', rank: RANK_HINT })
  // Plugins applied by id (`id 'jacoco'`, `id("com.google.cloud.tools.jib")`, a bare `jacoco` in plugins {}).
  const pluginIds: Array<{ name: string }> = []
  for (const m of s.matchAll(/\bid\s*\(?\s*['"]([\w.-]+)['"]/g)) pluginIds.push({ name: m[1] })
  for (const m of s.matchAll(/apply\s+plugin:\s*['"]([\w.-]+)['"]/g)) pluginIds.push({ name: m[1] })
  const pluginsBlock = /plugins\s*\{([\s\S]*?)\n\s*\}/.exec(s)?.[1] ?? ''
  for (const m of pluginsBlock.matchAll(/^\s*`?([a-z][\w-]*)`?\s*$/gm)) pluginIds.push({ name: m[1] })
  for (const p of cat?.plugins ?? []) pluginIds.push({ name: p.id })
  out.push(...depMentions(pluginIds, source))
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
  if (pm) out.push({ key: pm[1], version: cleanSpec(pm[2]), source, detail: `packageManager ${pkg.packageManager}`, rank: RANK_BUILD })
  if (pkg.engines?.npm) out.push({ key: 'npm', version: cleanSpec(pkg.engines.npm), source, detail: `engines.npm ${pkg.engines.npm}`, rank: RANK_BUILD })
  if (pkg.engines?.pnpm) out.push({ key: 'pnpm', version: cleanSpec(pkg.engines.pnpm), source, detail: `engines.pnpm ${pkg.engines.pnpm}`, rank: RANK_BUILD })
  const list = Object.entries(deps).map(([name, spec]) => ({ name, version: cleanSpec(spec) }))
  // A Next.js app is a React app; both are worth a row. SvelteKit implies Svelte.
  if (deps['@sveltejs/kit'] && !deps.svelte) list.push({ name: 'svelte', version: undefined })
  out.push(...depMentions(list, source))
  return out
}

export function parseDenoJson(text: string, source = 'deno.json'): TechMention[] {
  const out: TechMention[] = [{ key: 'deno', source, detail: baseName(source), rank: RANK_HINT }, { key: 'typescript', source, detail: 'Deno project', rank: RANK_HINT }]
  if (/"[\w:-]*test[\w:-]*"\s*:\s*"[^"]*deno test/.test(text)) out.push({ key: 'deno-test', source, detail: 'deno test task', rank: RANK_HINT })
  if (/"[\w:-]*lint[\w:-]*"\s*:\s*"[^"]*deno lint/.test(text) || /"lint"\s*:\s*\{/.test(text)) out.push({ key: 'deno-lint', source, detail: 'deno lint', rank: RANK_HINT })
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
  out.push({ key: 'go-modules', source, detail: 'go.mod', rank: RANK_HINT })
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
  // Tool tables say which build backend, test runner and linters the project uses.
  const tools: Array<[RegExp, string, string]> = [
    [/^\[tool\.poetry\]/m, 'poetry', '[tool.poetry]'],
    [/^\[tool\.uv\]/m, 'uv', '[tool.uv]'],
    [/^\[tool\.pdm\]/m, 'pdm', '[tool.pdm]'],
    [/^\[tool\.hatch[\].]/m, 'hatch', '[tool.hatch]'],
    [/^\[tool\.pytest(\.ini_options)?\]/m, 'pytest', '[tool.pytest.ini_options]'],
    [/^\[tool\.ruff[\].]/m, 'ruff', '[tool.ruff]'],
    [/^\[tool\.black\]/m, 'black', '[tool.black]'],
    [/^\[tool\.mypy\]/m, 'mypy', '[tool.mypy]'],
  ]
  for (const [re, key, detail] of tools) if (re.test(text)) out.push({ key, source, detail, rank: RANK_HINT })
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
  return [{ key: 'python', source, detail: 'requirements.txt', rank: RANK_HINT }, { key: 'pip', source, detail: baseName(source), rank: RANK_HINT }, ...depMentions(deps, source)]
}

export function parsePipfile(text: string, source = 'Pipfile'): TechMention[] {
  const v = /^\s*python_(?:full_)?version\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
  const out: TechMention[] = [{ key: 'python', version: cleanSpec(v), source, detail: v ? `python_version ${v}` : 'Pipfile', rank: v ? RANK_BUILD : RANK_HINT }, { key: 'pipenv', source, detail: 'Pipfile', rank: RANK_HINT }]
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of text.matchAll(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/gm)) if (!/^python_/.test(m[1]) && !/^(url|name|verify_ssl)$/.test(m[1])) deps.push({ name: m[1].toLowerCase(), version: cleanSpec(m[2]) })
  out.push(...depMentions(deps, source))
  return out
}

/* ─────────── Rust / Ruby / PHP / .NET / Elixir ─────────── */

export function parseCargo(text: string, source = 'Cargo.toml'): TechMention[] {
  const rv = /^\s*rust-version\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
  const edition = /^\s*edition\s*=\s*["'](\d+)["']/m.exec(text)?.[1]
  const out: TechMention[] = [
    { key: 'rust', version: cleanSpec(rv), source, detail: rv ? `rust-version ${rv}` : edition ? `edition ${edition}` : 'Cargo.toml', rank: rv ? RANK_BUILD : RANK_HINT },
    { key: 'cargo', source, detail: 'Cargo.toml', rank: RANK_HINT },
  ]
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
  const out: TechMention[] = [
    { key: 'ruby', version: cleanSpec(ruby), source, detail: ruby ? `ruby '${ruby}'` : 'Gemfile', rank: ruby ? RANK_BUILD : RANK_HINT },
    { key: 'bundler', source, detail: 'Gemfile', rank: RANK_HINT },
  ]
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
  const out: TechMention[] = [
    { key: 'php', version: cleanSpec(req.php), source, detail: req.php ? `require.php ${req.php}` : 'composer.json', rank: req.php ? RANK_BUILD : RANK_HINT },
    { key: 'composer', source, detail: 'composer.json', rank: RANK_HINT },
  ]
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
  const out: TechMention[] = [
    { key: 'elixir', version: cleanSpec(ex), source, detail: ex ? `elixir: "${ex}"` : 'mix.exs', rank: ex ? RANK_BUILD : RANK_HINT },
    { key: 'mix', source, detail: 'mix.exs', rank: RANK_HINT },
  ]
  const deps: Array<{ name: string; version?: string }> = []
  for (const m of text.matchAll(/\{:(\w+),\s*"([^"]+)"/g)) deps.push({ name: m[1], version: cleanSpec(m[2]) })
  out.push(...depMentions(deps, source))
  return out
}

/* ─────────── Helm / Compose / CI ─────────── */

/** Top-level `key: value` of a YAML document (no nesting) — enough for Chart.yaml. */
function yamlTop(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*['"]?([^'"#\\n]+?)['"]?\\s*(?:#.*)?$`, 'm').exec(text)
  return m ? m[1].trim() : undefined
}

/** Images that are datastores or brokers → the tech they carry. */
const SERVICE_IMAGES: Array<{ re: RegExp; key: string }> = [
  { re: /(^|\/)(postgres|postgresql|postgis\/postgis|cloudnative-pg\/postgresql)$/i, key: 'postgres' },
  { re: /(^|\/)mysql(-server)?$/i, key: 'mysql' },
  { re: /(^|\/)mariadb$/i, key: 'mariadb' },
  { re: /(^|\/)mongo(db)?(-community-server)?$/i, key: 'mongodb' },
  { re: /(^|\/)redis(-stack)?$/i, key: 'redis' },
  { re: /(^|\/)valkey$/i, key: 'valkey' },
  { re: /(^|\/)(rabbitmq)$/i, key: 'rabbitmq' },
  { re: /(^|\/)(kafka|cp-kafka|cp-server)$/i, key: 'kafka' },
  { re: /(^|\/)(elasticsearch)$/i, key: 'elasticsearch' },
  { re: /(^|\/)(opensearch)$/i, key: 'opensearch' },
  { re: /(^|\/)(clickhouse-server|clickhouse)$/i, key: 'clickhouse' },
  { re: /(^|\/)(minio)$/i, key: 'minio' },
  { re: /(^|\/)(nats)$/i, key: 'nats' },
  { re: /(^|\/)(cassandra)$/i, key: 'cassandra' },
]

/** Helm chart dependency names → the datastore they install. */
const CHART_DEPS: Record<string, string> = {
  postgresql: 'postgres', 'postgresql-ha': 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongodb: 'mongodb', redis: 'redis', 'redis-cluster': 'redis',
  valkey: 'valkey', rabbitmq: 'rabbitmq', kafka: 'kafka', elasticsearch: 'elasticsearch', opensearch: 'opensearch', clickhouse: 'clickhouse', minio: 'minio', nats: 'nats', cassandra: 'cassandra',
}

/** Chart.yaml → Helm (chart name and version), plus the datastores its dependencies install. */
export function parseChart(text: string, source = 'Chart.yaml'): TechMention[] {
  const name = yamlTop(text, 'name')
  const version = yamlTop(text, 'version')
  const api = yamlTop(text, 'apiVersion')
  const out: TechMention[] = [{ key: 'helm', source, detail: `chart ${name ?? baseName(source)}${version ? ` ${version}` : ''}${api === 'v2' ? ' (Helm 3)' : ''}`, rank: RANK_HINT }]
  const deps = /^dependencies:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(text)?.[1] ?? ''
  for (const item of deps.split(/^\s*-\s+/m).slice(1)) {
    const dep = /(?:^|\n)\s*name:\s*['"]?([\w.-]+)/.exec(`\n${item}`)?.[1]
    const dv = /(?:^|\n)\s*version:\s*['"]?([^'"\s]+)/.exec(`\n${item}`)?.[1]
    const key = dep ? CHART_DEPS[dep.toLowerCase()] : undefined
    // A chart's version is not the database's — it names the chart only.
    if (key) out.push({ key, source, detail: `Helm dependency ${dep}${dv ? ` ${dv}` : ''}`, rank: RANK_HINT })
  }
  return out
}

/** docker-compose / compose.yaml → the datastores and brokers it runs, with the image tag as version. */
export function parseCompose(text: string, source = 'docker-compose.yml'): TechMention[] {
  const out: TechMention[] = [{ key: 'docker-compose', source, detail: baseName(source), rank: RANK_HINT }]
  for (const m of text.matchAll(/^\s*image:\s*['"]?([^'"\s#]+)/gm)) {
    const ref = parseImageRef(m[1])
    const hit = SERVICE_IMAGES.find((x) => x.re.test(ref.repository))
    if (!hit) continue
    // Confluent's images carry the Confluent Platform version (7.6 ≈ Kafka 3.6), not the broker's.
    const vendorTag = /^confluentinc\//i.test(ref.repository)
    const v = ref.tag && !vendorTag ? /^v?(\d+(?:\.\d+)*)/.exec(ref.tag)?.[1] : undefined
    out.push({ key: hit.key, version: v, source, detail: `image ${ref.repository}${ref.tag ? `:${ref.tag}` : ''}${vendorTag ? ' (Confluent Platform version)' : ''}`, rank: v ? RANK_IMAGE : RANK_HINT })
  }
  return out
}

/** Tekton task names that name a build or scan tool. */
const TEKTON_TASK_TOOLS: Array<{ re: RegExp; key: string }> = [
  { re: /^(buildah|buildah-[\w-]+)$/i, key: 'buildah' },
  { re: /^(kaniko|kaniko-[\w-]+)$/i, key: 'kaniko' },
  { re: /^(buildpacks|buildpacks-phases)$/i, key: 'buildpacks' },
  { re: /^(trivy|trivy-scanner|trivy-[\w-]+)$/i, key: 'trivy' },
  { re: /^(sonarqube-scanner|sonar-[\w-]+)$/i, key: 'sonarqube' },
  { re: /^(maven)$/i, key: 'maven' },
  { re: /^(gradle)$/i, key: 'gradle' },
  { re: /^(golang-build|golang-test)$/i, key: 'go-modules' },
  { re: /^(npm|node-[\w-]+)$/i, key: 'npm' },
]

export interface CiSummary {
  /** Tech key of the CI system (`tekton`, `github-actions`, …). */
  key: string
  source: string
  /** Pipeline / workflow names declared in the file. */
  names: string[]
  /** Tasks or actions it runs (`git-clone`, `buildah`, `actions/setup-java`). */
  steps: string[]
}

/** A CI definition → what system it is and what it runs. Regex-level, never throws. */
export function parseCiFile(text: string, source: string): { summary: CiSummary; mentions: TechMention[] } | undefined {
  const lower = source.toLowerCase()
  const mentions: TechMention[] = []
  if (/(^|\/)\.?tekton\//.test(lower) || /apiVersion:\s*tekton\.dev\//.test(text)) {
    const kinds = [...text.matchAll(/^kind:\s*(\w+)/gm)].map((m) => m[1])
    const names = [...text.matchAll(/^metadata:\s*\n(?:\s+.*\n)*?\s+(?:name|generateName):\s*['"]?([\w.-]+)/gm)].map((m) => m[1].replace(/-$/, ''))
    const steps = [...new Set([...text.matchAll(/taskRef:\s*\n(?:\s+(?:kind|resolver|bundle|apiVersion):.*\n)*\s+name:\s*['"]?([\w.-]+)/g)].map((m) => m[1]))]
    // Resolver-style refs: params: - name: name / value: git-clone
    for (const m of text.matchAll(/-\s*name:\s*name\s*\n\s*value:\s*['"]?([\w.-]+)/g)) if (!steps.includes(m[1])) steps.push(m[1])
    for (const t of steps) {
      const hit = TEKTON_TASK_TOOLS.find((x) => x.re.test(t))
      if (hit) mentions.push({ key: hit.key, source, detail: `Tekton task ${t}`, rank: RANK_HINT })
    }
    const kindTxt = [...new Set(kinds)].join(', ')
    mentions.unshift({ key: 'tekton', source, detail: `${kindTxt || 'Tekton'}${names.length ? ` ${names.slice(0, 2).join(', ')}` : ''}`, rank: RANK_HINT })
    return { summary: { key: 'tekton', source, names, steps }, mentions }
  }
  if (/^\.(github|gitea|forgejo)\/workflows\//.test(lower)) {
    const key = lower.startsWith('.github/') ? 'github-actions' : 'gitea-actions'
    const name = /^name:\s*['"]?([^'"\n]+)/m.exec(text)?.[1]?.trim()
    const steps = [...new Set([...text.matchAll(/uses:\s*['"]?([\w.-]+\/[\w./-]+?)(?:@[\w.-]+)?['"]?\s*$/gm)].map((m) => m[1]))]
    mentions.push({ key, source, detail: `workflow ${name ?? baseName(source)}`, rank: RANK_HINT })
    if (steps.some((x) => /docker\/build-push-action|docker\/setup-buildx/.test(x))) mentions.push({ key: 'docker', source, detail: 'docker/build-push-action', rank: RANK_HINT })
    return { summary: { key, source, names: name ? [name] : [], steps }, mentions }
  }
  if (/(^|\/)jenkinsfile$/.test(lower)) {
    const steps = [...new Set([...text.matchAll(/stage\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))]
    mentions.push({ key: 'jenkins', source, detail: steps.length ? `stages ${steps.slice(0, 4).join(', ')}` : 'Jenkinsfile', rank: RANK_HINT })
    return { summary: { key: 'jenkins', source, names: [], steps }, mentions }
  }
  if (/(^|\/)\.gitlab-ci\.ya?ml$/.test(lower)) {
    const steps = [...new Set([...text.matchAll(/^stages:\s*\n((?:\s+-\s*.+\n?)+)/gm)].flatMap((m) => [...m[1].matchAll(/-\s*([\w-]+)/g)].map((x) => x[1])))]
    mentions.push({ key: 'gitlab-ci', source, detail: steps.length ? `stages ${steps.join(', ')}` : '.gitlab-ci.yml', rank: RANK_HINT })
    return { summary: { key: 'gitlab-ci', source, names: [], steps }, mentions }
  }
  return undefined
}

/** CI definitions worth reading, best first: Tekton (the platform's CI), then the forges', then Jenkins. */
export function ciFiles(listing: string[], max = 4): string[] {
  const rank = (p: string) =>
    /(^|\/)\.?tekton\/.+\.ya?ml$/i.test(p) ? 0 : /^\.gitea\/workflows\/.+\.ya?ml$/i.test(p) ? 1 : /^\.github\/workflows\/.+\.ya?ml$/i.test(p) ? 2 : /(^|\/)jenkinsfile$/i.test(p) ? 3 : /^\.gitlab-ci\.ya?ml$/i.test(p) ? 4 : -1
  return listing.filter((p) => rank(p) >= 0).sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b)).slice(0, max)
}

/* ─────────── container images ─────────── */

export interface ImageRef {
  /** Registry host (with port), when the reference names one. */
  registry?: string
  /** Repository path without the registry: `library/postgres`, `org/app`. */
  repository: string
  tag?: string
  /** `sha256:…` when the reference is pinned by digest. */
  digest?: string
}

/**
 * Split an image reference the way the container runtime does: the first
 * path segment is a registry only when it has a dot or a port or is
 * `localhost`; the tag is after the LAST colon of the last segment, so a
 * registry port (`registry:5000/app`) is never read as a tag; a digest after
 * `@` is kept separately.
 */
export function parseImageRef(raw: string): ImageRef {
  const ref = raw.trim()
  const at = ref.indexOf('@')
  const digest = at >= 0 ? ref.slice(at + 1) : undefined
  const noDigest = at >= 0 ? ref.slice(0, at) : ref
  const parts = noDigest.split('/')
  let registry: string | undefined
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) registry = parts.shift()
  const last = parts.pop() ?? ''
  const colon = last.lastIndexOf(':')
  const tag = colon >= 0 ? last.slice(colon + 1) : undefined
  const name = colon >= 0 ? last.slice(0, colon) : last
  return { registry, repository: [...parts, name].join('/'), tag: tag || undefined, digest: digest || undefined }
}

export interface DockerfileSummary {
  source: string
  /** The image the final stage is built FROM — what ships. */
  base?: string
  /** Earlier (build) stage images. */
  builders: string[]
  ports: string[]
  /** The USER the image runs as, when set. */
  user?: string
  healthcheck: boolean
  /** Command the container starts with (ENTRYPOINT, else CMD), trimmed. */
  entrypoint?: string
}

/** What a Dockerfile builds: base and builder images, exposed ports, user, entrypoint. */
export function describeDockerfile(text: string, source = 'Dockerfile'): DockerfileSummary {
  const args: Record<string, string> = {}
  const stages = new Set<string>()
  const images: string[] = []
  const ports: string[] = []
  let user: string | undefined
  let healthcheck = false
  let entry: string | undefined
  let cmd: string | undefined
  for (const raw of text.replace(/\\\r?\n/g, ' ').split('\n')) {
    const line = raw.trim()
    const arg = /^ARG\s+([\w]+)=["']?([^"'\s]+)["']?/i.exec(line)
    if (arg) args[arg[1]] = arg[2]
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line)
    if (from) {
      const ref = from[1].replace(/\$\{?(\w+)(?::-([^}]*))?\}?/g, (_all, k: string, dflt?: string) => args[k] ?? dflt ?? '')
      const isStage = stages.has(ref.toLowerCase())
      if (from[2]) stages.add(from[2].toLowerCase())
      images.push(isStage ? `stage ${ref}` : ref)
      // A new stage resets what the previous one declared.
      user = undefined
      entry = undefined
      cmd = undefined
      healthcheck = false
      ports.length = 0
      continue
    }
    const expose = /^EXPOSE\s+(.+)$/i.exec(line)
    if (expose) ports.push(...expose[1].split(/\s+/).filter(Boolean))
    const u = /^USER\s+(\S+)/i.exec(line)
    if (u) user = u[1]
    if (/^HEALTHCHECK\s+(?!NONE)/i.test(line)) healthcheck = true
    const e = /^ENTRYPOINT\s+(.+)$/i.exec(line)
    if (e) entry = e[1]
    const c = /^CMD\s+(.+)$/i.exec(line)
    if (c) cmd = c[1]
  }
  const base = images.length ? images[images.length - 1] : undefined
  const tidy = (v?: string) => v?.replace(/^\[|\]$/g, '').replace(/"\s*,\s*"/g, ' ').replace(/"/g, '').trim().slice(0, 120)
  return { source, base, builders: images.slice(0, -1).filter((i) => !i.startsWith('stage ')), ports, user, healthcheck, entrypoint: tidy(entry ?? cmd) }
}

/* ─────────── the application's own version ─────────── */

export interface AppVersionHint {
  version: string
  source: string
  /** How the file says it: `<version>`, `appVersion`, `[project] version`. */
  detail: string
}

/** The `version` of a TOML table (`[project]`, `[tool.poetry]`, `[package]`). */
function tomlTableVersion(text: string, table: string): string | undefined {
  const esc = table.replace(/\./g, '\\.')
  const sec = new RegExp(`^\\[${esc}\\]\\s*\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(text)?.[1]
  return sec ? /^\s*version\s*=\s*["']([^"']+)["']/m.exec(sec)?.[1] : undefined
}

/**
 * The version the project's own build file gives the application (not its
 * dependencies): package.json `version`, the pom's project `<version>`,
 * Gradle `version =`, Chart.yaml `appVersion`, `[project] version`, Cargo
 * `[package] version`, deno.json, mix.exs, a `.csproj` `<Version>`, a
 * VERSION file. `0.0.0` placeholders and unresolved placeholders are skipped.
 */
export function appVersionFrom(path: string, text: string): AppVersionHint | undefined {
  const lower = baseName(path).toLowerCase()
  const ok = (v: string | undefined) => {
    const s = literal(v)
    return s && s !== '0.0.0' && /^\d/.test(s) ? s : undefined
  }
  const hint = (v: string | undefined, detail: string) => (ok(v) ? { version: ok(v)!, source: path, detail } : undefined)
  try {
    if (lower === 'package.json' || lower === 'deno.json' || lower === 'composer.json') {
      const v = (JSON.parse(text) as { version?: string }).version
      return hint(v, `"version" in ${baseName(path)}`)
    }
  } catch {
    return undefined
  }
  if (lower === 'pom.xml') {
    let s = stripXmlComments(text)
    const props: Record<string, string> = {}
    for (const block of xmlBlocks(s, 'properties')) for (const m of block.matchAll(/<([A-Za-z0-9_.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props[m[1]] = m[2]
    for (const tag of ['parent', 'dependencies', 'dependencyManagement', 'build', 'profiles', 'plugins', 'reporting', 'properties', 'distributionManagement']) {
      s = s.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g'), '')
    }
    return hint(interpolate(xmlText(s, 'version'), props), 'project <version>')
  }
  if (/^build\.gradle(\.kts)?$/.test(lower)) return hint(/^\s*version\s*=\s*['"]([^'"]+)['"]/m.exec(text)?.[1], 'version = in build script')
  if (lower === 'gradle.properties') return hint(parseProperties(text).version, 'version= in gradle.properties')
  if (lower === 'chart.yaml') {
    const app = yamlTop(text, 'appVersion')
    return hint(app, 'appVersion in Chart.yaml') ?? hint(yamlTop(text, 'version'), 'chart version')
  }
  if (lower === 'pyproject.toml') return hint(tomlTableVersion(text, 'project'), '[project] version') ?? hint(tomlTableVersion(text, 'tool.poetry'), '[tool.poetry] version')
  if (lower === 'cargo.toml') return hint(tomlTableVersion(text, 'package'), '[package] version')
  if (lower === 'mix.exs') return hint(/version:\s*"([^"]+)"/.exec(text)?.[1], 'version: in mix.exs')
  if (isCsproj(lower)) return hint(/<Version>\s*([^<]+?)\s*<\/Version>/.exec(text)?.[1], '<Version>')
  if (lower === 'version') return hint(text.trim().split('\n')[0], 'VERSION file')
  return undefined
}

/**
 * Every app-version hint the files give, best first: a build manifest in a
 * focus folder (the entity's own app), then the chart, then the rest, by
 * path depth. `focus` lists folder prefixes in priority order ('' = root).
 */
export function detectAppVersions(files: Record<string, string>, focus: string[] = []): AppVersionHint[] {
  const kindRank = (p: string) => {
    const n = baseName(p).toLowerCase()
    if (n === 'chart.yaml') return 2
    if (n === 'version') return 1
    return 0
  }
  const focusRank = (p: string) => {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    const i = focus.findIndex((f) => dir === f || (f && dir.startsWith(`${f}/`)))
    return i < 0 ? focus.length : i
  }
  const hints: AppVersionHint[] = []
  for (const [path, text] of Object.entries(files)) {
    const h = appVersionFrom(path, text)
    if (h) hints.push(h)
  }
  return hints.sort((a, b) => focusRank(a.source) - focusRank(b.source) || kindRank(a.source) - kindRank(b.source) || a.source.split('/').length - b.source.split('/').length)
}

/**
 * Two version strings that describe the same thing: equal, or one a
 * dotted prefix of the other (`21` / `21.0.2`, `3.3` / `3.3.2`), ignoring a
 * trailing `+` from a range (`20+` / `20`). Used so compatible precision
 * differences are not flagged as conflicts.
 */
export function sameVersion(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = a.replace(/\+$/, '').replace(/^v/i, '')
  const y = b.replace(/\+$/, '').replace(/^v/i, '')
  return x === y || x.startsWith(`${y}.`) || y.startsWith(`${x}.`)
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
    else if (lower === 'chart.yaml') out.push(...parseChart(text, path))
    else if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(lower)) out.push(...parseCompose(text, path))
    else {
      const ci = parseCiFile(text, path)
      if (ci) out.push(...ci.mentions)
    }
  }
  // Presence signals: one mention per tech, naming the first file and how many there are.
  const seen = new Map<string, { source: string; detail: string; n: number }>()
  for (const p of listing) {
    for (const x of PRESENCE) {
      if (!x.re.test(x.path ? p : baseName(p))) continue
      const cur = seen.get(x.key)
      if (cur) cur.n++
      else seen.set(x.key, { source: x.path ? p : p, detail: x.detail, n: 1 })
      break
    }
  }
  for (const [key, v] of seen) out.push({ key, source: v.source, detail: v.n > 1 ? `${v.detail} (${v.n} files)` : v.detail, rank: RANK_HINT + 1 })
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
    const seen: string[] = best.version ? [best.version] : []
    const also: DetectedTech['also'] = []
    for (const m of sorted) {
      if (!m.version || seen.some((v) => sameVersion(v, m.version))) continue
      seen.push(m.version)
      also.push({ version: m.version, source: m.source, detail: m.detail })
    }
    out.push({ key, version: best.version, source: best.source, detail: best.detail, also })
  }
  return out
}

/* ─────────── repository layout: which folder, which files ─────────── */

/** Subfolders a service often keeps its build in when the root has none. */
export const NESTED_DIRS = /^(backend|server|service|api|app|frontend|web)$/i
/** Monorepo workspace containers: `apps/<name>`, `services/<name>`, … */
const WORKSPACE_DIRS = /^(apps|services|packages|libs|modules|projects|components|cmd)$/i
/** Folders whose contents say nothing about the service itself. */
export const SKIP_DIRS = /(^|\/)(node_modules|vendor|dist|build|target|out|\.git|\.idea|\.vscode|third_party|testdata|__fixtures__|fixtures|examples?|\.next|\.nuxt|coverage)(\/|$)/i
export const MAX_SCAN_FILES = 40

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** `v1.4.2` / `release-1.4.2` / `api/v2.0.0` → the version; undefined for tags that are not versions. */
export function tagVersion(tag: string): string | undefined {
  const m = /(?:^|[-_/@])v?(\d+(?:\.\d+)*(?:[-+][\w.]+)?)$/i.exec(tag.trim())
  return m ? m[1] : undefined
}

/**
 * Pick the folder that is this entity's app. In order: the folder the
 * entity names (annotation / source-location path), a manifest folder named
 * after the entity (`apps/<name>`, `services/<name>`), the root when it has a
 * build file, else undefined (scan every manifest folder near the top).
 */
export function chooseFocus(paths: string[], entityName: string, explicit: string): { focus: string; reason?: string } {
  if (explicit) return { focus: explicit, reason: 'entity source path' }
  const manifestDirs = [...new Set(paths.filter((p) => hasManifest([p])).map(dirOf))]
  const name = entityName.toLowerCase()
  const bare = name.replace(/-(service|svc|app|api|web|ui|frontend|backend|server)$/, '')
  const named = manifestDirs
    .filter((d) => {
      const base = d.split('/').pop()?.toLowerCase() ?? ''
      return d && (base === name || base === bare)
    })
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  if (named) return { focus: named, reason: `folder named after ${entityName}` }
  if (manifestDirs.includes('')) return { focus: '', reason: 'build file at the repository root' }
  return { focus: '' }
}

/**
 * Which files to read: build files in the focus folder, at the root, in
 * nested service folders when neither has one, plus CI definitions and Helm
 * charts. Capped at MAX_SCAN_FILES, best first.
 */
export function planScan(allPaths: string[], focus: string): { want: string[]; dirs: string[]; listing: string[] } {
  const paths = allPaths.filter((p) => !SKIP_DIRS.test(p))
  // In a monorepo, other apps' files would bleed into this one's stack.
  const inScope = (p: string) => {
    if (!focus) return true
    if (p.startsWith(`${focus}/`)) return true
    const top = p.split('/')[0]
    return !(p.includes('/') && WORKSPACE_DIRS.test(top))
  }
  const listing = paths.filter(inScope)
  const blobsIn = (d: string) => listing.filter((p) => dirOf(p) === d)
  const subdirsOf = (d: string) => [...new Set(listing.filter((p) => dirOf(p).startsWith(d ? `${d}/` : '') && dirOf(p) !== d).map((p) => {
    const rest = d ? p.slice(d.length + 1) : p
    return (d ? `${d}/` : '') + rest.split('/')[0]
  }))]
  const dirs: string[] = []
  if (focus) dirs.push(focus)
  if (!dirs.includes('')) dirs.push('')
  if (!hasManifest(blobsIn(focus)) && !hasManifest(blobsIn(''))) {
    // No build file where we looked: the nearest manifest folders (depth ≤ 2), service-named ones first.
    const candidates = [...new Set(listing.filter((p) => hasManifest([p])).map(dirOf))]
      .filter((d) => d && d.split('/').length <= 2)
      .sort((a, b) => Number(!NESTED_DIRS.test(a.split('/').pop() ?? '')) - Number(!NESTED_DIRS.test(b.split('/').pop() ?? '')) || a.split('/').length - b.split('/').length || a.localeCompare(b))
    dirs.push(...candidates.slice(0, 4))
  }
  const exists = new Set(listing)
  const want: string[] = []
  const add = (p: string) => {
    if (!want.includes(p) && exists.has(p)) want.push(p)
  }
  for (const d of dirs) for (const p of wantedFiles(blobsIn(d), subdirsOf(d))) add(p)
  for (const p of ciFiles(listing, 4)) add(p)
  // Helm charts anywhere in scope (charts/<name>/Chart.yaml, deploy/helm/Chart.yaml), focus first.
  listing.filter((p) => /(^|\/)chart\.ya?ml$/i.test(p)).sort((a, b) => Number(!a.startsWith(focus)) - Number(!b.startsWith(focus)) || a.length - b.length).slice(0, 2).forEach(add)
  return { want: want.slice(0, MAX_SCAN_FILES), dirs, listing }
}
