import { assertEquals } from 'jsr:@std/assert@^1'
import {
  cleanSpec,
  detectTech,
  mergeDetections,
  normalizeJava,
  parseDockerfile,
  parseGoMod,
  parseGradle,
  parsePackageJson,
  parsePinFile,
  parsePom,
  parsePyproject,
  parseSdkmanrc,
  parseToolVersions,
  parseVersionCatalog,
  parseWrapper,
  type TechMention,
  wantedFiles,
} from './catalog-techstack.ts'

/** The version (and the file it came from) a merged scan reports for one tech. */
function pick(mentions: TechMention[], key: string) {
  const hit = mergeDetections(mentions).find((d) => d.key === key)
  return hit ? { version: hit.version, source: hit.source } : undefined
}

/**
 * The bug that started this: a Spring Boot service tagged `java` +
 * `spring-boot` showed both without a version. The versions were always in
 * the pom — the starter parent and the java.version property.
 */
Deno.test('pom.xml: Spring Boot from the starter parent, Java from java.version', () => {
  const pom = `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.2</version>
    <relativePath/> <!-- lookup parent from repository -->
  </parent>
  <groupId>com.acme</groupId>
  <artifactId>orders</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <properties>
    <java.version>21</java.version>
    <spring-cloud.version>2023.0.3</spring-cloud.version>
  </properties>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId><scope>runtime</scope></dependency>
    <dependency><groupId>org.springframework.kafka</groupId><artifactId>spring-kafka</artifactId></dependency>
  </dependencies>
</project>`
  const m = parsePom(pom)
  assertEquals(pick(m, 'spring-boot'), { version: '3.3.2', source: 'pom.xml' })
  assertEquals(pick(m, 'java'), { version: '21', source: 'pom.xml' })
  assertEquals(pick(m, 'spring-cloud')?.version, '2023.0.3')
  assertEquals(pick(m, 'postgres')?.version, undefined)
  assertEquals(Boolean(pick(m, 'kafka')), true)
  assertEquals(Boolean(pick(m, 'maven')), true)
})

/** A company parent pom: Boot comes in as a BOM import whose version is a property. */
Deno.test('pom.xml: BOM import with ${property} interpolation and maven.compiler.release', () => {
  const pom = `<project>
  <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>7</version></parent>
  <properties>
    <spring-boot.version>3.2.5</spring-boot.version>
    <maven.compiler.release>17</maven.compiler.release>
  </properties>
  <dependencyManagement><dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>\${spring-boot.version}</version>
      <type>pom</type><scope>import</scope>
    </dependency>
  </dependencies></dependencyManagement>
</project>`
  const m = parsePom(pom)
  assertEquals(pick(m, 'spring-boot')?.version, '3.2.5')
  assertEquals(pick(m, 'java')?.version, '17')
})

Deno.test('pom.xml: compiler plugin source 1.8 reads as Java 8; Boot plugin version', () => {
  const pom = `<project><build><plugins>
    <plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId><version>2.7.18</version></plugin>
    <plugin><artifactId>maven-compiler-plugin</artifactId><configuration><source>1.8</source><target>1.8</target></configuration></plugin>
  </plugins></build></project>`
  const m = parsePom(pom)
  assertEquals(pick(m, 'spring-boot')?.version, '2.7.18')
  assertEquals(pick(m, 'java')?.version, '8')
})

/** The Boot parent sets java.version itself; without an override the default applies. */
Deno.test('pom.xml: Java falls back to the Boot parent default', () => {
  const pom = `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.1.0</version></parent></project>`
  assertEquals(pick(parsePom(pom), 'java')?.version, '17')
})

Deno.test('pom.xml: Kotlin version from kotlin.version', () => {
  const pom = `<project><properties><kotlin.version>1.9.24</kotlin.version><java.version>17</java.version></properties>
  <build><plugins><plugin><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-maven-plugin</artifactId></plugin></plugins></build></project>`
  assertEquals(pick(parsePom(pom), 'kotlin')?.version, '1.9.24')
})

