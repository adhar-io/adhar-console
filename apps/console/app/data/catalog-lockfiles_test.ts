import { assertEquals } from 'jsr:@std/assert@^1'
import {
  compareVersions,
  lockfilesFor,
  parseBunLock,
  parseComposerLock,
  parseDenoLock,
  parseGemfileLock,
  parseGradleLockfile,
  parseLockfile,
  parsePackageLock,
  parsePipfileLock,
  parsePnpmLock,
  parseTomlPackages,
  parseYarnLock,
  resolveWithLocks,
} from './catalog-lockfiles.ts'
import { bootLine, withManagedVersions } from './catalog-managed-versions.ts'
import { detectTech, type DetectedTech, mergeDetections } from './catalog-techstack.ts'

const v = (m: Map<string, Array<{ version: string }>>, name: string) => m.get(name)?.map((e) => e.version)

Deno.test('package-lock v3 (top-level only) and v1', () => {
  const m = parsePackageLock(JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'app' }, 'node_modules/react': { version: '18.3.1' }, 'node_modules/@angular/core': { version: '17.3.0' }, 'node_modules/x/node_modules/react': { version: '16.0.0' } },
  }))
  assertEquals(v(m, 'react'), ['18.3.1'])
  assertEquals(v(m, '@angular/core'), ['17.3.0'])
  assertEquals(v(parsePackageLock(JSON.stringify({ dependencies: { next: { version: '14.2.3' } } })), 'next'), ['14.2.3'])
})

Deno.test('pnpm-lock v9 importers with peer suffixes; v6 packages fallback', () => {
  const m = parsePnpmLock(`lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      react:
        specifier: ^18.2.0
        version: 18.3.1
    devDependencies:
      vitest:
        specifier: ^2.0.0
        version: 2.1.4(@types/node@22.0.0)

  apps/web:
    dependencies:
      next:
        specifier: 14.2.3
        version: 14.2.3(react@18.3.1)
      react:
        specifier: ^19.0.0
        version: 19.2.0

packages:

  react@18.3.1:
    resolution: {integrity: x}
`)
  assertEquals(m.get('react')?.map((e) => [e.version, e.importer]), [['18.3.1', '.'], ['19.2.0', 'apps/web']])
  assertEquals(v(m, 'vitest'), ['2.1.4'])
  assertEquals(v(m, 'next'), ['14.2.3'])
  assertEquals(v(parsePnpmLock(`lockfileVersion: '6.0'\n\ndependencies:\n  react:\n    specifier: ^18.2.0\n    version: 18.2.0\n\npackages:\n\n  /react@18.2.0:\n    dev: false\n`), 'react'), ['18.2.0'])
  assertEquals(v(parsePnpmLock(`lockfileVersion: '6.0'\n\npackages:\n\n  /react@18.2.0:\n    resolution: {}\n  /@types/node/20.1.0:\n    dev: true\n`), '@types/node'), ['20.1.0'])
})

Deno.test('yarn.lock classic and berry', () => {
  const classic = parseYarnLock(`# yarn lockfile v1

react@^18.0.0, react@^18.2.0:
  version "18.3.1"
  resolved "https://registry.yarnpkg.com/react/-/react-18.3.1.tgz"

"@babel/core@^7.0.0":
  version "7.24.0"
`)
  assertEquals(classic.get('react'), [{ version: '18.3.1', specs: ['^18.0.0', '^18.2.0'] }])
  assertEquals(v(classic, '@babel/core'), ['7.24.0'])
  const berry = parseYarnLock(`__metadata:
  version: 8

"react@npm:^18.2.0":
  version: 18.3.1
  resolution: "react@npm:18.3.1"
`)
  assertEquals(berry.get('react'), [{ version: '18.3.1', specs: ['^18.2.0'] }])
  assertEquals(berry.has('__metadata'), false)
})

Deno.test('bun.lock, deno.lock', () => {
  assertEquals(v(parseBunLock(`{\n  "lockfileVersion": 1,\n  "packages": {\n    "react": ["react@18.3.1", "", {}, "sha512-x"],\n    "@tanstack/react-router": ["@tanstack/react-router@1.167.0", "", {}, "sha"],\n  }\n}`), '@tanstack/react-router'), ['1.167.0'])
  const d = parseDenoLock(JSON.stringify({ version: '5', specifiers: { 'npm:react@^19.2.0': '19.2.5', 'jsr:@std/assert@1': '1.0.13', 'npm:@tanstack/react-query@^5.59.0': '5.90.2_react@19.2.5' } }))
  assertEquals(v(d, 'react'), ['19.2.5'])
  assertEquals(v(d, '@std/assert'), ['1.0.13'])
  assertEquals(v(d, '@tanstack/react-query'), ['5.90.2'])
})

