import { type DetectedTech, sameVersion } from './catalog-techstack.ts'

/**
 * The slice of a catalog Entity this module reads. Structural, so the
 * module (and its tests) don't pull in the catalog's React-side imports.
 */
export interface TechEntity {
  metadata: { name: string; tags?: string[]; annotations?: Record<string, string> }
}
type Entity = TechEntity

/**
 * The catalog's tech vocabulary: which tags, annotations and repository
 * detections become a recognisable badge (label, tone, section), and how
 * the catalog's own record is folded together with what the repository's
 * build files say. Pure — no React, no I/O — so the merge rules are tested.
 */

export type TechTone =
  | 'amber'
  | 'sky'
  | 'blue'
  | 'cyan'
  | 'indigo'
  | 'violet'
  | 'emerald'
  | 'green'
  | 'teal'
  | 'rose'
  | 'red'
  | 'orange'
  | 'slate'

/** Where a technology sits in the stack — drives the sections of the Tech stack tab. */
export type TechGroup = 'language' | 'framework' | 'datastore' | 'build' | 'testing' | 'delivery' | 'observability'

export interface TechBadge {
  label: string
  tone: TechTone
  group: TechGroup
  /** Canonical key (`java`, `spring-boot`) — for support lookups. Set by techStack/withRepoTech. */
  key?: string
  /** A version, when the tag, annotation or a build file carried one (`java-21` → "21"). */
  version?: string
  /** Repository path the version was read from (`pom.xml`), when the repo scan found it. */
  file?: string
  /** How the file says it — `<parent> spring-boot-starter-parent`, `engines.node >=20`. */
  detail?: string
  /** Other versions recorded elsewhere that disagree (a tag, the Dockerfile's base image). */
  also?: Array<{ version: string; from: string; file?: boolean }>
  /** Share of the repository's code (0–100) when Gitea's language stats name it. */
  share?: number
}

/** Section headings, in the order a reader builds a mental model of a service. */
export const TECH_GROUP_LABEL: Record<TechGroup, string> = {
  language: 'Languages & runtimes',
  framework: 'Frameworks & libraries',
  datastore: 'Data & messaging',
  build: 'Build & packaging',
  testing: 'Testing & quality',
  delivery: 'Delivery',
  observability: 'Observability',
}
export const TECH_GROUP_ORDER: TechGroup[] = ['language', 'framework', 'datastore', 'build', 'testing', 'delivery', 'observability']

const b = (label: string, tone: TechTone, group: TechGroup): TechBadge => ({ label, tone, group })

/**
 * Known language / framework tags → a recognisable, brand-ish badge. Keys are
 * the lowercased tag values `catalog-live.ts` derives from a repo's primary
 * language (`['java','repo']`, `['python','ml']`) or `adhar.io/tags`, and the
 * keys the repository scan (`catalog-techstack.ts`) reports. Anything not in
 * here is treated as a generic tag — never guessed at.
 */