Deno.test('build.gradle (Groovy): plugin version, sourceCompatibility', () => {
  const gradle = `plugins {
  id 'java'
  id 'org.springframework.boot' version '3.3.1'
  id 'io.spring.dependency-management' version '1.1.5'
}
group = 'com.acme'
java { sourceCompatibility = '17' }
ext { set('springCloudVersion', "2023.0.2") }
dependencies {
  implementation 'org.springframework.boot:spring-boot-starter-web'
  runtimeOnly 'org.postgresql:postgresql'
}`
  const m = parseGradle(gradle)
  assertEquals(pick(m, 'spring-boot'), { version: '3.3.1', source: 'build.gradle' })
  assertEquals(pick(m, 'java')?.version, '17')
  assertEquals(pick(m, 'spring-cloud')?.version, '2023.0.2')
  assertEquals(Boolean(pick(m, 'postgres')), true)
})

Deno.test('build.gradle.kts: toolchain and Kotlin plugin', () => {
  const kts = `plugins {
  id("org.springframework.boot") version "3.3.2"
  kotlin("jvm") version "2.0.0"
  kotlin("plugin.spring") version "2.0.0"
}
java {
  toolchain {
    languageVersion = JavaLanguageVersion.of(21)
  }
}`
  const m = parseGradle(kts, 'build.gradle.kts')
  assertEquals(pick(m, 'spring-boot')?.version, '3.3.2')
  assertEquals(pick(m, 'java')?.version, '21')
  assertEquals(pick(m, 'kotlin')?.version, '2.0.0')
})

Deno.test('Gradle: JavaVersion.VERSION_1_8, legacy buildscript ext + gradle.properties', () => {
  const gradle = `buildscript {
  dependencies { classpath("org.springframework.boot:spring-boot-gradle-plugin:\${springBootVersion}") }
}
apply plugin: 'org.springframework.boot'
sourceCompatibility = JavaVersion.VERSION_1_8`
  const m = parseGradle(gradle, 'build.gradle', { properties: 'springBootVersion=2.7.0\n' })
  assertEquals(pick(m, 'spring-boot')?.version, '2.7.0')
  assertEquals(pick(m, 'java')?.version, '8')
})

Deno.test('Gradle: Kotlin jvmToolchain(17)', () => {
  assertEquals(pick(parseGradle('kotlin { jvmToolchain(17) }', 'build.gradle.kts'), 'java')?.version, '17')
})

/** `alias(libs.plugins.spring.boot)` carries no version in the script — the catalog does. */
Deno.test('Gradle: version catalog plugin alias and [versions]', () => {
  const toml = `[versions]
springBoot = "3.3.0"
java = "21"
kotlin = "1.9.23"

[libraries]
pg = { module = "org.postgresql:postgresql", version = "42.7.3" }

[plugins]
spring-boot = { id = "org.springframework.boot", version.ref = "springBoot" }
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
`
  const cat = parseVersionCatalog(toml)
  assertEquals(cat.plugins[0], { id: 'org.springframework.boot', version: '3.3.0' })
  assertEquals(cat.libraries[0], { module: 'org.postgresql:postgresql', version: '42.7.3' })
  const kts = `plugins {
  alias(libs.plugins.spring.boot)
  alias(libs.plugins.kotlin.jvm)
}`
  const m = parseGradle(kts, 'build.gradle.kts', { catalog: toml })
  assertEquals(pick(m, 'spring-boot'), { version: '3.3.0', source: 'gradle/libs.versions.toml' })
  assertEquals(pick(m, 'java')?.version, '21')
  assertEquals(pick(m, 'kotlin')?.version, '1.9.23')
})