Deno.test('TOML [[package]] (poetry, uv, Cargo), Pipfile.lock, composer.lock, Gemfile.lock, gradle.lockfile', () => {
  const toml = parseTomlPackages(`[[package]]\nname = "Django"\nversion = "5.0.6"\ndescription = "x"\n\n[[package]]\nname = "fastapi"\nversion = "0.111.0"\n`)
  assertEquals(v(toml, 'django'), ['5.0.6'])
  assertEquals(v(parsePipfileLock(JSON.stringify({ default: { flask: { version: '==3.0.3' } }, develop: { pytest: { version: '==8.2.0' } } })), 'pytest'), ['8.2.0'])
  assertEquals(v(parseComposerLock(JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v11.9.2' }] })), 'laravel/framework'), ['11.9.2'])
  assertEquals(v(parseGemfileLock(`GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.1.3)\n      actionpack (= 7.1.3)\n    nokogiri (1.16.5-x86_64-linux)\n`), 'rails'), ['7.1.3'])
  assertEquals(v(parseGradleLockfile(`# comment\norg.springframework.boot:spring-boot:3.3.4=compileClasspath,runtimeClasspath\nempty=\n`), 'org.springframework.boot:spring-boot'), ['3.3.4'])
  assertEquals(parseLockfile('apps/x/poetry.lock', '[[package]]\nname = "a"\nversion = "1"\n').kind, 'poetry')
})

Deno.test('lockfilesFor: same folder then ancestors, size cap', () => {
  const listing = ['package-lock.json', 'apps/web/pnpm-lock.yaml', 'apps/web/package.json', 'pnpm-lock.yaml', 'apps/other/yarn.lock']
  assertEquals(lockfilesFor(listing, ['apps/web', '']), ['apps/web/pnpm-lock.yaml', 'package-lock.json', 'pnpm-lock.yaml'])
  assertEquals(lockfilesFor(listing, [''], new Map([['package-lock.json', 9_000_000]])), ['pnpm-lock.yaml'])
})

Deno.test('resolveWithLocks: declared range → exact, spec match, nearest lock, TECH_PACKAGES fallback', () => {
  const tech = mergeDetections(detectTech({
    'package.json': JSON.stringify({ dependencies: { react: '^18.2.0', next: '14.2.3' }, devDependencies: { typescript: '~5.4.0' } }),
  }))
  const lock = parseLockfile('yarn.lock', `react@^18.2.0:\n  version "18.3.1"\n\nreact@^17.0.0:\n  version "17.0.2"\n\nnext@14.2.3:\n  version "14.2.3"\n\ntypescript@~5.4.0:\n  version "5.4.5"\n`)
  const out = resolveWithLocks(tech, [lock])
  const get = (k: string) => out.find((t) => t.key === k)!
  assertEquals([get('react').spec, get('react').version, get('react').resolved?.version, get('react').resolved?.source], ['^18.2.0', '18.2.0', '18.3.1', 'yarn.lock'])
  assertEquals(get('next').resolved?.version, '14.2.3')
  assertEquals(get('typescript').resolved?.version, '5.4.5')
  // Datastore drivers never carry the datastore's version.
  const pg = resolveWithLocks(mergeDetections(detectTech({ 'package.json': JSON.stringify({ dependencies: { pg: '^8.11.0' } }) })), [parseLockfile('yarn.lock', 'pg@^8.11.0:\n  version "8.12.0"\n')])
  assertEquals(pg.find((t) => t.key === 'postgres')?.resolved, undefined)
  // Spring Boot from a parent POM resolves through gradle.lockfile via TECH_PACKAGES.
  const boot: DetectedTech[] = [{ key: 'spring-boot', version: '3.3.0', source: 'build.gradle', also: [] }]
  assertEquals(resolveWithLocks(boot, [parseLockfile('gradle.lockfile', 'org.springframework.boot:spring-boot:3.3.4=runtimeClasspath\n')])[0].resolved?.version, '3.3.4')
})

Deno.test('compareVersions', () => {
  assertEquals(compareVersions('1.10.0', '1.9.9') > 0, true)
  assertEquals(compareVersions('2.0.0-rc.1', '2.0.0') < 0, true)
  assertEquals(compareVersions('3.3', '3.3.0'), 0)
})

Deno.test('Spring Boot BOM table: Framework line and minimum Java', () => {
  assertEquals(bootLine('3.3.2')?.entry.framework, '6.1')
  assertEquals(bootLine('9.9.9'), undefined)
  const out = withManagedVersions([
    { key: 'spring-boot', version: '3.4.1', source: 'pom.xml', also: [] },
    { key: 'java', source: 'pom.xml', also: [] },
  ])
  assertEquals(out.find((t) => t.key === 'spring')?.version, '6.2.x')
  assertEquals(out.find((t) => t.key === 'java')?.version, '17+')
  // A version a file states is never overridden.
  const kept = withManagedVersions([{ key: 'spring-boot', version: '3.4.1', source: 'pom.xml', also: [] }, { key: 'spring', version: '6.2.3', source: 'pom.xml', also: [] }])
  assertEquals(kept.find((t) => t.key === 'spring')?.version, '6.2.3')
})
