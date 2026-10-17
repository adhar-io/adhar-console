import { assertEquals } from 'jsr:@std/assert@^1'
import {
  languageComposition,
  parseTechTag,
  primaryBuildTool,
  primaryFramework,
  primaryLanguage,
  runtimeFor,
  TECH_GROUP_ORDER,
  TECH_MAP,
  type TechEntity,
  techStack,
  withLanguageShares,
  withRepoTech,
} from './catalog-tech-badges.ts'
import type { DetectedTech } from './catalog-techstack.ts'

const entity = (tags: string[], annotations: Record<string, string> = {}): TechEntity => ({ metadata: { name: 'orders', tags, annotations } })
const det = (key: string, version?: string, source = 'pom.xml', also: DetectedTech['also'] = []): DetectedTech => ({ key, version, source, also })

Deno.test('every TECH_MAP entry sits in a known section', () => {
  for (const [k, v] of Object.entries(TECH_MAP)) assertEquals(TECH_GROUP_ORDER.includes(v.group), true, k)
})

Deno.test('parseTechTag and techStack: versions from tags and annotations', () => {
  assertEquals(parseTechTag('java-21'), { key: 'java', version: '21' })
  assertEquals(parseTechTag('python3'), { key: 'python3' })
  const s = techStack(entity(['java', 'spring-boot-3.3.2', 'repo'], { 'adhar.io/java-version': '21' }))
  assertEquals(s.map((b) => [b.label, b.version, b.key]), [['Java', '21', 'java'], ['Spring Boot', '3.3.2', 'spring-boot']])
})

Deno.test('withRepoTech: build file wins, the tag is kept as also', () => {
  const out = withRepoTech(techStack(entity(['java-17'])), [det('java', '21')])
  assertEquals(out[0].version, '21')
  assertEquals(out[0].also, [{ version: '17', from: 'catalog tag / annotation' }])
})

Deno.test('withRepoTech: precision differences are not conflicts, no duplicate also', () => {
  const out = withRepoTech(techStack(entity(['java-21'])), [det('java', '21.0.2', 'pom.xml', [{ version: '21', source: 'Dockerfile' }, { version: '17', source: '.sdkmanrc' }])])
  assertEquals(out[0].version, '21.0.2')
  assertEquals(out[0].also, [{ version: '17', from: '.sdkmanrc', file: true }])
})

Deno.test('withRepoTech: an alias detected twice keeps the first file version as also', () => {
  // `postgres` (compose image) and `postgresql` (alias) both map to PostgreSQL.
  const out = withRepoTech([], [det('postgres', '16', 'docker-compose.yml'), det('postgresql', '15', 'charts/x/values.yaml')])
  assertEquals(out.length, 1)
  assertEquals(out[0].version, '15')
  assertEquals(out[0].also, [{ version: '16', from: 'docker-compose.yml', file: true }])
})

Deno.test('withRepoTech: unversioned detection keeps the catalog version', () => {
  const out = withRepoTech(techStack(entity(['postgres-16'])), [det('postgres', undefined, 'pom.xml')])
  assertEquals([out[0].version, out[0].file], ['16', undefined])
  const added = withRepoTech([], [det('maven', '3.9.6', '.mvn/wrapper/maven-wrapper.properties')])
  assertEquals([added[0].label, added[0].group, added[0].key], ['Maven', 'build', 'maven'])
})

Deno.test('languageComposition: shares, colours, Other bucket', () => {
  const l = languageComposition({ Java: 900_000, Kotlin: 80_000, Shell: 15_000, Dockerfile: 4_000, Makefile: 1_000 })
  assertEquals(l.map((x) => x.name), ['Java', 'Kotlin', 'Shell', 'Other'])
  assertEquals(l[0].pct, 90)
  assertEquals(l[0].color, '#b07219')
  assertEquals(l[0].key, 'java')
  assertEquals(l[3].pct, 0.5)
  assertEquals(languageComposition({}), [])
  assertEquals(languageComposition(undefined), [])
})

Deno.test('withLanguageShares: annotates, adds real languages, never Shell', () => {
  const shares = languageComposition({ Java: 700, Kotlin: 250, Shell: 50 })
  const out = withLanguageShares(techStack(entity(['java-21'])), shares)
  assertEquals(out.map((b) => [b.label, b.share]), [['Java', 70], ['Kotlin', 25]])
})

Deno.test('summary picks: primary language, runtime, framework, build tool', () => {
  const stack = withRepoTech([], [det('node', '20', 'package.json'), det('typescript', '5.4', 'package.json'), det('react', '18.3.1', 'package.json'), det('next', '14.2', 'package.json'), det('npm'), det('pnpm', '9')])
  const shares = languageComposition({ TypeScript: 9000, JavaScript: 1000 })
  const lang = primaryLanguage(stack, shares)
  assertEquals(lang?.label, 'TypeScript')
  assertEquals(runtimeFor(lang, stack)?.label, 'Node.js')
  assertEquals(primaryFramework(stack)?.label, 'Next.js')
  assertEquals(primaryBuildTool(stack)?.label, 'pnpm')
})