Deno.test('wrappers: Gradle and Maven distribution versions', () => {
  assertEquals(
    parseWrapper('distributionUrl=https\\://services.gradle.org/distributions/gradle-8.8-bin.zip\n', 'gradle/wrapper/gradle-wrapper.properties')[0].version,
    '8.8',
  )
  assertEquals(
    parseWrapper('distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.6/apache-maven-3.9.6-bin.zip', '.mvn/wrapper/maven-wrapper.properties')[0],
    { key: 'maven', version: '3.9.6', source: '.mvn/wrapper/maven-wrapper.properties', detail: 'Maven wrapper distributionUrl', rank: 10 },
  )
})

Deno.test('pin files: .java-version, .sdkmanrc, .tool-versions, .nvmrc', () => {
  assertEquals(parsePinFile('java', 'temurin-21.0.2\n', '.java-version')[0].version, '21.0.2')
  assertEquals(parsePinFile('java', '1.8\n', '.java-version')[0].version, '8')
  const sdk = parseSdkmanrc('# Enable auto-env\njava=21.0.2-tem\ngradle=8.5\n')
  assertEquals(sdk.map((m) => [m.key, m.version]), [['java', '21.0.2'], ['gradle', '8.5']])
  const tv = parseToolVersions('java temurin-17.0.10+7\nnodejs 20.11.0\npython 3.12.1\ngolang 1.22.1\n')
  assertEquals(tv.map((m) => [m.key, m.version]), [['java', '17.0.10'], ['node', '20.11.0'], ['python', '3.12.1'], ['go', '1.22.1']])
  assertEquals(parsePinFile('node', 'lts/iron', '.nvmrc')[0].version, '20')
  assertEquals(parsePinFile('node', 'v20.11.1', '.nvmrc')[0].version, '20.11.1')
  assertEquals(parsePinFile('python', 'python-3.11.4', 'runtime.txt')[0].version, '3.11.4')
})

Deno.test('Dockerfile: JRE base image, ARG interpolation, build-stage images', () => {
  const df = `ARG JAVA_VERSION=21
FROM maven:3.9.6-eclipse-temurin-\${JAVA_VERSION} AS build
WORKDIR /src
RUN mvn -q package
FROM eclipse-temurin:\${JAVA_VERSION}-jre-alpine
COPY --from=build /src/target/app.jar /app.jar`
  const m = parseDockerfile(df)
  assertEquals(pick(m, 'java'), { version: '21', source: 'Dockerfile' })
  assertEquals(pick(m, 'maven')?.version, '3.9.6')
  assertEquals(mergeDetections(m).find((d) => d.key === 'docker')?.detail, 'final stage eclipse-temurin:21-jre-alpine')
  assertEquals(pick(parseDockerfile('FROM gcr.io/distroless/java17-debian12'), 'java')?.version, '17')
  assertEquals(pick(parseDockerfile('FROM node:20-alpine'), 'node')?.version, '20')
  assertEquals(pick(parseDockerfile('FROM python:3.12-slim'), 'python')?.version, '3.12')
  assertEquals(pick(parseDockerfile('FROM mcr.microsoft.com/dotnet/aspnet:8.0'), 'dotnet')?.version, '8.0')
})

/**
 * The build file outranks the base image — it is what the code targets —
 * but a disagreeing image is kept, because "compiled for 17, running on 21"
 * is worth seeing.
 */
Deno.test('merge: build file wins, a disagreeing image is kept as "also"', () => {
  const merged = mergeDetections(detectTech({
    'pom.xml': '<project><properties><java.version>17</java.version></properties></project>',
    'Dockerfile': 'FROM eclipse-temurin:21-jre',
    '.sdkmanrc': 'java=17.0.2-tem',
  }))
  const java = merged.find((d) => d.key === 'java')!
  assertEquals([java.version, java.source], ['17', 'pom.xml'])
  assertEquals(java.also.map((a) => [a.version, a.source]), [['17.0.2', '.sdkmanrc'], ['21', 'Dockerfile']])
})