export const TECH_MAP: Record<string, TechBadge> = {
  // ── languages & runtimes ──
  java: b('Java', 'orange', 'language'),
  python: b('Python', 'blue', 'language'),
  py: b('Python', 'blue', 'language'),
  go: b('Go', 'cyan', 'language'),
  golang: b('Go', 'cyan', 'language'),
  typescript: b('TypeScript', 'blue', 'language'),
  ts: b('TypeScript', 'blue', 'language'),
  javascript: b('JavaScript', 'amber', 'language'),
  js: b('JavaScript', 'amber', 'language'),
  rust: b('Rust', 'orange', 'language'),
  'c#': b('C#', 'violet', 'language'),
  csharp: b('C#', 'violet', 'language'),
  ruby: b('Ruby', 'red', 'language'),
  php: b('PHP', 'indigo', 'language'),
  kotlin: b('Kotlin', 'violet', 'language'),
  scala: b('Scala', 'red', 'language'),
  groovy: b('Groovy', 'sky', 'language'),
  elixir: b('Elixir', 'violet', 'language'),
  shell: b('Shell', 'slate', 'language'),
  bash: b('Shell', 'slate', 'language'),
  // Language runtimes sit with their language: "Node.js 20" is what a reader
  // means by "which JavaScript".
  node: b('Node.js', 'green', 'language'),
  nodejs: b('Node.js', 'green', 'language'),
  'node.js': b('Node.js', 'green', 'language'),
  deno: b('Deno', 'slate', 'language'),
  bun: b('Bun', 'amber', 'language'),
  dotnet: b('.NET', 'violet', 'language'),
  '.net': b('.NET', 'violet', 'language'),
  // ── frameworks & libraries ──
  spring: b('Spring', 'green', 'framework'),
  'spring-boot': b('Spring Boot', 'green', 'framework'),
  springboot: b('Spring Boot', 'green', 'framework'),
  'spring-cloud': b('Spring Cloud', 'green', 'framework'),
  'spring-security': b('Spring Security', 'green', 'framework'),
  webflux: b('Spring WebFlux', 'green', 'framework'),
  express: b('Express', 'slate', 'framework'),
  react: b('React', 'cyan', 'framework'),
  vue: b('Vue', 'emerald', 'framework'),
  svelte: b('Svelte', 'orange', 'framework'),
  next: b('Next.js', 'slate', 'framework'),
  nextjs: b('Next.js', 'slate', 'framework'),
  'next.js': b('Next.js', 'slate', 'framework'),
  nuxt: b('Nuxt', 'emerald', 'framework'),
  astro: b('Astro', 'orange', 'framework'),
  remix: b('Remix', 'slate', 'framework'),
  tanstack: b('TanStack', 'amber', 'framework'),
  hono: b('Hono', 'orange', 'framework'),
  koa: b('Koa', 'slate', 'framework'),
  tailwind: b('Tailwind CSS', 'sky', 'framework'),
  django: b('Django', 'emerald', 'framework'),
  flask: b('Flask', 'slate', 'framework'),
  fastapi: b('FastAPI', 'teal', 'framework'),
  rails: b('Rails', 'red', 'framework'),
  'ruby-on-rails': b('Rails', 'red', 'framework'),
  quarkus: b('Quarkus', 'sky', 'framework'),
  micronaut: b('Micronaut', 'cyan', 'framework'),
  grpc: b('gRPC', 'teal', 'framework'),
  graphql: b('GraphQL', 'rose', 'framework'),
  angular: b('Angular', 'red', 'framework'),
  nestjs: b('NestJS', 'rose', 'framework'),
  fastify: b('Fastify', 'slate', 'framework'),
  gin: b('Gin', 'cyan', 'framework'),
  echo: b('Echo', 'cyan', 'framework'),
  fiber: b('Fiber', 'cyan', 'framework'),
  actix: b('Actix Web', 'orange', 'framework'),
  axum: b('Axum', 'orange', 'framework'),
  rocket: b('Rocket', 'orange', 'framework'),
  laravel: b('Laravel', 'red', 'framework'),
  symfony: b('Symfony', 'slate', 'framework'),
  phoenix: b('Phoenix', 'orange', 'framework'),
  // ── data & messaging ──
  postgres: b('PostgreSQL', 'blue', 'datastore'),
  postgresql: b('PostgreSQL', 'blue', 'datastore'),
  mysql: b('MySQL', 'sky', 'datastore'),
  mariadb: b('MariaDB', 'orange', 'datastore'),
  mongodb: b('MongoDB', 'green', 'datastore'),
  redis: b('Redis', 'red', 'datastore'),
  valkey: b('Valkey', 'red', 'datastore'),
  kafka: b('Kafka', 'slate', 'datastore'),
  rabbitmq: b('RabbitMQ', 'orange', 'datastore'),
  nats: b('NATS', 'teal', 'datastore'),
  pulsar: b('Pulsar', 'sky', 'datastore'),
  cassandra: b('Cassandra', 'sky', 'datastore'),
  sqlite: b('SQLite', 'blue', 'datastore'),
  clickhouse: b('ClickHouse', 'amber', 'datastore'),
  elasticsearch: b('Elasticsearch', 'teal', 'datastore'),
  opensearch: b('OpenSearch', 'teal', 'datastore'),
  s3: b('S3', 'emerald', 'datastore'),
  minio: b('MinIO', 'red', 'datastore'),
  jpa: b('JPA / Hibernate', 'amber', 'datastore'),
  flyway: b('Flyway', 'red', 'datastore'),
  liquibase: b('Liquibase', 'sky', 'datastore'),
  prisma: b('Prisma', 'indigo', 'datastore'),
  typeorm: b('TypeORM', 'orange', 'datastore'),
  sequelize: b('Sequelize', 'blue', 'datastore'),
  drizzle: b('Drizzle ORM', 'green', 'datastore'),
  sqlalchemy: b('SQLAlchemy', 'red', 'datastore'),
  gorm: b('GORM', 'cyan', 'datastore'),
  // ── build & packaging ──
  maven: b('Maven', 'rose', 'build'),
  gradle: b('Gradle', 'teal', 'build'),
  npm: b('npm', 'red', 'build'),
  pnpm: b('pnpm', 'amber', 'build'),
  yarn: b('Yarn', 'sky', 'build'),
  'go-modules': b('Go modules', 'cyan', 'build'),
  cargo: b('Cargo', 'orange', 'build'),
  pip: b('pip', 'blue', 'build'),
  poetry: b('Poetry', 'sky', 'build'),
  uv: b('uv', 'violet', 'build'),
  pdm: b('PDM', 'violet', 'build'),
  hatch: b('Hatch', 'blue', 'build'),
  pipenv: b('Pipenv', 'blue', 'build'),
  bundler: b('Bundler', 'red', 'build'),
  composer: b('Composer', 'amber', 'build'),
  mix: b('Mix', 'violet', 'build'),
  make: b('Make', 'slate', 'build'),
  bazel: b('Bazel', 'emerald', 'build'),
  nx: b('Nx', 'blue', 'build'),
  turborepo: b('Turborepo', 'rose', 'build'),
  vite: b('Vite', 'violet', 'build'),
  webpack: b('webpack', 'sky', 'build'),
  // ── testing & quality ──
  junit: b('JUnit', 'green', 'testing'),
  testng: b('TestNG', 'orange', 'testing'),
  mockito: b('Mockito', 'emerald', 'testing'),
  testcontainers: b('Testcontainers', 'teal', 'testing'),
  jest: b('Jest', 'rose', 'testing'),
  vitest: b('Vitest', 'amber', 'testing'),
  mocha: b('Mocha', 'amber', 'testing'),
  playwright: b('Playwright', 'green', 'testing'),
  cypress: b('Cypress', 'slate', 'testing'),
  'testing-library': b('Testing Library', 'red', 'testing'),
  pytest: b('pytest', 'sky', 'testing'),
  'go-test': b('go test', 'cyan', 'testing'),
  testify: b('testify', 'cyan', 'testing'),
  'deno-test': b('deno test', 'slate', 'testing'),
  rspec: b('RSpec', 'red', 'testing'),
  phpunit: b('PHPUnit', 'indigo', 'testing'),
  eslint: b('ESLint', 'indigo', 'testing'),
  prettier: b('Prettier', 'slate', 'testing'),
  biome: b('Biome', 'amber', 'testing'),
  'deno-lint': b('deno lint', 'slate', 'testing'),
  ruff: b('Ruff', 'amber', 'testing'),
  black: b('Black', 'slate', 'testing'),
  flake8: b('Flake8', 'blue', 'testing'),
  mypy: b('mypy', 'blue', 'testing'),
  pylint: b('Pylint', 'amber', 'testing'),
  'golangci-lint': b('golangci-lint', 'cyan', 'testing'),
  checkstyle: b('Checkstyle', 'amber', 'testing'),
  spotbugs: b('SpotBugs', 'rose', 'testing'),
  pmd: b('PMD', 'emerald', 'testing'),
  spotless: b('Spotless', 'sky', 'testing'),
  ktlint: b('ktlint', 'violet', 'testing'),
  detekt: b('detekt', 'violet', 'testing'),
  jacoco: b('JaCoCo', 'red', 'testing'),
  sonarqube: b('SonarQube', 'sky', 'testing'),
  trivy: b('Trivy', 'teal', 'testing'),
  rubocop: b('RuboCop', 'red', 'testing'),
  'pre-commit': b('pre-commit', 'amber', 'testing'),
  // ── delivery: CI, containers, Kubernetes, CD ──
  tekton: b('Tekton', 'sky', 'delivery'),
  'gitea-actions': b('Gitea Actions', 'green', 'delivery'),
  'github-actions': b('GitHub Actions', 'slate', 'delivery'),
  'gitlab-ci': b('GitLab CI', 'orange', 'delivery'),
  jenkins: b('Jenkins', 'red', 'delivery'),
  docker: b('Docker', 'blue', 'delivery'),
  oci: b('OCI image', 'blue', 'delivery'),
  'docker-compose': b('Docker Compose', 'blue', 'delivery'),
  buildpacks: b('Buildpacks', 'sky', 'delivery'),
  kpack: b('kpack', 'sky', 'delivery'),
  buildah: b('Buildah', 'slate', 'delivery'),
  kaniko: b('Kaniko', 'amber', 'delivery'),
  jib: b('Jib', 'blue', 'delivery'),
  skaffold: b('Skaffold', 'sky', 'delivery'),
  helm: b('Helm', 'indigo', 'delivery'),
  kustomize: b('Kustomize', 'indigo', 'delivery'),
  kubernetes: b('Kubernetes', 'blue', 'delivery'),
  k8s: b('Kubernetes', 'blue', 'delivery'),
  argocd: b('Argo CD', 'orange', 'delivery'),
  gitops: b('GitOps', 'orange', 'delivery'),
  kargo: b('Kargo', 'amber', 'delivery'),
  serverless: b('Serverless', 'violet', 'delivery'),
  knative: b('Knative', 'violet', 'delivery'),
  terraform: b('Terraform', 'violet', 'delivery'),
  crossplane: b('Crossplane', 'teal', 'delivery'),
  // ── observability ──
  otel: b('OpenTelemetry', 'indigo', 'observability'),
  opentelemetry: b('OpenTelemetry', 'indigo', 'observability'),
  prometheus: b('Prometheus client', 'orange', 'observability'),
  micrometer: b('Micrometer', 'teal', 'observability'),
  actuator: b('Spring Boot Actuator', 'green', 'observability'),
  sentry: b('Sentry', 'violet', 'observability'),
  datadog: b('Datadog', 'violet', 'observability'),
  logback: b('Logback', 'slate', 'observability'),
  log4j: b('Log4j 2', 'rose', 'observability'),
  'structured-logging': b('Structured logging', 'slate', 'observability'),
}