Deno.test('package.json: engines.node, TypeScript, frameworks, package manager', () => {
  const m = parsePackageJson(JSON.stringify({
    engines: { node: '>=20.10' },
    packageManager: 'pnpm@9.4.0',
    dependencies: { next: '^14.2.3', react: '18.3.1', pg: '^8.11.0' },
    devDependencies: { typescript: '~5.4.5' },
  }))
  assertEquals(pick(m, 'node')?.version, '20.10+')
  assertEquals(pick(m, 'typescript')?.version, '5.4.5')
  assertEquals(pick(m, 'next')?.version, '14.2.3')
  assertEquals(pick(m, 'react')?.version, '18.3.1')
  assertEquals(pick(m, 'pnpm')?.version, '9.4.0')
  assertEquals(Boolean(pick(m, 'postgres')), true)
  assertEquals(pick(m, 'javascript'), undefined)
})

Deno.test('go.mod: go directive, toolchain and frameworks', () => {
  const m = parseGoMod(`module example.com/cart

go 1.22.1

toolchain go1.22.5

require (
\tgithub.com/gin-gonic/gin v1.10.0
\tgithub.com/jackc/pgx/v5 v5.6.0
\tgo.opentelemetry.io/otel v1.28.0 // indirect
)`)
  const go = mergeDetections(m).find((d) => d.key === 'go')!
  assertEquals(go.version, '1.22.1')
  assertEquals(go.also.map((a) => a.version), ['1.22.5'])
  assertEquals(pick(m, 'gin')?.version, '1.10.0')
  assertEquals(Boolean(pick(m, 'postgres')), true)
  assertEquals(Boolean(pick(m, 'otel')), true)
})

Deno.test('pyproject.toml: requires-python, PEP 621 and Poetry dependencies', () => {
  const pep = parsePyproject(`[project]
name = "svc"
requires-python = ">=3.11"
dependencies = ["fastapi[standard]>=0.111.0", "psycopg[binary]==3.1.19"]
`)
  assertEquals(pick(pep, 'python')?.version, '3.11+')
  assertEquals(pick(pep, 'fastapi')?.version, '0.111.0+')
  assertEquals(Boolean(pick(pep, 'postgres')), true)
  const poetry = parsePyproject(`[tool.poetry.dependencies]
python = "^3.12"
django = { version = "^5.0.6", extras = ["argon2"] }
redis = "^5.0"
`)
  assertEquals(pick(poetry, 'python')?.version, '3.12')
  assertEquals(pick(poetry, 'django')?.version, '5.0.6')
  assertEquals(Boolean(pick(poetry, 'redis')), true)
})

Deno.test('cleanSpec and normalizeJava', () => {
  assertEquals(cleanSpec('^18.2.0'), '18.2.0')
  assertEquals(cleanSpec('>=3.11,<3.13'), '3.11+')
  assertEquals(cleanSpec('~> 7.1'), '7.1')
  assertEquals(cleanSpec('==5.0.*'), '5.0')
  assertEquals(cleanSpec('*'), undefined)
  assertEquals(normalizeJava('1.8'), '8')
  assertEquals(normalizeJava('VERSION_17'), '17')
  assertEquals(normalizeJava('21'), '21')
})

Deno.test('wantedFiles: build files, Dockerfiles, nested Gradle/Maven paths', () => {
  const want = wantedFiles(
    ['pom.xml', 'README.md', 'Dockerfile', 'src.java', '.sdkmanrc', 'api.Dockerfile', 'App.csproj'],
    ['src', 'gradle', '.mvn'],
  )
  assertEquals(want, [
    'pom.xml',
    'Dockerfile',
    '.sdkmanrc',
    'api.Dockerfile',
    'App.csproj',
    'gradle/libs.versions.toml',
    'gradle/wrapper/gradle-wrapper.properties',
    '.mvn/wrapper/maven-wrapper.properties',
  ])
})