/** Full literal Tailwind classes (JIT-safe), matching the StatusBadge pill pattern. */
export const TECH_PILL: Record<TechTone, string> = {
  amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30',
  sky: 'bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-500/30',
  blue: 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 ring-blue-200 dark:ring-blue-500/30',
  cyan: 'bg-cyan-50 dark:bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 ring-cyan-200 dark:ring-cyan-500/30',
  indigo: 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 ring-indigo-200 dark:ring-indigo-500/30',
  violet: 'bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-violet-200 dark:ring-violet-500/30',
  emerald: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-500/30',
  green: 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300 ring-green-200 dark:ring-green-500/30',
  teal: 'bg-teal-50 dark:bg-teal-500/10 text-teal-700 dark:text-teal-300 ring-teal-200 dark:ring-teal-500/30',
  rose: 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/30',
  red: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 ring-red-200 dark:ring-red-500/30',
  orange: 'bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-300 ring-orange-200 dark:ring-orange-500/30',
  // The console theme inverts the slate ramp in dark mode, so slate needs no dark: overrides
  // (overriding it to slate-300 there made the mark near-invisible).
  slate: 'bg-slate-100 text-slate-700 ring-slate-300',
}

/** The canonical key for a label (first TECH_MAP key with that label). */
export function keyForLabel(label: string): string | undefined {
  return Object.keys(TECH_MAP).find((k) => TECH_MAP[k].label === label)
}

/**
 * Split a tech tag into the TECH_MAP key and an optional version.
 *
 * `java-21`, `java@21`, `java:21`, `spring-boot-3.3.2`, `node_20` all read as
 * the tech plus a version; `java` alone reads as the tech. The key must be a
 * known tech — otherwise `python3` would become Python 3 by accident.
 */
export function parseTechTag(raw: string): { key: string; version?: string } {
  const t = raw.trim().toLowerCase()
  const m = t.match(/^([a-z#.+][a-z0-9#.+-]*?)[-@:_ ]v?(\d+(?:\.\d+)*)$/)
  if (m && TECH_MAP[m[1]]) return { key: m[1], version: m[2] }
  return { key: t }
}

function annotationsOf(e: Entity): Record<string, string> {
  const ann = e.metadata.annotations
  return ann && typeof ann === 'object' ? ann : {}
}

/**
 * Versions declared as an annotation, for installs that keep tags for
 * classification and record the stack elsewhere:
 *   adhar.io/tech-stack: "java@21, spring-boot@3.3.2, postgres@16"
 *   adhar.io/java-version: "21"   (any `<tech>-version` key TECH_MAP knows)
 */
export function techFromAnnotations(entity: Entity): Array<{ key: string; version?: string }> {
  const ann = annotationsOf(entity)
  const out: Array<{ key: string; version?: string }> = []
  const list = (ann['adhar.io/tech-stack'] ?? ann['adhar.io/tech'] ?? '').trim()
  if (list) {
    for (const part of list.split(/[,;]/)) {
      const item = part.trim().toLowerCase()
      if (!item) continue
      const m = item.match(/^([a-z#.+][a-z0-9#.+-]*?)(?:\s*[@:= ]\s*v?(\d+(?:\.\d+)*))?$/)
      if (m && TECH_MAP[m[1]]) out.push({ key: m[1], version: m[2] })
    }
  }
  for (const [k, v] of Object.entries(ann)) {
    const m = k.match(/^adhar\.io\/([a-z0-9.+#-]+)-version$/)
    if (m && TECH_MAP[m[1]] && v.trim()) out.push({ key: m[1], version: v.trim().replace(/^v/i, '') })
  }
  return out
}

/** Lowercased tags that mapped to a tech badge — kept out of the generic tag row. */
export function techTagKeys(entity: Entity): Set<string> {
  const out = new Set<string>()
  for (const t of entity.metadata.tags ?? []) {
    if (TECH_MAP[parseTechTag(t).key]) out.add(t.toLowerCase())
  }
  return out
}

/** Generic (non-tech) tags — the ones the plain tag treatment should render. */
export function genericTags(entity: Entity): string[] {
  const tech = techTagKeys(entity)
  return (entity.metadata.tags ?? []).filter((t) => !tech.has(t.toLowerCase()))
}

/**
 * Detected languages, frameworks, datastores — de-duped by label, each with
 * a version when one was recorded anywhere (tag or annotation). A versioned
 * mention wins over a bare one, so `java` + `adhar.io/java-version: 21`
 * reads as Java 21.
 */
export function techStack(entity: Entity): TechBadge[] {
  const byLabel = new Map<string, TechBadge>()
  const mentions = [
    ...(entity.metadata.tags ?? []).map(parseTechTag),
    ...techFromAnnotations(entity),
  ]
  for (const m of mentions) {
    const hit = TECH_MAP[m.key]
    if (!hit) continue
    const key = keyForLabel(hit.label) ?? m.key
    const cur = byLabel.get(hit.label)
    if (!cur) byLabel.set(hit.label, m.version ? { ...hit, key, version: m.version } : { ...hit, key })
    else if (!cur.version && m.version) byLabel.set(hit.label, { ...hit, key, version: m.version })
  }
  return [...byLabel.values()]
}

/**
 * Fold what the repository's build files say into the catalog's own stack.
 * A build file is the ground truth for a version (it is what compiles), so
 * its number replaces a tag's; a tag or annotation that disagrees is kept
 * under `also` rather than silently dropped. Techs only the repository knows
 * about (Maven, the Dockerfile's base image) are added.
 *
 * Versions that differ only in precision (`21` / `21.0.2`, `20+` / `20`) are
 * the same line and never reported as a conflict, and an `also` list never
 * repeats the version shown or another `also` entry.
 */
export function withRepoTech(stack: TechBadge[], detected: DetectedTech[] | undefined): TechBadge[] {
  if (!detected?.length) return stack
  const out = [...stack]
  const dedupe = (version: string | undefined, list: NonNullable<TechBadge['also']>) => {
    const kept: NonNullable<TechBadge['also']> = []
    for (const a of list) {
      if (sameVersion(a.version, version) || kept.some((k) => sameVersion(k.version, a.version))) continue
      kept.push(a)
    }
    return kept
  }
  for (const d of detected) {
    const hit = TECH_MAP[d.key]
    if (!hit) continue
    const key = keyForLabel(hit.label) ?? d.key
    const also = d.also.map((a) => ({ version: a.version, from: a.source, file: true }))
    const i = out.findIndex((x) => x.label === hit.label)
    if (i < 0) {
      out.push({ ...hit, key, version: d.version, file: d.source, detail: d.detail, also: dedupe(d.version, also) })
      continue
    }
    const cur = out[i]
    if (!d.version) {
      // The repo confirms the tech but not its version — keep the catalog's, note the file.
      if (!cur.version && !cur.file) out[i] = { ...cur, key, file: d.source, detail: d.detail }
      continue
    }
    // What the badge said before this detection: a catalog tag, or an earlier file.
    const before = cur.version && !sameVersion(cur.version, d.version)
      ? [cur.file ? { version: cur.version, from: cur.file, file: true } : { version: cur.version, from: 'catalog tag / annotation' }]
      : []
    out[i] = { ...cur, key, version: d.version, file: d.source, detail: d.detail, also: dedupe(d.version, [...before, ...(cur.also ?? []), ...also]) }
  }
  return out
}

/* ─────────── language composition (Gitea / GitHub language stats) ─────────── */

/**
 * Linguist's colours for common languages (public data, no logos) so the
 * composition bar reads like the forge's own. Unknown languages get a grey.
 */
export const LANGUAGE_COLOR: Record<string, string> = {
  Java: '#b07219', Kotlin: '#A97BFF', Scala: '#c22d40', Groovy: '#4298b8', TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Go: '#00ADD8',
  Rust: '#dea584', 'C#': '#178600', 'F#': '#b845fc', Ruby: '#701516', PHP: '#4F5D95', Elixir: '#6e4a7e', Shell: '#89e051', PowerShell: '#012456',
  Dockerfile: '#384d54', HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c', Vue: '#41b883', Svelte: '#ff3e00', Makefile: '#427819', HCL: '#844FBA',
  Smarty: '#f0c040', Mustache: '#724b3b', 'Go Template': '#00ADD8', Swift: '#F05138', Dart: '#00B4AB', C: '#555555', 'C++': '#f34b7d', Lua: '#000080',
  Jsonnet: '#0064bd', Starlark: '#76d275', MDX: '#fcb32c', Astro: '#ff5a03', Batchfile: '#C1F12E', TSQL: '#e38c00', PLpgSQL: '#336790', Nix: '#7e7eff',
}
const FALLBACK_COLORS = ['#94a3b8', '#64748b', '#a1a1aa', '#78716c', '#9ca3af']

/** Gitea/linguist language names → TECH_MAP keys (only real languages). */
const LANGUAGE_KEY: Record<string, string> = {
  Java: 'java', Kotlin: 'kotlin', Scala: 'scala', Groovy: 'groovy', TypeScript: 'typescript', JavaScript: 'javascript', Python: 'python', Go: 'go', Rust: 'rust',
  'C#': 'csharp', Ruby: 'ruby', PHP: 'php', Elixir: 'elixir', Shell: 'shell',
}

export interface LanguageShare {
  name: string
  bytes: number
  /** Percentage of all bytes, one decimal. */
  pct: number
  color: string
  /** TECH_MAP key, when the language is one the catalog knows. */
  key?: string
}

/**
 * Bytes per language → shares, largest first. Tiny languages (under
 * `minPct`) are folded into one "Other" entry so the bar stays legible.
 */
export function languageComposition(bytes: Record<string, number> | undefined, minPct = 1): LanguageShare[] {
  const entries = Object.entries(bytes ?? {}).filter(([, n]) => Number.isFinite(n) && n > 0)
  const total = entries.reduce((s, [, n]) => s + n, 0)
  if (!total) return []
  const sorted = entries.sort((a, b) => b[1] - a[1])
  const out: LanguageShare[] = []
  let other = 0
  let fallback = 0
  for (const [name, n] of sorted) {
    const pct = (n / total) * 100
    if (pct < minPct && out.length >= 1) {
      other += n
      continue
    }
    out.push({ name, bytes: n, pct: Math.round(pct * 10) / 10, color: LANGUAGE_COLOR[name] ?? FALLBACK_COLORS[fallback++ % FALLBACK_COLORS.length], key: LANGUAGE_KEY[name] })
  }
  if (other) out.push({ name: 'Other', bytes: other, pct: Math.round((other / total) * 1000) / 10, color: '#cbd5e1' })
  return out
}

/**
 * Reconcile the language stats with the stack: each language badge gets
 * its share, and a language with a real share (≥ `minPct`) that no build
 * file or tag mentioned is added — "Kotlin 18%" belongs on the list even
 * when only the Java plugin was detected. Shell and markup are never added
 * (every repo has a script), only annotated if already present.
 */
export function withLanguageShares(stack: TechBadge[], shares: LanguageShare[], minPct = 5): TechBadge[] {
  if (!shares.length) return stack
  const out = stack.map((x) => {
    const s = shares.find((l) => l.key && TECH_MAP[l.key]?.label === x.label)
    return s ? { ...x, share: s.pct } : x
  })
  for (const s of shares) {
    if (!s.key || s.key === 'shell' || s.pct < minPct) continue
    const hit = TECH_MAP[s.key]
    if (!hit || out.some((x) => x.label === hit.label)) continue
    out.push({ ...hit, key: s.key, share: s.pct, detail: 'repository language statistics' })
  }
  return out
}

/** The primary language: largest share among known languages, else the first language badge. */
export function primaryLanguage(stack: TechBadge[], shares: LanguageShare[]): TechBadge | undefined {
  const langs = stack.filter((x) => x.group === 'language' && !['Node.js', 'Deno', 'Bun', 'Shell', '.NET'].includes(x.label))
  for (const s of shares) {
    const hit = s.key ? langs.find((x) => x.label === TECH_MAP[s.key!]?.label) : undefined
    if (hit) return hit
  }
  return langs[0]
}

/** The runtime that executes a language (Node.js for TS/JS, the JVM language itself, …). */
export function runtimeFor(lang: TechBadge | undefined, stack: TechBadge[]): TechBadge | undefined {
  if (!lang) return undefined
  if (lang.label === 'TypeScript' || lang.label === 'JavaScript') return stack.find((x) => ['Node.js', 'Deno', 'Bun'].includes(x.label) && x.version) ?? stack.find((x) => ['Node.js', 'Deno', 'Bun'].includes(x.label))
  if (lang.label === 'Kotlin' || lang.label === 'Scala' || lang.label === 'Groovy') return stack.find((x) => x.label === 'Java')
  if (lang.label === 'C#') return stack.find((x) => x.label === '.NET')
  return lang
}

/** Build tools in order of how much they say about the build (a wrapper beats a lockfile). */
const BUILD_PRIORITY = ['Maven', 'Gradle', 'Bazel', 'Go modules', 'Cargo', 'pnpm', 'Yarn', 'npm', 'Bun', 'Deno', 'Poetry', 'uv', 'PDM', 'Hatch', 'Pipenv', 'pip', 'Bundler', 'Composer', 'Mix', 'Make']

export function primaryBuildTool(stack: TechBadge[]): TechBadge | undefined {
  for (const label of BUILD_PRIORITY) {
    const hit = stack.find((x) => x.label === label)
    if (hit) return hit
  }
  return stack.find((x) => x.group === 'build')
}

/** Frameworks that define the application, ahead of libraries that sit beside them. */
const FRAMEWORK_PRIORITY = ['Spring Boot', 'Quarkus', 'Micronaut', 'Next.js', 'Nuxt', 'Remix', 'Astro', 'Angular', 'NestJS', 'Django', 'FastAPI', 'Flask', 'Rails', 'Laravel', 'Symfony', 'Phoenix', 'Express', 'Fastify', 'Hono', 'Koa', 'Gin', 'Echo', 'Fiber', 'Actix Web', 'Axum', 'Rocket', 'React', 'Vue', 'Svelte']

export function primaryFramework(stack: TechBadge[]): TechBadge | undefined {
  for (const label of FRAMEWORK_PRIORITY) {
    const hit = stack.find((x) => x.label === label)
    if (hit) return hit
  }
  return stack.find((x) => x.group === 'framework')
}

/** Two-letter mark for a badge — the tile beside each tech. */
export function techInitials(label: string): string {
  const words = label.replace(/[^A-Za-z0-9#.+ ]/g, ' ').trim().split(/\s+/)
  if (words.length > 1 && words[1] && /^[A-Za-z]/.test(words[1])) return (words[0][0] + words[1][0]).toUpperCase()
  return label.replace(/[^A-Za-z0-9#+]/g, '').slice(0, 2).replace(/^./, (c) => c.toUpperCase())
}
